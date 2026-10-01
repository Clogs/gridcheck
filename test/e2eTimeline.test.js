"use strict";

// core/timeline.js: the text `e2e watch` prints, the log line parser and
// the reorder buffer that merges log lines into the bridge stream.

const test = require("node:test");
const assert = require("node:assert");

const {
  collectIDs,
  createReorderBuffer,
  formatOffset,
  formatTimelineEvent,
  mentionsAny,
  parseLogLine,
} = require("../core/timeline");

test("offsets read t+HH:MM:SS, and t- for a step from before the watch", () => {
  assert.strictEqual(formatOffset(138_000), "t+00:02:18");
  assert.strictEqual(formatOffset(-65_000), "t-00:01:05");
});

test("the pirate-stalking lines read as the plan's example", () => {
  const hunt = formatTimelineEvent({
    t: 10_000, kind: "HUNT", phase: "stalking", reason: "scout-discovery", targetSelf: true, distanceMeters: 182_000,
    leader: { flightID: "living_flight_4411", corporation: "Guristas", pirateRole: "scout", count: 1 },
    supportFlightIDs: [],
  });
  assert.strictEqual(hunt,
    "t+00:00:10  HUNT      living_flight_4411 Guristas scout  scout-discovery target=self at 182 km  phase=stalking");
  const incoming = formatTimelineEvent({
    t: 40_000, kind: "INCOMING", flightID: "living_flight_4420", corporation: "Guristas", count: 4,
    systemName: "Tama", toSystemName: "Amamake", etaMs: 95_000, journeyKind: "pirate_hunt_support",
  });
  assert.match(incoming, /^t\+00:00:40  INCOMING  living_flight_4420 Guristas x4 Tama -> Amamake  eta 95s +pirate_hunt_support$/);
  const arrive = formatTimelineEvent({
    t: 138_000, kind: "ARRIVE", warpIn: true, distanceMeters: 24_000, count: 4,
    members: [{ label: "a", typeName: "Worm" }, { label: "b", typeName: "Worm" }, { label: "c", typeName: "Stiletto" },
      { label: "d", typeName: "Worm" }],
    lu: { flightID: "living_flight_4420", corporation: "Guristas", huntPhase: "committed", decision: "hunt:committed/tackle",
      huntReason: "confirmed-nearby-support-and-fitted-tackle" },
  });
  assert.match(arrive, /^t\+00:02:18  ARRIVE    Guristas x4 \(Worm\/Stiletto\)  warp-in 24 km from self +living_flight_4420 phase=committed why=hunt:committed\/tackle hunt=confirmed-nearby-support-and-fitted-tackle$/);
  assert.strictEqual(
    formatTimelineEvent({ t: 145_000, kind: "DAMAGE", label: "self", layer: "shield", fromPct: 100, toPct: 62 }),
    "t+00:02:25  DAMAGE    self shield 100 -> 62",
  );
  assert.strictEqual(
    formatTimelineEvent({ t: 141_000, kind: "TARGET", sourceLabel: "Guristas Stiletto", targetLabel: "self", locked: true }),
    "t+00:02:21  TARGET    Guristas Stiletto -> self (locked)",
  );
});

test("every event kind formats without throwing", () => {
  for (const kind of ["START", "GRID", "PRESENT", "LEAVE", "MODE", "DESTROYED", "KILLMAIL", "SIGHTING", "ENTER",
    "EXIT", "HERE", "MOVED", "ENGAGEMENT", "LOSS", "SYSTEM", "SELF", "DOCKED", "LOG", "ERROR", "END", "SOMETHING_NEW"]) {
    const line = formatTimelineEvent({ t: 0, kind, forMs: 1000, everyMs: 1000, offGridEveryMs: 1000, members: [] });
    assert.ok(line.startsWith("t+00:00:00  "), `${kind}: ${line}`);
  }
  for (const op of ["attached", "unavailable", "gap", "SetState", "ballpark-cleared", "AddBalls", "RemoveBalls", "Orbit",
    "Damage", "Destruction", "decode-error"]) {
    const line = formatTimelineEvent({ t: 0, kind: "CLIENT", op, itemID: "5" });
    assert.ok(line.startsWith("t+00:00:00  CLIENT"), `${op}: ${line}`);
  }
  for (const reason of ["server-only", "client-only", "mode", "position", "warp-landing", "unknown-ball", "no-ballpark",
    "new"]) {
    for (const status of ["open", "once", "cleared"]) {
      const line = formatTimelineEvent({ t: 0, kind: "DIVERGE", reason, status, itemID: "5" });
      assert.ok(line.startsWith("t+00:00:00  DIVERGE"), `${reason}: ${line}`);
    }
  }
});

