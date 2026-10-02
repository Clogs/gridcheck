"use strict";

// Gridcheck: the pure parts of the headless observer CLI -- argument parsing,
// log filtering and the grid table. The live path is checked by
// docs/GUIDE.md.

const test = require("node:test");
const assert = require("node:assert");
const { needsPlugin } = require("./tree");

const { formatDistance, formatGrid, formatClock } = require("../core/format");
const { CORE_COMMANDS, helpText, parseArgs, selectLogLines, systemsSeen, upKeyFor, upOptions } = require("../bin/gridcheck");
const { selectScouts } = require("../plugins/lu/tool/commands");

// These read the lu plugin through the default registry, so they need a tree
// it applies to: the fixture tree npm test names, or one with the mod.
const LU = needsPlugin("lu");

test("scouts are single-hull pirate flights, holding ones first", () => {
  const fleets = [
    { flightID: "f3", family: "pirate", pilotCount: 1, phase: "mission_travel" },
    { flightID: "f2", family: "pirate", pilotCount: 4, phase: "mission_holding" },
    { flightID: "f4", family: "pirate", pilotCount: 1, phase: "mission_holding" },
    { flightID: "f1", family: "police", pilotCount: 1, phase: "mission_holding" },
  ];
  assert.deepStrictEqual(selectScouts(fleets).map((f) => f.flightID), ["f4"]);
  assert.deepStrictEqual(selectScouts(fleets, { all: true }).map((f) => f.flightID), ["f4", "f3"]);
});

test("arguments: command, positionals, valued and boolean flags", () => {
  assert.deepStrictEqual(parseArgs(["grid", "--range", "500", "--all"]), {
    command: "grid", positionals: [], flags: { range: "500", all: true },
  });
  assert.deepStrictEqual(parseArgs(["slash", "/tr", "me", "Amamake"]).positionals, ["/tr", "me", "Amamake"]);
  assert.deepStrictEqual(parseArgs(["log", "--grep=PirateHunt"]).flags, { grep: "PirateHunt" });
  assert.deepStrictEqual(parseArgs(["slash", "--", "--weird"]).positionals, ["--weird"]);
  assert.strictEqual(parseArgs([]).command, "help");
  assert.throws(() => parseArgs(["log", "--grep"]), /needs a value/);
});

test("--reuse is a flag; a reused server is matched on the scenario's up options and cleared in the systems a run saw", () => {
  assert.strictEqual(parseArgs(["run", "loadout-npc-fight", "--reuse"]).flags.reuse, true);
  assert.strictEqual(upKeyFor({ market: true }), "none");
  assert.strictEqual(upKeyFor({ market: false, timeout: 120 }), "--no-market", "the boot timeout doesn't change the server");
  assert.deepStrictEqual(systemsSeen([
    { kind: "START" },
    { kind: "GRID", systemID: 30002537 },
    { kind: "SYSTEM", fromSystemID: 30002537, toSystemID: 30002539 },
    { kind: "GRID", systemID: 30002539 },
    { kind: "GRID", systemID: null },
  ]), [30002537, 30002539]);
});

test("log lines keep the server's pid and the pattern, newest last", () => {
  const text = [
    "[t1] [pid 10] [LOG] [PirateHunt] sighted",
    "[t2] [pid 99] [LOG] [PirateHunt] from a test process",
    "[t3] [pid 10] [LOG] [SpaceRuntime] tick",
    "[t4] [pid 10] [LOG] [piratehunt] committed",
    "",
  ].join("\r\n");
  assert.deepStrictEqual(selectLogLines(text, { grep: "PirateHunt", pid: 10, lines: 40 }), [
    "[t1] [pid 10] [LOG] [PirateHunt] sighted",
    "[t4] [pid 10] [LOG] [piratehunt] committed",
  ]);
  assert.strictEqual(selectLogLines(text, { grep: "PirateHunt", pid: null, lines: 40 }).length, 3);
  assert.deepStrictEqual(selectLogLines(text, { pid: 10, lines: 1 }), ["[t4] [pid 10] [LOG] [piratehunt] committed"]);
});

