const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const MAP = require('./map.js');

const PORT = process.env.PORT || 3000;
const INVITE_TIMEOUT_MS = 20000;

const app = express();
// Só os arquivos da página são públicos (o resto da pasta não).
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/map.js': 'map.js' };
for (const [route, file] of Object.entries(PUBLIC_FILES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}
app.use('/api/agent', express.json({ limit: '4kb' }));

// Servidores ICE para as chamadas. Só STUN não basta quando a pessoa está atrás de NAT de operadora
// (4G, alguns provedores): aí a câmera/áudio não chega. TURN repassa a mídia nesses casos.
//   Cloudflare (grátis até 1 TB/mês): CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   Outro TURN: TURN_URLS (separadas por vírgula) + TURN_USERNAME + TURN_CREDENTIAL
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
let iceCache = { at: 0, servers: null };
app.get('/api/ice', async (req, res) => {
  res.set('cache-control', 'no-store');
  const { CF_TURN_KEY_ID, CF_TURN_API_TOKEN, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
    if (iceCache.servers && Date.now() - iceCache.at < 6 * 3600 * 1000) return res.json({ iceServers: iceCache.servers, turn: true });
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      const data = await r.json();
      if (!r.ok || !data.iceServers) throw new Error('HTTP ' + r.status);
      iceCache = { at: Date.now(), servers: [].concat(data.iceServers) };
      return res.json({ iceServers: iceCache.servers, turn: true });
    } catch (e) {
      console.error('[ice] Cloudflare TURN falhou:', e.message);
    }
  }
  if (TURN_URLS) {
    return res.json({ iceServers: [...STUN, { urls: TURN_URLS.split(',').map((u) => u.trim()), username: TURN_USERNAME, credential: TURN_CREDENTIAL }], turn: true });
  }
  res.json({ iceServers: STUN, turn: false });
});
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, any>} socketId -> usuário */
const users = new Map();
/** inviteId -> { from, to, timer } */
const invites = new Map();

const STATUSES = ['disponivel', 'ocupado', 'ausente'];

// ---------------------------------------------------------------- Agentes de IA (Claude Code via hooks)
/** @type {Map<string, any>} agentId -> agente */
const agents = new Map();
const AGENT_KEY = process.env.AGENT_KEY || '';
const MAX_AGENTS = 40;
const AGENT_STALE_MS = 30 * 60 * 1000; // sem sinal há 30 min: some do mapa
const AGENT_COLORS = ['#7aa2ff', '#ff8a7a', '#5fd39a', '#ffc15e', '#b48cff', '#4cc9d6', '#ff94cf'];

function publicAgent(a) {
  return { id: a.id, name: a.name, owner: a.owner, color: a.color, state: a.state, tool: a.tool, x: a.x, y: a.y, dir: a.dir };
}

// Trabalhando/esperando: senta numa mesa do Desenvolvimento. Parado: vai pro Descanso.
function placeAgent(a) {
  const zone = a.state === 'idle' ? 'descanso' : 'dev';
  if (a.zone === zone) return;
  const spot = freeSpot(zone, a.id);
  a.zone = zone;
  a.x = spot.x;
  a.y = spot.y;
  a.dir = spot.dir || 'down';
}

const EVENT_STATE = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'idle',
};

