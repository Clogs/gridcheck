"use strict";

// Top-down tactical frames for `e2e run`, drawn from the run's own
// timeline.jsonl: the watch's POS events say where every ball near the ship
// was, the other events say when to draw. One SVG per key event:
//   - the first ARRIVE of each flight (or of each ball with no flight);
//   - the first TARGET lock on self;
//   - each DESTROYED;
//   - the stop condition (the runner's STOP, at the event that met it).
// Pure apart from writeFrames, so tests can pin the selection and the drawing.

const fs = require("node:fs");
const path = require("node:path");

const { formatDistance } = require("./format");
const { formatOffset, formatTimelineEvent } = require("./timeline");

const MAX_FRAMES = 40;
// A key event uses the newest POS at or before it, else the first after it
// within this window (an off-grid event can land between two samples).
const AFTER_WINDOW_MS = 15_000;
const MIN_HALF_SPAN_METERS = 5_000;
const CONTEXT_METERS = 50_000;
const TRACKED = new Set(["ship", "drone", "fighter", "wreck", "container", "structure"]);
const MOVING_MODES = new Set(["ORBIT", "FOLLOW", "APPROACH"]);

const SIZE = Object.freeze({ width: 1100, height: 760, plot: 640, left: 20, top: 74, legendX: 684 });
const COLOURS = Object.freeze({
  self: "#1f6feb",
  pirate: "#d1242f",
  concord: "#bf8700",
  drifter: "#8250df",
  player: "#1a7f37",
  neutral: "#6e7781",
  others: ["#e16f24", "#0a7f86", "#a0457a", "#7d4e00", "#5a32a3", "#2f6f3e"],
});

const REASON_TEXT = {
  arrive: "first arrival of the flight",
  target: "first lock on self",
  destroyed: "destroyed",
  stop: "stop condition",
};

function escapeXml(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clip(text, width) {
  const value = String(text || "");
  return value.length > width ? `${value.slice(0, width - 1)}~` : value;
}

function slug(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";
}

function readTimeline(file) {
  if (!fs.existsSync(file)) return [];
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_error) {
      // A line cut off by an interrupted run.
    }
  }
  return events;
}

// The balls an event is about, by item ID.
function focusIDs(event, more = []) {
  if (!event) return [];
  const ids = [];
  for (const other of more) ids.push(...focusIDs(other));
  if (Array.isArray(event.members)) ids.push(...event.members.map((member) => member.itemID));
  for (const key of ["itemID", "sourceID", "targetID", "wreckID", "observerID"]) {
    if (event[key]) ids.push(event[key]);
  }
  return [...new Set(ids.map(Number).filter((id) => id > 0))];
}

function arrivalKey(event) {
  if (event.flightID) return `flight:${event.flightID}`;
  const first = Array.isArray(event.members) && event.members[0];
  return `item:${first ? first.itemID : event.seq}`;
}

// Key events in time order, at most maxFrames: destructions, the first lock and
// the stop come first, then arrivals in order until the cap.
function selectKeyEvents(events, { maxFrames = MAX_FRAMES } = {}) {
  const bySeq = new Map();
  for (const event of events) if (event.source !== "runner" && event.seq !== undefined) bySeq.set(event.seq, event);
  const keys = [];
  const arrivals = new Set();
  let targetDone = false;
  for (const event of events) {
    if (event.source === "client") continue;
    if (event.kind === "ARRIVE") {
      const key = arrivalKey(event);
      if (arrivals.has(key)) continue;
      arrivals.add(key);
      // Balls with no flight (a /npc spawn, a skirmish wing, CONCORD) landing in
      // one sample share a frame.
      const sameSample = !event.flightID && keys.find((other) => other.reason === "arrive" && !other.event.flightID &&
        other.event.atMs === event.atMs);
      if (sameSample) {
        sameSample.also.push(event);
        continue;
      }
      keys.push({ reason: "arrive", event, also: [], what: event.flightID || (event.members && event.members[0] && event.members[0].label) });
    } else if (event.kind === "TARGET" && !targetDone && event.locked && event.targetLabel === "self") {
      targetDone = true;
      keys.push({ reason: "target", event, what: "self" });
    } else if (event.kind === "DESTROYED") {
      keys.push({ reason: "destroyed", event, what: event.self ? "self" : event.label });
    } else if (event.kind === "STOP" && event.source === "runner") {
      const matched = event.matchedSeq !== null && event.matchedSeq !== undefined ? bySeq.get(event.matchedSeq) : null;
      const existing = matched ? keys.find((key) => key.event === matched) : null;
      if (existing) existing.alsoStop = event;
      else keys.push({ reason: "stop", event: matched || event, stop: event, what: matched ? matched.kind : event.reason });
    }
  }
  const essential = keys.filter((key) => key.reason !== "arrive");
  const arrive = keys.filter((key) => key.reason === "arrive");
  const room = Math.max(0, maxFrames - essential.length);
  const kept = new Set([...essential.slice(0, maxFrames), ...arrive.slice(0, room)]);
  const chosen = keys.filter((key) => kept.has(key));
  return { keys: chosen, skipped: keys.length - chosen.length };
}