test("untagged log lines, as stock writes them, are kept from the server's start on, with their stack traces", () => {
  const text = [
    "[2026-10-02T11:00:00.000Z] [LOG] the last run's server",
    "    at an old stack frame",
    "[2026-10-02T11:41:01.945Z] [LOG] [GameStore] this server",
    "[2026-10-02T11:41:02.000Z] [ERR] boom",
    "    at a new stack frame",
  ].join("\n");
  const sinceMs = Date.parse("2026-10-02T11:41:00.000Z");
  assert.deepStrictEqual(selectLogLines(text, { lines: 40, sinceMs }), text.split("\n").slice(2));
  assert.strictEqual(selectLogLines(text, { lines: 40 }).length, 5, "without a start time, every line");
});

test("stock's log lines carry no pid, so they all stay, and parse with a null pid", () => {
  const { parseLogLine } = require("../core/timeline");
  const text = [
    "[2026-10-01T16:42:38.947Z] [LOG] [CharService] Space restore completed",
    "[2026-10-01T16:42:39.135Z] [pid 10] [LOG] [NpcController] tagged by a fork",
    "[2026-10-01T16:42:40.101Z] [WRN] [MarketDaemonClient] Unable to reach market daemon RPC",
  ].join("\n");
  assert.strictEqual(selectLogLines(text, { pid: 99, lines: 40 }).length, 2, "the fork line of another pid goes");
  assert.deepStrictEqual(parseLogLine("[2026-10-01T16:42:38.947Z] [LOG] [CharService] restored"),
    { atMs: Date.parse("2026-10-01T16:42:38.947Z"), pid: null, level: "LOG", text: "[CharService] restored" });
  assert.strictEqual(parseLogLine("[2026-10-01T16:42:39.135Z] [pid 10] [LOG] [X] y").pid, 10);
});

test("distances read as m, km or AU", () => {
  assert.strictEqual(formatDistance(0), "0");
  assert.strictEqual(formatDistance(8_200), "8,200 m");
  assert.strictEqual(formatDistance(182_000), "182 km");
  assert.strictEqual(formatDistance(14.2 * 149_597_870_700), "14.2 AU");
  assert.strictEqual(formatDistance(null), "?");
  assert.strictEqual(formatClock(252_000), "00:04:12");
});

const grid = {
  characterID: 7,
  characterName: "Agent Observer",
  solarSystemID: 30002537,
  systemName: "Amamake",
  security: 0.4,
  inSpace: true,
  self: { itemID: 1, typeName: "Rifter", mode: "STOP", protection: { active: true, remainingMs: 27_500, cloaked: false } },
  entities: [
    { itemID: 1, kind: "ship", name: "Rifter", typeName: "Rifter", isSelf: true, mode: "STOP", distanceMeters: 0, shieldRatio: 1, armorRatio: 1, hullRatio: 1 },
    { itemID: 2, kind: "ship", name: "Guristas Scout", typeName: "Worm", isNpc: true, npcEntityType: "npc", mode: "ORBIT", targetEntityID: 1, distanceMeters: 182_000, shieldRatio: 1, armorRatio: 0.5, hullRatio: 1 },
    { itemID: 3, kind: "moon", name: "Amamake IV - Moon 1", typeName: "Moon", distanceMeters: 14.2 * 149_597_870_700, shieldRatio: null, armorRatio: null, hullRatio: null },
  ],
};

test("a value exactly as wide as its column still leaves a gap", () => {
  const sentry = {
    itemID: 4, kind: "sentryGun", name: "Caldari Sentry Gun I", typeName: "Caldari Sentry Gun I", distanceMeters: 54_000,
  };
  const row = formatGrid({ ...grid, entities: [sentry] }).split("\n")[2];
  assert.match(row, /Caldari Sentry Gun~ -/);
});

