"use strict";

// Which copy runs a command (core/launcher.js): a checkout hands a command to
// a tree's own copy for --tree or a working directory inside the tree.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { planLaunch, takeTreeFlag } = require("../core/launcher");

const CLI = path.join(__dirname, "..", "bin", "e2e.js");
const CHECKOUT = path.resolve("/work/checkout");
const TREE = path.resolve("/work/tree");
const COPY_CLI = path.join(TREE, "tools", "evejs-e2e", "bin", "e2e.js");

function fakeFiles(files) {
  const set = new Set(files.map((file) => path.resolve(file)));
  return (file) => set.has(path.resolve(file));
}

const treeFiles = [TREE, path.join(TREE, "server", "package.json"), path.join(TREE, "server", "src")];
const plan = (argv, { files = [...treeFiles, COPY_CLI], cwd = CHECKOUT, env = {}, ownRoot = CHECKOUT } = {}) =>
  planLaunch({ argv, ownRoot, env, cwd, exists: fakeFiles(files) });

test("takeTreeFlag strips --tree before -- and keeps the rest", () => {
  assert.deepStrictEqual(takeTreeFlag(["run", "--tree", "x", "a"]), { rest: ["run", "a"], tree: "x", error: null });
  assert.deepStrictEqual(takeTreeFlag(["--tree=x", "slash", "--", "--tree", "y"]),
    { rest: ["slash", "--", "--tree", "y"], tree: "x", error: null });
  assert.strictEqual(takeTreeFlag(["run", "--tree"]).error, "--tree needs a path");
});

test("a checkout hands --tree to that tree's copy, flag first or last", () => {
  for (const argv of [["--tree", TREE, "run", "smoke-undock"], ["run", "smoke-undock", "--tree", TREE]]) {
    const result = plan(argv);
    assert.strictEqual(result.kind, "handoff");
    assert.strictEqual(result.cli, COPY_CLI);
    assert.deepStrictEqual(result.argv, ["run", "smoke-undock"]);
    assert.strictEqual(result.command, "run");
  }
});

test("a checkout run from inside a tree hands off without --tree", () => {
  const result = plan(["status"], { cwd: path.join(TREE, "server", "src") });
  assert.strictEqual(result.kind, "handoff");
  assert.strictEqual(result.tree, TREE);
});

test("a tree without a copy, or no tree at all, says what to run", () => {
  const bare = plan(["status", "--tree", TREE], { files: treeFiles });
  assert.strictEqual(bare.kind, "error");
  assert.match(bare.message, /no copy of the tool yet.*e2e setup --tree/);
  const none = plan(["status"]);
  assert.strictEqual(none.kind, "error");
  assert.match(none.message, /pass --tree <path>/);
  assert.strictEqual(plan(["help"]).kind, "local");
  assert.strictEqual(plan([]).kind, "local");
  assert.match(plan(["status", "--tree", "/nowhere"]).message, /no folder/);
});

test("vendor, gui and setup keep --tree as their own flag", () => {
  for (const command of ["vendor", "gui", "setup"]) {
    const argv = [command, "--tree", TREE];
    assert.deepStrictEqual(plan(argv), { kind: "local", argv });
  }
});

test("EVEJS_E2E_TREE runs the checkout's own code against that tree", () => {
  assert.deepStrictEqual(plan(["status"], { env: { EVEJS_E2E_TREE: TREE } }), { kind: "local", argv: ["status"] });
});

test("a vendored copy runs its own tree and refuses another", () => {
  const ownRoot = path.join(TREE, "tools", "evejs-e2e");
  const files = [...treeFiles, COPY_CLI, path.join(ownRoot, "VENDOR.json")];
  assert.deepStrictEqual(plan(["status", "--tree", TREE], { files, ownRoot }), { kind: "local", argv: ["status"] });
  const other = plan(["status", "--tree", CHECKOUT], { files: [...files, CHECKOUT], ownRoot });
  assert.strictEqual(other.kind, "error");
  assert.match(other.message, /this copy belongs to/);
});

test("the checkout's CLI runs a tree's copy, with the exit code passed back", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("server/package.json", "{}");
  write("server/src/index.js", "");
  write("tools/evejs-e2e/bin/e2e.js", "console.log(`copy ${process.argv.slice(2).join(' ')}`); process.exitCode = 3;\n");
  const env = { ...process.env, EVEJS_E2E_TREE: "" };
  const named = spawnSync(process.execPath, [CLI, "--tree", root, "grid", "--all"], { encoding: "utf8", env });
  assert.strictEqual(named.stdout.trim(), "copy grid --all");
  assert.strictEqual(named.status, 3);
  const inside = spawnSync(process.execPath, [CLI, "status"], { encoding: "utf8", env, cwd: path.join(root, "server") });
  assert.strictEqual(inside.stdout.trim(), "copy status");
});
