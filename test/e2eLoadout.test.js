"use strict";

// Loadouts (core/loadout.js, bridge/loadout.js): reading "Name xN" lists,
// refusing unknown names and missing skills before anything changes, and the
// stock calls a build makes, docked and in space, with the stock modules faked.
// The live round trip is in the compatibility lane (test/compat.js).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { formatLoadoutReply, loadoutBody, normalizeLoadout, parseEntry } = require("../core/loadout");
const { LOADOUT_EXPORTS, createLoadout, loadLoadoutModules } = require("../bridge/loadout");
const { createAgentBridgeRoutes } = require("../bridge/routes");
const { probeLoadoutExports } = require("../core/capabilities");
const { validateScenario, describeStep } = require("../core/scenario");
const { createToolRegistry } = require("../core/plugins");

const TYPES = [
  { typeID: 593, name: "Tristan", categoryID: 6 },
  { typeID: 3170, name: "Light Neutron Blaster II", categoryID: 7 },
  { typeID: 438, name: "1MN Afterburner II", categoryID: 7 },
  { typeID: 2456, name: "Hobgoblin II", categoryID: 18 },
  { typeID: 230, name: "Antimatter Charge S", categoryID: 8 },
  { typeID: 3436, name: "Drones", categoryID: 16 },
  { typeID: 3302, name: "Small Hybrid Turret", categoryID: 16 },
  { typeID: 3328, name: "Gallente Frigate", categoryID: 16 },
];
const BY_ID = new Map(TYPES.map((type) => [type.typeID, type]));
const REQUIREMENTS = {
  593: [{ skillTypeID: 3328, level: 1 }],
  3170: [{ skillTypeID: 3302, level: 5 }],
  2456: [{ skillTypeID: 3436, level: 5 }],
};
const GUN_FLAGS = [27, 28];

// The stock modules as the bridge loads them, recording every call that
// changes the world.
function fakeStock({ skills = { 3328: 5, 3302: 5, 3436: 5 }, docked = true } = {}) {
  const calls = [];
  const fitted = [];
  let nextItemID = 9000;
  const resolveByName = (query) => {
    const exact = TYPES.find((type) => type.name.toLowerCase() === String(query).toLowerCase());
    if (exact) return { success: true, match: exact };
    const partial = TYPES.filter((type) => type.name.toLowerCase().includes(String(query).toLowerCase()));
    return partial.length === 1 ? { success: true, match: partial[0] } : { success: false, errorMsg: "ITEM_NOT_FOUND", suggestions: [] };
  };
  const m = {
    shipTypes: { resolveShipByName: resolveByName },
    itemTypes: { resolveItemByName: resolveByName, resolveItemByTypeID: (typeID) => BY_ID.get(typeID) || null },
    skills: {
      getCachedCharacterSkillMap: () => new Map(Object.entries(skills).map(([typeID, level]) => [Number(typeID), { effectiveSkillLevel: level }])),
    },
    fitting: {
      getRequiredSkillRequirements: (typeID) => REQUIREMENTS[typeID] || [],
      isChargeCompatibleWithModule: (moduleTypeID, chargeTypeID) => moduleTypeID === 3170 && chargeTypeID === 230,
      getModuleChargeCapacity: () => 40,
      listFittedItems: () => fitted.slice(),
    },
    location: {
      isDockedSession: () => docked,
      getDockedLocationID: () => (docked ? 60004588 : 0),
    },
    character: {
      getCharacterRecord: () => ({ homeStationID: 60003760 }),
      syncInventoryItemForSession: () => calls.push(["sync"]),
      activateShipForSession: (_session, shipID) => {
        calls.push(["board docked", shipID]);
        return { success: true };
      },
    },
    itemStore: {
      ITEM_FLAGS: { HANGAR: 4, CARGO_HOLD: 5, DRONE_BAY: 87 },
      grantItemToCharacterLocation: (_charID, locationID, _flag, type) => {
        calls.push(["make ship", type.name, locationID]);
        return { success: true, data: { items: [{ itemID: 1001, typeID: type.typeID }], changes: [{ item: { itemID: 1001 } }] } };
      },
      grantItemsToCharacterStationHangar: (_charID, locationID, entries) => {
        calls.push(["grant", locationID, entries.map((entry) => `${entry.itemType.name} x${entry.quantity}`)]);
        return { success: true, data: { changes: [] } };
      },
      moveItemTypeFromCharacterLocation: (_charID, _from, _flag, shipID, flagID, typeID, quantity) => {
        calls.push(["load", shipID, flagID, BY_ID.get(typeID).name, quantity]);
        return { success: true, data: { changes: [] } };
      },
    },
    shipRuntime: {
      fitGrantedItemTypeToShip: (_session, _locationID, _ship, type, count) => {
        for (let index = 0; index < count; index += 1) {
          const flagID = type.typeID === 3170 ? GUN_FLAGS[index] : 19;
          fitted.push({ itemID: nextItemID += 1, typeID: type.typeID, flagID, categoryID: 7 });
        }
        calls.push(["fit", type.name, count]);
        return { success: true, data: { fittedCount: count } };
      },
      moveGrantedItemTypeToShipDroneBay: (_session, _locationID, _ship, type, quantity) => {
        calls.push(["drone bay", type.name, quantity]);
        return { success: true };
      },
      moveGrantedItemTypeToShipCargo: (_session, _locationID, _ship, type, quantity) => {
        calls.push(["cargo", type.name, quantity]);
        return { success: true };
      },
      boardPreparedShipInSpace: (_session, ship) => {
        calls.push(["board in space", ship.itemID]);
        return { success: true, data: { destroyResult: { destroyedShipID: 777 } } };
      },
    },
  };
  return { m, calls };
}