test("the grid table: header, one row per ball in range, a footer for the rest", () => {
  const lines = formatGrid(grid, { sinceMs: 252_000 }).split("\n");
  assert.strictEqual(lines[0], "Amamake (0.4)  t+00:04:12  self: Rifter (in space, STOP)  protected 28s");
  assert.match(lines[1], /^dist {8}name/);
  assert.match(lines[2], /^0 {11}\(self\) Rifter/);
  assert.match(lines[2], /100\/100\/100$/);
  assert.match(lines[3], /^182 km {6}Guristas Scout {10}Worm {16}npc {5}ORBIT {4}self {14}100\/50\/100$/);
  assert.strictEqual(lines[4], "+1 beyond 10,000 km; nearest Amamake IV - Moon 1 at 14.2 AU (--all to list)");
  assert.strictEqual(lines.length, 5);
});

test("--all lists celestials, --range narrows, docked shows where", () => {
  assert.match(formatGrid(grid, { all: true }), /Amamake IV - Moon 1 +Moon .* -$/m);
  assert.match(formatGrid(grid, { rangeKm: 100 }), /^\+2 beyond 100 km; nearest Guristas Scout at 182 km/m);
  assert.strictEqual(
    formatGrid({ ...grid, inSpace: false, stationID: 60015249 }),
    "Amamake (0.4)  self: Agent Observer (docked in station 60015249)",
  );
});

const { triggerRequest } = require("../plugins/lu/tool/triggers");

test("a plugin's up flags become the server's variables and the world restore's options", LU, () => {
  const set = upOptions({ "offgrid-travel": "10", "offgrid-activity": "4", "real-clock": true, world: "lowsec-docked" });
  assert.deepStrictEqual(set.env, {
    EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER: "10",
    EVEJS_LIVING_UNIVERSE_OFFGRID_ACTIVITY_TIME_MULTIPLIER: "4",
  });
  assert.deepStrictEqual(set.values, { offgridTravel: 10, offgridActivity: 4, realClock: true });
  assert.deepStrictEqual(set.restore, { realClock: true });
  assert.deepStrictEqual(upOptions({}), { values: {}, env: {}, restore: {} });
  for (const bad of ["0", "101", "fast"]) assert.throws(() => upOptions({ "offgrid-travel": bad }), /1 through 100/);
  assert.throws(() => upOptions({ "real-clock": true }), /applies to a restored world/);
  assert.deepStrictEqual(parseArgs(["up", "--real-clock", "--world", "w"]).flags, { "real-clock": true, world: "w" },
    "a plugin's bool flag takes no value");
});

test("help lists the core commands, then each plugin's, and names the active plugins", LU, () => {
  const help = helpText();
  assert.match(help, /gridcheck teleport <system name\|ID>/);
  assert.match(help, /gridcheck trigger fleet <family>/);
  assert.match(help, /plugins {2}lu active/);
  assert.ok(help.indexOf("gridcheck help") < help.indexOf("gridcheck trigger"), "core commands first");
  assert.ok(CORE_COMMANDS.trigger === undefined, "trigger is the plugin's");
});

test("trigger arguments become bridge bodies; a fleet goes to your grid unless --to names a system", LU, () => {
  const ctx = { characterID: 7, resolveSystemID: (text) => (text === "Amamake" ? 30002537 : Number(text)) };
  const { parseArgs } = require("../bin/gridcheck");
  const body = (line) => {
    const { positionals, flags } = parseArgs(["trigger", ...line]);
    return triggerRequest(positionals[0], positionals.slice(1), flags, ctx);
  };
  assert.deepStrictEqual(body(["scout", "Amamake"]), { characterID: 7, systemID: 30002537 });
  assert.deepStrictEqual(body(["hunt", "--phase", "committed", "--flight", "f1"]), { characterID: 7, flightID: "f1", phase: "committed" });
  assert.deepStrictEqual(body(["fleet", "pirate", "--doctrine", "guristas", "--count", "2"]),
    { characterID: 7, family: "pirate", doctrine: "guristas", count: 2, to: "self" });
  assert.deepStrictEqual(body(["fleet", "police", "--to", "Amamake"]), { characterID: 7, family: "police", systemID: 30002537 });
  assert.deepStrictEqual(body(["materialize", "f9", "--go"]), { characterID: 7, flightID: "f9", go: true });
  assert.deepStrictEqual(body(["skirmish", "--count", "3", "--class", "cruiser", "--gap", "20000"]),
    { characterID: 7, hullsPerSide: 3, shipClass: "cruiser", separationMeters: 20000 });
  assert.deepStrictEqual(body(["skirmish"]), { characterID: 7 });
  assert.throws(() => body(["skirmish", "--count", "21"]), /1 through 20/);
  assert.throws(() => body(["fleet"]), /needs a family/);
  assert.throws(() => body(["spawn"]), /unknown trigger spawn/);
});

