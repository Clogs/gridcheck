"use strict";

// The server's node under an Electron-based MCP client (core/node.js), the
// tree config's "node", union types in MCP arguments, slash and teleport as a
// real client, the launched-client record (core/clientRecord.js) and restart.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { nodeExecutable, nodesOnPath } = require("../core/node");
const clientRecord = require("../core/clientRecord");
const { validateConfig, loadTreeConfig } = require("../core/treeConfig");
const mcp = require("../bin/mcp");
const cli = require("../bin/gridcheck");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
}

test("plain Node runs the server with its own node; GRIDCHECK_NODE and the config name another", (t) => {
  const dir = tempDir(t);
  const named = touch(path.join(dir, "named", "node.exe"));
  const configured = touch(path.join(dir, "configured", "node.exe"));
  const base = { execPath: "/own/node", versions: { node: "24.0.0" }, useCache: false, env: {} };
  assert.deepStrictEqual(nodeExecutable(base), { path: "/own/node", source: "this process", warning: null });
  assert.strictEqual(nodeExecutable({ ...base, env: { GRIDCHECK_NODE: named }, configured }).path, named, "the environment first");
  assert.strictEqual(nodeExecutable({ ...base, configured }).source, "gridcheck.config.json");
  const missing = nodeExecutable({ ...base, env: { GRIDCHECK_NODE: path.join(dir, "nope.exe") } });
  assert.strictEqual(missing.path, "/own/node");
  assert.match(missing.warning, /isn't a file/);
});

test("under Electron's node the first real node on PATH runs the server", (t) => {
  const dir = tempDir(t);
  const electron = touch(path.join(dir, "app", "node.exe"));
  const electronAgain = touch(path.join(dir, "shim", "node.exe"));
  const real = touch(path.join(dir, "nodejs", "node.exe"));
  touch(path.join(dir, "nodejs", "node.cmd"));
  const env = { PATH: [path.dirname(electron), path.dirname(electronAgain), path.dirname(real)].join(path.delimiter), PATHEXT: ".EXE;.CMD" };
  assert.deepStrictEqual(nodesOnPath(env, "win32"), [electron, electronAgain, real], "only executables, in PATH order");
  const probed = [];
  const probe = (file) => {
    probed.push(file);
    return file === electronAgain ? "38.1.0" : "";
  };
  const picked = nodeExecutable({ env, execPath: electron, versions: { electron: "38.1.0" }, platform: "win32", probe, useCache: false });
  assert.deepStrictEqual(picked, { path: real, source: "PATH", warning: null });
  assert.deepStrictEqual(probed, [electronAgain, real], "its own binary is skipped without running it");
  const alone = nodeExecutable({ env: { PATH: path.dirname(electron) }, execPath: electron, versions: { electron: "38.1.0" },
    platform: "win32", probe, useCache: false });
  assert.strictEqual(alone.path, electron);
  assert.match(alone.warning, /GRIDCHECK_NODE/);
});

test("the tree config takes node as a path, resolved against the tree", (t) => {
  const dir = tempDir(t);
  assert.deepStrictEqual(validateConfig({ configVersion: 1, node: "" }), ["node is the path of a node executable"]);
  assert.deepStrictEqual(validateConfig({ configVersion: 1, node: "tools/node/node.exe" }), []);
  fs.writeFileSync(path.join(dir, "gridcheck.config.json"), JSON.stringify({ configVersion: 1, node: "tools/node/node.exe" }));
  assert.strictEqual(loadTreeConfig(dir, { env: {} }).node, path.join(dir, "tools", "node", "node.exe"));
  fs.writeFileSync(path.join(dir, "gridcheck.config.json"), JSON.stringify({ configVersion: 1 }));
  assert.strictEqual(loadTreeConfig(dir, { env: {} }).node, null);
});

test("an argument typed as a list of types takes any of them: client_act's target", () => {
  const act = mcp.TOOLS.find((tool) => tool.name === "client_act");
  assert.deepStrictEqual(mcp.checkParams(act, { action: "warpTo", target: 40491241 }), []);
  assert.deepStrictEqual(mcp.checkParams(act, { action: "warpTo", target: "40491241" }), []);
  assert.deepStrictEqual(mcp.checkParams(act, { action: "warpTo", target: true }), ["target must be a string or a number"]);
});

test("slash and teleport run as a real client with as, restart passes up's flags and clients", () => {
  assert.deepStrictEqual(mcp.cliArgs("slash", { command: "/corpmember list", as: "client", user: "e2eclient" }),
    ["slash", "--as=client", "--user=e2eclient", "--", "/corpmember list"]);
  assert.deepStrictEqual(mcp.cliArgs("teleport", { system: "Yulai", as: "client" }), ["teleport", "--as=client", "--", "Yulai"]);
  assert.deepStrictEqual(mcp.cliArgs("restart", { clients: true, timeout: 300 }), ["restart", "--timeout=300", "--clients"]);
  assert.deepStrictEqual(mcp.cliArgs("down", { keepClients: true }), ["down", "--keep-clients"]);
  assert.deepStrictEqual(cli.slashSubject({}), { as: "headless", user: undefined });
  assert.deepStrictEqual(cli.slashSubject({ as: "client", user: "e2eclient2" }), { as: "client", user: "e2eclient2" });
  assert.throws(() => cli.slashSubject({ as: "gm" }), /headless .* or client/);
  assert.throws(() => cli.slashSubject({ user: "x" }), /--as client/);
});

test("a restart without up flags boots with the last up's env, profile and plugin number flags", () => {
  const previous = { env: { EVEJS_SWITCH: "1" }, profile: { everyTicks: 20 }, options: {} };
  assert.deepStrictEqual(cli.restartUpFlags(previous, {}),
    { env: ["EVEJS_SWITCH=1"], profile: true, "profile-every": 20 });
  assert.deepStrictEqual(cli.restartUpFlags(previous, { timeout: "300" }),
    { timeout: "300", env: ["EVEJS_SWITCH=1"], profile: true, "profile-every": 20 }, "a timeout isn't an up flag to replace them");
  assert.deepStrictEqual(cli.restartUpFlags(previous, { world: "starter" }), { world: "starter" }, "given flags win outright");
  assert.deepStrictEqual(cli.restartUpFlags(null, {}), {});
});

test("the launched-client record keeps the pid and launch flags, never more, and forgets on stop", (t) => {
  const dir = tempDir(t);
  assert.deepStrictEqual(clientRecord.readLaunched(dir), {});
  const row = clientRecord.recordLaunched(dir, "e2eclient", { pid: 4242, characterID: 9000001, accountID: 7, launchedAtMs: 1,
    flags: { user: "e2eclient", name: "Client Observer", graphics: "dx11", wait: "30", timeout: "5" } });
  assert.deepStrictEqual(row, { pid: 4242, characterID: 9000001, accountID: 7, launchedAtMs: 1,
    flags: { user: "e2eclient", name: "Client Observer", graphics: "dx11" } });
  clientRecord.recordLaunched(dir, "e2eclient2", { pid: 5, flags: {} });
  assert.deepStrictEqual(Object.keys(clientRecord.readLaunched(dir)), ["e2eclient", "e2eclient2"]);
  clientRecord.forgetLaunched(dir, "e2eclient");
  assert.deepStrictEqual(Object.keys(clientRecord.readLaunched(dir)), ["e2eclient2"]);
});

test("a recorded pid counts as the client only while its process is exefile.exe", () => {
  const tasklist = (stdout) => () => ({ status: 0, stdout });
  assert.strictEqual(clientRecord.processImage(4242, { platform: "win32", run: tasklist("\"exefile.exe\",\"4242\",\"Console\",\"1\",\"900,000 K\"\r\n") }),
    "exefile.exe");
  assert.ok(clientRecord.isClientProcess(4242, { platform: "win32", run: tasklist("\"exefile.exe\",\"4242\",\"Console\",\"1\",\"9 K\"\r\n") }));
  assert.ok(!clientRecord.isClientProcess(4242, { platform: "win32", run: tasklist("\"chrome.exe\",\"4242\",\"Console\",\"1\",\"9 K\"\r\n") }),
    "Windows gave the pid to another process");
  assert.ok(!clientRecord.isClientProcess(4242, { platform: "win32", run: tasklist("INFO: No tasks are running which match the specified criteria.\r\n") }));
  assert.strictEqual(clientRecord.processImage(0), null);
});