const SESSION_DOCKED = { characterID: 90000001 };
const SESSION_IN_SPACE = { characterID: 90000001, _space: { systemID: 30002537, shipID: 777 } };
const STARTER = {
  ship: "Tristan",
  modules: ["Light Neutron Blaster II x2", "1MN Afterburner II"],
  drones: ["Hobgoblin II x5"],
  cargo: ["Antimatter Charge S x400"],
  charges: ["Antimatter Charge S"],
};

test("a loadout reads Name xN, adds up repeats and refuses what it can't build", () => {
  assert.deepStrictEqual(parseEntry("Hobgoblin II x5"), { name: "Hobgoblin II", quantity: 5, counted: true });
  assert.deepStrictEqual(parseEntry("  1MN  Afterburner II "), { name: "1MN Afterburner II", quantity: 1, counted: false });
  const { loadout } = normalizeLoadout({ ship: "Tristan", modules: ["Light Neutron Blaster II", "light neutron blaster II x2"] });
  assert.deepStrictEqual(loadout.modules, [{ name: "Light Neutron Blaster II", quantity: 3 }]);
  assert.deepStrictEqual(loadoutBody(loadout), { ship: "Tristan", modules: ["Light Neutron Blaster II x3"] });

  const bad = normalizeLoadout({ ship: "Tristan x2", modules: "Light Neutron Blaster II", charges: ["Antimatter Charge S x40"], rigs: [] });
  assert.strictEqual(bad.loadout, null);
  assert.ok(bad.problems.some((line) => /^rigs: unknown key/.test(line)));
  assert.ok(bad.problems.some((line) => /^ship: one hull/.test(line)));
  assert.ok(bad.problems.some((line) => /put spares in cargo/.test(line)));
  assert.ok(!bad.problems.some((line) => /^modules/.test(line)), "a lone string is a one-item list");
  assert.ok(normalizeLoadout({ modules: [] }).problems.some((line) => /^ship:/.test(line)));
});