function positionsFor(positions, atMs) {
  let before = null;
  let after = null;
  for (const pos of positions) {
    if (pos.atMs <= atMs) before = pos;
    else if (!after) after = pos;
  }
  if (before) return before;
  if (after && after.atMs - atMs <= AFTER_WINDOW_MS) return after;
  return null;
}

function colourFor(ball, palette) {
  if (ball.who === "self") return COLOURS.self;
  if (ball.who === "concord" || ball.family === "concord") return COLOURS.concord;
  if (ball.who === "drifter") return COLOURS.drifter;
  if (ball.who === "player") return COLOURS.player;
  if (ball.family === "pirate") return COLOURS.pirate;
  if (!ball.who) return COLOURS.neutral;
  // Any other NPC: one colour per flight, so two sides of a fight differ.
  // With no flight, family or corporation (a skirmish wing spawned with the war
  // off), the name's first word is the side: "OTSC Raider", "UEMD Defender".
  const key = ball.flightID || ball.family || (ball.corp ? `corp:${ball.corp}` : `name:${String(ball.label || "").split(" ")[0]}`);
  if (!palette.has(key)) palette.set(key, COLOURS.others[palette.size % COLOURS.others.length]);
  return palette.get(key);
}

function niceLength(target) {
  if (!(target > 0)) return 1000;
  const power = 10 ** Math.floor(Math.log10(target));
  for (const step of [5, 2, 1]) if (step * power <= target) return step * power;
  return power;
}

function shipShape(x, y, r, colour, ball) {
  if (ball.kind === "wreck") {
    return `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}" stroke="${colour}" stroke-width="2"/>`;
  }
  if (ball.kind === "drone" || ball.kind === "fighter") return `<circle cx="${x}" cy="${y}" r="${r * 0.5}" fill="${colour}"/>`;
  if (ball.kind === "container") return `<rect x="${x - r * 0.6}" y="${y - r * 0.6}" width="${r * 1.2}" height="${r * 1.2}" fill="${colour}"/>`;
  if (!TRACKED.has(ball.kind) || ball.kind === "structure") {
    return `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" fill="none" stroke="${colour}" stroke-width="1.5"/>`;
  }
  if (ball.who === "self") {
    return `<path d="M${x} ${y - r * 1.3}L${x + r * 1.3} ${y}L${x} ${y + r * 1.3}L${x - r * 1.3} ${y}Z" fill="${colour}"/>`;
  }
  return `<path d="M${x} ${y - r}L${x + r * 0.9} ${y + r * 0.75}L${x - r * 0.9} ${y + r * 0.75}Z" fill="${colour}"/>`;
}

