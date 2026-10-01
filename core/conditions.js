"use strict";

// Scenario conditions: the `until` and `expect` lines of a scenario, matched
// against the events `e2e watch` writes to timeline.jsonl. A condition is an
// event kind and field tests, in the names the watch prints:
//
//   ARRIVE family=pirate count>=3
//   DESTROYED self
//   HUNT reason~scout-discovery t<=5min
//   INCOMING flightID=$scout
//
// Every kind and field is checked against EVENT_FIELDS when the scenario
// loads, so a typo fails before a ten-minute run instead of after it. Keep
// EVENT_FIELDS in step with what bridge/watch.js and bridge/destiny.js
// emit; test/e2eScenario.test.js runs the differ against it.

// Scalar field types. `m` and `ms` take unit suffixes (30km, 90s, 5min).
const SCALAR_TYPES = new Set(["str", "id", "num", "m", "ms", "bool"]);

const LU = {
  flightID: "id", actorID: "id", family: "str", faction: "str", corporation: "str", pirateRole: "str",
  phase: "str", journeyKind: "str", journeyStage: "str", huntID: "id", huntRole: "str", huntPhase: "str",
  huntReason: "str", decision: "str", order: { obj: { mode: "str", role: "str" } },
};
const MEMBER = { itemID: "id", label: "str", typeName: "str", kind: "str", who: "str", mode: "str", distanceMeters: "m" };
const FLIGHT = {
  flightID: "id", family: "str", faction: "str", corporation: "str", pirateRole: "str", phase: "str",
  count: "num", systemID: "id", systemName: "str",
};
const GROUP = {
  flightID: "id", count: "num", who: "str", distanceMeters: "m", members: { list: MEMBER }, lu: { obj: LU },
};
const COMMON = { t: "ms", atMs: "ms", seq: "num", source: "str" };

