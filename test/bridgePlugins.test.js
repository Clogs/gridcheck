"use strict";

// The bridge's plugin seams: the loader (plugins.js), the route table, the
// watch's annotate and offGrid hooks with their timings, and the whole bridge
// started on a tree without Living Universe, where the lu plugin skips itself
// and /grid and /watch still work.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { API_VERSION, DEFAULT_PLUGINS_DIR, loadPlugins, startPlugins } = require("../bridge/plugins");
const { createAgentBridgeRoutes, createRouteTable } = require("../bridge/routes");
const { createGridWatch } = require("../bridge/watch");
const { createService } = require("../bridge/entry");

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePlugin(dir, name, source) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "plugin.js"), source);
}

function recorder() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, debug() {}, info: push("info"), warn: push("warn"), err: push("err") };
}

test("the loader takes plugins that apply, and skips the rest with one line each", (t) => {
  const dir = scratch(t, "e2e-plugins-");
  writePlugin(dir, "good", `module.exports = { name: "good", apiVersion: ${API_VERSION}, applies: () => true,
    server: () => ({ annotate: () => null }) };`);
  writePlugin(dir, "absent", `module.exports = { name: "absent", apiVersion: ${API_VERSION},
    applies: () => ({ ok: false, reason: "no such mod here" }), server() { throw new Error("must not run"); } };`);
  writePlugin(dir, "future", "module.exports = { name: \"future\", apiVersion: 2, server() {} };");
  writePlugin(dir, "broken", "throw new Error(\"syntax or worse\");");
  writePlugin(dir, "crashy", `module.exports = { name: "crashy", apiVersion: ${API_VERSION},
    server() { throw new Error("no engine"); } };`);
  fs.mkdirSync(path.join(dir, "not-a-plugin"));
  const log = recorder();
  const loaded = loadPlugins({ pluginsDir: dir, tree: { resolve: () => null }, log });
  assert.deepEqual(loaded.active.map((entry) => entry.name), ["crashy", "good"]);
  assert.deepEqual(Object.fromEntries(loaded.skipped.map((entry) => [entry.name, entry.reason])), {
    absent: "no such mod here",
    broken: "plugin.js failed to load: syntax or worse",
    future: `apiVersion 2, this core speaks ${API_VERSION}`,
  });
  assert.equal(log.lines.filter((line) => line.includes("skipped")).length, 3, log.lines.join("\n"));

  const started = startPlugins(loaded, {}, { log });
  assert.deepEqual(started.hooks.map((hook) => hook.name), ["good"]);
  assert.match(started.skipped.find((entry) => entry.name === "crashy").reason, /server\(\) threw: no engine/);
});

test("the shipped lu plugin skips a tree without Living Universe, and names what is missing", () => {
  const loaded = loadPlugins({ pluginsDir: DEFAULT_PLUGINS_DIR, tree: { resolve: () => null } });
  assert.deepEqual(loaded.active, []);
  assert.deepEqual(loaded.skipped, [{ name: "lu", reason: "no Living Universe in this tree (no server/src/modApi.js)" }]);
});

test("the route table: exact routes, a /* prefix with its rest, and core routes a plugin can't take", async () => {
  const log = recorder();
  const table = createRouteTable(log);
  assert.equal(table.add("GET /grid", () => "core grid", "core"), true);
  assert.equal(table.add("GET /grid", () => "stolen", "plugin x"), false);
  assert.equal(table.add("POST /trigger/*", ({ rest }) => `trigger ${rest}`, "plugin x"), true);
  assert.equal(table.add("BREW /coffee", () => null, "plugin x"), false);
  assert.equal(table.find("GET", "/grid").handler(), "core grid");
  const found = table.find("POST", "/trigger/hunt");
  assert.equal(found.handler({ rest: found.rest }), "trigger hunt");
  assert.equal(table.find("GET", "/trigger/hunt"), null);
  assert.equal(log.lines.length, 2, log.lines.join("\n"));

  const routes = createAgentBridgeRoutes({
    findSession: () => null,
    log,
    extraRoutes: [{ owner: "plugin x", routes: { "POST /slash": () => ({ statusCode: 418 }), "GET /x": () => ({ statusCode: 200 }) } }],
  });
  assert.equal(routes.handle("POST", "/slash", {}, { characterID: 7, command: "/x" }).statusCode, 409, "core /slash kept");
  assert.equal(routes.handle("GET", "/x", {}, null).statusCode, 200);
});

