"use strict";

// loadout `into` (core/loadout.js, bridge/loadout.js): a ship built, fitted and
// left in a station hangar or a corporation office division instead of boarded,
// with the stock modules faked. Refusals change nothing. The live round trip
// isn't covered here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadoutFromArgs, parseArgs } = require("../bin/gridcheck");
const { describeLoadout, formatLoadoutReply, loadoutBody, normalizeLoadout } = require("../core/loadout");
const { LOADOUT_EXPORTS, LOADOUT_INTO_EXPORTS, createLoadout, loadIntoModules, loadLoadoutModules } = require("../bridge/loadout");
const { buildReport, probeLoadoutExports } = require("../core/capabilities");
const { validateScenario, describeStep } = require("../core/scenario");
const { createToolRegistry } = require("../core/plugins");
const mcp = require("../bin/mcp");

const CHARACTER = 90000001;
const OTHER = 90000002;
const HOME = 60004588;
const FAR_STATION = 60003760;
const CORP = 98000001;
const OFFICE = { corporationID: CORP, stationID: FAR_STATION, officeID: 285, officeFolderID: 285, itemID: 286, impounded: false };
const SESSION_DOCKED = { characterID: CHARACTER };
const SESSION_IN_SPACE = { characterID: CHARACTER, _space: { systemID: 30002537 } };

const TYPES = [
  { typeID: 593, name: "Tristan", categoryID: 6 },
  { typeID: 3170, name: "Light Neutron Blaster II", categoryID: 7 },
];
const BY_NAME = new Map(TYPES.map((type) => [type.name.toLowerCase(), type]));

// The stock modules, recording every call that changes the world.
function fakeStock({ docked = true, offices = [OFFICE], transfer = null, sessions = {}, dockedAt = {} } = {}) {
  const calls = [];
  const lookup = (query) => (BY_NAME.has(String(query).toLowerCase())
    ? { success: true, match: BY_NAME.get(String(query).toLowerCase()) } : { success: false, errorMsg: "ITEM_NOT_FOUND", suggestions: [] });
  const m = {
    shipTypes: { resolveShipByName: lookup },
    itemTypes: { resolveItemByName: lookup, resolveItemByTypeID: (typeID) => TYPES.find((type) => type.typeID === typeID) || null },
    skills: { getCachedCharacterSkillMap: () => new Map() },
    fitting: {
      getRequiredSkillRequirements: () => [],
      isChargeCompatibleWithModule: () => false,
      getModuleChargeCapacity: () => 0,
      listFittedItems: () => [{ itemID: 1002, typeID: 3170, flagID: 27, categoryID: 7 }],
      selectAutoFitFlagForType: () => 27,
      validateFitForShip: () => ({ success: true }),
      buildShipResourceState: () => ({ cpuLoad: 1, cpuOutput: 100, powerLoad: 1, powerOutput: 50, upgradeLoad: 0, upgradeCapacity: 400 }),
    },
    location: {
      isDockedSession: () => docked,
      getDockedLocationID: (session) => (session === SESSION_DOCKED || session === SESSION_IN_SPACE ? (docked ? HOME : 0) : dockedAt[session.characterID] || 0),
    },
    character: {
      getCharacterRecord: (id) => (id === CHARACTER || id === OTHER ? { homeStationID: FAR_STATION } : null),
      syncInventoryItemForSession: (session, item) => calls.push(["sync", session.characterID, item.itemID]),
      activateShipForSession: () => {
        calls.push(["board"]);
        return { success: true };
      },
    },
    itemStore: {
      ITEM_FLAGS: { HANGAR: 4 },
      grantItemToCharacterLocation: (_charID, locationID, _flag, type) => {
        calls.push(["make ship", type.name, locationID]);
        return { success: true, data: { items: [{ itemID: 1001, typeID: type.typeID }], changes: [{ item: { itemID: 1001 } }] } };
      },
      grantItemsToCharacterStationHangar: (_charID, locationID, entries) => {
        calls.push(["grant", locationID, entries.length]);
        return { success: true, data: { changes: [] } };
      },
      moveItemTypeFromCharacterLocation: () => ({ success: true, data: { changes: [] } }),
    },
    intoItemStore: {
      transferItemToOwnerLocation: (...args) => {
        calls.push(["transfer", ...args]);
        return transfer || { success: true, data: { quantity: 1, changes: [{ item: { itemID: 1001 } }, { item: { itemID: 1002 } }] } };
      },
    },
    shipRuntime: {
      fitGrantedItemTypeToShip: (_session, _location, _ship, type, count) => {
        calls.push(["fit", type.name, count]);
        return { success: true, data: { fittedCount: count } };
      },
      moveGrantedItemTypeToShipDroneBay: () => ({ success: true }),
      moveGrantedItemTypeToShipCargo: () => ({ success: true }),
      boardPreparedShipInSpace: () => {
        calls.push(["board in space"]);
        return { success: true, data: {} };
      },
    },
    stations: { getStationByID: (id) => ([HOME, FAR_STATION].includes(id) ? { stationID: id } : null) },
    structures: { getStructureByID: (id) => (id === 1030000000001 ? { structureID: id } : null) },
    corporations: { ensureRuntimeInitialized: () => ({ corporations: { [CORP]: { offices: Object.fromEntries(offices.map((office, index) => [String(index), office])) } } }) },
    officeObservers: { fanCorporationOfficeInventoryChanges: (changes, options) => calls.push(["fan out", changes.length, options.excludeSessions.length]) },
    sessions: { findSessionByCharacterID: (id) => sessions[id] || null },
  };
  return { m, calls };
}

