/* global io, MAP */
(() => {
  const SHIRTS = ['#4f7cff', '#ef5b6b', '#3ccf7a', '#f5a623', '#a35bff', '#16b8c4', '#ff7ac3', '#2d3142'];
  const SKINS = ['#f6d5b8', '#f1c7a0', '#d9a27a', '#b57c55', '#8a5638', '#5e3a24'];
  const HAIRS = ['#2b1b10', '#4a2c17', '#8b5a2b', '#d6a756', '#1a1a1a', '#7a2e1d', '#9aa0a6'];
  const STATUS_LABEL = { disponivel: 'Disponível', ocupado: 'Ocupado', ausente: 'Ausente' };
  const STATUS_COLOR = { disponivel: '#3ccf7a', ocupado: '#ef5b6b', ausente: '#f5c04a' };
  const SPEED = 170;
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const zoneName = (id) => (MAP.zoneById[id] ? `${MAP.zoneById[id].icon} ${MAP.zoneById[id].name}` : '🚶 Corredor');

  // ---------------------------------------------------------------- Login
  const saved = JSON.parse(localStorage.getItem('ev-profile') || '{}');
  const profile = {
    name: saved.name || '',
    color: saved.color || SHIRTS[0],
    skin: saved.skin || SKINS[1],
    sector: saved.sector || 'dev',
  };
  if (!MAP.spawnZones.some((z) => z.id === profile.sector)) profile.sector = 'dev';
  $('nameInput').value = profile.name;

  function picker(el, values, key, render) {
    el.innerHTML = '';
    for (const v of values) {
      const b = render(v);
      if (profile[key] === (v.id || v)) b.classList.add('sel');
      b.onclick = () => {
        profile[key] = v.id || v;
        [...el.children].forEach((c) => c.classList.remove('sel'));
        b.classList.add('sel');
      };
      el.appendChild(b);
    }
  }
  const swatch = (c) => { const d = document.createElement('div'); d.className = 'swatch'; d.style.background = c; return d; };
  picker($('colorPicker'), SHIRTS, 'color', swatch);
  picker($('skinPicker'), SKINS, 'skin', swatch);
  picker($('sectorPicker'), MAP.spawnZones, 'sector', (z) => {
    const d = document.createElement('div'); d.className = 'chip'; d.textContent = `${z.icon} ${z.name}`; return d;
  });

  $('loginForm').onsubmit = (e) => {
    e.preventDefault();
    profile.name = $('nameInput').value.trim().slice(0, 24);
    if (!profile.name) return;
    localStorage.setItem('ev-profile', JSON.stringify(profile));
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    start();
  };

  // ---------------------------------------------------------------- Estado
  const socket = io({ autoConnect: false });
  const users = new Map(); // id -> user (com campos de render rx, ry)
  let meId = null;
  let myTp = 0;
  let target = null; // destino do clique
  const keys = new Set();
  const effects = []; // emojis flutuando / poof
  let lastSent = 0;
  let lastSentState = '';

  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  let view = { scale: 1, ox: 0, oy: 0, dpr: 1 };

  // Agentes de IA (sessões do Claude Code)
  const agents = new Map();
  const AGENT_SPEED = 120;
  const TOOL_ICON = { Edit: '✏️', MultiEdit: '✏️', Write: '📝', Read: '📖', Bash: '⌨️', Grep: '🔎', Glob: '🔎', WebFetch: '🌐', WebSearch: '🌐', Task: '🧩', Agent: '🧩', TodoWrite: '✅' };
  const AGENT_STATE = { working: 'Trabalhando', waiting: 'Precisa de você', idle: 'Parado' };
  function upsertAgent(a) {
    const cur = agents.get(a.id);
    if (cur) { Object.assign(cur, a); return cur; }
    const n = { ...a, rx: a.x, ry: a.y, phase: (hash(a.id) % 100) / 10, bubble: null };
    agents.set(a.id, n);
    poof(a.x, a.y);
    return n;
  }

  function addUser(u) {
    const h = hash(u.name + u.id);
    users.set(u.id, { ...u, rx: u.x, ry: u.y, phase: (h % 100) / 10, hair: HAIRS[h % HAIRS.length], bubble: null });
  }

  function start() {
    socket.connect();
    socket.emit('join', profile);
    resize();
    requestAnimationFrame(loop);
  }
  // Reconexão (queda de internet, aba em segundo plano): entra de novo sozinho.
  socket.on('connect', () => {
    if (!meId) return;
    endCall();
    socket.emit('join', profile);
  });
  socket.on('disconnect', () => { if (meId) toast('Conexão perdida — reconectando...'); });

  socket.on('init', ({ me, users: list, agents: agentList = [] }) => {
    meId = me.id;
    myTp = 0;
    users.clear();
    list.forEach(addUser);
    agents.clear();
    agentList.forEach(upsertAgent);
    $('meName').textContent = me.name;
    $('whereAmI').textContent = `📍 ${zoneName(me.zone)}`;
    paintMini($('meAvatar'), me.color, me.skin);
    buildGoto();
    renderPeople();
    $('statusSelect').value = me.status;
    toast(`Bem-vindo(a)! Você está em ${zoneName(me.zone)}.`);
  });
  socket.on('user-joined', (u) => { addUser(u); poof(u.x, u.y); renderPeople(); toast(`👋 ${u.name} chegou`); });
  socket.on('user-left', ({ id }) => {
    const u = users.get(id);
    if (u) { poof(u.rx, u.ry); toast(`${u.name} saiu`); }
    users.delete(id);
    renderPeople();
  });
  socket.on('user-moved', (d) => {
    const u = users.get(d.id);
    if (u) Object.assign(u, { x: d.x, y: d.y, dir: d.dir, moving: d.moving });
  });
  socket.on('user-zone', ({ id, zone }) => {
    const u = users.get(id);
    if (!u) return;
    u.zone = zone;
    if (id === meId) {
      $('whereAmI').textContent = `📍 ${zoneName(zone)}`;
      if (MAP.zoneById[zone]?.type === 'meeting') {
        setTimeout(() => { if (u.zone === zone && !u.call) toast('Sala de reunião: puxe alguém para ligar câmera e áudio.'); }, 700);
      }
      if (zone === 'off') socket.emit('status', 'ausente');
    }
    renderPeople();
  });
  socket.on('user-call', ({ id, call }) => { const u = users.get(id); if (u) u.call = call; });
  socket.on('user-status', ({ id, status }) => {
    const u = users.get(id);
    if (!u) return;
    u.status = status;
    if (id === meId) $('statusSelect').value = status;
    renderPeople();
  });
  socket.on('teleport', ({ id, x, y, dir, tp }) => {
    const u = users.get(id);
    if (!u) return;
    poof(u.rx, u.ry);
    Object.assign(u, { x, y, rx: x, ry: y, dir, moving: false });
    poof(x, y);
    if (id === meId) { myTp = tp; target = null; }
  });
  socket.on('chat', (m) => {
    const u = users.get(m.id);
    if (u) u.bubble = { text: m.text, until: performance.now() + 6000 };
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `<span class="z">${esc(zoneName(m.zone))}</span><br><b>${esc(m.name)}:</b> ${esc(m.text)}`;
    log.appendChild(div);
    while (log.children.length > 100) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  });
  socket.on('emote', ({ id, emoji }) => {
    const u = users.get(id);
    if (u) effects.push({ kind: 'emoji', id, emoji, t0: performance.now(), dx: (Math.random() - 0.5) * 16 });
  });
  socket.on('toast', (t) => toast(t));

  socket.on('agent-update', (a) => {
    const isNew = !agents.has(a.id);
    const ag = upsertAgent(a);
    const now = performance.now();
    if (a.event === 'Stop') ag.bubble = { text: '✅ Terminei!', until: now + 5000 };
    else if (a.event === 'UserPromptSubmit') ag.bubble = { text: '🫡 Bora!', until: now + 2500 };
    else if (isNew) ag.bubble = { text: '👋 Cheguei', until: now + 3000 };
    if (a.event === 'Notification') toast(`🤖 ${a.name} (${a.owner}) precisa de atenção`);
    renderPeople();
  });
  socket.on('agent-left', ({ id }) => {
    const a = agents.get(id);
    if (a) poof(a.rx, a.ry);
    agents.delete(id);
    renderPeople();
  });

  // ---------------------------------------------------------------- Convites
  let currentInvite = null;
  let inviteAnim = null;
  socket.on('invite', (inv) => {
    currentInvite = inv;
    $('inviteTitle').textContent = `${inv.from.name} está te chamando`;
    $('inviteText').textContent = inv.room
      ? `Quer você na ${inv.room} agora.`
      : 'Quer fazer uma reunião rápida com você.';
    $('invite').classList.remove('hidden');
    ring();
    const t0 = performance.now();
    cancelAnimationFrame(inviteAnim);
    const tick = () => {
      const p = Math.max(0, 1 - (performance.now() - t0) / inv.timeout);
      $('inviteProgress').style.width = p * 100 + '%';
      if (p > 0 && currentInvite === inv) inviteAnim = requestAnimationFrame(tick);
    };
    tick();
  });
  socket.on('invite-cancel', ({ inviteId }) => {
    if (currentInvite?.inviteId === inviteId) closeInvite();
  });
  function answerInvite(accept) {
    if (!currentInvite) return;
    socket.emit('invite-response', { inviteId: currentInvite.inviteId, accept });
    closeInvite();
  }
  function closeInvite() { currentInvite = null; $('invite').classList.add('hidden'); }
  $('acceptBtn').onclick = () => answerInvite(true);
  $('declineBtn').onclick = () => answerInvite(false);

  function ring() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18, 0.5, 0.68].forEach((t, i) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.frequency.value = i % 2 ? 880 : 660;
        g.gain.setValueAtTime(0.0001, ac.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.15);
        o.connect(g).connect(ac.destination);
        o.start(ac.currentTime + t);
        o.stop(ac.currentTime + t + 0.16);
      });
      setTimeout(() => ac.close(), 1200);
    } catch { /* sem áudio */ }
  }

  // ---------------------------------------------------------------- Sidebar
  let peopleQueued = false;
  function renderPeople() {
    if (peopleQueued) return;
    peopleQueued = true;
    setTimeout(() => {
      peopleQueued = false;
      const groups = new Map();
      for (const z of MAP.zones) groups.set(z.id, []);
      groups.set('corredor', []);
      for (const u of users.values()) (groups.get(u.zone) || groups.get('corredor')).push(u);
      let html = '';
      for (const [zid, list] of groups) {
        if (!list.length) continue;
        html += `<div class="group-title"><span>${esc(zoneName(zid))}</span><span>${list.length}</span></div>`;
        list.sort((a, b) => a.name.localeCompare(b.name));
        for (const u of list) {
          const isMe = u.id === meId;
          html += `<div class="person" data-id="${u.id}">
            <div class="dot" style="background:${u.color}"><i class="st-${u.status}"></i></div>
            <div class="nm">${esc(u.name)}${isMe ? ' <span class="muted">(você)</span>' : ''}
              <div class="muted" style="font-size:11px">${STATUS_LABEL[u.status]}</div></div>
            ${isMe ? '' : `<div class="acts">
              <button data-act="walk" title="Ir até">📍</button>
              <button data-act="pull" class="pull" title="Puxar pra reunião">📞 Puxar</button></div>`}
          </div>`;
        }
      }
      if (agents.size) {
        html += `<div class="group-title"><span>🤖 Agentes de IA</span><span>${agents.size}</span></div>`;
        const order = { waiting: 0, working: 1, idle: 2 };
        for (const a of [...agents.values()].sort((x, y) => order[x.state] - order[y.state] || x.name.localeCompare(y.name))) {
          const detail = a.state === 'working' && a.tool ? `${AGENT_STATE.working} · ${a.tool}` : AGENT_STATE[a.state];
          html += `<div class="person agent ag-${a.state}" data-agent="${esc(a.id)}">
            <div class="dot bot" style="background:${a.color}"><i class="st-ag-${a.state}"></i></div>
            <div class="nm">${esc(a.name)} <span class="muted">· ${esc(a.owner)}</span>
              <div class="muted" style="font-size:11px">${esc(detail)}</div></div>
            <div class="acts"><button data-act="walk-agent" title="Ir até">📍</button></div>
          </div>`;
        }
      }
      $('people').innerHTML = html;
      $('onlineCount').textContent = users.size;
    }, 30);
  }
  $('people').onclick = (e) => {
    const btn = e.target.closest('button');
    const row = e.target.closest('.person');
    if (!btn || !row) return;
    if (btn.dataset.act === 'walk-agent') {
      const a = agents.get(row.dataset.agent);
      if (a) target = { x: a.x + 26, y: a.y };
      return;
    }
    personAction(btn.dataset.act, row.dataset.id);
  };
  function personAction(act, id) {
    const u = users.get(id);
    if (!u) return;
    if (act === 'pull') {
      if (u.status === 'ocupado') toast(`${u.name} está em foco — o convite vai mesmo assim.`);
      socket.emit('pull', id);
    } else if (act === 'walk') {
      target = { x: u.x + 26, y: u.y };
    } else if (act === 'wave') {
      socket.emit('emote', '👋');
      socket.emit('chat', `👋 Oi, ${u.name}!`);
    }
  }

  function buildGoto() {
    const el = $('goto');
    el.innerHTML = '';
    for (const z of MAP.zones) {
      const c = document.createElement('div');
      c.className = 'chip';
      c.textContent = `${z.icon} ${z.name}`;
      c.onclick = () => socket.emit('go-zone', z.id);
      el.appendChild(c);
    }
  }

  $('statusSelect').onchange = (e) => socket.emit('status', e.target.value);
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    if (v) socket.emit('chat', v);
    $('chatInput').value = '';
    $('chatInput').blur();
  };
  $('emoteBar').onclick = (e) => { const b = e.target.closest('button'); if (b) socket.emit('emote', b.dataset.e); };

  function paintMini(el, color, skin) {
    el.style.background = `radial-gradient(circle at 50% 38%, ${skin} 0 28%, transparent 29%), radial-gradient(circle at 50% 110%, ${color} 0 52%, #3a4060 53%)`;
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 3800);
    setTimeout(() => t.remove(), 4200);
  }

  // ---------------------------------------------------------------- Entrada
  const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  window.addEventListener('keydown', (e) => {
    if (!meId) return;
    if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.key === 'Enter') { e.preventDefault(); $('chatInput').focus(); return; }
    const em = ['👋', '❤️', '😂', '👍', '🎉', '☕'][Number(e.key) - 1];
    if (em) { socket.emit('emote', em); return; }
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      keys.add(k);
      target = null;
      e.preventDefault();
    }
    if (k === 'escape') hideMenu();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  const toWorld = (cx, cy) => ({ x: (cx - view.ox) / view.scale, y: (cy - view.oy) / view.scale });
  canvas.addEventListener('click', (e) => {
    if (!meId) return;
    const r = canvas.getBoundingClientRect();
    const p = toWorld(e.clientX - r.left, e.clientY - r.top);
    hideMenu();
    // Clicou em alguém?
    let hit = null;
    for (const u of users.values()) {
      if (u.id === meId) continue;
      if (Math.abs(p.x - u.rx) < 14 && p.y > u.ry - 44 && p.y < u.ry + 6) hit = u;
    }
    if (hit) return showMenu(hit, e.clientX - r.left, e.clientY - r.top);
    target = { x: Math.max(8, Math.min(MAP.WIDTH - 8, p.x)), y: Math.max(8, Math.min(MAP.HEIGHT - 8, p.y)) };
    effects.push({ kind: 'click', x: target.x, y: target.y, t0: performance.now() });
  });

  function showMenu(u, x, y) {
    const m = $('ctxMenu');
    m.innerHTML = `<div class="hdr">${esc(u.name)} <span class="muted" style="font-weight:400">· ${STATUS_LABEL[u.status]}</span></div>
      ${u.zone === 'off' ? '<div class="muted" style="padding:4px 10px">🌙 Está OFF</div>' : '<button data-act="pull">📞 Puxar pra reunião (liga câmera e áudio)</button>'}
      <button data-act="walk">📍 Ir até ${esc(u.name)}</button>
      <button data-act="wave">👋 Acenar</button>`;
    m.style.left = Math.min(x, canvas.clientWidth - 200) + 'px';
    m.style.top = Math.min(y, canvas.clientHeight - 150) + 'px';
    m.classList.remove('hidden');
    m.onclick = (e) => { const b = e.target.closest('button'); if (b) { personAction(b.dataset.act, u.id); hideMenu(); } };
  }
  function hideMenu() { $('ctxMenu').classList.add('hidden'); }

  // ---------------------------------------------------------------- Loop
  let lastT = performance.now();
  function loop(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    update(dt, t);
    draw(t);
    requestAnimationFrame(loop);
  }

  function update(dt, t) {
    const me = users.get(meId);
    if (!me) return;
    let vx = 0;
    let vy = 0;
    if (keys.has('a') || keys.has('arrowleft')) vx -= 1;
    if (keys.has('d') || keys.has('arrowright')) vx += 1;
    if (keys.has('w') || keys.has('arrowup')) vy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) vy += 1;
    if (!vx && !vy && target) {
      const dx = target.x - me.x;
      const dy = target.y - me.y;
      const d = Math.hypot(dx, dy);
      if (d < 3) target = null;
      else { vx = dx / d; vy = dy / d; }
    }
    const len = Math.hypot(vx, vy);
    me.moving = len > 0;
    if (len) {
      const step = Math.min(SPEED * dt, target && !keys.size ? Math.hypot(target.x - me.x, target.y - me.y) : Infinity);
      me.x = Math.max(8, Math.min(MAP.WIDTH - 8, me.x + (vx / len) * step));
      me.y = Math.max(8, Math.min(MAP.HEIGHT - 8, me.y + (vy / len) * step));
      me.dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
    }
    me.rx = me.x;
    me.ry = me.y;

    const state = `${Math.round(me.x)},${Math.round(me.y)},${me.dir},${me.moving}`;
    if (state !== lastSentState && t - lastSent > 50) {
      lastSent = t;
      lastSentState = state;
      socket.emit('move', { x: me.x, y: me.y, dir: me.dir, moving: me.moving, tp: myTp });
    }

    for (const a of agents.values()) {
      const dx = a.x - a.rx;
      const dy = a.y - a.ry;
      const d = Math.hypot(dx, dy);
      a.walking = d > 1;
      if (a.walking) {
        const step = Math.min(d, AGENT_SPEED * dt);
        a.rx += (dx / d) * step;
        a.ry += (dy / d) * step;
        a.wdir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      } else {
        a.rx = a.x;
        a.ry = a.y;
      }
    }

    for (const u of users.values()) {
      if (u.id === meId) continue;
      const k = 1 - Math.pow(0.0005, dt);
      u.rx += (u.x - u.rx) * k;
      u.ry += (u.y - u.ry) * k;
    }
  }

  // ---------------------------------------------------------------- Desenho (pixel art)
  // Tudo é desenhado numa tela pequena (1 pixel de arte = 2 px do mundo) e ampliado sem suavização.
  const PX = 2;
  const AW = MAP.WIDTH / PX;
  const AH = MAP.HEIGHT / PX;
  const FONT = '"Pixelify Sans", ui-monospace, monospace';
  const OUT = '#1b1d2b';
  const ZSTYLE = {
    dev: { wall: '#5b6f9c', cap: '#3e4d70' },
    estudo: { wall: '#4f7a52', cap: '#36573a' },
    meeting: { wall: '#5a4f8f', cap: '#3f3668' },
    descanso: { wall: '#9b6b3f', cap: '#6f4a28' },
    off: { wall: '#23263a', cap: '#14162a' },
  };
  const WALL = 14; // altura da parede (pixels de arte)

  const dyn = document.createElement('canvas');
  dyn.width = AW;
  dyn.height = AH;
  const dctx = dyn.getContext('2d');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const scale = Math.min(w / MAP.WIDTH, h / MAP.HEIGHT) * 0.98;
    view = { scale, dpr, ox: (w - MAP.WIDTH * scale) / 2, oy: (h - MAP.HEIGHT * scale) / 2 };
    bakeStatic();
  }
  window.addEventListener('resize', resize);
  if (document.fonts) document.fonts.ready.then(() => { if (meId) resize(); });

  function rr(c, x, y, w, h) { c.beginPath(); c.rect(x, y, w, h); }
  const R = (c, color, x, y, w, h) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
  const box = (c, fill, x, y, w, h) => { R(c, OUT, x, y, w, h); R(c, fill, x + 1, y + 1, w - 2, h - 2); };

  let staticLayer = null;
  let artLayer = null;
  function bakeStatic() {
    if (!artLayer) {
      artLayer = document.createElement('canvas');
      artLayer.width = AW;
      artLayer.height = AH;
      drawArt(artLayer.getContext('2d'));
    }
    const s = view.scale * view.dpr;
    staticLayer = document.createElement('canvas');
    staticLayer.width = Math.ceil(MAP.WIDTH * s);
    staticLayer.height = Math.ceil(MAP.HEIGHT * s);
    const c = staticLayer.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(artLayer, 0, 0, staticLayer.width, staticLayer.height);
    // Placas com o nome das salas (texto nítido por cima da arte)
    c.scale(s, s);
    for (const z of MAP.zones) {
      const st = ZSTYLE[z.type === 'sector' ? 'dev' : z.type === 'study' ? 'estudo' : z.type === 'lounge' ? 'descanso' : z.type];
      c.font = `600 12px ${FONT}`;
      const label = z.name.toUpperCase();
      const tw = Math.ceil(c.measureText(label).width) + 14;
      c.fillStyle = OUT;
      c.fillRect(z.px + 8, z.py + 5, tw + 4, 20);
      c.fillStyle = st.cap;
      c.fillRect(z.px + 10, z.py + 7, tw, 16);
      c.fillStyle = '#f4f1e8';
      c.textBaseline = 'middle';
      c.fillText(label, z.px + 17, z.py + 15.5);
    }
  }

  function drawArt(c) {
    // Corredor: lajotas
    for (let y = 0; y < AH; y += 16) {
      for (let x = 0; x < AW; x += 16) {
        R(c, ((x + y) / 16) % 2 ? '#c7cad4' : '#c1c4cf', x, y, 16, 16);
        R(c, '#b0b3bf', x, y + 15, 16, 1);
        R(c, '#b0b3bf', x + 15, y, 1, 16);
        R(c, '#d3d6df', x, y, 15, 1);
      }
    }
    for (const z of MAP.zones) drawRoom(c, z);
    for (const [x, y] of [[13.5, 10.5], [26.5, 10.5], [10, 19.5], [20, 19.5], [30, 19.5], [0.5, 10.5], [39.5, 19.5]]) plant(c, (x * MAP.TILE) / PX, (y * MAP.TILE) / PX);
  }

  function drawRoom(c, z) {
    const x = z.px / PX;
    const y = z.py / PX;
    const w = z.pw / PX;
    const h = z.ph / PX;
    const key = z.type === 'sector' ? 'dev' : z.type === 'study' ? 'estudo' : z.type === 'lounge' ? 'descanso' : z.type;
    const st = ZSTYLE[key];
    // sombra externa
    R(c, 'rgba(0,0,0,.18)', x + 2, y + 3, w, h);
    floor(c, key, x, y + WALL, w, h - WALL);
    // parede do fundo
    R(c, st.wall, x, y, w, WALL);
    for (let i = x + 6; i < x + w; i += 12) R(c, st.cap, i, y + 4, 1, WALL - 6);
    R(c, st.cap, x, y, w, 3);
    R(c, 'rgba(0,0,0,.25)', x, y + WALL - 1, w, 1);
    R(c, 'rgba(0,0,0,.12)', x, y + WALL, w, 2);
    // paredes laterais e de baixo (contorno)
    R(c, st.cap, x, y, 2, h);
    R(c, st.cap, x + w - 2, y, 2, h);
    R(c, st.cap, x, y + h - 2, w, 2);
    // portas
    const cx = x + w / 2;
    const bottomDoor = z.y <= 18;
    if (bottomDoor) floorPatch(c, key, cx - 13, y + h - 2, 26, 2);
    if (z.y > 18) {
      floorPatch(c, key, cx - 13, y, 26, WALL);
      R(c, st.cap, cx - 15, y, 2, WALL);
      R(c, st.cap, cx + 13, y, 2, WALL);
    }
    // decoração da parede + móveis
    if (key === 'dev') {
      windowPane(c, x + 40, y + 3);
      windowPane(c, x + w - 120, y + 3);
      clock(c, x + w / 2 - 4, y + 4);
      for (const d of MAP.desks[z.id]) desk(c, d, false);
    } else if (key === 'estudo') {
      shelf(c, x + w - 78, y + 2);
      shelf(c, x + w - 136, y + 2);
      for (const d of MAP.desks[z.id]) desk(c, d, true);
    } else if (key === 'meeting') {
      const t = MAP.tables[z.id];
      board(c, x + w / 2 - 20, y + 3);
      for (const s of MAP.seats[z.id]) chairTop(c, s.x / PX, (s.y - 8) / PX);
      table(c, t.x / PX, t.y / PX, t.w / PX, t.h / PX);
    } else if (key === 'descanso') {
      lounge(c, z, x, y, w, h);
    } else if (key === 'off') {
      offRoom(c, z, x, y, w, h);
    }
    if (key !== 'off') plant(c, x + w - 11, y + WALL + 6);
    if (key === 'dev' || key === 'estudo') plant(c, x + 10, y + h - 9);
  }

  function floor(c, key, x, y, w, h) {
    R(c, '#000', x, y, w, h);
    floorPatch(c, key, x, y, w, h);
  }
  function floorPatch(c, key, x, y, w, h) {
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    if (key === 'dev') {
      const tones = ['#b7814f', '#ae7847', '#bf8a57'];
      for (let j = 0, yy = y - (y % 5); yy < y + h; j++, yy += 5) {
        R(c, tones[j % 3], x, yy, w, 5);
        R(c, '#8a5a30', x, yy + 4, w, 1);
        for (let xx = x - 40 + ((j * 23) % 40); xx < x + w; xx += 40) R(c, '#8a5a30', xx, yy, 1, 4);
      }
    } else if (key === 'estudo') {
      R(c, '#5d8f62', x, y, w, h);
      for (let yy = y - (y % 6); yy < y + h; yy += 6) for (let xx = x - (x % 6) + ((yy / 6) % 2) * 3; xx < x + w; xx += 6) R(c, '#6a9c6e', xx, yy, 1, 1);
    } else if (key === 'meeting') {
      R(c, '#6c75b3', x, y, w, h);
      for (let yy = y - (y % 8); yy < y + h; yy += 8) for (let xx = x - (x % 8); xx < x + w; xx += 8) { R(c, '#7881bf', xx, yy, 4, 4); R(c, '#7881bf', xx + 4, yy + 4, 4, 4); }
    } else if (key === 'descanso') {
      for (let yy = y - (y % 8); yy < y + h; yy += 8) for (let xx = x - (x % 8); xx < x + w; xx += 8) R(c, ((xx + yy) / 8) % 2 ? '#e9dcc0' : '#cdb48a', xx, yy, 8, 8);
    } else if (key === 'off') {
      R(c, '#2a2f48', x, y, w, h);
      for (let yy = y - (y % 10); yy < y + h; yy += 10) R(c, '#262a42', x, yy + 9, w, 1);
    }
    c.restore();
  }

  function windowPane(c, x, y) {
    box(c, '#9fd3f5', x, y, 40, 10);
    R(c, '#c9e9fb', x + 2, y + 2, 10, 2);
    R(c, '#e8eef6', x + 19, y + 1, 2, 8);
    R(c, '#e8eef6', x + 1, y + 4, 38, 1);
  }
  function clock(c, x, y) {
    box(c, '#f4f1e8', x, y, 9, 9);
    R(c, OUT, x + 4, y + 2, 1, 3);
    R(c, OUT, x + 4, y + 4, 3, 1);
  }
  function shelf(c, x, y) {
    box(c, '#7a5532', x, y, 54, 11);
    const colors = ['#ef5b6b', '#5b8cff', '#3ccf7a', '#f5c04a', '#a35bff', '#16b8c4', '#f08a4b'];
    for (let i = 0; i < 16; i++) {
      const bh = 6 + (i * 7) % 3;
      R(c, colors[i % colors.length], x + 2 + i * 3, y + 10 - bh, 2, bh - 1);
    }
  }
  function board(c, x, y) {
    box(c, '#2b2f3f', x, y, 40, 10);
    R(c, '#3a7bd5', x + 2, y + 2, 36, 6);
    R(c, '#7fb0ff', x + 4, y + 3, 10, 1);
    R(c, '#7fb0ff', x + 4, y + 5, 18, 1);
  }

  function desk(c, d, study) {
    const x = d.x / PX;
    const y = d.y / PX;
    const w = d.w / PX;
    const h = d.h / PX;
    // cadeira
    const chx = x + w / 2 - 6;
    const chy = y + h + 6;
    box(c, '#3d4256', chx, chy, 12, 9);
    R(c, '#4d536b', chx + 2, chy + 2, 8, 3);
    // mesa
    R(c, 'rgba(0,0,0,.2)', x + 1, y + h, w, 2);
    box(c, '#c99a63', x, y, w, h);
    R(c, '#9c6b3a', x + 1, y + h - 4, w - 2, 3);
    R(c, '#d8ad79', x + 1, y + 1, w - 2, 1);
    if (study) {
      box(c, '#f4f1e8', x + 6, y + 2, 7, 6);
      box(c, '#f4f1e8', x + 13, y + 2, 7, 6);
      R(c, '#b8b2a2', x + 8, y + 4, 4, 1);
      R(c, '#b8b2a2', x + 15, y + 4, 4, 1);
      R(c, OUT, x + w - 5, y + 2, 1, 6);
      R(c, '#f5c04a', x + w - 7, y + 1, 4, 2);
      return;
    }
    // monitor CRT
    const mx = x + w / 2 - 7;
    box(c, '#d9d2bf', mx, y - 4, 14, 10);
    R(c, '#2d5fc4', mx + 2, y - 2, 10, 6);
    R(c, '#7fb0ff', mx + 3, y - 1, 4, 1);
    R(c, '#b9b19b', mx + 5, y + 6, 4, 1);
    // teclado e caneca
    box(c, '#e8e6df', x + w / 2 - 6, y + 7, 12, 3);
    R(c, '#f4f1e8', x + w - 6, y + 3, 3, 3);
    R(c, '#c95b4a', x + w - 6, y + 3, 3, 1);
  }

  function chairTop(c, x, y) {
    box(c, '#4a3f86', x - 5, y - 4, 10, 9);
    R(c, '#6458a6', x - 3, y - 2, 6, 3);
  }
  function table(c, x, y, w, h) {
    R(c, 'rgba(0,0,0,.2)', x + 2, y + h, w, 2);
    box(c, '#9a6b45', x, y, w, h);
    R(c, '#ab7c55', x + 3, y + 3, w - 6, h - 9);
    R(c, '#6e4a2c', x + 1, y + h - 4, w - 2, 3);
    for (let i = 0; i < 3; i++) R(c, '#f4f1e8', x + 12 + i * 20, y + 7, 6, 4); // papéis
  }

  function lounge(c, z, x, y, w, h) {
    // tapete
    box(c, '#3c6582', x + 12, y + 22, 200, 98);
    R(c, '#4f7fa0', x + 15, y + 25, 194, 92);
    // sofás
    for (const j of [0, 1]) {
      const sy = (z.py + 80 + j * 84) / PX;
      box(c, '#8e2f2c', x + 12, sy, 200, 7);
      box(c, '#b6403a', x + 12, sy + 6, 200, 7);
      for (let k = 1; k < 7; k++) R(c, '#9a3430', x + 12 + k * 28, sy + 7, 1, 5);
      box(c, '#8e2f2c', x + 8, sy + 1, 6, 12);
      box(c, '#8e2f2c', x + 210, sy + 1, 6, 12);
    }
    // balcão do café
    const bx = (z.px + z.pw - 70) / PX;
    const by = (z.py + 40) / PX;
    box(c, '#6f4a28', bx, by, 28, 55);
    R(c, '#8c6239', bx + 2, by + 2, 24, 4);
    box(c, '#2b2b33', bx + 6, by + 8, 12, 12);
    R(c, '#e44', bx + 8, by + 10, 2, 2);
    R(c, '#f4f1e8', bx + 10, by + 22, 4, 4);
    box(c, '#dfe4ee', bx + 4, by + 32, 20, 20); // geladeira
    R(c, '#9aa2b6', bx + 20, by + 36, 1, 6);
    // quadro na parede
    box(c, '#d8b46a', x + 60, y + 3, 22, 9);
    R(c, '#5fa86a', x + 62, y + 5, 18, 5);
    R(c, '#f5c04a', x + 74, y + 5, 3, 2);
  }

  function offRoom(c, z, x, y, w, h) {
    // janela com lua
    box(c, '#0f1226', x + w - 46, y + 2, 30, 11);
    R(c, '#f3e7b0', x + w - 26, y + 4, 5, 6);
    R(c, '#0f1226', x + w - 24, y + 4, 3, 4);
    for (let i = 0; i < 6; i++) R(c, '#c9d4ff', x + w - 44 + i * 3, y + 4 + (i * 5) % 7, 1, 1);
    // estrelinhas no chão (luzinhas)
    for (let i = 0; i < 30; i++) R(c, 'rgba(255,255,255,.35)', x + 8 + ((i * 97) % (w - 16)), y + WALL + 6 + ((i * 53) % (h - WALL - 12)), 1, 1);
    // pufes
    for (const s of MAP.seats[z.id]) {
      const px = s.x / PX;
      const py = (s.y - 6) / PX;
      R(c, OUT, px - 7, py - 4, 14, 9);
      R(c, OUT, px - 8, py - 2, 16, 5);
      R(c, '#4b5170', px - 6, py - 3, 12, 7);
      R(c, '#4b5170', px - 7, py - 1, 14, 3);
      R(c, '#5d6488', px - 4, py - 2, 6, 2);
    }
  }

  function plant(c, x, y) {
    R(c, OUT, x - 4, y, 9, 7);
    R(c, '#b5653a', x - 3, y + 1, 7, 5);
    R(c, '#cf7b4b', x - 3, y + 1, 7, 1);
    R(c, OUT, x - 6, y - 9, 13, 10);
    R(c, '#2c7a3a', x - 5, y - 8, 11, 8);
    R(c, '#3f9b4f', x - 4, y - 8, 7, 6);
    R(c, '#5bbf63', x - 2, y - 7, 2, 2);
    R(c, '#5bbf63', x + 2, y - 4, 2, 1);
  }

  // ---------------------------------------------------------------- Sprites
  const spriteCache = new Map();
  function sprite(key, rows, pal) {
    let s = spriteCache.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = rows[0].length;
    s.height = rows.length;
    const c = s.getContext('2d');
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const col = pal[row[x]];
        if (col) { c.fillStyle = col; c.fillRect(x, y, 1, 1); }
      }
    });
    if (spriteCache.size > 600) spriteCache.clear();
    spriteCache.set(key, s);
    return s;
  }

  const P_DOWN = [
    '...OOOOOO...', '..OHHHHHHO..', '.OHHHHHHHHO.', '.OHSSSSSSHO.', '.OSSSSSSSSO.', '.OSESSSSESO.', '.OSSSSSSSSO.',
    '..OSSSSSSO..', '..OOSSSSOO..', '.OTTTTTTTTO.', 'OtTTTTTTTTtO', 'OtTTTTTTTTtO', 'OSTTTTTTTTSO', '.OTTTTTTTTO.',
  ];
  const P_UP = [
    '...OOOOOO...', '..OHHHHHHO..', '.OHHHHHHHHO.', '.OHHHHHHHHO.', '.OHHHHHHHHO.', '.OHHHHHHHHO.', '.OHHHHHHHHO.',
    '..OHHHHHHO..', '..OOSSSSOO..', '.OTTTTTTTTO.', 'OtTTTTTTTTtO', 'OtTTTTTTTTtO', 'OSTTTTTTTTSO', '.OTTTTTTTTO.',
  ];
  const P_SIDE = [
    '...OOOOO....', '..OHHHHHO...', '.OHHHHHHHO..', '.OHHHHSSSO..', '.OHHSSSSSO..', '.OHSSSSESO..', '.OHSSSSSSO..',
    '..OSSSSSO...', '...OSSSO....', '..OTTTTTO...', '..OTTtTTO...', '..OTTtTTO...', '..OTTSTTO...', '..OTTTTTO...',
  ];
  const L_FRONT = [
    ['.OPPPPPPPPO.', '.OPPPOOPPPO.', '..OPO..OPO..', '..OBO..OBO..', '..OOO..OOO..'],
    ['.OPPPPPPPPO.', '.OPPPOOPPPO.', '..OBO..OPO..', '..OOO..OBO..', '.......OOO..'],
    ['.OPPPPPPPPO.', '.OPPPOOPPPO.', '..OPO..OBO..', '..OBO..OOO..', '..OOO.......'],
  ];
  const L_SIDE = [
    ['..OPPPPPO...', '..OPPOPPO...', '..OPO.OPO...', '..OBO.OBO...', '..OOO.OOO...'],
    ['..OPPPPPO...', '..OPPOPPO...', '.OPO...OPO..', '.OBO...OBO..', '.OOO...OOO..'],
    ['..OPPPPPO...', '..OPPOPPO...', '..OPO.OPO...', '..OBO.OBO...', '..OOO.OOO...'],
  ];

  function personSprite(u, dir, frame, blink) {
    const side = dir === 'left' || dir === 'right';
    const top = dir === 'up' ? P_UP : side ? P_SIDE : P_DOWN;
    const legs = (side ? L_SIDE : L_FRONT)[frame];
    const key = `p|${u.color}|${u.skin}|${u.hair}|${dir}|${frame}|${blink}`;
    return sprite(key, [...top, ...legs], {
      O: OUT, H: u.hair, S: u.skin, E: blink ? u.skin : '#1d2030', T: u.color, t: shade(u.color, -30), P: '#2d3142', B: '#141622',
    });
  }

  function robotSprite(a, dir, frame, eyes, arms, led) {
    const face = dir === 'up'
      ? ['.OMMMMMMMMO.', '.OMMMMMMMMO.', '.OMMMMMMMMO.']
      : eyes === 'closed'
        ? ['.OMDDDDDDMO.', '.OMDDDDDDMO.', '.OMggDDggMO.']
        : eyes === 'blink'
          ? ['.OMDDDDDDMO.', '.OMDDDDDDMO.', '.OMDDDDDDMO.']
          : ['.OMDDDDDDMO.', '.OMDGDDGDMO.', '.OMDGDDGDMO.'];
    const armRow = (r) => (arms[0] === r ? 'm' : arms[0] + 1 === r ? 'm' : '.');
    const armRowR = (r) => (arms[1] === r ? 'm' : arms[1] + 1 === r ? 'm' : '.');
    const body = [9, 10, 11, 12].map((r, i) => armRow(r) + ['OMMMMMMMMO', 'OCCCCCCCCO', 'OMMMMMMMMO', 'OMMMMMMMMO'][i] + armRowR(r));
    const legs = [
      ['..OMO..OMO..', '..OMO..OMO..', '..OOO..OOO..'],
      ['..OMO..OMO..', '..OOO..OMO..', '.......OOO..'],
      ['..OMO..OMO..', '..OMO..OOO..', '..OOO.......'],
    ][frame];
    const rows = ['.....LL.....', '.....OO.....', '..OOOOOOOO..', '.OMMMMMMMMO.', ...face, '.OMMMMMMMMO.', '..OOOOOOOO..', ...body, '..OOOOOOOO..', ...legs];
    const eyeColor = eyes === 'wait' ? '#f5c04a' : '#7df0c2';
    const key = `r|${a.color}|${dir}|${frame}|${eyes}|${arms}|${led}`;
    return sprite(key, rows, { O: OUT, M: '#c3c9d6', D: '#1d2236', G: eyeColor, g: '#7f8bb0', C: a.color, m: '#8f97ab', L: led });
  }

  function shadow(c, x, y, wd) {
    c.fillStyle = 'rgba(0,0,0,.25)';
    c.fillRect(x - wd, y - 1, wd * 2 + 1, 2);
    c.fillRect(x - wd + 2, y + 1, wd * 2 - 3, 1);
  }

  function draw(t) {
    const { scale, ox, oy, dpr } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#151726';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (staticLayer) ctx.drawImage(staticLayer, ox * dpr, oy * dpr);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, ox * dpr, oy * dpr);
    ctx.imageSmoothingEnabled = false;

    // Salas de reunião em uso: moldura piscando
    const occ = {};
    for (const u of users.values()) if (u.call) occ[u.call] = (occ[u.call] || 0) + 1;
    for (const z of MAP.zones) {
      if (z.type !== 'meeting' || !occ[z.id]) continue;
      if (Math.floor(t / 500) % 2) {
        ctx.strokeStyle = '#ef5b6b';
        ctx.lineWidth = 4;
        ctx.strokeRect(z.px - 3, z.py - 3, z.pw + 6, z.ph + 6);
      }
      ctx.fillStyle = OUT;
      ctx.fillRect(z.px + z.pw - 78, z.py + 5, 70, 20);
      ctx.fillStyle = '#ef5b6b';
      ctx.fillRect(z.px + z.pw - 76, z.py + 7, 66, 16);
      ctx.fillStyle = '#fff';
      ctx.font = `600 11px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(`● AO VIVO ${occ[z.id]}`, z.px + z.pw - 71, z.py + 15.5);
    }

    // Marcador de destino
    const me = users.get(meId);
    if (target && me) {
      ctx.strokeStyle = 'rgba(91,140,255,.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(me.x, me.y); ctx.lineTo(target.x, target.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- Camada de pixels (personagens e efeitos)
    dctx.clearRect(0, 0, AW, AH);
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i];
      if (f.kind !== 'click' && f.kind !== 'poof') continue;
      const p = (t - f.t0) / (f.kind === 'poof' ? 500 : 450);
      if (p >= 1) { effects.splice(i, 1); continue; }
      const fx = Math.round(f.x / PX);
      const fy = Math.round(f.y / PX);
      if (f.kind === 'click') {
        const r = Math.round(2 + p * 6);
        dctx.fillStyle = `rgba(91,140,255,${1 - p})`;
        dctx.fillRect(fx - r, fy, 2, 1); dctx.fillRect(fx + r - 1, fy, 2, 1);
        dctx.fillRect(fx, fy - Math.ceil(r / 2), 1, 1); dctx.fillRect(fx, fy + Math.ceil(r / 2), 1, 1);
      } else {
        dctx.fillStyle = `rgba(255,255,255,${1 - p})`;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const s = p < 0.5 ? 3 : 2;
          dctx.fillRect(Math.round(fx + Math.cos(a) * p * 13), Math.round(fy - 8 + Math.sin(a) * p * 10), s, s);
        }
      }
    }
    const list = [...users.values(), ...agents.values()].sort((a, b) => a.ry - b.ry);
    for (const u of list) (agents.has(u.id) ? drawAgentSprite(u, t) : drawPersonSprite(u, t));
    ctx.drawImage(dyn, 0, 0, MAP.WIDTH, MAP.HEIGHT);

    // ---- Textos nítidos por cima
    for (const u of list) (agents.has(u.id) ? drawAgentLabel(u, t) : drawPersonLabel(u, t));
    for (const u of list) drawBubble(u, t);

    // Emojis flutuando
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i];
      if (f.kind !== 'emoji') continue;
      const p = (t - f.t0) / 1600;
      const u = users.get(f.id);
      if (p >= 1 || !u) { effects.splice(i, 1); continue; }
      ctx.globalAlpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
      ctx.font = `${22 + Math.sin(p * Math.PI) * 8}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(f.emoji, u.rx + f.dx + Math.sin(p * 9) * 4, u.ry - 52 - p * 46);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
  }

  function isMoving(u) {
    return u.id === meId ? u.moving : Math.hypot(u.x - u.rx, u.y - u.ry) > 0.8 || u.moving;
  }

  function drawPersonSprite(u, t) {
    const x = Math.round(u.rx / PX);
    const y = Math.round(u.ry / PX);
    const moving = isMoving(u);
    const frame = moving ? 1 + (Math.floor(t / 130 + u.phase) % 2) : 0;
    const blink = (t / 1000 + u.phase) % 4 < 0.12;
    const bob = moving && frame === 1 ? -1 : 0;
    const off = u.zone === 'off';
    dctx.globalAlpha = off ? 0.55 : 1;
    shadow(dctx, x, y, 5);
    if (u.id === meId && Math.floor(t / 400) % 2) {
      dctx.fillStyle = '#5b8cff';
      dctx.fillRect(x - 8, y - 1, 2, 2); dctx.fillRect(x + 7, y - 1, 2, 2);
      dctx.fillRect(x - 6, y + 1, 13, 1); dctx.fillRect(x - 6, y - 2, 13, 1);
    }
    const s = personSprite(u, u.dir, frame, blink);
    const flip = u.dir === 'left';
    if (flip) {
      dctx.save();
      dctx.scale(-1, 1);
      dctx.drawImage(s, -x - 6, y - 19 + bob);
      dctx.restore();
    } else {
      dctx.drawImage(s, x - 6, y - 19 + bob);
    }
    // bolinha de status
    dctx.fillStyle = OUT;
    dctx.fillRect(x + 4, y - 21 + bob, 5, 5);
    dctx.fillStyle = STATUS_COLOR[u.status] || '#999';
    dctx.fillRect(x + 5, y - 20 + bob, 3, 3);
    dctx.globalAlpha = 1;
  }

  function drawPersonLabel(u, t) {
    const x = u.rx;
    const y = u.ry;
    const isMe = u.id === meId;
    const off = u.zone === 'off';
    ctx.globalAlpha = off ? 0.6 : 1;
    nameTag(u.name, x, y, isMe ? '#3d63d6' : 'rgba(27,29,43,.85)');
    if (off) {
      ctx.globalAlpha = 0.5 + Math.sin(t / 500 + u.phase) * 0.4;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillStyle = '#c9d4ff';
      ctx.fillText('z', x + 14, y - 44 - ((t / 40 + u.phase * 10) % 8));
      ctx.fillText('Z', x + 21, y - 52 - ((t / 40 + u.phase * 10) % 8));
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  function nameTag(text, x, y, bg) {
    ctx.font = `600 11px ${FONT}`;
    const tw = Math.ceil(ctx.measureText(text).width) + 10;
    const lx = Math.round(x - tw / 2);
    ctx.fillStyle = OUT;
    ctx.fillRect(lx - 1, y + 4, tw + 2, 16);
    ctx.fillStyle = bg;
    ctx.fillRect(lx, y + 5, tw, 14);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 12.5);
  }

  function drawAgentSprite(a, t) {
    const x = Math.round(a.rx / PX);
    const y = Math.round(a.ry / PX);
    const dir = a.walking ? a.wdir : a.dir;
    const working = a.state === 'working' && !a.walking;
    const frame = a.walking ? 1 + (Math.floor(t / 140 + a.phase) % 2) : 0;
    const blink = (t / 1000 + a.phase) % 3.5 < 0.1;
    const eyes = a.state === 'idle' && !a.walking ? 'closed' : blink ? 'blink' : a.state === 'waiting' ? 'wait' : 'open';
    const tap = working ? Math.floor(t / 110 + a.phase) % 2 : 0;
    const arms = working ? [9 + tap, 10 - tap] : [10, 10];
    const ledOn = a.state === 'working' ? Math.floor(t / 250) % 2 === 0 : true;
    const led = a.state === 'working' ? (ledOn ? '#3ccf7a' : '#1f6b40') : a.state === 'waiting' ? '#f5c04a' : '#8b93a8';
    const bob = !a.walking && a.state !== 'idle' ? 0 : a.walking && frame === 1 ? -1 : 0;
    shadow(dctx, x, y, 5);
    dctx.drawImage(robotSprite(a, dir === 'up' ? 'up' : 'down', frame, eyes, arms, led), x - 6, y - 17 + bob);
    if (a.state === 'waiting' && !a.walking) {
      const up = Math.floor(t / 300) % 2;
      const bx = x - 3;
      const by = y - 28 - up;
      dctx.fillStyle = OUT;
      dctx.fillRect(bx, by, 7, 9);
      dctx.fillStyle = '#f5c04a';
      dctx.fillRect(bx + 1, by + 1, 5, 7);
      dctx.fillStyle = OUT;
      dctx.fillRect(bx + 3, by + 2, 1, 3);
      dctx.fillRect(bx + 3, by + 6, 1, 1);
    }
  }

  function drawAgentLabel(a, t) {
    const x = a.rx;
    const y = a.ry;
    nameTag(`🤖 ${a.name}`, x, y, 'rgba(27,29,43,.85)');
    const working = a.state === 'working' && !a.walking;
    if (working && a.tool && !(a.bubble && t < a.bubble.until)) {
      const tag = `${TOOL_ICON[a.tool] || '⚙️'} ${a.tool}`;
      ctx.font = `600 10px ${FONT}`;
      const w = Math.ceil(ctx.measureText(tag).width) + 10;
      const lx = Math.round(x - w / 2);
      ctx.fillStyle = OUT;
      ctx.fillRect(lx - 1, y - 55, w + 2, 15);
      ctx.fillStyle = '#3ccf7a';
      ctx.fillRect(lx, y - 54, w, 13);
      ctx.fillStyle = '#0f2a1b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tag, x, y - 47.5);
    }
    if (a.state === 'idle' && !a.walking) {
      ctx.globalAlpha = 0.5 + Math.sin(t / 500 + a.phase) * 0.4;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillStyle = '#9aa7d6';
      ctx.textAlign = 'left';
      ctx.fillText('z', x + 13, y - 38 - ((t / 40 + a.phase * 10) % 8));
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  }

  function drawBubble(u, t) {
    if (!u.bubble || t > u.bubble.until) return;
    const fade = Math.min(1, (u.bubble.until - t) / 400);
    ctx.globalAlpha = fade;
    ctx.font = `500 12px ${FONT}`;
    const lines = wrap(u.bubble.text, 150).slice(0, 4);
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 14;
    const h = lines.length * 14 + 8;
    const bx = Math.round(u.rx - w / 2);
    const by = Math.round(u.ry - 52 - h);
    ctx.fillStyle = OUT;
    ctx.fillRect(bx - 2, by - 2, w + 4, h + 4);
    ctx.fillRect(Math.round(u.rx) - 4, by + h, 8, 6);
    ctx.fillStyle = '#fff';
    ctx.fillRect(bx, by, w, h);
    ctx.fillRect(Math.round(u.rx) - 2, by + h, 4, 4);
    ctx.fillStyle = '#1d2030';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + 7, by + 5 + i * 14));
    ctx.globalAlpha = 1;
  }

  function wrap(text, maxW) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function poof(x, y) { effects.push({ kind: 'poof', x, y, t0: performance.now() }); }

  // ---------------------------------------------------------------- Chamada (WebRTC mesh)
  const call = { room: null, local: null, ready: null, peers: new Map(), mic: true, cam: true };

  socket.on('call-joined', async ({ room, peers }) => {
    call.room = room;
    $('callRoom').textContent = `🗣️ ${MAP.zoneById[room].name}`;
    $('callBar').classList.remove('hidden');
    call.ready = getMedia();
    await call.ready;
    if (call.room !== room) return;
    for (const id of peers) offerTo(id);
  });
  socket.on('call-left', () => endCall());
  socket.on('peer-left', ({ id }) => closePeer(id));

  socket.on('signal', async ({ from, data }) => {
    if (!call.room) return;
    await call.ready;
    try {
      if (data.sdp) {
        let p = call.peers.get(from);
        if (data.sdp.type === 'offer') {
          if (!p) p = makePeer(from);
          await p.pc.setRemoteDescription(data.sdp);
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          socket.emit('signal', { to: from, data: { sdp: p.pc.localDescription } });
        } else if (p) {
          await p.pc.setRemoteDescription(data.sdp);
        }
        if (p) { for (const c of p.queue) await p.pc.addIceCandidate(c).catch(() => {}); p.queue = []; }
      } else if (data.candidate) {
        const p = call.peers.get(from);
        if (!p) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
        else p.queue.push(data.candidate);
      }
    } catch (err) {
      console.warn('signal error', err);
    }
  });

  async function getMedia() {
    if (call.local) return call.local;
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: 320, height: 240 } });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        toast('Câmera indisponível — entrando só com áudio.');
      } catch {
        toast('Sem microfone/câmera — você vai só ouvir e ver. (Precisa de HTTPS ou localhost.)');
      }
    }
    call.local = stream;
    if (stream) {
      stream.getAudioTracks().forEach((tr) => (tr.enabled = call.mic));
      stream.getVideoTracks().forEach((tr) => (tr.enabled = call.cam));
    }
    tile('me', stream, users.get(meId)?.name + ' (você)', true);
    updateButtons();
    return stream;
  }

  function makePeer(id) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const p = { pc, queue: [], stream: new MediaStream() };
    call.peers.set(id, p);
    if (call.local) {
      call.local.getTracks().forEach((tr) => pc.addTrack(tr, call.local));
    }
    const kinds = new Set(call.local ? call.local.getTracks().map((tr) => tr.kind) : []);
    for (const k of ['audio', 'video']) if (!kinds.has(k)) pc.addTransceiver(k, { direction: 'recvonly' });
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      if (!p.stream.getTracks().includes(e.track)) p.stream.addTrack(e.track);
      tile(id, p.stream, users.get(id)?.name || '...', false);
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') toast(`Conexão com ${users.get(id)?.name} falhou (rede bloqueando?).`); };
    tile(id, null, users.get(id)?.name || '...', false);
    return p;
  }

  async function offerTo(id) {
    const p = makePeer(id);
    await p.pc.setLocalDescription(await p.pc.createOffer());
    socket.emit('signal', { to: id, data: { sdp: p.pc.localDescription } });
  }

  function closePeer(id) {
    const p = call.peers.get(id);
    if (p) p.pc.close();
    call.peers.delete(id);
    document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`)?.remove();
  }

  function endCall() {
    for (const id of [...call.peers.keys()]) closePeer(id);
    call.local?.getTracks().forEach((tr) => tr.stop());
    call.local = null;
    call.ready = null;
    call.room = null;
    $('videos').innerHTML = '';
    $('callBar').classList.add('hidden');
  }

  function tile(id, stream, name, isMe) {
    let el = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile' + (isMe ? ' me' : '');
      el.dataset.id = id;
      const u = users.get(isMe ? meId : id);
      el.innerHTML = `<div class="noCam" style="background:${u?.color || '#333'}">${esc((u?.name || '?')[0].toUpperCase())}</div>
        <video autoplay playsinline ${isMe ? 'muted' : ''}></video><div class="label"></div>`;
      $('videos').appendChild(el);
    }
    el.querySelector('.label').textContent = name;
    const v = el.querySelector('video');
    if (stream && v.srcObject !== stream) v.srcObject = stream;
    const hasVideo = stream && stream.getVideoTracks().some((tr) => tr.readyState === 'live');
    v.style.visibility = hasVideo ? 'visible' : 'hidden';
    if (stream && !isMe) v.play().catch(() => {});
    if (stream) watchSpeaking(el, stream, isMe);
  }

  // Borda verde em quem está falando
  let audioCtx = null;
  function watchSpeaking(el, stream, isMe) {
    if (el._watching || !stream.getAudioTracks().length) return;
    el._watching = true;
    try {
      audioCtx = audioCtx || new AudioContext();
      const src = audioCtx.createMediaStreamSource(isMe ? new MediaStream(stream.getAudioTracks()) : stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (!el.isConnected) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const b of buf) sum += (b - 128) ** 2;
        el.classList.toggle('speaking', Math.sqrt(sum / buf.length) > 6);
        setTimeout(tick, 120);
      };
      tick();
    } catch { /* sem análise de áudio */ }
  }

  function updateButtons() {
    $('micBtn').classList.toggle('off', !call.mic);
    $('camBtn').classList.toggle('off', !call.cam);
  }
  $('micBtn').onclick = () => {
    call.mic = !call.mic;
    call.local?.getAudioTracks().forEach((tr) => (tr.enabled = call.mic));
    updateButtons();
  };
  $('camBtn').onclick = () => {
    call.cam = !call.cam;
    call.local?.getVideoTracks().forEach((tr) => (tr.enabled = call.cam));
    const me = document.querySelector('.tile.me video');
    if (me) me.style.visibility = call.cam && call.local?.getVideoTracks().length ? 'visible' : 'hidden';
    updateButtons();
  };
  $('leaveBtn').onclick = () => socket.emit('leave-meeting');
})();