const EVENT_FIELDS = Object.freeze({
  GRID: {
    systemID: "id", systemName: "str", security: "num", tracked: "num",
    self: { obj: { itemID: "id", typeName: "str", mode: "str",
      protection: { obj: { active: "bool", untilMs: "ms", remainingMs: "ms", cloaked: "bool" } } } },
  },
  PRESENT: GROUP,
  ARRIVE: { ...GROUP, firstSeenAtMs: "ms", warpIn: "bool", stillWarping: "bool" },
  LEAVE: { ...GROUP, warped: "bool" },
  MODE: {
    itemID: "id", label: "str", from: "str", to: "str", targetID: "id", targetLabel: "str", distanceMeters: "m",
    flightID: "id", lu: { obj: LU },
  },
  TARGET: {
    sourceID: "id", sourceLabel: "str", targetID: "id", targetLabel: "str", locked: "bool", flightID: "id",
    lu: { obj: LU },
  },
  DAMAGE: { itemID: "id", label: "str", layer: "str", fromPct: "num", toPct: "num", flightID: "id", lu: { obj: LU } },
  DESTROYED: {
    itemID: "id", label: "str", typeName: "str", typeID: "id", corporationID: "id", characterID: "id", self: "bool",
    who: "str", wreckID: "id", wreckLabel: "str", distanceMeters: "m", flightID: "id", lu: { obj: LU },
  },
  KILLMAIL: { killID: "id", itemID: "id", label: "str", typeName: "str", flightID: "id" },
  SIGHTING: {
    observerID: "id", observerLabel: "str", observerFlightID: "id", source: "str", certainty: "str",
    observedAtMs: "ms", distanceMeters: "m", lu: { obj: LU },
  },
  SELF: { fromItemID: "id", fromTypeName: "str", toItemID: "id", toTypeName: "str" },
  DOCKED: { systemID: "id", systemName: "str", stationID: "id" },
  SYSTEM: { fromSystemID: "id", toSystemID: "id", toSystemName: "str", security: "num" },
  MOVED: { distanceMeters: "m", systemName: "str" },
  HUNT: {
    huntID: "id", phase: "str", reason: "str", source: "str", targetSelf: "bool", targetLabel: "str",
    observerID: "id", observerLabel: "str", contactSystemID: "id", contactSystemName: "str", distanceMeters: "m",
    supportFlightIDs: { list: "id" }, leader: { obj: FLIGHT }, initial: "bool",
  },
  HERE: { systemID: "id", systemName: "str", count: "num", byFamily: { map: "num" }, flights: { list: FLIGHT } },
  INCOMING: {
    ...FLIGHT, toSystemID: "id", toSystemName: "str", journeyKind: "str", stage: "str", ownerID: "id",
    dueAtMs: "ms", etaMs: "ms", jumpsRemaining: "num", initial: "bool",
  },
  ENTER: FLIGHT,
  EXIT: { ...FLIGHT, fromSystemName: "str" },
  ENGAGEMENT: {
    status: "str", encounterID: "id", flightIDs: { list: "id" }, shipCount: "num", phase: "str",
    encounterKind: "str", battleClass: "str",
  },
  LOSS: {
    actorID: "id", pilotName: "str", shipName: "str", corporation: "str", cause: "str", encounterID: "id",
    opponentName: "str",
  },
  LOG: { level: "str", text: "str" },
  CLIENT: {
    op: "str", itemID: "id", label: "str", targetID: "id", targetLabel: "str", mode: "str", rangeMeters: "m",
    count: "num", layer: "str", fromPct: "num", toPct: "num", update: "str", error: "str", newly: "bool",
    dropped: "num", egoID: "id", itemIDs: { list: "id" }, labels: { list: "str" }, keys: { list: "str" },
    balls: { list: { itemID: "id", typeID: "id", mode: "str", label: "str" } },
    attachedAtMs: "ms", baselineAtMs: "ms", notifications: "num", decodeErrors: "num", lastError: "str",
  },
  FX: {
    itemID: "id", label: "str", guid: "str", targetID: "id", targetLabel: "str", moduleID: "id", moduleTypeID: "id",
    offensive: "bool", durationMs: "ms", repeat: "num", knownBall: "bool", repeatsBefore: "num",
  },
  DIVERGE: {
    status: "str", reason: "str", itemID: "id", label: "str", distanceMeters: "m", serverMode: "str",
    clientMode: "str", errorMeters: "m", positionSource: "str", ageMs: "ms", update: "str", count: "num",
    inServerGrid: "bool", warpSource: "str", minRangeMeters: "m", durationMs: "ms", sinceMs: "ms",
  },
});

const KINDS = Object.freeze(Object.keys(EVENT_FIELDS));

// What `self` means for each kind: the event is about the player's own ship.
function selfTest(kind) {
  if (kind === "DESTROYED") return (event) => event.self === true;
  if (kind === "HUNT") return (event) => event.targetSelf === true;
  if (kind === "TARGET") return (event) => event.targetLabel === "self";
  if (kind === "SIGHTING") return () => true;
  if (EVENT_FIELDS[kind].label) return (event) => event.label === "self";
  return null;
}

const UNITS = {
  m: { "": 1, m: 1, km: 1000 },
  ms: { "": 1, ms: 1, s: 1000, min: 60_000, h: 3_600_000 },
};

function parseNumber(text, type) {
  const match = /^(-?\d+(?:\.\d+)?)([a-z]*)$/i.exec(text);
  if (!match) return null;
  const units = UNITS[type] || { "": 1 };
  const factor = units[match[2].toLowerCase()];
  return factor === undefined ? null : Number(match[1]) * factor;
}

// Splits on spaces outside double quotes; quotes are removed.
function tokenize(text) {
  const tokens = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of String(text)) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) throw new Error("unclosed quote");
  if (started) tokens.push(current);
  return tokens;
}

function isNested(spec) {
  return spec && typeof spec === "object";
}

function nestedFields(spec) {
  if (!isNested(spec)) return null;
  if (spec.obj) return spec.obj;
  if (spec.list && isNested(spec.list)) return spec.list;
  return null;
}