// One frame as SVG text. key: { reason, event, stop?, alsoStop? }.
function renderFrame(pos, key, { index = 1, system = null } = {}) {
  const balls = Array.isArray(pos.balls) ? pos.balls : [];
  const byID = new Map(balls.map((ball) => [ball.id, ball]));
  const self = byID.get(pos.selfID) || null;
  const focus = new Set(focusIDs(key.event, key.also || []).filter((id) => byID.has(id) && id !== pos.selfID));
  // Arrivals and anything about self are drawn around self, so their
  // distances read from the centre. A fight elsewhere on the grid is drawn
  // around itself.
  const event = key.event;
  const aboutSelf = event.self === true || event.label === "self" || event.targetLabel === "self";
  const selfCentred = Boolean(self) && (!focus.size || aboutSelf || key.reason === "arrive" ||
    (key.reason === "stop" && event.kind === "STOP"));
  if (self && selfCentred) focus.add(self.id);
  const focusBalls = [...focus].map((id) => byID.get(id));
  const centroid = (list) => ({ x: list.reduce((sum, ball) => sum + ball.x, 0) / list.length,
    y: list.reduce((sum, ball) => sum + ball.y, 0) / list.length, z: list.reduce((sum, ball) => sum + ball.z, 0) / list.length });
  const centre = selfCentred ? self : focusBalls.length ? centroid(focusBalls) : self || balls[0] || { x: 0, y: 0, z: 0 };
  const origin = self || centre;
  const planar = (ball) => Math.hypot(ball.x - centre.x, ball.z - centre.z);
  const fromSelf = (ball) => Math.hypot(ball.x - origin.x, (ball.y || 0) - (origin.y || 0), ball.z - origin.z);
  const focusMax = focusBalls.reduce((max, ball) => Math.max(max, planar(ball)), 0);
  const contextLimit = Math.max(2 * focusMax, CONTEXT_METERS);
  const contextMax = balls.filter((ball) => TRACKED.has(ball.kind) && planar(ball) <= contextLimit)
    .reduce((max, ball) => Math.max(max, planar(ball)), 0);
  const half = Math.max(MIN_HALF_SPAN_METERS, 1.12 * Math.max(focusMax, contextMax));
  const { plot, left, top, legendX } = SIZE;
  const scale = (plot / 2) / half;
  const cx = left + plot / 2;
  const cy = top + plot / 2;
  // Top-down: x to the right, z up; height (y) is dropped.
  const project = (ball) => ({ x: cx + (ball.x - centre.x) * scale, y: cy - (ball.z - centre.z) * scale });
  const inside = (point) => point.x >= left && point.x <= left + plot && point.y >= top && point.y <= top + plot;
  const round = (value) => Math.round(value * 10) / 10;

  const palette = new Map();
  const colour = new Map(balls.map((ball) => [ball.id, colourFor(ball, palette)]));
  const tracked = balls.filter((ball) => TRACKED.has(ball.kind));
  const order = [...tracked].sort((a, b) => (focus.has(b.id) - focus.has(a.id)) ||
    (a.who === "self" ? -1 : b.who === "self" ? 1 : 0) || planar(a) - planar(b));
  const number = new Map(order.map((ball, i) => [ball.id, i + 1]));
  const labelAll = tracked.length <= 12;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE.width}" height="${SIZE.height}" ` +
    `viewBox="0 0 ${SIZE.width} ${SIZE.height}" font-family="Consolas, Menlo, monospace" font-size="11">`);
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  const where = pos.systemName || system || (pos.systemID ? `system ${pos.systemID}` : "?");
  const why = `${REASON_TEXT[key.reason]}${key.alsoStop ? ", and the stop condition" : ""}`;
  out.push(`<text x="${left}" y="24" font-size="15" font-weight="bold">${escapeXml(clip(
    `${String(index).padStart(2, "0")}  ${where}  ${formatOffset(key.event.t)}  ${why}`, 110))}</text>`);
  const line = key.reason === "stop" && key.stop && key.event === key.stop
    ? formatTimelineEvent(key.stop)
    : `${formatTimelineEvent(key.event)}${key.also && key.also.length ? `  (+${key.also.length} more arriving)` : ""}`;
  out.push(`<text x="${left}" y="44">${escapeXml(clip(line, 150))}</text>`);
  const stopEvent = key.stop || key.alsoStop;
  if (stopEvent && stopEvent !== key.event) {
    out.push(`<text x="${left}" y="60">${escapeXml(clip(formatTimelineEvent(stopEvent), 150))}</text>`);
  }

  out.push(`<rect x="${left}" y="${top}" width="${plot}" height="${plot}" fill="#f6f8fa" stroke="#d0d7de"/>`);
  out.push(`<svg x="${left}" y="${top}" width="${plot}" height="${plot}" overflow="hidden">`);
  out.push(`<g transform="translate(${-left} ${-top})">`);
  // Range rings around the centre, one scale-bar length apart.
  const bar = niceLength((2 * half) / 5);
  for (let ring = 1; ring * bar <= half * 1.4 && ring <= 6; ring += 1) {
    out.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(ring * bar * scale)}" fill="none" stroke="#d8dee4" stroke-dasharray="3 4"/>`);
  }
  // Movement (orbit, follow, approach) as dashed lines, locks as solid ones.
  for (const ball of balls) {
    const from = project(ball);
    const target = ball.target ? byID.get(ball.target) : null;
    if (target && MOVING_MODES.has(ball.mode)) {
      const to = project(target);
      out.push(`<line x1="${round(from.x)}" y1="${round(from.y)}" x2="${round(to.x)}" y2="${round(to.y)}" ` +
        `stroke="${colour.get(ball.id)}" stroke-opacity="0.45" stroke-dasharray="5 4"/>`);
    }
    for (const lockID of ball.locks || []) {
      const locked = byID.get(lockID);
      if (!locked) continue;
      const to = project(locked);
      const keyLock = key.event.kind === "TARGET" && key.event.sourceID === ball.id && key.event.targetID === lockID;
      const onSelf = lockID === pos.selfID;
      out.push(`<line x1="${round(from.x)}" y1="${round(from.y)}" x2="${round(to.x)}" y2="${round(to.y)}" ` +
        `stroke="${onSelf ? COLOURS.pirate : colour.get(ball.id)}" stroke-width="${keyLock ? 2.6 : 1.1}" stroke-opacity="${keyLock ? 0.95 : 0.7}"/>`);
    }
  }
  // Labels step down until they clear the ones already placed.
  const placed = [];
  // Returns null when there is no room; optional labels are then left out.
  const place = (x, y, text, anchorEnd = false, optional = false) => {
    const width = 6.6 * text.length;
    const x0 = anchorEnd ? x - width : x;
    const clashes = (ty) => placed.some((box) => x0 < box.x1 && x0 + width > box.x0 && ty - 10 < box.y1 && ty + 2 > box.y0);
    let ty = y;
    let tries = 0;
    while (clashes(ty) && tries < 14) {
      ty += 13;
      tries += 1;
    }
    if (clashes(ty)) {
      if (optional) return null;
      ty = y;
    }
    placed.push({ x0, x1: x0 + width, y0: ty - 10, y1: ty + 2 });
    return ty;
  };
  const edge = [];
  const drawn = [...balls].sort((a, b) => (focus.has(b.id) - focus.has(a.id)) || planar(a) - planar(b));
  const labels = [];
  for (const ball of drawn) {
    const point = project(ball);
    if (!inside(point)) {
      edge.push({ ball, point });
      continue;
    }
    const isFocus = focus.has(ball.id);
    const c = colour.get(ball.id);
    out.push(shipShape(round(point.x), round(point.y), TRACKED.has(ball.kind) ? 6 : 5, c, ball));
    if (isFocus && ball.who !== "self") {
      out.push(`<circle cx="${round(point.x)}" cy="${round(point.y)}" r="12" fill="none" stroke="#24292f" stroke-width="1.4"/>`);
    }
    const n = number.get(ball.id);
    const text = !TRACKED.has(ball.kind) ? clip(ball.label, 28)
      : (isFocus || labelAll) ? `${n} ${clip(ball.label, 26)}` : String(n);
    // Near the right edge the label goes on the left, so the plot doesn't cut it.
    const flip = point.x > left + plot - 6.6 * text.length - 12;
    const tx = point.x + (flip ? -9 : 9);
    const ty = place(tx, point.y - 7, text, flip, !TRACKED.has(ball.kind));
    if (ty === null) continue;
    labels.push(`<text x="${round(tx)}" y="${round(ty)}"${flip ? ' text-anchor="end"' : ""} ` +
      `fill="${TRACKED.has(ball.kind) ? c : "#57606a"}"${isFocus ? ' font-weight="bold"' : ""}>${escapeXml(text)}</text>`);
  }
  out.push(...labels);
  out.push("</g></svg>");
  // Balls beyond the frame: an arrow on the edge, toward them. Ships are
  // labelled there; landmarks are listed under the legend instead.
  const bearing = (ball) => {
    const degrees = (Math.atan2(ball.x - centre.x, ball.z - centre.z) * 180 / Math.PI + 360) % 360;
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(degrees / 45) % 8];
  };
  const landmarks = [];
  for (const { ball, point } of edge) {
    const dx = point.x - cx;
    const dy = point.y - cy;
    const t = Math.min((plot / 2 - 10) / Math.abs(dx || 1e-9), (plot / 2 - 10) / Math.abs(dy || 1e-9));
    const ex = cx + dx * t;
    const ey = cy + dy * t;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const tracked = TRACKED.has(ball.kind);
    const c = tracked ? colour.get(ball.id) : "#8c959f";
    out.push(`<path d="M0 -5L10 0L0 5Z" fill="${c}" transform="translate(${round(ex)} ${round(ey)}) rotate(${round(angle)})"/>`);
    if (!tracked) {
      landmarks.push(ball);
      continue;
    }
    const text = `${number.get(ball.id)} ${clip(ball.label, 16)} ${formatDistance(fromSelf(ball))}`;
    const tx = Math.min(Math.max(ex - 40, left + 4), left + plot - 6.6 * text.length - 4);
    const ty = place(tx, Math.min(Math.max(ey + (dy > 0 ? -8 : 16), top + 12), top + plot - 30), text);
    out.push(`<text x="${round(tx)}" y="${round(ty)}" fill="${c}">${escapeXml(text)}</text>`);
  }

  // Scale bar, bottom left inside the plot.
  const barPx = bar * scale;
  const by = top + plot - 16;
  out.push(`<rect x="${left + 10}" y="${by - 16}" width="${round(barPx + 70)}" height="26" fill="#ffffff" fill-opacity="0.85"/>`);
  out.push(`<path d="M${left + 16} ${by - 4}V${by + 4}M${left + 16} ${by}H${round(left + 16 + barPx)}M${round(left + 16 + barPx)} ${by - 4}V${by + 4}" stroke="#24292f" stroke-width="2"/>`);
  out.push(`<text x="${round(left + 22 + barPx)}" y="${by + 4}" font-weight="bold">${escapeXml(formatDistance(bar))}</text>`);

  // Legend: every ship, drone, wreck and structure in the frame or beyond it.
  let y = top + 4;
  out.push(`<text x="${legendX + 12}" y="${y + 8}" font-weight="bold" xml:space="preserve">#  from self  mode    name (type)</text>`);
  y += 24;
  const rows = Math.floor((top + plot - 60 - y) / 15);
  for (const ball of order.slice(0, rows)) {
    const distance = fromSelf(ball);
    const c = colour.get(ball.id);
    out.push(`<rect x="${legendX}" y="${y - 8}" width="8" height="8" fill="${c}"/>`);
    const text = `${String(number.get(ball.id)).padEnd(3)}${(ball.who === "self" ? "-" : formatDistance(distance)).padEnd(11)}` +
      `${(ball.mode || "-").padEnd(8)}${ball.label}${ball.type ? ` (${ball.type})` : ""}`;
    out.push(`<text x="${legendX + 12}" y="${y}" xml:space="preserve"${focus.has(ball.id) ? ' font-weight="bold"' : ""}>${escapeXml(clip(text, 62))}</text>`);
    y += 15;
  }
  if (order.length > rows) {
    out.push(`<text x="${legendX}" y="${y}">+${order.length - rows} more</text>`);
    y += 15;
  }
  const landmarkRows = Math.max(0, Math.floor((top + plot - 60 - y - 20) / 15));
  if (landmarks.length && landmarkRows > 1) {
    y += 10;
    out.push(`<text x="${legendX}" y="${y}" font-weight="bold" fill="#57606a">Beyond the frame</text>`);
    y += 15;
    const nearest = [...landmarks].sort((a, b) => planar(a) - planar(b));
    for (const ball of nearest.slice(0, landmarkRows - 1)) {
      out.push(`<text x="${legendX + 12}" y="${y}" fill="#57606a" xml:space="preserve">` +
        `${escapeXml(clip(`${formatDistance(fromSelf(ball)).padEnd(10)} ${bearing(ball).padEnd(3)}${ball.label}`, 60))}</text>`);
      y += 15;
    }
    if (nearest.length > landmarkRows - 1) {
      out.push(`<text x="${legendX + 12}" y="${y}" fill="#57606a">+${nearest.length - landmarkRows + 1} more</text>`);
    }
  }
  const keyY = top + plot - 44;
  out.push(`<text x="${legendX}" y="${keyY}" fill="#57606a">Blue self, red pirate, gold CONCORD, green player, other NPCs</text>`);
  out.push(`<text x="${legendX}" y="${keyY + 14}" fill="#57606a">one colour per flight; grey squares are celestials. Ringed: what</text>`);
  out.push(`<text x="${legendX}" y="${keyY + 28}" fill="#57606a">the frame is about. Solid line: a lock; dashed: orbit or follow.</text>`);

  const lagMs = pos.atMs - (key.event.atMs || pos.atMs);
  const footer = [
    `Top-down: x right, z up, height dropped; N = +z. Half-width ${formatDistance(half)}, ` +
      `${selfCentred ? "centred on self" : `centred on the event${self ? ` (${formatDistance(fromSelf(centre))} from self)` : ", self not on grid"}`}.`,
    `Distances are from self. Positions from the sample at ${formatOffset(pos.t)}` +
      `${lagMs ? ` (${lagMs > 0 ? "+" : ""}${(lagMs / 1000).toFixed(1)} s from the event)` : ""}; ` +
      `${balls.length} balls within ${formatDistance(pos.rangeMeters)}${pos.omitted ? `, ${pos.omitted} beyond` : ""}.`,
  ];
  footer.forEach((text, i) => {
    out.push(`<text x="${left}" y="${top + plot + 20 + 14 * i}" fill="#57606a">${escapeXml(clip(text, 160))}</text>`);
  });
  out.push("</svg>");
  return { svg: `${out.join("\n")}\n`, halfMeters: half, balls: balls.length, focus: [...focus] };
}

