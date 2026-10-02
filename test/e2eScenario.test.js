"use strict";

// `gridcheck run <scenario>` (core/scenario.js, core/conditions.js): the
// condition language, scenario checks at load, the run with its server calls
// faked, and the report. The live path is in docs/GUIDE.md
// "Scenarios".

const test = require("node:test");
const assert = require("node:assert");
const { needsPlugin } = require("./tree");
const fs = require("fs");
const path = require("path");

const { EVENT_FIELDS, eventFields, parseCondition, resolveField } = require("../core/conditions");
const {
  ScenarioError,
  bindStep,
  describeStep,
  exitCodeFor,
  listScenarios,
  renderReport,
  resultRecord,
  runScenario,
  validateScenario,
} = require("../core/scenario");
const { createToolRegistry, emptyRegistry } = require("../core/plugins");
const { triggerIDs } = require("../plugins/lu/tool/triggers");
const { createGridDiffer } = require("../bridge/watch");
const { createOffGridTracker } = require("../plugins/lu/server/offGrid");
const { createLuAnnotate } = require("../plugins/lu/server/join");
const { createLuOnGrid } = require("../plugins/lu/server/onGrid");

const ARRIVE = {
  seq: 9, t: 138_000, kind: "ARRIVE", groupKey: "flight:living_flight_4420", count: 4, who: "npc", warpIn: true,
  distanceMeters: 24_000,
  members: [{ itemID: 2, label: "Guristas Worm", typeName: "Worm" }, { itemID: 3, label: "Guristas Stiletto", typeName: "Stiletto" }],
  ext: { lu: { flightID: "living_flight_4420", family: "pirate", corporation: "Guristas", huntPhase: "committed",
    order: { mode: "committed" } } },
};

const matches = (text, event, ctx) => parseCondition(text, ctx).test(event, ctx);

// These read the lu plugin through the default registry, so they need a tree
// it applies to: the fixture tree npm test names, or one with the mod.
const LU = needsPlugin("lu");

test("the plan's stop conditions read as written", LU, () => {
  assert.ok(matches("ARRIVE family=pirate count>=3", ARRIVE));
  assert.ok(!matches("ARRIVE family=pirate count>=5", ARRIVE));
  assert.ok(matches("DESTROYED self", { kind: "DESTROYED", self: true, label: "self" }));
  assert.ok(!matches("DESTROYED self", { kind: "DESTROYED", self: false, label: "Worm" }));
  assert.ok(!matches("DESTROYED self", ARRIVE), "another kind never matches");
});

test("fields resolve on the event, then one level down, then under ext.<plugin>, and lists match on any element", LU, () => {
  assert.ok(matches("ARRIVE typeName=Stiletto", ARRIVE), "members.typeName");
  assert.ok(matches("ARRIVE members.label~stiletto", ARRIVE));
  assert.ok(matches("ARRIVE lu.huntPhase=committed order.mode=committed", ARRIVE), "<plugin>.<field> and a plugin's nested field");
  assert.ok(matches("ARRIVE ext.lu.family=pirate flightID=living_flight_4420", ARRIVE), "the full path, and a plain name");
  assert.ok(matches("ARRIVE groupKey=flight:living_flight_4420", ARRIVE));
  assert.ok(matches("ARRIVE corporation=guristas", ARRIVE), "text compares without case");
  assert.ok(matches("ARRIVE warpIn", ARRIVE), "a bare field is true when set");
  assert.ok(matches("ARRIVE !stillWarping", ARRIVE));
  assert.ok(matches("HUNT family=pirate", { kind: "HUNT", leader: { family: "pirate" } }), "leader.family");
  assert.ok(matches("HERE byFamily.pirate>=2", { kind: "HERE", byFamily: { pirate: 2, freight: 9 } }));
  assert.ok(matches("HUNT supportFlightIDs=gang", { kind: "HUNT", supportFlightIDs: ["scout", "gang"] }));
  assert.ok(!matches("HUNT supportFlightIDs!=gang", { kind: "HUNT", supportFlightIDs: ["scout", "gang"] }));
  assert.ok(matches('ARRIVE label="Guristas Worm"', ARRIVE), "quotes keep spaces");
});

test("distances and times take units, and every event has t", LU, () => {
  assert.ok(matches("ARRIVE distanceMeters<=30km", ARRIVE));
  assert.ok(!matches("ARRIVE distanceMeters<20km", ARRIVE));
  assert.ok(matches("ARRIVE t<=3min", ARRIVE));
  assert.ok(matches("ARRIVE t>2min t<139s", ARRIVE));
  assert.ok(matches("INCOMING etaMs<=95s", { kind: "INCOMING", etaMs: 95_000 }));
});

test("self means the player's ship, kind by kind", LU, () => {
  assert.ok(matches("HUNT self", { kind: "HUNT", targetSelf: true }));
  assert.ok(matches("TARGET self locked", { kind: "TARGET", targetLabel: "self", locked: true }));
  assert.ok(matches("DAMAGE self layer=shield toPct<50", { kind: "DAMAGE", label: "self", layer: "shield", toPct: 40 }));
  assert.ok(matches("TARGET !self", { kind: "TARGET", targetLabel: "Worm" }));
  assert.throws(() => parseCondition("ARRIVE self"), /"self" has no meaning for ARRIVE/);
});

test("a $name matches what a trigger bound, and nothing before it is bound", LU, () => {
  const bindings = new Set(["scout"]);
  const condition = parseCondition("INCOMING flightID=$scout", { bindings });
  const event = { kind: "INCOMING", flightID: "living_flight_0908" };
  assert.strictEqual(condition.test(event, { bindings: {} }), false);
  assert.strictEqual(condition.test(event, { bindings: { scout: ["living_flight_0908"] } }), true);
  assert.throws(() => parseCondition("INCOMING flightID=$fleet", { bindings }), /no setup step binds \$fleet/);
  assert.throws(() => parseCondition("ARRIVE count=$scout", { bindings }), /compares IDs or text/);
});

