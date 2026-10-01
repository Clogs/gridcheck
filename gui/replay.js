"use strict";

// The GUI's replay model: a run's timeline.jsonl read into events and position
// samples, and everything the Runs tab draws from them that isn't drawing: the
// text of each event, the grid at a moment, each ball's modes as spans for the
// trace view, hit points at a moment, and which divergences are open. No DOM
// here, so test/e2eGuiReplay.test.js loads it in Node. The page gets it as
// window.E2EReplay.

(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.E2EReplay = api;
})(typeof self !== "undefined" ? self : this, () => {
  const AU = 149_597_870_700;
  const LANE_KINDS = new Set(["ship", "drone", "fighter"]);
  const SWARM_KINDS = new Set(["drone", "fighter"]);
  const TRACKED = new Set(["ship", "drone", "fighter", "wreck", "container", "structure"]);
  const MOVING = new Set(["ORBIT", "FOLLOW", "APPROACH"]);
  // The lanes of the workbench's compact track, in this order, when present.
  const TRACK_KINDS = ["STEP", "ARRIVE", "TARGET", "MODE", "FX", "DAMAGE", "DESTROYED", "DIVERGE"];
  const HIDDEN_KINDS = new Set(["POS", "START", "END"]);

  // ---------- text ----------

  function distance(meters) {
    if (meters === null || meters === undefined || !Number.isFinite(Number(meters))) return "?";
    const m = Number(meters);
    if (m < 10_000) return `${Math.round(m).toLocaleString("en-US")} m`;
    if (m < 0.1 * AU) return `${Math.round(m / 1000).toLocaleString("en-US")} km`;
    return `${(m / AU).toFixed(1)} AU`;
  }

  const pad = (n, width = 2) => String(n).padStart(width, "0");

  function offset(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `t+${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }

  function offsetFine(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    return `${offset(value)}.${pad(value % 1000, 3)}`;
  }

  // "00:07" or "1:02:07", for tight columns.
  function clockShort(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const body = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
    return h ? `${h}:${body}` : body;
  }

  function seconds(ms) {
    const s = (Number(ms) || 0) / 1000;
    if (s < 60) return `${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${pad(Math.round(s % 60))} s`;
    return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} min`;
  }

  function group(event) {
    const members = Array.isArray(event.members) ? event.members : [];
    const first = members[0] || {};
    const count = event.count || members.length;
    return `${first.label || event.who || "?"}${count > 1 ? ` x${count}` : ""}`;
  }

  function summary(e) {
    switch (e.kind) {
      case "ARRIVE": return `${group(e)} ${e.warpIn ? "warp-in " : ""}${distance(e.distanceMeters)} from self${e.groupKey ? `  ${e.groupKey}` : ""}`;
      case "LEAVE": return `${group(e)} ${e.warped ? "warped off" : "left grid"}${e.groupKey ? `  ${e.groupKey}` : ""}`;
      case "PRESENT": return `${group(e)} at ${distance(e.distanceMeters)}`;
      case "MODE": return `${e.label} ${e.from || "-"} → ${e.to || "-"}${e.targetLabel ? ` ${e.targetLabel}` : ""}`;
      case "DECISION": return `${e.label} decided ${e.from || "-"} → ${e.to}${e.targetLabel ? ` ${e.targetLabel}` : ""}`;
      case "TARGET": return `${e.sourceLabel} → ${e.targetLabel} ${e.locked ? "locked" : "unlocked"}`;
      case "DAMAGE": return `${e.label}  ${e.layer} ${e.fromPct}% → ${e.toPct}%`;
      case "DESTROYED": return `${e.label}${e.typeName && e.typeName !== e.label ? ` (${e.typeName})` : ""} destroyed` +
        `${e.who ? ` [${e.who}]` : ""}`;
      case "KILLMAIL": return `killmail ${e.killID} ${e.label || ""}`;
      case "DIVERGE": return `${e.status || ""} ${e.reason || ""} ${e.label || e.itemID || ""}` +
        `${e.errorMeters ? ` off by ${distance(e.errorMeters)}` : ""}` +
        `${e.serverMode ? `  server ${e.serverMode}` : ""}${e.clientMode ? `  client ${e.clientMode}` : ""}`;
      case "FX": return `${e.label || e.itemID} ${String(e.guid || "").replace(/^effects\./, "")}${e.targetLabel ? ` → ${e.targetLabel}` : ""}`;
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

  // The colour family of a kind, as a CSS class.
  function kindClass(kind) {
    switch (kind) {
      case "STEP": case "STOP": return "k-step";
      case "ARRIVE": case "PRESENT": case "GRID": case "SYSTEM": return "k-arrive";
      case "TARGET": return "k-target";
      case "MODE": case "DECISION": case "LEAVE": case "MOVED": case "DOCKED": return "k-mode";
      case "FX": return "k-fx";
      case "DAMAGE": return "k-damage";
      case "DESTROYED": case "KILLMAIL": return "k-destroyed";
      case "DIVERGE": return "k-div";
      default: return "k-log";
    }
  }

  // A round step for an axis that shows about `count` ticks over `spanMs`.
  function niceStep(spanMs, count = 12) {
    const raw = Math.max(1, spanMs / Math.max(1, count));
    const steps = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
      1_800_000, 3_600_000];
    return steps.find((step) => step >= raw) || steps[steps.length - 1];
  }

  function axisLabel(ms, step) {
    if (step < 1000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 60_000 || step < 60_000 && ms < 120_000) return `${Math.round(ms / 1000)}s`;
    return clockShort(ms);
  }

  const idOf = (value) => (value === null || value === undefined || value === "" ? null : Number(value));

  // ---------- the model ----------

  function createModel() {
    const model = {
      events: [],
      positions: [],
      t0: null,
      tEnd: null,
      ended: false,
      selfID: null,
      version: 0,
      bySeq: new Map(),
      destroyedAt: new Map(),
      damageOf: new Map(),
      counts: new Map(),
      labels: new Map(),
    };
    let lanesCache = null;
    let positionsSorted = true;

    // Whole lines of a timeline; `summaries` is [lineIndex, text] for a
    // plugin's kinds. Returns the indices of the events it added.
    model.ingest = function ingest(text, summaries) {
      const added = [];
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
        if (!event || typeof event !== "object") continue;
        if (texts.has(lineIndex)) event.summary_ = texts.get(lineIndex);
        const atMs = Number(event.atMs);
        if (Number.isFinite(atMs)) {
          if (model.t0 === null || atMs < model.t0) model.t0 = atMs;
          if (model.tEnd === null || atMs > model.tEnd) model.tEnd = atMs;
        }
        if (event.kind === "POS") {
          const last = model.positions[model.positions.length - 1];
          if (last && last.atMs > atMs) positionsSorted = false;
          model.positions.push(event);
          if (event.selfID) model.selfID = Number(event.selfID);
          for (const ball of event.balls || []) if (ball && ball.label) model.labels.set(Number(ball.id), ball.label);
          continue;
        }
        if (event.kind === "END" && event.source !== "runner") model.ended = true;
        const index = model.events.length;
        model.events.push(event);
        if (Number.isFinite(Number(event.seq)) && event.source !== "runner") model.bySeq.set(Number(event.seq), index);
        if (event.kind === "DESTROYED" && !model.destroyedAt.has(Number(event.itemID))) model.destroyedAt.set(Number(event.itemID), atMs);
        if (event.kind === "DAMAGE") {
          const id = Number(event.itemID);
          if (!model.damageOf.has(id)) model.damageOf.set(id, []);
          model.damageOf.get(id).push(index);
        }
        if (!HIDDEN_KINDS.has(event.kind)) model.counts.set(event.kind, (model.counts.get(event.kind) || 0) + 1);
        added.push(index);
      }
      if (!positionsSorted) {
        model.positions.sort((a, b) => a.atMs - b.atMs);
        positionsSorted = true;
      }
      if (added.length || lines.length > 1) model.version += 1;
      return added;
    };

    model.label = (id) => {
      const n = idOf(id);
      if (n === null) return "";
      if (n === model.selfID) return "self";
      return model.labels.get(n) || String(id);
    };

    // A ref from result.json ({ seq, t }) as a time on this timeline.
    model.timeOf = function timeOf(ref, watchStartedAtMs) {
      if (!ref) return null;
      if (Number.isFinite(Number(ref.seq)) && model.bySeq.has(Number(ref.seq))) return model.events[model.bySeq.get(Number(ref.seq))].atMs;
      const t = Number(ref.t);
      if (!Number.isFinite(t)) return null;
      if (Number.isFinite(Number(watchStartedAtMs))) return Number(watchStartedAtMs) + t;
      return model.t0 === null ? null : model.t0 + t;
    };

    // The newest sample at or before `at`, moved toward the next one so a
    // replay glides; `velocity` is metres per second from the pair it sits in.
    model.frameAt = function frameAt(at) {
      const list = model.positions;
      if (!list.length || at === null || at === undefined) return null;
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
      if (found < 0) {
        return list[0].atMs - at <= 15_000 ? { pos: list[0], balls: list[0].balls || [], velocity: new Map() } : null;
      }
      const a = list[found];
      const b = list[found + 1];
      const paired = b && b.systemID === a.systemID && b.atMs - a.atMs <= 20_000;
      const prev = list[found - 1];
      const [from, to] = paired ? [a, b] : prev && prev.systemID === a.systemID && a.atMs - prev.atMs <= 20_000 ? [prev, a] : [null, null];
      const velocity = new Map();
      if (from && to && to.atMs > from.atMs) {
        const dt = (to.atMs - from.atMs) / 1000;
        const next = new Map((to.balls || []).map((ball) => [ball.id, ball]));
        for (const ball of from.balls || []) {
          const other = next.get(ball.id);
          if (!other) continue;
          const vx = (other.x - ball.x) / dt;
          const vz = (other.z - ball.z) / dt;
          const vy = ((other.y || 0) - (ball.y || 0)) / dt;
          velocity.set(ball.id, { vx, vz, speed: Math.hypot(vx, vy, vz) });
        }
      }
      if (!paired || at <= a.atMs) return { pos: a, balls: a.balls || [], velocity };
      const f = (at - a.atMs) / (b.atMs - a.atMs);
      const next = new Map((b.balls || []).map((ball) => [ball.id, ball]));
      const balls = (a.balls || []).map((ball) => {
        const to2 = next.get(ball.id);
        if (!to2) return ball;
        return { ...ball, x: ball.x + (to2.x - ball.x) * f, y: ball.y + (to2.y - ball.y) * f, z: ball.z + (to2.z - ball.z) * f };
      });
      return { pos: a, balls, velocity };
    };

    // The newest event at or before `at` that passes `test`, as an index.
    model.indexAt = function indexAt(at, test = () => true) {
      for (let index = model.events.length - 1; index >= 0; index -= 1) {
        if (model.events[index].atMs <= at && test(model.events[index])) return index;
      }
      return -1;
    };

    model.recent = function recent(kind, at, windowMs, test = () => true) {
      const out = [];
      for (let index = model.events.length - 1; index >= 0; index -= 1) {
        const event = model.events[index];
        if (event.atMs > at) continue;
        if (at - event.atMs > windowMs) {
          if (event.atMs < at - 60_000) break;
          continue;
        }
        if (event.kind === kind && test(event)) out.push(event);
      }
      return out;
    };

    // Each layer's percentage at `at`: the last DAMAGE's toPct before it, or
    // the first one's fromPct after it, or null when the run never says.
    model.hpAt = function hpAt(id, at) {
      const out = { shield: null, armor: null, hull: null };
      const indices = model.damageOf.get(Number(id)) || [];
      const seen = new Set();
      for (const index of indices) {
        const event = model.events[index];
        const layer = event.layer === "structure" ? "hull" : event.layer;
        if (event.atMs <= at) {
          out[layer] = Number(event.toPct);
          seen.add(layer);
        } else if (!seen.has(layer)) {
          out[layer] = Number(event.fromPct);
          seen.add(layer);
        }
      }
      return out;
    };

    // Per item, the newest DIVERGE at or before `at`: `open` holds those still
    // open (or a one-off within the last 3 s); `ahead` the next few.
    model.divergenceAt = function divergenceAt(at) {
      const latest = new Map();
      const ahead = [];
      for (const event of model.events) {
        if (event.kind !== "DIVERGE") continue;
        if (event.atMs <= at) latest.set(`${event.itemID}|${event.reason}`, event);
        else if (ahead.length < 4) ahead.push(event);
      }
      const open = [...latest.values()].filter((event) => event.status === "open" || (event.status === "once" && at - event.atMs <= 3000));
      return { open, ahead };
    };

    model.logNear = function logNear(at, windowMs = 2000, max = 8) {
      const rows = model.events.filter((event) => event.kind === "LOG" && Math.abs(event.atMs - at) <= windowMs);
      rows.sort((a, b) => Math.abs(a.atMs - at) - Math.abs(b.atMs - at));
      const kept = rows.slice(0, max).sort((a, b) => a.atMs - b.atMs);
      return { rows: kept, nearest: rows[0] || null };
    };

    // One lane per ship, and one per swarm of same-named drones or fighters,
    // with their modes as spans and their events as marks. Spans come from
    // the position samples' mode and target, refined by MODE events.
    model.lanes = function lanes({ maxLanes = 40 } = {}) {
      if (lanesCache && lanesCache.version === model.version && lanesCache.maxLanes === maxLanes) return lanesCache.value;
      const entities = new Map();
      const lastPosAt = model.positions.length ? model.positions[model.positions.length - 1].atMs : null;
      for (const pos of model.positions) {
        for (const ball of pos.balls || []) {
          if (!ball || !LANE_KINDS.has(ball.kind)) continue;
          const id = Number(ball.id);
          let entity = entities.get(id);
          if (!entity) {
            entity = { id, kind: ball.kind, label: ball.label || String(id), type: ball.type || null, who: ball.who || null,
              group: ball.group || null, firstAt: pos.atMs, lastAt: pos.atMs, changes: [], marks: [] };
            entities.set(id, entity);
          }
          entity.lastAt = pos.atMs;
          entity.changes.push({ at: pos.atMs, mode: ball.mode || null, target: idOf(ball.target) });
        }
      }
      for (let index = 0; index < model.events.length; index += 1) {
        const event = model.events[index];
        const on = (value) => {
          const id = value === "self" ? model.selfID : idOf(value);
          return id === null ? null : entities.get(id) || null;
        };
        let entity = null;
        let mark = event.kind;
        switch (event.kind) {
          case "MODE": {
            const target = on(event.itemID);
            if (target) target.changes.push({ at: event.atMs, mode: event.to || null, target: idOf(event.targetID) });
            break;
          }
          case "TARGET": entity = on(event.sourceID); if (!event.locked) mark = "UNTARGET"; break;
          case "FX": entity = on(event.itemID); break;
          case "DAMAGE": entity = on(event.itemID); break;
          case "DESTROYED": entity = on(event.itemID); break;
          case "DIVERGE": entity = on(event.itemID); break;
          case "DECISION": entity = on(event.itemID); break;
          default: break;
        }
        if (entity) entity.marks.push({ at: event.atMs, kind: mark, index });
      }

      // Names: duplicates numbered in the order they appeared.
      const byLabel = new Map();
      for (const entity of [...entities.values()].sort((a, b) => a.firstAt - b.firstAt)) {
        if (entity.id === model.selfID || SWARM_KINDS.has(entity.kind)) continue;
        if (!byLabel.has(entity.label)) byLabel.set(entity.label, []);
        byLabel.get(entity.label).push(entity);
      }
      const names = new Map();
      for (const [label, list] of byLabel) list.forEach((entity, i) => names.set(entity.id, list.length > 1 ? `${label} #${i + 1}` : label));
      const nameOf = (id) => (id === model.selfID ? "self" : names.get(id) || model.labels.get(id) || String(id));

      const endOf = (entity) => {
        const destroyed = model.destroyedAt.get(entity.id);
        if (Number.isFinite(destroyed)) return destroyed;
        return entity.lastAt === lastPosAt ? model.tEnd : entity.lastAt;
      };
      const spanText = (mode, target, swarm) => {
        const name = target !== null ? nameOf(target) : "";
        if (mode) return `${mode}${name && (MOVING.has(mode) || swarm) ? ` ${name}` : ""}`;
        if (swarm) return name ? `→ ${name}` : "idle";
        return name ? `→ ${name}` : "";
      };
      const spansOf = (changes, end, swarm) => {
        const sorted = [...changes].sort((a, b) => a.at - b.at);
        const spans = [];
        for (const change of sorted) {
          const key = `${change.mode}|${change.target}`;
          const open = spans[spans.length - 1];
          if (open && open.key === key) continue;
          if (open) open.end = change.at;
          spans.push({ key, start: change.at, end, mode: change.mode, target: change.target, text: spanText(change.mode, change.target, swarm) });
        }
        if (spans.length) spans[spans.length - 1].end = Math.max(spans[spans.length - 1].start, end);
        return spans.filter((span) => span.end > span.start || spans.length === 1);
      };

      const lanesOut = [];
      const swarms = new Map();
      for (const entity of entities.values()) {
        if (SWARM_KINDS.has(entity.kind)) {
          const key = `${entity.kind}|${entity.label}|${entity.who || ""}|${entity.group || ""}`;
          if (!swarms.has(key)) swarms.set(key, []);
          swarms.get(key).push(entity);
          continue;
        }
        const end = endOf(entity);
        lanesOut.push({
          id: String(entity.id), ids: [entity.id], kind: entity.kind, who: entity.who, self: entity.id === model.selfID,
          name: nameOf(entity.id), sub: entity.id === model.selfID ? `${entity.type || entity.kind} · you` : `${entity.type || entity.kind} · ${entity.id}`,
          start: entity.firstAt, end, destroyedAt: model.destroyedAt.get(entity.id) ?? null,
          spans: spansOf(entity.changes, end, false), marks: entity.marks,
        });
      }
      for (const members of swarms.values()) {
        const first = members[0];
        const end = Math.max(...members.map(endOf));
        // The swarm does what most of its members in space are doing.
        const times = [...new Set(members.flatMap((m) => m.changes.map((c) => c.at)))].sort((a, b) => a - b);
        const changes = [];
        for (const at of times) {
          const tally = new Map();
          for (const member of members) {
            if (at < member.firstAt || at > endOf(member)) continue;
            let current = null;
            for (const change of member.changes) if (change.at <= at && (!current || change.at >= current.at)) current = change;
            if (!current) continue;
            const key = `${current.mode}|${current.target}`;
            tally.set(key, { change: current, n: ((tally.get(key) || {}).n || 0) + 1 });
          }
          const best = [...tally.values()].sort((a, b) => b.n - a.n)[0];
          if (best) changes.push({ at, mode: best.change.mode, target: best.change.target });
        }
        lanesOut.push({
          id: `swarm:${first.kind}:${first.label}:${first.who || ""}`, ids: members.map((m) => m.id), kind: first.kind, who: first.who, self: false,
          name: `${first.label}${members.length > 1 ? ` × ${members.length}` : ""}`, sub: `${first.kind}s${members.length > 1 ? ", most of them" : ""}`,
          start: Math.min(...members.map((m) => m.firstAt)), end, destroyedAt: null,
          spans: spansOf(changes, end, true), marks: members.flatMap((m) => m.marks).sort((a, b) => a.at - b.at),
        });
      }
      const rank = (lane) => (lane.self ? 0 : SWARM_KINDS.has(lane.kind) ? 2 : 1);
      lanesOut.sort((a, b) => rank(a) - rank(b) || (b.marks.length > 0) - (a.marks.length > 0) || a.start - b.start);
      const value = { lanes: lanesOut.slice(0, maxLanes), hidden: Math.max(0, lanesOut.length - maxLanes), nameOf };
      lanesCache = { version: model.version, maxLanes, value };
      return value;
    };

    return model;
  }

  return {
    AU, TRACKED, MOVING, TRACK_KINDS, HIDDEN_KINDS,
    distance, offset, offsetFine, clockShort, seconds, summary, kindClass, niceStep, axisLabel, createModel,
  };
});