// Every frame a timeline asks for, without writing anything.
function buildFrames(events, options = {}) {
  const positions = events.filter((event) => event.kind === "POS");
  const { keys, skipped } = selectKeyEvents(events, options);
  const frames = [];
  const unplaced = [];
  for (const key of keys) {
    const atMs = Number(key.event.atMs) || 0;
    const pos = positionsFor(positions, atMs);
    if (!pos) {
      unplaced.push({ reason: key.reason, t: key.event.t, line: formatTimelineEvent(key.event) });
      continue;
    }
    const index = frames.length + 1;
    const drawn = renderFrame(pos, key, { index });
    const name = `${String(index).padStart(2, "0")}-${key.reason}-${slug(key.what)}.svg`;
    frames.push({
      file: name,
      index,
      reason: key.reason,
      stop: Boolean(key.stop || key.alsoStop),
      t: key.event.t,
      seq: key.event.seq === undefined ? null : key.event.seq,
      line: formatTimelineEvent(key.reason === "stop" && key.stop === key.event ? key.stop : key.event),
      positionsT: pos.t,
      lagMs: pos.atMs - atMs,
      balls: drawn.balls,
      halfMeters: Math.round(drawn.halfMeters),
      svg: drawn.svg,
    });
  }
  return { frames, skipped, unplaced, positions: positions.length };
}

