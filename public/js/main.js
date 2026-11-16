import { MapView, isTyping } from './map.js';
import { ALERT_RANGE_MULT } from './sim.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------------------
// Local storage (wrapped: may be unavailable)
// ---------------------------------------------------------------------------
const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  name: store.get('pr.name') || `runner-${Math.floor(1000 + Math.random() * 9000)}`,
  role: null, // 'host' | 'player'
  code: null,
  hostName: '',
  players: [],
  scenes: [], // host only
  currentId: null, // host: scene being edited
  view: { mode: 'waiting', sceneId: null }, // group view (host)
  assignments: {}, // host: playerKey → own view
  playerScene: null, // player: scene currently shown
};
// Per-tab player id so the host's view assignments survive reconnects/refreshes.
const playerKey = (() => {
  try {
    let k = sessionStorage.getItem('pr.pkey');
    if (!k) sessionStorage.setItem('pr.pkey', (k = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`));
    return k;
  } catch {
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

const clock = { paused: true, time: 0, at: performance.now() };
const simTime = () => (clock.paused ? clock.time : clock.time + (performance.now() - clock.at) / 1000);

const socket = io({ transports: ['websocket', 'polling'] });
const emit = (event, payload = {}) =>
  new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res || { error: 'No response' })));

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new MapView($('#map'), {
  getTime: simTime,
  onChange: (kind) => {
    const s = currentScene();
    if (!s) return;
    queueSync(s);
    refreshInspectorValues();
  },
  onSelect: () => renderInspector(),
  onCursor: (label) => ($('#cursorCell').textContent = label || '--'),
});

function currentScene() {
  return state.scenes.find((s) => s.id === state.currentId) || null;
}

// Debounced scene sync (host → server → players)
const pendingSync = new Map();
let syncTimer = null;
function queueSync(scene) {
  pendingSync.set(scene.id, scene);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushSync, 90);
}
function flushSync() {
  clearTimeout(syncTimer);
  for (const scene of pendingSync.values()) socket.emit('scene:update', { scene });
  pendingSync.clear();
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function showMenuTab(tab) {
  $$('.menu-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.menu-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
  $('#menuError').textContent = '';
  const focus = { name: '#nameInput', join: '#joinCode' }[tab];
  if (focus) setTimeout(() => $(focus).focus(), 0);
}
$$('.menu-tab').forEach((b) => b.addEventListener('click', () => showMenuTab(b.dataset.tab)));

const nameInput = $('#nameInput');
nameInput.value = state.name;
$('#currentHandle').textContent = state.name;
nameInput.addEventListener('input', () => {
  const v = nameInput.value.trim().slice(0, 24);
  if (!v) return;
  state.name = v;
  store.set('pr.name', v);
  $('#currentHandle').textContent = v;
});

const joinCode = $('#joinCode');
joinCode.value = store.get('pr.lastCode') || '';
joinCode.addEventListener('input', () => (joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
joinCode.addEventListener('keydown', (e) => e.key === 'Enter' && joinSession());
$('#joinBtn').addEventListener('click', joinSession);
$('#createBtn').addEventListener('click', createSession);
$('#resumeBtn').addEventListener('click', resumeHost);

function menuError(msg) {
  $('#menuError').textContent = msg ? `// ${msg}` : '';
}

function refreshResume() {
  const saved = store.get('pr.host');
  const btn = $('#resumeBtn');
  btn.classList.toggle('hidden', !saved);
  if (saved) btn.textContent = `Resume session ${saved.code}`;
}
refreshResume();

async function createSession() {
  const res = await emit('host:create', { name: state.name });
  if (res.error) return menuError(res.error);
  store.set('pr.host', { code: res.state.code, token: res.token });
  enterHost(res.state);
}

async function resumeHost() {
  const saved = store.get('pr.host');
  if (!saved) return;
  const res = await emit('host:resume', saved);
  if (res.error) {
    store.del('pr.host');
    refreshResume();
    return menuError('That session has ended (server restarted?)');
  }
  enterHost(res.state);
}

async function joinSession() {
  const code = joinCode.value.trim().toUpperCase();
  if (code.length < 5) return menuError('Enter the 5-character code');
  const res = await emit('player:join', { code, name: state.name, key: playerKey });
  if (res.error) return menuError(res.error);
  store.set('pr.lastCode', code);
  enterPlayer(res.state);
}

// ---------------------------------------------------------------------------
// Entering the app
// ---------------------------------------------------------------------------
function showApp() {
  $('#menu').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#sessionCode').textContent = state.code;
  $('#whoAmI').innerHTML = `<b>${esc(state.name)}</b> · ${state.role === 'host' ? 'HOST' : 'RUNNER'}`;
  map._resize();
}

function applyClock(sim) {
  clock.paused = sim.paused;
  clock.time = sim.time;
  clock.at = performance.now();
  const btn = $('#pauseBtn');
  btn.textContent = clock.paused ? '▶ Run' : '❚❚ Pause';
  btn.classList.toggle('primary', clock.paused);
  btn.classList.toggle('warn', !clock.paused);
  $('#simClock').classList.toggle('running', !clock.paused);
}

function enterHost(s) {
  state.role = 'host';
  state.code = s.code;
  state.hostName = s.hostName;
  state.players = s.players;
  state.scenes = s.scenes;
  state.view = s.view;
  state.assignments = s.assignments || {};
  if (!state.scenes.find((x) => x.id === state.currentId)) state.currentId = state.scenes[0]?.id ?? null;
  document.body.classList.remove('player');
  map.editable = true;
  showApp();
  applyClock(s.sim);
  selectScene(state.currentId);
  renderPlayers();
  renderCrew();
  setTool('select');
}

function enterPlayer(s) {
  state.role = 'player';
  state.code = s.code;
  state.hostName = s.hostName;
  state.players = s.players;
  document.body.classList.add('player');
  map.editable = false;
  showApp();
  setTool('pan');
  applyClock(s.sim);
  applyPlayerView(s.view);
  renderPlayers();
}

function leaveSession() {
  if (state.role === 'host' && !confirm('Exit to menu? The session stays alive while the server runs — you can resume it from the Create tab.')) return;
  flushSync();
  socket.emit('session:leave');
  state.role = null;
  state.code = null;
  state.scenes = [];
  state.currentId = null;
  map.setScene(null);
  $('#app').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  refreshResume();
}
$('#leaveBtn').addEventListener('click', leaveSession);

$('#codeChip').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.code);
    toast(`Code ${state.code} copied`);
  } catch {
    toast(`Session code: ${state.code}`);
  }
});

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------
let wasDisconnected = false;
socket.on('disconnect', () => {
  if (state.role) {
    wasDisconnected = true;
    toast('Connection lost — reconnecting…', 4000);
  }
});
socket.on('connect', async () => {
  if (!wasDisconnected || !state.role) return;
  wasDisconnected = false;
  if (state.role === 'host') {
    const saved = store.get('pr.host');
    const res = saved ? await emit('host:resume', saved) : { error: 'x' };
    if (res.error) {
      toast('Session ended (server restarted).', 5000);
      store.del('pr.host');
      return leaveSessionSilently();
    }
    enterHost(res.state);
    toast('Reconnected');
  } else {
    const res = await emit('player:join', { code: state.code, name: state.name, key: playerKey });
    if (res.error) {
      toast('Session ended.', 5000);
      return leaveSessionSilently();
    }
    enterPlayer(res.state);
    toast('Reconnected');
  }
});
function leaveSessionSilently() {
  state.role = null;
  map.setScene(null);
  $('#app').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  refreshResume();
}

