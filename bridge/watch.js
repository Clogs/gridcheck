"use strict";

// `gridcheck watch`, server side. Samples one character's grid every few seconds and
// reports only what changed. Plugins add to it through three hooks
// (plugins.js): annotate joins each row to the plugin's own state, onGrid
// reads each sample's rows and adds events of its own, and offGrid adds
// context from outside the grid, scanned less often and only while a watch
// runs. The watch times every hook and reports them in END.
//
// A row's annotations ride on the events about it: its plugins' data at
// ext.<plugin>, and the groupKey that groups balls arriving or leaving
// together.
//
//   createGridDiffer    grid sample -> ARRIVE, LEAVE, MODE, DECISION, TARGET, DAMAGE, ...
//   createGridWatch     runs the differ and the hooks on a timer and streams the events.

const { createDivergenceChecker } = require("./destiny");

const TRACKED_KINDS = new Set(["ship", "drone", "fighter", "wreck", "container", "structure"]);
// Differ events after which the grid is a new one; open divergences are dropped.
const NEW_GRID_KINDS = new Set(["SYSTEM", "MOVED", "DOCKED"]);
const LAYERS = ["shield", "armor", "hull"];
// A ship first seen in warp has not landed yet. Its ARRIVE waits for it to
// drop out of warp, so the distance printed is where it landed.
const WARP_IN_SETTLE_MS = 30_000;
// A killmail is written after the wreck appears, by a worker.
const KILLMAIL_WAIT_MS = 20_000;
const WRECK_MATCH_METERS = 20_000;
// A ship covers well under this in one sample outside warp.
const SELF_MOVED_METERS = 1_000_000;
// POS events (watch option `positions`): after any sample with an on-grid
// event, and at least this often while in space.
const POSITIONS = Object.freeze({ everyMs: 10_000, rangeMeters: 1_000_000, maxBalls: 150 });
// FILETIME of the Unix epoch, in 100 ns ticks.
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n;

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function safe(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function percent(ratio) {
  return ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))
    ? null
    : Math.round(Number(ratio) * 100);
}

// Quarter bands: 100, 75-99, 50-74, 25-49, 0-24. DAMAGE fires on a crossing.
function healthBand(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return null;
  const value = Number(ratio);
  return value >= 0.999 ? 4 : Math.max(0, Math.floor(value * 4));
}

function centreDistance(a, b) {
  if (!a || !b) return null;
  const dx = Number(b.x) - Number(a.x);
  const dy = Number(b.y) - Number(a.y);
  const dz = Number(b.z) - Number(a.z);
  const value = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Number.isFinite(value) ? value : null;
}

function filetimeToMs(value) {
  try {
    return Number((BigInt(String(value)) - FILETIME_EPOCH_OFFSET) / 10_000n);
  } catch (_error) {
    return 0;
  }
}


function labelOf(row) {
  if (!row) return null;
  if (row.isSelf) return "self";
  return row.name || row.typeName || `#${row.itemID}`;
}

function whoOf(row) {
  if (row.isSelf) return "self";
  if (row.isNpc) return row.npcEntityType || "npc";
  if (row.kind === "ship" && row.characterID) return "player";
  return null;
}

function snapshot(row) {
  return {
    itemID: row.itemID,
    kind: row.kind,
    label: labelOf(row),
    name: row.name || null,
    typeName: row.typeName || null,
    typeID: row.typeID || null,
    isSelf: row.isSelf === true,
    who: whoOf(row),
    corporationID: row.corporationID || null,
    characterID: row.characterID || null,
    mode: row.mode || null,
    targetEntityID: row.targetEntityID || null,
    decision: row.decision || null,
    position: row.position || null,
    distanceMeters: row.distanceMeters === undefined ? null : row.distanceMeters,
    pcts: {
      shield: percent(row.shieldRatio),
      armor: percent(row.armorRatio),
      hull: percent(row.hullRatio),
    },
    bands: {
      shield: healthBand(row.shieldRatio),
      armor: healthBand(row.armorRatio),
      hull: healthBand(row.hullRatio),
    },
    locks: new Set(Array.isArray(row.lockedTargetIDs) ? row.lockedTargetIDs : []),
    groupKey: row.groupKey || null,
    ext: row.ext ? { ...row.ext } : null,
    // A plugin's working data for its own onGrid hook; never on an event.
    hidden: row.hidden || null,
  };
}

