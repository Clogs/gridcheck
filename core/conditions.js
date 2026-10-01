"use strict";

// Scenario conditions: the `until` and `expect` lines of a scenario, matched
// against the events `e2e watch` writes to timeline.jsonl. A condition is an
// event kind and field tests, in the names the watch prints:
//
//   ARRIVE who=npc count>=3
//   DESTROYED self
//   TARGET self locked t<=5min
//   DAMAGE itemID=$mark
//
// Every kind and field is checked when the scenario loads, so a typo fails
// before a ten-minute run instead of after it. The kinds here are the core's;
// plugins add theirs (and their data on core events) through the registry
// (core/plugins.js). Keep EVENT_FIELDS in step with what bridge/watch.js and
// bridge/destiny.js emit; test/e2eScenario.test.js runs the differ against it.

const { defaultRegistry } = require("./plugins");

// Scalar field types. `m` and `ms` take unit suffixes (30km, 90s, 5min).
const SCALAR_TYPES = new Set(["str", "id", "num", "m", "ms", "bool"]);

const MEMBER = { itemID: "id", label: "str", typeName: "str", kind: "str", who: "str", mode: "str", distanceMeters: "m" };
// groupKey: the group a plugin put the ball in (a flight, a gang), or none.
const GROUP = { groupKey: "str", count: "num", who: "str", distanceMeters: "m", members: { list: MEMBER } };
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
    groupKey: "str",
  },
  DECISION: {
    itemID: "id", label: "str", from: "str", to: "str", targetID: "id", targetLabel: "str", groupKey: "str",
  },
  TARGET: {
    sourceID: "id", sourceLabel: "str", targetID: "id", targetLabel: "str", locked: "bool", groupKey: "str",
  },
  DAMAGE: { itemID: "id", label: "str", layer: "str", fromPct: "num", toPct: "num", groupKey: "str" },
  DESTROYED: {
    itemID: "id", label: "str", typeName: "str", typeID: "id", corporationID: "id", characterID: "id", self: "bool",
    who: "str", wreckID: "id", wreckLabel: "str", distanceMeters: "m", groupKey: "str",
  },
  KILLMAIL: { killID: "id", itemID: "id", label: "str", typeName: "str", groupKey: "str" },
  SELF: { fromItemID: "id", fromTypeName: "str", toItemID: "id", toTypeName: "str" },
  DOCKED: { systemID: "id", systemName: "str", stationID: "id" },
  SYSTEM: { fromSystemID: "id", toSystemID: "id", toSystemName: "str", security: "num" },
  MOVED: { distanceMeters: "m", systemName: "str" },
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

// The core kinds that carry the plugins' data about a ball, at ext.<plugin>.
const EXT_KINDS = Object.freeze(["PRESENT", "ARRIVE", "LEAVE", "MODE", "DECISION", "TARGET", "DAMAGE", "DESTROYED", "KILLMAIL"]);

// Per registry: every kind's fields, plugin kinds and plugin data included.
const TABLES = new WeakMap();

function tablesFor(registry) {
  const cached = TABLES.get(registry);
  if (cached) return cached;
  const fields = {};
  for (const [kind, spec] of Object.entries(EVENT_FIELDS)) fields[kind] = { ...spec };
  const ext = {};
  for (const [plugin, extFields] of Object.entries(registry.extFields)) ext[plugin] = { obj: extFields };
  if (Object.keys(ext).length) {
    for (const kind of EXT_KINDS) fields[kind].ext = { obj: ext };
  }
  const owners = {};
  for (const [kind, entry] of Object.entries(registry.kinds)) {
    if (fields[kind]) {
      registry.warn(`plugin ${entry.plugin}: event kind ${kind} is a core kind`);
      continue;
    }
    fields[kind] = entry.fields || {};
    owners[kind] = entry.plugin;
  }
  const tables = { fields, owners, kinds: Object.keys(fields) };
  TABLES.set(registry, tables);
  return tables;
}

function eventFields(registry = defaultRegistry()) {
  return tablesFor(registry).fields;
}

function kindsOf(registry = defaultRegistry()) {
  return tablesFor(registry).kinds;
}

