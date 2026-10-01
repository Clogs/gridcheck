"use strict";

// The agent bridge (server/src/_secondary/agentBridge): the grid reader, the
// routes and the loopback HTTP layer, each built from injected seams so none of
// it needs a booted server. The live path is checked by docs/E2E-GRID-TESTING.md.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createGridReader, describeProtection, surfaceDistanceMeters } =
  require("../bridge/grid");
const { createAgentBridgeRoutes } = require("../bridge/routes");
const { createLuRoutes } = require("../plugins/lu/server/routes");
const { createAgentBridgeHttp, removeHandshake } =
  require("../bridge/http");
const agentBridgeService = require("../../../server/src/_secondary/agentBridge/server");

function projectEntity(entity, egoItemID) {
  return {
    kind: entity.kind,
    itemID: entity.itemID,
    typeID: entity.typeID,
    name: entity.name,
    radius: entity.radius,
    position: entity.position,
    isSelf: entity.itemID === egoItemID,
    mode: entity.mode || null,
    isNpc: entity.nativeNpc === true,
  };
}

function sceneWith(ego, others, simNowMs = 1_000_000) {
  return {
    getShipEntityForSession: () => ego,
    getVisibleEntitiesForSession: () => [ego, ...others].filter(Boolean),
    getCurrentSimTimeMs: () => simNowMs,
  };
}

function reader(scene) {
  return createGridReader({
    space: { getSceneForSession: () => scene },
    projectEntity,
    describeType: (typeID) => ({ 587: "Rifter", 17619: "Worm", 14: "Moon" }[typeID] || null),
    describeSystem: () => ({ name: "Amamake", security: 0.4 }),
  });
}

const inSpaceSession = {
  characterID: 140000007,
  characterName: "Agent Observer",
  _space: { systemID: 30002537, shipID: 1 },
};

test("surface distance subtracts both radii and never goes negative", () => {
  const a = { position: { x: 0, y: 0, z: 0 }, radius: 50 };
  assert.strictEqual(surfaceDistanceMeters(a, { position: { x: 1000, y: 0, z: 0 }, radius: 50 }), 900);
  assert.strictEqual(surfaceDistanceMeters(a, { position: { x: 10, y: 0, z: 0 }, radius: 50 }), 0);
  assert.strictEqual(surfaceDistanceMeters(a, { radius: 1 }), null);
});

test("the grid is sorted nearest first, names types and marks self", () => {
  const ego = { kind: "ship", itemID: 1, typeID: 587, name: "Rifter", radius: 40, position: { x: 0, y: 0, z: 0 }, mode: "STOP" };
  const moon = { kind: "moon", itemID: 3, typeID: 14, name: "Amamake IV - Moon 1", radius: 1000, position: { x: 2e12, y: 0, z: 0 } };
  const scout = { kind: "ship", itemID: 2, typeID: 17619, name: "Guristas Scout", radius: 30, position: { x: 182_070, y: 0, z: 0 }, nativeNpc: true, mode: "ORBIT" };
  const grid = reader(sceneWith(ego, [moon, scout])).readGrid(inSpaceSession);

  assert.deepStrictEqual(grid.entities.map((row) => row.itemID), [1, 2, 3]);
  assert.strictEqual(grid.entities[0].distanceMeters, 0);
  assert.strictEqual(grid.entities[1].distanceMeters, 182_000);
  assert.strictEqual(grid.entities[1].typeName, "Worm");
  assert.strictEqual(grid.systemName, "Amamake");
  assert.strictEqual(grid.self.typeName, "Rifter");
  assert.strictEqual(grid.self.mode, "STOP");
  assert.strictEqual(grid.inSpace, true);
});

test("self is added when the visibility query leaves the ego ball out", () => {
  const ego = { kind: "ship", itemID: 1, typeID: 587, radius: 40, position: { x: 0, y: 0, z: 0 } };
  const scene = { ...sceneWith(ego, []), getVisibleEntitiesForSession: () => [] };
  const grid = reader(scene).readGrid(inSpaceSession);
  assert.strictEqual(grid.entities.length, 1);
  assert.strictEqual(grid.entities[0].isSelf, true);
});

test("a docked session answers without touching the scene", () => {
  const grid = createGridReader({
    space: { getSceneForSession: () => { throw new Error("must not be called"); } },
    projectEntity,
  }).readGrid({ characterID: 7, stationid: 60015249, solarsystemid2: 30100032 });
  assert.strictEqual(grid.inSpace, false);
  assert.strictEqual(grid.stationID, 60015249);
  assert.deepStrictEqual(grid.entities, []);
});

