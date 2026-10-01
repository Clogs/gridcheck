"use strict";

// What a real client would have received. The gateway drops DoDestinyUpdate
// for browser sessions (evejsWebGatewayRuntime.js sendNotification), so the
// watch only ever saw server state. For agent sessions only, the tee wraps the
// session's sendNotification, decodes each destiny update before the gateway
// drops it, and keeps the ball set a client would hold. The divergence
// checker compares that set with the server grid on each watch sample.
//
// Four parts, each testable alone:
//   decodeBallState     AddBalls2 / SetState binary state -> balls
//   decodeDestinyUpdate DoDestinyUpdate payload tuple -> [{ stamp, name, args }]
//   createClientModel   updates -> client ball set + CLIENT / FX events
//   createDestinyTee    session wrapper, per-session model and bounded event ring
// createDivergenceChecker compares a model with a grid sample -> DIVERGE events.
//
// The binary layout mirrors space/destiny/stream/ballEncoding.js and
// staticBallTail.js. test/agentBridgeDestiny.test.js round-trips every
// mode through the stock encoder, so a layout change there fails the test.

const MODE_NAMES = ["GOTO", "FOLLOW", "STOP", "WARP", "ORBIT", "MISSILE", "MUSHROOM", "BOID", "TROLL",
  "MINIBALL", "FIELD", "RIGID", "FORMATION"];
const MODE = Object.freeze(Object.fromEntries(MODE_NAMES.map((name, index) => [name, index])));
const FLAG = Object.freeze({ IS_FREE: 0x01, HAS_MINIBOXES: 0x20, HAS_MINIBALLS: 0x40, HAS_MINICAPSULES: 0x80 });
// Static non-rigid tail: mass, a byte, int64, two int32, formation byte.
const STATIC_HEADER_BYTES = 8 + 1 + 8 + 4 + 4 + 1;
const MINI_BALL_BYTES = 3 * 8 + 4;
const MINI_CAPSULE_BYTES = 6 * 8 + 4;
const MINI_BOX_BYTES = 12 * 8;

const LIMITS = Object.freeze({
  ringSize: 2048,
  maxSessions: 8,
  // The same effect from the same ship on the same target is printed once per window.
  fxRepeatMs: 30_000,
  packagedDepth: 2,
});

const DIVERGE_DEFAULTS = Object.freeze({
  positionMeters: 5_000,
  // A one-sided ball or a mode mismatch must last this many samples and this
  // long. One destiny tick of delivery lag is normal, not a divergence.
  persistSamples: 2,
  settleMs: 3_000,
  // A WarpTo the server never showed as a warp is assumed landed after this.
  warpGiveUpMs: 120_000,
});

// Balls the presence check covers on the server side: what moves or comes and
// goes. Celestials are static and missiles live for seconds.
const PRESENCE_KINDS = new Set(["ship", "drone", "fighter", "wreck", "container", "structure"]);
const MOVING_KINDS = new Set(["ship", "drone", "fighter"]);
// Faster than any ship flies outside warp.
const MAX_SUBWARP_MS = 15_000;
const LAYERS = ["shield", "armor", "hull"];

// --- marshal-shaped values --------------------------------------------------
// Payloads reach sendNotification as marshal-ready objects ({type:"real"},
// {type:"list"}, KeyVal objects, Buffers). A PackagedAction's inner updates
// come out of marshalDecodeExact as plain arrays, BigInts and Buffer names.

function num(value, fallback = NaN) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) return num(value.value, fallback);
  return fallback;
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.items)) return value.items;
  return [];
}

function text(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function dictGet(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  if (Array.isArray(value.entries)) {
    for (const entry of value.entries) {
      if (Array.isArray(entry) && text(entry[0]) === key) return entry[1];
    }
    return undefined;
  }
  if (value.args && typeof value.args === "object") return dictGet(value.args, key, depth + 1);
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  return undefined;
}

// Ball IDs are compared as decimal strings: NPC IDs can pass 2^53.
function idKey(value) {
  if (typeof value === "bigint") return value > 0n ? value.toString(10) : null;
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) return idKey(value.value);
  const numeric = num(value);
  return Number.isFinite(numeric) && numeric > 0 ? String(Math.trunc(numeric)) : null;
}