socket.on('players', (players) => {
  state.players = players;
  renderPlayers();
  renderCrew();
  renderSceneTabs();
});
socket.on('sim', applyClock);
socket.on('view', (view) => state.role === 'player' && applyPlayerView(view));
socket.on('view:host', ({ view, assignments }) => {
  state.view = view;
  state.assignments = assignments || {};
  renderSceneTabs();
  renderViewSelect();
  renderCrew();
  renderInspector();
});
socket.on('scene:live', (scene) => {
  if (state.role !== 'player' || state.playerScene?.id !== scene.id) return;
  state.playerScene = scene;
  map.setScene(scene);
});

// ---------------------------------------------------------------------------
// Players / waiting room
// ---------------------------------------------------------------------------
function renderPlayers() {
  $('#playerCount').textContent = state.players.length;
  const items = [`<li class="host">${esc(state.hostName)}</li>`];
  for (const p of state.players) items.push(`<li>${esc(p.name)}</li>`);
  if (!state.players.length) items.push('<li class="empty">No runners yet</li>');
  $('#playerList').innerHTML = items.join('');
  $('#waitingList').innerHTML = state.players
    .map((p) => `<li class="${p.id === socket.id ? 'me' : ''}">${esc(p.name)}</li>`)
    .join('');
}

function applyPlayerView(view) {
  const showing = view.mode === 'scene' && view.scene;
  $('#waiting').classList.toggle('hidden', !!showing || view.mode === 'hidden');
  $('#feedcut').classList.toggle('hidden', view.mode !== 'hidden');
  state.playerScene = showing ? view.scene : null;
  map.setScene(state.playerScene);
}

