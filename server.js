// PunkRunner server. CommonJS so it can be bundled into a Node Single Executable (see build.mjs).
const express = require('express');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const { Server } = require('socket.io');

let sea = null;
try {
  sea = require('node:sea');
} catch {
  /* older node */
}
const IS_SEA = !!sea && sea.isSea();

// When packaged, keep saved data next to the .exe; in dev, next to this file.
const BASE_DIR = IS_SEA ? path.dirname(process.execPath) : __dirname;
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(BASE_DIR, 'punkrunner-data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const LIBRARY_DIR = path.join(DATA_DIR, 'scenes');
fs.mkdirSync(IMAGE_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Static UI: served from embedded SEA assets when packaged, from disk otherwise.
function readUiFile(rel) {
  if (IS_SEA) {
    try {
      return Buffer.from(sea.getAsset(rel));
    } catch {
      return null;
    }
  }
  if (rel === 'vendor/socket.io.min.js') {
    return fs.readFileSync(path.join(__dirname, 'node_modules/socket.io/client-dist/socket.io.min.js'));
  }
  const full = path.join(__dirname, 'public', rel);
  if (!full.startsWith(path.join(__dirname, 'public'))) return null;
  try {
    return fs.readFileSync(full);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LAN-only: refuse anything that isn't loopback or a private/link-local address.
// Players must be on the same local network as the host machine.
// ---------------------------------------------------------------------------
function isLocalAddress(addr) {
  if (!addr) return false;
  let ip = String(addr).toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  if (ip === '::1' || ip.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(ip)) return true; // loopback, link-local, ULA
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 || // loopback
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // link-local
  );
}

const app = express();
app.use((req, res, next) => {
  if (isLocalAddress(req.socket.remoteAddress)) return next();
  console.warn(`[blocked] HTTP from non-local address ${req.socket.remoteAddress}`);
  res.status(403).send('PunkRunner only accepts connections from the local network.');
});
app.use('/images', express.static(IMAGE_DIR, { maxAge: '1d' }));
app.get('*', (req, res, next) => {
  let rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  if (rel.includes('..')) return next();
  const buf = readUiFile(rel);
  if (!buf) return next();
  res.type(MIME[path.extname(rel)] || 'application/octet-stream').send(buf);
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 60 * 1024 * 1024,
  serveClient: false,
  allowRequest: (req, cb) => cb(null, isLocalAddress(req.socket.remoteAddress)),
});

// ---------------------------------------------------------------------------
// Sessions (in memory; scenes saved to the library persist on disk)
// ---------------------------------------------------------------------------
/** @type {Map<string, any>} */
const sessions = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (sessions.has(code));
  return code;
}
const newId = () => crypto.randomUUID();

function cleanName(name) {
  const n = String(name ?? '').trim().slice(0, 24);
  return n || 'Anon';
}

function simNow(sim) {
  return sim.paused ? sim.time : sim.time + (Date.now() - sim.startedAt) / 1000;
}
function simPayload(session) {
  return { paused: session.sim.paused, time: simNow(session.sim) };
}

function playerList(session) {
  return [...session.players.values()].map((p) => ({ id: p.id, name: p.name }));
}

function playerView(session) {
  const v = session.view;
  if (v.mode === 'scene' && session.scenes.has(v.sceneId)) {
    return { mode: 'scene', scene: session.scenes.get(v.sceneId) };
  }
  return { mode: 'waiting' };
}

function hostState(session) {
  return {
    code: session.code,
    hostName: session.hostName,
    players: playerList(session),
    scenes: session.sceneOrder.map((id) => session.scenes.get(id)),
    view: session.view,
    sim: simPayload(session),
  };
}

function playerState(session) {
  return {
    code: session.code,
    hostName: session.hostName,
    players: playerList(session),
    view: playerView(session),
    sim: simPayload(session),
  };
}

function broadcastPlayers(session) {
  io.to(session.code).emit('players', playerList(session));
}
function broadcastView(session) {
  io.to(`${session.code}:players`).emit('view', playerView(session));
  io.to(`${session.code}:host`).emit('view:host', session.view);
}
function broadcastSim(session) {
  io.to(session.code).emit('sim', simPayload(session));
}

// Library helpers ------------------------------------------------------------
const libPath = (id) => path.join(LIBRARY_DIR, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`);

function listLibrary() {
  return fs
    .readdirSync(LIBRARY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, f), 'utf8'));
        return {
          libraryId: s.libraryId,
          name: s.name,
          image: s.image,
          enemies: s.enemies?.length ?? 0,
          cameras: s.cameras?.length ?? 0,
          savedAt: s.savedAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

function sanitizeScene(s) {
  // Shallow validation: keep only the fields we know about.
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const str = (v, d = '') => (typeof v === 'string' ? v.slice(0, 64) : d);
  const pts = (arr) => (Array.isArray(arr) ? arr.slice(0, 200).map((p) => ({ x: num(p.x), y: num(p.y) })) : []);
  return {
    id: str(s.id),
    libraryId: s.libraryId ? str(s.libraryId) : null,
    name: str(s.name, 'Scene') || 'Scene',
    image: { url: str(s.image?.url, ''), width: num(s.image?.width, 1), height: num(s.image?.height, 1) },
    grid: {
      x: num(s.grid?.x),
      y: num(s.grid?.y),
      size: Math.max(4, num(s.grid?.size, 50)),
      opacity: Math.min(1, Math.max(0, num(s.grid?.opacity, 0.18))),
    },
    unitScale: Math.min(3, Math.max(0.1, num(s.unitScale, 1))),
    enemies: (Array.isArray(s.enemies) ? s.enemies.slice(0, 500) : []).map((e) => ({
      id: str(e.id),
      label: str(e.label),
      x: num(e.x),
      y: num(e.y),
      facing: num(e.facing),
      fov: num(e.fov, 90),
      range: num(e.range, 4),
      alerted: !!e.alerted,
      speed: Math.max(0, num(e.speed, 1)),
      pathMode: e.pathMode === 'pingpong' ? 'pingpong' : 'loop',
      path: pts(e.path),
    })),
    cameras: (Array.isArray(s.cameras) ? s.cameras.slice(0, 500) : []).map((c) => ({
      id: str(c.id),
      label: str(c.label),
      x: num(c.x),
      y: num(c.y),
      facing: num(c.facing),
      fov: num(c.fov, 60),
      range: num(c.range, 6),
      alerted: !!c.alerted,
      sightOff: !!c.sightOff,
      sweep: Math.max(0, num(c.sweep, 0)),
      sweepSpeed: Math.max(0, num(c.sweepSpeed, 20)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  /** @type {{session:any, role:'host'|'player'} | null} */
  let ctx = null;

  const isHost = () => ctx && ctx.role === 'host';
  const fail = (ack, error) => typeof ack === 'function' && ack({ error });

  function leave() {
    if (!ctx) return;
    const { session, role } = ctx;
    if (role === 'player') {
      session.players.delete(socket.id);
      socket.leave(`${session.code}:players`);
      broadcastPlayers(session);
    } else {
      if (session.hostSocket === socket.id) session.hostSocket = null;
      socket.leave(`${session.code}:host`);
    }
    socket.leave(session.code);
    ctx = null;
  }

  function attachHost(session, ack) {
    session.hostSocket = socket.id;
    ctx = { session, role: 'host' };
    socket.join(session.code);
    socket.join(`${session.code}:host`);
    ack({ ok: true, token: session.hostToken, state: hostState(session) });
  }

  socket.on('host:create', ({ name } = {}, ack) => {
    leave();
    const code = makeCode();
    const session = {
      code,
      hostToken: newId(),
      hostName: cleanName(name),
      hostSocket: null,
      players: new Map(),
      scenes: new Map(),
      sceneOrder: [],
      view: { mode: 'waiting', sceneId: null },
      sim: { paused: true, time: 0, startedAt: Date.now() },
    };
    sessions.set(code, session);
    console.log(`[session] ${code} created by ${session.hostName}`);
    attachHost(session, ack);
  });

  socket.on('host:resume', ({ code, token } = {}, ack) => {
    const session = sessions.get(String(code || '').toUpperCase());
    if (!session || session.hostToken !== token) return fail(ack, 'Session not found');
    leave();
    attachHost(session, ack);
  });

  socket.on('player:join', ({ code, name } = {}, ack) => {
    const session = sessions.get(String(code || '').trim().toUpperCase());
    if (!session) return fail(ack, 'No session with that code');
    leave();
    session.players.set(socket.id, { id: socket.id, name: cleanName(name) });
    ctx = { session, role: 'player' };
    socket.join(session.code);
    socket.join(`${session.code}:players`);
    broadcastPlayers(session);
    ack({ ok: true, state: playerState(session) });
  });

  socket.on('session:leave', () => leave());

  socket.on('name:update', ({ name } = {}) => {
    if (!ctx) return;
    if (ctx.role === 'host') ctx.session.hostName = cleanName(name);
    else {
      const p = ctx.session.players.get(socket.id);
      if (p) p.name = cleanName(name);
    }
    broadcastPlayers(ctx.session);
  });

  // ---- Scenes ---------------------------------------------------------------
  socket.on('scene:upload', ({ name, mime, data, width, height } = {}, ack) => {
    if (!isHost()) return fail(ack, 'Not host');
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
    if (!ext || !data) return fail(ack, 'Unsupported image type');
    const file = `${newId()}.${ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, file), Buffer.from(data));
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const scene = sanitizeScene({
      id: newId(),
      name: String(name || 'Scene').replace(/\.[a-z0-9]+$/i, ''),
      image: { url: `/images/${file}`, width: w, height: h },
      grid: { x: 0, y: 0, size: Math.round(Math.max(w, h) / 24), opacity: 0.18 },
      enemies: [],
      cameras: [],
    });
    const { session } = ctx;
    session.scenes.set(scene.id, scene);
    session.sceneOrder.push(scene.id);
    ack({ ok: true, scene });
  });

  socket.on('scene:update', ({ scene } = {}) => {
    if (!isHost() || !scene) return;
    const { session } = ctx;
    if (!session.scenes.has(scene.id)) return;
    const clean = sanitizeScene(scene);
    session.scenes.set(clean.id, clean);
    if (session.view.mode === 'scene' && session.view.sceneId === clean.id) {
      io.to(`${session.code}:players`).emit('scene:live', clean);
    }
  });

  socket.on('scene:delete', ({ id } = {}) => {
    if (!isHost()) return;
    const { session } = ctx;
    session.scenes.delete(id);
    session.sceneOrder = session.sceneOrder.filter((s) => s !== id);
    if (session.view.sceneId === id) {
      session.view = { mode: 'waiting', sceneId: null };
      broadcastView(session);
    }
  });

  socket.on('view:set', ({ mode, sceneId } = {}) => {
    if (!isHost()) return;
    const { session } = ctx;
    session.view =
      mode === 'scene' && session.scenes.has(sceneId) ? { mode: 'scene', sceneId } : { mode: 'waiting', sceneId: null };
    broadcastView(session);
  });

  // ---- Simulation -------------------------------------------------------------
  socket.on('sim:pause', ({ paused } = {}) => {
    if (!ctx) return;
    const { sim } = ctx.session;
    const want = !!paused;
    if (want === sim.paused) return;
    sim.time = simNow(sim);
    sim.startedAt = Date.now();
    sim.paused = want;
    broadcastSim(ctx.session);
  });

  socket.on('sim:reset', () => {
    if (!isHost()) return;
    const { sim } = ctx.session;
    sim.time = 0;
    sim.startedAt = Date.now();
    broadcastSim(ctx.session);
  });

  // ---- Library ---------------------------------------------------------------
  socket.on('library:list', (_ = {}, ack) => {
    if (!isHost()) return fail(ack, 'Not host');
    ack({ ok: true, items: listLibrary() });
  });

  socket.on('library:save', ({ sceneId } = {}, ack) => {
    if (!isHost()) return fail(ack, 'Not host');
    const { session } = ctx;
    const scene = session.scenes.get(sceneId);
    if (!scene) return fail(ack, 'Scene not found');
    if (!scene.libraryId) scene.libraryId = newId();
    const record = { ...scene, savedAt: Date.now() };
    fs.writeFileSync(libPath(scene.libraryId), JSON.stringify(record, null, 2));
    console.log(`[library] saved "${scene.name}"`);
    ack({ ok: true, libraryId: scene.libraryId });
  });

  socket.on('library:load', ({ libraryId } = {}, ack) => {
    if (!isHost()) return fail(ack, 'Not host');
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(libPath(String(libraryId)), 'utf8'));
    } catch {
      return fail(ack, 'Saved scene not found');
    }
    const scene = sanitizeScene({ ...stored, id: newId() });
    const { session } = ctx;
    session.scenes.set(scene.id, scene);
    session.sceneOrder.push(scene.id);
    ack({ ok: true, scene });
  });

  socket.on('library:delete', ({ libraryId } = {}, ack) => {
    if (!isHost()) return fail(ack, 'Not host');
    try {
      fs.unlinkSync(libPath(String(libraryId)));
    } catch {
      /* already gone */
    }
    ack({ ok: true, items: listLibrary() });
  });

  socket.on('disconnect', () => leave());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  PUNKRUNNER online\n`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isLocalAddress(a.address)) console.log(`  Network: http://${a.address}:${PORT}`);
    }
  }
  console.log('');
  if (IS_SEA && !process.env.PUNKRUNNER_NO_BROWSER) {
    exec(`start "" "http://localhost:${PORT}"`);
    console.log('  Keep this window open while playing. Close it to shut down.\n');
  }
  console.log('  LAN-only: connections from outside your local network are refused.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Is PunkRunner already running?\n`);
  } else console.error(err);
  if (IS_SEA) setTimeout(() => process.exit(1), 8000);
});