function vector(x, y, z) {
  const v = { x: num(x), y: num(y), z: num(z) };
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null;
}

function distance(a, b) {
  if (!a || !b) return null;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  const value = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Number.isFinite(value) ? value : null;
}

function percent(ratio) {
  return Number.isFinite(ratio) ? Math.round(ratio * 100) : null;
}

function healthBand(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return ratio >= 0.999 ? 4 : Math.max(0, Math.floor(ratio * 4));
}

// --- binary ball state --------------------------------------------------------

function createReader(buffer) {
  let offset = 0;
  const need = (bytes) => {
    if (offset + bytes > buffer.length) throw new RangeError(`ball state ends at ${buffer.length}, needed ${offset + bytes}`);
  };
  const take = (bytes, read) => {
    need(bytes);
    const value = read(offset);
    offset += bytes;
    return value;
  };
  return {
    u8: () => take(1, (at) => buffer.readUInt8(at)),
    u16: () => take(2, (at) => buffer.readUInt16LE(at)),
    i32: () => take(4, (at) => buffer.readInt32LE(at)),
    u32: () => take(4, (at) => buffer.readUInt32LE(at)),
    i64: () => take(8, (at) => buffer.readBigInt64LE(at)),
    f32: () => take(4, (at) => buffer.readFloatLE(at)),
    f64: () => take(8, (at) => buffer.readDoubleLE(at)),
    skip: (bytes) => take(bytes, () => undefined),
    vec: () => ({ x: take(8, (at) => buffer.readDoubleLE(at)), y: take(8, (at) => buffer.readDoubleLE(at)),
      z: take(8, (at) => buffer.readDoubleLE(at)) }),
    done: () => offset >= buffer.length,
    offset: () => offset,
  };
}

function readModeData(reader, mode, ball) {
  switch (mode) {
    case MODE.GOTO:
      ball.targetPoint = reader.vec();
      return;
    case MODE.FOLLOW:
    case MODE.ORBIT:
      ball.followID = idKey(reader.i64());
      ball.followRange = reader.f32();
      return;
    case MODE.FORMATION:
      ball.followID = idKey(reader.i64());
      ball.followRange = reader.f32();
      reader.i32();
      return;
    case MODE.MISSILE:
      ball.followID = idKey(reader.i64());
      ball.followRange = reader.f32();
      reader.i64();
      reader.i32();
      ball.targetPoint = reader.vec();
      return;
    case MODE.WARP:
      ball.targetPoint = reader.vec();
      ball.effectStamp = reader.i32();
      ball.totalDistance = reader.f64();
      ball.minimumRange = reader.f64();
      ball.warpFactor = Number(reader.i64());
      return;
    case MODE.MUSHROOM:
      reader.f32();
      reader.f64();
      reader.i32();
      reader.i64();
      return;
    case MODE.TROLL:
      reader.i32();
      return;
    case MODE.STOP:
    case MODE.FIELD:
      return;
    default:
      throw new RangeError(`free ball ${ball.itemID} has mode ${mode}, which has no known layout`);
  }
}