test("an unknown kind, field, operator or value fails when the condition is read", LU, () => {
  assert.throws(() => parseCondition("ARIVE family=pirate"), /unknown event kind "ARIVE"/);
  assert.throws(() => parseCondition("ARRIVE famly=pirate"), /ARRIVE has no field "famly". Fields: .*lu\.family/);
  assert.throws(() => parseCondition("ARRIVE count~3"), /is a number/);
  assert.throws(() => parseCondition("ARRIVE count>=three"), /not a number/);
  assert.throws(() => parseCondition("ARRIVE distanceMeters<30au"), /units: m, km/);
  assert.throws(() => parseCondition("ARRIVE family>=pirate"), /is text/);
  assert.throws(() => parseCondition("ARRIVE warpIn=yes"), /true or false/);
  assert.throws(() => parseCondition("ARRIVE lu=pirate"), /group of fields/);
  assert.throws(() => parseCondition("ARRIVE family~(["), /Invalid regular expression/);
  assert.throws(() => parseCondition("START"), /unknown event kind "START"/, "the watch's own bookends are not observations");
  assert.throws(() => parseCondition('ARRIVE label="open'), /unclosed quote/);
});

// Every field a real watch emits must be one a scenario may name, or a
// scenario about it would be refused at load.
function leafPaths(event, prefix = "", out = []) {
  for (const [key, value] of Object.entries(event)) {
    if (!prefix && ["kind"].includes(key)) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Set)) {
      if (!/^byFamily$/.test(name)) leafPaths(value, name, out);
    } else if (Array.isArray(value) && value.length && typeof value[0] === "object") {
      for (const item of value) leafPaths(item, name, out);
    } else if (value !== undefined) {
      out.push(name);
    }
  }
  return out;
}