test("docked: the hull is made in the station, fitted, filled, every gun loaded, then boarded", () => {
  const { m, calls } = fakeStock();
  const reply = createLoadout(m)(SESSION_DOCKED, STARTER);
  assert.strictEqual(reply.statusCode, 200, JSON.stringify(reply.body));
  const changes = calls.filter(([what]) => what !== "sync");
  assert.deepStrictEqual(changes, [
    ["make ship", "Tristan", 60004588],
    ["grant", 60004588, ["Light Neutron Blaster II x2", "1MN Afterburner II x1", "Hobgoblin II x5", "Antimatter Charge S x400"]],
    ["fit", "Light Neutron Blaster II", 2],
    ["fit", "1MN Afterburner II", 1],
    ["drone bay", "Hobgoblin II", 5],
    ["cargo", "Antimatter Charge S", 400],
    ["grant", 60004588, ["Antimatter Charge S x80"]],
    ["load", 1001, 27, "Antimatter Charge S", 40],
    ["load", 1001, 28, "Antimatter Charge S", 40],
    ["board docked", 1001],
  ]);
  assert.ok(calls.some(([what]) => what === "sync"), "a docked session sees its hangar change");
  const body = reply.body;
  assert.strictEqual(body.ship.itemID, 1001);
  assert.strictEqual(body.docked, true);
  assert.strictEqual(body.locationID, 60004588);
  assert.deepStrictEqual(body.modules.map((row) => [row.slot, row.name, row.charge && row.charge.quantity]),
    [["mid", "1MN Afterburner II", undefined], ["high", "Light Neutron Blaster II", 40], ["high", "Light Neutron Blaster II", 40]]);
  assert.strictEqual(body.skillsChecked, 3, "the hull's, the gun's and the drone's; the afterburner and charge need none here");
  assert.match(formatLoadoutReply(body), /^boarded Tristan 1001 docked in 60004588\n/);
});

test("in space: the hull is staged at the home station and swapped in, and the old ship is named", () => {
  const { m, calls } = fakeStock({ docked: false });
  const reply = createLoadout(m)(SESSION_IN_SPACE, { ship: "Tristan" });
  assert.strictEqual(reply.statusCode, 200);
  assert.deepStrictEqual(calls, [["make ship", "Tristan", 60003760], ["board in space", 1001]],
    "in space nothing syncs: the hangar it was made in isn't the session's");
  assert.strictEqual(reply.body.replacedShipID, 777);
  assert.strictEqual(reply.body.systemID, 30002537);
  assert.match(formatLoadoutReply(reply.body), /in space, system 30002537; the old ship 777 was removed/);
});

test("an unknown or near-miss name, a misplaced item or an unloadable charge is refused before anything is made", () => {
  const { m, calls } = fakeStock();
  const run = createLoadout(m);
  const reply = run(SESSION_DOCKED, { ship: "Tristan", modules: ["Neutron Blaster II", "Hobgoblin II", "Warp Disruptor IX"] });
  assert.strictEqual(reply.statusCode, 409);
  assert.deepStrictEqual(reply.body.unknown.map((row) => [row.list, row.name]),
    [["modules", "Neutron Blaster II"], ["modules", "Hobgoblin II"], ["modules", "Warp Disruptor IX"]]);
  assert.deepStrictEqual(reply.body.unknown[0].suggestions, ["Light Neutron Blaster II"], "a partial match is a suggestion, not a pick");
  assert.match(reply.body.unknown[1].why, /not a module/);
  const charge = run(SESSION_DOCKED, { ship: "Tristan", modules: ["1MN Afterburner II"], charges: ["Antimatter Charge S"] });
  assert.strictEqual(charge.statusCode, 409);
  assert.match(charge.body.error, /fits none of the modules/);
  assert.deepStrictEqual(calls, []);
  assert.match(formatLoadoutReply(reply.body), /unknown module "Neutron Blaster II" \(did you mean Light Neutron Blaster II\?\)/);
});

