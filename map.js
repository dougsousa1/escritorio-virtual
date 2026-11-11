// Mapa do escritório — compartilhado entre servidor (require) e navegador (window.MAP).
(function (root) {
  const TILE = 32;
  const COLS = 40;
  const ROWS = 30;

  const zones = [
    { id: 'dev', name: 'Desenvolvimento', icon: '💻', type: 'sector', x: 1, y: 1, w: 18, h: 8, floor: '#dde8f7', wall: '#5b7db1' },
    { id: 'estudo', name: 'Estudo', icon: '📚', type: 'study', x: 21, y: 1, w: 18, h: 8, floor: '#e4f3e2', wall: '#4f9a55' },
    { id: 'r1', name: 'Reunião 1', icon: '🗣️', type: 'meeting', x: 1, y: 12, w: 8, h: 6, floor: '#efe9fb', wall: '#7c5cc4' },
    { id: 'r2', name: 'Reunião 2', icon: '🗣️', type: 'meeting', x: 11, y: 12, w: 8, h: 6, floor: '#efe9fb', wall: '#7c5cc4' },
    { id: 'r3', name: 'Reunião 3', icon: '🗣️', type: 'meeting', x: 21, y: 12, w: 8, h: 6, floor: '#efe9fb', wall: '#7c5cc4' },
    { id: 'r4', name: 'Reunião 4', icon: '🗣️', type: 'meeting', x: 31, y: 12, w: 8, h: 6, floor: '#efe9fb', wall: '#7c5cc4' },
    { id: 'descanso', name: 'Descanso', icon: '☕', type: 'lounge', x: 1, y: 21, w: 18, h: 8, floor: '#f7ecdc', wall: '#a97b45' },
    { id: 'off', name: 'OFF', icon: '🌙', type: 'off', x: 21, y: 21, w: 18, h: 8, floor: '#3a3f55', wall: '#23263a' },
  ];

  const zoneById = {};
  const desks = {}; // zoneId -> [{x,y,w,h}] (px)
  const seats = {}; // zoneId -> [{x,y,dir}] (px, posição dos pés)
  const tables = {}; // zoneId -> {x,y,w,h}

  for (const z of zones) {
    zoneById[z.id] = z;
    z.px = z.x * TILE;
    z.py = z.y * TILE;
    z.pw = z.w * TILE;
    z.ph = z.h * TILE;
    desks[z.id] = [];
    seats[z.id] = [];

    if (z.type === 'sector' || z.type === 'study') {
      const cols = Math.floor((z.pw - 48) / 84);
      const slot = (z.pw - 48) / cols;
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < cols; i++) {
          const cx = z.px + 24 + slot / 2 + i * slot;
          const cy = z.py + 70 + j * 108;
          desks[z.id].push({ x: cx - 28, y: cy - 14, w: 56, h: 28 });
          seats[z.id].push({ x: cx, y: cy + 36, dir: 'up' });
        }
      }
    } else if (z.type === 'meeting') {
      const cx = z.px + z.pw / 2;
      const cy = z.py + z.ph / 2 + 10;
      tables[z.id] = { x: cx - 70, y: cy - 26, w: 140, h: 52 };
      for (const dx of [-44, 0, 44]) {
        seats[z.id].push({ x: cx + dx, y: cy - 30, dir: 'down' });
        seats[z.id].push({ x: cx + dx, y: cy + 50, dir: 'up' });
      }
      seats[z.id].push({ x: cx - 96, y: cy + 12, dir: 'right' });
      seats[z.id].push({ x: cx + 96, y: cy + 12, dir: 'left' });
    } else {
      // Descanso e OFF: pontos livres espalhados (sofás / pufes)
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 7; i++) {
          seats[z.id].push({ x: z.px + 50 + i * 54, y: z.py + 108 + j * 84, dir: 'down' });
        }
      }
    }
  }

  function zoneAt(x, y) {
    for (const z of zones) {
      if (x >= z.px && x < z.px + z.pw && y >= z.py && y < z.py + z.ph) return z;
    }
    return null;
  }

  const MAP = {
    TILE, COLS, ROWS,
    WIDTH: COLS * TILE,
    HEIGHT: ROWS * TILE,
    zones, zoneById, desks, seats, tables, zoneAt,
    spawnZones: zones.filter((z) => z.type !== 'meeting'),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MAP;
  else root.MAP = MAP;
})(this);
