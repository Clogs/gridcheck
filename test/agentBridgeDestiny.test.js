"use strict";

// Client-fidelity capture (bridge/destiny.js): every payload here is built by
// the tree's destiny encoders, so a change to the wire layout fails these tests
// rather than silently corrupting the client model. npm test replays the
// encoders' recorded output (test/fixtures/destiny.json); the compatibility
// script records it again from each tree and fails when it changed.

const test = require("node:test");
const assert = require("node:assert");

const {
  PROBE_ENTITIES,
  PROBE_STAMP,
  createClientModel,
  createDestinyTee,
  createDivergenceChecker,
  decodeBallState,
  decodeDestinyUpdate,
  probeDestinyLayout,
} = require("../bridge/destiny");
const { encoders } = require("./fixtures/encoders");

const encoded = encoders();
// The tree's modules as these tests use them, through the recording.
const statePayloads = { buildAddBallsStateBuffer: (stamp, entities) => encoded.ballState(stamp, entities) };
const actions = new Proxy({}, { get: (_target, name) => (...args) => encoded.action(String(name), ...args) });
const buildPackagedActionPayload = (pairs) => encoded.packaged(pairs);
const marshalDecodeExact = (bytes) => encoded.marshalDecode(bytes);
const { createAgentBridgeRoutes } = require("../bridge/routes");

const BIG_NPC_ID = 9_007_199_254_740_993n; // past 2^53

function ship(itemID, overrides = {}) {
  return {
    kind: "ship",
    itemID,
    typeID: 587,
    radius: 35,
    mass: 1_000_000,
    maxVelocity: 400,
    position: { x: 1000, y: 2000, z: 3000 },
    velocity: { x: 0, y: 0, z: 0 },
    mode: "STOP",
    ...overrides,
  };
}

function destinyUpdate(...payloads) {
  return encoded.destinyUpdate(...payloads);
}

function setState(entities, ego = 1) {
  return encoded.setState(entities, ego);
}

function addBalls(entities) {
  return encoded.addBalls(entities);
}

function apply(model, tuple, atMs) {
  return model.apply(decodeDestinyUpdate(tuple, { decodePackaged: marshalDecodeExact }).updates, atMs);
}

test("the ball state decoder reads every ball the stock encoder writes", () => {
  const entities = [
    ship(1),
    ship(2, { mode: "GOTO", targetPoint: { x: 5e6, y: 0, z: 0 }, velocity: { x: 120, y: -3, z: 0 } }),
    ship(3, { mode: "ORBIT", targetEntityID: 1, orbitDistance: 2500 }),
    ship(4, { mode: "FOLLOW", targetEntityID: 1, followRange: 500 }),
    ship(BIG_NPC_ID, { mode: "WARP", warpState: { targetPoint: { x: 9e9, y: 1, z: 2 }, effectStamp: 7,
      totalDistance: 9e9, stopDistance: 15_000, warpSpeed: 3000 } }),
    { kind: "wreck", itemID: 6, typeID: 26468, radius: 14, position: { x: 7, y: 8, z: 9 } },
    { kind: "planet", itemID: 40000001, radius: 6e6, position: { x: -1e11, y: 0, z: 4e10 },
      miniBalls: [{ x: 1, y: 2, z: 3, radius: 100 }, { x: 4, y: 5, z: 6, radius: 200 }] },
    { kind: "station", itemID: 60004603, radius: 20_000, position: { x: 1e9, y: 2e9, z: 3e9 },
      destinyBallMode: "STOP", corporationID: 1000049 },
    ship(9, { mode: "STOP", position: { x: -1.5, y: 2.25, z: 1e12 } }),
  ];
  const buffer = statePayloads.buildAddBallsStateBuffer(4242, entities);
  const decoded = decodeBallState(buffer);
  assert.strictEqual(decoded.error, null);
  assert.strictEqual(decoded.packetType, 1);
  assert.strictEqual(decoded.stamp, 4242);
  assert.deepStrictEqual(decoded.balls.map((ball) => ball.itemID),
    ["1", "2", "3", "4", BIG_NPC_ID.toString(), "6", "40000001", "60004603", "9"]);
  assert.deepStrictEqual(decoded.balls.map((ball) => ball.modeName),
    ["STOP", "GOTO", "ORBIT", "FOLLOW", "WARP", "STOP", "RIGID", "STOP", "STOP"]);
  const byID = new Map(decoded.balls.map((ball) => [ball.itemID, ball]));
  assert.deepStrictEqual(byID.get("2").targetPoint, { x: 5e6, y: 0, z: 0 });
  assert.deepStrictEqual(byID.get("2").velocity, { x: 120, y: -3, z: 0 });
  assert.strictEqual(byID.get("3").followID, "1");
  assert.strictEqual(byID.get("3").followRange, 2500);
  const warp = byID.get(BIG_NPC_ID.toString());
  assert.deepStrictEqual(warp.targetPoint, { x: 9e9, y: 1, z: 2 });
  assert.strictEqual(warp.minimumRange, 15_000);
  assert.strictEqual(byID.get("6").isFree, true);
  assert.strictEqual(byID.get("40000001").isFree, false);
  assert.deepStrictEqual(byID.get("60004603").position, { x: 1e9, y: 2e9, z: 3e9 });
  assert.deepStrictEqual(byID.get("9").position, { x: -1.5, y: 2.25, z: 1e12 });
});