// ---------------------------------------------------------------------------
// Views: group view (top bar) + per-player overrides (Crew panel)
// ---------------------------------------------------------------------------
const viewToValue = (v) => (v?.mode === 'scene' ? `scene:${v.sceneId}` : v?.mode || 'waiting');
const valueToView = (val) => (val.startsWith('scene:') ? { mode: 'scene', sceneId: val.slice(6) } : { mode: val });
const effectiveView = (p) => state.assignments[p.key] || state.view;
const sceneName = (id) => state.scenes.find((s) => s.id === id)?.name || '?';
function describeView(v) {
  if (v.mode === 'scene') return `▶ ${sceneName(v.sceneId)}`;
  return v.mode === 'hidden' ? '✕ Feed cut' : '⏸ Waiting room';
}
function viewOptions() {
  return (
    '<option value="waiting">⏸ Waiting room</option><option value="hidden">✕ Feed cut (hidden)</option>' +
    state.scenes.map((s) => `<option value="scene:${s.id}">▶ ${esc(s.name)}</option>`).join('')
  );
}

/** target omitted → group view; target = player key → that player only ('follow' clears the override). */
function setPlayerView(value, target) {
  flushSync();
  socket.emit('view:set', { ...(value === 'follow' ? { mode: 'follow' } : valueToView(value)), target });
}

function renderCrew() {
  const el = $('#crewPanel');
  if (state.role !== 'host' || !el) return;
  if (!state.players.length) {
    el.innerHTML = `<div class="section"><h3>Crew <span class="tag">0 CONNECTED</span></h3>
      <p class="muted">Players who join with code <b>${esc(state.code)}</b> show up here.</p></div>`;
    return;
  }
  const rows = state.players
    .map((p) => {
      const own = state.assignments[p.key];
      return `<div class="crew-row ${own ? 'override' : ''}">
        <div class="crew-name"><span>${esc(p.name)}</span><small>${own ? 'own view' : 'follows group'}</small></div>
        <select class="input" data-crew="${esc(p.key)}">
          <option value="follow">↳ Group: ${esc(describeView(state.view))}</option>
          ${viewOptions()}
        </select></div>`;
    })
    .join('');
  el.innerHTML = `<div class="section"><h3>Crew <span class="tag">${state.players.length} CONNECTED</span></h3>
    ${rows}
    <div class="btn-row"><button class="btn small" data-act="crewreset" ${Object.keys(state.assignments).length ? '' : 'disabled'}>Everyone follow group</button></div>
    <p class="muted">Give a player their own view to split the crew across scenes, or cut their feed.</p></div>`;
  for (const sel of $$('[data-crew]', el)) {
    const own = state.assignments[sel.dataset.crew];
    sel.value = own ? viewToValue(own) : 'follow';
  }
}