function watchGrid(entities) {
  return { inSpace: true, solarSystemID: 30002537, systemName: "Amamake", self: { itemID: 1 }, entities };
}

test("a watch runs each plugin's hooks, files annotations under ext, and times every hook", async () => {
  let clock = 0;
  const entity = { itemID: 2 };
  const npcRow = () => ({ kind: "ship", itemID: 2, isNpc: true, typeName: "Mule", mode: "STOP", distanceMeters: 9000,
    position: { x: 9000, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1 });
  const selfRow = () => ({ kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", mode: "STOP", distanceMeters: 0,
    position: { x: 0, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1 });
  const seenRows = [];
  const scans = [];
  const hooks = [
    {
      name: "demo",
      annotate: (seen, { row, characterID }) => {
        seenRows.push(row);
        clock += 3;
        return seen === entity ? { groupKey: "gang:a", ext: { gang: "a", characterID } } : null;
      },
      offGrid: {
        watch: ({ characterID }) => ({
          scan: (systemID, context) => {
            scans.push([characterID, systemID, typeof context.labelFor]);
            clock += 5;
            return { events: [{ kind: "NEAR", systemID }], stats: { gangsScanned: 4, sampleMsAvg: -1 } };
          },
        }),
      },
    },
    { name: "throws", annotate: () => { throw new Error("bad plugin"); } },
  ];
  const watch = createGridWatch({
    findSession: () => ({ characterID: 7 }),
    readGrid: (_session, { annotate }) => {
      const rows = [selfRow(), npcRow()];
      annotate(rows[0], { itemID: 1 });
      annotate(rows[1], entity);
      return watchGrid(rows);
    },
    hooks,
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  const lines = [];
  await watch.run({ characterID: 7, forMs: 4000, everyMs: 2000, offGridEveryMs: 2000, clientMode: "off" },
    { write: (event) => lines.push(event), closed: () => false });

  const npc = seenRows.find((row) => row.itemID === 2);
  assert.deepEqual(npc.ext, { demo: { gang: "a", characterID: 7 } });
  assert.equal(npc.groupKey, "gang:a");
  assert.equal(seenRows.find((row) => row.itemID === 1).ext, undefined, "a hook answering null adds nothing");
  assert.deepEqual(scans[0], [7, 30002537, "function"]);
  assert.ok(lines.some((event) => event.kind === "NEAR"), "the scanner's events are streamed");
  const end = lines.at(-1);
  assert.equal(end.kind, "END");
  assert.equal(end.costs.gangsScanned, 4, "a scanner's stats reach END");
  assert.ok(end.costs.sampleMsAvg >= 0, "core numbers win a name clash");
  assert.equal(end.costs.hooks["demo.annotate"].runs, end.samples, "annotate is timed once per sample");
  assert.equal(end.costs.hooks["demo.annotate"].msMax, 6, "both rows' calls count in the sample");
  assert.equal(end.costs.hooks["demo.offGrid"].msAvg, 5);
  assert.ok(end.costs.hooks["throws.annotate"], "a throwing hook is timed and the watch carries on");
});

// The whole bridge on a tree with no Living Universe: a server root with no
// modApi, stock modules faked, the real plugins folder.
function fakeStock(logger) {
  const session = { characterID: 7, characterName: "Agent", _space: { systemID: 30002537 } };
  const ego = { itemID: 1, typeID: 587, mode: "STOP", position: { x: 0, y: 0, z: 0 }, radius: 40 };
  const rat = { itemID: 2, typeID: 23707, mode: "ORBIT", position: { x: 20_000, y: 0, z: 0 }, radius: 40, npc: true };
  const scene = {
    getShipEntityForSession: () => ego,
    getVisibleEntitiesForSession: () => [ego, rat],
    getCurrentSimTimeMs: () => 1_000_000,
  };
  const shutdownHooks = [];
  const stock = {
    sessionRegistry: { findSessionByCharacterID: (id) => (Number(id) === 7 ? session : null) },
    chatCommands: { executeChatCommand: (_s, line) => ({ handled: true, success: true, message: `ran ${line}` }) },
    space: { getSceneForSession: () => scene },
    webGateway: {
      projectSpaceEntity: (entity, egoID) => ({
        itemID: entity.itemID, kind: "ship", typeID: entity.typeID, isSelf: entity.itemID === egoID,
        isNpc: Boolean(entity.npc), mode: entity.mode, position: entity.position, radius: entity.radius,
      }),
    },
    itemTypeRegistry: { resolveItemByTypeID: (typeID) => ({ name: typeID === 587 ? "Rifter" : "Hostile Rat" }) },
    worldData: { getSolarSystemByID: () => ({ solarSystemName: "Amamake", security: 0.4 }) },
    killmailState: { listKillmailsForCharacter: () => [], listKillmailsForCorporation: () => [] },
    gameStore: { registerShutdownHook: (name, fn) => shutdownHooks.push(fn) },
    marshal: { marshalDecodeExact: () => null },
    logger,
  };
  return { stock, shutdownHooks };
}

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("on a tree without Living Universe the lu plugin is skipped, and /grid and /watch still work", async (t) => {
  const root = scratch(t, "e2e-stock-tree-");
  const serverRoot = path.join(root, "server");
  fs.mkdirSync(path.join(serverRoot, "src"), { recursive: true });
  const handshakePath = path.join(root, "_local", "agentBridge", "bridge.json");
  const logger = recorder();
  const { stock, shutdownHooks } = fakeStock(logger);
  const service = createService({
    serverRoot, stock, port: 0,
    env: { EVEJS_AGENT_BRIDGE: "1", EVEJS_AGENT_BRIDGE_HANDSHAKE: handshakePath },
  });
  assert.ok(service.exec(), "the bridge starts");
  t.after(() => Promise.all(shutdownHooks.map((stop) => stop())));
  const handshake = await waitFor(() => fs.existsSync(handshakePath) && JSON.parse(fs.readFileSync(handshakePath, "utf8")));

  assert.deepEqual(service.__testing.pluginStatus(), {
    active: [],
    skipped: [{ name: "lu", reason: "no Living Universe in this tree (no server/src/modApi.js)" }],
  });
  assert.equal(logger.lines.filter((line) => line.includes("plugin lu")).length, 1, logger.lines.join("\n"));

  const call = (method, route, body) => fetch(`http://127.0.0.1:${handshake.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${handshake.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const grid = await (await call("GET", "/grid?characterID=7&ext=1")).json();
  assert.equal(grid.ok, true);
  assert.equal(grid.grid.systemName, "Amamake");
  assert.deepEqual(grid.grid.entities.map((row) => [row.itemID, row.typeName, row.isSelf]),
    [[1, "Rifter", true], [2, "Hostile Rat", false]]);
  assert.equal(grid.grid.entities[1].ext, undefined, "no plugin, no annotations");

  const watched = await call("POST", "/watch", { characterID: 7, forSeconds: 1, everySeconds: 0.5, client: "off" });
  const events = (await watched.text()).trim().split("\n").map((line) => JSON.parse(line));
  const kinds = events.map((event) => event.kind);
  assert.equal(kinds[0], "START");
  assert.ok(kinds.includes("GRID") && kinds.includes("PRESENT"), kinds.join(" "));
  const end = events.at(-1);
  assert.equal(end.kind, "END");
  assert.equal(end.costs.offGridScans, 0, "nothing off grid to scan without a plugin");
  assert.deepEqual(end.costs.hooks, {});

  assert.equal((await call("GET", "/clock")).status, 404, "the plugin's routes are absent, not broken");
  const slash = await (await call("POST", "/slash", { characterID: 7, command: "/tr me Amamake" })).json();
  assert.equal(slash.message, "ran /tr me Amamake");
});

test("the lu plugin's server half assembles with parts of the mod missing, and its routes say what's absent", () => {
  const { createLuServer } = require("../plugins/lu/server");
  const hooks = createLuServer({
    stock: {},
    require: (relativePath) => {
      if (relativePath === "modApi") return {};
      throw new Error(`no ${relativePath}`);
    },
    log: recorder(),
    seams: { findSession: () => null, describeSystem: () => null },
  });
  assert.equal(typeof hooks.annotate, "function");
  assert.equal(typeof hooks.offGrid.watch, "function");
  assert.deepEqual(Object.keys(hooks.routes).sort(),
    ["GET /clock", "GET /economy", "POST /trigger/*", "POST /warp", "POST /warp/stop"]);
  assert.equal(hooks.routes["GET /clock"]().statusCode, 503);
  assert.equal(hooks.routes["POST /trigger/*"]({ rest: "hunt", body: {} }).statusCode, 503);
  assert.equal(hooks.annotate({ itemID: 5 }, { row: { isSelf: true }, nowMs: 0, characterID: 7 }), null,
    "a player row isn't joined");
});