test("missing skills are listed with the level each item needs, and nothing changes", () => {
  const { m, calls } = fakeStock({ skills: { 3328: 1, 3302: 3 } });
  const reply = createLoadout(m)(SESSION_DOCKED, STARTER);
  assert.strictEqual(reply.statusCode, 409);
  assert.match(reply.body.error, /missing 2 skill\(s\); nothing was changed/);
  assert.deepStrictEqual(reply.body.missingSkills.map(({ name, level, has, for: needs }) => [name, level, has, needs]), [
    ["Drones", 5, 0, ["Hobgoblin II"]],
    ["Small Hybrid Turret", 5, 3, ["Light Neutron Blaster II"]],
  ]);
  assert.deepStrictEqual(calls, []);
  assert.match(formatLoadoutReply(reply.body), /missing Drones 5 \(has 0\) for Hobgoblin II/);
});

test("POST /loadout finds the session, and says so when the tree can't build one", () => {
  const routes = (loadout) => createAgentBridgeRoutes({
    findSession: (id) => (id === 90000001 ? SESSION_DOCKED : null),
    executeChatCommand: () => ({}),
    readGrid: () => ({}),
    watcher: null,
    loadout,
  });
  const { m } = fakeStock();
  const run = createLoadout(m);
  const ok = routes(() => ({ run })).handle("POST", "/loadout", {}, { characterID: 90000001, ship: "Tristan" });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(routes(() => ({ run })).handle("POST", "/loadout", {}, { characterID: 5, ship: "Tristan" }).statusCode, 409);
  const off = routes(() => ({ error: "services/ship/devCommandShipRuntime has no fitGrantedItemTypeToShip" }))
    .handle("POST", "/loadout", {}, { characterID: 90000001, ship: "Tristan" });
  assert.strictEqual(off.statusCode, 503);
  assert.match(off.body.error, /can't build a loadout: services\/ship/);
});

test("the probe reads each module's exports without loading it, and names what is missing", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-loadout-"));
  try {
    const write = (relativePath, names) => {
      const file = path.join(tree, "src", `${relativePath}.js`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `throw new Error("must not load");\nmodule.exports = {\n  ${names.join(",\n  ")},\n};\n`);
    };
    for (const [relativePath, names] of Object.values(LOADOUT_EXPORTS)) write(relativePath, names);
    assert.deepStrictEqual(probeLoadoutExports(tree), { missing: [] });
    write("services/ship/devCommandShipRuntime", ["fitGrantedItemTypeToShip"]);
    fs.rmSync(path.join(tree, "src", "services", "skills", "skillState.js"));
    assert.deepStrictEqual(probeLoadoutExports(tree).missing, [
      "services/ship/devCommandShipRuntime has no moveGrantedItemTypeToShipCargo, moveGrantedItemTypeToShipDroneBay, boardPreparedShipInSpace",
      "services/skills/skillState is not in the tree",
    ]);
    const loaded = loadLoadoutModules((relativePath) => (relativePath.includes("skillState") ? (() => { throw new Error("nope"); })() : {}));
    assert.ok(loaded.missing.some((line) => /skillState failed to load: nope/.test(line)));
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a scenario's loadout step is checked when the scenario is, and reads back in the report", () => {
  const registry = createToolRegistry({ active: [], skipped: [] });
  const base = { name: "loadout-step", world: "fresh", until: { timeout: 30 }, expect: ["GRID"] };
  const scenario = validateScenario({ ...base, setup: [{ loadout: STARTER }, { loadout: "Tristan" }] }, { registry });
  assert.deepStrictEqual(scenario.setup.map((step) => describeStep(step, registry)), [
    "login",
    "loadout Tristan: 3 module(s), 5 drone(s), Antimatter Charge S loaded, 1 cargo stack(s)",
    "loadout Tristan",
  ]);
  assert.throws(() => validateScenario({ ...base, setup: [{ loadout: { ship: "Tristan", charges: ["Antimatter Charge S x9"] } }] }, { registry }),
    /setup\[0\]\.loadout: charges\[0\]: a charge fills every module/);
});