// What `self` means for each kind: the event is about the player's own ship.
function selfTest(kind, registry) {
  if (registry.selfTests[kind]) return registry.selfTests[kind];
  if (kind === "DESTROYED") return (event) => event.self === true;
  if (kind === "TARGET") return (event) => event.targetLabel === "self";
  if (tablesFor(registry).fields[kind].label) return (event) => event.label === "self";
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

// The plugins' data on an event of this kind: [[plugin, fields]].
function extFieldsOf(root) {
  const ext = root.ext && root.ext.obj;
  return ext ? Object.entries(ext).map(([plugin, spec]) => [plugin, spec.obj]) : [];
}

// A field name resolves to a path in the event: the kind's own field first,
// then a field one level down (members.typeName, self.mode), then a field of
// a plugin's data under ext.<plugin> (family on an ARRIVE is ext.lu.family).
// <plugin>.<field> names a plugin's field outright.
function resolveField(kind, name, registry = defaultRegistry()) {
  const root = tablesFor(registry).fields[kind];
  if (!root) return null;
  const parts = name.split(".");
  const plugins = extFieldsOf(root);
  if (parts.length === 1) {
    if (root[name] !== undefined) return { path: [name], spec: root[name] };
    if (COMMON[name] !== undefined) return { path: [name], spec: COMMON[name] };
    for (const [key, spec] of Object.entries(root)) {
      const inner = nestedFields(spec);
      if (inner && inner[name] !== undefined) return { path: [key, name], spec: inner[name] };
    }
    for (const [plugin, fields] of plugins) {
      if (fields[name] !== undefined) return { path: ["ext", plugin, name], spec: fields[name] };
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
  for (const [key, spec] of Object.entries(root)) {
    const inner = nestedFields(spec);
    const found = inner ? walk(inner, parts) : null;
    if (found) return { path: [key, ...parts], spec: found };
  }
  // order.mode on an ARRIVE is ext.lu.order.mode.
  for (const [plugin, fields] of plugins) {
    const found = walk(fields, parts);
    if (found) return { path: ["ext", plugin, ...parts], spec: found };
  }
  return null;
}

function fieldNames(kind, registry = defaultRegistry()) {
  const root = tablesFor(registry).fields[kind];
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
function compileTerm(kind, token, { bindings, registry }) {
  if (token === "self" || token === "!self") {
    const test = selfTest(kind, registry);
    if (!test) throw new Error(`"self" has no meaning for ${kind}`);
    return token === "self" ? test : (event) => !test(event);
  }
  const match = OPERATOR.exec(token);
  if (!match) throw new Error(`can't read "${token}"; write field=value, field>=number, field~regex or a bare field`);
  const [, bang, name, op, rawValue] = match;
  const resolved = resolveField(kind, name, registry);
  if (!resolved) {
    throw new Error(`${kind} has no field "${name}". Fields: ${fieldNames(kind, registry).join(", ")}`);
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
      throw new Error(`"${token}": no setup step binds $${binding}; add "as": "${binding}" to the step that makes it`);
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

// text -> { text, kind, plugin, test(event, ctx) }. Throws with a message
// naming the problem. `bindings` is the set of $names setup steps declare;
// `plugin` names the plugin that owns the kind, or null for a core kind.
function parseCondition(text, { bindings = new Set(), registry = defaultRegistry() } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("a condition is a non-empty string");
  const tokens = tokenize(text.trim());
  const kind = tokens.shift();
  const tables = tablesFor(registry);
  if (!tables.fields[kind]) {
    throw new Error(`unknown event kind "${kind}". Kinds: ${tables.kinds.join(", ")}`);
  }
  const terms = tokens.map((token) => compileTerm(kind, token, { bindings, registry }));
  return {
    text: text.trim(),
    kind,
    plugin: tables.owners[kind] || null,
    test(event, ctx = {}) {
      return Boolean(event) && event.kind === kind && terms.every((term) => term(event, ctx));
    },
  };
}

module.exports = {
  EVENT_FIELDS,
  EXT_KINDS,
  KINDS,
  eventFields,
  fieldNames,
  kindsOf,
  parseCondition,
  resolveField,
  tokenize,
};