const into = (extra) => ({ ship: "Tristan", modules: ["Light Neutron Blaster II"], ...extra });
const transfers = (calls) => calls.filter(([what]) => what === "transfer").map(([, ...args]) => args);

test("into a station hangar of the character's own: nothing to move when it was built there", () => {
  const { m, calls } = fakeStock();
  const reply = createLoadout(m)(SESSION_DOCKED, into({ into: HOME }));
  assert.strictEqual(reply.statusCode, 200, JSON.stringify(reply.body));
  assert.deepStrictEqual(transfers(calls), []);
  assert.ok(!calls.some(([what]) => what === "board"), "not boarded");
  assert.strictEqual(reply.body.placed.kind, "hangar");
  assert.deepStrictEqual([reply.body.placed.locationID, reply.body.placed.ownerID, reply.body.placed.flagID], [HOME, CHARACTER, 4]);
  assert.deepStrictEqual([reply.body.locationID, reply.body.systemID, reply.body.replacedShipID], [null, null, null]);
});

test("into another station moves the fitted hull whole, keeps its contents with it, and syncs the docked session", () => {
  const { m, calls } = fakeStock();
  const reply = createLoadout(m)(SESSION_DOCKED, into({ into: FAR_STATION }));
  assert.strictEqual(reply.statusCode, 200);
  assert.deepStrictEqual(transfers(calls), [[1001, CHARACTER, FAR_STATION, 4, null, { reownContents: true }]]);
  const order = calls.map(([what]) => what);
  assert.ok(order.indexOf("fit") < order.indexOf("transfer"), "fitted where stock fits it, then moved");
  assert.deepStrictEqual(calls.filter(([what, id]) => what === "sync" && id === CHARACTER).slice(-2).map(([, , item]) => item), [1001, 1002],
    "the session is told of the move and of the contents that changed");
  assert.ok(!calls.some(([what]) => what === "fan out"), "no office, no office observers");
  assert.match(formatLoadoutReply(reply.body), /^built Tristan 1001 in character 90000001's hangar in station 60003760; not boarded\n {2}high {2}Light Neutron Blaster II/);
});

test("into an office defaults to its corporation and division 1, and tells the members who have it open", () => {
  const { m, calls } = fakeStock();
  const reply = createLoadout(m)(SESSION_DOCKED, into({ into: OFFICE.itemID }));
  assert.strictEqual(reply.statusCode, 200, JSON.stringify(reply.body));
  assert.deepStrictEqual(transfers(calls), [[1001, CORP, OFFICE.itemID, 115, null, { reownContents: true }]],
    "written under the ID the client opens the office by");
  assert.deepStrictEqual(calls.find(([what]) => what === "fan out"), ["fan out", 2, 1], "this session was synced, so it is left out");
  assert.deepStrictEqual(reply.body.placed, { kind: "office", locationID: 286, ownerID: CORP, flagID: 115, stationID: FAR_STATION, corporationID: CORP,
    description: `corporation ${CORP}'s office 286 in station ${FAR_STATION}, hangar division 1 (flag 115)` });
  const second = fakeStock();
  createLoadout(second.m)(SESSION_DOCKED, into({ into: OFFICE.officeID, flag: 117, owner: CORP }));
  assert.deepStrictEqual(transfers(second.calls), [[1001, CORP, 285, 117, null, { reownContents: true }]]);
});

test("a character in space builds at its home station and the observers still hear of it", () => {
  const { m, calls } = fakeStock({ docked: false });
  const reply = createLoadout(m)(SESSION_IN_SPACE, into({ into: OFFICE.itemID }));
  assert.strictEqual(reply.statusCode, 200);
  assert.deepStrictEqual(calls.find(([what]) => what === "make ship"), ["make ship", "Tristan", FAR_STATION]);
  assert.ok(!calls.some(([what]) => what === "sync" || what === "board in space"));
  assert.deepStrictEqual(calls.find(([what]) => what === "fan out"), ["fan out", 2, 0]);
});

test("another character's hangar: its docked session sees the ship arrive", () => {
  const owner = { characterID: OTHER };
  const here = fakeStock({ sessions: { [OTHER]: owner }, dockedAt: { [OTHER]: FAR_STATION } });
  assert.strictEqual(createLoadout(here.m)(SESSION_DOCKED, into({ into: FAR_STATION, owner: OTHER })).statusCode, 200);
  assert.deepStrictEqual(transfers(here.calls), [[1001, OTHER, FAR_STATION, 4, null, { reownContents: true }]]);
  assert.deepStrictEqual(here.calls.filter(([what, id]) => what === "sync" && id === OTHER).map(([, , item]) => item), [1001, 1002]);
  const away = fakeStock({ sessions: { [OTHER]: owner }, dockedAt: { [OTHER]: HOME } });
  createLoadout(away.m)(SESSION_DOCKED, into({ into: FAR_STATION, owner: OTHER }));
  assert.ok(!away.calls.some(([what, id]) => what === "sync" && id === OTHER), "docked elsewhere: nothing to show it");
});

test("a place a ship can't sit, or an owner that makes no sense, is refused before anything is made", () => {
  const refuse = (setup, spec) => {
    const { m, calls } = fakeStock(setup);
    const reply = createLoadout(m)(SESSION_DOCKED, into(spec));
    assert.strictEqual(reply.statusCode, 409, JSON.stringify(reply.body));
    assert.match(reply.body.error, /the ship can't be left there: .*; nothing was changed/);
    assert.deepStrictEqual(calls, [], "nothing was made, fitted or moved");
    return reply.body.into;
  };
  assert.match(refuse({}, { into: 5555 }), /5555 is not a station, a structure or a corporation office/);
  assert.match(refuse({}, { into: HOME, owner: CORP }), /owner 98000001 is not a character; .*pass the office's ID as into/);
  assert.match(refuse({}, { into: HOME, flag: 115 }), /flag 115: a ship in a station hangar is at flag 4/);
  assert.match(refuse({}, { into: OFFICE.itemID, owner: OTHER }), /owner 90000002: office 286 is corporation 98000001's.*leave owner out/);
  assert.match(refuse({}, { into: OFFICE.itemID, flag: 4 }), /flag 4: an office's hangar divisions are flags 115 through 121/);
  assert.match(refuse({}, { into: OFFICE.itemID, flag: 122 }), /flag 122/);
  assert.match(refuse({ offices: [{ ...OFFICE, impounded: true }] }, { into: OFFICE.itemID }), /office 286 is impounded/);
  assert.match(refuse({ offices: [OFFICE, { ...OFFICE, officeID: 286, itemID: 9 }] }, { into: 286 }), /names more than one corporation office/);
});

test("a structure's hangar counts as a hangar", () => {
  const { m, calls } = fakeStock();
  const reply = createLoadout(m)(SESSION_DOCKED, into({ into: 1030000000001 }));
  assert.strictEqual(reply.statusCode, 200);
  assert.deepStrictEqual(transfers(calls), [[1001, CHARACTER, 1030000000001, 4, null, { reownContents: true }]]);
});

test("a move that fails says where the ship is, and what was done", () => {
  const { m } = fakeStock({ transfer: { success: false, errorMsg: "WRITE_ERROR" } });
  const reply = createLoadout(m)(SESSION_DOCKED, into({ into: OFFICE.itemID }));
  assert.strictEqual(reply.statusCode, 500);
  assert.strictEqual(reply.body.shipID, 1001);
  assert.match(reply.body.error, /made it, but moving it to corporation 98000001's office 286 .* failed: WRITE_ERROR; it is in the character's hangar in 60004588/);
  assert.ok(reply.body.done.some((line) => /^fitted Light Neutron Blaster II/.test(line)));
});

test("without into the ship is boarded as before", () => {
  const { m, calls } = fakeStock();
  const reply = createLoadout(m)(SESSION_DOCKED, into({}));
  assert.strictEqual(reply.statusCode, 200);
  assert.deepStrictEqual([transfers(calls).length, calls.filter(([what]) => what === "board").length], [0, 1]);
  assert.strictEqual(reply.body.placed, undefined);
});

test("into, owner and flag are read, checked and sent on", () => {
  const { loadout } = normalizeLoadout({ ship: "Tristan", into: "285", owner: 98000001, flag: "116" });
  assert.deepStrictEqual([loadout.into, loadout.owner, loadout.flag], [285, 98000001, 116]);
  assert.deepStrictEqual(loadoutBody(loadout), { ship: "Tristan", into: 285, owner: 98000001, flag: 116 });
  assert.strictEqual(describeLoadout(loadout), "loadout Tristan into 285");
  assert.strictEqual(describeLoadout(normalizeLoadout({ ship: "Tristan" }).loadout), "loadout Tristan");
  assert.ok(normalizeLoadout({ ship: "Tristan", into: "Jita" }).problems.some((line) => /^into: an ID/.test(line)));
  assert.ok(normalizeLoadout({ ship: "Tristan", into: 0 }).problems.some((line) => /^into: an ID/.test(line)));
  assert.deepStrictEqual(normalizeLoadout({ ship: "Tristan", owner: 5 }).problems, ["owner and flag say where `into` leaves the ship; give into too"]);
  assert.strictEqual(normalizeLoadout({ ship: "Tristan" }).loadout.into, undefined);
  const registry = createToolRegistry({ active: [], skipped: [] });
  const scenario = validateScenario({ name: "into", world: "fresh", until: { timeout: 30 }, expect: ["GRID"], setup: [{ loadout: { ship: "Tristan", into: 285 } }] }, { registry });
  assert.strictEqual(describeStep(scenario.setup[1], registry), "loadout Tristan into 285");
});

test("the CLI refuses a bad into before it needs a login; the MCP tool passes it in the spec", () => {
  const fromArgs = (...argv) => {
    const { positionals, flags } = parseArgs(["loadout", ...argv]);
    return loadoutFromArgs(positionals, flags);
  };
  assert.throws(() => fromArgs("Tristan", "--into", "Jita"), /into: an ID, a whole number above 0[\s\S]*usage: loadout/);
  assert.throws(() => fromArgs("Tristan", "--flag", "116"), /give into too/);
  const flagged = fromArgs("Tristan", "--modules", "Light Neutron Blaster II", "--into", "285", "--owner", "98000001", "--flag", "116");
  assert.deepStrictEqual([flagged.into, flagged.owner, flagged.flag], [285, 98000001, 116]);
  const overridden = fromArgs("--spec", JSON.stringify({ ship: "Tristan", into: 1, flag: 115 }), "--into", "285");
  assert.deepStrictEqual([overridden.into, overridden.flag], [285, 115], "a flag wins over the spec's key");
  const args = mcp.cliArgs("loadout", { ship: "Tristan", into: 285, owner: 98000001, flag: 116 });
  assert.deepStrictEqual(JSON.parse(args.find((arg) => arg.startsWith("--spec=")).slice(7)), { ship: "Tristan", into: 285, owner: 98000001, flag: 116 });
  const tool = mcp.TOOLS.find((entry) => entry.name === "loadout");
  assert.deepStrictEqual(["into", "owner", "flag"].filter((key) => !tool.inputSchema.properties[key]), []);
});

test("a tree missing what into needs refuses only into; a plain loadout still boards", () => {
  const { m, calls } = fakeStock();
  const run = createLoadout(m, { intoMissing: ["services/inventory/itemStore has no transferItemToOwnerLocation"] });
  const refused = run(SESSION_DOCKED, into({ into: FAR_STATION }));
  assert.strictEqual(refused.statusCode, 503);
  assert.match(refused.body.error, /^into isn't available in this tree: services\/inventory\/itemStore has no transferItemToOwnerLocation; nothing was changed/);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(run(SESSION_DOCKED, into({})).statusCode, 200);
  assert.ok(calls.some(([what]) => what === "board"));
});

test("the two tables load apart: a missing into export leaves the loadout table complete", () => {
  const loadFake = (relativePath) => (relativePath.endsWith("structureState") ? {} : new Proxy({}, { get: () => () => {} }));
  const base = loadLoadoutModules(loadFake);
  const extra = loadIntoModules(loadFake);
  assert.deepStrictEqual(base.missing, []);
  assert.deepStrictEqual(extra.missing, ["services/structure/structureState has no getStructureByID"]);
  assert.ok(extra.modules.intoItemStore && !base.modules.intoItemStore);
});

test("the probe reports into apart from the loadout", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-into-"));
  try {
    const write = (table, skip = () => false) => {
      for (const [relativePath, names] of Object.values(table)) {
        const file = path.join(tree, "src", `${relativePath}.js`);
        const known = fs.existsSync(file) ? fs.readFileSync(file, "utf8").match(/module\.exports = \{([\s\S]*?)\};/)[1].split(",").map((name) => name.trim()).filter(Boolean) : [];
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `module.exports = {\n  ${[...known, ...names.filter((name) => !skip(relativePath, name))].join(",\n  ")},\n};\n`);
      }
    };
    write(LOADOUT_EXPORTS);
    write(LOADOUT_INTO_EXPORTS, (relativePath, name) => name === "ensureRuntimeInitialized");
    assert.deepStrictEqual(probeLoadoutExports(tree), { missing: [] }, "plain loadout is whole");
    assert.deepStrictEqual(probeLoadoutExports(tree, LOADOUT_INTO_EXPORTS).missing,
      ["services/corporation/corporationRuntimeState has no ensureRuntimeInitialized"]);
    const report = buildReport({ treeRoot: tree, serverRoot: tree, patches: [], probe: { allowlist: [], destiny: { ok: false } } });
    assert.deepStrictEqual(report.loadout, { ok: true, missing: [], into: { ok: false, missing: ["services/corporation/corporationRuntimeState has no ensureRuntimeInitialized"] } });
    const live = buildReport({ treeRoot: tree, serverRoot: tree, patches: [], probe: { allowlist: [], destiny: { ok: false }, loadout: { missing: [], intoMissing: [] } } });
    assert.deepStrictEqual(live.loadout.into, { ok: true, missing: [] });
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("the capability probe checks what into reads", () => {
  const names = Object.values(LOADOUT_INTO_EXPORTS).flatMap(([relativePath, exported]) => exported.map((name) => `${relativePath}:${name}`));
  for (const wanted of ["services/inventory/itemStore:transferItemToOwnerLocation", "space/worldData:getStationByID",
    "services/structure/structureState:getStructureByID", "services/corporation/corporationRuntimeState:ensureRuntimeInitialized",
    "services/inventory/corporationOfficeInventoryObservers:fanCorporationOfficeInventoryChanges",
    "services/chat/sessionRegistry:findSessionByCharacterID"]) {
    assert.ok(names.includes(wanted), wanted);
  }
});
