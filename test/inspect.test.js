"use strict";

// `gridcheck inspect` and the sessionless grid (`grid --at`): the entity
// locator, the inspector and its route, the grid reader around an anchor and
// the rows' capacitor and module fields, each from fake scenes.

const test = require("node:test");
const assert = require("node:assert");

const { createEntityLocator, activeModulesOf, describeController, capacitorPctOf } = require("../bridge/entities");
const { createInspector } = require("../bridge/inspect");
const { createGridReader, AT_RANGE_METERS } = require("../bridge/grid");
const { createAgentBridgeRoutes } = require("../bridge/routes");
const { formatInspect } = require("../core/inspect");
const { formatGrid } = require("../core/format");

const SIM_NOW = 500_000;

function fakeScene(systemID, dynamic, statics = []) {
  const byID = new Map(statics.map((entity) => [entity.itemID, entity]));
  return {
    systemID,
    dynamicEntities: new Map(dynamic.map((entity) => [entity.itemID, entity])),
    staticEntities: statics,
    staticEntitiesByID: byID,
    getEntityByID(id) { return this.dynamicEntities.get(id) || byID.get(id) || null; },
    getCurrentSimTimeMs: () => SIM_NOW,
  };
}

function fakeSpace(...scenes) {
  return { getSceneForSession: () => null, scenes: new Map(scenes.map((scene, index) => [`scene${index}`, scene])) };
}

const effect = (moduleID, extra = {}) => ({ moduleID, typeID: 483, groupID: 54, effectName: "miningLaser", effectID: 67, targetID: 50,
  startedAtMs: SIM_NOW - 8000, durationMs: 1000, nextCycleAtMs: SIM_NOW + 400, capNeed: 0, repeat: 0, remainingCycles: null,
  deactivationRequestedAtMs: 0, deactivateAtMs: 0, stopReason: null, ...extra });

function minerEntity(extra = {}) {
  return {
    kind: "ship", itemID: 2, typeID: 32880, slimName: "Corp Miner", radius: 30, position: { x: 100, y: 0, z: 0 },
    velocity: { x: 3, y: 4, z: 0 }, mode: "MINING", ownerID: 98000001, corporationID: 98000001, nativeNpc: true, npcEntityType: "npc",
    capacitorChargeRatio: 0.04, capacitorCapacity: 300, capacitorRechargeRate: 250_000, systemID: 30001389,
    activeModuleEffects: new Map([[5001, effect(5001)]]),
    lockedTargets: new Map([[50, {}]]),
    pendingTargetLocks: new Map([[51, { completeAtMs: SIM_NOW + 2000, totalDurationMs: 4000 }]]),
    targetedBy: new Set([77]),
    fittedItems: [{ itemID: 5001, typeID: 483, flagID: 27 }],
    ...extra,
  };
}

// The gateway projection's shape, for the fields the tests read.
function projectEntity(entity, egoItemID = 0) {
  return {
    kind: entity.kind || null, itemID: entity.itemID, typeID: entity.typeID || null,
    name: String(entity.slimName || entity.itemName || "") || null, ownerID: entity.ownerID || null, radius: entity.radius || 0,
    position: entity.position || null, velocity: entity.velocity || null, isSelf: entity.itemID === egoItemID,
    shieldRatio: 1, armorRatio: 0.5, hullRatio: 1, mode: entity.mode || null, isNpc: entity.nativeNpc === true,
    npcEntityType: entity.npcEntityType || null, corporationID: entity.corporationID || null,
  };
}

const describeType = (typeID) => ({ 32880: "Venture", 483: "Miner I", 1230: "Veldspar" }[typeID] || null);
const describeSystem = (id) => (id === 30001389 ? { name: "Yulai", security: 0.9 } : id === 30002537 ? { name: "Amamake", security: 0.4 } : null);

function inspectorFor(space, extra = {}) {
  const locate = createEntityLocator({ space, describeSystem, describeItem: extra.describeItem });
  return { locate, inspector: createInspector({ locate, projectEntity, describeType, describeSystem, ...extra }) };
}