test("every field the grid differ and off-grid tracker emit can be named in a condition", LU, () => {
  const self = { kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", name: "Rifter", mode: "STOP", distanceMeters: 0,
    position: { x: 0, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const lu = { flightID: "f", actorID: "a", family: "pirate", faction: "Guristas Pirates", corporation: "Guristas",
    pirateRole: "tackle", phase: "mission_holding", journeyKind: "pirate_hunt_support", journeyStage: "outbound",
    huntID: "h", huntRole: "support", huntPhase: "committed", huntReason: "r", order: { mode: "committed", role: "tackle" },
    decision: "engage", sightings: [{ observerID: 2, source: "sighting", certainty: "confirmed", observedAtMs: 5, observerFlightID: "f" }] };
  // The rows the watch's annotate makes with the lu plugin's join (join.js).
  const annotation = createLuAnnotate({ annotate: () => lu })({}, { row: { isNpc: true } });
  const npc = (itemID, extra = {}) => ({ kind: "ship", itemID, name: `N${itemID}`, typeName: "Worm", typeID: 17930, isNpc: true,
    npcEntityType: "npc", corporationID: 9, mode: "ORBIT", targetEntityID: 1, distanceMeters: 24_000,
    position: { x: 24_000, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1, lockedTargetIDs: [],
    groupKey: annotation.groupKey, ext: { lu: annotation.ext }, hidden: { lu: annotation.hidden }, ...extra });
  const grid = (entities, extra = {}) => ({ inSpace: true, solarSystemID: 30002537, systemName: "Amamake", security: 0.4,
    self: { itemID: 1, typeName: "Rifter", mode: "STOP", protection: { active: false, untilMs: null, remainingMs: 0, cloaked: false } },
    entities: [self, ...entities], ...extra });
  const differ = createGridDiffer({ gridHooks: [{ name: "lu", step: createLuOnGrid().watch({}).step }] });
  const events = [
    ...differ.step(grid([npc(2, { lockedTargetIDs: [1] })]), 1000),
    ...differ.step(grid([npc(3, { mode: "WARP" })]), 3000),
  ];
  events.push(...differ.step(grid([npc(3)]), 5000));
  events.push(...differ.step(grid([npc(3, { mode: "FOLLOW", shieldRatio: 0.4, lockedTargetIDs: [1] })]), 7000));
  events.push(...differ.step(grid([{ kind: "wreck", itemID: 50, name: "W", position: { x: 24_000, y: 0, z: 0 } }]), 8000));
  const capsule = grid([]);
  events.push(...differ.step({ ...capsule, self: { ...capsule.self, itemID: 5, typeName: "Capsule" },
    entities: [{ ...self, itemID: 5, typeName: "Capsule" }] }, 9000));
  events.push(...differ.step(grid([], { solarSystemID: 30002538, systemName: "Siseide" }), 11_000));
  events.push(...differ.step({ ...grid([], { solarSystemID: 30002538, systemName: "Siseide" }),
    entities: [{ ...self, position: { x: 1e12, y: 0, z: 0 } }] }, 13_000));
  events.push(...differ.step({ inSpace: false, solarSystemID: 30002538, stationID: 60000001 }, 15_000));

  const hunt = { id: "h", phase: "stalking", reason: "scout-discovery", supportIDs: ["g"],
    report: { systemID: 30002537, targetCharacterID: 7, targetID: 1, observerID: 2, source: "sighting",
      location: { position: { x: 1, y: 0, z: 0 } } },
    trace: [{ atMs: 1000, phase: "stalking", reason: "scout-discovery" }] };
  const flights = {
    s: { flightID: "s", family: "pirate", pirateRole: "scout", homeFactionName: "F", homeCorporationName: "C",
      currentSystemID: 30002537, actorIDs: ["a"], phase: "mission_holding", pirateHunt: hunt, encounterID: "e1" },
    g: { flightID: "g", family: "pirate", currentSystemID: 30002540, actorIDs: ["b"], phase: "mission_outbound",
      missionJourney: { kind: "pirate_hunt_support", stage: "outbound", status: "outbound", ownerID: "h", startedAtMs: 1,
        dueAtMs: 9000, destination: { systemID: 30002537 }, systemIDs: [30002540, 30002537], cursor: 0 } },
  };
  const tracker = createOffGridTracker({ characterID: 7, startedAtMs: 0, describeSystem: () => ({ name: "Amamake" }), inspect: {
    listFlights: () => Object.values(flights), getFlightByID: (id) => flights[id] || null,
    getEncounterByID: () => ({ phase: "active", kind: "k", battleClass: "skirmish" }),
    listShipLosses: () => ({ losses: [{ lostAtMs: 3000, systemID: 30002537, actorID: "x", pilotName: "p", shipName: "Worm",
      corporationName: "C", cause: "physical", encounterID: "e1", opponentName: "o" }] }),
  } });
  const context = { nowMs: 2000, egoPosition: { x: 0, y: 0, z: 0 }, labelFor: () => "self" };
  events.push(...tracker.scan(30002537, context).events);
  flights.n = { flightID: "n", family: "freight", currentSystemID: 30002537, actorIDs: ["c"] };
  delete flights.s.encounterID;
  flights.s.pirateHunt = null;
  events.push(...tracker.scan(30002537, { ...context, nowMs: 4000 }).events);

  const kinds = new Set(events.map((event) => event.kind));
  for (const kind of ["GRID", "PRESENT", "ARRIVE", "LEAVE", "MODE", "TARGET", "DAMAGE", "DESTROYED", "SIGHTING", "SELF",
    "SYSTEM", "MOVED", "DOCKED", "HERE", "HUNT", "INCOMING", "ENTER", "ENGAGEMENT", "LOSS"]) {
    assert.ok(kinds.has(kind), `the fixture should produce ${kind}`);
  }
  const unknown = new Set();
  const fields = eventFields();
  for (const event of events) {
    assert.ok(fields[event.kind], `kind ${event.kind}`);
    for (const name of leafPaths(event)) if (!resolveField(event.kind, name)) unknown.add(`${event.kind} ${name}`);
  }
  assert.deepStrictEqual([...unknown], []);
});

const STUBS = { worldExists: (name) => name === "lowsec-docked", resolveSystemID: (text) => {
  const known = { Amamake: 30002537, Siseide: 30002538, Rens: 30002510, Yrmori: 30003414 };
  if (known[text]) return known[text];
  if (Number(text) > 0) return Number(text);
  throw new Error(`no solar system named ${text}`);
} };

const GOOD = {
  description: "pirates arrive",
  world: "lowsec-docked",
  setup: ["undock", { teleport: "Amamake" }, { trigger: "scout", as: "scout" }, { waitFor: "ENTER flightID=$scout", timeout: 120 },
    { trigger: "materialize", flight: "$scout", go: true }, { trigger: "fleet", family: "pirate", doctrine: "sanshas", count: 2 },
    { wait: 5 }, { slash: "/heal" }],
  until: { any: ["ARRIVE family=pirate count>=3", "DESTROYED self"], timeout: 600, grace: 20 },
  expect: ["SIGHTING", { match: "ARRIVE flightID=$scout", note: "the scout lands" }, "no DIVERGE"],
};

test("a scenario loads to its steps, conditions and defaults", LU, () => {
  const scenario = validateScenario(GOOD, { ...STUBS, defaultName: "pirates" });
  assert.strictEqual(scenario.name, "pirates");
  assert.deepStrictEqual(scenario.setup.map((step) => step.type),
    ["login", "undock", "teleport", "trigger", "waitFor", "trigger", "trigger", "wait", "slash"]);
  assert.strictEqual(scenario.setup[0].implicit, true, "a login runs first even when setup leaves it out");
  assert.strictEqual(scenario.setup[2].systemID, 30002537);
  assert.deepStrictEqual(scenario.setup[5].positionals, ["$scout"]);
  assert.deepStrictEqual(scenario.setup[6].positionals, ["pirate"]);
  assert.deepStrictEqual(scenario.setup[6].flags, { doctrine: "sanshas", count: 2 });
  assert.deepStrictEqual(scenario.up, { realClock: true, market: true, offgridTravel: null, offgridActivity: null, timeout: null,
    profile: false, profileEvery: null });
  assert.strictEqual(scenario.watch.client, "diverge");
  assert.strictEqual(scenario.until.any.length, 2);
  assert.deepStrictEqual(scenario.expect.map((entry) => [entry.text, entry.absent]),
    [["SIGHTING", false], ["ARRIVE flightID=$scout", false], ["no DIVERGE", true]]);
});

test("every problem in a scenario is reported at load, each with where it is", LU, () => {
  const bad = {
    world: "nowhere",
    colour: "red",
    up: { realClock: "yes", offgridTravel: 500 },
    watch: { client: "none" },
    setup: ["undock", "login", { teleport: "Atlantis" }, { trigger: "scot" }, { trigger: "hunt", phase: "eager", family: "x" },
      { trigger: "materialize", flight: "$later" }, { wait: 5, slash: "/heal" }, { jump: true }],
    until: { any: ["ARIVE"], timeout: 0, from: "later" },
    expect: [{ match: "FX guid~warp", oops: 1 }, "ARRIVE famly=pirate"],
  };
  let error;
  try {
    validateScenario(bad, STUBS);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ScenarioError);
  const text = error.problems.join("\n");
  for (const pattern of [
    /colour: unknown key/,
    /world: no saved world "nowhere"/,
    /up.realClock: true or false/,
    /up.offgridTravel: a number from 1 through 100/,
    /watch.client: all, fx, diverge or off/,
    /setup\[1\]: login is the first step/,
    /setup\[2\]: no solar system named Atlantis/,
    /setup\[3\]: unknown trigger "scot"/,
    /setup\[4\].phase: stalking or committed/,
    /setup\[4\].family: unknown key for trigger hunt/,
    /setup\[5\].flight: no earlier step binds \$later/,
    /setup\[6\]: one step per entry, not slash and wait/,
    /setup\[7\]: unknown step/,
    /until.any\[0\]: unknown event kind "ARIVE"/,
    /until.timeout: seconds, above 0/,
    /until.from: "setup" \(the default/,
    /expect\[0\].oops: unknown key/,
    /expect\[0\]: FX needs "watch": \{ "client": "fx" \} or "all"/,
    /expect\[1\]: ARRIVE has no field "famly"/,
  ]) {
    assert.match(text, pattern);
  }
});

test("a scenario that can't fit in one bridge watch is refused", () => {
  assert.throws(() => validateScenario({ ...GOOD, until: { timeout: 3000 }, setup: [{ wait: 60 }] }, STUBS),
    /add up to 3060 s; a run fits in 3000 s/);
});

test("every shipped scenario loads", LU, () => {
  const rows = listScenarios();
  for (const name of ["pirate-stalking", "gate-rats", "lu-traffic", "alliance-skirmish", "concord-highsec", "loadout-npc-fight"]) {
    assert.ok(rows.some((row) => row.name === name), `the first scenarios include ${name}`);
  }
  for (const row of rows) {
    const raw = JSON.parse(fs.readFileSync(row.file, "utf8"));
    assert.doesNotThrow(() => validateScenario(raw, { ...STUBS, worldExists: () => true, defaultName: row.name }), row.name);
  }
});

test("without a plugin, its kinds, data, steps and up keys are unknown, and the core still loads", () => {
  const registry = emptyRegistry();
  assert.throws(() => parseCondition("HUNT self", { registry }), /unknown event kind "HUNT"/);
  assert.throws(() => parseCondition("ARRIVE family=pirate", { registry }), /ARRIVE has no field "family"/);
  assert.ok(parseCondition("ARRIVE who=npc count>=2", { registry }).test({ kind: "ARRIVE", who: "npc", count: 3 }));
  assert.strictEqual(EVENT_FIELDS.HUNT, undefined, "the core's own table names no plugin kind");
  let error;
  try {
    validateScenario({ world: "lowsec-docked", up: { offgridTravel: 5 }, setup: ["undock", { trigger: "scout" }], until: { timeout: 5 },
      expect: ["GRID"] }, { ...STUBS, registry, defaultName: "t" });
  } catch (caught) {
    error = caught;
  }
  assert.match(error.problems.join("\n"), /up.offgridTravel: unknown key; up takes market, timeout/);
  assert.match(error.problems.join("\n"), /setup\[1\]: unknown step; steps are login, undock/);
  const scenario = validateScenario({ world: "lowsec-docked", setup: ["undock"], until: { timeout: 5 }, expect: ["GRID"] }, { ...STUBS, registry, defaultName: "t" });
  assert.deepStrictEqual(scenario.up, { market: true, timeout: null, profile: false, profileEvery: null });
});

test("a plugin's step validates, describes, binds and runs through the registry", () => {
  const registry = createToolRegistry({ active: [{ name: "demo", dir: null, plugin: { tool: {
    kinds: { RAID: { gang: "id", size: "num" } },
    steps: {
      raid: {
        binds: true,
        keys: () => ["size", "gang"],
        parse(raw, ctx) {
          if (!(raw.size >= 1)) ctx.problem("size", "1 or more");
          ctx.bound(raw.gang, "gang");
          return { size: raw.size, gang: raw.gang };
        },
        describe: (step) => `raid x${step.size}${step.gang ? ` with ${step.gang}` : ""}`,
        run: async () => ({ ok: true, ids: ["g1"] }),
      },
    },
  } } }] });
  const scenario = validateScenario({ world: "lowsec-docked", setup: [{ raid: true, size: 3, as: "gang" }, { raid: true, size: 1, gang: "$gang" }],
    until: { any: ["RAID gang=$gang"], timeout: 5 }, expect: ["RAID size>=2"] }, { ...STUBS, registry, defaultName: "t" });
  assert.deepStrictEqual(scenario.setup.map((step) => step.type), ["login", "raid", "raid"]);
  assert.strictEqual(scenario.setup[1].plugin, "demo");
  assert.strictEqual(describeStep(scenario.setup[1], registry), "raid x3 as $gang");
  assert.strictEqual(bindStep(scenario.setup[2], { gang: ["g1"] }).gang, "g1");
  assert.throws(() => validateScenario({ world: "lowsec-docked", setup: [{ raid: true, size: 0, colour: "red", gang: "$later" }],
    until: { timeout: 5 }, expect: ["GRID"] }, { ...STUBS, registry, defaultName: "t" }),
  (error) => /setup\[0\].size: 1 or more/.test(error.message) && /setup\[0\].colour: unknown key for raid/.test(error.message) &&
    /setup\[0\].gang: no earlier step binds \$later/.test(error.message));
});

test("trigger replies bind the IDs a timeline names them by", () => {
  assert.deepStrictEqual(triggerIDs({ trigger: "scout", flightID: "f1" }), ["f1"]);
  assert.deepStrictEqual(triggerIDs({ trigger: "hunt", huntID: "h1", flight: { flightID: "f2" } }), ["h1", "f2"]);
  assert.deepStrictEqual(triggerIDs({ trigger: "fleet", ownerID: "o", flights: [{ flightID: "a" }, { flightID: "b" }] }), ["a", "b", "o"]);
  assert.deepStrictEqual(bindStep({ type: "trigger", positionals: ["$s"], flags: { go: true } }, { s: ["f1"] }).positionals, ["f1"]);
  assert.throws(() => bindStep({ type: "teleport", flight: "$s" }, {}), /\$s is not bound yet/);
});

// A watch that replays a script of events, each `afterMs` after the last.
function fakeOps(script, { failStep = null, triggerReply = null } = {}) {
  const calls = [];
  const timeline = [];
  let seq = 0;
  const ops = {
    calls,
    timeline,
    up: async () => { calls.push("up"); },
    down: async () => { calls.push("down"); },
    step: async (step) => {
      calls.push(`step:${step.type}${step.flight ? `:${step.flight}` : ""}${step.positionals && step.positionals.length ? `:${step.positionals.join(",")}` : ""}`);
      if (failStep === step.type) return { ok: false, text: `${step.type} -> refused` };
      if (step.type === "trigger") return { ok: true, text: "scout f1", ids: triggerIDs(triggerReply || { trigger: "scout", flightID: "f1" }) };
      return { ok: true, text: `${step.type} ok` };
    },
    startWatch: async (onEvent) => {
      calls.push("watch");
      const startedAtMs = Date.now();
      let stopped = false;
      let endResolve;
      const ended = new Promise((resolve) => { endResolve = resolve; });
      const release = (event) => {
        const line = { seq: ++seq, t: Date.now() - startedAtMs, atMs: Date.now(), ...event };
        timeline.push(line);
        onEvent(line);
      };
      release({ kind: "START" });
      (async () => {
        for (const { afterMs, event } of script) {
          await new Promise((resolve) => setTimeout(resolve, afterMs));
          if (stopped) return;
          if (event === "END") {
            stopped = true;
            endResolve({ reason: "session-gone", error: null });
            return;
          }
          release(event);
        }
      })();
      return {
        push: (event) => { if (!stopped) release(event); },
        stop: async () => { stopped = true; endResolve({ reason: "stopped", error: null }); return ended; },
        ended,
      };
    },
  };
  return ops;
}

const scenarioOf = (raw) => validateScenario({ world: "lowsec-docked", setup: ["undock"], ...raw }, { ...STUBS, defaultName: "t" });

// The phase's done-when: one expectation that can't be met.
test("a run stops at its stop condition, flags the unmet expectation and keeps the whole timeline", LU, async () => {
  const scenario = scenarioOf({
    until: { any: ["HERE"], timeout: 5, grace: 0.15 },
    expect: ["GRID systemName=Amamake", { match: "SYSTEM toSystemName=Jita", note: "can't happen" }],
  });
  const ops = fakeOps([
    { afterMs: 10, event: { kind: "GRID", systemName: "Amamake" } },
    { afterMs: 10, event: { kind: "HERE", count: 3, byFamily: { pirate: 3 } } },
    { afterMs: 50, event: { kind: "ARRIVE", flightID: "f9", count: 1, members: [] } },
  ]);
  const started = Date.now();
  const result = await runScenario(scenario, ops);
  assert.ok(Date.now() - started < 3000, "stopped at HERE, not at the 5 s timeout");
  assert.deepStrictEqual(ops.calls, ["up", "step:login", "watch", "step:undock", "down"]);
  assert.strictEqual(result.stop.reason, "until");
  assert.strictEqual(result.stop.condition, "HERE");
  assert.strictEqual(result.failure, null);
  assert.deepStrictEqual(result.expectations.map((row) => [row.text, row.met]),
    [["GRID systemName=Amamake", true], ["SYSTEM toSystemName=Jita", false]]);
  assert.strictEqual(result.missing, 1);
  assert.strictEqual(exitCodeFor(result), 1);
  assert.deepStrictEqual(result.events.map((event) => event.kind), ["START", "STEP", "GRID", "HERE", "ARRIVE", "STOP"],
    "the grace period's ARRIVE and the runner's own lines are kept");
  assert.deepStrictEqual(result.events, ops.timeline, "the report reads the same events the timeline holds");

  const report = renderReport(result, { runID: "r1", scenario, scenarioFile: "tools/gridcheck/scenarios/t.json" });
  assert.match(report, /^# Scenario t: FAILED/);
  assert.match(report, /1 of 2 expectations met\. stop condition `HERE` met at t\+00:00:00, then watched 0\.\d s of 0\.2 s grace \(grace ran out\)\./,
    "an unmet expectation keeps grace running to its end");
  assert.strictEqual(result.stop.grace.endedBy, "elapsed");
  assert.match(report, /\| met \| `GRID systemName=Amamake` \| `t\+00:00:00  GRID {6}Amamake/);
  assert.match(report, /\| MISSING \| `SYSTEM toSystemName=Jita` can't happen \| not seen \|/);
  assert.match(report, /- `HERE` \*\*fired\*\*/);
  assert.match(report, /```text\n(.*\n){6}```/, "every event is in the report's timeline");
  assert.match(report, /STOP {6}stop condition met: HERE/);
  const record = resultRecord(result, { runID: "r1", scenarioFile: "t.json" });
  assert.strictEqual(record.exitCode, 1);
  assert.strictEqual(record.events, undefined, "events stay in timeline.jsonl");
});

test("grace ends once every expectation is met, but not before graceMin", async () => {
  const scenario = scenarioOf({
    until: { any: ["GRID"], from: "start", timeout: 5, grace: 4, graceMin: 0.3 },
    expect: ["GRID", "DESTROYED", "no DIVERGE"],
  });
  assert.strictEqual(scenario.until.graceMin, 0.3);
  const ops = fakeOps([
    { afterMs: 10, event: { kind: "GRID", systemName: "Amamake" } },
    { afterMs: 50, event: { kind: "DESTROYED", itemID: 7 } },
  ]);
  const started = Date.now();
  const result = await runScenario(scenario, ops);
  const took = Date.now() - started;
  assert.strictEqual(result.stop.grace.endedBy, "met");
  assert.ok(result.stop.grace.ms >= 290, `waited out graceMin (${result.stop.grace.ms} ms)`);
  assert.ok(took < 2000, `ended long before the 4 s grace (${took} ms)`);
  assert.strictEqual(result.passed, true);
  assert.match(renderReport(result, { runID: "r1", scenario, scenarioFile: "t.json" }),
    /then watched 0\.\d s of 4 s grace \(every expectation met\)/);
});

test("graceMin defaults to 5 s or the whole grace, and can't exceed grace", () => {
  assert.strictEqual(scenarioOf({ until: { any: ["GRID"], timeout: 5, grace: 20 }, expect: ["GRID"] }).until.graceMin, 5);
  assert.strictEqual(scenarioOf({ until: { any: ["GRID"], timeout: 5, grace: 2 }, expect: ["GRID"] }).until.graceMin, 2);
  assert.strictEqual(scenarioOf({ until: { any: ["GRID"], timeout: 5 }, expect: ["GRID"] }).until.graceMin, 0);
  assert.throws(() => scenarioOf({ until: { any: ["GRID"], timeout: 5, grace: 2, graceMin: 3 }, expect: ["GRID"] }),
    /until\.graceMin: seconds, from 0 to grace \(2\)/);
});

test("stop conditions match only events after setup unless until.from is start", async () => {
  const setup = ["undock", { wait: 0.15 }];
  const script = () => [{ afterMs: 10, event: { kind: "GRID", systemName: "Amamake" } }];
  const fromSetup = scenarioOf({ setup, until: { any: ["GRID"], timeout: 0.3 }, expect: ["GRID"] });
  assert.strictEqual(fromSetup.until.from, "setup");
  const afterSetup = await runScenario(fromSetup, fakeOps(script()));
  assert.strictEqual(afterSetup.stop.reason, "timeout", "the GRID seen during setup's wait doesn't stop the run");
  assert.strictEqual(afterSetup.passed, true, "expectations still match setup's events");
  assert.match(renderReport(afterSetup, { runID: "r", scenario: fromSetup }), /matched only against events after setup ended/);

  const fromStart = scenarioOf({ setup, until: { any: ["GRID"], from: "start", timeout: 2 }, expect: ["GRID"] });
  const anyTime = await runScenario(fromStart, fakeOps(script()));
  assert.strictEqual(anyTime.stop.reason, "until");
  assert.strictEqual(anyTime.stop.condition, "GRID");
  assert.match(renderReport(anyTime, { runID: "r", scenario: fromStart }), /since the watch began, setup included/);

  // The watch delivers lines up to 1.5 s late; a late line from setup still doesn't count.
  const late = await runScenario(scenarioOf({ until: { any: ["GRID"], timeout: 0.3 }, expect: ["GRID"] }),
    fakeOps([{ afterMs: 20, event: { kind: "GRID", atMs: Date.now() - 1000 } }]));
  assert.strictEqual(late.stop.reason, "timeout");
});

test("with every expectation met the run passes; a timeout is a stop, not a failure", async () => {
  const scenario = scenarioOf({ until: { any: ["DESTROYED self"], timeout: 0.2 }, expect: ["GRID", "no DIVERGE"] });
  const result = await runScenario(scenario, fakeOps([{ afterMs: 10, event: { kind: "GRID", systemName: "Amamake" } }]));
  assert.strictEqual(result.stop.reason, "timeout");
  assert.strictEqual(result.passed, true);
  assert.strictEqual(exitCodeFor(result), 0);
  assert.match(renderReport(result, { runID: "r", scenario }), /PASSED[\s\S]*\| clean \| `no DIVERGE` \| none \|[\s\S]*\*\*reached\*\*/);
});

test("an absent expectation that shows up fails the run", async () => {
  const scenario = scenarioOf({ until: { timeout: 0.2 }, expect: ["no DIVERGE reason=server-only"] });
  const result = await runScenario(scenario, fakeOps([{ afterMs: 10, event: { kind: "DIVERGE", reason: "server-only", label: "x" } }]));
  assert.deepStrictEqual(result.expectations.map((row) => [row.met, row.count]), [[false, 1]]);
  assert.strictEqual(exitCodeFor(result), 1);
});

test("a refused setup step ends the run there, and the server still goes down", async () => {
  const scenario = scenarioOf({ setup: ["undock", { slash: "/tr me Jita" }, { wait: 30 }], until: { timeout: 30 }, expect: ["GRID"] });
  const ops = fakeOps([{ afterMs: 10, event: { kind: "GRID" } }], { failStep: "slash" });
  const result = await runScenario(scenario, ops);
  assert.deepStrictEqual(ops.calls, ["up", "step:login", "watch", "step:undock", "step:slash", "down"]);
  assert.deepStrictEqual(result.failure, { stage: "setup", step: "slash /tr me Jita", error: "slash -> refused" });
  assert.strictEqual(exitCodeFor(result), 2);
  assert.match(renderReport(result, { runID: "r", scenario }), /DID NOT COMPLETE[\s\S]*\*\*setup failed\*\* at `slash \/tr me Jita`/);
});

test("a trigger with retry is tried again until the feature accepts it, and gives up after `for`", LU, async () => {
  const scenario = scenarioOf({ setup: [{ trigger: "hunt", as: "hunt", retry: { every: 0.05, for: 1 } }],
    until: { timeout: 1 }, expect: ["GRID"] });
  assert.match(describeStep(scenario.setup[1]), /trigger hunt as \$hunt \(retry every 0.05s for 1s\)/);
  const ops = fakeOps([{ afterMs: 10, event: { kind: "GRID" } }], { triggerReply: { trigger: "hunt", huntID: "h1" } });
  const step = ops.step;
  let refusals = 2;
  ops.step = async (bound) => {
    if (bound.type === "trigger" && refusals-- > 0) throw new Error("trigger hunt: observer-sensors-unavailable");
    return step(bound);
  };
  const result = await runScenario(scenario, ops);
  assert.strictEqual(result.failure, null);
  assert.deepStrictEqual(result.steps[1].bound, { hunt: ["h1"] });
  assert.match(result.steps[1].text, /\(attempt 3\)$/);

  refusals = Infinity;
  const gaveUp = await runScenario(scenario, ops);
  assert.match(gaveUp.failure.error, /observer-sensors-unavailable/);
  assert.ok(gaveUp.steps[1].ms < 1_500, "it stops retrying once another try would pass `for`");
  assert.throws(() => scenarioOf({ setup: [{ trigger: "hunt", retry: { for: 0 } }], until: { timeout: 1 }, expect: ["GRID"] }),
    /retry/);
});

test("waitFor holds setup until its condition, and a trigger's binding reaches later steps and conditions", LU, async () => {
  const scenario = scenarioOf({
    setup: [{ trigger: "scout", as: "scout" }, { waitFor: "ENTER flightID=$scout", timeout: 2 },
      { trigger: "materialize", flight: "$scout" }],
    until: { any: ["ARRIVE flightID=$scout"], timeout: 2 },
    expect: ["ENTER flightID=$scout"],
  });
  const ops = fakeOps([
    { afterMs: 30, event: { kind: "ENTER", flightID: "other" } },
    { afterMs: 30, event: { kind: "ENTER", flightID: "f1" } },
    { afterMs: 30, event: { kind: "ARRIVE", groupKey: "flight:f1", ext: { lu: { flightID: "f1" } }, members: [] } },
  ]);
  const result = await runScenario(scenario, ops);
  assert.deepStrictEqual(ops.calls, ["up", "step:login", "watch", "step:trigger", "step:trigger:f1", "down"]);
  assert.deepStrictEqual(result.bindings, { scout: ["f1"] });
  assert.strictEqual(result.stop.reason, "until");
  assert.strictEqual(result.passed, true);
  const kinds = result.events.map((event) => `${event.kind}${event.flightID ? `:${event.flightID}` : ""}`);
  assert.ok(kinds.indexOf("STEP") < kinds.indexOf("ENTER:f1"));
});

test("a waitFor that never sees its condition fails setup; a watch that ends early is a failed run", LU, async () => {
  const waiting = await runScenario(scenarioOf({ setup: [{ waitFor: "HUNT self", timeout: 0.1 }], until: { timeout: 1 }, expect: ["GRID"] }),
    fakeOps([]));
  assert.match(waiting.failure.error, /not seen in 0.1s/);
  const ended = await runScenario(scenarioOf({ until: { timeout: 2 }, expect: ["GRID"] }),
    fakeOps([{ afterMs: 10, event: { kind: "GRID" } }, { afterMs: 10, event: "END" }]));
  assert.strictEqual(ended.stop.reason, "watch-ended");
  assert.match(ended.failure.error, /ended early \(session-gone\)/);
  assert.strictEqual(ended.expectations[0].met, true, "what was seen is still judged");
});

test("a run that can't boot reports that and still calls down", async () => {
  const ops = fakeOps([]);
  ops.up = async () => { throw new Error("port(s) in use: gateway :30002"); };
  const result = await runScenario(scenarioOf({ until: { timeout: 1 }, expect: ["GRID"] }), ops);
  assert.deepStrictEqual(result.failure, { stage: "up", error: "port(s) in use: gateway :30002" });
  assert.deepStrictEqual(ops.calls, ["down"]);
  assert.strictEqual(result.stop.reason, "up-failed");
  assert.strictEqual(exitCodeFor(result), 2);
});

test("an interrupt stops the run and still takes the server down", async () => {
  const controller = new AbortController();
  const ops = fakeOps([{ afterMs: 10, event: { kind: "GRID" } }]);
  setTimeout(() => controller.abort(), 60);
  const result = await runScenario(scenarioOf({ until: { timeout: 30 }, expect: ["GRID"] }), ops, { signal: controller.signal });
  assert.strictEqual(result.stop.reason, "interrupted");
  assert.strictEqual(ops.calls[ops.calls.length - 1], "down");
  assert.strictEqual(exitCodeFor(result), 2);
});

test("player action steps load in setup and during, with their targets, modules and bindings checked", LU, () => {
  const scenario = scenarioOf({
    setup: ["undock", { loadAmmo: "weapons", charge: "EMP S" }, { trigger: "fleet", family: "police", to: "self", as: "police" }],
    during: [{ lock: "flight=$police", as: "mark", retry: { every: 5, for: 60 } }, { activate: "weapons", target: "$mark", once: true },
      { orbit: "$mark", range: 2000 }, "stop", { wait: 900 }],
    watch: { client: "fx" },
    until: { any: ["DESTROYED itemID=$mark"], timeout: 600 },
    expect: ["FX self targetID=$mark", "TARGET sourceLabel=self targetID=$mark locked"],
  });
  assert.deepStrictEqual(scenario.setup[2].action, { type: "loadAmmo", modules: "weapons", charge: "EMP S" });
  assert.deepStrictEqual(scenario.during.map((step) => step.type), ["lock", "activate", "orbit", "stop", "wait"]);
  assert.deepStrictEqual(scenario.during[0].action, { type: "lock", target: "flight=$police" });
  assert.deepStrictEqual(scenario.during[0].retry, { every: 5, for: 60 });
  assert.deepStrictEqual(scenario.during[1].action, { type: "activate", modules: "weapons", target: "$mark", once: true });
  assert.strictEqual(describeStep(scenario.during[2]), "orbit $mark range 2,000 m");
  assert.ok(scenario.bindings.includes("mark"));
  // A during wait runs beside until.timeout, so it adds nothing to the budget.
  assert.doesNotThrow(() => scenarioOf({ during: [{ wait: 2900 }], until: { timeout: 600 }, expect: ["GRID"] }));

  let error;
  try {
    scenarioOf({
      setup: ["undock", { lock: "$nope" }, { activate: "bogus~x" }, { orbit: "npc", range: -1 }, { loadAmmo: "weapons" },
        { stop: "now" }, { lock: "npc", charge: "EMP S" }],
      during: [{ login: true }, { approach: true }],
      until: { timeout: 5 },
      expect: ["GRID"],
    });
  } catch (caught) {
    error = caught;
  }
  const text = error.problems.join("\n");
  for (const pattern of [
    /setup\[1\].target: no earlier step binds \$nope/,
    /setup\[2\]: modules: can't read "bogus~x"/,
    /setup\[3\]: range: metres, 0 or more/,
    /setup\[4\]: loadAmmo needs a charge/,
    /setup\[5\]: "stop" or \{ "stop": true \}/,
    /setup\[6\].charge: unknown key for lock/,
    /during\[0\]: login is a setup step/,
    /during\[1\]: approach needs a target/,
  ]) {
    assert.match(text, pattern);
  }
});

function actionOps(script, { lockOK = true } = {}) {
  const ops = fakeOps(script);
  const step = ops.step;
  ops.step = async (bound, bindings) => {
    if (!bound.action) return step(bound);
    ops.calls.push(`act:${bound.action.type}:${bound.action.target || bound.action.modules || ""}:${JSON.stringify(bindings)}`);
    if (bound.action.type === "lock") return { ok: lockOK, text: lockOK ? "locked Patrol #77" : "not locked after 30s", ids: ["77"] };
    return { ok: true, text: `${bound.action.type} ok`, ids: [] };
  };
  return ops;
}

test("during steps run after setup, beside the stop conditions, and stop with the run", async () => {
  const scenario = scenarioOf({
    during: [{ lock: "nearest npc", as: "mark" }, { activate: "weapons", target: "$mark" }, { wait: 30 }],
    until: { any: ["DAMAGE itemID=$mark"], timeout: 3 },
    expect: ["DAMAGE itemID=$mark"],
  });
  const ops = actionOps([{ afterMs: 150, event: { kind: "DAMAGE", itemID: 77, label: "Patrol", layer: "shield", fromPct: 100, toPct: 80 } }]);
  const started = Date.now();
  const result = await runScenario(scenario, ops);
  assert.ok(Date.now() - started < 2000, "the 30 s during wait ends when the stop condition fires");
  assert.deepStrictEqual(ops.calls, ["up", "step:login", "watch", "step:undock",
    'act:lock:nearest npc:{}', 'act:activate:$mark:{"mark":["77"]}', "down"]);
  assert.strictEqual(result.stop.reason, "until");
  assert.strictEqual(result.failure, null);
  assert.strictEqual(result.passed, true);
  const during = result.steps.filter((step) => step.phase === "during");
  assert.deepStrictEqual(during.map((step) => [step.step, step.ok, Boolean(step.stopped)]),
    [["lock nearest npc as $mark", true, false], ["activate weapons at $mark", true, false], ["wait 30s", false, true]]);
  const stepEvents = result.events.filter((event) => event.kind === "STEP" && event.phase === "during");
  assert.strictEqual(stepEvents.length, 2, "a step cut short by the stop writes no STEP line");
  const report = renderReport(result, { runID: "r", scenario });
  assert.match(report, /## During\n\nPlayer actions and waits run after setup/);
  assert.match(report, /\| 3 \| t\+00:00:0\d \| `wait 30s` \| stopped: the run stopped first \|/);
  assert.match(report, /\| 1 \| t\+00:00:0\d \| `lock nearest npc as \$mark` \| ok: locked Patrol #77 \$mark=77 \|/);
});

test("a during step that fails ends the run as not completed", async () => {
  const scenario = scenarioOf({
    during: [{ lock: "nearest npc", as: "mark" }, { activate: "weapons", target: "$mark" }],
    until: { timeout: 5 },
    expect: ["GRID"],
  });
  const ops = actionOps([{ afterMs: 10, event: { kind: "GRID" } }], { lockOK: false });
  const result = await runScenario(scenario, ops);
  assert.strictEqual(result.stop.reason, "during-failed");
  assert.deepStrictEqual(result.failure, { stage: "during", step: "lock nearest npc as $mark", error: "not locked after 30s" });
  assert.ok(!ops.calls.some((call) => call.startsWith("act:activate")), "the steps after it don't run");
  assert.strictEqual(exitCodeFor(result), 2);
  assert.match(renderReport(result, { runID: "r", scenario }), /\*\*during failed\*\* at `lock nearest npc as \$mark`/);
});

test("a bare name is the tree's scenario first, then the core's, then a plugin's", (t) => {
  const { scenarioPath } = require("../core/scenario");
  const os = require("os");
  const treeDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tree-scenarios-"));
  t.after(() => fs.rmSync(treeDir, { recursive: true, force: true }));
  const registry = emptyRegistry();
  const core = path.resolve(__dirname, "..", "scenarios", "smoke-undock.json");
  assert.strictEqual(scenarioPath("smoke-undock", { treeDir, registry }), core);
  fs.writeFileSync(path.join(treeDir, "smoke-undock.json"), "{}\n");
  assert.strictEqual(scenarioPath("smoke-undock", { treeDir, registry }), path.join(treeDir, "smoke-undock.json"));
  assert.strictEqual(scenarioPath("not-anywhere", { treeDir, registry }), path.join(treeDir, "not-anywhere.json"),
    "a new name is the tree's");
  assert.deepStrictEqual(listScenarios({ treeDir, registry }).find((row) => row.name === "smoke-undock").file,
    path.join(treeDir, "smoke-undock.json"));
});

test("scenario new writes a template that checks out, or a copy, and won't replace one", (t) => {
  const os = require("os");
  const { newScenario, loadScenario } = require("../core/scenario");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-scenario-new-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { treeDir: path.join(root, "tree"), draftDir: path.join(root, "drafts"), registry: emptyRegistry() };
  const draft = newScenario("my-check", dirs);
  assert.strictEqual(draft.file, path.join(dirs.draftDir, "my-check.json"));
  assert.strictEqual(draft.from, null);
  const loaded = loadScenario(draft.file, { ...dirs, worldExists: () => true });
  assert.strictEqual(loaded.scenario.name, "my-check");
  assert.throws(() => newScenario("my-check", dirs), /already exists; pick another name, or pass --force/);
  assert.doesNotThrow(() => newScenario("my-check", { ...dirs, force: true }));
  const copy = newScenario("fight", { ...dirs, from: "smoke-undock", save: true });
  assert.strictEqual(copy.file, path.join(dirs.treeDir, "fight.json"));
  assert.match(JSON.parse(fs.readFileSync(copy.file, "utf8")).description, /^Undock and read the grid/);
  assert.throws(() => newScenario("x", { ...dirs, from: "nope" }), /no scenario nope to copy/);
  assert.throws(() => newScenario("bad name", dirs), /needs a name/);
});
