"use strict";

// A tree's runs as agents read them (core/runs.js), the CLI's report and
// run --detach, and the primer each surface gets (core/primer.js).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createRuns } = require("../core/runs");
const { primer } = require("../core/primer");
const { defaultRegistry } = require("../core/plugins");

const CLI = path.join(__dirname, "..", "bin", "gridcheck.js");

function scratchTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-runs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "server", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "package.json"), "{}");
  return root;
}

function writeRun(root, runID, { exitCode = 0, failure = null } = {}) {
  const dir = path.join(root, "_local", "gridcheck", "runs", runID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    name: "smoke-undock", exitCode, failure, scenarioFile: "tools/gridcheck-scenarios/smoke-undock.json", world: "fresh",
    startedAtMs: 0, stoppedAtMs: 30000, expectations: [{ text: "GRID self", met: exitCode === 0 }], frames: [],
  }));
  fs.writeFileSync(path.join(dir, "report.md"), "# smoke-undock\n\n1 of 1 expectations met.\n\n## Expected against observed\n\nrow\n\n## Timeline\n\nlots\n");
  return dir;
}

const runsFor = (root, surface) => createRuns({ treeRoot: root, runsDir: path.join(root, "_local", "gridcheck", "runs"),
  e2eDir: path.join(root, "_local", "gridcheck"), surface });

test("readReport lists runs, reads a summary without its timeline, and cites a run for a PR", async (t) => {
  const root = scratchTree(t);
  writeRun(root, "20261002-100000-smoke-undock");
  const runs = runsFor(root, "cli");
  assert.match((await runs.readReport({})).text, /PASSED 1\/1\s+smoke-undock/);
  const summary = await runs.readReport({ run: "latest" });
  assert.strictEqual(summary.isError, false);
  assert.strictEqual(summary.exitCode, 0);
  assert.match(summary.text, /Expected against observed/);
  assert.doesNotMatch(summary.text, /lots/);
  assert.match((await runs.readReport({ run: "latest", section: "full" })).text, /lots/);
  assert.match((await runs.readReport({ run: "latest", section: "pr" })).text, /### End-to-end check `smoke-undock`: PASSED/);
  assert.strictEqual((await runs.readReport({ run: "latest", section: "nope" })).isError, true);
  assert.strictEqual((await runs.readReport({ run: "missing" })).isError, true);
});

test("a background run that died without a report says so, naming its console", async (t) => {
  const root = scratchTree(t);
  const runs = runsFor(root, "cli");
  fs.mkdirSync(runs.backgroundDir, { recursive: true });
  fs.writeFileSync(path.join(runs.backgroundDir, "r1.log"), "booting\ncrashed: boom\n");
  fs.writeFileSync(path.join(runs.backgroundDir, "r1.json"), JSON.stringify({ runID: "r1", pid: 0, startedAtMs: Date.now(), log: "_local/gridcheck/background/r1.log" }));
  const reply = await runs.readReport({ run: "r1" });
  assert.strictEqual(reply.isError, true);
  assert.match(reply.text, /ended without a report[\s\S]*crashed: boom/);
});

test("each surface names its own commands", () => {
  const registry = defaultRegistry();
  const cli = primer({ registry, surface: "cli" });
  assert.match(cli, /`gridcheck run <name> --detach`/);
  assert.match(cli, /`gridcheck status`/);
  assert.doesNotMatch(cli, /run_scenario|`status`/);
  const mcp = primer({ registry, surface: "mcp" });
  assert.match(mcp, /`run_scenario` \{ name, scenario, check: true \}/);
  assert.doesNotMatch(mcp, /`gridcheck status`/);
  if (registry.primers.length) assert.match(cli, /the tool `<plugin>_<name>` is the CLI command/);
});

test("the CLI's report exits by verdict, and run --detach starts a background run", (t) => {
  const root = scratchTree(t);
  writeRun(root, "20261002-100000-failed", { exitCode: 1 });
  const env = { ...process.env, GRIDCHECK_TREE: root };
  const failed = spawnSync(process.execPath, [CLI, "report", "latest"], { encoding: "utf8", env });
  assert.strictEqual(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /Files:/);
  const none = spawnSync(process.execPath, [CLI, "report", "nope"], { encoding: "utf8", env });
  assert.strictEqual(none.status, 2);

  // Attach mode with no server: the background run stops at once, and report says why.
  fs.writeFileSync(path.join(root, "gridcheck.config.json"), JSON.stringify({ configVersion: 1, mode: "attach" }));
  const scenarios = path.join(root, "tools", "gridcheck-scenarios");
  fs.mkdirSync(scenarios, { recursive: true });
  fs.writeFileSync(path.join(scenarios, "bg.json"), JSON.stringify({ world: "fresh", setup: ["undock"], until: { timeout: 5 },
    expect: ["ARRIVE who=npc"] }));
  const started = spawnSync(process.execPath, [CLI, "run", "bg", "--detach", "--run", "bg-1"], { encoding: "utf8", env });
  assert.strictEqual(started.status, 0, started.stderr);
  assert.match(started.stdout, /started run bg-1 in the background \(pid \d+\); console in _local\/gridcheck\/background\/bg-1\.log/);
  assert.match(started.stdout, /`gridcheck report bg-1 --wait 600`/);
  const record = JSON.parse(fs.readFileSync(path.join(root, "_local", "gridcheck", "background", "bg-1.json"), "utf8"));
  assert.deepStrictEqual(record.args.slice(0, 2), ["run", "--run=bg-1"]);
  const until = Date.now() + 15000;
  const alive = () => { try { process.kill(record.pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
  while (alive() && Date.now() < until) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 200)"]);
  const ended = spawnSync(process.execPath, [CLI, "report", "bg-1"], { encoding: "utf8", env });
  assert.strictEqual(ended.status, 2);
  assert.match(ended.stdout, /ended without a report[\s\S]*attach mode runs on a live server/);
});