app.post('/api/agent', (req, res) => {
  if (AGENT_KEY && req.get('x-office-key') !== AGENT_KEY) return res.status(401).json({ ok: false });
  const b = req.body || {};
  const id = 'ag-' + clean(b.id, 64).replace(/[^\w-]/g, '');
  if (id === 'ag-') return res.status(400).json({ ok: false });
  if (agents.get(id)?.permanent) return res.status(403).json({ ok: false });
  const event = String(b.event || '');

  if (event === 'SessionEnd') {
    if (agents.delete(id)) io.emit('agent-left', { id });
    return res.json({ ok: true });
  }
  const state = EVENT_STATE[event];
  if (!state) return res.json({ ok: true, ignored: true });

  let a = agents.get(id);
  if (!a) {
    if (agents.size >= MAX_AGENTS) return res.status(429).json({ ok: false });
    const owner = clean(b.owner, 24) || 'alguém';
    a = {
      id, owner,
      name: clean(b.name, 24) || 'agente',
      color: AGENT_COLORS[[...owner].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AGENT_COLORS.length],
      state, tool: null, x: 0, y: 0, dir: 'down', zone: null,
    };
    agents.set(id, a);
  }
  if (b.name) a.name = clean(b.name, 24) || a.name;
  a.state = state;
  a.tool = event === 'PreToolUse' ? clean(String(b.tool || '').split('__').pop(), 32) || null : state === 'working' ? a.tool : null;
  a.seen = Date.now();
  placeAgent(a);
  io.emit('agent-update', { ...publicAgent(a), event });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Bot @claude (responde dúvidas no chat)
// Liga só se ANTHROPIC_API_KEY estiver definida no servidor (Render > Environment).
const BOT_KEY = process.env.ANTHROPIC_API_KEY || '';
const BOT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const BOT_ID = 'ag-claude-bot';
const BOT_MAX_PER_HOUR = Number(process.env.CLAUDE_MAX_PER_HOUR) || 60;
const BOT_USER_COOLDOWN_MS = 8000;
const BOT_SYSTEM = [
  'Você é o Claude, um assistente dentro de um escritório virtual de uma equipe brasileira que trabalha com agentes de IA, automação e conteúdo.',
  'As pessoas te chamam no chat do escritório escrevendo @claude.',
  'Responda em português do Brasil, direto e curto: no máximo uns 4 parágrafos curtos ou uma lista curta. Sem markdown pesado (o chat mostra texto puro); pode usar quebras de linha e listas com "-".',
  'Sua resposta também é lida em voz alta para quem perguntou: escreva frases naturais de falar, evite símbolos, tabelas e links longos.',
  'Se precisar de código, mande só o trecho essencial.',
  'Você não vê os computadores, arquivos ou sessões de ninguém, só o que escreverem no chat. Se faltar contexto, peça.',
].join('\n');
const chatHistory = []; // últimas mensagens do chat, para o bot ter contexto
const botLastAsk = new Map(); // userId -> horário da última pergunta
let botCalls = [];
let botBusy = 0;

if (BOT_KEY) {
  const spot = freeSpot('estudo', BOT_ID);
  agents.set(BOT_ID, {
    id: BOT_ID, name: 'Claude', owner: 'chame com @claude', color: '#d97757',
    state: 'idle', tool: null, x: spot.x, y: spot.y, dir: spot.dir || 'down', zone: 'estudo',
    seen: Infinity, permanent: true,
  });
}

function rememberChat(name, text) {
  chatHistory.push({ name, text });
  if (chatHistory.length > 16) chatHistory.shift();
}

// asker: quem perguntou. O navegador de quem perguntou (e de quem está na mesma sala) lê a resposta em voz alta.
function botSay(text, asker) {
  const bot = agents.get(BOT_ID);
  const msg = { id: BOT_ID, name: 'Claude 🤖', zone: bot ? bot.zone : 'estudo', text, at: Date.now(), bot: true };
  if (asker) { msg.askerId = asker.id; msg.askerName = asker.name; msg.askerRoom = asker.call || asker.zone; }
  rememberChat('Claude', text);
  io.emit('chat', msg);
}

function botState(state, tool) {
  const bot = agents.get(BOT_ID);
  if (!bot) return;
  bot.state = state;
  bot.tool = tool || null;
  io.emit('agent-update', { ...publicAgent(bot), event: state === 'working' ? 'UserPromptSubmit' : 'BotIdle' });
}

async function askClaude(u, question) {
  const now = Date.now();
  botCalls = botCalls.filter((t) => now - t < 3600 * 1000);
  const last = botLastAsk.get(u.id) || 0;
  const sock = io.sockets.sockets.get(u.id);
  if (now - last < BOT_USER_COOLDOWN_MS) { sock?.emit('toast', 'Calma aí, espera uns segundos pra perguntar de novo ao Claude.'); return; }
  if (botCalls.length >= BOT_MAX_PER_HOUR) { botSay(`Bati o limite de ${BOT_MAX_PER_HOUR} respostas por hora. Tenta de novo daqui a pouco.`, u); return; }
  if (botBusy >= 3) { sock?.emit('toast', 'O Claude está respondendo outras perguntas, tenta em instantes.'); return; }
  botLastAsk.set(u.id, now);
  botCalls.push(now);
  botBusy++;
  botState('working', 'pensando');

  const context = chatHistory.slice(0, -1).map((m) => `${m.name}: ${m.text}`).join('\n');
  const content = (context ? `Conversa recente no chat do escritório:\n${context}\n\n` : '') + `${u.name} perguntou: ${question}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': BOT_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: BOT_MODEL, max_tokens: 700, system: BOT_SYSTEM, messages: [{ role: 'user', content }] }),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[bot] API erro', r.status, data?.error?.type, data?.error?.message);
      botSay(r.status === 401 ? 'Minha chave da API está inválida. Quem cuida do servidor precisa conferir a ANTHROPIC_API_KEY.' : 'Não consegui responder agora (erro na API). Tenta de novo daqui a pouco.', u);
      return;
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    botSay(text ? `@${u.name} ${text}`.slice(0, 2000) : 'Fiquei sem resposta pra essa, pode reformular?', u);
  } catch (e) {
    console.error('[bot] falha', e.name, e.message);
    botSay('Demorei demais pra responder e desisti. Tenta de novo?', u);
  } finally {
    clearTimeout(timer);
    botBusy--;
    if (!botBusy) botState('idle');
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, a] of agents) {
    if (a.permanent) continue;
    if (now - a.seen > AGENT_STALE_MS) { agents.delete(id); io.emit('agent-left', { id }); }
  }
}, 60 * 1000);

function publicUser(u) {
  return {
    id: u.id, name: u.name, color: u.color, skin: u.skin,
    x: u.x, y: u.y, dir: u.dir, moving: u.moving,
    status: u.status, zone: u.zone, home: u.home, call: u.call,
  };
}

const isMeeting = (zoneId) => MAP.zoneById[zoneId]?.type === 'meeting';
const zoneIdAt = (x, y) => MAP.zoneAt(x, y)?.id || 'corredor';
const clean = (s, max) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, max);
const clampX = (v) => Math.max(8, Math.min(MAP.WIDTH - 8, Number(v) || 0));
const clampY = (v) => Math.max(8, Math.min(MAP.HEIGHT - 8, Number(v) || 0));

function freeSpot(zoneId, exceptId) {
  const spots = MAP.seats[zoneId] || [];
  const others = [...users.values(), ...agents.values()].filter((u) => u.id !== exceptId);
  for (const s of spots) {
    if (!others.some((u) => Math.hypot(u.x - s.x, u.y - s.y) < 20)) return s;
  }
  const z = MAP.zoneById[zoneId];
  return {
    x: z.px + 30 + Math.random() * (z.pw - 60),
    y: z.py + 40 + Math.random() * (z.ph - 60),
    dir: 'down',
  };
}

function freeMeetingRoom() {
  const rooms = MAP.zones.filter((z) => z.type === 'meeting');
  return rooms.find((r) => ![...users.values()].some((u) => u.zone === r.id || u.call === r.id))?.id || null;
}

// Recalcula a zona do usuário e entra/sai da chamada de vídeo da sala.
function updateZone(u) {
  const nz = zoneIdAt(u.x, u.y);
  if (nz === u.zone) return;
  const old = u.zone;
  u.zone = nz;
  const sock = io.sockets.sockets.get(u.id);

  // Saiu da sala onde estava em chamada -> desliga câmera/áudio.
  if (u.call && nz !== u.call) leaveCall(u);
  if (!isMeeting(nz)) u.prev = null;
  io.emit('user-zone', { id: u.id, zone: nz });
  // Entrou numa sala de reunião: já entra na chamada, com microfone ligado.
  if (isMeeting(nz)) joinCall(u, nz);
}

// Chamada da sala: começa assim que a pessoa entra na sala de reunião (a pé, pelo atalho ou puxada).
function joinCall(u, room) {
  if (u.call === room) return;
  if (u.call) leaveCall(u);
  const sock = io.sockets.sockets.get(u.id);
  const peers = [...users.values()].filter((o) => o.id !== u.id && o.call === room).map((o) => o.id);
  u.call = room;
  if (!sock) return;
  sock.join('call:' + room);
  sock.emit('call-joined', { room, peers });
  io.emit('user-call', { id: u.id, call: room });
}

function leaveCall(u) {
  if (!u.call) return;
  const room = u.call;
  u.call = null;
  const sock = io.sockets.sockets.get(u.id);
  if (sock) {
    sock.leave('call:' + room);
    sock.to('call:' + room).emit('peer-left', { id: u.id });
    sock.emit('call-left');
  }
  io.emit('user-call', { id: u.id, call: null });
}

function teleport(u, spot) {
  u.x = spot.x;
  u.y = spot.y;
  u.dir = spot.dir || 'down';
  u.moving = false;
  u.tp += 1;
  io.emit('teleport', { id: u.id, x: u.x, y: u.y, dir: u.dir, tp: u.tp });
  const prev = u.prev;
  updateZone(u);
  // Se só trocou de sala de reunião, preserva a posição de volta.
  if (isMeeting(u.zone) && !u.prev) u.prev = prev;
}

function bringToRoom(u, room, withCall) {
  if (u.zone !== room) {
    const prev = isMeeting(u.zone) ? u.prev : { x: u.x, y: u.y, dir: u.dir };
    teleport(u, freeSpot(room, u.id));
    u.prev = prev;
  }
  if (withCall) joinCall(u, room);
}

function cancelInvitesOf(id) {
  for (const [inviteId, inv] of invites) {
    if (inv.from === id || inv.to === id) {
      clearTimeout(inv.timer);
      invites.delete(inviteId);
      io.to(inv.to).emit('invite-cancel', { inviteId });
    }
  }
}

io.on('connection', (socket) => {
  socket.on('join', (data = {}) => {
    if (users.has(socket.id)) return;
    const home = MAP.zoneById[data.sector] && MAP.zoneById[data.sector].type !== 'meeting' ? data.sector : 'dev';
    const spot = freeSpot(home);
    const u = {
      id: socket.id,
      name: clean(data.name, 24) || 'Visitante',
      color: /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : '#4f7cff',
      skin: /^#[0-9a-f]{6}$/i.test(data.skin) ? data.skin : '#f1c7a0',
      x: spot.x, y: spot.y, dir: spot.dir, moving: false,
      status: 'disponivel', zone: null, home, prev: null, tp: 0, call: null,
    };
    users.set(socket.id, u);
    u.zone = zoneIdAt(u.x, u.y);
    socket.emit('init', { me: publicUser(u), users: [...users.values()].map(publicUser), agents: [...agents.values()].map(publicAgent) });
    socket.broadcast.emit('user-joined', publicUser(u));
  });

  socket.on('move', (d = {}) => {
    const u = users.get(socket.id);
    if (!u || d.tp !== u.tp) return; // ignora movimentos antigos de antes de um teleporte
    u.x = clampX(d.x);
    u.y = clampY(d.y);
    u.dir = ['up', 'down', 'left', 'right'].includes(d.dir) ? d.dir : u.dir;
    u.moving = !!d.moving;
    socket.broadcast.volatile.emit('user-moved', { id: u.id, x: u.x, y: u.y, dir: u.dir, moving: u.moving });
    updateZone(u);
  });

  socket.on('status', (status) => {
    const u = users.get(socket.id);
    if (!u || !STATUSES.includes(status)) return;
    u.status = status;
    io.emit('user-status', { id: u.id, status });
  });

  socket.on('chat', (text) => {
    const u = users.get(socket.id);
    const t = clean(text, 280);
    if (!u || !t) return;
    io.emit('chat', { id: u.id, name: u.name, zone: u.zone, text: t, at: Date.now() });
    rememberChat(u.name, t);
    if (BOT_KEY && /(^|[^\w@])@claude\b/i.test(t)) {
      const q = t.replace(/@claude\b[,:]?/ig, '').trim();
      if (q) askClaude(u, q);
      else botSay(`Oi, ${u.name}! Me pergunta algo junto com o @claude, tipo: @claude como faço um hook no Claude Code?`, u);
    }
  });

  socket.on('emote', (emoji) => {
    const u = users.get(socket.id);
    if (!u || !['👋', '❤️', '😂', '👍', '🎉', '☕'].includes(emoji)) return;
    io.emit('emote', { id: u.id, emoji });
  });

  socket.on('go-zone', (zoneId) => {
    const u = users.get(socket.id);
    if (!u || !MAP.zoneById[zoneId]) return;
    if (isMeeting(zoneId)) bringToRoom(u, zoneId, false);
    else teleport(u, freeSpot(zoneId, u.id));
  });

  socket.on('leave-meeting', () => {
    const u = users.get(socket.id);
    if (!u || !isMeeting(u.zone)) return;
    const back = u.prev || freeSpot(u.home, u.id);
    u.prev = null;
    teleport(u, back);
  });

  // "Puxar" alguém para uma reunião rápida.
  socket.on('pull', (targetId) => {
    const from = users.get(socket.id);
    const to = users.get(targetId);
    if (!from || !to || from.id === to.id) return;
    if (from.call && from.call === to.call) {
      socket.emit('toast', `${to.name} já está na chamada com você.`);
      return;
    }
    if (to.zone === 'off') {
      socket.emit('toast', `${to.name} está OFF agora.`);
      return;
    }
    for (const inv of invites.values()) {
      if (inv.from === from.id && inv.to === to.id) {
        socket.emit('toast', `Convite para ${to.name} já está pendente.`);
        return;
      }
    }
    const inviteId = crypto.randomUUID();
    const timer = setTimeout(() => {
      invites.delete(inviteId);
      io.to(to.id).emit('invite-cancel', { inviteId });
      io.to(from.id).emit('toast', `${to.name} não respondeu ao convite.`);
    }, INVITE_TIMEOUT_MS);
    invites.set(inviteId, { from: from.id, to: to.id, timer });
    const room = from.call ? MAP.zoneById[from.call].name : null;
    io.to(to.id).emit('invite', { inviteId, from: { id: from.id, name: from.name }, room, timeout: INVITE_TIMEOUT_MS });
    socket.emit('toast', `📞 Chamando ${to.name}...`);
  });

  socket.on('invite-response', ({ inviteId, accept } = {}) => {
    const inv = invites.get(inviteId);
    if (!inv || inv.to !== socket.id) return;
    clearTimeout(inv.timer);
    invites.delete(inviteId);
    const from = users.get(inv.from);
    const to = users.get(inv.to);
    if (!from || !to) return;
    if (!accept) {
      io.to(from.id).emit('toast', `${to.name} não pode agora.`);
      return;
    }
    // Usa a chamada já aberta; senão a sala de reunião onde quem chamou está; senão uma sala livre.
    const roomBusy = (r) => [...users.values()].some((o) => o.call === r);
    const room = from.call || (isMeeting(from.zone) && !roomBusy(from.zone) ? from.zone : null) || freeMeetingRoom();
    if (!room) {
      io.to(from.id).emit('toast', 'Todas as salas de reunião estão ocupadas.');
      io.to(to.id).emit('toast', 'Todas as salas de reunião estão ocupadas.');
      return;
    }
    bringToRoom(from, room, true);
    bringToRoom(to, room, true);
    io.to(from.id).emit('toast', `${to.name} entrou na ${MAP.zoneById[room].name}.`);
  });

  // Sinalização WebRTC (só repassa entre pessoas da mesma sala).
  socket.on('signal', ({ to, data } = {}) => {
    const a = users.get(socket.id);
    const b = users.get(to);
    if (!a || !b || !a.call || a.call !== b.call) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    if (!u) return;
    cancelInvitesOf(u.id);
    if (u.call) socket.to('call:' + u.call).emit('peer-left', { id: u.id });
    users.delete(socket.id);
    io.emit('user-left', { id: u.id });
  });
});

server.listen(PORT, () => {
  console.log(`Escritório virtual rodando em http://localhost:${PORT}`);
});