// A field name resolves to a path in the event: the kind's own field first,
// then a field one level down (lu.family, leader.flightID, members.typeName).
function resolveField(kind, name) {
  const root = EVENT_FIELDS[kind];
  const parts = name.split(".");
  if (parts.length === 1) {
    if (root[name] !== undefined) return { path: [name], spec: root[name] };
    if (COMMON[name] !== undefined) return { path: [name], spec: COMMON[name] };
    for (const [key, spec] of Object.entries(root)) {
      const inner = nestedFields(spec);
      if (inner && inner[name] !== undefined) return { path: [key, name], spec: inner[name] };
    }
    return null;
  }
  const walk = (fields, path) => {
    let spec = null;
    for (const part of path) {
      if (spec && isNested(spec) && spec.map) {
        spec = spec.map;
        fields = null;
        continue;
      }
      if (!fields || fields[part] === undefined) return null;
      spec = fields[part];
      fields = nestedFields(spec);
    }
    return spec;
  };
  const direct = walk({ ...COMMON, ...root }, parts);
  if (direct) return { path: parts, spec: direct };
  // order.mode on an ARRIVE is lu.order.mode.
  for (const [key, spec] of Object.entries(root)) {
    const inner = nestedFields(spec);
    const found = inner ? walk(inner, parts) : null;
    if (found) return { path: [key, ...parts], spec: found };
  }
  return null;
}

function fieldNames(kind) {
  const root = EVENT_FIELDS[kind];
  const names = Object.keys(root).filter((key) => !isNested(root[key]) || typeof root[key].list === "string");
  for (const [key, spec] of Object.entries(root)) {
    const inner = nestedFields(spec);
    for (const [name, innerSpec] of Object.entries(inner || {})) {
      const deeper = nestedFields(innerSpec);
      if (deeper) names.push(...Object.keys(deeper).map((leaf) => `${key}.${name}.${leaf}`));
      else names.push(`${key}.${name}`);
    }
    if (isNested(spec) && spec.map) names.push(`${key}.<key>`);
  }
  return names;
}

// Every value at `path`, walking into lists: a list matches when any element does.
function valuesAt(event, path) {
  let values = [event];
  for (const part of path) {
    const next = [];
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const child = value[part];
      if (Array.isArray(child)) next.push(...child);
      else if (child !== undefined && child !== null) next.push(child);
    }
    values = next;
  }
  return values;
}

function scalarType(spec) {
  if (typeof spec === "string") return spec;
  if (isNested(spec) && typeof spec.list === "string") return spec.list;
  if (isNested(spec) && typeof spec.map === "string") return spec.map;
  return null;
}

function truthy(value) {
  if (typeof value === "string") return value.length > 0;
  return Boolean(value);
}

const OPERATOR = /^(!?)([A-Za-z_][\w.]*)(?:(!=|>=|<=|=|>|<|~)([\s\S]*))?$/;