test("a truncated ball state keeps the balls before the break and says where it stopped", () => {
  const buffer = statePayloads.buildAddBallsStateBuffer(1, [ship(1), ship(2)]);
  const decoded = decodeBallState(buffer.subarray(0, buffer.length - 3));
  assert.deepStrictEqual(decoded.balls.map((ball) => ball.itemID), ["1"]);
  assert.match(decoded.error, /ends at/);
  assert.strictEqual(decodeBallState(null).error, "no ball state buffer");
});

test("packaged actions are unpacked into the updates they carry", () => {
  const packaged = buildPackagedActionPayload([
    [100, actions.buildOrbitPayload(2, 1, 2500)],
    [100, actions.buildStopPayload(3)],
  ]);
  const tuple = destinyUpdate(actions.buildGotoPointPayload(4, { x: 1, y: 2, z: 3 }), packaged);
  const { updates, errors } = decodeDestinyUpdate(tuple, { decodePackaged: marshalDecodeExact });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(updates.map((update) => update.name), ["GotoPoint", "Orbit", "Stop"]);
  const unread = decodeDestinyUpdate(tuple);
  assert.deepStrictEqual(unread.updates.map((update) => update.name), ["GotoPoint"]);
  assert.deepStrictEqual(unread.errors, ["PackagedAction not decoded"]);
});