function writeFrames(runDir, events, options = {}) {
  const built = buildFrames(events, options);
  const dir = path.join(runDir, "frames");
  if (built.frames.length) fs.mkdirSync(dir, { recursive: true });
  for (const frame of built.frames) fs.writeFileSync(path.join(dir, frame.file), frame.svg);
  return {
    ...built,
    frames: built.frames.map(({ svg, ...rest }) => ({ ...rest, file: `frames/${rest.file}` })),
  };
}

// The report's "Tactical frames" section.
function renderFramesSection(summary) {
  const lines = ["## Tactical frames", ""];
  if (!summary) {
    lines.push("No frames: the run wrote no timeline.", "");
    return lines.join("\n");
  }
  if (!summary.frames.length) {
    lines.push(summary.positions
      ? "No key event (first arrival per flight, first lock on self, a destruction, the stop) to draw."
      : "No frames: the watch recorded no positions (the ship never undocked, or the run ended first).", "");
  } else {
    lines.push("Top-down SVGs drawn from the `POS` samples in `timeline.jsonl`: the first arrival of each flight, " +
      "the first lock on self, each destruction and the stop condition.", "");
    lines.push("| # | t | Why | Event | Frame |", "| --- | --- | --- | --- | --- |");
    for (const frame of summary.frames) {
      const why = `${REASON_TEXT[frame.reason]}${frame.stop && frame.reason !== "stop" ? " + stop" : ""}`;
      const event = frame.line.slice(12).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
      lines.push(`| ${frame.index} | ${formatOffset(frame.t)} | ${why} | \`${event.slice(0, 120)}\` | ` +
        `[${frame.file.slice("frames/".length)}](${frame.file}) |`);
    }
    lines.push("");
    const stop = summary.frames.find((frame) => frame.stop);
    if (stop) lines.push(`![Stop frame: ${REASON_TEXT[stop.reason]}](${stop.file})`, "");
  }
  if (summary.skipped) lines.push(`${summary.skipped} more arrival(s) not drawn: the run keeps at most ${MAX_FRAMES} frames.`, "");
  for (const row of summary.unplaced) lines.push(`- no positions near ${formatOffset(row.t)} for the ${row.reason} frame`);
  if (summary.unplaced.length) lines.push("");
  return lines.join("\n");
}

module.exports = {
  MAX_FRAMES,
  buildFrames,
  focusIDs,
  niceLength,
  positionsFor,
  readTimeline,
  renderFrame,
  renderFramesSection,
  selectKeyEvents,
  writeFrames,
};
