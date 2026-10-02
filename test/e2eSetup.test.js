"use strict";

// e2e setup (core/setup.js): what it refuses before changing anything, the
// commands it runs in order, what it skips, and where it stops.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseSetupArgs, runSetup } = require("../core/setup");

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

// A tree with its dependencies and reference data, no copy and no config.
function scratchTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "server/package.json", JSON.stringify({ dependencies: { ws: "1" }, scripts: { start: "node ." } }));
  write(root, "server/src/index.js", "");
  fs.mkdirSync(path.join(root, "server", "node_modules"));
  write(root, "_local/gameStore/data/solarSystems/data.json", "[]");
  return root;
}

// io that records commands; answers maps a command word to { code, stdout }.
function fakeIO({ codes = {}, reads = {}, onRun = () => {} } = {}) {
  const lines = [];
  const ran = [];
  return {
    lines,
    ran,
    out: (line) => lines.push(line),
    run: async (args) => {
      const words = args.slice(1);
      ran.push(words);
      onRun(words);
      return codes[words[0]] || 0;
    },
    read: (args) => reads[args.slice(1, 3).join(" ")] || { code: 1, stdout: "" },
  };
}

const checkout = { vendored: false, tree: null, head: "abc1234def" };

test("parseSetupArgs takes the tree as --tree or a word, and checks every list", () => {
  assert.strictEqual(parseSetupArgs(["--tree", "/x"]).tree, path.resolve("/x"));
  assert.strictEqual(parseSetupArgs(["/y", "--dry-run"]).dryRun, true);
  assert.deepStrictEqual(parseSetupArgs(["/x", "--agents", "claude,cli"]).agents, ["claude", "cli"]);
  assert.strictEqual(parseSetupArgs(["/x", "--agents=none"]).agents, "none");
  assert.deepStrictEqual([...parseSetupArgs(["/x", "--skip", "world,smoke"]).skip], ["world", "smoke"]);
  assert.throws(() => parseSetupArgs(["/x", "--mode", "wild"]), /--mode is auto, attach, managed/);
  assert.throws(() => parseSetupArgs(["/x", "--agents", "cursor"]), /--agents is none/);
  assert.throws(() => parseSetupArgs(["/x", "--skip", "vendor"]), /--skip takes agents, patches, world, smoke/);
  assert.throws(() => parseSetupArgs([], { cwd: os.tmpdir() }), /setup needs the tree/);
  assert.strictEqual(parseSetupArgs([], { defaultTree: "/own" }).tree, path.resolve("/own"));
});

test("missing dependencies or reference data refuse before anything runs, naming the fix", async (t) => {
  const root = scratchTree(t);
  fs.rmSync(path.join(root, "server", "node_modules"), { recursive: true });
  fs.rmSync(path.join(root, "_local"), { recursive: true });
  const io = fakeIO();
  assert.strictEqual(await runSetup(parseSetupArgs([root]), io, checkout), 2);
  assert.deepStrictEqual(io.ran, []);
  const text = io.lines.join("\n");
  assert.match(text, /server dependencies missing \(server\/node_modules\/\): npm ci in server/);
  assert.match(text, /reference data missing .*CreateDatabase\.bat/);
});

test("a server that is up refuses, and so does a vendored copy asked for another tree", async (t) => {
  const root = scratchTree(t);
  write(root, "_local/agentBridge/bridge.json", JSON.stringify({ port: 1, pid: process.pid }));
  const io = fakeIO();
  assert.strictEqual(await runSetup(parseSetupArgs([root]), io, checkout), 2);
  assert.match(io.lines.join("\n"), /server is up .*Stop it first/);
  const other = fakeIO();
  assert.strictEqual(await runSetup(parseSetupArgs([root]), other, { vendored: true, tree: os.tmpdir(), head: null }), 2);
  assert.match(other.lines.join("\n"), /this copy belongs to/);
});

