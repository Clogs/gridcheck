"use strict";

// `gridcheck watch`, server side (bridge/watch.js, and the Living Universe plugin's
// join and off-grid tracker): the grid differ, the LU join, the off-grid
// tracker, the plugin hooks, the /watch route and the NDJSON stream, each from
// injected seams so no booted server is needed.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createGridDiffer,
  createGridWatch,
  createKillmailFinder,
  healthBand,
} = require("../bridge/watch");
const { createLuAnnotate, createLuJoin, describeDecision } = require("../plugins/lu/server/join");
const { createOffGridTracker } = require("../plugins/lu/server/offGrid");
const { createLuOnGrid } = require("../plugins/lu/server/onGrid");
const { createAgentBridgeRoutes } = require("../bridge/routes");
const { createAgentBridgeHttp } = require("../bridge/http");

const SELF = { kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", name: "Rifter", mode: "STOP",
  distanceMeters: 0, position: { x: 0, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };

function grid(entities, extra = {}) {
  return {
    inSpace: true,
    solarSystemID: 30002537,
    systemName: "Amamake",
    security: 0.4,
    self: { itemID: 1, typeName: "Rifter", mode: "STOP" },
    entities: [SELF, ...entities],
    ...extra,
  };
}

// A row as the watch's annotate leaves it: the lu plugin's join at ext.lu,
// its group key, and the hunter reports its onGrid hook reads at hidden.lu.
function luRow(lu, sightings = []) {
  return {
    groupKey: lu.flightID ? `flight:${lu.flightID}` : null,
    ext: { lu },
    hidden: sightings.length ? { lu: { sightings } } : undefined,
  };
}

function npc(itemID, overrides = {}) {
  return {
    kind: "ship", itemID, name: `Guristas ${itemID}`, typeName: "Worm", isNpc: true, npcEntityType: "npc",
    mode: "ORBIT", distanceMeters: 24_000, position: { x: 24_000, y: 0, z: 0 },
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, lockedTargetIDs: [],
    ...luRow({ flightID: "living_flight_4420", corporation: "Guristas", family: "pirate", huntPhase: "committed",
      decision: "hunt:committed/tackle" }),
    ...overrides,
  };
}

// The differ with the lu plugin's onGrid hook, as a watch builds it.
function luDiffer() {
  return createGridDiffer({ gridHooks: [{ name: "lu", step: createLuOnGrid().watch({}).step }] });
}

const kinds = (events) => events.map((event) => event.kind);

test("health bands are quarters, and 100% is its own band", () => {
  assert.strictEqual(healthBand(1), 4);
  assert.strictEqual(healthBand(0.99), 3);
  assert.strictEqual(healthBand(0.62), 2);
  assert.strictEqual(healthBand(0.1), 0);
  assert.strictEqual(healthBand(null), null);
});

test("the first sample is a baseline: one GRID line, then what is present, grouped by groupKey", () => {
  const differ = createGridDiffer();
  const events = differ.step(grid([npc(2), npc(3), { kind: "stargate", itemID: 9, name: "Stargate" }]), 1000);
  assert.deepStrictEqual(kinds(events), ["GRID", "PRESENT"]);
  assert.strictEqual(events[1].count, 2);
  assert.strictEqual(events[1].groupKey, "flight:living_flight_4420");
  assert.strictEqual(events[1].ext.lu.family, "pirate", "the plugins' data rides on the event");
  assert.strictEqual(events[1].hidden, undefined, "a plugin's working data never does");
  assert.strictEqual(events[0].tracked, 3, "celestials are not tracked");
  const alone = createGridDiffer().step(grid([npc(2, { groupKey: null }), npc(3, { groupKey: null })]), 1000);
  assert.deepStrictEqual(alone.map((event) => `${event.kind}:${event.count || ""}`), ["GRID:", "PRESENT:1", "PRESENT:1"],
    "balls in no group are one event each");
});

test("a gang that warps in is one ARRIVE, with the distance it landed at", () => {
  const differ = createGridDiffer();
  differ.step(grid([]), 1000);
  const inWarp = differ.step(grid([
    npc(2, { mode: "WARP", distanceMeters: 900_000 }),
    npc(3, { mode: "WARP", distanceMeters: 900_000 }),
  ]), 3000);
  assert.deepStrictEqual(kinds(inWarp), [], "nothing until they drop out of warp");
  const landed = differ.step(grid([npc(2), npc(3, { lockedTargetIDs: [1] })]), 5000);
  assert.deepStrictEqual(kinds(landed), ["ARRIVE", "TARGET"]);
  assert.strictEqual(landed[0].count, 2);
  assert.strictEqual(landed[0].warpIn, true);
  assert.strictEqual(landed[0].distanceMeters, 24_000);
  assert.strictEqual(landed[0].firstSeenAtMs, 3000);
  assert.strictEqual(landed[1].targetLabel, "self");
  assert.strictEqual(landed[1].locked, true);
});

test("mode, lock and damage changes are reported once each", () => {
  const differ = createGridDiffer();
  differ.step(grid([npc(2)]), 1000);
  const events = differ.step({
    ...grid([npc(2, { mode: "FOLLOW", lockedTargetIDs: [1] })]),
    entities: [{ ...SELF, shieldRatio: 0.62 }, npc(2, { mode: "FOLLOW", lockedTargetIDs: [1] })],
  }, 3000);
  assert.deepStrictEqual(kinds(events).sort(), ["DAMAGE", "MODE", "TARGET"]);
  const damage = events.find((event) => event.kind === "DAMAGE");
  assert.deepStrictEqual([damage.label, damage.layer, damage.fromPct, damage.toPct], ["self", "shield", 100, 62]);
  const again = differ.step({
    ...grid([]),
    entities: [{ ...SELF, shieldRatio: 0.6 }, npc(2, { mode: "FOLLOW", lockedTargetIDs: [1] })],
  }, 5000);
  assert.deepStrictEqual(kinds(again), [], "same band, same mode, same lock: nothing");
  const regen = differ.step({ ...grid([]), entities: [{ ...SELF, shieldRatio: 0.8 }, npc(2, { mode: "FOLLOW", lockedTargetIDs: [1] })] }, 7000);
  assert.deepStrictEqual(kinds(regen), [], "climbing back up a band is not damage");
  const healed = differ.step({ ...grid([]), entities: [{ ...SELF, shieldRatio: 1 }, npc(2, { mode: "FOLLOW", lockedTargetIDs: [1] })] }, 9000);
  assert.deepStrictEqual(healed.map((event) => `${event.kind}:${event.toPct}`), ["DAMAGE:100"], "back to full is reported");
});

test("an NPC's decision change is one DECISION event, with its target", () => {
  const differ = createGridDiffer();
  differ.step(grid([npc(2, { decision: "idle-anchor-orbit" }), npc(3)]), 1000);
  const engaged = differ.step(grid([npc(2, { decision: "engage", targetEntityID: 1 }), npc(3)]), 3000);
  assert.deepStrictEqual(kinds(engaged), ["DECISION"]);
  assert.deepStrictEqual([engaged[0].from, engaged[0].to, engaged[0].targetLabel], ["idle-anchor-orbit", "engage", "self"]);
  assert.strictEqual(engaged[0].ext.lu.family, "pirate");
  assert.deepStrictEqual(kinds(differ.step(grid([npc(2, { decision: "engage", targetEntityID: 1 }), npc(3)]), 5000)), [],
    "the same decision again is not news");
  const { formatTimelineEvent } = require("../core/timeline");
  assert.match(formatTimelineEvent({ ...engaged[0], t: 3000 }), /decided idle-anchor-orbit -> engage on self/);
});

test("a ship replaced by a wreck is DESTROYED; one that warps away is a LEAVE", () => {
  const differ = createGridDiffer();
  differ.step(grid([npc(2), npc(3, { mode: "WARP", groupKey: null, ext: null })]), 1000);
  const events = differ.step(grid([
    { kind: "wreck", itemID: 50, name: "Worm Wreck", position: { x: 24_100, y: 0, z: 0 }, distanceMeters: 24_100 },
  ]), 3000);
  assert.deepStrictEqual(kinds(events), ["DESTROYED", "LEAVE"]);
  assert.strictEqual(events[0].wreckID, 50);
  assert.strictEqual(events[0].groupKey, "flight:living_flight_4420");
  assert.strictEqual(events[0].ext.lu.corporation, "Guristas");
  assert.strictEqual(events[1].warped, true);
});

test("the lu onGrid hook: a hunter report on self is one SIGHTING until it goes stale", () => {
  const differ = luDiffer();
  const report = { observerID: 2, source: "sighting", certainty: "confirmed", observedAtMs: 10_000 };
  const scout = (observedAtMs) => npc(2, { distanceMeters: 182_000,
    ...luRow({ flightID: "living_flight_4411" }, [{ ...report, observedAtMs }]) });
  const first = differ.step(grid([scout(10_000)]), 10_000);
  assert.deepStrictEqual(kinds(first), ["GRID", "PRESENT", "SIGHTING"]);
  assert.strictEqual(first[2].distanceMeters, 182_000);
  assert.strictEqual(first[2].lu.flightID, "living_flight_4411");
  assert.strictEqual(first[1].hidden, undefined, "the reports stay off the PRESENT");
  assert.deepStrictEqual(kinds(differ.step(grid([scout(15_000)]), 15_000)), []);
  assert.deepStrictEqual(kinds(differ.step(grid([scout(80_000)]), 80_000)), ["SIGHTING"]);
  assert.deepStrictEqual(kinds(createGridDiffer().step(grid([scout(10_000)]), 10_000)), ["GRID", "PRESENT"],
    "without the plugin's hook there is no SIGHTING");
});

test("the lu onGrid hook names the ball a decision is about, before the events are built", () => {
  const differ = luDiffer();
  const decided = (decision) => npc(2, luRow({ flightID: "f1", decision }));
  const [, present] = differ.step(grid([decided("hunt:committed+engaging:1")]), 1000);
  assert.strictEqual(present.ext.lu.decision, "hunt:committed+engaging:self");
  const mode = differ.step(grid([{ ...decided("fleeing:3"), mode: "WARP" }, npc(3, { name: "Guristas Mule" })]), 3000)
    .find((event) => event.kind === "MODE");
  assert.strictEqual(mode.ext.lu.decision, "fleeing:Guristas Mule");
});

test("the lu annotate hook splits its join: data on events, reports for onGrid, family for frames", () => {
  const annotate = createLuAnnotate({ annotate: () => ({ flightID: "f1", family: "police", decision: "idle",
    sightings: [{ observerID: 2 }] }) });
  assert.deepStrictEqual(annotate({ itemID: 2, livingUniverseFlightID: "f1" }, { row: { isNpc: true } }), {
    groupKey: "flight:f1",
    ext: { flightID: "f1", family: "police", decision: "idle" },
    hidden: { sightings: [{ observerID: 2 }] },
    pos: { family: "police" },
  });
  assert.strictEqual(annotate({ itemID: 1 }, { row: { isSelf: true } }), null, "a player costs one check");
});

test("changing system resets the baseline and says so", () => {
  const differ = createGridDiffer();
  differ.step(grid([npc(2)]), 1000);
  const events = differ.step(grid([], { solarSystemID: 30002538, systemName: "Siseide" }), 3000);
  assert.deepStrictEqual(kinds(events), ["SYSTEM", "GRID"]);
  assert.strictEqual(events[0].toSystemName, "Siseide");
});

test("self jumping to another grid in the same system is a new baseline, not a LEAVE", () => {
  const differ = createGridDiffer();
  differ.step(grid([npc(2)]), 1000);
  const moved = { ...SELF, position: { x: 1.8e12, y: 0, z: 0 } };
  const events = differ.step({ ...grid([]), entities: [moved] }, 3000);
  assert.deepStrictEqual(kinds(events), ["MOVED", "GRID"]);
});

test("the decision reads the controller fields that decide one", () => {
  assert.strictEqual(describeDecision(null, null), null);
  assert.strictEqual(describeDecision({ controllerPaused: true, pausedReason: "dormant" }, null), "paused:dormant");
  assert.strictEqual(describeDecision({ manualOrder: { kind: "orbit" } }, null), "order:orbit");
  assert.strictEqual(describeDecision({ currentTargetID: 9 }, { mode: "committed", role: "tackle" }), "hunt:committed/tackle");
  assert.strictEqual(describeDecision({ currentTargetID: 9 }, { mode: "staging" }), "engaging:9");
  assert.strictEqual(describeDecision({ returningHome: true }, null), "returning-home");
  assert.strictEqual(describeDecision({}, { mode: "staging", huntID: "h1" }), "hunt:staging");
  assert.strictEqual(describeDecision({}, { mode: "staging" }), "idle", "the no-hunt default is not a hunt");
  assert.strictEqual(describeDecision({}, null), "idle");
});

test("after a think, the decision is the branch tickController returned through", () => {
  assert.strictEqual(describeDecision({ lastDecision: "engage", currentTargetID: 9 }, null), "engaging:9");
  assert.strictEqual(describeDecision({ lastDecision: "engage", currentTargetID: 9 }, { mode: "committed", role: "tackle", huntID: "h" }),
    "hunt:committed/tackle+engaging:9");
  assert.strictEqual(describeDecision({ lastDecision: "flee", currentTargetID: 9 }, null), "fleeing:9");
  assert.strictEqual(describeDecision({ lastDecision: "hunt-order" }, { mode: "stalking", huntID: "h" }), "hunt:stalking");
  assert.strictEqual(describeDecision({ lastDecision: "order-stop", manualOrder: { kind: "stop" } }, null), "order-stop:stop");
  assert.strictEqual(describeDecision({ lastDecision: "idle-anchor-orbit" }, null), "idle-anchor-orbit");
  assert.strictEqual(describeDecision({ lastDecision: "engage", controllerPaused: true, pausedReason: "dormant" }, null),
    "paused:dormant", "a paused controller is not thinking");
});

test("the LU join names the flight, the hunt it serves and the reports on self, without writing", () => {
  const leader = { flightID: "f1", family: "pirate", homeCorporationName: "Guristas", pirateRole: "scout",
    pirateHunt: { id: "pirate-hunt:f1:1", phase: "stalking", reason: "scout-discovery" } };
  const support = { flightID: "f2", family: "pirate", huntLeaderID: "f1", missionJourney: { kind: "pirate_hunt_support", stage: "outbound" } };
  const reports = [{ targetCharacterID: 7, observerID: 2, source: "sighting", observedAtMs: 5 }, { targetCharacterID: 8 }];
  const controller = { currentTargetID: 0, hunterReports: reports };
  const flights = { f1: leader, f2: support };
  const join = createLuJoin({
    inspect: { getFlightByID: (id) => flights[id] || null },
    controllerFor: () => controller,
    huntOrderFor: () => ({ mode: "stalking" }),
  });
  const onScout = join.annotate({ itemID: 2, livingUniverseFlightID: "f1" }, 0, 7);
  assert.strictEqual(onScout.huntRole, "leader");
  assert.strictEqual(onScout.huntReason, "scout-discovery");
  assert.strictEqual(onScout.decision, "hunt:stalking");
  assert.strictEqual(onScout.sightings.length, 1);
  const onSupport = join.annotate({ itemID: 3, livingUniverseFlightID: "f2" }, 0, 7);
  assert.strictEqual(onSupport.huntRole, "support");
  assert.strictEqual(onSupport.huntPhase, "stalking");
  assert.strictEqual(onSupport.journeyStage, "outbound");
  assert.strictEqual(controller.hunterReports, reports, "reports are read, not pruned");
  assert.strictEqual(controller.hunterReports.length, 2);
  assert.strictEqual(join.annotate({ itemID: 4 }, 0, 7) !== null, true, "a controller alone still annotates");
});

function offGridWorld() {
  const hunt = {
    id: "pirate-hunt:scout:1000",
    phase: "stalking",
    reason: "scout-discovery",
    report: { systemID: 30002537, targetCharacterID: 7, targetID: 1, observerID: 2, source: "sighting",
      location: { position: { x: 182_000, y: 0, z: 0 } } },
    supportIDs: ["gang"],
    trace: [{ atMs: 1000, phase: "stalking", reason: "scout-discovery" }],
  };
  const flights = {
    scout: { flightID: "scout", family: "pirate", pirateRole: "scout", homeCorporationName: "Guristas",
      currentSystemID: 30002537, actorIDs: ["a"], phase: "mission_holding", pirateHunt: hunt },
    gang: { flightID: "gang", family: "pirate", homeCorporationName: "Guristas", currentSystemID: 30002540,
      actorIDs: ["b", "c", "d", "e"], phase: "mission_outbound",
      missionJourney: { kind: "pirate_hunt_support", status: "outbound", ownerID: hunt.id, startedAtMs: 2000,
        dueAtMs: 97_000, destination: { systemID: 30002537 }, systemIDs: [30002540, 30002537], cursor: 0 } },
    other: { flightID: "other", family: "freight", currentSystemID: 30009999, actorIDs: ["f"] },
  };
  return { flights, hunt };
}

test("off grid: a hunt on self, a gang heading here with its ETA, then its arrival", () => {
  const { flights, hunt } = offGridWorld();
  const inspect = { listFlights: () => Object.values(flights), getFlightByID: (id) => flights[id] || null };
  const tracker = createOffGridTracker({ inspect, characterID: 7, startedAtMs: 0,
    describeSystem: (id) => ({ 30002537: { name: "Amamake" }, 30002540: { name: "Tama" } }[id] || null) });
  const context = (nowMs) => ({ nowMs, egoPosition: { x: 0, y: 0, z: 0 }, labelFor: (id) => (id === 1 ? "self" : `#${id}`) });

  const first = tracker.scan(30002537, context(2000)).events;
  assert.deepStrictEqual(kinds(first), ["HERE", "HUNT", "INCOMING"]);
  assert.deepStrictEqual(first[0].flights.map((flight) => flight.flightID), ["scout"]);
  assert.deepStrictEqual(first[0].byFamily, { pirate: 1 });
  assert.strictEqual(first[1].targetSelf, true);
  assert.strictEqual(first[1].distanceMeters, 182_000);
  assert.strictEqual(first[1].initial, true);
  assert.strictEqual(first[2].etaMs, 95_000);
  assert.strictEqual(first[2].count, 4);
  assert.strictEqual(first[2].systemName, "Tama");

  assert.deepStrictEqual(kinds(tracker.scan(30002537, context(4000)).events), [], "nothing new, nothing said");

  hunt.phase = "committed";
  hunt.trace.push({ atMs: 90_000, phase: "committed", reason: "confirmed-nearby-support-and-fitted-tackle" });
  flights.gang.currentSystemID = 30002537;
  flights.gang.missionJourney.status = "arrived";
  const later = tracker.scan(30002537, context(96_000)).events;
  assert.deepStrictEqual(kinds(later), ["HUNT", "ENTER"]);
  assert.strictEqual(later[0].reason, "confirmed-nearby-support-and-fitted-tackle");
  assert.strictEqual(later[0].atMs, 90_000, "a hunt step keeps the time it happened");
  assert.strictEqual(later[1].flightID, "gang");

  flights.scout.lastPirateHunt = { ...hunt, reason: "fleet-lost",
    trace: [...hunt.trace, { atMs: 120_000, phase: "returning", reason: "fleet-lost" }] };
  flights.scout.pirateHunt = null;
  const ended = tracker.scan(30002537, context(121_000)).events;
  assert.deepStrictEqual(ended.map((event) => `${event.kind}:${event.phase}`), ["HUNT:returning", "HUNT:ended"]);
});

// A restored world resumes its clock where it was saved, so LU time can sit hours
// behind the real time the watch keeps. Hunt steps and ETAs are read on LU time.
test("off grid: hunt times and ETAs on a world whose LU clock runs behind are put on the watch's clock", () => {
  const { flights } = offGridWorld();
  const behind = 12 * 3600_000;
  const inspect = { listFlights: () => Object.values(flights), getFlightByID: (id) => flights[id] || null };
  const tracker = createOffGridTracker({ inspect, characterID: 7, startedAtMs: 0, luNowMs: () => 2000 });
  const events = tracker.scan(30002537, { nowMs: 2000 + behind, labelFor: () => null }).events;
  const hunt = events.find((event) => event.kind === "HUNT");
  const incoming = events.find((event) => event.kind === "INCOMING");
  assert.strictEqual(hunt.atMs, 1000 + behind);
  assert.strictEqual(incoming.etaMs, 95_000);
  assert.strictEqual(incoming.dueAtMs, 97_000 + behind);
});

test("off grid: fights and losses in the watched system only", () => {
  let flights = [];
  let losses = [];
  const inspect = {
    listFlights: () => flights,
    getFlightByID: (id) => flights.find((flight) => flight.flightID === id) || null,
    listConflicts: () => { throw new Error("the whole-universe status must not be built per scan"); },
    listShipLosses: (options) => ({ losses: losses.filter((row) => row.lostAtMs >= options.sinceMs) }),
  };
  const tracker = createOffGridTracker({ inspect, startedAtMs: 1000 });
  flights = [
    { flightID: "a", currentSystemID: 30002537, actorIDs: ["1", "2"], encounterID: "e1" },
    { flightID: "b", currentSystemID: 30002537, actorIDs: ["3"], encounterID: "e1" },
    { flightID: "c", currentSystemID: 1, actorIDs: ["4"], encounterID: "e2" },
  ];
  const first = tracker.scan(30002537, { nowMs: 2000 }).events;
  assert.deepStrictEqual(first.map((event) => `${event.kind}:${event.status || ""}`), ["HERE:", "ENGAGEMENT:present"]);
  assert.strictEqual(first[1].shipCount, 3);
  assert.deepStrictEqual(first[1].flightIDs, ["a", "b"]);
  flights = flights.map((flight) => ({ ...flight, encounterID: null }));
  losses = [{ lostAtMs: 3000, systemID: 30002537, shipName: "Worm", cause: "physical" },
    { lostAtMs: 3000, systemID: 1, shipName: "Elsewhere" }];
  const later = tracker.scan(30002537, { nowMs: 4000 }).events;
  assert.deepStrictEqual(later.map((event) => event.kind), ["ENGAGEMENT", "LOSS"]);
  assert.strictEqual(later[0].status, "end");
  assert.strictEqual(tracker.scan(30002537, { nowMs: 5000 }).events.length, 0, "a loss is reported once");
});

test("off grid: an engagement carries its phase and kind, and a phase change is news", () => {
  const encounter = { encounterID: "e1", phase: "staging", kind: "pirate_interdiction", battleClass: "skirmish" };
  let lookups = 0;
  const flights = [{ flightID: "a", currentSystemID: 30002537, actorIDs: ["1"], encounterID: "e1" }];
  const tracker = createOffGridTracker({ startedAtMs: 1000, inspect: {
    listFlights: () => flights,
    getEncounterByID: (id) => { lookups += 1; return id === "e1" ? encounter : null; },
  } });
  const first = tracker.scan(30002537, { nowMs: 2000 }).events.find((event) => event.kind === "ENGAGEMENT");
  assert.deepStrictEqual([first.phase, first.encounterKind, first.battleClass], ["staging", "pirate_interdiction", "skirmish"]);
  assert.strictEqual(tracker.scan(30002537, { nowMs: 3000 }).events.length, 0);
  encounter.phase = "active";
  const changed = tracker.scan(30002537, { nowMs: 4000 }).events;
  assert.deepStrictEqual(changed.map((event) => `${event.kind}:${event.status}:${event.phase}`), ["ENGAGEMENT:changed:active"]);
  assert.strictEqual(lookups, 3, "one keyed read per encounter per scan");
});

test("killmails: the newest unused one for this victim type and system, written since the watch began", () => {
  const filetime = (ms) => String((BigInt(ms) * 10_000n) + 116_444_736_000_000_000n);
  const records = [
    { killID: 12, victimShipTypeID: 587, solarSystemID: 30002537, killTime: filetime(20_000) },
    { killID: 11, victimShipTypeID: 587, solarSystemID: 30002537, killTime: filetime(1_000) },
  ];
  const find = createKillmailFinder({ listKillmailsForCharacter: () => records }, 15_000);
  const query = { self: true, characterID: 7, typeID: 587, systemID: 30002537 };
  assert.strictEqual(find(query), 12);
  assert.strictEqual(find(query), null, "each killmail names one loss; 11 is older than the watch");
});

function sink() {
  const lines = [];
  return { lines, write: (event) => lines.push(event), closed: () => false };
}

test("a watch runs on its clock, streams START ... END and stops when the session goes", async () => {
  let clock = 0;
  let sessionAlive = true;
  const samples = [grid([]), grid([npc(2)]), grid([npc(2, { mode: "WARP" })])];
  let index = 0;
  const watch = createGridWatch({
    findSession: () => (sessionAlive ? { characterID: 7 } : null),
    readGrid: () => samples[Math.min(index++, samples.length - 1)],
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => {
      clock += ms;
      if (index >= samples.length) sessionAlive = false;
    },
  });
  const out = sink();
  const result = await watch.run({ characterID: 7, forMs: 60_000, everyMs: 2000, offGridEveryMs: 2000 }, out);
  assert.strictEqual(result.reason, "session-gone");
  assert.deepStrictEqual(kinds(out.lines), ["START", "GRID", "ARRIVE", "MODE", "END"]);
  assert.deepStrictEqual(out.lines.map((event) => event.t), [0, 0, 2000, 4000, 6000]);
  assert.strictEqual(out.lines[4].samples, 3);
  assert.strictEqual(watch.busy(), false);
});

test("/watch validates, refuses when busy, and hands the HTTP layer a stream", () => {
  let busy = false;
  const calls = [];
  const routes = createAgentBridgeRoutes({
    findSession: (id) => (id === 7 ? { characterID: 7 } : null),
    watcher: { busy: () => busy, run: (params, out) => { calls.push(params); out.write({ kind: "END" }); } },
  });
  assert.strictEqual(routes.handle("POST", "/watch", {}, { characterID: 8 }).statusCode, 409);
  assert.strictEqual(routes.handle("POST", "/watch", {}, { characterID: 7, everySeconds: 0.1 }).statusCode, 400);
  assert.strictEqual(routes.handle("POST", "/watch", {}, { characterID: 7, forSeconds: 99_999 }).statusCode, 400);
  const accepted = routes.handle("POST", "/watch", {}, { characterID: 7, forSeconds: 30 });
  assert.strictEqual(typeof accepted.stream, "function");
  accepted.stream(sink());
  assert.deepStrictEqual(calls[0], { characterID: 7, forMs: 30_000, everyMs: 2000, offGridEveryMs: 5000,
    clientMode: "all", divergeMeters: null, positions: false, perfEveryMs: 0 });
  busy = true;
  assert.strictEqual(routes.handle("POST", "/watch", {}, { characterID: 7 }).statusCode, 429);
});

test("http: a stream route answers NDJSON, one event per line", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-watch-"));
  const handshakePath = path.join(dir, "bridge.json");
  const routes = {
    handle: () => ({
      statusCode: 200,
      stream: async (out) => {
        out.write({ kind: "START" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        out.write({ kind: "END", reason: "time" });
      },
    }),
  };
  const http = createAgentBridgeHttp({ routes, port: 0, handshakePath });
  const port = await http.start();
  t.after(async () => {
    await http.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { token } = JSON.parse(fs.readFileSync(handshakePath, "utf8"));
  const response = await fetch(`http://127.0.0.1:${port}/watch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.strictEqual(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepStrictEqual(lines.map((event) => event.kind), ["START", "END"]);
});