test("the locator finds an entity in any loaded scene, static or dynamic", () => {
  const space = fakeSpace(fakeScene(30002537, [{ itemID: 9, kind: "ship" }]), fakeScene(30001389, [minerEntity()], [{ itemID: 50, kind: "asteroid" }]));
  const locate = createEntityLocator({ space });
  assert.strictEqual(locate.find(2).scene.systemID, 30001389);
  assert.strictEqual(locate.find(50).entity.kind, "asteroid");
  assert.strictEqual(locate.find(9).scene.systemID, 30002537);
  assert.strictEqual(locate.find(12345), null);
  assert.strictEqual(locate.find("nope"), null);
  assert.strictEqual(createEntityLocator({ space: {} }).find(2), null, "a runtime with no scenes finds nothing");
});

test("a missing entity is explained: unknown item, unloaded system scene, loaded scene without it", () => {
  const space = fakeSpace(fakeScene(30001389, []));
  const items = { 100: { locationID: 30002537 }, 101: { locationID: 30001389 }, 102: { locationID: 60003760 } };
  const locate = createEntityLocator({ space, describeSystem, describeItem: (id) => items[id] || null });
  assert.match(locate.explainMissing(100), /Amamake \(30002537\), whose scene is not loaded/);
  assert.match(locate.explainMissing(101), /Yulai, whose scene is loaded, but it is not an entity there/);
  assert.match(locate.explainMissing(102), /location 60003760/);
  assert.match(locate.explainMissing(103), /No entity 103 in the 1 loaded scene .*item store has no such item/);
  assert.match(createEntityLocator({ space }).explainMissing(103), /scene is not loaded it cannot be read/);
});

test("inspect: the record has identity, motion, capacitor, modules in scene time, locks, fitted modules and the controller", () => {
  const controller = { runtimeKind: "nativeCombat", entityType: "npc", lastDecision: "mine", currentTargetID: 50, preferredTargetID: 0,
    controllerPaused: false, pausedReason: "", nextThinkAtMs: SIM_NOW + 250, ownerCharacterID: 0, behaviorProfile: { a: 1, b: 2 },
    waypoints: [1, 2, 3], hunterReports: new Array(20).fill({}), fn() {} };
  const { inspector } = inspectorFor(fakeSpace(fakeScene(30001389, [minerEntity()])), {
    controllerFor: (id) => (id === 2 ? controller : null),
    annotate: (row) => { row.ext = { lu: { family: "miner" } }; row.groupKey = "flight:1"; },
  });
  const reply = inspector.inspect(2);
  assert.strictEqual(reply.statusCode, 200);
  const e = reply.body.entity;
  assert.deepStrictEqual([e.itemID, e.name, e.kind, e.typeID, e.typeName, e.systemID, e.systemName, e.mode],
    [2, "Corp Miner", "ship", 32880, "Venture", 30001389, "Yulai", "MINING"]);
  assert.deepStrictEqual([e.speed, e.simTimeMs, e.armorRatio, e.ownerID, e.corporationID, e.characterID, e.isNpc, e.npcEntityType],
    [5, SIM_NOW, 0.5, 98000001, 98000001, null, true, "npc"]);
  assert.deepStrictEqual(e.capacitor, { ratio: 0.04, pct: 4, capacity: 300, amount: 12, rechargeMs: 250_000 });
  assert.strictEqual(e.activeModules.length, 1);
  const m = e.activeModules[0];
  assert.deepStrictEqual([m.moduleID, m.typeName, m.effectName, m.targetID, m.nextCycleInMs, m.runningMs, m.durationMs, m.deactivateAtMs, m.stopReason],
    [5001, "Miner I", "miningLaser", 50, 400, 8000, 1000, null, null]);
  assert.deepStrictEqual(e.locks, { locked: [50], pending: [{ targetID: 51, completeInMs: 2000, totalDurationMs: 4000 }], lockedBy: [77] });
  assert.deepStrictEqual(e.fittedModules, [{ itemID: 5001, typeID: 483, typeName: "Miner I", flagID: 27 }]);
  assert.deepStrictEqual([e.controller.decision, e.controller.currentTargetID, e.controller.preferredTargetID, e.controller.paused,
    e.controller.nextThinkInMs, e.controller.runtimeKind], ["mine", 50, null, false, 250, "nativeCombat"]);
  assert.deepStrictEqual(e.controller.fields.waypoints, [1, 2, 3], "a short scalar list stays");
  assert.deepStrictEqual(Object.keys(e.controller.nested).sort(), ["behaviorProfile", "hunterReports"]);
  assert.match(e.controller.nested.hunterReports, /array of 20/);
  assert.strictEqual("fn" in e.controller.fields, false);
  assert.deepStrictEqual(e.ext, { lu: { family: "miner" } });
});