test("a new tree gets every step in order; a failed step stops setup and says to rerun", async (t) => {
  const root = scratchTree(t);
  const copyCli = path.join(root, "tools", "evejs-e2e", "bin", "e2e.js");
  // vendor update "installs" the copy, so later steps find it.
  const io = fakeIO({
    onRun: (words) => { if (words[0] === "vendor") write(root, "tools/evejs-e2e/bin/e2e.js", ""); },
    reads: { "patch status": { code: 0, stdout: JSON.stringify([{ id: "xmpp-port", state: "absent", applies: true },
      { id: "slash-success", state: "detected", applies: true }]) } },
  });
  const code = await runSetup(parseSetupArgs([root, "--agents", "cli"]), io, checkout);
  assert.strictEqual(code, 0, io.lines.join("\n"));
  assert.deepStrictEqual(io.ran.map((words) => words.slice(0, 2)),
    [["vendor", "update"], ["init", "--mode"], ["agents", "setup"], ["patch", "apply"], ["world", "build"], ["run", "smoke-undock"]]);
  assert.deepStrictEqual(io.ran[3], ["patch", "apply", "xmpp-port"], "only the absent patch");
  assert.ok(fs.existsSync(copyCli));
  assert.match(io.lines.join("\n"), /ready: .* can run tests/);

  const failing = fakeIO({ codes: { init: 1 } });
  assert.strictEqual(await runSetup(parseSetupArgs([root, "--agents", "none"]), failing, checkout), 1);
  assert.deepStrictEqual(failing.ran.map((words) => words[0]), ["vendor", "init"]);
  assert.match(failing.lines.join("\n"), /setup stopped at "Write the tree's config".*run setup again/);
});

test("what is done is skipped: the config, agents, patches, a current world; attach mode skips world and smoke", async (t) => {
  const root = scratchTree(t);
  write(root, "tools/evejs-e2e/bin/e2e.js", "");
  write(root, "e2e.config.json", JSON.stringify({ configVersion: 1, mode: "attach" }));
  const io = fakeIO({
    reads: { "patch status": { code: 0, stdout: JSON.stringify([{ id: "xmpp-port", state: "applied", applies: true }]) } },
  });
  assert.strictEqual(await runSetup(parseSetupArgs([root, "--agents", "none"]), io, { vendored: true, tree: root, head: null }), 0);
  assert.deepStrictEqual(io.ran, []);
  const text = io.lines.join("\n");
  assert.match(text, /\[1\/6\][^\n]*\n  skipped: this is the tree's own copy/);
  assert.match(text, /skipped: e2e\.config\.json is there, in attach mode/);
  assert.match(text, /skipped: every patch is applied or detected already/);
  assert.match(text, /skipped: attach mode: the tool doesn't start the server/);

  write(root, "e2e.config.json", JSON.stringify({ configVersion: 1, mode: "auto" }));
  const built = fakeIO({ reads: {
    "patch status": { code: 0, stdout: "[]" },
    "world recipes": { code: 0, stdout: JSON.stringify([{ name: "starter", state: "built" }]) },
  } });
  await runSetup(parseSetupArgs([root, "--agents", "none", "--skip", "smoke"]), built, { vendored: true, tree: root, head: null });
  assert.deepStrictEqual(built.ran, []);
  assert.match(built.lines.join("\n"), /skipped: starter is built and current/);
});

test("a partly applied patch stops setup with the revert to run", async (t) => {
  const root = scratchTree(t);
  write(root, "tools/evejs-e2e/bin/e2e.js", "");
  write(root, "e2e.config.json", JSON.stringify({ configVersion: 1, mode: "auto" }));
  const io = fakeIO({ reads: { "patch status": { code: 0, stdout: JSON.stringify([{ id: "last-decision", state: "partial" }]) } } });
  assert.strictEqual(await runSetup(parseSetupArgs([root, "--agents", "none"]), io, { vendored: true, tree: root, head: null }), 1);
  assert.match(io.lines.join("\n"), /`e2e patch revert last-decision` puts the file back/);
});
