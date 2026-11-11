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

  socket.on('init', ({ me, users: list }) => {
    meId = me.id;
    myTp = 0;
    users.clear();
    list.forEach(addUser);
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
      $('people').innerHTML = html;
      $('onlineCount').textContent = users.size;
    }, 30);
  }
  $('people').onclick = (e) => {
    const btn = e.target.closest('button');
    const row = e.target.closest('.person');
    if (!btn || !row) return;
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

    for (const u of users.values()) {
      if (u.id === meId) continue;
      const k = 1 - Math.pow(0.0005, dt);
      u.rx += (u.x - u.rx) * k;
      u.ry += (u.y - u.ry) * k;
    }
  }

  // ---------------------------------------------------------------- Desenho
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

  let staticLayer = null;
  function bakeStatic() {
    const s = view.scale * view.dpr;
    staticLayer = document.createElement('canvas');
    staticLayer.width = Math.ceil(MAP.WIDTH * s);
    staticLayer.height = Math.ceil(MAP.HEIGHT * s);
    const c = staticLayer.getContext('2d');
    c.scale(s, s);
    drawStatic(c);
  }

  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h);
  }

  function drawStatic(c) {
    const T = MAP.TILE;
    // Piso do corredor
    c.fillStyle = '#c9ccd8';
    c.fillRect(0, 0, MAP.WIDTH, MAP.HEIGHT);
    c.strokeStyle = 'rgba(0,0,0,.05)';
    c.lineWidth = 1;
    for (let x = 0; x <= MAP.COLS; x++) { c.beginPath(); c.moveTo(x * T, 0); c.lineTo(x * T, MAP.HEIGHT); c.stroke(); }
    for (let y = 0; y <= MAP.ROWS; y++) { c.beginPath(); c.moveTo(0, y * T); c.lineTo(MAP.WIDTH, y * T); c.stroke(); }

    for (const z of MAP.zones) {
      // sombra + piso
      c.fillStyle = 'rgba(0,0,0,.12)';
      rr(c, z.px + 3, z.py + 5, z.pw, z.ph, 10); c.fill();
      c.fillStyle = z.floor;
      rr(c, z.px, z.py, z.pw, z.ph, 10); c.fill();
      // padrão do piso
      c.save();
      rr(c, z.px, z.py, z.pw, z.ph, 10); c.clip();
      c.strokeStyle = 'rgba(0,0,0,.045)';
      if (z.type === 'lounge') {
        for (let i = -z.ph; i < z.pw; i += 16) { c.beginPath(); c.moveTo(z.px + i, z.py); c.lineTo(z.px + i + z.ph, z.py + z.ph); c.stroke(); }
      } else {
        for (let x = z.px; x < z.px + z.pw; x += T / 2) { c.beginPath(); c.moveTo(x, z.py); c.lineTo(x, z.py + z.ph); c.stroke(); }
      }
      c.restore();
      // paredes
      c.strokeStyle = z.wall;
      c.lineWidth = 5;
      rr(c, z.px, z.py, z.pw, z.ph, 10); c.stroke();
      // porta (abertura na parede voltada pro corredor)
      const doorY = z.y < 10 ? z.py + z.ph : z.y > 18 ? z.py : z.py + z.ph;
      c.strokeStyle = z.floor;
      c.lineWidth = 7;
      c.beginPath(); c.moveTo(z.px + z.pw / 2 - 26, doorY); c.lineTo(z.px + z.pw / 2 + 26, doorY); c.stroke();
      if (z.type !== 'sector') { c.beginPath(); c.moveTo(z.px + z.pw / 2 - 26, z.py); c.lineTo(z.px + z.pw / 2 + 26, z.py); c.stroke(); }
      // placa
      c.font = '600 13px system-ui, sans-serif';
      const label = `${z.icon} ${z.name}`;
      const tw = c.measureText(label).width + 18;
      c.fillStyle = z.wall;
      rr(c, z.px + 10, z.py + 8, tw, 22, 11); c.fill();
      c.fillStyle = '#fff';
      c.textBaseline = 'middle';
      c.fillText(label, z.px + 19, z.py + 19.5);

      // móveis
      for (const d of MAP.desks[z.id]) drawDesk(c, d, z.type === 'study');
      if (MAP.tables[z.id]) drawMeetingTable(c, z, MAP.tables[z.id]);
      if (z.type === 'lounge') drawLounge(c, z);
      if (z.type === 'off') drawOff(c, z);
      if (z.type === 'study') drawShelf(c, z);
      if (z.type !== 'off') drawPlant(c, z.px + z.pw - 22, z.py + 26);
      if (z.type === 'sector' || z.type === 'study') drawPlant(c, z.px + 20, z.py + z.ph - 22);
    }
    // decoração no corredor
    for (const [x, y] of [[13.5, 10.5], [26.5, 10.5], [10, 19.5], [20, 19.5], [30, 19.5], [0.5, 10.5], [39.5, 19.5]]) drawPlant(c, x * T, y * T);
  }

  function drawDesk(c, d, study) {
    // cadeira
    c.fillStyle = '#4b5068';
    rr(c, d.x + d.w / 2 - 11, d.y + d.h + 12, 22, 18, 6); c.fill();
    // mesa
    c.fillStyle = 'rgba(0,0,0,.15)';
    rr(c, d.x + 2, d.y + 4, d.w, d.h, 5); c.fill();
    c.fillStyle = '#c08a57';
    rr(c, d.x, d.y, d.w, d.h, 5); c.fill();
    c.fillStyle = '#a8743f';
    c.fillRect(d.x, d.y + d.h - 5, d.w, 5);
    if (study) {
      // livros abertos + luminária
      c.fillStyle = '#fff';
      rr(c, d.x + 12, d.y + 6, 15, 12, 2); c.fill();
      rr(c, d.x + 28, d.y + 6, 15, 12, 2); c.fill();
      c.strokeStyle = '#bbb'; c.lineWidth = 1;
      for (const ly of [9, 12, 15]) { c.beginPath(); c.moveTo(d.x + 14, d.y + ly); c.lineTo(d.x + 25, d.y + ly); c.moveTo(d.x + 30, d.y + ly); c.lineTo(d.x + 41, d.y + ly); c.stroke(); }
      c.fillStyle = '#f5c04a';
      c.beginPath(); c.arc(d.x + d.w - 8, d.y + 8, 4, 0, Math.PI * 2); c.fill();
      return;
    }
    // monitor
    c.fillStyle = '#2b2f3f';
    rr(c, d.x + d.w / 2 - 15, d.y + 2, 30, 17, 3); c.fill();
    c.fillStyle = '#7fb4ff';
    c.fillRect(d.x + d.w / 2 - 12, d.y + 4.5, 24, 12);
    c.fillStyle = '#2b2f3f';
    c.fillRect(d.x + d.w / 2 - 3, d.y + 19, 6, 4);
    // caneca
    c.fillStyle = '#fff';
    c.beginPath(); c.arc(d.x + d.w - 9, d.y + 14, 3.5, 0, Math.PI * 2); c.fill();
  }

  function drawMeetingTable(c, z, t) {
    for (const s of MAP.seats[z.id]) {
      c.fillStyle = '#6b5aa6';
      c.beginPath(); c.arc(s.x, s.y - 8, 11, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = 'rgba(0,0,0,.15)';
    rr(c, t.x + 3, t.y + 5, t.w, t.h, 26); c.fill();
    c.fillStyle = '#8d6a4a';
    rr(c, t.x, t.y, t.w, t.h, 26); c.fill();
    c.fillStyle = '#a07b58';
    rr(c, t.x + 6, t.y + 5, t.w - 12, t.h - 12, 22); c.fill();
    // TV na parede
    c.fillStyle = '#2b2f3f';
    rr(c, z.px + z.pw / 2 - 40, z.py + 36, 80, 10, 3); c.fill();
  }

  function drawLounge(c, z) {
    // balcão + cafeteira
    c.fillStyle = '#8c6239';
    rr(c, z.px + z.pw - 70, z.py + 40, 56, 110, 6); c.fill();
    c.fillStyle = '#333';
    rr(c, z.px + z.pw - 58, z.py + 52, 24, 26, 4); c.fill();
    c.fillStyle = '#e44';
    c.beginPath(); c.arc(z.px + z.pw - 46, z.py + 60, 2.5, 0, Math.PI * 2); c.fill();
    // tapete
    c.fillStyle = 'rgba(169,123,69,.18)';
    rr(c, z.px + 22, z.py + 44, 400, 196, 22); c.fill();
    // sofás atrás dos assentos
    for (const j of [0, 1]) {
      c.fillStyle = '#c0664a';
      rr(c, z.px + 24, z.py + 80 + j * 84, 398, 20, 9); c.fill();
      c.fillStyle = '#d87d5a';
      rr(c, z.px + 28, z.py + 92 + j * 84, 390, 14, 6); c.fill();
    }
  }

  function drawShelf(c, z) {
    c.fillStyle = '#7a5532';
    rr(c, z.px + z.pw - 150, z.py + 10, 100, 20, 3); c.fill();
    const colors = ['#ef5b6b', '#5b8cff', '#3ccf7a', '#f5c04a', '#a35bff', '#16b8c4'];
    for (let i = 0; i < 14; i++) {
      c.fillStyle = colors[i % colors.length];
      c.fillRect(z.px + z.pw - 146 + i * 6.8, z.py + 13, 5, 14);
    }
  }

  function drawOff(c, z) {
    // céu estrelado + lua
    c.fillStyle = 'rgba(255,255,255,.55)';
    for (let i = 0; i < 40; i++) {
      const sx = z.px + 20 + ((i * 97) % (z.pw - 40));
      const sy = z.py + 40 + ((i * 53) % (z.ph - 60));
      c.fillRect(sx, sy, 1.6, 1.6);
    }
    c.fillStyle = '#f3e7b0';
    c.beginPath(); c.arc(z.px + z.pw - 40, z.py + 40, 14, 0, Math.PI * 2); c.fill();
    c.fillStyle = z.floor;
    c.beginPath(); c.arc(z.px + z.pw - 34, z.py + 35, 12, 0, Math.PI * 2); c.fill();
    // pufes
    for (const s of MAP.seats[z.id]) {
      c.fillStyle = '#4b5170';
      c.beginPath(); c.ellipse(s.x, s.y - 6, 16, 11, 0, 0, Math.PI * 2); c.fill();
    }
  }

  function drawPlant(c, x, y) {
    c.fillStyle = '#b06b3c';
    rr(c, x - 7, y, 14, 11, 3); c.fill();
    c.fillStyle = '#3f9b4f';
    for (const [dx, dy, r] of [[0, -6, 8], [-6, -2, 6], [6, -2, 6], [0, -12, 5]]) {
      c.beginPath(); c.arc(x + dx, y + dy, r, 0, Math.PI * 2); c.fill();
    }
  }

  function draw(t) {
    const { scale, ox, oy, dpr } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#151726';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (staticLayer) ctx.drawImage(staticLayer, ox * dpr, oy * dpr);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, ox * dpr, oy * dpr);

    // Salas de reunião em uso: brilho pulsante
    const occ = {};
    for (const u of users.values()) if (u.call) occ[u.call] = (occ[u.call] || 0) + 1;
    for (const z of MAP.zones) {
      if (z.type !== 'meeting' || !occ[z.id]) continue;
      const a = 0.35 + Math.sin(t / 400) * 0.25;
      ctx.strokeStyle = `rgba(124,92,196,${a})`;
      ctx.lineWidth = 10;
      rr(ctx, z.px - 4, z.py - 4, z.pw + 8, z.ph + 8, 14); ctx.stroke();
      ctx.fillStyle = '#ef5b6b';
      rr(ctx, z.px + z.pw - 74, z.py + 9, 64, 20, 10); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`● AO VIVO ${occ[z.id]}`, z.px + z.pw - 68, z.py + 19.5);
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

    // Efeitos de clique
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i];
      if (f.kind !== 'click' && f.kind !== 'poof') continue;
      const p = (t - f.t0) / (f.kind === 'poof' ? 500 : 450);
      if (p >= 1) { effects.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - p;
      if (f.kind === 'click') {
        ctx.strokeStyle = '#5b8cff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(f.x, f.y, 6 + p * 14, 3 + p * 7, 0, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = '#fff';
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          ctx.beginPath(); ctx.arc(f.x + Math.cos(a) * p * 26, f.y - 16 + Math.sin(a) * p * 20, 5 * (1 - p) + 1, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Avatares ordenados por profundidade
    const list = [...users.values()].sort((a, b) => a.ry - b.ry);
    for (const u of list) drawAvatar(u, t);
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

  function drawAvatar(u, t) {
    const x = u.rx;
    const y = u.ry;
    const moving = u.id === meId ? u.moving : Math.hypot(u.x - u.rx, u.y - u.ry) > 0.8 || u.moving;
    const walk = moving ? Math.sin(t / 70 + u.phase) : 0;
    const bob = moving ? Math.abs(walk) * -2.5 : Math.sin(t / 600 + u.phase) * 0.8;
    const isMe = u.id === meId;
    const off = u.zone === 'off';
    ctx.globalAlpha = off ? 0.55 : 1;

    // sombra
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(x, y, 11, 4.5, 0, 0, Math.PI * 2); ctx.fill();
    if (isMe) {
      ctx.strokeStyle = 'rgba(91,140,255,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y, 15 + Math.sin(t / 300) * 1.5, 6, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // pernas
    ctx.fillStyle = '#2d3142';
    rr(ctx, x - 6, y - 9 + walk * 2, 5, 9 - walk * 2, 2); ctx.fill();
    rr(ctx, x + 1, y - 9 - walk * 2, 5, 9 + walk * 2, 2); ctx.fill();
    // corpo
    const by = y - 23 + bob;
    ctx.fillStyle = u.color;
    rr(ctx, x - 9, by, 18, 16, 6); ctx.fill();
    // braços
    ctx.fillStyle = shade(u.color, -25);
    rr(ctx, x - 12, by + 2 - walk * 2, 4, 11, 2); ctx.fill();
    rr(ctx, x + 8, by + 2 + walk * 2, 4, 11, 2); ctx.fill();
    // cabeça
    const hy = by - 9;
    ctx.fillStyle = u.skin;
    ctx.beginPath(); ctx.arc(x, hy, 10, 0, Math.PI * 2); ctx.fill();
    // cabelo
    ctx.fillStyle = u.hair;
    ctx.beginPath();
    if (u.dir === 'up') ctx.arc(x, hy, 10.5, 0, Math.PI * 2);
    else ctx.arc(x, hy - 1, 10.5, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    // olhos
    if (u.dir !== 'up') {
      const blink = (t / 1000 + u.phase) % 4 < 0.12;
      const ex = u.dir === 'left' ? -3 : u.dir === 'right' ? 3 : 0;
      ctx.fillStyle = '#1d2030';
      for (const s of u.dir === 'down' ? [-3.5, 3.5] : [ex > 0 ? 1.5 : -5.5, ex > 0 ? 5.5 : -1.5]) {
        if (blink) ctx.fillRect(x + s - 1.5, hy + 1, 3, 1);
        else { ctx.beginPath(); ctx.arc(x + s, hy + 1.5, 1.6, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    // status
    ctx.fillStyle = STATUS_COLOR[u.status] || '#999';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x + 9, hy - 8, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // nome
    ctx.font = '600 10px system-ui, sans-serif';
    const tw = ctx.measureText(u.name).width + 10;
    ctx.fillStyle = isMe ? 'rgba(91,140,255,.92)' : 'rgba(29,32,48,.78)';
    rr(ctx, x - tw / 2, y + 5, tw, 15, 7.5); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(u.name, x, y + 12.8);
    if (off) {
      ctx.globalAlpha = 0.5 + Math.sin(t / 500 + u.phase) * 0.4;
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = '#c9d4ff';
      ctx.fillText('z', x + 14, hy - 12 - ((t / 40 + u.phase * 10) % 8));
      ctx.fillText('z', x + 20, hy - 20 - ((t / 40 + u.phase * 10) % 8));
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  function drawBubble(u, t) {
    if (!u.bubble || t > u.bubble.until) return;
    const fade = Math.min(1, (u.bubble.until - t) / 400);
    ctx.globalAlpha = fade;
    ctx.font = '11px system-ui, sans-serif';
    const lines = wrap(u.bubble.text, 150).slice(0, 4);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
    const h = lines.length * 14 + 8;
    const bx = u.rx - w / 2;
    const by = u.ry - 50 - h;
    ctx.fillStyle = '#fff';
    rr(ctx, bx, by, w, h, 8); ctx.fill();
    ctx.beginPath(); ctx.moveTo(u.rx - 5, by + h); ctx.lineTo(u.rx + 5, by + h); ctx.lineTo(u.rx, by + h + 6); ctx.fill();
    ctx.fillStyle = '#1d2030';
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
