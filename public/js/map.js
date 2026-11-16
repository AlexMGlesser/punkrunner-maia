// Canvas map: renders a scene (image, grid, rulers, enemies, cameras, sight cones) and,
// when editable, handles the host's editing tools.
import { colName, enemyPose, cameraPose, sightRange, toRad, toDeg } from './sim.js';

const RULER = 26; // px, screen space
const COLORS = {
  enemy: '255,212,0',
  camera: '255,31,69',
  alert: '255,138,0',
};

let uid = 0;
export const newId = () => `${Date.now().toString(36)}${(uid++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const imageCache = new Map();
function loadImage(url) {
  if (!imageCache.has(url)) {
    const img = new Image();
    img.src = url;
    imageCache.set(url, img);
  }
  return imageCache.get(url);
}

export class MapView {
  constructor(canvas, { editable = false, getTime, onChange, onSelect, onCursor } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.editable = editable;
    this.getTime = getTime || (() => 0);
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onCursor = onCursor || (() => {});

    this.scene = null;
    this.image = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.tool = 'select';
    this.selected = null; // { kind: 'enemy'|'camera', id }
    this.snap = true;
    this.showPaths = true;
    this.drag = null;
    this.hoverWorld = null;
    this.spaceDown = false;
    this.needsFit = true;

    this._bindInput();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
    const loop = () => {
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ public
  setScene(scene) {
    const changedScene = !this.scene || !scene || this.scene.id !== scene.id;
    this.scene = scene;
    this.image = scene?.image?.url ? loadImage(scene.image.url) : null;
    if (changedScene) {
      this.selected = null;
      this.drag = null;
      this.needsFit = true;
      this.onSelect(null);
    } else if (this.selected && !this.getSelected()) {
      this.selected = null;
      this.onSelect(null);
    }
  }

  setTool(tool) {
    this.tool = tool;
    this.drag = null;
    this._updateCursor();
  }

  select(sel) {
    this.selected = sel;
    this.onSelect(sel);
  }

  getSelected() {
    if (!this.selected || !this.scene) return null;
    const list = this.selected.kind === 'enemy' ? this.scene.enemies : this.scene.cameras;
    return list.find((u) => u.id === this.selected.id) || null;
  }

  deleteSelected() {
    const u = this.getSelected();
    if (!u) return;
    const key = this.selected.kind === 'enemy' ? 'enemies' : 'cameras';
    this.scene[key] = this.scene[key].filter((x) => x !== u);
    this.select(null);
    this.onChange();
  }

  fit() {
    if (!this.scene) return;
    const { width: W, height: H } = this.scene.image;
    const cw = this.cssW - RULER - 20;
    const ch = this.cssH - RULER - 20;
    if (cw <= 0 || ch <= 0) return;
    this.zoom = Math.min(cw / W, ch / H);
    this.panX = RULER + 10 + (cw - W * this.zoom) / 2;
    this.panY = RULER + 10 + (ch - H * this.zoom) / 2;
    this.needsFit = false;
  }

  /** Grid helpers ----------------------------------------------------------- */
  gridInfo() {
    const s = this.scene;
    const g = s.grid;
    const size = Math.max(4, g.size);
    const c0 = Math.floor((0 - g.x) / size);
    const c1 = Math.ceil((s.image.width - g.x) / size);
    const r0 = Math.floor((0 - g.y) / size);
    const r1 = Math.ceil((s.image.height - g.y) / size);
    return { gx: g.x, gy: g.y, size, c0, c1, r0, r1 };
  }

  cellLabelAt(x, y) {
    if (!this.scene) return '';
    const { width: W, height: H } = this.scene.image;
    if (x < 0 || y < 0 || x > W || y > H) return '';
    const gi = this.gridInfo();
    const c = Math.floor((x - gi.gx) / gi.size) - gi.c0;
    const r = Math.floor((y - gi.gy) / gi.size) - gi.r0;
    return `${colName(c)}${r + 1}`;
  }

  // ------------------------------------------------------------------ coords
  toWorld(sx, sy) {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  snapPoint(p) {
    if (!this.snap) return p;
    const { gx, gy, size } = this.gridInfo();
    return {
      x: gx + (Math.floor((p.x - gx) / size) + 0.5) * size,
      y: gy + (Math.floor((p.y - gy) / size) + 0.5) * size,
    };
  }

  // ------------------------------------------------------------------ input
  _bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerup', (e) => this._onUp(e));
    c.addEventListener('pointercancel', (e) => this._onUp(e));
    c.addEventListener('pointerleave', () => {
      this.hoverWorld = null;
      this.onCursor('');
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) {
        this.spaceDown = true;
        this._updateCursor();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this._updateCursor();
      }
    });
  }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  _onWheel(e) {
    e.preventDefault();
    const { sx, sy } = this._local(e);
    const before = this.toWorld(sx, sy);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoom = Math.min(20, Math.max(0.03, this.zoom * factor));
    this.panX = sx - before.x * this.zoom;
    this.panY = sy - before.y * this.zoom;
  }

  _onDown(e) {
    if (!this.scene) return;
    const { sx, sy } = this._local(e);
    const w = this.toWorld(sx, sy);
    this.canvas.setPointerCapture(e.pointerId);

    const wantsPan = e.button === 1 || e.button === 2 || this.spaceDown || this.tool === 'pan' || !this.editable;
    if (wantsPan) {
      this.drag = { type: 'pan', sx, sy, px: this.panX, py: this.panY };
      this._updateCursor();
      return;
    }
    if (e.button !== 0) return;

    const t = this.getTime();
    const s = this.scene;

    switch (this.tool) {
      case 'select': {
        const sel = this.getSelected();
        if (sel) {
          // rotate handle
          const h = this._rotateHandle(sel, t);
          if (h && dist(w, h) < 9 / this.zoom) {
            this.drag = { type: 'rotate', unit: sel };
            return;
          }
          // path handles
          if (this.selected.kind === 'enemy' && sel.path?.length) {
            const pts = [{ x: sel.x, y: sel.y }, ...sel.path];
            for (let i = pts.length - 1; i >= 0; i--) {
              if (dist(w, pts[i]) < 8 / this.zoom) {
                this.drag = { type: 'waypoint', unit: sel, index: i - 1 };
                return;
              }
            }
          }
        }
        const hit = this._hitTest(w, t);
        if (hit) {
          this.select({ kind: hit.kind, id: hit.unit.id });
          this.drag = {
            type: 'move',
            unit: hit.unit,
            start: w,
            orig: { x: hit.unit.x, y: hit.unit.y, path: (hit.unit.path || []).map((p) => ({ ...p })) },
            moved: false,
          };
        } else {
          if (this.selected) this.select(null);
          this.drag = { type: 'pan', sx, sy, px: this.panX, py: this.panY };
        }
        break;
      }
      case 'enemy': {
        const p = this.snapPoint(w);
        const enemy = {
          id: newId(),
          label: '',
          x: p.x,
          y: p.y,
          facing: 0,
          fov: 90,
          range: 4,
          alerted: false,
          speed: 1,
          pathMode: 'loop',
          path: [],
        };
        s.enemies.push(enemy);
        this.select({ kind: 'enemy', id: enemy.id });
        this.onChange();
        break;
      }
      case 'camera': {
        const p = this.snapPoint(w);
        const cam = {
          id: newId(),
          label: '',
          x: p.x,
          y: p.y,
          facing: 90,
          fov: 60,
          range: 6,
          alerted: false,
          sweep: 0,
          sweepSpeed: 20,
        };
        s.cameras.push(cam);
        this.select({ kind: 'camera', id: cam.id });
        this.onChange();
        break;
      }
      case 'path': {
        const sel = this.selected?.kind === 'enemy' ? this.getSelected() : null;
        const hit = this._hitTest(w, t);
        if (hit && hit.kind === 'enemy' && (!sel || hit.unit.id !== sel.id)) {
          this.select({ kind: 'enemy', id: hit.unit.id });
          break;
        }
        if (!sel) break;
        sel.path = sel.path || [];
        sel.path.push(this.snapPoint(w));
        this.onChange();
        break;
      }
      case 'grid': {
        this.drag = { type: 'grid', start: w, orig: { x: s.grid.x, y: s.grid.y } };
        break;
      }
    }
  }

  _onMove(e) {
    if (!this.scene) return;
    const { sx, sy } = this._local(e);
    const w = this.toWorld(sx, sy);
    this.hoverWorld = w;
    this.onCursor(this.cellLabelAt(w.x, w.y));

    const d = this.drag;
    if (!d) return;
    switch (d.type) {
      case 'pan':
        this.panX = d.px + (sx - d.sx);
        this.panY = d.py + (sy - d.sy);
        break;
      case 'move': {
        let dx = w.x - d.start.x;
        let dy = w.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * this.zoom < 3) return;
        d.moved = true;
        if (this.snap) {
          const target = this.snapPoint({ x: d.orig.x + dx, y: d.orig.y + dy });
          dx = target.x - d.orig.x;
          dy = target.y - d.orig.y;
        }
        d.unit.x = d.orig.x + dx;
        d.unit.y = d.orig.y + dy;
        if (d.unit.path) d.unit.path = d.orig.path.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        this.onChange();
        break;
      }
      case 'waypoint': {
        const p = this.snapPoint(w);
        if (d.index < 0) {
          d.unit.x = p.x;
          d.unit.y = p.y;
        } else d.unit.path[d.index] = p;
        this.onChange();
        break;
      }
      case 'rotate': {
        const pose = this._pose(d.unit, this.getTime());
        let deg = toDeg(Math.atan2(w.y - pose.y, w.x - pose.x));
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        // cameras rotate around their base facing even while sweeping
        d.unit.facing = Math.round(normDeg(deg - (pose.facing - d.unit.facing)));
        this.onChange();
        break;
      }
      case 'grid': {
        const g = this.scene.grid;
        g.x = Math.round((d.orig.x + (w.x - d.start.x)) * 10) / 10;
        g.y = Math.round((d.orig.y + (w.y - d.start.y)) * 10) / 10;
        this.onChange('grid');
        break;
      }
    }
  }

  _onUp(e) {
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    this._updateCursor();
  }

  _updateCursor() {
    let cur = 'default';
    if (this.drag?.type === 'pan') cur = 'grabbing';
    else if (this.spaceDown || this.tool === 'pan' || !this.editable) cur = 'grab';
    else if (this.tool === 'grid') cur = 'move';
    else if (['enemy', 'camera', 'path'].includes(this.tool)) cur = 'crosshair';
    this.canvas.style.cursor = cur;
  }

  _pose(unit, t) {
    const isEnemy = this.scene.enemies.includes(unit);
    return isEnemy ? enemyPose(unit, t, this.scene.grid.size) : cameraPose(unit, t);
  }

  _unitRadius() {
    return Math.max(this.scene.grid.size * 0.3, 5 / this.zoom);
  }

  _hitTest(w, t) {
    const r = Math.max(this._unitRadius(), 10 / this.zoom);
    const s = this.scene;
    for (let i = s.cameras.length - 1; i >= 0; i--) {
      const p = cameraPose(s.cameras[i], t);
      if (dist(w, p) < r * 1.2) return { kind: 'camera', unit: s.cameras[i] };
    }
    for (let i = s.enemies.length - 1; i >= 0; i--) {
      const p = enemyPose(s.enemies[i], t, s.grid.size);
      if (dist(w, p) < r) return { kind: 'enemy', unit: s.enemies[i] };
    }
    return null;
  }

  _rotateHandle(unit, t) {
    // Moving enemies face along their path, so they get no manual rotate handle.
    if (this.scene.enemies.includes(unit) && unit.path?.length && unit.speed > 0) return null;
    const pose = this._pose(unit, t);
    const len = this._unitRadius() + Math.max(this.scene.grid.size * 0.6, 22 / this.zoom);
    const a = toRad(pose.facing);
    return { x: pose.x + Math.cos(a) * len, y: pose.y + Math.sin(a) * len };
  }

  // ------------------------------------------------------------------ render
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width;
    this.cssH = r.height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (this.needsFit) this.fit();
  }

  draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.scene) return;
    if (this.needsFit && this.cssW > 0) this.fit();

    const s = this.scene;
    const z = this.zoom;
    const t = this.getTime();
    const now = performance.now() / 1000;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * this.panX, dpr * this.panY);

    // image
    const { width: W, height: H } = s.image;
    ctx.fillStyle = '#0b0408';
    ctx.fillRect(0, 0, W, H);
    if (this.image?.complete && this.image.naturalWidth) {
      ctx.imageSmoothingEnabled = z < 2;
      ctx.drawImage(this.image, 0, 0, W, H);
    }

    this._drawGrid();

    if (this.editable && this.showPaths) this._drawPaths(t);

    // cones first so bodies sit on top
    const enemyPoses = s.enemies.map((e) => enemyPose(e, t, s.grid.size));
    const camPoses = s.cameras.map((c) => cameraPose(c, t));
    s.cameras.forEach((c, i) => this._drawCone(c, camPoses[i], c.alerted ? COLORS.alert : COLORS.camera));
    s.enemies.forEach((e, i) => this._drawCone(e, enemyPoses[i], e.alerted ? COLORS.alert : COLORS.enemy));
    s.cameras.forEach((c, i) => this._drawCamera(c, camPoses[i], now));
    s.enemies.forEach((e, i) => this._drawEnemy(e, enemyPoses[i], now));

    if (this.editable) this._drawSelection(t);

    // rulers in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawRulers();
  }

  _drawGrid() {
    const { ctx, zoom: z } = this;
    const s = this.scene;
    const { width: W, height: H } = s.image;
    const op = s.grid.opacity;
    if (op <= 0) return;
    const { gx, gy, size, c0, c1, r0, r1 } = this.gridInfo();
    if (size * z < 3) return; // too dense to be meaningful

    ctx.beginPath();
    for (let c = c0; c <= c1; c++) {
      const x = gx + c * size;
      if (x < 0 || x > W) continue;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let r = r0; r <= r1; r++) {
      const y = gy + r * size;
      if (y < 0 || y > H) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    // dark under-stroke + light stroke so it reads on both light and dark maps
    ctx.lineWidth = 2.5 / z;
    ctx.strokeStyle = `rgba(0,0,0,${op * 0.5})`;
    ctx.stroke();
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = `rgba(255,235,240,${op})`;
    ctx.stroke();

    if (this.editable && this.tool === 'grid') {
      // highlight grid origin while editing the grid
      ctx.strokeStyle = 'rgba(255,31,69,0.9)';
      ctx.lineWidth = 2 / z;
      ctx.strokeRect(gx, gy, size, size);
    }
  }

  _drawCone(unit, pose, rgb) {
    const { ctx } = this;
    const R = sightRange(unit, this.scene.grid.size);
    if (R <= 0) return;
    const fov = Math.min(360, Math.max(1, unit.fov || 0));
    const a = toRad(pose.facing);
    const half = toRad(fov / 2);
    ctx.beginPath();
    if (fov >= 360) ctx.arc(pose.x, pose.y, R, 0, Math.PI * 2);
    else {
      ctx.moveTo(pose.x, pose.y);
      ctx.arc(pose.x, pose.y, R, a - half, a + half);
      ctx.closePath();
    }
    const g = ctx.createRadialGradient(pose.x, pose.y, 0, pose.x, pose.y, R);
    const strong = unit.alerted ? 0.42 : 0.3;
    g.addColorStop(0, `rgba(${rgb},${strong})`);
    g.addColorStop(0.75, `rgba(${rgb},${strong * 0.45})`);
    g.addColorStop(1, `rgba(${rgb},0.06)`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.5 / this.zoom;
    ctx.strokeStyle = `rgba(${rgb},${unit.alerted ? 0.9 : 0.6})`;
    ctx.stroke();
  }

  _drawEnemy(e, pose, now) {
    const { ctx, zoom: z } = this;
    const r = this._unitRadius();
    if (e.alerted) {
      const pulse = 1 + 0.25 * (0.5 + 0.5 * Math.sin(now * 6));
      ctx.beginPath();
      ctx.arc(pose.x, pose.y, r * 1.35 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,138,0,0.85)';
      ctx.lineWidth = 2.5 / z;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(pose.x, pose.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd400';
    ctx.shadowColor = e.alerted ? 'rgba(255,138,0,0.9)' : 'rgba(255,212,0,0.7)';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = '#3d2a00';
    ctx.stroke();
    // facing pip
    const a = toRad(pose.facing);
    ctx.beginPath();
    ctx.moveTo(pose.x + Math.cos(a) * r * 0.2, pose.y + Math.sin(a) * r * 0.2);
    ctx.lineTo(pose.x + Math.cos(a) * r * 0.95, pose.y + Math.sin(a) * r * 0.95);
    ctx.lineWidth = Math.max(r * 0.22, 1.5 / z);
    ctx.strokeStyle = '#3d2a00';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
    if (e.alerted) this._text('!', pose.x, pose.y - r * 1.7, '#ff8a00', r * 1.3);
    if (e.label) this._text(e.label, pose.x, pose.y + r * 2.1, '#ffe680', Math.max(r * 0.8, 11 / z));
  }

  _drawCamera(c, pose, now) {
    const { ctx, zoom: z } = this;
    const size = this.scene.grid.size;
    const w = Math.max(size * 0.6, 12 / z);
    const h = Math.max(size * 0.34, 7 / z);
    const col = c.alerted ? '#ff8a00' : '#ff1f45';
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(toRad(pose.facing));
    ctx.shadowColor = col;
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#1c0a10';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = col;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    // lens
    ctx.fillStyle = col;
    ctx.fillRect(w / 2 - w * 0.12, -h * 0.28, w * 0.18, h * 0.56);
    // blinking LED
    if (Math.floor(now * (c.alerted ? 4 : 1.2)) % 2 === 0) {
      ctx.beginPath();
      ctx.arc(-w * 0.25, 0, h * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = c.alerted ? '#ffb000' : '#ff4d6a';
      ctx.fill();
    }
    ctx.restore();
    if (c.label) this._text(c.label, pose.x, pose.y + h * 1.6 + 6 / z, '#ff8da0', Math.max(size * 0.25, 11 / z));
  }

  _drawPaths(t) {
    const { ctx, zoom: z } = this;
    for (const e of this.scene.enemies) {
      if (!e.path?.length) continue;
      const isSel = this.selected?.kind === 'enemy' && this.selected.id === e.id;
      const pts = [{ x: e.x, y: e.y }, ...e.path];
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      if (e.pathMode !== 'pingpong') ctx.closePath();
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.lineWidth = (isSel ? 2.2 : 1.5) / z;
      ctx.strokeStyle = isSel ? 'rgba(255,230,120,0.95)' : 'rgba(255,212,0,0.45)';
      ctx.stroke();
      ctx.setLineDash([]);
      if (!isSel) {
        for (const p of pts.slice(1)) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5 / z, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,212,0,0.6)';
          ctx.fill();
        }
      }
    }
  }

  _drawSelection(t) {
    const { ctx, zoom: z } = this;
    const u = this.getSelected();
    if (u) {
      const pose = this._pose(u, t);
      const r = this._unitRadius() * (this.selected.kind === 'camera' ? 1.4 : 1) + 6 / z;
      ctx.beginPath();
      ctx.arc(pose.x, pose.y, r, 0, Math.PI * 2);
      ctx.setLineDash([4 / z, 3 / z]);
      ctx.lineWidth = 2 / z;
      ctx.strokeStyle = '#ff1f45';
      ctx.stroke();
      ctx.setLineDash([]);

      // path handles for the selected enemy
      if (this.selected.kind === 'enemy') {
        const pts = [{ x: u.x, y: u.y }, ...(u.path || [])];
        if (pts.length > 1 || this.tool === 'path') {
          pts.forEach((p, i) => {
            const hs = 6 / z;
            if (i === 0) {
              ctx.fillStyle = '#ff1f45';
              ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
            } else {
              ctx.beginPath();
              ctx.arc(p.x, p.y, hs, 0, Math.PI * 2);
              ctx.fillStyle = '#ffd400';
              ctx.fill();
              ctx.lineWidth = 1.5 / z;
              ctx.strokeStyle = '#3d2a00';
              ctx.stroke();
              this._text(String(i), p.x, p.y - 12 / z, '#fff', 10 / z);
            }
          });
        }
        // preview of the next path segment
        if (this.tool === 'path' && this.hoverWorld) {
          const last = pts[pts.length - 1];
          const nxt = this.snapPoint(this.hoverWorld);
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(nxt.x, nxt.y);
          ctx.setLineDash([3 / z, 4 / z]);
          ctx.lineWidth = 1.5 / z;
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // rotate handle
      if (this.tool === 'select') {
        const h = this._rotateHandle(u, t);
        if (h) {
          ctx.beginPath();
          ctx.moveTo(pose.x, pose.y);
          ctx.lineTo(h.x, h.y);
          ctx.lineWidth = 1.5 / z;
          ctx.strokeStyle = 'rgba(255,31,69,0.8)';
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(h.x, h.y, 6 / z, 0, Math.PI * 2);
          ctx.fillStyle = '#ff1f45';
          ctx.fill();
          ctx.lineWidth = 2 / z;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
      }
    }

    // placement ghost
    if ((this.tool === 'enemy' || this.tool === 'camera') && this.hoverWorld && !this.drag) {
      const p = this.snapPoint(this.hoverWorld);
      ctx.globalAlpha = 0.45;
      if (this.tool === 'enemy') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, this._unitRadius(), 0, Math.PI * 2);
        ctx.fillStyle = '#ffd400';
        ctx.fill();
      } else {
        const size = this.scene.grid.size;
        ctx.strokeStyle = '#ff1f45';
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(p.x - size * 0.3, p.y - size * 0.17, size * 0.6, size * 0.34);
      }
      ctx.globalAlpha = 1;
    }
  }

  _drawRulers() {
    const { ctx, zoom: z } = this;
    const W = this.cssW;
    const H = this.cssH;
    const { gx, gy, size, c0, c1, r0, r1 } = this.gridInfo();
    const cellPx = size * z;
    const imgW = this.scene.image.width;
    const imgH = this.scene.image.height;

    ctx.fillStyle = 'rgba(10,4,8,0.92)';
    ctx.fillRect(0, 0, W, RULER);
    ctx.fillRect(0, 0, RULER, H);
    ctx.fillStyle = '#ff1f45';
    ctx.fillRect(0, RULER - 1, W, 1);
    ctx.fillRect(RULER - 1, 0, 1, H);

    const hover = this.hoverWorld;
    const hc = hover ? Math.floor((hover.x - gx) / size) : null;
    const hr = hover ? Math.floor((hover.y - gy) / size) : null;
    const inImg = hover && hover.x >= 0 && hover.y >= 0 && hover.x <= imgW && hover.y <= imgH;

    ctx.font = `600 11px Orbitron, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const colStep = Math.max(1, Math.ceil(26 / cellPx));
    const rowStep = Math.max(1, Math.ceil(16 / cellPx));

    // columns: A..Z, AA..
    ctx.save();
    ctx.beginPath();
    ctx.rect(RULER, 0, W - RULER, RULER);
    ctx.clip();
    for (let c = c0; c < c1; c++) {
      const idx = c - c0;
      const left = Math.max(0, gx + c * size);
      const right = Math.min(imgW, gx + (c + 1) * size);
      const sx = ((left + right) / 2) * z + this.panX;
      if (sx < RULER - 40 || sx > W + 40) continue;
      const isHover = inImg && c === hc;
      if (isHover) {
        ctx.fillStyle = 'rgba(255,31,69,0.25)';
        ctx.fillRect(left * z + this.panX, 0, (right - left) * z, RULER - 1);
      }
      if (idx % colStep && !isHover) continue;
      ctx.fillStyle = isHover ? '#fff' : '#ff6b84';
      ctx.fillText(colName(idx), sx, RULER / 2 + 1);
    }
    ctx.restore();

    // rows: 1..N
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, RULER, H - RULER);
    ctx.clip();
    ctx.font = `600 10px Orbitron, "Segoe UI", sans-serif`;
    for (let r = r0; r < r1; r++) {
      const idx = r - r0;
      const top = Math.max(0, gy + r * size);
      const bottom = Math.min(imgH, gy + (r + 1) * size);
      const sy = ((top + bottom) / 2) * z + this.panY;
      if (sy < RULER - 40 || sy > H + 40) continue;
      const isHover = inImg && r === hr;
      if (isHover) {
        ctx.fillStyle = 'rgba(255,31,69,0.25)';
        ctx.fillRect(0, top * z + this.panY, RULER - 1, (bottom - top) * z);
      }
      if (idx % rowStep && !isHover) continue;
      ctx.fillStyle = isHover ? '#fff' : '#ff6b84';
      ctx.fillText(String(idx + 1), RULER / 2, sy);
    }
    ctx.restore();

    ctx.fillStyle = '#12070c';
    ctx.fillRect(0, 0, RULER - 1, RULER - 1);
  }

  _text(str, x, y, color, px) {
    const { ctx } = this;
    ctx.font = `600 ${px}px "Share Tech Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(px * 0.25, 2 / this.zoom);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function normDeg(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}
export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
