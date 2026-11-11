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
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, any>} socketId -> usuário */
const users = new Map();
/** inviteId -> { from, to, timer } */
const invites = new Map();

const STATUSES = ['disponivel', 'ocupado', 'ausente'];

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
  const others = [...users.values()].filter((u) => u.id !== exceptId);
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
}

// Chamada só existe quando alguém puxa outra pessoa.
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
    socket.emit('init', { me: publicUser(u), users: [...users.values()].map(publicUser) });
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
