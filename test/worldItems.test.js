"use strict";

// `world items` (core/worldItems.js, core/worlds.js readItems, bridge/items.js,
// GET /items): the query, the read-only game store reader against a small
// store made here with the stock schema, and the route over a fake item store.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { formatItemsReply, parseQuery, runQuery } = require("../core/worldItems");
const { readItems } = require("../core/worlds");
const { ITEMS_EXPORTS, createItemsReader } = require("../bridge/items");
const { loadModuleTable } = require("../bridge/loadout");
const { createAgentBridgeRoutes } = require("../bridge/routes");

const STATION = 60004588;
const OFFICE = 285;
const CORP = 98000001;
const CHAR = 90000001;
const TYPE_NAMES = { 593: "Tristan", 3170: "Light Neutron Blaster II", 2456: "Hobgoblin II", 230: "Antimatter Charge S", 34: "Tritanium" };

const item = (itemID, typeID, ownerID, locationID, flagID, extra = {}) => ({
  itemID, typeID, ownerID, locationID, flagID, quantity: -1, stacksize: 1, singleton: 1, groupID: 25, categoryID: 6,
  itemName: TYPE_NAMES[typeID], ...extra,
});

// A ship with a gun, a charge and drones, a renamed frigate, a stack of ore,
// and a ship in an office division.
const ITEMS = [
  item(1001, 593, CHAR, STATION, 4, { itemName: "Old Faithful" }),
  item(1002, 3170, CHAR, 1001, 27, { categoryID: 7, groupID: 74 }),
  item(1003, 230, CHAR, 1001, 27, { categoryID: 8, quantity: 40, stacksize: 40, singleton: 0 }),
  item(1004, 2456, CHAR, 1001, 87, { categoryID: 18, quantity: 5, stacksize: 5, singleton: 0 }),
  item(1005, 593, CHAR, STATION, 4),
  item(1006, 34, CHAR, STATION, 4, { categoryID: 4, quantity: 1500, stacksize: 1500, singleton: 0 }),
  item(2001, 593, CORP, OFFICE, 115),
  item(2002, 593, CORP, OFFICE, 116),
];