// ---------------------------------------------------------------------------
// Sim controls
// ---------------------------------------------------------------------------
$('#pauseBtn').addEventListener('click', () => socket.emit('sim:pause', { paused: !clock.paused }));
$('#resetBtn').addEventListener('click', () => socket.emit('sim:reset'));
setInterval(() => {
  const t = simTime();
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  $('#simClock').textContent = `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}, 100);

// ---------------------------------------------------------------------------
// Host: scenes
// ---------------------------------------------------------------------------
function selectScene(id) {
  flushSync();
  state.currentId = id;
  map.setScene(currentScene());
  renderSceneTabs();
  renderViewSelect();
  renderInspector();
  const empty = !currentScene();
  $('#emptyHint').classList.toggle('hidden', !empty || state.role !== 'host');
  $('#emptyHint').innerHTML =
    '<div><b>NO SCENE LOADED</b><br>Import a map image with <span class="kbd">+ Import image</span>, drop one here,<br>or load a saved scene from the <span class="kbd">Library</span>.</div>';
}

function renderSceneTabs() {
  const list = $('#sceneTabList');
  if (!state.scenes.length) {
    list.innerHTML = '<div class="scene-tabs-empty">No scenes yet</div>';
    return;
  }
  list.innerHTML = state.scenes
    .map((s) => {
      const watching = state.players.filter((p) => {
        const v = effectiveView(p);
        return v.mode === 'scene' && v.sceneId === s.id;
      });
      const groupLive = state.view.mode === 'scene' && state.view.sceneId === s.id;
      const live = watching.length || groupLive;
      const tip = watching.length ? ` — viewing: ${watching.map((p) => p.name).join(', ')}` : '';
      return `<div class="scene-tab ${s.id === state.currentId ? 'active' : ''}" data-id="${s.id}" title="${esc(s.name + tip)}">
        ${live ? `<span class="live">LIVE ${watching.length}</span>` : ''}<span class="name">${esc(s.name)}</span>
        <span class="x" data-del="${s.id}" title="Remove from session">✕</span></div>`;
    })
    .join('');
}
$('#sceneTabList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) return deleteScene(del.dataset.del);
  const tab = e.target.closest('.scene-tab');
  if (tab) selectScene(tab.dataset.id);
});

function deleteScene(id) {
  const s = state.scenes.find((x) => x.id === id);
  if (!s) return;
  const note = s.libraryId ? ' (the saved library copy is kept)' : ' Unsaved changes will be lost.';
  if (!confirm(`Remove "${s.name}" from this session?${note}`)) return;
  socket.emit('scene:delete', { id });
  state.scenes = state.scenes.filter((x) => x.id !== id);
  pendingSync.delete(id);
  if (state.currentId === id) selectScene(state.scenes[0]?.id ?? null);
  else renderSceneTabs();
  renderViewSelect();
}

function renderViewSelect() {
  const sel = $('#viewSelect');
  sel.innerHTML = viewOptions();
  sel.value = viewToValue(state.view);
}
$('#viewSelect').addEventListener('change', (e) => setPlayerView(e.target.value));

// Import images
const fileInput = $('#fileInput');
$('#importBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  importFiles([...fileInput.files]);
  fileInput.value = '';
});
const stage = $('#stage');
stage.addEventListener('dragover', (e) => {
  if (state.role !== 'host') return;
  e.preventDefault();
  stage.classList.add('dragover');
});
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  stage.classList.remove('dragover');
  if (state.role !== 'host') return;
  e.preventDefault();
  importFiles([...e.dataTransfer.files]);
});

async function importFiles(files) {
  const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  for (const f of files) {
    if (!ok.includes(f.type)) {
      toast(`${f.name}: unsupported type (use PNG, JPG, WEBP or GIF)`);
      continue;
    }
    toast(`Uploading ${f.name}…`);
    let width, height;
    try {
      const bmp = await createImageBitmap(f);
      width = bmp.width;
      height = bmp.height;
      bmp.close?.();
    } catch {
      toast(`${f.name}: could not read image`);
      continue;
    }
    const res = await emit('scene:upload', { name: f.name, mime: f.type, data: await f.arrayBuffer(), width, height });
    if (res.error) {
      toast(res.error);
      continue;
    }
    state.scenes.push(res.scene);
    selectScene(res.scene.id);
    toast(`Scene "${res.scene.name}" imported`);
  }
}

// ---------------------------------------------------------------------------
// Host: library
// ---------------------------------------------------------------------------
const libraryModal = $('#libraryModal');
$('#libraryBtn').addEventListener('click', openLibrary);
libraryModal.addEventListener('click', (e) => {
  if (e.target === libraryModal || e.target.closest('[data-close]')) libraryModal.classList.add('hidden');
});

async function openLibrary() {
  libraryModal.classList.remove('hidden');
  $('#libraryList').innerHTML = '<div class="library-empty">Loading…</div>';
  const res = await emit('library:list');
  renderLibrary(res.items || []);
}

function renderLibrary(items) {
  const el = $('#libraryList');
  if (!items.length) {
    el.innerHTML = '<div class="library-empty">No saved scenes yet. Build a scene and hit “Save to library”.</div>';
    return;
  }
  el.innerHTML = items
    .map(
      (it) => `<div class="lib-card">
        <img src="${esc(it.image?.url)}" alt="" loading="lazy" />
        <div class="meta"><b>${esc(it.name)}</b>
          <span>${it.enemies} enemies · ${it.cameras} cameras<br>${it.savedAt ? new Date(it.savedAt).toLocaleString() : ''}</span></div>
        <div class="btn-row">
          <button class="btn small primary" data-load="${esc(it.libraryId)}">Load</button>
          <button class="btn small danger" data-libdel="${esc(it.libraryId)}" data-name="${esc(it.name)}">Delete</button>
        </div></div>`,
    )
    .join('');
}
$('#libraryList').addEventListener('click', async (e) => {
  const load = e.target.closest('[data-load]');
  const del = e.target.closest('[data-libdel]');
  if (load) {
    const res = await emit('library:load', { libraryId: load.dataset.load });
    if (res.error) return toast(res.error);
    state.scenes.push(res.scene);
    selectScene(res.scene.id);
    libraryModal.classList.add('hidden');
    toast(`Loaded "${res.scene.name}"`);
  } else if (del) {
    if (!confirm(`Permanently delete "${del.dataset.name}" from the library?`)) return;
    const res = await emit('library:delete', { libraryId: del.dataset.libdel });
    renderLibrary(res.items || []);
  }
});

async function saveToLibrary() {
  const s = currentScene();
  if (!s) return;
  flushSync();
  const res = await emit('library:save', { sceneId: s.id });
  if (res.error) return toast(res.error);
  s.libraryId = res.libraryId;
  toast(`"${s.name}" saved to library`);
}

// ---------------------------------------------------------------------------
// Host: tools
// ---------------------------------------------------------------------------
const TOOL_HINTS = {
  select: 'Click to select · drag to move · drag the red handle to rotate · right-drag to pan · wheel to zoom',
  enemy: 'Click to place an enemy',
  camera: 'Click to place a camera',
  box: 'Drag to draw a box · pick a color in the panel · in Select, drag corners to resize',
  path: 'Select an enemy, then click to add waypoints · Backspace removes last · Esc to finish',
  grid: 'Drag to move the grid · adjust cell size in the panel',
  pan: 'Drag to pan · wheel to zoom',
};
function setTool(tool) {
  map.setTool(tool);
  // The box panel's swatches recolor the selected box, so start new boxes with nothing selected.
  if (tool === 'box' && map.selected) map.select(null);
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#toolHint').textContent = state.role === 'host' ? TOOL_HINTS[tool] || '' : 'Drag to pan · wheel to zoom';
  renderInspector();
}
$$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#fitBtn').addEventListener('click', () => map.fit());

window.addEventListener('keydown', (e) => {
  if (isTyping(e) || !state.role || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'f' || e.key === 'F') return map.fit();
  if (state.role !== 'host' || !libraryModal.classList.contains('hidden')) return;
  const keyTools = { v: 'select', e: 'enemy', c: 'camera', b: 'box', p: 'path', g: 'grid', h: 'pan' };
  const k = e.key.toLowerCase();
  if (keyTools[k]) return setTool(keyTools[k]);
  const sel = map.getSelected();
  if (e.key === 'Escape') {
    if (map.tool !== 'select') setTool('select');
    else map.select(null);
  } else if (e.key === 'Backspace' && map.tool === 'path' && sel?.path?.length) {
    e.preventDefault();
    sel.path.pop();
    map.onChange();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
    e.preventDefault();
    map.deleteSelected();
  } else if (k === 'a' && sel && map.selected.kind !== 'box') {
    sel.alerted = !sel.alerted;
    map.onChange();
    renderInspector();
  }
});

// ---------------------------------------------------------------------------
// Host: inspector
// ---------------------------------------------------------------------------
const inspector = $('#inspector');
const inspectorBody = $('#inspectorBody');

const BOX_COLORS = [
  '#ff1f45', '#ff8a00', '#ffd400', '#39ff14', '#2af5ff', '#2d6bff',
  '#b14dff', '#ff4fd8', '#ffffff', '#808080', '#000000', '#8b5a2b',
];
function swatches(current) {
  return `<div class="swatches">${BOX_COLORS.map(
    (c) => `<button class="swatch ${c === current?.toLowerCase() ? 'active' : ''}" style="background:${c}" data-act="color" data-color="${c}" title="${c}"></button>`,
  ).join('')}</div>`;
}

function slider(obj, field, label, min, max, step, unit = '') {
  return `<div class="row"><label>${label}</label><div class="pair">
    <input type="range" data-obj="${obj}" data-field="${field}" min="${min}" max="${max}" step="${step}" />
    <input type="number" class="input" data-obj="${obj}" data-field="${field}" min="${min}" step="${step}" title="${unit}" />
  </div></div>`;
}

function renderInspector() {
  if (state.role !== 'host') return;
  const s = currentScene();
  if (!s) {
    inspectorBody.innerHTML = `<div class="section"><h3>No scene</h3><p class="muted">Import an image to start building a scene.</p></div>${helpSection()}`;
    return;
  }
  const live = state.view.mode === 'scene' && state.view.sceneId === s.id; // group view
  const sel = map.getSelected();
  const kind = map.selected?.kind;

  let html = `
  <div class="section">
    <h3>Scene ${s.libraryId ? '<span class="tag">IN LIBRARY</span>' : '<span class="tag">UNSAVED</span>'}</h3>
    <div class="row"><label>Name</label><input class="input" data-obj="scene" data-field="name" maxlength="64" /></div>
    <div class="btn-row">
      ${live ? '<button class="btn small" data-act="waiting">Send group to waiting room</button>' : '<button class="btn small primary" data-act="show">Show to group</button>'}
    </div>
    <div class="btn-row">
      <button class="btn small" data-act="save">${s.libraryId ? 'Update library' : 'Save to library'}</button>
      <button class="btn small" data-act="saveas" title="Save as a new library entry">Save as new</button>
    </div>
  </div>

  <div class="section">
    <h3>Grid</h3>
    ${slider('grid', 'size', 'Cell size', 8, Math.round(Math.max(s.image.width, s.image.height) / 3), 0.5, 'px')}
    ${slider('grid', 'opacity', 'Opacity', 0, 1, 0.01)}
    ${slider('scene', 'unitScale', 'Unit size', 0.1, 3, 0.05, 'size of enemies & cameras (1 = default)')}
    <div class="row"><label>Offset</label><div class="pair" style="grid-template-columns:1fr 1fr">
      <input type="number" class="input" data-obj="grid" data-field="x" step="1" title="X offset (px)" />
      <input type="number" class="input" data-obj="grid" data-field="y" step="1" title="Y offset (px)" />
    </div></div>
    <div class="row"><label>Snap</label><label class="muted"><input type="checkbox" data-opt="snap" ${map.snap ? 'checked' : ''}/> snap units to cell centers</label></div>
    <div class="row"><label>Paths</label><label class="muted"><input type="checkbox" data-opt="paths" ${map.showPaths ? 'checked' : ''}/> show patrol paths (host only)</label></div>
    <p class="muted">Use the <span class="kbd">G</span> Grid tool to drag the grid into place.</p>
  </div>`;

  if (sel && kind === 'enemy') {
    html += `
    <div class="section">
      <h3>Enemy <span class="alert-state ${sel.alerted ? 'on' : 'off'}">${sel.alerted ? 'ALERTED' : 'CALM'}</span></h3>
      <div class="row"><label>Label</label><input class="input" data-obj="unit" data-field="label" maxlength="20" placeholder="optional" /></div>
      <div class="btn-row"><button class="btn small ${sel.alerted ? '' : 'warn'}" data-act="alert">${sel.alerted ? 'Stand down' : 'Alert! (A)'}</button></div>
      ${slider('unit', 'range', 'Sight', 0, 30, 0.5, 'cells')}
      ${slider('unit', 'fov', 'Cone °', 5, 360, 1, 'degrees')}
      ${sel.path?.length && sel.speed > 0 ? '' : slider('unit', 'facing', 'Facing °', -180, 180, 1, 'degrees')}
      <p class="muted">Sight in grid cells${sel.alerted ? ` · alerted ×${ALERT_RANGE_MULT} = ${(sel.range * ALERT_RANGE_MULT).toFixed(1)}` : ''}.</p>
    </div>
    <div class="section">
      <h3>Patrol <span class="tag">${sel.path?.length || 0} WAYPOINTS</span></h3>
      ${slider('unit', 'speed', 'Speed', 0, 10, 0.1, 'cells / second')}
      <div class="row"><label>Mode</label><select class="input" data-obj="unit" data-field="pathMode">
        <option value="loop">Loop (back to start)</option><option value="pingpong">Ping-pong (reverse)</option></select></div>
      <div class="btn-row">
        <button class="btn small ${map.tool === 'path' ? 'primary' : ''}" data-act="drawpath">${map.tool === 'path' ? 'Drawing… (Esc)' : 'Draw path'}</button>
        <button class="btn small" data-act="undopt" ${sel.path?.length ? '' : 'disabled'}>Undo point</button>
        <button class="btn small" data-act="clearpath" ${sel.path?.length ? '' : 'disabled'}>Clear</button>
      </div>
      <p class="muted">Speed in cells/sec. The enemy faces the way it walks.</p>
    </div>
    <div class="section"><div class="btn-row"><button class="btn small danger" data-act="delete">Delete enemy</button></div></div>`;
  } else if (sel && kind === 'camera') {
    html += `
    <div class="section">
      <h3>Camera <span class="alert-state ${sel.alerted ? 'on' : 'off'}">${sel.alerted ? 'ALERTED' : 'CALM'}</span></h3>
      <div class="row"><label>Label</label><input class="input" data-obj="unit" data-field="label" maxlength="20" placeholder="optional" /></div>
      <div class="btn-row"><button class="btn small ${sel.alerted ? '' : 'warn'}" data-act="alert">${sel.alerted ? 'Stand down' : 'Alert! (A)'}</button></div>
      <div class="row"><label>Sight on</label><label class="muted"><input type="checkbox" data-obj="unit" data-field="sightOff" data-invert="1" /> show line of sight</label></div>
      ${slider('unit', 'range', 'Sight', 0, 40, 0.5, 'cells')}
      ${slider('unit', 'fov', 'Cone °', 5, 360, 1, 'degrees')}
      ${slider('unit', 'facing', 'Facing °', -180, 180, 1, 'degrees')}
      ${slider('unit', 'sweep', 'Sweep °', 0, 270, 1, 'total arc in degrees (0 = fixed)')}
      ${slider('unit', 'sweepSpeed', 'Sweep spd', 1, 180, 1, 'degrees / second')}
    </div>
    <div class="section"><div class="btn-row"><button class="btn small danger" data-act="delete">Delete camera</button></div></div>`;
  } else if (sel && kind === 'box') {
    html += `
    <div class="section">
      <h3>Box <span class="tag" data-boxsize>${boxSizeText(sel, s)}</span></h3>
      <div class="row"><label>Label</label><input class="input" data-obj="unit" data-field="label" maxlength="20" placeholder="optional" /></div>
      ${swatches(sel.color)}
      <div class="row"><label>Custom</label><input type="color" class="input" data-obj="unit" data-field="color" /></div>
      ${slider('unit', 'opacity', 'Fill', 0, 1, 0.05, 'fill opacity')}
      <p class="muted">Drag to move · drag the corner squares to resize.</p>
    </div>
    <div class="section"><div class="btn-row"><button class="btn small danger" data-act="delete">Delete box</button></div></div>`;
  } else if (map.tool === 'box') {
    html += `
    <div class="section">
      <h3>New box color</h3>
      ${swatches(map.boxColor)}
      <div class="row"><label>Custom</label><input type="color" class="input" data-opt="boxcolor" value="${map.boxColor}" /></div>
      <p class="muted">Drag on the map to draw a box.</p>
    </div>`;
  } else {
    html += `
    <div class="section">
      <h3>Units</h3>
      <p class="muted">${s.enemies.length} enemies · ${s.cameras.length} cameras · ${(s.boxes || []).length} boxes<br>${s.enemies.filter((e) => e.alerted).length + s.cameras.filter((c) => c.alerted).length} alerted</p>
      <div class="btn-row">
        <button class="btn small warn" data-act="alertall" ${s.enemies.length + s.cameras.length ? '' : 'disabled'}>Alert all</button>
        <button class="btn small" data-act="calmall" ${s.enemies.length + s.cameras.length ? '' : 'disabled'}>Calm all</button>
      </div>
      <p class="muted">Select a unit to edit it.</p>
    </div>`;
  }

  html += `<div class="section"><div class="btn-row"><button class="btn small danger" data-act="delscene">Remove scene from session</button></div></div>`;
  html += helpSection();
  inspectorBody.innerHTML = html;
  refreshInspectorValues(true);
}

function helpSection() {
  return `<div class="section"><h3>Keys</h3><p class="muted">
    <span class="kbd">V</span> select <span class="kbd">E</span> enemy <span class="kbd">C</span> camera<br>
    <span class="kbd">B</span> box <span class="kbd">P</span> path <span class="kbd">G</span> grid <span class="kbd">H</span> pan <span class="kbd">F</span> fit<br>
    <span class="kbd">A</span> toggle alert · <span class="kbd">Del</span> delete<br>
    Right-drag or <span class="kbd">Space</span>+drag to pan · wheel to zoom · <span class="kbd">Shift</span> while rotating snaps 15°</p></div>`;
}

function targetFor(obj) {
  const s = currentScene();
  if (!s) return null;
  if (obj === 'scene') return s;
  if (obj === 'grid') return s.grid;
  if (obj === 'unit') return map.getSelected();
  return null;
}

function boxSizeText(box, scene) {
  const cells = (v) => (v / scene.grid.size).toFixed(1).replace(/\.0$/, '');
  return `${cells(box.w)} × ${cells(box.h)} CELLS`;
}

function refreshInspectorValues(force = false) {
  if (state.role !== 'host') return;
  const sizeTag = $('[data-boxsize]', inspector);
  const selBox = map.selected?.kind === 'box' ? map.getSelected() : null;
  if (sizeTag && selBox) sizeTag.textContent = boxSizeText(selBox, currentScene());
  for (const el of $$('[data-obj]', inspector)) {
    if (!force && el === document.activeElement) continue;
    const t = targetFor(el.dataset.obj);
    if (!t) continue;
    const v = t[el.dataset.field];
    if (el.type === 'checkbox') {
      el.checked = el.dataset.invert ? !v : !!v;
      continue;
    }
    el.value = typeof v === 'number' ? Math.round(v * 100) / 100 : (v ?? '');
  }
}

inspector.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.opt === 'snap') return (map.snap = el.checked);
  if (el.dataset.opt === 'paths') return (map.showPaths = el.checked);
  if (el.dataset.opt === 'boxcolor') {
    map.boxColor = el.value;
    $$('.swatch', inspector).forEach((sw) => sw.classList.toggle('active', sw.dataset.color === el.value));
    return;
  }
  if (!el.dataset.obj) return;
  if (el.dataset.field === 'color') {
    map.boxColor = el.value;
    $$('.swatch', inspector).forEach((sw) => sw.classList.toggle('active', sw.dataset.color === el.value));
  }
  const t = targetFor(el.dataset.obj);
  if (!t) return;
  const f = el.dataset.field;
  const isNum = el.type === 'range' || el.type === 'number';
  if (el.type === 'checkbox') {
    t[f] = el.dataset.invert ? !el.checked : el.checked;
  } else if (isNum) {
    const n = parseFloat(el.value);
    if (!Number.isFinite(n)) return;
    t[f] = f === 'size' ? Math.max(4, n) : n;
  } else t[f] = el.value;
  // keep slider/number pairs in step
  for (const other of $$(`[data-obj="${el.dataset.obj}"][data-field="${f}"]`, inspector)) if (other !== el) other.value = el.value;
  if (el.dataset.obj === 'scene' && f === 'name') {
    renderSceneTabs();
    renderViewSelect();
  }
  queueSync(currentScene());
});
inspector.addEventListener('change', (e) => {
  if (e.target.dataset.crew) return setPlayerView(e.target.value, e.target.dataset.crew);
  if (e.target.dataset.field === 'pathMode' || e.target.dataset.field === 'speed') renderInspector();
});

inspector.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const s = currentScene();
  const sel = map.getSelected();
  const changed = () => {
    queueSync(s);
    renderInspector();
  };
  switch (btn.dataset.act) {
    case 'show':
      setPlayerView(`scene:${s.id}`);
      break;
    case 'waiting':
      setPlayerView('waiting');
      break;
    case 'crewreset':
      for (const key of Object.keys(state.assignments)) setPlayerView('follow', key);
      break;
    case 'save':
      await saveToLibrary();
      renderInspector();
      break;
    case 'saveas':
      s.libraryId = null;
      await saveToLibrary();
      renderInspector();
      break;
    case 'color':
      map.boxColor = btn.dataset.color;
      if (sel && map.selected.kind === 'box') {
        sel.color = btn.dataset.color;
        changed();
      } else renderInspector();
      break;
    case 'alert':
      sel.alerted = !sel.alerted;
      changed();
      break;
    case 'alertall':
    case 'calmall':
      [...s.enemies, ...s.cameras].forEach((u) => (u.alerted = btn.dataset.act === 'alertall'));
      changed();
      break;
    case 'drawpath':
      setTool(map.tool === 'path' ? 'select' : 'path');
      renderInspector();
      break;
    case 'undopt':
      sel.path.pop();
      changed();
      break;
    case 'clearpath':
      sel.path = [];
      changed();
      break;
    case 'delete':
      map.deleteSelected();
      break;
    case 'delscene':
      deleteScene(s.id);
      break;
  }
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

showMenuTab('name');

// Test hook: open with ?debug to inspect state from the console / automation.
if (new URLSearchParams(location.search).has('debug')) window.__pr = { map, state };