test("the client model follows SetState, AddBalls, movement, damage, effects and removal", () => {
  const model = createClientModel();
  let events = apply(model, setState([ship(1), ship(2, { typeID: 17932 })]), 1000);
  assert.deepStrictEqual(events.map((event) => event.op), ["SetState"]);
  assert.strictEqual(model.egoID, "1");
  assert.strictEqual(model.balls.get("2").typeID, 17932);
  assert.ok(model.baseline);

  events = apply(model, addBalls([ship(3, { mode: "WARP", warpState: { targetPoint: { x: 1e5, y: 0, z: 0 },
    stopDistance: 2500, effectStamp: 1, totalDistance: 1e9 } })]), 2000);
  assert.deepStrictEqual(events.map((event) => event.op), ["AddBalls"]);
  assert.deepStrictEqual(model.balls.get("3").warp.dest, { x: 1e5, y: 0, z: 0 });

  events = apply(model, destinyUpdate(
    actions.buildOrbitPayload(2, 1, 2500),
    actions.buildOrbitPayload(2, 1, 2600),
    actions.buildWarpToPayload(1, { x: 5e9, y: 0, z: 0 }, 0, 3000),
    actions.buildOnDamageStateChangePayload(2, [[{ type: "real", value: 0.4 }, { type: "real", value: 1 },
      { type: "long", value: 1n }], { type: "real", value: 1 }, { type: "real", value: 1 }]),
    actions.buildOnSpecialFXPayload(2, "effects.ProjectileFired", { moduleID: 77, moduleTypeID: 484, targetID: 1,
      isOffensive: true, start: true }),
    actions.buildOnSpecialFXPayload(2, "effects.ProjectileFired", { moduleID: 77, moduleTypeID: 484, targetID: 1,
      isOffensive: true, start: true }),
    actions.buildOnSpecialFXPayload(2, "effects.ProjectileFired", { moduleID: 77, targetID: 1, start: false }),
  ), 3000);
  assert.deepStrictEqual(events.map((event) => `${event.kind}:${event.op || event.guid}`),
    ["CLIENT:Orbit", "CLIENT:WarpTo", "CLIENT:Damage", "FX:effects.ProjectileFired"]);
  const damage = events.find((event) => event.op === "Damage");
  assert.deepStrictEqual([damage.layer, damage.fromPct, damage.toPct], ["shield", 100, 40]);
  assert.strictEqual(events.find((event) => event.kind === "FX").offensive, true);
  assert.strictEqual(model.balls.get("1").mode, "WARP");

  events = apply(model, destinyUpdate(actions.buildRemoveBallsPayload([2, 3])), 4000);
  assert.deepStrictEqual(events.map((event) => [event.op, event.itemIDs]), [["RemoveBalls", ["2", "3"]]]);
  assert.deepStrictEqual([...model.balls.keys()], ["1"]);
});

test("updates for a ball the client never got are kept as orphans", () => {
  const model = createClientModel();
  apply(model, destinyUpdate(actions.buildOrbitPayload(5, 1, 500)), 500);
  assert.strictEqual(model.orphans.size, 0, "no baseline yet: nothing to compare with");
  apply(model, setState([ship(1)]), 1000);
  apply(model, destinyUpdate(actions.buildOrbitPayload(5, 1, 500), actions.buildStopPayload(5)), 2000);
  assert.deepStrictEqual(model.orphans.get("5"), { op: "Orbit", firstAtMs: 2000, count: 2 });
  apply(model, addBalls([ship(5)]), 3000);
  assert.strictEqual(model.orphans.size, 0);
});

function gatewaySession(original = () => undefined) {
  return {
    clientID: 2_000_000_001,
    characterID: 90000001,
    socket: { destroyed: false, destroy() { this.destroyed = true; } },
    sendNotification: original,
  };
}

// The bridge's layout check (probeDestinyLayout) against the tree's own encoder.
const treeEncoder = (stamp, entities) => statePayloads.buildAddBallsStateBuffer(stamp, entities);
// The same balls with one byte more after the header, as a tree that grew a field would write them.
const shiftedEncoder = (stamp, entities) => {
  const buffer = treeEncoder(stamp, entities);
  return Buffer.concat([buffer.subarray(0, 13), Buffer.from([0]), buffer.subarray(13)]);
};

test("the layout check reads back every probe ball the tree's encoder writes", () => {
  const probe = probeDestinyLayout(treeEncoder);
  assert.deepStrictEqual(probe, { ok: true, error: null, balls: PROBE_ENTITIES.length });
  assert.strictEqual(decodeBallState(treeEncoder(PROBE_STAMP, PROBE_ENTITIES.map((entity) => ({ ...entity })))).stamp, PROBE_STAMP);
});