function memberOf(entry) {
  return {
    itemID: entry.itemID,
    label: entry.label,
    typeName: entry.typeName,
    kind: entry.kind,
    who: entry.who,
    mode: entry.mode,
    distanceMeters: entry.distanceMeters,
  };
}

// A ball's group: its groupKey, or the ball alone.
function groupOf(entry) {
  return entry.groupKey || `item:${entry.itemID}`;
}

// Members of a group arriving or leaving in the same sample are one event.
function groupByKey(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = groupOf(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()];
}

function groupEvent(kind, entries, extra = {}) {
  const distances = entries.map((entry) => entry.distanceMeters).filter((value) => value !== null);
  const first = entries[0];
  return {
    kind,
    groupKey: first.groupKey,
    count: entries.length,
    who: first.who,
    distanceMeters: distances.length ? Math.min(...distances) : null,
    members: entries.map(memberOf),
    ext: first.ext,
    ...extra,
  };
}

// One compact POS event: where every ball near the ship is, for the tactical
// frames `gridcheck run` draws. Nearest first (readGrid sorts), capped, positions
// rounded to the metre; fields that are empty are left out.
function positionFrame(grid, { rangeMeters = POSITIONS.rangeMeters, maxBalls = POSITIONS.maxBalls } = {}) {
  const rows = Array.isArray(grid && grid.entities) ? grid.entities : [];
  const balls = [];
  let omitted = 0;
  for (const row of rows) {
    if (!row || !row.position) continue;
    const near = row.isSelf || (row.distanceMeters !== null && row.distanceMeters <= rangeMeters);
    if (!near || balls.length >= maxBalls) {
      omitted += 1;
      continue;
    }
    const ball = {
      id: row.itemID,
      kind: row.kind || null,
      label: labelOf(row),
      x: Math.round(Number(row.position.x) || 0),
      y: Math.round(Number(row.position.y) || 0),
      z: Math.round(Number(row.position.z) || 0),
    };
    const who = whoOf(row);
    if (who) ball.who = who;
    if (row.typeName && row.typeName !== ball.label) ball.type = row.typeName;
    if (row.mode) ball.mode = row.mode;
    if (row.targetEntityID) ball.target = row.targetEntityID;
    if (Array.isArray(row.lockedTargetIDs) && row.lockedTargetIDs.length) ball.locks = row.lockedTargetIDs;
    if (row.groupKey) ball.group = row.groupKey;
    // The few fields each plugin wants on a frame (annotate's `pos`), for its colours.
    if (row.posExt) ball.ext = row.posExt;
    if (row.corporationID) ball.corp = row.corporationID;
    if (Number(row.radius) > 0) ball.radius = Math.round(Number(row.radius));
    balls.push(ball);
  }
  return {
    kind: "POS",
    systemID: grid.solarSystemID || null,
    systemName: grid.systemName || null,
    selfID: toPositiveInt(grid.self && grid.self.itemID) || null,
    rangeMeters,
    balls,
    omitted,
  };
}

