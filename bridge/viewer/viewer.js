"use strict";

// The e2e viewer: draws a run's timeline.jsonl as a top-down tactical view
// with a replay scrubber, live while the run writes it. Served by the agent
// bridge (bridge/viewer.js) or by `e2e view`. Positions come from the
// watch's POS events, the rest from the timeline's own events; DIVERGE events
// (what the client was sent disagreeing with the server) are marked on the
// map, the scrubber and their own list. Guide: docs/E2E-GRID-TESTING.md "Viewer".

(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const PLOT = 640;
  const TRACKED = new Set(["ship", "drone", "fighter", "wreck", "container", "structure"]);
  const MOVING = new Set(["ORBIT", "FOLLOW", "APPROACH"]);
  // Plugins add colours for their own balls (GET /viewer/config).
  const COLOURS = {
    self: "#1f6feb", hostile: "#d1242f", concord: "#bf8700", drifter: "#8250df", player: "#1a7f37", neutral: "#6e7781",
    others: ["#e16f24", "#0a7f86", "#a0457a", "#7d4e00", "#5a32a3", "#2f6f3e"],
  };
  const MARKS = { DIVERGE: "#8250df", DESTROYED: "#24292f", TARGET: "#cf222e", ARRIVE: "#1a7f37", STEP: "#0969da", FX: "#e16f24" };
  const AU = 149_597_870_700;
  const SHOT_MS = 4000;
  const FLASH_MS = 3000;
  const DIVERGE_MS = 10_000;
  const LIVE_IDLE_MS = 30_000;

  // The token arrives in the fragment once, then lives in this tab only.
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token") || sessionStorage.getItem("e2eViewerToken") || "";
  if (params.get("token")) sessionStorage.setItem("e2eViewerToken", token);

  const state = {
    runID: params.get("run") || null,
    runs: [],
    generation: 0,
    events: [],
    positions: [],
    bytes: 0,
    result: null,
    ended: false,
    mtimeMs: 0,
    nowMs: 0,
    t0: null,
    tEnd: null,
    at: null,
    playing: false,
    loading: false,
    current: -1,
    palette: new Map(),
    destroyedAt: new Map(),
    colourRules: [],
  };

  // ---------- text ----------

  function distance(meters) {
    if (meters === null || meters === undefined || !Number.isFinite(Number(meters))) return "?";
    const m = Number(meters);
    if (m < 10_000) return `${Math.round(m).toLocaleString("en-US")} m`;
    if (m < 0.1 * AU) return `${Math.round(m / 1000).toLocaleString("en-US")} km`;
    return `${(m / AU).toFixed(1)} AU`;
  }

  function offset(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    return `t+${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }

  function group(event) {
    const members = Array.isArray(event.members) ? event.members : [];
    const first = members[0] || {};
    const count = event.count || members.length;
    return `${first.label || event.who || "?"}${count > 1 ? ` x${count}` : ""}`;
  }

  function summary(e) {
    switch (e.kind) {
      case "ARRIVE": return `${group(e)} ${e.warpIn ? "warp-in " : ""}${distance(e.distanceMeters)} from self${e.flightID ? `  ${e.flightID}` : ""}`;
      case "LEAVE": return `${group(e)} ${e.warped ? "warped off" : "left grid"}${e.flightID ? `  ${e.flightID}` : ""}`;
      case "PRESENT": return `${group(e)} at ${distance(e.distanceMeters)}`;
      case "MODE": return `${e.label} ${e.from || "-"} -> ${e.to || "-"}${e.targetLabel ? ` ${e.targetLabel}` : ""}`;
      case "TARGET": return `${e.sourceLabel} -> ${e.targetLabel} ${e.locked ? "locked" : "unlocked"}`;
      case "DAMAGE": return `${e.label} ${e.layer} ${e.fromPct} -> ${e.toPct}`;
      case "DESTROYED": return `${e.label}${e.typeName && e.typeName !== e.label ? ` (${e.typeName})` : ""} destroyed` +
        `${e.who ? ` [${e.who}]` : ""}`;
      case "KILLMAIL": return `killmail ${e.killID} ${e.label || ""}`;
      case "DIVERGE": return `${e.status || ""} ${e.reason || ""} ${e.label || e.itemID || ""}` +
        `${e.errorMeters ? ` off by ${distance(e.errorMeters)}` : ""}` +
        `${e.serverMode ? ` server ${e.serverMode}` : ""}${e.clientMode ? ` client ${e.clientMode}` : ""}`;
      case "FX": return `${e.label || e.itemID} ${e.guid || ""}${e.targetLabel ? ` -> ${e.targetLabel}` : ""}`;
      case "CLIENT": return `${e.op || ""} ${e.label || ""}${e.mode ? ` ${e.mode}` : ""}${e.error ? ` ${e.error}` : ""}`;
      case "STEP": return `${e.phase === "during" ? "during: " : ""}${e.ok ? "" : "FAILED "}${e.step}${e.text ? `: ${e.text}` : ""}`;
      case "STOP": return e.reason === "until" ? `stop condition met: ${e.condition}` : `stopped: ${e.reason}`;
      case "GRID": return `${e.systemName || e.systemID}${e.self && e.self.typeName ? `, self in a ${e.self.typeName}` : ""}`;
      case "SYSTEM": return `self now in ${e.toSystemName || e.toSystemID}`;
      case "MOVED": return `self moved ${distance(e.distanceMeters)} to a new grid`;
      case "DOCKED": return "self docked";
      case "LOG": return String(e.text || "");
      case "START": return "watch started";
      case "END": return `watch ended: ${e.reason}`;
      // A plugin's kind: the plugin's own text, sent with the timeline.
      default: return e.summary_ || JSON.stringify(e).slice(0, 200);
    }
  }

  function lineText(e) {
    const t = state.t0 === null ? 0 : (Number(e.atMs) || state.t0) - state.t0;
    return `${offset(t)}  ${String(e.kind).padEnd(9)} ${summary(e)}`.slice(0, 260);
  }

  // ---------- data ----------

  function message(text) {
    $("message").textContent = text || "";
  }

  async function api(route) {
    const response = await fetch(route, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  function verdict(result) {
    if (!result) return null;
    if (result.exitCode === 2) return "did not complete";
    return result.passed ? "passed" : "failed";
  }

  async function loadRuns() {
    const body = await api("/viewer/runs");
    state.runs = body.runs || [];
    const select = $("run");
    const chosen = state.runID;
    select.textContent = "";
    for (const run of state.runs) {
      const option = document.createElement("option");
      option.value = run.runID;
      const v = verdict(run.result);
      option.textContent = `${run.runID}${v ? `  (${v})` : ""}`;
      select.append(option);
    }
    if (chosen && !state.runs.some((run) => run.runID === chosen)) {
      const option = document.createElement("option");
      option.value = chosen;
      option.textContent = chosen;
      select.prepend(option);
    }
    if (chosen) select.value = chosen;
  }

  function live() {
    return !state.result && !state.ended && state.nowMs - state.mtimeMs < LIVE_IDLE_MS;
  }

  async function openRun(runID) {
    state.generation += 1;
    Object.assign(state, { runID, events: [], positions: [], bytes: 0, result: null, ended: false, mtimeMs: 0, nowMs: 0,
      t0: null, tEnd: null, at: null, playing: false, current: -1, palette: new Map(), destroyedAt: new Map() });
    history.replaceState(null, "", `#run=${encodeURIComponent(runID)}`);
    $("events").textContent = "";
    $("diverges").textContent = "";
    $("play").textContent = "Play";
    await pull();
    // A finished run starts at its beginning, or at #t=<seconds>; a live one at its newest sample.
    const startAt = Number(params.get("t"));
    if (state.t0 !== null && Number.isFinite(startAt) && startAt > 0 && runID === params.get("run")) {
      $("follow").checked = false;
      state.at = Math.min(state.tEnd, state.t0 + startAt * 1000);
    } else if (!live()) {
      state.at = state.t0;
    }
    render();
  }

  async function pull() {
    if (state.loading || !state.runID) return;
    state.loading = true;
    const generation = state.generation;
    let added = 0;
    try {
      for (;;) {
        const body = await api(`/viewer/timeline?run=${encodeURIComponent(state.runID)}&from=${state.bytes}`);
        if (generation !== state.generation) return;
        added += ingest(body.text, body.summaries);
        state.bytes = body.next;
        state.result = body.result;
        state.mtimeMs = body.mtimeMs;
        state.nowMs = body.nowMs;
        if (body.next >= body.size || !body.text) break;
      }
      message("");
    } catch (error) {
      message(error.message);
    } finally {
      state.loading = false;
    }
    if (added) drawMarks();
    const following = $("follow").checked && live();
    if (state.at === null || following) state.at = state.tEnd;
    updateStatus();
    render();
  }

  function ingest(text, summaries) {
    let added = 0;
    const list = $("events");
    const diverges = $("diverges");
    const texts = new Map(Array.isArray(summaries) ? summaries : []);
    const lines = String(text || "").split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      if (texts.has(lineIndex)) event.summary_ = texts.get(lineIndex);
      const atMs = Number(event.atMs);
      if (Number.isFinite(atMs)) {
        if (state.t0 === null || atMs < state.t0) state.t0 = atMs;
        if (state.tEnd === null || atMs > state.tEnd) state.tEnd = atMs;
      }
      if (event.kind === "POS") {
        state.positions.push(event);
        continue;
      }
      if (event.kind === "END" && event.source !== "runner") state.ended = true;
      if (event.kind === "DESTROYED" && !state.destroyedAt.has(Number(event.itemID))) state.destroyedAt.set(Number(event.itemID), atMs);
      const index = state.events.length;
      state.events.push(event);
      added += 1;
      const item = document.createElement("li");
      item.textContent = lineText(event);
      item.className = `k-${event.kind}${event.kind === "STEP" && !event.ok ? " fail" : ""}`;
      item.dataset.index = String(index);
      item.hidden = !visible(event);
      list.append(item);
      if (event.kind === "DIVERGE") {
        const row = document.createElement("li");
        row.textContent = lineText(event);
        row.dataset.index = String(index);
        diverges.append(row);
      }
    }
    // The order lines were written in is close to, but not exactly, time order.
    state.positions.sort((a, b) => a.atMs - b.atMs);
    $("diverge-count").textContent = `(${diverges.childElementCount})`;
    return added;
  }

  // ---------- filters ----------

  let grep = null;
  function visible(event) {
    if (!$("show-client").checked && (event.kind === "CLIENT" || event.kind === "FX")) return false;
    if (!$("show-log").checked && event.kind === "LOG") return false;
    if (event.kind === "START" || event.kind === "END") return false;
    return !grep || grep.test(`${event.kind} ${summary(event)}`);
  }

  function refilter() {
    const text = $("grep").value.trim();
    try {
      grep = text ? new RegExp(text, "i") : null;
      message("");
    } catch (error) {
      message(`filter: ${error.message}`);
      return;
    }
    for (const item of $("events").children) item.hidden = !visible(state.events[Number(item.dataset.index)]);
    state.current = -1;
    render();
  }

  // ---------- status and track ----------

  function updateStatus() {
    const badge = $("status");
    const v = verdict(state.result);
    badge.className = "badge";
    if (v) {
      badge.textContent = `finished: ${v}`;
      badge.classList.add(v === "passed" ? "passed" : "failed");
    } else if (live()) {
      badge.textContent = "live";
      badge.classList.add("live");
    } else {
      badge.textContent = state.ended ? "finished" : "stopped";
    }
    const span = state.t0 === null ? 0 : state.tEnd - state.t0;
    const scrub = $("scrub");
    scrub.max = String(Math.max(0, span));
  }

  function drawMarks() {
    const svg = $("marks");
    svg.textContent = "";
    const span = state.t0 === null ? 0 : state.tEnd - state.t0;
    if (!span) return;
    for (const event of state.events) {
      const colour = MARKS[event.kind];
      if (!colour || (event.kind === "TARGET" && event.targetLabel !== "self") || (event.kind === "FX" && event.label !== "self")) continue;
      const x = ((event.atMs - state.t0) / span) * 1000;
      const tick = el("rect", { x: x.toFixed(1), y: event.kind === "DIVERGE" ? 0 : 4, width: event.kind === "DIVERGE" ? 3 : 2,
        height: event.kind === "DIVERGE" ? 14 : 10, fill: colour });
      tick.append(title(lineText(event)));
      svg.append(tick);
    }
  }

  // ---------- the map ----------

  function el(name, attributes = {}) {
    const node = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function title(text) {
    const node = el("title");
    node.textContent = text;
    return node;
  }

  // A plugin's data on a POS ball, at ball.ext.<plugin>; balls written before
  // the watch wrote ext carry it flat.
  function ballData(ball, plugin) {
    return (ball.ext && ball.ext[plugin]) || ball;
  }

  function colourFor(ball) {
    if (ball.who === "self") return COLOURS.self;
    if (ball.who === "concord") return COLOURS.concord;
    if (ball.who === "drifter") return COLOURS.drifter;
    if (ball.who === "player") return COLOURS.player;
    const rule = state.colourRules.find((entry) => Object.entries(entry.match || {})
      .every(([field, value]) => String(ballData(ball, entry.plugin)[field]) === String(value)));
    if (rule) return rule.colour;
    if (!ball.who) return COLOURS.neutral;
    const key = ball.flightID || ball.family || (ball.corp ? `corp:${ball.corp}` : `name:${String(ball.label || "").split(" ")[0]}`);
    if (!state.palette.has(key)) state.palette.set(key, COLOURS.others[state.palette.size % COLOURS.others.length]);
    return state.palette.get(key);
  }

  function niceLength(target) {
    if (!(target > 0)) return 1000;
    const power = 10 ** Math.floor(Math.log10(target));
    for (const step of [5, 2, 1]) if (step * power <= target) return step * power;
    return power;
  }

  // The newest sample at or before `at`, moved toward the next one so a
  // replay glides instead of jumping every sample.
  function frameAt(at) {
    const list = state.positions;
    if (!list.length || at === null) return null;
    let low = 0;
    let high = list.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].atMs <= at) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found < 0) return list[0].atMs - at <= 15_000 ? { pos: list[0], balls: list[0].balls || [] } : null;
    const a = list[found];
    const b = list[found + 1];
    if (!b || b.systemID !== a.systemID || b.atMs - a.atMs > 20_000 || at <= a.atMs) return { pos: a, balls: a.balls || [] };
    const f = (at - a.atMs) / (b.atMs - a.atMs);
    const next = new Map((b.balls || []).map((ball) => [ball.id, ball]));
    const balls = (a.balls || []).map((ball) => {
      const to = next.get(ball.id);
      if (!to) return ball;
      return { ...ball, x: ball.x + (to.x - ball.x) * f, y: ball.y + (to.y - ball.y) * f, z: ball.z + (to.z - ball.z) * f };
    });
    return { pos: a, balls };
  }

  function recent(kind, at, windowMs, test = () => true) {
    const out = [];
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const event = state.events[index];
      if (event.atMs > at) continue;
      if (at - event.atMs > windowMs) {
        if (event.atMs < at - 60_000) break;
        continue;
      }
      if (event.kind === kind && test(event)) out.push(event);
    }
    return out;
  }

  function renderMap() {
    const svg = $("map");
    svg.textContent = "";
    const frame = frameAt(state.at);
    const foot = $("map-foot");
    const ballList = $("balls");
    ballList.textContent = "";
    if (!frame) {
      const text = el("text", { x: 20, y: 40 });
      text.textContent = state.positions.length ? "no position sample near this time" :
        "no positions in this run: watch with --positions, or use e2e run";
      svg.append(text);
      foot.textContent = "";
      $("where").textContent = "";
      $("ball-count").textContent = "";
      return;
    }
    const { pos, balls } = frame;
    const byID = new Map(balls.map((ball) => [ball.id, ball]));
    const self = byID.get(pos.selfID) || null;
    const centre = self || balls[0] || { x: 0, y: 0, z: 0 };
    const planar = (ball) => Math.hypot(ball.x - centre.x, ball.z - centre.z);
    const fromSelf = (ball) => Math.hypot(ball.x - centre.x, (ball.y || 0) - (centre.y || 0), ball.z - centre.z);
    const tracked = balls.filter((ball) => TRACKED.has(ball.kind));
    const zoom = $("zoom").value;
    let half = Number(zoom);
    if (!(half > 0)) {
      const near = tracked.filter((ball) => planar(ball) <= 300_000).reduce((max, ball) => Math.max(max, planar(ball)), 0);
      half = Math.max(5000, 1.15 * near);
    }
    const scale = (PLOT / 2) / half;
    const project = (ball) => ({ x: PLOT / 2 + (ball.x - centre.x) * scale, y: PLOT / 2 - (ball.z - centre.z) * scale });
    const inside = (p) => p.x >= 0 && p.x <= PLOT && p.y >= 0 && p.y <= PLOT;
    const colour = new Map(balls.map((ball) => [ball.id, colourFor(ball)]));

    const bar = niceLength((2 * half) / 5);
    for (let ring = 1; ring * bar <= half * 1.45 && ring <= 6; ring += 1) {
      svg.append(el("circle", { cx: PLOT / 2, cy: PLOT / 2, r: (ring * bar * scale).toFixed(1), fill: "none",
        stroke: "#d8dee4", "stroke-dasharray": "3 4" }));
    }
    for (const ball of balls) {
      const from = project(ball);
      const target = ball.target ? byID.get(ball.target) : null;
      if (target && MOVING.has(ball.mode)) {
        const to = project(target);
        svg.append(el("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: colour.get(ball.id),
          "stroke-opacity": 0.45, "stroke-dasharray": "5 4" }));
      }
      for (const lockID of ball.locks || []) {
        const locked = byID.get(lockID);
        if (!locked) continue;
        const to = project(locked);
        svg.append(el("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y,
          stroke: lockID === pos.selfID ? COLOURS.hostile : colour.get(ball.id), "stroke-width": 1.2, "stroke-opacity": 0.75 }));
      }
    }
    // Weapons and effects the client was told about (FX). A repeating module
    // sends one FX for all its cycles, so it is drawn while they last, the
    // shooter still locks the target and the target is alive.
    const shots = recent("FX", state.at, 30 * 60_000, (event) => {
      if (!event.itemID || !event.targetID) return false;
      const cycles = Number(event.repeat) > 1 ? Number(event.durationMs) * Number(event.repeat) : SHOT_MS;
      const destroyed = state.destroyedAt.get(Number(event.targetID));
      return state.at - event.atMs <= Math.max(SHOT_MS, cycles || 0) && !(destroyed && destroyed <= state.at);
    });
    for (const shot of shots) {
      const a = byID.get(Number(shot.itemID));
      const b = byID.get(Number(shot.targetID));
      if (!a || !b) continue;
      if (state.at - shot.atMs > SHOT_MS && Array.isArray(a.locks) && !a.locks.includes(b.id)) continue;
      const p = project(a);
      const q = project(b);
      const line = el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: "#e16f24", "stroke-width": 3, "stroke-opacity": 0.8 });
      line.append(title(lineText(shot)));
      svg.append(line);
    }
    const hit = new Set(recent("DAMAGE", state.at, FLASH_MS).map((event) => Number(event.itemID)));
    const diverged = new Map();
    for (const event of recent("DIVERGE", state.at, DIVERGE_MS, (e) => e.itemID)) {
      if (!diverged.has(Number(event.itemID))) diverged.set(Number(event.itemID), event);
    }
    const order = [...balls].sort((a, b) => planar(a) - planar(b));
    const labelAll = tracked.length <= 20;
    const edge = [];
    for (const ball of order) {
      const p = project(ball);
      if (!inside(p)) {
        edge.push({ ball, p });
        continue;
      }
      const c = colour.get(ball.id);
      const shape = shapeFor(ball, p.x, p.y, TRACKED.has(ball.kind) ? 6 : 5, c);
      shape.append(title(`${ball.label}${ball.type ? ` (${ball.type})` : ""}  ${distance(fromSelf(ball))}` +
        `${ball.mode ? `  ${ball.mode}` : ""}${ball.flightID ? `  ${ball.flightID}` : ""}  #${ball.id}`));
      svg.append(shape);
      if (hit.has(ball.id)) svg.append(el("circle", { cx: p.x, cy: p.y, r: 11, fill: "none", stroke: "#bc4c00", "stroke-width": 2 }));
      if (diverged.has(ball.id)) {
        svg.append(el("circle", { cx: p.x, cy: p.y, r: 15, fill: "none", stroke: MARKS.DIVERGE, "stroke-width": 2, "stroke-dasharray": "4 3" }));
        const tag = el("text", { x: p.x + 16, y: p.y + 14, fill: MARKS.DIVERGE });
        tag.textContent = `DIVERGE ${diverged.get(ball.id).reason}`;
        svg.append(tag);
      }
      if (TRACKED.has(ball.kind) ? (labelAll || ball.who === "self") : planar(ball) * scale < PLOT / 2) {
        const text = el("text", { x: p.x + 9, y: p.y - 7, fill: TRACKED.has(ball.kind) ? c : "#8c959f" });
        text.textContent = String(ball.label || "").slice(0, 28);
        svg.append(text);
      }
    }
    for (const { ball, p } of edge) {
      const dx = p.x - PLOT / 2;
      const dy = p.y - PLOT / 2;
      const t = Math.min((PLOT / 2 - 10) / Math.abs(dx || 1e-9), (PLOT / 2 - 10) / Math.abs(dy || 1e-9));
      const arrow = el("path", { d: "M0 -5L10 0L0 5Z", fill: TRACKED.has(ball.kind) ? colour.get(ball.id) : "#c4cad0",
        transform: `translate(${(PLOT / 2 + dx * t).toFixed(1)} ${(PLOT / 2 + dy * t).toFixed(1)}) rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)})` });
      arrow.append(title(`${ball.label} ${distance(fromSelf(ball))}`));
      svg.append(arrow);
    }
    const barPx = bar * scale;
    svg.append(el("path", { d: `M16 ${PLOT - 20}V${PLOT - 12}M16 ${PLOT - 16}H${(16 + barPx).toFixed(1)}M${(16 + barPx).toFixed(1)} ${PLOT - 20}V${PLOT - 12}`,
      stroke: "#24292f", "stroke-width": 2 }));
    const barText = el("text", { x: (22 + barPx).toFixed(1), y: PLOT - 12, "font-weight": "bold" });
    barText.textContent = distance(bar);
    svg.append(barText);

    for (const ball of order.filter((entry) => TRACKED.has(entry.kind)).slice(0, 60)) {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = colour.get(ball.id);
      item.append(swatch, `${(ball.who === "self" ? "self" : distance(fromSelf(ball))).padEnd(9)} ${(ball.mode || "-").padEnd(8)} ` +
        `${ball.label}${ball.type ? ` (${ball.type})` : ""}`);
      item.title = `#${ball.id}${ball.flightID ? ` ${ball.flightID}` : ""}`;
      ballList.append(item);
    }
    $("ball-count").textContent = `(${tracked.length})`;
    $("where").textContent = pos.systemName || (pos.systemID ? `system ${pos.systemID}` : "");
    foot.textContent = `Top-down: x right, z up (N = +z). Half-width ${distance(half)}, centred on ${self ? "self" : "the first ball"}. ` +
      `Positions from the sample at ${offset(pos.atMs - state.t0)}; ${balls.length} balls within ${distance(pos.rangeMeters)}` +
      `${pos.omitted ? `, ${pos.omitted} beyond` : ""}. Orange line: a weapon or effect fired; orange ring: damage; ` +
      "purple dashed ring: DIVERGE.";
  }

  function shapeFor(ball, x, y, r, colour) {
    if (ball.kind === "wreck") {
      return el("path", { d: `M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}`, stroke: colour, "stroke-width": 2 });
    }
    if (ball.kind === "drone" || ball.kind === "fighter") return el("circle", { cx: x, cy: y, r: r * 0.5, fill: colour });
    if (ball.kind === "container") return el("rect", { x: x - r * 0.6, y: y - r * 0.6, width: r * 1.2, height: r * 1.2, fill: colour });
    if (!TRACKED.has(ball.kind) || ball.kind === "structure") {
      return el("rect", { x: x - r, y: y - r, width: r * 2, height: r * 2, fill: "none", stroke: colour, "stroke-width": 1.5 });
    }
    if (ball.who === "self") {
      return el("path", { d: `M${x} ${y - r * 1.3}L${x + r * 1.3} ${y}L${x} ${y + r * 1.3}L${x - r * 1.3} ${y}Z`, fill: colour });
    }
    return el("path", { d: `M${x} ${y - r}L${x + r * 0.9} ${y + r * 0.75}L${x - r * 0.9} ${y + r * 0.75}Z`, fill: colour });
  }

  // ---------- events list ----------

  function renderEvents() {
    let current = -1;
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      if (state.events[index].atMs <= state.at && visible(state.events[index])) {
        current = index;
        break;
      }
    }
    if (current === state.current) return;
    state.current = current;
    for (const item of $("events").children) {
      const index = Number(item.dataset.index);
      item.classList.toggle("future", state.events[index].atMs > state.at);
      item.classList.toggle("current", index === current);
    }
    const node = $("events").querySelector(`li[data-index="${current}"]`);
    if (node) node.scrollIntoView({ block: "nearest" });
  }

  function render() {
    if (state.t0 !== null && state.at !== null) {
      $("scrub").value = String(state.at - state.t0);
      $("clock").textContent = offset(state.at - state.t0);
    }
    renderMap();
    renderEvents();
  }

  // ---------- controls ----------

  function seek(atMs, { pause = true } = {}) {
    if (state.t0 === null) return;
    state.at = Math.min(Math.max(atMs, state.t0), state.tEnd);
    if (pause) setPlaying(false);
    if (state.at < state.tEnd) $("follow").checked = false;
    render();
  }

  function setPlaying(on) {
    state.playing = on;
    $("play").textContent = on ? "Pause" : "Play";
    if (on) {
      if (state.at >= state.tEnd && !live()) state.at = state.t0;
      lastTick = performance.now();
      requestAnimationFrame(tick);
    }
  }

  let lastTick = 0;
  function tick(nowMs) {
    if (!state.playing) return;
    const dt = nowMs - lastTick;
    lastTick = nowMs;
    state.at = Math.min(state.tEnd, state.at + dt * Number($("speed").value));
    if (state.at >= state.tEnd && !live()) setPlaying(false);
    render();
    if (state.playing) requestAnimationFrame(tick);
  }

  function stepEvent(direction, kind = null) {
    const list = state.events.filter((event) => visible(event) || (kind && event.kind === kind))
      .filter((event) => !kind || event.kind === kind);
    const found = direction > 0
      ? list.find((event) => event.atMs > state.at + 1)
      : [...list].reverse().find((event) => event.atMs < state.at - 1);
    if (found) seek(found.atMs);
  }

  function wire() {
    $("run").addEventListener("change", () => openRun($("run").value));
    $("play").addEventListener("click", () => setPlaying(!state.playing));
    $("prev").addEventListener("click", () => stepEvent(-1));
    $("next").addEventListener("click", () => stepEvent(1));
    $("next-diverge").addEventListener("click", () => stepEvent(1, "DIVERGE"));
    $("scrub").addEventListener("input", () => seek(state.t0 + Number($("scrub").value), { pause: false }));
    $("zoom").addEventListener("change", render);
    $("follow").addEventListener("change", () => { if ($("follow").checked && live()) seek(state.tEnd, { pause: false }); });
    for (const id of ["show-client", "show-log"]) $(id).addEventListener("change", refilter);
    $("grep").addEventListener("input", refilter);
    const jump = (event) => {
      const item = event.target.closest("li[data-index]");
      if (item) seek(state.events[Number(item.dataset.index)].atMs);
    };
    $("events").addEventListener("click", jump);
    $("diverges").addEventListener("click", jump);
    document.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== "range" && event.target.type !== "checkbox") return;
      if (event.key === " ") {
        event.preventDefault();
        setPlaying(!state.playing);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepEvent(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepEvent(-1);
      }
    });
  }

  async function start() {
    wire();
    const zoom = params.get("zoom");
    if (zoom && [...$("zoom").options].some((option) => option.value === zoom)) $("zoom").value = zoom;
    if (!token) {
      message("no token: open the URL `e2e view` prints");
      return;
    }
    try {
      await loadRuns();
      state.colourRules = (await api("/viewer/config")).colours || [];
    } catch (error) {
      message(error.message);
      return;
    }
    if (!state.runID && state.runs.length) state.runID = state.runs[0].runID;
    if (!state.runID) {
      message("no runs with a timeline yet: `e2e run <scenario>` or `e2e watch --positions`");
      return;
    }
    $("run").value = state.runID;
    await openRun(state.runID);
    setInterval(() => { if (live()) pull(); }, 1000);
    setInterval(() => { loadRuns().catch(() => {}); }, 15_000);
  }

  start();
})();
