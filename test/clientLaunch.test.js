"use strict";

// client launch's switches, its /noconsole output file, and how it tells a
// client that won't start from one that is still starting.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const { launchSwitches, launchFailure, redactSwitches, startClient } = require("../core/client");
const { validateScenario } = require("../core/scenario");
const mcp = require("../bin/mcp");

test("launch adds a switch only when asked: settings profile, renderer, no console", () => {
  assert.deepStrictEqual(launchSwitches({}), { args: [] });
  assert.deepStrictEqual(launchSwitches({ settingsProfile: "Gridcheck_UI-1", graphics: "dx12", noConsole: true }).args,
    ["/settingsprofile=Gridcheck_UI-1", "/triPlatform=dx12", "/noconsole"]);
  for (const settingsProfile of ["../real", "ok /ssoToken=bad", "", "x".repeat(65)]) {
    assert.match(launchSwitches({ settingsProfile }).error, /settings-profile/, settingsProfile);
  }
  assert.match(launchSwitches({ graphics: "stub" }).error, /dx11 or dx12/);
});

test("with a log file the client gets the file as its stdout, not a pipe; without one, nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-launch-"));
  try {
    const seen = [];
    const fake = (_exe, _args, options) => {
      seen.push(options.stdio);
      return { pid: 1, unref() {}, once() {} };
    };
    startClient({ exe: path.join(dir, "exefile.exe"), args: [], env: {}, spawnImpl: fake });
    startClient({ exe: path.join(dir, "exefile.exe"), args: [], env: {}, logfile: path.join(dir, "out", "launch.log"), spawnImpl: fake });
    assert.strictEqual(seen[0], "ignore");
    assert.strictEqual(seen[1][0], "ignore");
    assert.strictEqual(typeof seen[1][1], "number", "a file descriptor");
    assert.strictEqual(seen[1][1], seen[1][2]);
    assert.ok(fs.existsSync(path.join(dir, "out", "launch.log")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a client that prints a known startup failure, or whose launcher fails, is reported; exit 0 is its hand-off", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-launch-"));
  try {
    const logfile = path.join(dir, "launch.log");
    const child = startClient({ exe: process.execPath, env: process.env, logfile,
      args: ["-e", "console.log('exefile /ssoToken=secret-token'); console.error('NoAdaptersFoundError: none'); process.exit(3)"] });
    await once(child, "exit");
    assert.match(fs.readFileSync(logfile, "utf8"), /NoAdaptersFoundError/, "the process wrote the file itself");
    assert.match(launchFailure(child.gridcheckLaunch, logfile), /no graphics adapter/);
    assert.strictEqual(child.gridcheckLaunch.exitCode, 3);

    assert.match(launchFailure({ exited: true, exitCode: 3, error: null }), /exited with code 3/);
    assert.strictEqual(launchFailure({ exited: true, exitCode: 0, error: null }), null);
    assert.strictEqual(launchFailure({ exited: false, exitCode: null, error: null }, path.join(dir, "none.log")), null);
    assert.match(launchFailure({ exited: false, exitCode: null, error: "spawn ENOENT" }), /didn't start: spawn ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("token and login switches are redacted from what launch prints", () => {
  assert.strictEqual(redactSwitches("ran /ssoToken=abc then saw abc", ["/ssoToken=abc"]), "ran /ssoToken=[redacted] then saw [redacted]");
  assert.strictEqual(redactSwitches("/login:pilot:secret /refreshToken=xyz"), "/login:[redacted] /refreshToken=[redacted]");
});

test("a scenario's clientLaunch takes launch's flags; MCP passes them on", () => {
  const scenario = (clientLaunch) => validateScenario({ name: "launch", world: "fresh", setup: [{ clientLaunch }],
    until: { timeout: 2 }, expect: ["GRID"] });
  const step = scenario({ user: "ui", settingsProfile: "GridcheckUI", graphics: "dx11", noConsole: true, exe: "C:/eve/exefile.exe" })
    .setup.find((row) => row.type === "clientLaunch");
  assert.deepStrictEqual(step.launch, { exe: "C:/eve/exefile.exe", "settings-profile": "GridcheckUI", graphics: "dx11", "no-console": true });
  assert.strictEqual(scenario(true).setup.find((row) => row.type === "clientLaunch").launch, undefined);
  for (const [value, problem] of [[{ graphics: "vulkan" }, /dx11 or dx12/], [{ settingsProfile: "a b" }, /settings-profile/],
    [{ noConsole: "yes" }, /noConsole/], [{ console: true }, /unknown key/]]) {
    assert.throws(() => scenario(value), problem, JSON.stringify(value));
  }
  assert.deepStrictEqual(mcp.cliArgs("client_launch", { settingsProfile: "GridcheckUI", graphics: "dx12", noConsole: true }),
    ["client", "--settings-profile=GridcheckUI", "--graphics=dx12", "--no-console", "--", "launch"]);
});
