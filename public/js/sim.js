// Deterministic simulation: every client computes positions from (scene data, sim time),
// so only the clock needs to be synced over the network.

export const ALERT_RANGE_MULT = 1.5;

/** Spreadsheet-style column name: 0 → A, 25 → Z, 26 → AA */
export function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

const RAD = Math.PI / 180;
export const toRad = (d) => d * RAD;
export const toDeg = (r) => r / RAD;

/** Route the enemy walks: start point followed by waypoints, expanded by path mode. */
function route(e) {
  const pts = [{ x: e.x, y: e.y }, ...(e.path || [])];
  if (pts.length < 2) return null;
  if (e.pathMode === 'pingpong') {
    return pts.concat(pts.slice(0, -1).reverse());
  }
  return pts.concat([pts[0]]); // loop back to start
}

/**
 * @returns {{x:number,y:number,facing:number}} facing in degrees (0 = east, 90 = south)
 */
export function enemyPose(e, t, cellSize) {
  const pts = route(e);
  const speedPx = (e.speed || 0) * cellSize;
  if (!pts || speedPx <= 0) return { x: e.x, y: e.y, facing: e.facing || 0 };

  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.001) continue;
    segs.push({ a, b, len, start: total });
    total += len;
  }
  if (!segs.length) return { x: e.x, y: e.y, facing: e.facing || 0 };

  let d = (t * speedPx) % total;
  if (d < 0) d += total;
  let seg = segs[segs.length - 1];
  for (const s of segs) {
    if (d < s.start + s.len) {
      seg = s;
      break;
    }
  }
  const k = (d - seg.start) / seg.len;
  return {
    x: seg.a.x + (seg.b.x - seg.a.x) * k,
    y: seg.a.y + (seg.b.y - seg.a.y) * k,
    facing: toDeg(Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x)),
  };
}

/** Cameras optionally sweep back and forth around their base facing. */
export function cameraPose(c, t) {
  let facing = c.facing || 0;
  if (c.sweep > 0 && c.sweepSpeed > 0) {
    const half = c.sweep / 2;
    const period = (2 * c.sweep) / c.sweepSpeed; // seconds for a full there-and-back
    facing += half * Math.sin((2 * Math.PI * t) / period);
  }
  return { x: c.x, y: c.y, facing };
}

/** Effective sight range in pixels. */
export function sightRange(unit, cellSize) {
  return (unit.range || 0) * cellSize * (unit.alerted ? ALERT_RANGE_MULT : 1);
}
