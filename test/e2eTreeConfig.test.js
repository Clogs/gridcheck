"use strict";

// A tree's e2e.config.json (core/treeConfig.js): defaults, the file, the
// environment, the listener probe, and the CLI's attach and managed modes.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  CONFIG_NAME, defaultConfig, loadTreeConfig, probeTree, validateConfig, writeTreeConfig,
} = require("../core/treeConfig");
const worlds = require("../core/worlds");

const CLI = path.join(__dirname, "..", "bin", "e2e.js");

function scratchTree(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tree-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const all = { "server/package.json": JSON.stringify({ scripts: { start: "node --max-old-space-size=8192 ." } }), ...files };
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const NO_ENV = {};

test("a tree with no file gets the stock layout, in attach mode", (t) => {
  const root = scratchTree(t, { "_local/gameStore/manifest.json": "{}" });
  const config = loadTreeConfig(root, { env: NO_ENV });
  assert.equal(config.exists, false);
  assert.deepEqual(config.problems, []);
  assert.equal(config.mode, "attach");
  assert.deepEqual(config.start, ["node", "--max-old-space-size=8192", "."]);
  assert.equal(config.dataDir, path.join(root, "_local", "gameStore", "data"));
  assert.equal(config.gameStore, path.join(root, "_local", "gameStore", "gamestore.sqlite"));
  assert.equal(config.manifest, path.join(root, "_local", "gameStore", "manifest.json"));
  assert.equal(config.logFile, path.join(root, "_local", "logs", "server.log"));
  assert.equal(config.runsDir, path.join(root, "_local", "e2e", "runs"));
  assert.equal(config.worldsDir, path.join(root, "_local", "e2e", "worlds"));
  assert.equal(config.handshake, path.join(root, "_local", "agentBridge", "bridge.json"));
  assert.equal(config.scenariosDir, path.join(root, "tools", "e2e-scenarios"));
  assert.equal(config.market.enabled, false, "no market source, no market");
});

test("before any database is generated the data dir is the copy in the source, as the server picks it", (t) => {
  const root = scratchTree(t);
  assert.equal(loadTreeConfig(root, { env: NO_ENV }).dataDir, path.join(root, "server", "src", "gameStore", "data"));
});

test("the environment moves the data dir, the game store beside it, the log and the handshake", (t) => {
  const root = scratchTree(t);
  const elsewhere = path.join(root, "elsewhere");
  const config = loadTreeConfig(root, { env: {
    EVEJS_GAMESTORE_DATA_DIR: path.join(elsewhere, "store", "data"),
    EVEJS_DATA_ROOT: path.join(elsewhere, "root"),
    EVEJS_AGENT_BRIDGE_HANDSHAKE: path.join(elsewhere, "hs.json"),
  } });
  assert.equal(config.dataDir, path.join(elsewhere, "store", "data"));
  assert.equal(config.gameStore, path.join(elsewhere, "store", "gamestore.sqlite"));
  assert.equal(config.manifest, path.join(elsewhere, "store", "manifest.json"));
  assert.equal(config.logFile, path.join(elsewhere, "root", "logs", "server.log"));
  assert.equal(config.handshake, path.join(elsewhere, "hs.json"));
});

test("the file sets paths relative to the tree, and the worlds follow it", (t) => {
  const root = scratchTree(t, {
    [CONFIG_NAME]: JSON.stringify({
      configVersion: 1, mode: "managed", e2eDir: "work/e2e", worldsDir: "saves", logFile: "logs/game.log",
      daemons: { market: { enabled: true, database: "market/market.sqlite" } },
    }),
  });
  const config = loadTreeConfig(root, { env: NO_ENV });
  assert.deepEqual(config.problems, []);
  assert.equal(config.exists, true);
  assert.equal(config.mode, "managed");
  assert.equal(config.e2eDir, path.join(root, "work", "e2e"));
  assert.equal(config.runsDir, path.join(root, "work", "e2e", "runs"), "runs follow e2eDir unless set");
  assert.equal(config.worldsDir, path.join(root, "saves"));
  assert.equal(config.logFile, path.join(root, "logs", "game.log"));
  assert.equal(config.market.enabled, true);
  const paths = worlds.worldPaths(root);
  assert.equal(paths.saved, path.join(root, "saves"));
  assert.equal(paths.market, path.join(root, "market", "market.sqlite"));
});

test("every problem in the file is reported, and the defaults stand in", (t) => {
  assert.deepEqual(validateConfig({ configVersion: 1 }), []);
  const problems = validateConfig({ configVersion: 2, mode: "auto", colour: "red", start: ["npm", "start"], runsDir: "",
    listeners: { xmpp: { movable: "no" } }, daemons: { redis: {}, market: { enabled: "yes", port: 1 } } });
  for (const pattern of [/configVersion is 2/, /mode is attach or managed/, /unknown key colour/, /start is an argv/,
    /runsDir is a path/, /listeners.xmpp.movable/, /daemons.redis/, /daemons.market: unknown key port/, /market.enabled/]) {
    assert.ok(problems.some((problem) => pattern.test(problem)), `${pattern} in ${problems.join("; ")}`);
  }
  const root = scratchTree(t, { [CONFIG_NAME]: JSON.stringify({ configVersion: 1, mode: "auto",
    gameStore: "somewhere/else.sqlite" }) });
  const config = loadTreeConfig(root, { env: NO_ENV });
  assert.equal(config.mode, "attach", "a bad mode falls back to attach");
  assert.ok(config.problems.some((problem) => /gameStore must sit beside the data dir/.test(problem)), config.problems.join("; "));
  fs.writeFileSync(path.join(root, CONFIG_NAME), "{ not json");
  assert.match(loadTreeConfig(root, { env: NO_ENV }).problems[0], /not JSON/);
});

test("init's probe moves a listener only when the tree reads its variable", (t) => {
  const root = scratchTree(t, {
    "_local/gameStore/manifest.json": "{}",
    "server/src/config/schema/server.js": "envVar: \"EVEJS_SERVER_PORT\"; envVar: \"EVEJS_MICROSERVICES_PORT\"",
    "server/src/edge/chat.js": "// no port variable here",
    "server/src/node_modules/dep/index.js": "EVEJS_XMPP_SERVER_PORT",
  });
  const { config, notes } = probeTree(root, { env: NO_ENV, mode: "managed",
    pluginListeners: [{ name: "demoBridge", offset: 6, env: "EVEJS_DEMO_PORT" }] });
  assert.equal(config.mode, "managed");
  assert.deepEqual(config.listeners.game, { movable: true, via: "EVEJS_SERVER_PORT" });
  assert.equal(config.listeners.gatewayTls.movable, true, "follows the gateway");
  assert.equal(config.listeners.xmpp.movable, false, "node_modules isn't the tree's source");
  assert.equal(config.listeners.image.movable, false);
  assert.equal(config.listeners.agentBridge.movable, true, "the bridge is this tool's");
  assert.deepEqual(config.listeners.demoBridge, { movable: false, via: "EVEJS_DEMO_PORT" });
  assert.ok(notes.some((note) => /stay on their stock ports: .*xmpp/.test(note)), notes.join("; "));
  assert.deepEqual(validateConfig(config), [], "what init writes is valid");
});

test("writing refuses to replace a file without force, and refuses a bad config", (t) => {
  const root = scratchTree(t);
  const config = defaultConfig(root, NO_ENV);
  writeTreeConfig(root, config);
  assert.throws(() => writeTreeConfig(root, config), /exists; pass --force/);
  writeTreeConfig(root, { ...config, mode: "managed" }, { force: true });
  assert.equal(loadTreeConfig(root, { env: NO_ENV }).mode, "managed");
  assert.throws(() => writeTreeConfig(root, { ...config, mode: "auto" }, { force: true }), /refusing to write/);
});

function cli(root, args) {
  const env = { ...process.env, EVEJS_E2E_TREE: root };
  for (const name of ["EVEJS_AGENT_BRIDGE_HANDSHAKE", "EVEJS_GAMESTORE_DATA_DIR", "EVEJS_DATA_ROOT", "EVEJS_E2E_PORT_SLOT"]) delete env[name];
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test("attach mode refuses the lifecycle and runs only on a live server", (t) => {
  const root = scratchTree(t, { "_local/gameStore/manifest.json": "{}" });
  for (const args of [["up"], ["down"], ["world", "save", "x"], ["world", "copy", "--from", root]]) {
    const result = cli(root, args);
    assert.equal(result.code, 1, `${args.join(" ")}: ${result.out}`);
    assert.match(result.out, /needs managed mode; this tree is in attach mode/);
  }
  const run = cli(root, ["run", "smoke-undock"]);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /attach mode runs on a live server/);
  const check = cli(root, ["run", "smoke-undock", "--check"]);
  assert.equal(check.code, 0, `a check boots nothing, in either mode: ${check.out}`);
  assert.match(cli(root, ["status"]).out, /mode {3}attach \(no e2e.config.json/);
});

test("init writes the config, refuses to overwrite it, and managed mode turns the lifecycle on", (t) => {
  const root = scratchTree(t, { "_local/gameStore/manifest.json": "{}" });
  const first = cli(root, ["init"]);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /wrote e2e.config.json, mode attach/);
  assert.match(first.out, /next: start the server with EVEJS_AGENT_BRIDGE=1/);
  assert.equal(cli(root, ["init"]).code, 1, "an existing config needs --force");
  const managed = cli(root, ["init", "--mode", "managed", "--force"]);
  assert.match(managed.out, /mode managed/);
  const up = cli(root, ["up", "--fresh", "--timeout", "10"]);
  assert.doesNotMatch(up.out, /needs managed mode/);
  assert.match(up.out, /server start|server exited|not ready|no world|reference data|port/i, up.out);
});

test("a broken config stops every command but init, doctor, help and vendor", (t) => {
  const root = scratchTree(t, { [CONFIG_NAME]: JSON.stringify({ configVersion: 1, mode: "sometimes" }) });
  const status = cli(root, ["status"]);
  assert.equal(status.code, 1);
  assert.match(status.out, /mode is attach or managed.*e2e init --force/s);
  assert.equal(cli(root, ["help"]).code, 0);
});