test("protection follows the hunter sensor rule on scene sim time", () => {
  assert.deepStrictEqual(
    describeProtection({ undockInvulnerabilityUntilMs: 1_030_000 }, 1_000_000),
    { active: true, untilMs: 1_030_000, remainingMs: 30_000, cloaked: false },
  );
  assert.strictEqual(describeProtection({ undockInvulnerabilityUntilMs: 999_000 }, 1_000_000).active, false);
  assert.strictEqual(describeProtection({ undockInvulnerabilityActive: true }, 1_000_000).active, true);
  assert.strictEqual(describeProtection({ invulnerable: true }, 1_000_000).active, true);
  assert.strictEqual(describeProtection({ cloakMode: 1 }, 1_000_000).cloaked, true);
});

function routesWith(overrides = {}) {
  return createAgentBridgeRoutes({
    findSession: (id) => (id === 7 ? { characterID: 7 } : null),
    executeChatCommand: () => ({ handled: true, success: true, message: "done" }),
    readGrid: (session) => ({ characterID: session.characterID }),
    requestShutdown: () => {},
    ...overrides,
  });
}

test("slash passes the line through with a null chat hub and returns the reply", async () => {
  const calls = [];
  const routes = routesWith({
    executeChatCommand: (session, line, hub, options) => {
      calls.push({ session, line, hub, options });
      return { handled: true, success: false, message: "You are docked." };
    },
  });
  const result = await routes.handle("POST", "/slash", {}, { characterID: 7, command: " /tr me Amamake " });
  assert.strictEqual(result.statusCode, 200);
  assert.deepStrictEqual(result.body, {
    ok: true, command: "/tr me Amamake", handled: true, success: false, message: "You are docked.",
  });
  assert.strictEqual(calls[0].hub, null);
  assert.strictEqual(calls[0].line, "/tr me Amamake");
});

test("slash settles a command that answers with a promise", async () => {
  const routes = routesWith({ executeChatCommand: async () => ({ handled: true, success: true, message: "cleared" }) });
  const result = await routes.handle("POST", "/slash", {}, { characterID: 7, command: "/npcclear" });
  assert.strictEqual(result.body.message, "cleared");
});

test("slash and grid refuse a missing ID, an offline character and a non-command", async () => {
  const routes = routesWith();
  assert.strictEqual(routes.handle("POST", "/slash", {}, { command: "/where" }).statusCode, 400);
  assert.strictEqual(routes.handle("POST", "/slash", {}, { characterID: 8, command: "/where" }).statusCode, 409);
  assert.strictEqual(routes.handle("POST", "/slash", {}, { characterID: 7, command: "where" }).statusCode, 400);
  assert.strictEqual(routes.handle("GET", "/grid", { characterID: "8" }).statusCode, 409);
  assert.deepStrictEqual(routes.handle("GET", "/grid", { characterID: "7" }).body, { ok: true, grid: { characterID: 7 } });
  assert.strictEqual(routes.handle("GET", "/nope", {}).statusCode, 404);
});

test("shutdown asks once and answers 202", () => {
  let asked = 0;
  const result = routesWith({ requestShutdown: () => { asked += 1; } }).handle("POST", "/shutdown", {}, {});
  assert.strictEqual(result.statusCode, 202);
  assert.strictEqual(asked, 1);
});

test("http: health needs no token, everything else needs the handshake's", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-"));
  const handshakePath = path.join(dir, "bridge.json");
  const http = createAgentBridgeHttp({ routes: routesWith(), port: 0, handshakePath });
  const port = await http.start();
  t.after(async () => {
    await http.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const handshake = JSON.parse(fs.readFileSync(handshakePath, "utf8"));
  assert.strictEqual(handshake.port, port);
  assert.strictEqual(handshake.host, "127.0.0.1");
  assert.strictEqual(handshake.pid, process.pid);
  const base = `http://127.0.0.1:${port}`;

  assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  assert.strictEqual((await fetch(`${base}/grid?characterID=7`)).status, 401);
  assert.strictEqual(
    (await fetch(`${base}/grid?characterID=7`, { headers: { authorization: "Bearer wrong" } })).status,
    401,
  );
  const auth = { authorization: `Bearer ${handshake.token}` };
  const grid = await fetch(`${base}/grid?characterID=7`, { headers: auth });
  assert.deepStrictEqual(await grid.json(), { ok: true, grid: { characterID: 7 } });
  const slash = await fetch(`${base}/slash`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ characterID: 7, command: "/where" }),
  });
  assert.strictEqual((await slash.json()).message, "done");
  const bad = await fetch(`${base}/slash`, { method: "POST", headers: auth, body: "{not json" });
  assert.strictEqual(bad.status, 400);

  await http.stop();
  assert.strictEqual(fs.existsSync(handshakePath), false);
});