// Returns every ball it could read. A malformed record stops the walk: the
// balls before it stand, and `error` says where it stopped.
function decodeBallState(buffer) {
  const result = { packetType: null, stamp: null, balls: [], error: null };
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    result.error = "no ball state buffer";
    return result;
  }
  const reader = createReader(buffer);
  result.packetType = reader.u8();
  result.stamp = reader.u32();
  try {
    while (!reader.done()) {
      const ball = {
        itemID: idKey(reader.i64()),
        mode: null,
        modeName: null,
        radius: 0,
        position: null,
        flags: 0,
        isFree: false,
        velocity: null,
      };
      const mode = reader.u8();
      ball.mode = mode;
      ball.modeName = MODE_NAMES[mode] || `UNKNOWN_${mode}`;
      ball.radius = reader.f32();
      ball.position = reader.vec();
      ball.flags = reader.u8();
      ball.isFree = (ball.flags & FLAG.IS_FREE) !== 0;
      if (ball.isFree) {
        ball.mass = reader.f64();
        ball.cloak = reader.u8();
        reader.i64();
        ball.corporationID = reader.i32();
        ball.allianceID = reader.i32();
        ball.maxVelocity = reader.f32();
        ball.velocity = reader.vec();
        reader.f32();
        ball.speedFraction = reader.f32();
        reader.u8();
        readModeData(reader, mode, ball);
      } else {
        reader.skip(mode === MODE.RIGID ? 1 : STATIC_HEADER_BYTES);
        if (ball.flags & FLAG.HAS_MINIBALLS) reader.skip(reader.u16() * MINI_BALL_BYTES);
        if (ball.flags & FLAG.HAS_MINICAPSULES) reader.skip(reader.u16() * MINI_CAPSULE_BYTES);
        if (ball.flags & FLAG.HAS_MINIBOXES) reader.skip(reader.u16() * MINI_BOX_BYTES);
      }
      if (!ball.itemID) throw new RangeError(`ball at byte ${reader.offset()} has no positive itemID`);
      result.balls.push(ball);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

// --- DoDestinyUpdate payloads ------------------------------------------------

// payloadTuple is [list([stamp, [name, args]]...), waitForBubble, delayedTargetEvents?].
function decodeDestinyUpdate(payloadTuple, { decodePackaged = null } = {}) {
  const updates = [];
  const errors = [];
  const visit = (stamp, payload, depth) => {
    if (!Array.isArray(payload)) return;
    const name = text(payload[0]);
    if (!name) return;
    if (name === "PackagedAction") {
      if (depth >= LIMITS.packagedDepth || typeof decodePackaged !== "function") {
        errors.push("PackagedAction not decoded");
        return;
      }
      let inner;
      try {
        inner = decodePackaged(payload[1]);
      } catch (error) {
        errors.push(`PackagedAction: ${error.message}`);
        return;
      }
      for (const entry of list(inner)) {
        if (Array.isArray(entry)) visit(num(entry[0], stamp), entry[1], depth + 1);
      }
      return;
    }
    updates.push({ stamp, name, args: Array.isArray(payload[1]) ? payload[1] : list(payload[1]) });
  };
  const entries = Array.isArray(payloadTuple) ? list(payloadTuple[0]) : [];
  for (const entry of entries) {
    if (Array.isArray(entry)) visit(num(entry[0], 0), entry[1], 0);
  }
  return { updates, errors };
}

function slimIdentity(entry) {
  const slim = Array.isArray(entry) ? entry[0] : entry;
  const damage = Array.isArray(entry) ? entry[1] : undefined;
  return {
    itemID: idKey(dictGet(slim, "itemID")),
    typeID: Math.trunc(num(dictGet(slim, "typeID"), 0)) || null,
    damage,
  };
}

// [ [shield, tau, time] | null, armor, hull ]
function decodeDamageState(value) {
  const parts = list(value);
  if (!parts.length) return null;
  const shield = Array.isArray(parts[0]) || (parts[0] && parts[0].items) ? num(list(parts[0])[0]) : NaN;
  return { shield, armor: num(parts[1]), hull: num(parts[2]) };
}

// --- the client's ball set -------------------------------------------------------

const BALLPARK_SESSION_KEYS = new Set(["stationid", "stationid2", "structureid", "solarsystemid", "solarsystemid2",
  "locationid", "worldspaceid"]);

const MOVEMENT_MODES = {
  GotoPoint: "GOTO",
  GotoDirection: "GOTO",
  FollowBall: "FOLLOW",
  Orbit: "ORBIT",
  Stop: "STOP",
  WarpTo: "WARP",
  EntityWarpIn: "WARP",
};

function createClientModel({ now = Date.now } = {}) {
  const balls = new Map();
  // Updates that named a ball the client does not hold: id -> { op, firstAtMs, count }.
  const orphans = new Map();
  const fxSeen = new Map();
  const model = {
    balls,
    orphans,
    baseline: null,
    baselineSeq: 0,
    egoID: null,
    decodeErrors: 0,
    lastDecodeError: null,
  };

  function ballFromState(decoded, atMs, slim, source) {
    const ball = {
      id: decoded.itemID,
      typeID: slim ? slim.typeID : null,
      mode: decoded.modeName,
      isFree: decoded.isFree,
      radius: decoded.radius,
      position: decoded.position,
      velocity: decoded.velocity || { x: 0, y: 0, z: 0 },
      targetID: decoded.followID || null,
      addedAtMs: atMs,
      check: null,
      warp: null,
      health: slim && slim.damage !== undefined ? decodeDamageState(slim.damage) : null,
    };
    if (decoded.isFree && decoded.modeName !== "WARP") {
      ball.check = { position: decoded.position, velocity: ball.velocity, atMs, source };
    }
    if (decoded.modeName === "WARP" && decoded.targetPoint) {
      // The server encoded this ball in warp: it was warping when this left.
      ball.warp = { dest: decoded.targetPoint, minRange: Number(decoded.minimumRange) || 0, atMs,
        source, serverWasWarping: true };
    }
    return ball;
  }

  function decodeError(events, op, message, atMs) {
    model.decodeErrors += 1;
    model.lastDecodeError = `${op}: ${message}`;
    events.push({ kind: "CLIENT", op: "decode-error", update: op, error: message, atMs });
  }

  function setState(args, atMs, events) {
    const state = args[0];
    const decoded = decodeBallState(dictGet(state, "state"));
    const slims = new Map(list(dictGet(state, "slims")).map(slimIdentity).filter((s) => s.itemID).map((s) => [s.itemID, s]));
    const damage = new Map();
    for (const entry of list(dictGet(state, "damageState") && dictGet(state, "damageState").entries)) {
      if (Array.isArray(entry)) damage.set(idKey(entry[0]), entry[1]);
    }
    balls.clear();
    orphans.clear();
    for (const raw of decoded.balls) {
      const slim = slims.get(raw.itemID) || null;
      const ball = ballFromState(raw, atMs, slim, "SetState");
      if (!ball.health && damage.has(raw.itemID)) ball.health = decodeDamageState(damage.get(raw.itemID));
      balls.set(ball.id, ball);
    }
    model.egoID = idKey(dictGet(state, "ego"));
    model.baseline = { atMs, stamp: decoded.stamp };
    model.baselineSeq += 1;
    if (decoded.error) decodeError(events, "SetState", decoded.error, atMs);
    events.push({ kind: "CLIENT", op: "SetState", balls: balls.size, egoID: model.egoID, atMs });
  }

  function addBalls(args, atMs, events) {
    const added = [];
    for (const batch of list(args)) {
      if (!Array.isArray(batch)) continue;
      const decoded = decodeBallState(batch[0]);
      const slims = new Map(list(batch[1]).map(slimIdentity).filter((s) => s.itemID).map((s) => [s.itemID, s]));
      for (const raw of decoded.balls) {
        const ball = ballFromState(raw, atMs, slims.get(raw.itemID) || null, "AddBalls");
        balls.set(ball.id, ball);
        orphans.delete(ball.id);
        added.push({ itemID: ball.id, typeID: ball.typeID, mode: ball.mode });
      }
      if (decoded.error) decodeError(events, "AddBalls2", decoded.error, atMs);
    }
    if (added.length) events.push({ kind: "CLIENT", op: "AddBalls", count: added.length, balls: added, atMs });
  }

  function removeBalls(ids, op, atMs, events) {
    const removed = [];
    for (const id of ids) {
      if (id && balls.delete(id)) removed.push(id);
      if (id) orphans.delete(id);
    }
    if (removed.length) events.push({ kind: "CLIENT", op, count: removed.length, itemIDs: removed, atMs });
  }

  function orphan(id, op, atMs) {
    if (!model.baseline || !id || id === model.egoID) return;
    const known = orphans.get(id);
    if (known) known.count += 1;
    else orphans.set(id, { op, firstAtMs: atMs, count: 1 });
  }

  function movement(name, args, atMs, events) {
    const id = idKey(args[0]);
    const ball = id ? balls.get(id) : null;
    if (!ball) {
      orphan(id, name, atMs);
      return;
    }
    const mode = MOVEMENT_MODES[name];
    let targetID = null;
    if (name === "FollowBall" || name === "Orbit") targetID = idKey(args[1]);
    if (name === "WarpTo" || name === "EntityWarpIn") {
      const dest = vector(args[1], args[2], args[3]);
      ball.warp = dest
        ? { dest, minRange: name === "WarpTo" ? num(args[4], 0) || 0 : 0, atMs, source: name,
          serverWasWarping: name === "EntityWarpIn" }
        : null;
      ball.check = null;
    } else {
      ball.warp = null;
    }
    const changed = ball.mode !== mode || ball.targetID !== targetID;
    ball.mode = mode;
    ball.targetID = targetID;
    ball.serverSeenWarp = false;
    if (changed) {
      const event = { kind: "CLIENT", op: name, itemID: id, mode, atMs };
      if (targetID) event.targetID = targetID;
      if (name === "FollowBall" || name === "Orbit") event.rangeMeters = num(args[2], null);
      if (ball.warp) event.warpTo = ball.warp.dest;
      events.push(event);
    }
  }

  function damageChange(args, atMs, events) {
    const id = idKey(args[0]);
    const ball = id ? balls.get(id) : null;
    if (!ball) return;
    const next = decodeDamageState(args[1]);
    if (!next) return;
    const before = ball.health;
    ball.health = next;
    if (!before) return;
    for (const layer of LAYERS) {
      const from = healthBand(before[layer]);
      const to = healthBand(next[layer]);
      if (from === null || to === null) continue;
      if ((to < from || (to === 4 && from < 4)) && percent(before[layer]) !== percent(next[layer])) {
        events.push({ kind: "CLIENT", op: "Damage", itemID: id, layer, fromPct: percent(before[layer]),
          toPct: percent(next[layer]), atMs });
      }
    }
  }

  function specialFx(args, atMs, events) {
    if (num(args[7], 0) !== 1) return;
    const shipID = idKey(args[0]);
    const targetID = idKey(args[3]);
    const guid = text(args[5]) || "";
    const key = `${shipID}:${guid}:${targetID}`;
    const seen = fxSeen.get(key);
    if (seen && atMs - seen.atMs < LIMITS.fxRepeatMs) {
      seen.repeats += 1;
      return;
    }
    fxSeen.set(key, { atMs, repeats: 0 });
    if (fxSeen.size > 512) fxSeen.delete(fxSeen.keys().next().value);
    events.push({
      kind: "FX",
      itemID: shipID,
      guid,
      targetID,
      moduleID: idKey(args[1]),
      moduleTypeID: Math.trunc(num(args[2], 0)) || null,
      offensive: num(args[6], 0) === 1,
      durationMs: num(args[9], null),
      repeat: args[10] === null || args[10] === undefined ? null : num(args[10], null),
      knownBall: Boolean(shipID && balls.has(shipID)),
      repeatsBefore: seen ? seen.repeats : 0,
      atMs,
    });
  }

  function apply(updates, atMs = now()) {
    const events = [];
    for (const { name, args } of updates) {
      switch (name) {
        case "SetState":
          setState(args, atMs, events);
          break;
        case "AddBalls2":
          addBalls(args, atMs, events);
          break;
        case "AddBall": {
          const id = idKey(args[0]);
          if (!id) break;
          const position = vector(args[9], args[10], args[11]);
          const velocity = vector(args[12], args[13], args[14]) || { x: 0, y: 0, z: 0 };
          balls.set(id, { id, typeID: null, mode: "STOP", isFree: num(args[4], 0) === 1, radius: num(args[2], 0),
            position, velocity, targetID: null, addedAtMs: atMs, warp: null, health: null,
            check: position ? { position, velocity, atMs, source: "AddBall" } : null });
          orphans.delete(id);
          events.push({ kind: "CLIENT", op: "AddBalls", count: 1, balls: [{ itemID: id, typeID: null, mode: "STOP" }], atMs });
          break;
        }
        case "RemoveBalls":
          removeBalls(list(args[0]).map(idKey), "RemoveBalls", atMs, events);
          break;
        case "RemoveBall":
        case "RemoveGlobalBall":
          removeBalls([idKey(args[0])], "RemoveBalls", atMs, events);
          break;
        case "GotoPoint":
        case "GotoDirection":
        case "FollowBall":
        case "Orbit":
        case "Stop":
        case "WarpTo":
        case "EntityWarpIn":
          movement(name, args, atMs, events);
          break;
        case "SetBallPosition": {
          const id = idKey(args[0]);
          const ball = id ? balls.get(id) : null;
          const position = vector(args[1], args[2], args[3]);
          if (!ball) { orphan(id, name, atMs); break; }
          if (position) {
            ball.position = position;
            ball.check = { position, velocity: ball.velocity, atMs, source: "SetBallPosition" };
          }
          break;
        }
        case "SetBallVelocity": {
          const ball = balls.get(idKey(args[0]));
          const velocity = vector(args[1], args[2], args[3]);
          if (ball && velocity) {
            ball.velocity = velocity;
            if (ball.check && ball.check.atMs === atMs) ball.check.velocity = velocity;
          }
          break;
        }
        case "OnDamageStateChange":
          damageChange(args, atMs, events);
          break;
        case "OnSpecialFX":
          specialFx(args, atMs, events);
          break;
        case "TerminalPlayDestructionEffect":
          events.push({ kind: "CLIENT", op: "Destruction", itemID: idKey(args[0]), atMs });
          break;
        case "OnSlimItemChange": {
          const ball = balls.get(idKey(args[0]));
          const typeID = Math.trunc(num(dictGet(args[1], "typeID"), 0));
          if (ball && typeID > 0) ball.typeID = typeID;
          break;
        }
        default:
          break;
      }
    }
    return events;
  }

  // A client tears its ballpark down when it docks, undocks or changes system,
  // and waits for the next SetState. Ship changes in space keep the park.
  function sessionChange(changes, atMs = now()) {
    const keys = Object.keys(changes && typeof changes === "object" ? changes : {})
      .filter((key) => BALLPARK_SESSION_KEYS.has(key));
    if (!keys.length) return [];
    balls.clear();
    orphans.clear();
    model.baseline = null;
    model.clearedAtMs = atMs;
    return [{ kind: "CLIENT", op: "ballpark-cleared", keys, atMs }];
  }

  model.apply = apply;
  model.sessionChange = sessionChange;
  model.clearedAtMs = null;
  return model;
}

// --- the tee ------------------------------------------------------------------

// Browser gateway sessions only: clientIDs from 2,000,000,000 up and a duck
// socket that cannot write. A retail client's session is never wrapped.
function isGatewaySession(session) {
  return Boolean(
    session &&
    typeof session.sendNotification === "function" &&
    Number(session.clientID) >= 2_000_000_000 &&
    session.socket &&
    typeof session.socket.write !== "function",
  );
}

function createDestinyTee({
  decodePackaged = null,
  now = Date.now,
  perfNow = () => Number(process.hrtime.bigint()) / 1e6,
  ringSize = LIMITS.ringSize,
  maxSessions = LIMITS.maxSessions,
} = {}) {
  const states = new Map();

  function prune() {
    for (const [session, state] of states) {
      if ((session.socket && session.socket.destroyed) || session.sendNotification !== state.wrapper) {
        states.delete(session);
      }
    }
  }

  function capture(state, payloadTuple) {
    const started = perfNow();
    try {
      const atMs = now();
      const { updates, errors } = decodeDestinyUpdate(payloadTuple, { decodePackaged });
      const events = state.model.apply(updates, atMs);
      for (const error of errors) events.push({ kind: "CLIENT", op: "decode-error", update: "PackagedAction", error, atMs });
      state.costs.notifications += 1;
      state.costs.updates += updates.length;
      for (const event of events) {
        state.ring.push({ seq: ++state.seq, event });
      }
      if (state.ring.length > ringSize) {
        const excess = state.ring.length - ringSize;
        state.ring.splice(0, excess);
      }
    } catch (error) {
      state.costs.errors += 1;
      state.lastError = error && error.message ? error.message : String(error);
    } finally {
      const ms = perfNow() - started;
      state.costs.msTotal += ms;
      state.costs.msMax = Math.max(state.costs.msMax, ms);
    }
  }

  function attach(session) {
    if (!isGatewaySession(session)) {
      return { ok: false, error: "Only web gateway sessions can be teed." };
    }
    const existing = states.get(session);
    if (existing && session.sendNotification === existing.wrapper) return { ok: true, state: existing, attached: false };
    prune();
    if (states.size >= maxSessions) {
      return { ok: false, error: `${maxSessions} sessions are already teed.` };
    }
    const original = session.sendNotification;
    const state = {
      characterID: Number(session.characterID || session.charid) || null,
      attachedAtMs: now(),
      model: createClientModel({ now }),
      ring: [],
      seq: 0,
      costs: { notifications: 0, updates: 0, errors: 0, msTotal: 0, msMax: 0 },
      lastError: null,
      wrapper: null,
    };
    // The original's result goes back unchanged: michelleContract reads a
    // false return as a rejected delivery.
    state.wrapper = function agentBridgeDestinyTee(notifyType, ...rest) {
      if (notifyType === "DoDestinyUpdate") capture(state, rest[1]);
      return original.call(this, notifyType, ...rest);
    };
    session.sendNotification = state.wrapper;
    const originalSessionChange = session.sendSessionChange;
    if (typeof originalSessionChange === "function") {
      session.sendSessionChange = function agentBridgeSessionChangeTee(changes, ...rest) {
        try {
          for (const event of state.model.sessionChange(changes, now())) state.ring.push({ seq: ++state.seq, event });
        } catch (error) {
          state.costs.errors += 1;
          state.lastError = error && error.message ? error.message : String(error);
        }
        return originalSessionChange.call(this, changes, ...rest);
      };
    }
    states.set(session, state);
    return { ok: true, state, attached: true };
  }

  function drain(state, afterSeq) {
    const ring = state.ring;
    const firstSeq = ring.length ? ring[0].seq : state.seq + 1;
    const dropped = afterSeq < firstSeq - 1 ? firstSeq - 1 - afterSeq : 0;
    const events = ring.filter((entry) => entry.seq > afterSeq).map((entry) => entry.event);
    return { events, lastSeq: state.seq, dropped };
  }

  function describe(state) {
    const model = state.model;
    return {
      attachedAtMs: state.attachedAtMs,
      balls: model.balls.size,
      baselineAtMs: model.baseline ? model.baseline.atMs : null,
      egoID: model.egoID,
      notifications: state.costs.notifications,
      decodeErrors: model.decodeErrors + state.costs.errors,
      lastError: state.lastError || model.lastDecodeError,
    };
  }

  return { attach, drain, describe, isGatewaySession, size: () => states.size };
}

// --- divergence ---------------------------------------------------------------

function createDivergenceChecker(options = {}) {
  const settings = { ...DIVERGE_DEFAULTS, ...Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined && value !== null)) };
  // `${reason}:${id}` -> { firstAtMs, samples, open, details }
  const pending = new Map();
  let baselineSeq = -1;

  function reset() {
    pending.clear();
  }

  function step(grid, model, atMs, describeBall = () => ({})) {
    const events = [];
    if (!grid || !grid.inSpace || !model) return events;
    if (!model.baseline) {
      // In space, and the client threw its ballpark away and has had nothing since.
      if (model.clearedAtMs !== null && model.clearedAtMs !== undefined) {
        const key = "no-ballpark:self";
        const entry = pending.get(key) || { firstAtMs: model.clearedAtMs, samples: 0, open: false };
        entry.samples += 1;
        pending.set(key, entry);
        if (!entry.open && entry.samples >= settings.persistSamples && atMs - entry.firstAtMs >= settings.settleMs) {
          entry.open = true;
          events.push({ kind: "DIVERGE", source: "client", status: "open", reason: "no-ballpark", itemID: "self",
            label: "self", sinceMs: atMs - entry.firstAtMs, atMs: entry.firstAtMs });
        }
      }
      return events;
    }
    const waiting = pending.get("no-ballpark:self");
    if (waiting) {
      pending.delete("no-ballpark:self");
      if (waiting.open) {
        events.push({ kind: "DIVERGE", source: "client", status: "cleared", reason: "no-ballpark", itemID: "self",
          label: "self", durationMs: model.baseline.atMs - waiting.firstAtMs });
      }
    }
    if (model.baselineSeq !== baselineSeq) {
      baselineSeq = model.baselineSeq;
      pending.clear();
    }
    const rows = Array.isArray(grid.entities) ? grid.entities : [];
    const server = new Map(rows.map((row) => [idKey(row.itemID), row]));
    const seen = new Map();
    const flag = (reason, id, details) => seen.set(`${reason}:${id}`, { reason, id, details });
    const once = (reason, id, details) => events.push({ kind: "DIVERGE", source: "client", status: "once", reason,
      itemID: id, ...describeBall(id), ...details });

    for (const row of rows) {
      const id = idKey(row.itemID);
      if (id && PRESENCE_KINDS.has(row.kind) && !model.balls.has(id)) {
        flag("server-only", id, { serverMode: row.mode || null, distanceMeters: row.distanceMeters ?? null });
      }
    }
    for (const ball of model.balls.values()) {
      if (ball.isFree && !server.has(ball.id)) flag("client-only", ball.id, { clientMode: ball.mode });
    }

    for (const ball of model.balls.values()) {
      const row = server.get(ball.id);
      if (!row) continue;
      const serverMode = typeof row.mode === "string" ? row.mode.toUpperCase() : null;
      if (serverMode === "WARP") ball.serverSeenWarp = true;
      if (ball.mode === "WARP" && ball.warp && serverMode && serverMode !== "WARP") {
        const warp = ball.warp;
        if (ball.serverSeenWarp || warp.serverWasWarping) {
          const offBy = distance(row.position, warp.dest);
          const errorMeters = offBy === null ? null : Math.max(0, offBy - warp.minRange);
          if (errorMeters !== null && errorMeters > settings.positionMeters) {
            once("warp-landing", ball.id, { errorMeters: Math.round(errorMeters), serverMode, clientMode: "WARP",
              warpSource: warp.source, minRangeMeters: Math.round(warp.minRange) });
          }
          // A client drops out of warp by itself; nothing more is sent.
          ball.mode = "STOP";
          ball.warp = null;
          ball.position = row.position;
        } else if (atMs - warp.atMs > settings.warpGiveUpMs) {
          ball.mode = "STOP";
          ball.warp = null;
        }
      } else if (MOVING_KINDS.has(row.kind) && serverMode && ball.mode && ball.mode !== "WARP" && ball.mode !== serverMode) {
        flag("mode", ball.id, { serverMode, clientMode: ball.mode });
      }
      if (ball.check) {
        const check = ball.check;
        ball.check = null;
        // Missiles accelerate away from their launch velocity; a straight-line
        // guess says nothing about them.
        if (PRESENCE_KINDS.has(row.kind) && serverMode !== "WARP" && ball.mode !== "WARP") {
          const dt = Math.max(0, atMs - check.atMs) / 1000;
          // A velocity left over from warp would carry the guess thousands of km.
          const v = check.velocity && (distance(check.velocity, { x: 0, y: 0, z: 0 }) || 0) <= MAX_SUBWARP_MS
            ? check.velocity : { x: 0, y: 0, z: 0 };
          const predicted = { x: check.position.x + v.x * dt, y: check.position.y + v.y * dt, z: check.position.z + v.z * dt };
          const errorMeters = distance(row.position, predicted);
          if (errorMeters !== null && errorMeters > settings.positionMeters) {
            once("position", ball.id, { errorMeters: Math.round(errorMeters), positionSource: check.source,
              ageMs: Math.round(atMs - check.atMs), serverMode, clientMode: ball.mode });
          }
        }
      }
    }

    for (const [id, orphan] of model.orphans) {
      once("unknown-ball", id, { update: orphan.op, count: orphan.count, inServerGrid: server.has(id) });
    }
    model.orphans.clear();

    for (const [key, hit] of seen) {
      const entry = pending.get(key) || { firstAtMs: atMs, samples: 0, open: false };
      entry.samples += 1;
      entry.details = hit.details;
      pending.set(key, entry);
      if (!entry.open && entry.samples >= settings.persistSamples && atMs - entry.firstAtMs >= settings.settleMs) {
        entry.open = true;
        events.push({ kind: "DIVERGE", source: "client", status: "open", reason: hit.reason, itemID: hit.id,
          ...describeBall(hit.id), ...hit.details, sinceMs: atMs - entry.firstAtMs, atMs: entry.firstAtMs });
      }
    }
    for (const [key, entry] of pending) {
      if (seen.has(key)) continue;
      pending.delete(key);
      if (entry.open) {
        const [reason, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
        events.push({ kind: "DIVERGE", source: "client", status: "cleared", reason, itemID: id, ...describeBall(id),
          durationMs: atMs - entry.firstAtMs });
      }
    }
    return events;
  }

  return { step, reset, settings };
}

module.exports = {
  DIVERGE_DEFAULTS,
  LIMITS,
  createClientModel,
  createDestinyTee,
  createDivergenceChecker,
  decodeBallState,
  decodeDestinyUpdate,
  isGatewaySession,
};