test("a changed destiny layout turns the client view off with a clear message", async () => {
  const probe = probeDestinyLayout(shiftedEncoder);
  assert.strictEqual(probe.ok, false);
  assert.match(probe.error, /^this tree's destiny ball layout is not the one the decoder reads: /);
  assert.match(probe.error, /ball 1 modeName read as "GOTO", written as "STOP"/);

  const tee = createDestinyTee({ decodePackaged: marshalDecodeExact, off: probe.error });
  const session = gatewaySession();
  const original = session.sendNotification;
  assert.deepStrictEqual(tee.attach(session), { ok: false, error: `client view off: ${probe.error}` });
  assert.strictEqual(session.sendNotification, original, "nothing wraps the session");

  const { createGridWatch } = require("../bridge/watch");
  let clock = 0;
  const watch = createGridWatch({
    findSession: () => session,
    readGrid: () => ({ inSpace: true, solarSystemID: 30000142, systemName: "Jita", self: { itemID: 1 },
      entities: [{ kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", mode: "STOP", position: { x: 0, y: 0, z: 0 } }] }),
    destinyTee: tee,
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  const lines = [];
  await watch.run({ characterID: 90000001, forMs: 4_000, everyMs: 2_000, offGridEveryMs: 60_000, clientMode: "all" },
    { write: (event) => lines.push(event), closed: () => false });
  assert.deepStrictEqual([lines[0].kind, lines[0].clientMode, lines[0].clientOff], ["START", "off", probe.error]);
  assert.ok(!lines.some((event) => event.kind === "CLIENT" || event.kind === "DIVERGE"),
    lines.map((event) => event.kind).join(" "));
});

test("the tee wraps gateway sessions only and returns the original's result", () => {
  const seen = [];
  const tee = createDestinyTee({ decodePackaged: marshalDecodeExact, now: () => 1000 });
  const session = gatewaySession((name) => { seen.push(name); return name === "Refuse" ? false : undefined; });
  const attached = tee.attach(session);
  assert.strictEqual(attached.ok, true);
  assert.strictEqual(attached.attached, true);
  assert.strictEqual(tee.attach(session).attached, false, "attaching twice keeps one wrapper");

  assert.strictEqual(session.sendNotification("DoDestinyUpdate", "clientID", setState([ship(1)])), undefined);
  assert.strictEqual(session.sendNotification("Refuse", "clientID", []), false);
  assert.deepStrictEqual(seen, ["DoDestinyUpdate", "Refuse"]);
  assert.strictEqual(attached.state.model.balls.size, 1);

  // A payload the decoder cannot read is counted, never thrown into the sender.
  assert.doesNotThrow(() => session.sendNotification("DoDestinyUpdate", "clientID", [{ type: "list", items: [[1, ["SetState", [null]]]] }]));
  assert.strictEqual(tee.describe(attached.state).notifications, 2);

  const retail = { ...gatewaySession(), clientID: 7, socket: { write() {} } };
  assert.strictEqual(tee.attach(retail).ok, false);
});

test("the tee ring is bounded and a slow reader is told how many events it missed", () => {
  const tee = createDestinyTee({ decodePackaged: marshalDecodeExact, ringSize: 3, now: () => 1000 });
  const session = gatewaySession();
  const { state } = tee.attach(session);
  session.sendNotification("DoDestinyUpdate", "clientID", setState([ship(1)]));
  for (let id = 2; id <= 6; id += 1) session.sendNotification("DoDestinyUpdate", "clientID", addBalls([ship(id)]));
  const drained = tee.drain(state, 0);
  assert.strictEqual(drained.events.length, 3);
  assert.strictEqual(drained.dropped, 3);
  assert.strictEqual(drained.lastSeq, 6);
  assert.deepStrictEqual(tee.drain(state, drained.lastSeq), { events: [], lastSeq: 6, dropped: 0 });
  assert.strictEqual(state.model.balls.size, 6, "the model keeps every ball even when the ring drops events");
});

function serverGrid(rows) {
  return { inSpace: true, entities: rows };
}

function row(itemID, overrides = {}) {
  return { kind: "ship", itemID, mode: "STOP", position: { x: 1000, y: 2000, z: 3000 }, ...overrides };
}

test("a ship that warped in is position-checked at sub-warp speed, not its warp velocity", () => {
  const model = createClientModel();
  apply(model, setState([ship(1)]), 0);
  apply(model, addBalls([ship(5, { mode: "WARP", velocity: { x: 150_000, y: 0, z: 0 },
    warpState: { targetPoint: { x: 1e6, y: 0, z: 0 }, stopDistance: 0, effectStamp: 1, totalDistance: 1e9 } })]), 0);
  apply(model, destinyUpdate(actions.buildStopPayload(5),
    actions.buildSetBallPositionPayload(5, { x: 1e6, y: 0, z: 0 })), 1000);
  const checker = createDivergenceChecker();
  assert.deepStrictEqual(checker.step(serverGrid([row(1), row(5, { position: { x: 1e6 + 300, y: 0, z: 0 } })]), model, 2350), []);
  // A SetBallVelocity in the same batch moves the guess with it.
  apply(model, destinyUpdate(actions.buildSetBallPositionPayload(5, { x: 0, y: 0, z: 0 }),
    actions.buildSetBallVelocityPayload(5, { x: 1000, y: 0, z: 0 })), 3000);
  assert.deepStrictEqual(checker.step(serverGrid([row(1), row(5, { position: { x: 4000, y: 0, z: 0 } })]), model, 7000), []);
});

test("docking throws the client's ballpark away; in space without a SetState is one DIVERGE", () => {
  let clock = 0;
  const changes = [];
  const session = { ...gatewaySession(), sendSessionChange: (value) => { changes.push(value); return "sent"; } };
  const tee = createDestinyTee({ decodePackaged: marshalDecodeExact, now: () => clock });
  const { state } = tee.attach(session);
  session.sendNotification("DoDestinyUpdate", "clientID", setState([ship(1), ship(2)]));
  assert.strictEqual(session.sendSessionChange({ shipid: [1, 9] }), "sent");
  assert.strictEqual(state.model.balls.size, 2, "a new ship in space keeps the park");
  session.sendSessionChange({ stationid: [null, 60004603], solarsystemid: [30002537, null] });
  assert.strictEqual(changes.length, 2);
  assert.strictEqual(state.model.balls.size, 0);
  assert.strictEqual(state.model.baseline, null);
  assert.deepStrictEqual(tee.drain(state, 1).events.map((event) => [event.op, event.keys]),
    [["ballpark-cleared", ["stationid", "solarsystemid"]]]);

  // Undocked: the server has a grid, the client has nothing yet.
  const checker = createDivergenceChecker();
  const rows = [row(1), row(2)];
  clock = 10_000;
  session.sendSessionChange({ stationid: [60004603, null] });
  assert.deepStrictEqual(checker.step(serverGrid(rows), state.model, 11_000), []);
  const open = checker.step(serverGrid(rows), state.model, 14_000);
  assert.deepStrictEqual(open.map((event) => [event.reason, event.status, event.sinceMs]), [["no-ballpark", "open", 4000]]);
  clock = 20_000;
  session.sendNotification("DoDestinyUpdate", "clientID", setState([ship(1), ship(2)]));
  const cleared = checker.step(serverGrid(rows), state.model, 21_000);
  assert.deepStrictEqual(cleared.map((event) => [event.reason, event.status, event.durationMs]),
    [["no-ballpark", "cleared", 10_000]]);
});

test("missiles are never position-checked", () => {
  const model = createClientModel();
  apply(model, setState([ship(1)]), 0);
  apply(model, addBalls([{ kind: "missile", itemID: 42, typeID: 209, radius: 1, position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 }, maxVelocity: 4000 }]), 0);
  const checker = createDivergenceChecker();
  const out = checker.step(serverGrid([row(1), row(42, { kind: "missile", mode: "GOTO", position: { x: 9e4, y: 0, z: 0 } })]),
    model, 2000);
  assert.deepStrictEqual(out, []);
});

// The phase's done-when, in miniature: an AddBalls path that skips one ball.
test("a watch over a teed session reports a ball the AddBalls path skipped as DIVERGE", async () => {
  const { createGridWatch } = require("../bridge/watch");
  let clock = 1_000;
  const session = gatewaySession();
  const tee = createDestinyTee({ decodePackaged: marshalDecodeExact, now: () => clock });
  const npcs = [ship(2, { typeID: 17932 }), ship(3, { typeID: 17932 })];
  const selfRow = { kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", name: "Rifter", mode: "STOP",
    distanceMeters: 0, position: { x: 1000, y: 2000, z: 3000 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const npcRow = (entity) => ({ kind: "ship", itemID: entity.itemID, isNpc: true, typeName: "Worm",
    name: `Guristas Worm ${entity.itemID}`, mode: "STOP", distanceMeters: 24_000, position: entity.position,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1 });
  const grids = [
    { inSpace: true, solarSystemID: 30002537, systemName: "Amamake", self: { itemID: 1 }, entities: [selfRow] },
    { inSpace: true, solarSystemID: 30002537, systemName: "Amamake", self: { itemID: 1 },
      entities: [selfRow, ...npcs.map(npcRow)] },
  ];
  let sample = 0;
  const watch = createGridWatch({
    findSession: () => session,
    readGrid: () => grids[Math.min(sample, 1)],
    destinyTee: tee,
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => {
      clock += ms;
      sample += 1;
      if (sample === 1) {
        // The server puts both NPCs on grid, but the broken path sends only one.
        session.sendNotification("DoDestinyUpdate", "clientID", addBalls(npcs.slice(0, 1)));
      }
    },
  });
  // The undock's SetState arrives before the watch starts.
  tee.attach(session);
  session.sendNotification("DoDestinyUpdate", "clientID", setState([ship(1)]));
  const lines = [];
  await watch.run({ characterID: 90000001, forMs: 8_000, everyMs: 2_000, offGridEveryMs: 60_000, clientMode: "all" },
    { write: (event) => lines.push(event), closed: () => false });
  const diverge = lines.filter((event) => event.kind === "DIVERGE");
  assert.deepStrictEqual(diverge.map((event) => [event.reason, event.itemID, event.status, event.label]),
    [["server-only", "3", "open", "Guristas Worm 3"]]);
  const added = lines.find((event) => event.kind === "CLIENT" && event.op === "AddBalls");
  assert.deepStrictEqual(added.balls.map((ball) => ball.itemID), ["2"]);
  assert.strictEqual(added.source, "client");
  const end = lines[lines.length - 1];
  assert.strictEqual(end.kind, "END");
  assert.strictEqual(end.client.notifications, 1);
});

test("client mode fx keeps the client's special effects and DIVERGE, without CLIENT lines", async () => {
  const { createGridWatch } = require("../bridge/watch");
  let clock = 1_000;
  const session = gatewaySession();
  const tee = createDestinyTee({ decodePackaged: marshalDecodeExact, now: () => clock });
  const selfRow = { kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", name: "Rifter", mode: "STOP",
    distanceMeters: 0, position: { x: 1000, y: 2000, z: 3000 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const grid = { inSpace: true, solarSystemID: 30002537, systemName: "Amamake", self: { itemID: 1 }, entities: [selfRow] };
  let sample = 0;
  const watch = createGridWatch({
    findSession: () => session,
    readGrid: () => grid,
    destinyTee: tee,
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => {
      clock += ms;
      sample += 1;
      if (sample === 1) {
        session.sendNotification("DoDestinyUpdate", "clientID", destinyUpdate(
          actions.buildOrbitPayload(1, 2, 2500),
          actions.buildOnSpecialFXPayload(1, "effects.ProjectileFired", { moduleID: 77, moduleTypeID: 486, targetID: 2,
            isOffensive: true, start: true, repeat: 1000 }),
        ));
      }
    },
  });
  tee.attach(session);
  session.sendNotification("DoDestinyUpdate", "clientID", setState([ship(1), ship(2)]));
  const lines = [];
  await watch.run({ characterID: 90000001, forMs: 4_000, everyMs: 2_000, offGridEveryMs: 60_000, clientMode: "fx" },
    { write: (event) => lines.push(event), closed: () => false });
  const kinds = lines.map((event) => `${event.kind}${event.op ? `:${event.op}` : ""}`);
  assert.ok(kinds.includes("FX"), kinds.join(" "));
  assert.ok(!kinds.some((kind) => kind.startsWith("CLIENT") && kind !== "CLIENT:attached"),
    `no CLIENT lines beyond the attach status every mode prints: ${kinds.join(" ")}`);
  const fx = lines.find((event) => event.kind === "FX");
  assert.deepStrictEqual([fx.guid, fx.label, fx.targetID, fx.offensive], ["effects.ProjectileFired", "self", "2", true]);
});

test("/grid?ext=1 adds the plugins' annotations to each row; without it the grid is as before", () => {
  const session = gatewaySession();
  const seen = [];
  const routes = createAgentBridgeRoutes({
    findSession: () => session,
    readGrid: (_session, options) => {
      const rows = [{ itemID: 2, isNpc: true }];
      if (options && options.annotate) options.annotate(rows[0], { itemID: 2 });
      return { entities: rows };
    },
    gridAnnotate: (row, entity, forSession) => {
      seen.push(forSession === session);
      Object.assign(row, { groupKey: "gang:a", ext: { demo: { side: "raiders" } } });
    },
  });
  assert.deepStrictEqual(routes.handle("GET", "/grid", { characterID: "7", ext: "1" }).body.grid.entities,
    [{ itemID: 2, isNpc: true, groupKey: "gang:a", ext: { demo: { side: "raiders" } } }]);
  assert.deepStrictEqual(routes.handle("GET", "/grid", { characterID: "7" }).body.grid.entities, [{ itemID: 2, isNpc: true }]);
  assert.deepStrictEqual(routes.handle("GET", "/grid", { characterID: "7", lu: "1" }).body.grid.entities, [{ itemID: 2, isNpc: true }],
    "the old ?lu=1 is gone");
  assert.deepStrictEqual(seen, [true]);
});

test("/tee attaches gateway sessions and /watch passes the client options through", () => {
  const calls = [];
  const session = gatewaySession();
  const routes = createAgentBridgeRoutes({
    findSession: (id) => (id === 7 ? session : null),
    destinyTee: createDestinyTee({ decodePackaged: marshalDecodeExact }),
    watcher: { busy: () => false, run: (params) => calls.push(params) },
  });
  const teed = routes.handle("POST", "/tee", {}, { characterID: 7 });
  assert.strictEqual(teed.statusCode, 200);
  assert.strictEqual(teed.body.attached, true);
  assert.strictEqual(routes.handle("POST", "/tee", {}, { characterID: 8 }).statusCode, 409);
  assert.strictEqual(routes.handle("POST", "/watch", {}, { characterID: 7, client: "loud" }).statusCode, 400);
  assert.strictEqual(routes.handle("POST", "/watch", {}, { characterID: 7, divergeMeters: -1 }).statusCode, 400);
  const watched = routes.handle("POST", "/watch", {}, { characterID: 7, client: "diverge", divergeMeters: 2000 });
  watched.stream({ write() {}, closed: () => false });
  assert.deepStrictEqual([calls[0].clientMode, calls[0].divergeMeters], ["diverge", 2000]);
});

test("a ball the server shows but the client never got opens a DIVERGE, and clears when it arrives", () => {
  const model = createClientModel();
  apply(model, setState([ship(1)]), 0);
  const checker = createDivergenceChecker();
  const rows = [row(1), row(2, { distanceMeters: 24_000 })];
  assert.deepStrictEqual(checker.step(serverGrid(rows), model, 1000), []);
  assert.deepStrictEqual(checker.step(serverGrid(rows), model, 2000), [], "not yet past settleMs");
  const opened = checker.step(serverGrid(rows), model, 4000);
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(opened[0].kind, "DIVERGE");
  assert.strictEqual(opened[0].reason, "server-only");
  assert.strictEqual(opened[0].itemID, "2");
  assert.strictEqual(opened[0].status, "open");
  apply(model, addBalls([ship(2)]), 4500);
  const cleared = checker.step(serverGrid(rows), model, 5000);
  assert.deepStrictEqual(cleared.map((event) => [event.reason, event.status, event.durationMs]), [["server-only", "cleared", 4000]]);
});

test("one-sided balls, mode mismatches, position errors, bad warp landings and orphans are reported", () => {
  const model = createClientModel();
  apply(model, setState([ship(1), ship(2), ship(3, { mode: "ORBIT", targetEntityID: 1, orbitDistance: 500 })]), 0);
  // Ball 4 lands far from where the client was told it warps to.
  apply(model, addBalls([ship(4, { mode: "WARP", warpState: { targetPoint: { x: 0, y: 0, z: 0 }, stopDistance: 0,
    effectStamp: 1, totalDistance: 1e9 } })]), 0);
  apply(model, destinyUpdate(actions.buildSetBallPositionPayload(2, { x: 1000, y: 2000, z: 3000 })), 0);
  apply(model, destinyUpdate(actions.buildStopPayload(77)), 0);
  const checker = createDivergenceChecker({ positionMeters: 5000 });
  const rows = [
    row(1),
    row(2, { position: { x: 1000 + 60_000, y: 2000, z: 3000 } }),
    row(3, { mode: "STOP" }),
    row(4, { mode: "STOP", position: { x: 250_000, y: 0, z: 0 } }),
  ];
  const first = checker.step(serverGrid(rows), model, 1000);
  assert.deepStrictEqual(first.map((event) => `${event.reason}:${event.itemID}:${event.status}`).sort(),
    ["position:2:once", "unknown-ball:77:once", "warp-landing:4:once"]);
  assert.strictEqual(first.find((event) => event.reason === "warp-landing").errorMeters, 250_000);
  assert.strictEqual(model.balls.get("4").mode, "STOP", "the client drops out of warp by itself");

  const rowsWithout1 = rows.filter((entry) => entry.itemID !== 1);
  checker.step(serverGrid(rowsWithout1), model, 2000);
  const later = checker.step(serverGrid(rowsWithout1), model, 5000);
  assert.deepStrictEqual(later.map((event) => `${event.reason}:${event.itemID}:${event.status}`).sort(),
    ["client-only:1:open", "mode:3:open"]);
  const mode = later.find((event) => event.reason === "mode");
  assert.deepStrictEqual([mode.clientMode, mode.serverMode], ["ORBIT", "STOP"]);
});

test("a WarpTo is only checked on landing once the server has shown the warp", () => {
  const model = createClientModel();
  apply(model, setState([ship(1)]), 0);
  apply(model, destinyUpdate(actions.buildWarpToPayload(1, { x: 1e9, y: 0, z: 0 }, 0, 3000)), 0);
  const checker = createDivergenceChecker();
  // The server is still aligning (GOTO): no landing check, no mode mismatch.
  assert.deepStrictEqual(checker.step(serverGrid([row(1, { mode: "GOTO" })]), model, 1000), []);
  assert.deepStrictEqual(checker.step(serverGrid([row(1, { mode: "WARP" })]), model, 2000), []);
  const landed = checker.step(serverGrid([row(1, { mode: "STOP", position: { x: 1e9 - 100, y: 0, z: 0 } })]), model, 30_000);
  assert.deepStrictEqual(landed, [], "landed within the threshold");
  assert.strictEqual(model.balls.get("1").mode, "STOP");
});