test("a disabled bridge leaves a live server's handshake alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-"));
  const handshakePath = path.join(dir, "bridge.json");
  try {
    // The parent of this test process is alive and is not this process.
    fs.writeFileSync(handshakePath, JSON.stringify({ pid: process.ppid }));
    assert.strictEqual(removeHandshake(handshakePath, { onlyIfOurs: true }), false);
    assert.strictEqual(fs.existsSync(handshakePath), true);
    fs.writeFileSync(handshakePath, JSON.stringify({ pid: process.pid }));
    assert.strictEqual(removeHandshake(handshakePath, { onlyIfOurs: true }), true);
    assert.strictEqual(fs.existsSync(handshakePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the service is off unless EVEJS_AGENT_BRIDGE turns it on", () => {
  const { isEnabledByEnvironment, resolvePort } = agentBridgeService.__testing;
  assert.strictEqual(isEnabledByEnvironment({}), false);
  assert.strictEqual(isEnabledByEnvironment({ EVEJS_AGENT_BRIDGE: "0" }), false);
  assert.strictEqual(isEnabledByEnvironment({ EVEJS_AGENT_BRIDGE: "1" }), true);
  assert.strictEqual(resolvePort({}), 26052);
  assert.strictEqual(resolvePort({ EVEJS_AGENT_BRIDGE_PORT: "27000" }), 27000);
  assert.strictEqual(agentBridgeService.enabled, true);
  assert.strictEqual(agentBridgeService.serviceName, "agentBridge");
});

// ---------- triggers (agentBridgeTriggers.js) ----------

const { createAgentBridgeTriggers } = require("../plugins/lu/server/triggers");
const scouts = require("../../../server/src/_secondary/pirateScouts");

// One system (1) with the character's ship, a scout and a gang; the hunt tick is
// run inline. Every LU call is recorded so a test reads what the trigger asked for.
function triggerWorld({ docked = false } = {}) {
  const calls = [];
  const ship = { itemID: 900, position: { x: 0, y: 0, z: 0 } };
  const entities = { scout: [{ itemID: 11, position: { x: 50_000, y: 0, z: 0 } }],
    gang: [{ itemID: 12, position: { x: 1_000, y: 0, z: 0 } }] };
  const flights = {
    scout: { flightID: "scout", family: "pirate", pirateRole: "scout", currentSystemID: 1, actorIDs: ["a"] },
    gang: { flightID: "gang", family: "pirate", doctrineFactionKey: "guristas", currentSystemID: 3, actorIDs: ["b", "c"] },
    patroller: { flightID: "patroller", family: "pirate", pirateRole: "scout", currentSystemID: 2, actorIDs: ["d"],
      missionJourney: { kind: "pirate_scout_patrol", ownerID: "pirate-scout:patroller" } },
    police: { flightID: "police", family: "police", currentSystemID: 1, actorIDs: ["e"] },
  };
  const scene = { sessions: new Map([[1, {}]]), getShipEntityForSession: () => (docked ? null : ship) };
  const session = { characterID: 7, solarsystemid2: 1, _space: docked ? null : { systemID: 1 } };
  const coordinator = {
    start(leader, reports, now, explain) {
      calls.push(["start", leader.flightID, reports.map(r => r.targetID)]);
      if (leader.refuse) { explain(leader.refuse); return false; }
      leader.pirateHunt = { id: `pirate-hunt:${leader.flightID}:${now}`, phase: "stalking", trace: [{ phase: "stalking", reason: "scout-discovery" }] };
      return true;
    },
    commit(leader, reason) { calls.push(["commit", reason]); leader.pirateHunt.phase = "committed"; return true; },
    viable: f => f.homeless !== true,
  };
  const tools = {
    nowMs: 1000, state: { flights }, flights: Object.values(flights).filter(f => f.family === "pirate"),
    space: { scenes: new Map([[1, scene]]) }, coordinator,
    entities: f => entities[f.flightID] || [],
    reports: () => [{ targetID: 900 }, { targetID: 555 }],
    registry: { getControllerByEntityID: id => ({ id }) },
    hunterIntel: { scanTarget: (_s, observer, _c, target) => (target.protected ? null : { source: "scan", targetID: target.itemID, observerID: observer.itemID }) },
    assignments: { ready: f => !f.busy },
    journeys: { divert: (id, owner, anchor) => { calls.push(["divert", id, owner, anchor.systemID]); return { success: true }; } },
    patrol: {
      safe: (_f, id) => id !== 99, path: (from, to) => (from === 2 ? [2, to] : [from, 5, to]), blocked: () => false,
      pinned: f => f.pinned === true,
      anchor: id => ({ systemID: id, anchorID: id * 10 }), mark() {},
      claim: (f, spec) => { calls.push(["claim", f.flightID, spec.kind, spec.ownerID]); return { success: true }; },
    },
  };
  const lu = {
    inspect: { listFlights: () => Object.values(flights) },
    assignments: {
      ready: f => !f.busy,
      claim: (f, spec) => { calls.push(["fleet-claim", f.flightID, spec]); return { success: true }; },
    },
    journeys: { pathTo: (from, to) => (from === to ? [from] : [from, to]) },
    machines: { materializeFlightNow: id => (flights[id] ? { success: true, flight: flights[id], madeDue: true } : { success: false }) },
  };
  const triggers = createAgentBridgeTriggers({
    findSession: id => (id === 7 ? session : null),
    space: { getSceneForSession: () => scene, scenes: tools.space.scenes },
    lu, hunts: { requestInTick: run => Promise.resolve().then(() => run(tools)) },
    simNow: () => 1000,
    staticAnchors: () => [{ itemID: 40, kind: "stargate" }],
    executeChatCommand: (_s, line) => { calls.push(["chat", line]); return { success: true, message: "jumped" }; },
    scouts,
  });
  return { triggers, calls, flights, ship, session };
}

test("trigger hunt: a scout on your system scans you and the coordinator's start runs on that report", async () => {
  const w = triggerWorld();
  const reply = await w.triggers.run("hunt", { characterID: 7, phase: "committed" });
  assert.strictEqual(reply.statusCode, 200, JSON.stringify(reply.body));
  assert.strictEqual(reply.body.flightID, "scout", "a scout leads ahead of a nearer gang");
  assert.strictEqual(reply.body.huntID, "pirate-hunt:scout:1000");
  assert.strictEqual(reply.body.phase, "committed");
  assert.deepStrictEqual(w.calls, [["start", "scout", [900]], ["commit", "trigger-committed"]],
    "only reports on the character's ship reach start");

  const refused = triggerWorld();
  refused.flights.scout.refuse = "hunt-cooldown";
  const no = await refused.triggers.run("hunt", { characterID: 7 });
  assert.strictEqual(no.statusCode, 409);
  assert.strictEqual(no.body.reason, "hunt-cooldown");
  assert.match(no.body.error, /refused scout: hunt-cooldown/);

  const docked = await triggerWorld({ docked: true }).triggers.run("hunt", { characterID: 7 });
  assert.strictEqual(docked.statusCode, 409);
  assert.match(docked.body.error, /Undock first/);
  assert.strictEqual((await w.triggers.run("hunt", { characterID: 7, phase: "returning" })).statusCode, 400);
});

test("trigger scout: the nearest ready scout takes a patrol leg, diverting an existing patrol", async () => {
  const w = triggerWorld();
  w.flights.scout.busy = true;
  const reply = await w.triggers.run("scout", { characterID: 7, systemID: 4 });
  assert.strictEqual(reply.statusCode, 200, JSON.stringify(reply.body));
  assert.strictEqual(reply.body.flightID, "patroller");
  assert.strictEqual(reply.body.jumps, 1);
  assert.deepStrictEqual(w.calls, [["divert", "patroller", "pirate-scout:patroller", 4]]);
  assert.ok(w.flights.patroller.scoutPatrolAtMs >= 1000 + 600_000, "it holds instead of patrolling on");

  const idle = triggerWorld();
  delete idle.flights.patroller;
  const claimed = await idle.triggers.run("scout", { characterID: 7 });
  assert.strictEqual(claimed.body.systemID, 1, "defaults to the character's system");
  assert.deepStrictEqual(idle.calls, [["claim", "scout", "pirate_scout_patrol", "pirate-scout:scout"]]);

  const none = triggerWorld();
  none.flights.patroller.pinned = true;
  const refused = await none.triggers.run("scout", { characterID: 7, systemID: 99 });
  assert.strictEqual(refused.statusCode, 409);
  assert.deepStrictEqual(refused.body.refusals, { "outside-its-hunting-corridors": 1, "pinned-by-combat": 1 });
  const homeless = triggerWorld();
  homeless.flights.patroller.homeless = true;
  const preferred = await homeless.triggers.run("scout", { characterID: 7, systemID: 4 });
  assert.strictEqual(preferred.body.flightID, "scout", "a scout that could hunt there goes ahead of a nearer one that can't");
  assert.strictEqual(preferred.body.canHunt, true);
  homeless.flights.scout.homeless = true;
  const unviable = await homeless.triggers.run("scout", { characterID: 7, systemID: 4 });
  assert.strictEqual(unviable.body.canHunt, false, "still sent, and says it can't lead a hunt");
});

test("trigger fleet: ready flights of the family and doctrine are claimed to hold on your grid", async () => {
  const w = triggerWorld();
  const reply = await w.triggers.run("fleet", { characterID: 7, family: "pirate", doctrine: "gurist", to: "self", count: 3 });
  assert.strictEqual(reply.statusCode, 200, JSON.stringify(reply.body));
  assert.deepStrictEqual(reply.body.flights.map(f => f.flightID), ["gang"], "scouts and other doctrines stay");
  const [, flightID, spec] = w.calls[0];
  assert.strictEqual(flightID, "gang");
  assert.deepStrictEqual(spec.destination, { systemID: 1, anchorID: 900 });
  assert.strictEqual(spec.holdPosition, undefined, "holdPosition would keep a flight already here where it is");
  assert.strictEqual(spec.ownerID, reply.body.ownerID);

  const bySystem = triggerWorld();
  await bySystem.triggers.run("fleet", { characterID: 7, family: "police", systemID: 6 });
  assert.deepStrictEqual(bySystem.calls[0][2].destination, { systemID: 6, anchorID: 40 }, "a system gets its stargate");
  assert.strictEqual((await bySystem.triggers.run("fleet", { characterID: 7, family: "salvage" })).statusCode, 409);
});

test("trigger materialize pins the flight and --go jumps only when you are elsewhere", async () => {
  const w = triggerWorld();
  const here = await w.triggers.run("materialize", { characterID: 7, flightID: "police", go: true });
  assert.strictEqual(here.body.madeDue, true);
  assert.strictEqual(here.body.observed, true);
  assert.strictEqual(here.body.moved, null);
  const away = await w.triggers.run("materialize", { characterID: 7, flightID: "gang", go: true });
  assert.deepStrictEqual(w.calls, [["chat", "/solar 3"]]);
  assert.strictEqual(away.body.moved.success, true);
  assert.strictEqual((await w.triggers.run("materialize", { flightID: "nope" })).statusCode, 404);
  assert.strictEqual((await w.triggers.run("spawn", {})).statusCode, 404);
});

test("a trigger whose tick comes too late answers 503 and then does nothing", async () => {
  let lateTick = null;
  const triggers = createAgentBridgeTriggers({
    findSession: () => ({ characterID: 7, solarsystemid2: 1 }), space: {}, lu: {}, simNow: () => 0,
    staticAnchors: () => [], tickTimeoutMs: 5, scouts,
    // The tick never comes until the test runs it, after the caller has given up.
    hunts: { requestInTick: run => { lateTick = () => run({ flights: [] }); return new Promise(() => {}); } },
  });
  const reply = await triggers.run("scout", { characterID: 7 });
  assert.strictEqual(reply.statusCode, 503);
  assert.match(reply.body.error, /nothing was done/);
  assert.throws(lateTick, /abandoned/, "the queued work refuses instead of dispatching a scout");
});

test("POST /trigger/<name> reaches the trigger with its body", async () => {
  const seen = [];
  const withPlugin = (deps) => createAgentBridgeRoutes({ findSession: () => null, readGrid: () => null,
    extraRoutes: [{ owner: "plugin lu", routes: createLuRoutes(deps) }] });
  const routes = withPlugin({
    triggers: { run: (name, body) => { seen.push([name, body]); return { statusCode: 200, body: { ok: true } }; } } });
  assert.strictEqual((await routes.handle("POST", "/trigger/hunt", {}, { characterID: 7 })).statusCode, 200);
  assert.deepStrictEqual(seen, [["hunt", { characterID: 7 }]]);
  assert.strictEqual(withPlugin({}).handle("POST", "/trigger/hunt", {}, {}).statusCode, 503,
    "the plugin without its triggers says so");
  const none = createAgentBridgeRoutes({ findSession: () => null, readGrid: () => null });
  assert.strictEqual(none.handle("POST", "/trigger/hunt", {}, {}).statusCode, 404, "without the plugin there is no route");
});
