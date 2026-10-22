"use strict";

// `grid --json` filters (--range, --kind, --npc, --fields), the CLI and MCP
// names for the new options, and the scenario's watch.modules.

const test = require("node:test");
const assert = require("node:assert");

const { GRID_FIELDS, filterGrid, parseFields } = require("../core/gridFilter");
const { parseArgs } = require("../bin/gridcheck");
const mcp = require("../bin/mcp");
const { validateScenario } = require("../core/scenario");

const rows = [
  { kind: "ship", itemID: 1, isSelf: true, name: "Me", distanceMeters: 0, capacitorPct: 80, activeModules: [] },
  { kind: "ship", itemID: 2, name: "Rat", isNpc: true, distanceMeters: 5_000, capacitorPct: 10, activeModules: [{ moduleID: 9 }] },
  { kind: "ship", itemID: 3, name: "Pilot", characterID: 5, distanceMeters: 9_000, capacitorPct: 50, activeModules: [] },
  { kind: "asteroid", itemID: 4, name: "Rock", distanceMeters: 2_000 },
  { kind: "planet", itemID: 5, name: "Planet", distanceMeters: 5e10 },
];
const grid = { inSpace: true, solarSystemID: 1, entities: rows };
const ids = (result) => result.entities.map((row) => row.itemID);

test("with no filter the grid is returned untouched", () => {
  assert.strictEqual(filterGrid(grid, {}), grid);
  assert.strictEqual(filterGrid(grid, { rangeKm: 10, all: true }), grid, "--all lifts a range");
});

test("--range keeps rows within that many km, and the ship's own row", () => {
  assert.deepStrictEqual(ids(filterGrid(grid, { rangeKm: 6 })), [1, 2, 4]);
  assert.deepStrictEqual(filterGrid(grid, { rangeKm: 6 }).filtered, { rows: 3, of: 5 });
});

test("--kind and --npc narrow the rows and combine", () => {
  assert.deepStrictEqual(ids(filterGrid(grid, { kind: "Asteroid" })), [1, 4]);
  assert.deepStrictEqual(ids(filterGrid(grid, { npc: true })), [1, 2]);
  assert.deepStrictEqual(ids(filterGrid(grid, { npc: true, kind: "ship", rangeKm: 1 })), [1]);
});

test("an anchor row stays, as the ship does", () => {
  const anchored = { ...grid, entities: [{ kind: "ship", itemID: 7, anchor: true, distanceMeters: 0 }, ...rows.slice(1)] };
  assert.deepStrictEqual(ids(filterGrid(anchored, { npc: true })), [7, 2]);
});

test("--fields keeps only those keys of each row, null where a row lacks one", () => {
  const result = filterGrid(grid, { npc: true, fields: ["itemID", "capacitorPct", "activeModules"] });
  assert.deepStrictEqual(result.entities, [
    { itemID: 1, capacitorPct: 80, activeModules: [] },
    { itemID: 2, capacitorPct: 10, activeModules: [{ moduleID: 9 }] },
  ]);
  assert.deepStrictEqual(filterGrid(grid, { fields: ["name", "capacitorPct"] }).entities[3], { name: "Rock", capacitorPct: null });
  assert.strictEqual(result.solarSystemID, 1, "the grid's own fields stay");
  assert.ok(JSON.stringify(filterGrid(grid, { fields: ["itemID"] })).length < JSON.stringify(grid).length);
});

test("parseFields splits, de-duplicates, and refuses an unknown name with the valid ones", () => {
  assert.deepStrictEqual(parseFields("itemID, name,itemID"), ["itemID", "name"]);
  assert.throws(() => parseFields("itemID,nmae,bogus"), (error) => /unknown fields nmae, bogus\. Valid fields: kind, itemID/.test(error.message));
  assert.throws(() => parseFields(""), /takes field names.*Valid fields/);
  for (const name of ["capacitorPct", "activeModules", "distanceMeters", "typeName", "isNpc", "anchor"]) assert.ok(GRID_FIELDS.includes(name), name);
});

test("the CLI reads --npc and --no-modules as flags and --at, --fields and --range as values", () => {
  assert.deepStrictEqual(parseArgs(["grid", "--at", "140", "--npc", "--fields", "itemID,name", "--json"]),
    { command: "grid", positionals: [], flags: { at: "140", npc: true, fields: "itemID,name", json: true } });
  assert.deepStrictEqual(parseArgs(["watch", "--at", "140", "--no-modules", "--for", "30"]).flags, { at: "140", "no-modules": true, for: "30" });
  assert.deepStrictEqual(parseArgs(["inspect", "140", "--json"]), { command: "inspect", positionals: ["140"], flags: { json: true } });
});

test("MCP maps the new grid, inspect and watch parameters onto CLI arguments", () => {
  assert.deepStrictEqual(mcp.cliArgs("grid", { json: true, range: 50, kind: "ship", npc: true, fields: ["itemID", "capacitorPct"], at: 140 }),
    ["grid", "--range=50", "--kind=ship", "--npc", "--fields=itemID,capacitorPct", "--at=140", "--json"]);
  assert.deepStrictEqual(mcp.cliArgs("inspect", { itemID: 140, json: true }), ["inspect", "--json", "--", "140"]);
  assert.deepStrictEqual(mcp.cliArgs("watch", { at: 140, modules: false, seconds: 30 }), ["watch", "--for=30", "--at=140", "--no-modules"]);
  assert.deepStrictEqual(mcp.cliArgs("watch", { modules: true, seconds: 30 }), ["watch", "--for=30"]);
  const tool = (name) => mcp.TOOLS.find((entry) => entry.name === name);
  const names = mcp.TOOLS.map((entry) => entry.name);
  assert.strictEqual(names[names.indexOf("grid") + 1], "inspect", "inspect sits right after grid");
  assert.deepStrictEqual(mcp.checkParams(tool("inspect"), { itemID: 140 }), []);
  assert.match(mcp.checkParams(tool("inspect"), {})[0], /itemID/);
  assert.match(mcp.checkParams(tool("grid"), { at: "x" })[0], /at must be/);
  assert.deepStrictEqual(mcp.checkParams(tool("grid"), { npc: true, fields: ["itemID"], at: 5 }), []);
});

test("a scenario's watch.modules is a boolean, defaults on, and MODULE conditions need it", () => {
  const STUBS = { worldExists: () => true, resolveSystemID: (text) => Number(text) || 30002537, defaultName: "t" };
  const make = (extra) => validateScenario({ world: "w", setup: ["undock"], until: { timeout: 5 }, expect: ["GRID"], ...extra }, STUBS);
  assert.strictEqual(make({}).watch.modules, true);
  assert.strictEqual(make({ watch: { modules: false } }).watch.modules, false);
  assert.throws(() => make({ watch: { modules: "no" } }), (error) => error.problems.some((problem) => /watch\.modules: true or false/.test(problem)));
  assert.doesNotThrow(() => make({ expect: ["MODULE on=true", "no CAPACITOR state=empty"] }));
  assert.throws(() => make({ watch: { modules: false }, expect: ["MODULE on=true"] }),
    (error) => error.problems.some((problem) => /MODULE needs watch\.modules true/.test(problem)));
});