// One field test, compiled. Returns (event, ctx) => boolean.
function compileTerm(kind, token, { bindings }) {
  if (token === "self" || token === "!self") {
    const test = selfTest(kind);
    if (!test) throw new Error(`"self" has no meaning for ${kind}`);
    return token === "self" ? test : (event) => !test(event);
  }
  const match = OPERATOR.exec(token);
  if (!match) throw new Error(`can't read "${token}"; write field=value, field>=number, field~regex or a bare field`);
  const [, bang, name, op, rawValue] = match;
  const resolved = resolveField(kind, name);
  if (!resolved) {
    throw new Error(`${kind} has no field "${name}". Fields: ${fieldNames(kind).join(", ")}`);
  }
  const type = scalarType(resolved.spec);
  if (!type || !SCALAR_TYPES.has(type)) {
    throw new Error(`${kind} ${name} is a group of fields; name one, e.g. ${name}.${Object.keys(nestedFields(resolved.spec) || { "<key>": 1 })[0]}`);
  }
  const values = (event) => valuesAt(event, resolved.path);
  if (!op) {
    const test = (event) => values(event).some(truthy);
    return bang ? (event) => !test(event) : test;
  }
  if (bang) throw new Error(`"${token}": put ! only before a bare field; use != to compare`);
  if (rawValue === "") throw new Error(`"${token}" has no value after ${op}`);

  if (rawValue.startsWith("$")) {
    const binding = rawValue.slice(1);
    if (!(type === "id" || type === "str") || !(op === "=" || op === "!=")) {
      throw new Error(`"${token}": a $name compares IDs or text with = or !=`);
    }
    if (!bindings.has(binding)) {
      throw new Error(`"${token}": no setup step binds $${binding}; add "as": "${binding}" to the trigger that makes it`);
    }
    const test = (event, ctx) => {
      const bound = ctx && ctx.bindings ? ctx.bindings[binding] : null;
      if (!bound || !bound.length) return false;
      const wanted = new Set(bound.map(String));
      return values(event).some((value) => wanted.has(String(value)));
    };
    return op === "=" ? test : (event, ctx) => !test(event, ctx);
  }

  if (type === "bool") {
    if (op !== "=" && op !== "!=") throw new Error(`"${token}": ${name} is true or false; compare with = or !=`);
    if (rawValue !== "true" && rawValue !== "false") throw new Error(`"${token}": ${name} is true or false`);
    const wanted = rawValue === "true";
    const test = (event) => values(event).some((value) => Boolean(value) === wanted);
    return op === "=" ? test : (event) => !test(event);
  }

  if (type === "num" || type === "m" || type === "ms") {
    if (op === "~") throw new Error(`"${token}": ${name} is a number; compare with = != > >= < <=`);
    const wanted = parseNumber(rawValue, type);
    if (wanted === null) {
      const units = Object.keys(UNITS[type] || {}).filter(Boolean);
      throw new Error(`"${token}": ${rawValue} is not a number${units.length ? ` (units: ${units.join(", ")})` : ""}`);
    }
    const compare = {
      "=": (value) => value === wanted,
      "!=": (value) => value === wanted,
      ">": (value) => value > wanted,
      ">=": (value) => value >= wanted,
      "<": (value) => value < wanted,
      "<=": (value) => value <= wanted,
    }[op];
    const test = (event) => values(event).some((value) => Number.isFinite(Number(value)) && compare(Number(value)));
    return op === "!=" ? (event) => !test(event) : test;
  }

  // str and id
  if (!["=", "!=", "~"].includes(op)) throw new Error(`"${token}": ${name} is text; compare with =, != or ~`);
  if (op === "~") {
    let pattern;
    try {
      pattern = new RegExp(rawValue, "i");
    } catch (error) {
      throw new Error(`"${token}": ${error.message}`);
    }
    return (event) => values(event).some((value) => pattern.test(String(value)));
  }
  const wanted = type === "id" ? rawValue : rawValue.toLowerCase();
  const same = (value) => (type === "id" ? String(value) : String(value).toLowerCase()) === wanted;
  const test = (event) => values(event).some(same);
  return op === "=" ? test : (event) => !test(event);
}

// text -> { text, kind, test(event, ctx) }. Throws with a message naming the
// problem. `bindings` is the set of $names setup steps declare.
function parseCondition(text, { bindings = new Set() } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("a condition is a non-empty string");
  const tokens = tokenize(text.trim());
  const kind = tokens.shift();
  if (!EVENT_FIELDS[kind]) {
    throw new Error(`unknown event kind "${kind}". Kinds: ${KINDS.join(", ")}`);
  }
  const terms = tokens.map((token) => compileTerm(kind, token, { bindings }));
  return {
    text: text.trim(),
    kind,
    test(event, ctx = {}) {
      return Boolean(event) && event.kind === kind && terms.every((term) => term(event, ctx));
    },
  };
}

module.exports = {
  EVENT_FIELDS,
  KINDS,
  fieldNames,
  parseCondition,
  resolveField,
  tokenize,
};