test("help --json: every core command has a summary, and every docs entry names a usage line", () => {
  const { DOCS, GROUPS, buildCatalog, usageParts } = require("../core/commandDocs");
  const catalog = buildCatalog({ core: CORE_COMMANDS });
  assert.deepStrictEqual(catalog.commands.filter((command) => command.undocumented || !command.summary).map((command) => command.name), [],
    "a command without an entry in core/commandDocs.js");
  assert.deepStrictEqual(Object.keys(DOCS).filter((key) => !catalog.commands.some((command) => command.name === key)), [],
    "a docs entry for a usage line the command table doesn't have");
  const groups = new Set(GROUPS.map((group) => group.id));
  for (const command of catalog.commands) assert.ok(groups.has(command.group), `${command.name}: group ${command.group}`);
  const names = (prefix) => catalog.commands.filter((command) => command.name.split(" ")[0] === prefix).map((command) => command.name);
  assert.deepStrictEqual(names("world").sort(), ["world build", "world copy", "world list", "world recipes", "world save"]);
  assert.deepStrictEqual(names("patch"), ["patch"], "patch's parts have no entries of their own, so they stay one command");
  assert.deepStrictEqual(usageParts("loadout", ["loadout <ship> [--json]", "loadout --file <x> | --spec '<json>'"]),
    ["loadout <ship> [--json]", "loadout --file <x> | --spec '<json>'"], "a part that doesn't start with the name stays with the one before");
  assert.deepStrictEqual(usageParts("watch", ["watch [--for 600]", "      [--perf]"]), ["watch [--for 600] [--perf]"]);
  const up = catalog.commands.find((command) => command.name === "up");
  assert.strictEqual(up.managed, true);
  assert.strictEqual(up.mcp, "up");
  assert.ok(up.flags.some((flag) => flag.flag === "--timeout" && flag.default === "600 s"));

  const withPlugin = buildCatalog({ core: { help: CORE_COMMANDS.help },
    plugins: { scouts: { usage: ["scouts [--all]"], summary: "Lists them.", needs: "up", plugin: "lu" } },
    handlers: { teleport: [{ flags: ["flight"], usage: ["teleport <system> --flight <id>"], summary: "Pins a flight.", plugin: "lu" }] },
    mcpTools: [{ name: "status", description: "Where things stand. Call this first." }] });
  assert.deepStrictEqual(withPlugin.groups.map((group) => group.id), ["tool", "plugin:lu"]);
  assert.deepStrictEqual(withPlugin.commands.filter((command) => command.plugin).map((command) => [command.name, command.needs || null]),
    [["scouts", "up"], ["teleport --flight", null]]);
  assert.deepStrictEqual(withPlugin.mcpTools, [{ name: "status", description: "Where things stand." }]);
});

test("an unknown command or scenario names the closest ones and how to list them", () => {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const cli = path.join(__dirname, "..", "bin", "gridcheck.js");
  const typo = spawnSync(process.execPath, [cli, "stauts"], { encoding: "utf8" });
  assert.strictEqual(typo.status, 1);
  assert.match(typo.stderr, /unknown command: stauts\. Did you mean .*`gridcheck status`.*`gridcheck help` lists them all/);
  const scenario = spawnSync(process.execPath, [cli, "run", "smoke-undok", "--check"], { encoding: "utf8" });
  assert.match(scenario.stderr, /no such scenario file\. Did you mean `smoke-undock`\? `gridcheck run` lists the scenarios/);
});