test("inspect: an entity with none of the fields gives nulls, not errors", () => {
  const { inspector } = inspectorFor(fakeSpace(fakeScene(30001389, [], [{ itemID: 50, kind: "asteroid", typeID: 1230 }])));
  const e = inspector.inspect(50).body.entity;
  assert.deepStrictEqual([e.capacitor, e.activeModules, e.fittedModules, e.controller, e.mode, e.position, e.speed],
    [null, [], null, null, null, null, null]);
  assert.deepStrictEqual(e.locks, { locked: [], pending: [], lockedBy: [] });
  assert.strictEqual(e.typeName, "Veldspar");
});

test("inspect: a sentinel next cycle and a paused controller read as never and paused", () => {
  const entity = minerEntity({ activeModuleEffects: new Map([[1, effect(1, { nextCycleAtMs: Number.MAX_SAFE_INTEGER })]]) });
  const { inspector } = inspectorFor(fakeSpace(fakeScene(30001389, [entity])), {
    controllerFor: () => ({ controllerPaused: true, pausedReason: "no-player", nextThinkAtMs: Number.MAX_SAFE_INTEGER }),
  });
  const e = inspector.inspect(2).body.entity;
  assert.strictEqual(e.activeModules[0].nextCycleInMs, null);
  assert.deepStrictEqual([e.controller.paused, e.controller.pausedReason, e.controller.nextThinkInMs], [true, "no-player", null]);
});

test("GET /inspect: 400 without an itemID, 404 with the explanation, 200 with the record; no character needed", () => {
  const space = fakeSpace(fakeScene(30001389, [minerEntity()]));
  const { locate, inspector } = inspectorFor(space, { describeItem: (id) => (id === 9 ? { locationID: 30002537 } : null) });
  const routes = createAgentBridgeRoutes({ findSession: () => { throw new Error("no session lookup"); }, inspector, explainAnchor: locate.explainMissing });
  assert.strictEqual(routes.handle("GET", "/inspect", {}, {}).statusCode, 400);
  const missing = routes.handle("GET", "/inspect", { itemID: "9" }, {});
  assert.strictEqual(missing.statusCode, 404);
  assert.match(missing.body.error, /Amamake.*scene is not loaded/);
  const found = routes.handle("GET", "/inspect", { itemID: "2" }, {});
  assert.strictEqual(found.statusCode, 200);
  assert.strictEqual(found.body.entity.itemID, 2);
  assert.strictEqual(createAgentBridgeRoutes({ findSession: () => null }).handle("GET", "/inspect", { itemID: "2" }, {}).statusCode, 503);
});