test("client lines read what the client was sent, and DIVERGE says which side is wrong", () => {
  const lines = [
    { t: 1000, kind: "CLIENT", op: "AddBalls", count: 2, balls: [
      { itemID: "2", label: "Guristas Worm", mode: "WARP" }, { itemID: "3", label: "Guristas Stiletto", mode: "STOP" }] },
    { t: 2000, kind: "CLIENT", op: "Orbit", itemID: "2", label: "Guristas Worm", mode: "ORBIT", targetID: "1",
      targetLabel: "self", rangeMeters: 2500 },
    { t: 3000, kind: "FX", itemID: "2", label: "Guristas Worm", guid: "effects.ProjectileFired", targetID: "1",
      targetLabel: "self", offensive: true, knownBall: true },
    { t: 4000, kind: "DIVERGE", reason: "server-only", status: "open", itemID: "4", label: "Guristas Worm 4",
      distanceMeters: 24_000, sinceMs: 4000 },
    { t: 9000, kind: "DIVERGE", reason: "server-only", status: "cleared", itemID: "4", label: "Guristas Worm 4",
      durationMs: 9000 },
  ].map(formatTimelineEvent);
  assert.deepStrictEqual(lines.map((line) => line.replace(/\s+/g, " ").trim()), [
    "t+00:00:01 CLIENT AddBalls 2: Guristas Worm WARP, Guristas Stiletto",
    "t+00:00:02 CLIENT Guristas Worm Orbit -> ORBIT on self at 2,500 m",
    "t+00:00:03 FX Guristas Worm effects.ProjectileFired -> self offensive",
    "t+00:00:04 DIVERGE server-only Guristas Worm 4: server shows it at 24 km; the client never got it for 4s",
    "t+00:00:09 DIVERGE server-only Guristas Worm 4 cleared after 9s",
  ]);
});

test("a plugin formats its own kinds and tags core lines; without it they read raw", () => {
  const { emptyRegistry } = require("../core/plugins");
  const hunt = { t: 0, kind: "HUNT", phase: "stalking", reason: "x", leader: { flightID: "f1" } };
  assert.match(formatTimelineEvent(hunt), /^t\+00:00:00 {2}HUNT {6}f1 {2}x/);
  assert.match(formatTimelineEvent(hunt, emptyRegistry()), /^t\+00:00:00 {2}HUNT {6}\{"t":0,"kind":"HUNT"/);
  const target = { t: 0, kind: "TARGET", sourceLabel: "a", targetLabel: "self", locked: true, lu: { flightID: "f9" } };
  assert.match(formatTimelineEvent(target), /self \(locked\) +f9$/);
  assert.strictEqual(formatTimelineEvent(target, emptyRegistry()), "t+00:00:00  TARGET    a -> self (locked)");
  const end = { t: 0, kind: "END", reason: "time", samples: 2, events: 9, costs: { sampleMsAvg: 1, sampleMsMax: 2,
    offGridMsAvg: 3, offGridMsMax: 4, flightsScanned: 1717 } };
  assert.match(formatTimelineEvent(end), /off grid 3\/4 ms over 1717 flights \(avg\/max\)$/);
  assert.match(formatTimelineEvent(end, emptyRegistry()), /off grid 3\/4 ms \(avg\/max\)$/);
});

test("log lines parse to server time, pid, level and text", () => {
  assert.deepStrictEqual(
    parseLogLine("[2026-09-30T19:03:13.564Z] [pid 23332] [INF] [LivingHostility] flight=living_flight_4420 armed"),
    { atMs: Date.parse("2026-09-30T19:03:13.564Z"), pid: 23332, level: "INF",
      text: "[LivingHostility] flight=living_flight_4420 armed" },
  );
  assert.strictEqual(parseLogLine("not a log line"), null);
});

test("log lines are kept when they name something the watch has seen", () => {
  const ids = collectIDs({ kind: "ARRIVE", flightID: "living_flight_4420", members: [{ itemID: 990001 }] }, new Set());
  assert.strictEqual(mentionsAny("[LivingHostility] flight=living_flight_4420 armed", ids), true);
  assert.strictEqual(mentionsAny("[NpcController] npc=990001 state=active", ids), true);
  assert.strictEqual(mentionsAny("[LivingHostility] flight=living_flight_0001 armed", ids), false);
});

test("the reorder buffer releases held events in server-time order", () => {
  const released = [];
  const buffer = createReorderBuffer(1500, (event) => released.push(event.name));
  buffer.push({ atMs: 2000, seq: 1, name: "sample" });
  buffer.push({ atMs: 1900, name: "log" });
  buffer.push({ atMs: 9000, seq: 2, name: "later" });
  buffer.flush(4000);
  assert.deepStrictEqual(released, ["log", "sample"]);
  buffer.flush(4000, true);
  assert.deepStrictEqual(released, ["log", "sample", "later"]);
});