function makeStore(dir) {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(dir, "gamestore.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE items (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
  db.exec("CREATE TABLE characters (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO items(key, json) VALUES (?, ?)");
  for (const row of ITEMS) insert.run(String(row.itemID), JSON.stringify(row));
  db.close();
  return file;
}

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-items-"));
  try {
    return run(makeStore(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const typeName = (typeID) => TYPE_NAMES[typeID] || null;
const ask = (file, raw) => {
  const { query, problems } = parseQuery(raw);
  assert.deepStrictEqual(problems, []);
  return readItems(file, query, { typeName });
};

test("a query names a place or an item; the rest only narrows it", () => {
  assert.deepStrictEqual(parseQuery({ location: "60004588", flag: "4", type: "Tristan", limit: "10" }).query,
    { limit: 10, location: 60004588, flag: 4, type: { name: "Tristan" } });
  assert.deepStrictEqual(parseQuery({ item: 1001, type: "593" }).query, { limit: 200, item: 1001, type: { typeID: 593 } });
  assert.match(parseQuery({}).problems[0], /give --location <id> or --item <id>/);
  assert.match(parseQuery({ owner: 5 }).problems[0], /give --location/, "an owner alone isn't a place");
  assert.match(parseQuery({ location: 1, item: 2 }).problems[0], /separate questions/);
  assert.match(parseQuery({ location: "abc" }).problems[0], /location: a positive whole number/);
  assert.match(parseQuery({ location: 1, limit: 99999 }).problems[0], /limit: at most 5000/);
  assert.match(parseQuery({ location: true }).problems[0], /--location needs a value/);
  assert.deepStrictEqual(parseQuery({ location: 1, flag: 0 }).query.flag, 0, "flag 0 is a flag");
});

test("the game store reader lists a place, narrows it, and counts what a ship holds", () => withStore((file) => {
  const hangar = ask(file, { location: STATION });
  assert.strictEqual(hangar.ok, true);
  assert.deepStrictEqual(hangar.rows.map((row) => row.itemID), [1001, 1005, 1006]);
  const [named, plain, ore] = hangar.rows;
  assert.deepStrictEqual([named.typeName, named.name, named.assembled, named.quantity, named.contents], ["Tristan", "Old Faithful", true, 1, 3]);
  assert.deepStrictEqual([plain.name, plain.contents], [null, 0], "no custom name; an empty ship says 0 inside");
  assert.deepStrictEqual([ore.typeName, ore.quantity, ore.assembled, ore.contents], ["Tritanium", 1500, false, null]);

  assert.deepStrictEqual(ask(file, { location: STATION, type: "tritanium" }).rows.map((row) => row.itemID), [1006], "a name matches exactly, any case");
  assert.deepStrictEqual(ask(file, { location: STATION, type: 593 }).rows.map((row) => row.itemID), [1001, 1005]);
  assert.deepStrictEqual(ask(file, { location: STATION, owner: CORP }).rows, []);
  assert.deepStrictEqual(ask(file, { location: OFFICE, owner: CORP, flag: 116 }).rows.map((row) => row.itemID), [2002]);
  const limited = ask(file, { location: STATION, limit: 2 });
  assert.deepStrictEqual([limited.rows.length, limited.total, limited.truncated], [2, 3, true]);
  assert.match(formatItemsReply(limited, "x"), /showing 2 of 3; --limit N shows more/);
}));

test("--item shows the item and what's directly inside it, by slot", () => withStore((file) => {
  const ship = ask(file, { item: 1001 });
  assert.strictEqual(ship.item.itemID, 1001);
  assert.deepStrictEqual(ship.rows.map((row) => [row.itemID, row.flagID, row.quantity]), [[1002, 27, 1], [1003, 27, 40], [1004, 87, 5]]);
  const text = formatItemsReply(ship, "the game store");
  assert.match(text, /^source: the game store\nthe item:\n {2}itemID .*contents\n {2}1001 +Tristan \(593\) +90000001 +60004588 +4 hangar +1 +assembled +"Old Faithful" +3 inside/);
  assert.match(text, /inside it \(3\):[\s\S]*27 high/);
  assert.deepStrictEqual(ask(file, { item: 1001, flag: 87 }).rows.map((row) => row.itemID), [1004], "filters narrow the contents");
  assert.deepStrictEqual(readItems(file, parseQuery({ item: 4242 }).query, { typeName }), { ok: false, error: "no item 4242" });
}));

test("the reader opens the file read-only and says plainly when there is nothing to read", () => withStore((file, dir) => {
  const before = fs.readFileSync(file);
  ask(file, { location: STATION });
  assert.ok(before.equals(fs.readFileSync(file)), "the store is byte for byte as it was");
  assert.deepStrictEqual(fs.readdirSync(dir), ["gamestore.sqlite"], "no journal or copy left beside it");
  assert.match(readItems(path.join(dir, "missing.sqlite"), parseQuery({ location: 1 }).query).error, /no game store at/);
  const { DatabaseSync } = require("node:sqlite");
  const other = path.join(dir, "other.sqlite");
  const db = new DatabaseSync(other);
  db.exec("CREATE TABLE skills (key TEXT, json TEXT)");
  db.close();
  assert.match(readItems(other, parseQuery({ location: 1 }).query).error, /has no items table/);
  assert.strictEqual(typeName(34), "Tritanium");
  assert.strictEqual(runQuery({ item: () => null, inLocation: () => [], contentsCounts: () => new Map(), typeName }, { limit: 5, location: 9 }).total, 0);
  assert.match(formatItemsReply({ query: { limit: 5, location: 9 }, rows: [], total: 0, truncated: false }, "s"), /no items match location 9/);
}));

// A live item store: the same rows, held in memory.
function fakeItemModules(rows = ITEMS) {
  return {
    itemStore: {
      findItemById: (id) => rows.find((row) => row.itemID === id) || null,
      listContainerItems: (owner, location) => rows.filter((row) => row.locationID === location && (owner === null || row.ownerID === owner)),
    },
    itemTypes: { resolveItemByTypeID: (typeID) => (TYPE_NAMES[typeID] ? { name: TYPE_NAMES[typeID] } : null) },
  };
}

const routesWith = (items) => createAgentBridgeRoutes({ findSession: () => null, executeChatCommand: () => ({}), readGrid: () => ({}), watcher: null, items });

test("GET /items answers from the live store, with no character, and says so", () => {
  const routes = routesWith(() => ({ run: createItemsReader(fakeItemModules()) }));
  const live = routes.handle("GET", "/items", { location: String(STATION), type: "Tristan" }, {});
  assert.strictEqual(live.statusCode, 200);
  assert.strictEqual(live.body.source, "live");
  assert.deepStrictEqual(live.body.rows.map((row) => [row.itemID, row.contents]), [[1001, 3], [1005, 0]]);
  // The same question answered from the file agrees row for row.
  withStore((file) => assert.deepStrictEqual(ask(file, { location: STATION, type: "Tristan" }).rows, live.body.rows));
  const one = routes.handle("GET", "/items", { item: "1001" }, {});
  assert.deepStrictEqual(one.body.rows.map((row) => row.itemID), [1002, 1003, 1004]);
  assert.strictEqual(routes.handle("GET", "/items", { item: "7" }, {}).statusCode, 404);
  const bad = routes.handle("GET", "/items", {}, {});
  assert.strictEqual(bad.statusCode, 400);
  assert.match(bad.body.error, /give --location <id> or --item <id>/);
});

test("GET /items says when the tree can't read items, and a failure is a 500, not a crash", () => {
  const off = routesWith(() => ({ error: "services/inventory/itemStore has no listContainerItems" })).handle("GET", "/items", { location: "1" }, {});
  assert.strictEqual(off.statusCode, 503);
  assert.match(off.body.error, /can't read items: services\/inventory\/itemStore has no listContainerItems/);
  assert.strictEqual(routesWith(null).handle("GET", "/items", { location: "1" }, {}).statusCode, 503);
  const broken = routesWith(() => ({ run: () => { throw new Error("boom"); } })).handle("GET", "/items", { location: "1" }, {});
  assert.deepStrictEqual([broken.statusCode, broken.body.error], [500, "items failed: boom"]);
});

test("the items modules load by the table, and a missing export is named", () => {
  const loaded = loadModuleTable(ITEMS_EXPORTS, (relativePath) => (relativePath.endsWith("itemStore") ? { findItemById() {} } : { resolveItemByTypeID() {} }));
  assert.deepStrictEqual(loaded.missing, ["services/inventory/itemStore has no listContainerItems"]);
});