test("the inspect text names the capacitor, each module with its timing, the locks and the controller", () => {
  const { inspector } = inspectorFor(fakeSpace(fakeScene(30001389, [minerEntity()])), {
    controllerFor: () => ({ runtimeKind: "nativeCombat", entityType: "npc", lastDecision: "mine", currentTargetID: 50, nextThinkAtMs: SIM_NOW + 250,
      controllerPaused: true, pausedReason: "no-player", behaviorProfile: { a: 1 } }),
    annotate: (row) => { row.ext = { lu: { family: "miner" } }; },
  });
  const text = formatInspect(inspector.inspect(2).body.entity);
  assert.match(text, /^#2 Corp Miner  ship  mode MINING  in Yulai \(30001389\)/);
  assert.match(text, /capacitor 4% \(12 of 300\), recharge 250 s/);
  assert.match(text, /locks: #50; pending #51 in 2000 ms; locked by #77/);
  assert.match(text, /#5001 Miner I \(miningLaser\) on #50\n\s+cycle 1000 ms, next in 400 ms, running 8000 ms/);
  assert.match(text, /controller: nativeCombat npc  decision mine  target #50  next think in 250 ms  PAUSED \(no-player\)/);
  assert.match(text, /not shown: behaviorProfile \(object, 1 key: a\)/);
  assert.match(text, /plugin lu: \{"family":"miner"\}/);
  assert.match(formatInspect({ ...inspector.inspect(2).body.entity, capacitor: null, controller: null, ext: null, activeModules: [] }),
    /capacitor: none on this entity[\s\S]*modules running: 0 \(none\)[\s\S]*controller: none/);
});

test("capacitor and module helpers read defensively", () => {
  assert.strictEqual(capacitorPctOf({ capacitorChargeRatio: 0.6667 }), 66.7);
  assert.strictEqual(capacitorPctOf({ capacitorChargeRatio: 7 }), 100);
  assert.strictEqual(capacitorPctOf({}), null);
  assert.strictEqual(capacitorPctOf({ capacitorChargeRatio: null }), null);
  assert.deepStrictEqual(activeModulesOf({}), []);
  assert.deepStrictEqual(activeModulesOf({ activeModuleEffects: new Map([[1, { effectName: "afterburner" }], [2, null]]) }),
    [{ moduleID: 1, name: "afterburner", effectName: "afterburner", targetID: null }]);
  assert.strictEqual(describeController(null, 0), null);
});

// ---------- the sessionless grid ----------

function anchorWorld() {
  const statics = [
    { kind: "stargate", itemID: 90, itemName: "Stargate (Auga)", typeID: 16, radius: 5000, position: { x: 300_000, y: 0, z: 0 } },
    { kind: "planet", itemID: 91, itemName: "Yulai I", typeID: 11, radius: 6_000_000, position: { x: 9e10, y: 0, z: 0 } },
    { kind: "asteroid", itemID: 50, itemName: "Veldspar", typeID: 1230, radius: 100, position: { x: 2000, y: 0, z: 0 } },
  ];
  const dynamic = [
    minerEntity(),
    { kind: "ship", itemID: 3, typeID: 32880, slimName: "Other Miner", radius: 30, position: { x: 4000, y: 0, z: 0 }, nativeNpc: true,
      capacitorChargeRatio: 0.9, activeModuleEffects: new Map() },
    { kind: "ship", itemID: 4, typeID: 587, slimName: "Far Rifter", radius: 30, position: { x: 50_000_000, y: 0, z: 0 } },
    { kind: "wreck", itemID: 6, typeID: 26, slimName: "Wreck", radius: 20, position: { x: 1000, y: 0, z: 0 } },
  ];
  return fakeSpace(fakeScene(30001389, dynamic, statics), fakeScene(30002537, [{ kind: "ship", itemID: 8, typeID: 587, position: { x: 0, y: 0, z: 0 } }]));
}

function readerFor(space) {
  return createGridReader({ space, projectEntity, describeType, describeSystem,
    npcDecision: (entity) => (entity.itemID === 3 ? "idle" : null) });
}

test("readGridAt reads around the anchor with no session: nearest first, anchor marked, nobody isSelf, far things left out", () => {
  const grid = readerFor(anchorWorld()).readGridAt(2);
  assert.deepStrictEqual(grid.entities.map((row) => row.itemID), [2, 6, 50, 3, 90], "dynamic and static, within the default reach");
  assert.strictEqual(grid.entities[0].anchor, true);
  assert.ok(grid.entities.every((row) => row.isSelf === false));
  assert.strictEqual(grid.entities.filter((row) => row.anchor).length, 1);
  assert.deepStrictEqual([grid.inSpace, grid.characterID, grid.self, grid.solarSystemID, grid.systemName, grid.rangeMeters],
    [true, null, null, 30001389, "Yulai", AT_RANGE_METERS]);
  assert.deepStrictEqual([grid.anchor.itemID, grid.anchor.name, grid.anchor.typeName, grid.anchor.mode], [2, "Corp Miner", "Venture", "MINING"]);
  assert.strictEqual(grid.sampledAtMs, SIM_NOW, "scene time");
  const wreck = grid.entities.find((row) => row.itemID === 6);
  assert.strictEqual(wreck.distanceMeters, 850, "surface distance from the anchor: 900 m between centres, less both radii");
  assert.strictEqual(grid.entities.find((row) => row.itemID === 3).decision, "idle", "NPC decisions come with the rows");
});

test("readGridAt: a range narrows it, another system's entity is never read, a missing anchor is null", () => {
  const reader = readerFor(anchorWorld());
  assert.deepStrictEqual(reader.readGridAt(2, { rangeMeters: 3000 }).entities.map((row) => row.itemID), [2, 6, 50]);
  assert.deepStrictEqual(reader.readGridAt(8).entities.map((row) => row.itemID), [8], "the other system's scene has only itself");
  assert.strictEqual(reader.readGridAt(12345), null);
  const annotated = reader.readGridAt(2, { rangeMeters: 1, annotate: (row) => { row.ext = { probe: row.itemID }; } });
  assert.deepStrictEqual(annotated.entities.map((row) => row.ext), [{ probe: 2 }]);
});

test("rows get capacitorPct and activeModules for ships, and neither key for a rock", () => {
  const grid = readerFor(anchorWorld()).readGridAt(2);
  const row = (id) => grid.entities.find((entry) => entry.itemID === id);
  assert.strictEqual(row(2).capacitorPct, 4);
  assert.deepStrictEqual(row(2).activeModules, [{ moduleID: 5001, name: "Miner I", effectName: "miningLaser", targetID: 50 }]);
  assert.deepStrictEqual([row(3).capacitorPct, row(3).activeModules], [90, []]);
  assert.strictEqual(row(50).capacitorPct, undefined);
  assert.strictEqual("activeModules" in row(50), false);
  const noCap = readerFor(anchorWorld()).readGridAt(4, { rangeMeters: 1 }).entities[0];
  assert.deepStrictEqual([noCap.capacitorPct, noCap.activeModules], [null, []], "a ship without the fields");
});

test("readGrid (a session) carries the same two fields", () => {
  const ego = { kind: "ship", itemID: 1, typeID: 587, position: { x: 0, y: 0, z: 0 }, capacitorChargeRatio: 0.5,
    activeModuleEffects: new Map([[1, effect(1)]]) };
  const scene = { getShipEntityForSession: () => ego, getVisibleEntitiesForSession: () => [ego], getCurrentSimTimeMs: () => SIM_NOW };
  const grid = createGridReader({ space: { getSceneForSession: () => scene }, projectEntity, describeType })
    .readGrid({ characterID: 7, _space: { systemID: 30001389, shipID: 1 } });
  assert.deepStrictEqual([grid.entities[0].capacitorPct, grid.entities[0].activeModules.length], [50, 1]);
});

test("GET /grid?at= is the sessionless read: 400, 404 with the reason, 200, the range in km; characterID still works", () => {
  const space = anchorWorld();
  const locate = createEntityLocator({ space, describeSystem });
  const reader = readerFor(space);
  const routes = createAgentBridgeRoutes({
    findSession: (id) => (id === 7 ? { characterID: 7 } : null),
    readGrid: (session) => ({ characterID: session.characterID }),
    readGridAt: reader.readGridAt,
    explainAnchor: locate.explainMissing,
    gridAnnotate: (row, _entity, session) => { row.ext = { session: session === null ? "none" : "some" }; },
  });
  assert.strictEqual(routes.handle("GET", "/grid", { at: "abc" }, {}).statusCode, 400);
  assert.strictEqual(routes.handle("GET", "/grid", { at: "2", range: "-1" }, {}).statusCode, 400);
  const missing = routes.handle("GET", "/grid", { at: "777" }, {});
  assert.strictEqual(missing.statusCode, 404);
  assert.match(missing.body.error, /No entity 777/);
  const ok = routes.handle("GET", "/grid", { at: "2", range: "3", ext: "1" }, {});
  assert.deepStrictEqual(ok.body.grid.entities.map((row) => row.itemID), [2, 6, 50]);
  assert.deepStrictEqual(ok.body.grid.entities[0].ext, { session: "none" });
  assert.deepStrictEqual(routes.handle("GET", "/grid", { characterID: "7" }, {}).body.grid, { characterID: 7 });
});

test("POST /watch with at: validated, 404 when the entity is not there, never both at and a character", () => {
  const space = anchorWorld();
  const locate = createEntityLocator({ space, describeSystem });
  const reader = readerFor(space);
  const calls = [];
  const routes = createAgentBridgeRoutes({
    findSession: () => { throw new Error("no session lookup for an anchor watch"); },
    readGridAt: reader.readGridAt,
    explainAnchor: locate.explainMissing,
    watcher: { busy: () => false, run: (params, out) => { calls.push(params); out.write({ kind: "END" }); } },
  });
  assert.strictEqual(routes.handle("POST", "/watch", {}, { at: "x" }).statusCode, 400);
  assert.strictEqual(routes.handle("POST", "/watch", {}, { at: 2, characterID: 7 }).statusCode, 400);
  assert.strictEqual(routes.handle("POST", "/watch", {}, { at: 2, modules: "no" }).statusCode, 400);
  assert.strictEqual(routes.handle("POST", "/watch", {}, { at: 777 }).statusCode, 404);
  const accepted = routes.handle("POST", "/watch", {}, { at: 2, forSeconds: 30, modules: false });
  assert.strictEqual(accepted.statusCode, 200);
  accepted.stream({ write() {}, closed: () => false });
  assert.deepStrictEqual([calls[0].at, calls[0].characterID, calls[0].modules], [2, null, false]);
});

test("the grid table: cap and mods columns when a row has them, an anchor header and row, --npc", () => {
  const grid = readerFor(anchorWorld()).readGridAt(2);
  const text = formatGrid(grid, { all: true });
  const lines = text.split("\n");
  assert.match(lines[0], /^Yulai \(0\.9\)  anchor: Corp Miner #2 \(MINING, within 7,864 km\)$/);
  assert.match(lines[1], /S\/A\/H\s+cap\s+mods$/);
  assert.match(lines.find((line) => line.includes("(anchor)")), /\(anchor\) Corp Miner\s+Venture\s+npc\s+MINING\s+-\s+100\/50\/100\s+4%\s+1$/);
  assert.match(lines.find((line) => line.includes("Other Miner")), /100\/50\/100\s+90%\s+0$/);
  const npcOnly = formatGrid(grid, { all: true, npc: true }).split("\n");
  assert.deepStrictEqual(npcOnly.slice(2).map((line) => /Corp Miner|Other Miner/.exec(line)[0]), ["Corp Miner", "Other Miner"]);
  const plain = formatGrid({ inSpace: true, solarSystemID: 1, self: { typeName: "Rifter", mode: "STOP" },
    entities: [{ itemID: 1, isSelf: true, name: "Rifter", distanceMeters: 0, kind: "ship" }] }, {});
  assert.doesNotMatch(plain, /cap|mods/, "no cap column when nothing has one");
});