// gridHooks: one per plugin with an onGrid hook, for this watch:
//   { name, step(entries, ctx) -> [event] }
// entries is the sample's Map itemID -> entry (label, distanceMeters, ext,
// hidden, ...). A hook may replace an entry's ext with a copy, before the
// differ's own events are built from it; its events follow the differ's.
// ctx: { atMs, selfID, labelFor(itemID) }. `timed(name, fn)` times each call.
function createGridDiffer({ gridHooks = [], timed = (_name, fn) => fn() } = {}) {
  let previous = null;
  let selfID = 0;
  let systemID = 0;
  let docked = false;
  // group key -> { firstSeenAtMs, itemIDs }
  const pendingArrivals = new Map();

  function labelFor(itemID, current) {
    const id = toPositiveInt(itemID);
    if (!id) return null;
    if (id === selfID) return "self";
    const entry = (current && current.get(id)) || (previous && previous.get(id));
    return entry ? entry.label : `#${id}`;
  }

  function lockEvents(entry, targets, locked, current) {
    return [...targets].map((targetID) => ({
      kind: "TARGET",
      sourceID: entry.itemID,
      sourceLabel: entry.label,
      targetID,
      targetLabel: labelFor(targetID, current),
      locked,
      groupKey: entry.groupKey,
      ext: entry.ext,
    }));
  }

  function hookEvents(current, atMs, selfNow) {
    if (!gridHooks.length) return [];
    const ctx = {
      atMs,
      selfID: selfNow,
      labelFor: (itemID) => (toPositiveInt(itemID) === selfNow && selfNow ? "self" : labelFor(itemID, current)),
    };
    const events = [];
    for (const hook of gridHooks) {
      const answer = timed(hook.name, () => safe(() => hook.step(current, ctx), []));
      if (Array.isArray(answer)) events.push(...answer.filter((event) => event && event.kind));
    }
    return events;
  }

  function baseline(grid, current) {
    const events = [{
      kind: "GRID",
      systemID: grid.solarSystemID,
      systemName: grid.systemName,
      security: grid.security,
      self: grid.self ? { itemID: grid.self.itemID, typeName: grid.self.typeName, mode: grid.self.mode,
        protection: grid.self.protection } : null,
      tracked: current.size,
    }];
    const others = [...current.values()].filter((entry) => !entry.isSelf);
    for (const group of groupByKey(others)) events.push(groupEvent("PRESENT", group));
    for (const entry of current.values()) {
      const involvingSelf = entry.isSelf
        ? entry.locks
        : new Set([...entry.locks].filter((targetID) => targetID === selfID));
      events.push(...lockEvents(entry, involvingSelf, true, current));
    }
    return events;
  }

  function step(grid, atMs) {
    const events = [];
    if (!grid || !grid.inSpace) {
      if (!docked) {
        events.push({ kind: "DOCKED", systemID: grid && grid.solarSystemID, systemName: grid && grid.systemName,
          stationID: grid && (grid.stationID || grid.structureID) });
      }
      docked = true;
      previous = null;
      pendingArrivals.clear();
      return events;
    }
    docked = false;
    if (systemID && grid.solarSystemID !== systemID) {
      events.push({ kind: "SYSTEM", fromSystemID: systemID, toSystemID: grid.solarSystemID,
        toSystemName: grid.systemName, security: grid.security });
      previous = null;
      pendingArrivals.clear();
    }
    systemID = grid.solarSystemID;

    const rows = (Array.isArray(grid.entities) ? grid.entities : []).filter((row) => TRACKED_KINDS.has(row.kind));
    const current = new Map(rows.map((row) => [row.itemID, snapshot(row)]));
    const selfNow = toPositiveInt(grid.self && grid.self.itemID);
    const pluginEvents = hookEvents(current, atMs, selfNow);

    // Self jumped (warp, /tr to a celestial): this is a new grid, not a grid
    // everybody else left.
    if (previous && selfNow && selfNow === selfID) {
      const before = previous.get(selfID);
      const now = current.get(selfNow);
      const moved = before && now ? centreDistance(before.position, now.position) : null;
      if (moved !== null && moved > SELF_MOVED_METERS) {
        events.push({ kind: "MOVED", distanceMeters: moved, systemName: grid.systemName });
        previous = null;
        pendingArrivals.clear();
      }
    }

    if (!previous) {
      selfID = selfNow;
      previous = current;
      events.push(...baseline(grid, current), ...pluginEvents);
      return events;
    }

    if (selfNow !== selfID) {
      const before = previous.get(selfID);
      events.push({ kind: "SELF", fromItemID: selfID || null, fromTypeName: before ? before.typeName : null,
        toItemID: selfNow || null, toTypeName: grid.self ? grid.self.typeName : null });
    }
    const oldSelfID = selfID;
    selfID = selfNow;

    const arrived = [...current.values()].filter((entry) => !previous.has(entry.itemID) && !entry.isSelf);
    const departed = [...previous.values()].filter((entry) => !current.has(entry.itemID));
    const wrecks = arrived.filter((entry) => entry.kind === "wreck");
    const usedWrecks = new Set();
    const leaving = [];

    for (const gone of departed) {
      let wreck = null;
      if (gone.kind === "ship" || gone.kind === "structure") {
        let best = Infinity;
        for (const candidate of wrecks) {
          if (usedWrecks.has(candidate.itemID)) continue;
          const d = centreDistance(gone.position, candidate.position);
          if (d !== null && d <= WRECK_MATCH_METERS && d < best) {
            best = d;
            wreck = candidate;
          }
        }
      }
      if (wreck) {
        usedWrecks.add(wreck.itemID);
        events.push({
          kind: "DESTROYED",
          itemID: gone.itemID,
          label: gone.itemID === oldSelfID ? "self" : gone.label,
          typeName: gone.typeName,
          typeID: gone.typeID,
          corporationID: gone.corporationID,
          characterID: gone.characterID,
          self: gone.itemID === oldSelfID,
          who: gone.itemID === oldSelfID ? "self" : gone.who,
          wreckID: wreck.itemID,
          wreckLabel: wreck.label,
          distanceMeters: gone.distanceMeters,
          groupKey: gone.groupKey,
          ext: gone.ext,
        });
      } else if (gone.itemID !== oldSelfID) {
        leaving.push(gone);
      }
    }
    for (const group of groupByKey(leaving)) {
      const warped = group.every((entry) => entry.mode === "WARP");
      events.push(groupEvent("LEAVE", group, { warped }));
    }

    // Arrivals: landed now, or wait for the ball to drop out of warp.
    const landedNow = [];
    for (const entry of arrived) {
      if (usedWrecks.has(entry.itemID)) continue;
      if (entry.mode === "WARP") {
        const key = groupOf(entry);
        const pending = pendingArrivals.get(key) || { firstSeenAtMs: atMs, itemIDs: new Set() };
        pending.itemIDs.add(entry.itemID);
        pendingArrivals.set(key, pending);
      } else {
        landedNow.push(entry);
      }
    }
    for (const group of groupByKey(landedNow)) {
      events.push(groupEvent("ARRIVE", group, { firstSeenAtMs: atMs }));
      for (const entry of group) events.push(...lockEvents(entry, entry.locks, true, current));
    }
    const settling = new Set();
    for (const [key, pending] of pendingArrivals) {
      const members = [...pending.itemIDs].map((id) => current.get(id)).filter(Boolean);
      if (!members.length) {
        pendingArrivals.delete(key);
        continue;
      }
      const landed = members.every((entry) => entry.mode !== "WARP");
      if (landed || atMs - pending.firstSeenAtMs >= WARP_IN_SETTLE_MS) {
        pendingArrivals.delete(key);
        events.push(groupEvent("ARRIVE", members, { firstSeenAtMs: pending.firstSeenAtMs, warpIn: true,
          stillWarping: !landed }));
        for (const entry of members) events.push(...lockEvents(entry, entry.locks, true, current));
      }
      for (const entry of members) settling.add(entry.itemID);
    }

    for (const entry of current.values()) {
      const before = previous.get(entry.itemID);
      if (!before) continue;
      if (before.mode !== entry.mode && !settling.has(entry.itemID)) {
        events.push({
          kind: "MODE",
          itemID: entry.itemID,
          label: entry.label,
          from: before.mode,
          to: entry.mode,
          targetID: entry.targetEntityID,
          targetLabel: labelFor(entry.targetEntityID, current),
          distanceMeters: entry.distanceMeters,
          groupKey: entry.groupKey,
          ext: entry.ext,
        });
      }
      // The branch an NPC's last think took (the last-decision patch).
      if (entry.decision && before.decision !== entry.decision) {
        events.push({
          kind: "DECISION",
          itemID: entry.itemID,
          label: entry.label,
          from: before.decision,
          to: entry.decision,
          targetID: entry.targetEntityID,
          targetLabel: labelFor(entry.targetEntityID, current),
          groupKey: entry.groupKey,
          ext: entry.ext,
        });
      }
      if (entry.kind === "ship" || entry.kind === "structure") {
        for (const layer of LAYERS) {
          const from = before.bands[layer];
          const to = entry.bands[layer];
          // Down a band, or back to full (a repair or /heal). Regeneration
          // climbing through the bands is not news.
          if (from !== null && to !== null && (to < from || (to === 4 && from < 4)) &&
              before.pcts[layer] !== entry.pcts[layer]) {
            events.push({
              kind: "DAMAGE",
              itemID: entry.itemID,
              label: entry.label,
              layer,
              fromPct: before.pcts[layer],
              toPct: entry.pcts[layer],
              groupKey: entry.groupKey,
              ext: entry.ext,
            });
          }
        }
      }
      // A settling arrival's locks are printed with its ARRIVE.
      if (!settling.has(entry.itemID)) {
        const gained = new Set([...entry.locks].filter((id) => !before.locks.has(id)));
        // A lock lost because its target just died is part of the DESTROYED line.
        const lost = new Set([...before.locks].filter((id) => !entry.locks.has(id) && current.has(id)));
        events.push(...lockEvents(entry, gained, true, current));
        events.push(...lockEvents(entry, lost, false, current));
      }
    }
    events.push(...pluginEvents);

    previous = current;
    return events;
  }

  function selfEntry() {
    return previous && selfID ? previous.get(selfID) || null : null;
  }

  return {
    step,
    labelFor: (itemID) => labelFor(itemID, null),
    selfEntry,
  };
}


// Killmails are written after the wreck appears. Look for one naming this
// victim type in this system, written since the watch started.
function createKillmailFinder(killmails, sinceMs) {
  const used = new Set();
  return function findKillmail({ self, characterID, corporationID, typeID, systemID }) {
    if (!killmails) return null;
    const records = self
      ? safe(() => killmails.listKillmailsForCharacter(characterID, { limit: 10 })) || []
      : corporationID
        ? safe(() => killmails.listKillmailsForCorporation(corporationID, "losses", { limit: 10 })) || []
        : [];
    for (const record of records) {
      const killID = toPositiveInt(record && record.killID);
      if (!killID || used.has(killID)) continue;
      if (typeID && toPositiveInt(record.victimShipTypeID) !== toPositiveInt(typeID)) continue;
      if (systemID && toPositiveInt(record.solarSystemID) !== toPositiveInt(systemID)) continue;
      if (filetimeToMs(record.killTime) < sinceMs - 5_000) continue;
      used.add(killID);
      return killID;
    }
    return null;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LIMITS = Object.freeze({
  maxForSeconds: 3600,
  minEverySeconds: 0.5,
  maxEverySeconds: 60,
  maxConcurrent: 4,
});

// The client side of one watch: attaches the destiny tee to the watched
// session, prints what the client was sent (clientMode "all", or only its
// special effects with "fx") and compares the
// client's ball set with each grid sample (DIVERGE).
function createClientWatch({ tee, differ, describeType, clientMode, divergeMeters, emit }) {
  const checker = createDivergenceChecker({ positionMeters: divergeMeters });
  let state = null;
  let cursor = 0;
  let unavailable = false;
  let startCosts = null;

  const label = (id) => {
    if (!id) return null;
    const known = differ.labelFor(id);
    if (known && !known.startsWith("#")) return known;
    const ball = state && state.model.balls.get(String(id));
    const typeName = ball && ball.typeID && typeof describeType === "function"
      ? safe(() => describeType(ball.typeID)) : null;
    return typeName ? `${typeName} #${id}` : `#${id}`;
  };

  function decorate(event) {
    const out = { ...event, source: "client" };
    if (event.itemID) out.label = label(event.itemID);
    if (event.targetID) out.targetLabel = label(event.targetID);
    if (Array.isArray(event.balls)) out.balls = event.balls.map((ball) => ({ ...ball, label: label(ball.itemID) }));
    if (Array.isArray(event.itemIDs)) out.labels = event.itemIDs.map(label);
    return out;
  }

  function step(session, grid, atMs) {
    const attached = tee.attach(session);
    if (!attached.ok) {
      if (!unavailable) emit({ kind: "CLIENT", source: "client", op: "unavailable", error: attached.error });
      unavailable = true;
      return;
    }
    if (attached.state !== state) {
      state = attached.state;
      cursor = state.seq;
      startCosts = { ...state.costs };
      checker.reset();
      emit({ kind: "CLIENT", source: "client", op: "attached", newly: attached.attached, ...tee.describe(state) });
    }
    const drained = tee.drain(state, cursor);
    cursor = drained.lastSeq;
    if (drained.dropped) emit({ kind: "CLIENT", source: "client", op: "gap", dropped: drained.dropped });
    for (const event of drained.events) {
      if (clientMode === "all" || event.op === "decode-error" || (clientMode === "fx" && event.kind === "FX")) {
        emit(decorate(event));
      }
    }
    for (const event of checker.step(grid, state.model, atMs, (id) => ({ label: label(id) }))) {
      emit({ atMs, ...event });
    }
  }

  function costs() {
    if (!state || !startCosts) return null;
    const notifications = state.costs.notifications - startCosts.notifications;
    const msTotal = state.costs.msTotal - startCosts.msTotal;
    return {
      notifications,
      updates: state.costs.updates - startCosts.updates,
      decodeMsAvg: notifications ? Math.round((msTotal / notifications) * 1000) / 1000 : 0,
      decodeMsMaxSinceAttach: Math.round(state.costs.msMax * 1000) / 1000,
      teeErrors: state.costs.errors - startCosts.errors,
      decodeErrorsSinceAttach: state.model.decodeErrors,
      balls: state.model.balls.size,
    };
  }

  return { step, reset: () => checker.reset(), costs };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// A plugin's annotate answer { groupKey, ext, hidden, pos }: its data at
// row.ext[<plugin>], the first groupKey any plugin gives, data only its own
// onGrid hook reads at row.hidden[<plugin>], and the fields a tactical frame
// carries for it at row.posExt[<plugin>]. A /grid read keeps ext and groupKey.
function applyAnnotation(row, name, result, { watch = true } = {}) {
  if (!row.ext) row.ext = {};
  row.ext[name] = result.ext === undefined ? null : result.ext;
  if (result.groupKey && !row.groupKey) row.groupKey = String(result.groupKey);
  if (!watch) return;
  if (result.hidden !== undefined) (row.hidden = row.hidden || {})[name] = result.hidden;
  if (result.pos && typeof result.pos === "object") (row.posExt = row.posExt || {})[name] = result.pos;
}

// Runs the plugins' annotate hooks on one /grid row, outside a watch.
function annotateRow(hooks, row, entity, { nowMs, characterID }) {
  for (const hook of hooks) {
    if (!hook || typeof hook.annotate !== "function") continue;
    const result = safe(() => hook.annotate(entity, { row, nowMs, characterID }));
    if (result) applyAnnotation(row, hook.name, result, { watch: false });
  }
}

// Each plugin hook's cost: one entry per sample for annotate (all rows) and
// onGrid, one per scan for offGrid, so a plugin can't add whole-world cost unseen.
function createHookTimer() {
  const timings = new Map();
  function record(key, ms) {
    const entry = timings.get(key) || { runs: 0, msTotal: 0, msMax: 0 };
    entry.runs += 1;
    entry.msTotal += ms;
    entry.msMax = Math.max(entry.msMax, ms);
    timings.set(key, entry);
  }
  function report() {
    const out = {};
    for (const [key, entry] of timings) {
      out[key] = { runs: entry.runs, msAvg: round2(entry.msTotal / entry.runs), msMax: round2(entry.msMax) };
    }
    return out;
  }
  return { record, report };
}

function createGridWatch({
  findSession,
  readGrid,
  hooks = [],
  killmails = null,
  destinyTee = null,
  describeType = null,
  perf = null,
  now = Date.now,
  perfNow = () => Number(process.hrtime.bigint()) / 1e6,
  wait = sleep,
  maxConcurrent = LIMITS.maxConcurrent,
} = {}) {
  let active = 0;
  const annotators = hooks.filter((hook) => hook && typeof hook.annotate === "function");
  const offGridHooks = hooks.filter((hook) => hook && hook.offGrid && typeof hook.offGrid.watch === "function");
  const onGridHooks = hooks.filter((hook) => hook && hook.onGrid && typeof hook.onGrid.watch === "function");

  function busy() {
    return active >= maxConcurrent;
  }

  async function run(options, sink) {
    active += 1;
    const closers = [];
    try {
      return await runWatch(options, sink, closers);
    } finally {
      active -= 1;
      for (const close of closers) safe(close);
    }
  }

  async function runWatch({ characterID, forMs, everyMs, offGridEveryMs, clientMode = "all", divergeMeters = null,
    positions = false, perfEveryMs = 0 }, sink, closers = []) {
    const startedAtMs = now();
    let seq = 0;
    const emit = (event) => {
      const atMs = Number(event.atMs) || now();
      const { kind, ...rest } = event;
      sink.write({ seq: ++seq, t: atMs - startedAtMs, atMs, kind, ...rest });
    };
    const timer = createHookTimer();
    const gridHooks = [];
    for (const hook of onGridHooks) {
      const watcher = safe(() => hook.onGrid.watch({ characterID, startedAtMs }));
      if (watcher && typeof watcher.step === "function") gridHooks.push({ name: hook.name, step: watcher.step });
    }
    const differ = createGridDiffer({
      gridHooks,
      timed: (name, fn) => {
        const start = perfNow();
        try {
          return fn();
        } finally {
          timer.record(`${name}.onGrid`, perfNow() - start);
        }
      },
    });
    const scanners = [];
    for (const hook of offGridHooks) {
      const scanner = safe(() => hook.offGrid.watch({ characterID, startedAtMs }));
      if (scanner && typeof scanner.scan === "function") scanners.push({ name: hook.name, scanner });
    }
    const findKillmail = createKillmailFinder(killmails, startedAtMs);
    const pendingKillmails = [];
    const costs = { samples: 0, sampleMsTotal: 0, sampleMsMax: 0, offGridScans: 0, offGridMsTotal: 0,
      offGridMsMax: 0, offGridStats: {} };
    const annotateMs = annotators.map(() => 0);
    let sampleNowMs = 0;
    const annotate = (row, entity) => {
      if (entity && entity.lockedTargets instanceof Map) {
        row.lockedTargetIDs = [...entity.lockedTargets.keys()].map(Number).filter((id) => id > 0);
      }
      for (let index = 0; index < annotators.length; index += 1) {
        const hook = annotators[index];
        const start = perfNow();
        const result = safe(() => hook.annotate(entity, { row, nowMs: sampleNowMs, characterID }));
        annotateMs[index] += perfNow() - start;
        if (result) applyAnnotation(row, hook.name, result);
      }
    };
    let lastOffGridAtMs = -Infinity;
    let lastPositionsAtMs = -Infinity;
    let reason = "time";
    const client = destinyTee && !destinyTee.off && clientMode !== "off"
      ? createClientWatch({ tee: destinyTee, differ, describeType, clientMode, divergeMeters, emit })
      : null;

    // Tick figures from the runtime's own ring, a window every perfEveryMs, and
    // each profiler window as it ends (bridge/perf.js).
    const sampler = perf && perfEveryMs > 0 ? perf.createSampler() : null;
    if (sampler) closers.push(() => sampler.close());
    let lastPerfAtMs = now();
    const emitPerf = (atMs) => {
      for (const { id: _id, atMs: profileAtMs, ...profile } of sampler.profiles()) {
        emit({ kind: "PROFILE", atMs: profileAtMs, ...profile });
      }
      const ticks = sampler.window();
      if (ticks.ticks || ticks.missedTicks) emit({ kind: "PERF", atMs, ...ticks });
      lastPerfAtMs = atMs;
    };

    emit({ kind: "START", characterID, forMs, everyMs, offGridEveryMs, clientMode: client ? clientMode : "off",
      ...(destinyTee && destinyTee.off && clientMode !== "off" ? { clientOff: destinyTee.off } : {}),
      positions: positions === true,
      ...(sampler ? { perf: { everyMs: perfEveryMs, profiler: perf.profiler.enabled, everyTicks: perf.profiler.everyTicks } } : {}) });
    for (;;) {
      if (sink.closed()) { reason = "client-closed"; break; }
      const session = findSession(characterID);
      if (!session) { reason = "session-gone"; break; }
      const sampleStart = perfNow();
      const atMs = now();
      sampleNowMs = atMs;
      annotateMs.fill(0);
      const grid = readGrid(session, { annotate });
      annotators.forEach((hook, index) => timer.record(`${hook.name}.annotate`, annotateMs[index]));
      const gridEvents = differ.step(grid, atMs);
      for (const event of gridEvents) {
        emit({ atMs, ...event });
        if (event.kind === "DESTROYED") {
          pendingKillmails.push({ event, systemID: grid.solarSystemID, sinceAtMs: atMs });
        }
        if (client && NEW_GRID_KINDS.has(event.kind)) client.reset();
      }
      if (positions && grid.inSpace && (gridEvents.length || atMs - lastPositionsAtMs >= POSITIONS.everyMs)) {
        lastPositionsAtMs = atMs;
        emit({ atMs, ...positionFrame(grid) });
      }
      if (client) client.step(session, grid, atMs);
      for (let index = pendingKillmails.length - 1; index >= 0; index -= 1) {
        const pending = pendingKillmails[index];
        const killID = findKillmail({
          self: pending.event.self,
          characterID,
          corporationID: pending.event.corporationID,
          typeID: pending.event.typeID,
          systemID: pending.systemID,
        });
        if (killID) {
          emit({ kind: "KILLMAIL", killID, itemID: pending.event.itemID, label: pending.event.label,
            typeName: pending.event.typeName, groupKey: pending.event.groupKey, ext: pending.event.ext });
          pendingKillmails.splice(index, 1);
        } else if (atMs - pending.sinceAtMs > KILLMAIL_WAIT_MS) {
          pendingKillmails.splice(index, 1);
        }
      }
      const sampleMs = perfNow() - sampleStart;
      costs.samples += 1;
      costs.sampleMsTotal += sampleMs;
      costs.sampleMsMax = Math.max(costs.sampleMsMax, sampleMs);

      if (scanners.length && grid.inSpace && atMs - lastOffGridAtMs >= offGridEveryMs) {
        lastOffGridAtMs = atMs;
        const self = differ.selfEntry();
        const context = { nowMs: atMs, egoPosition: self ? self.position : null, labelFor: differ.labelFor };
        let scanMs = 0;
        for (const { name, scanner } of scanners) {
          const scanStart = perfNow();
          const answer = safe(() => scanner.scan(toPositiveInt(grid.solarSystemID), context));
          const ms = perfNow() - scanStart;
          scanMs += ms;
          timer.record(`${name}.offGrid`, ms);
          if (answer && answer.stats && typeof answer.stats === "object") Object.assign(costs.offGridStats, answer.stats);
          for (const event of (answer && Array.isArray(answer.events) ? answer.events : [])) emit(event);
        }
        costs.offGridScans += 1;
        costs.offGridMsTotal += scanMs;
        costs.offGridMsMax = Math.max(costs.offGridMsMax, scanMs);
      }

      if (sampler) {
        sampler.take();
        if (atMs - lastPerfAtMs >= perfEveryMs) emitPerf(atMs);
      }

      if (now() - startedAtMs >= forMs) break;
      await wait(Math.max(0, everyMs - (perfNow() - sampleStart)));
    }
    if (sampler) emitPerf(now());
    emit({
      kind: "END",
      reason,
      samples: costs.samples,
      events: seq,
      costs: {
        // A plugin's scan stats, e.g. how many records it walked. Core numbers win a name clash.
        ...costs.offGridStats,
        sampleMsAvg: costs.samples ? round2(costs.sampleMsTotal / costs.samples) : 0,
        sampleMsMax: round2(costs.sampleMsMax),
        offGridScans: costs.offGridScans,
        offGridMsAvg: costs.offGridScans ? round2(costs.offGridMsTotal / costs.offGridScans) : 0,
        offGridMsMax: round2(costs.offGridMsMax),
        hooks: timer.report(),
      },
      client: client ? client.costs() : null,
    });
    return { reason, events: seq };
  }

  return { run, busy };
}

module.exports = {
  LIMITS,
  POSITIONS,
  TRACKED_KINDS,
  annotateRow,
  createGridDiffer,
  createGridWatch,
  createHookTimer,
  createKillmailFinder,
  filetimeToMs,
  healthBand,
  positionFrame,
};
