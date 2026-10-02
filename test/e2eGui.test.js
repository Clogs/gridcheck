"use strict";

// `e2e gui` (core/gui.js): the trees it offers, the runs it shows, and the
// preview-then-run rule for every write, against scratch trees and a fake
// command runner, so no EveJS tree or CLI child process is needed. The last
// test goes through HTTP for the token and the page policy.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const gui = require("../core/gui");

function write(root, file, text) {
  const full = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const HELP = [
  "node tools/evejs-e2e/bin/e2e.js <command>",
  "  e2e init [--mode auto|attach|managed] [--force] [--dry-run]",
  "  e2e agents [status] [--json] | agents setup [claude] [codex] [--dry-run]",
  "  e2e vendor update [--from <checkout|tag>] [--tree <path>] [--force] [--dry-run] | vendor check [--tree <path>]",
  "  e2e patch list | patch status [<id>] [--json] | patch apply|revert <id>... [--dry-run]",
].join("\n");

// A runner that records each command and answers help, dry runs and runs.
function fakeRun({ help = HELP, exitCode = 0 } = {}) {
  const calls = [];
  const run = async (step) => {
    calls.push(step.args.slice(1));
    if (step.args[1] === "help") return { exitCode: 0, output: help, ms: 1 };
    return { exitCode, output: `${step.args.includes("--dry-run") ? "would" : "did"} ${step.args.slice(1).join(" ")}\n`, ms: 1 };
  };
  return { run, calls };
}

// <dir>/evejs-e2e (the checkout), <dir>/tree (an EveJS tree with a copy and a
// run), <dir>/other (another tree), <dir>/notatree.
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, "evejs-e2e");
  fs.mkdirSync(checkout);
  const tree = path.join(dir, "tree");
  write(tree, "server/src/server.js", "// a tree\n");
  write(tree, "tools/evejs-e2e/bin/e2e.js", "// the vendored CLI\n");
  write(tree, "tools/evejs-e2e/VENDOR.json", JSON.stringify({ name: "evejs-e2e", version: "9.9.9", commit: "c0ffee", files: {} }));
  const run = path.join(tree, "_local", "e2e", "runs", "20261001-120000-demo");
  write(run, "timeline.jsonl", `${JSON.stringify({ kind: "START", atMs: 1 })}\n`);
  write(run, "result.json", JSON.stringify({ name: "demo", passed: true, exitCode: 0, missing: 0, expectations: [1, 2] }));
  write(run, "report.md", "# Scenario demo: PASSED\n\n![Stop frame](frames/01-stop.svg)\n");
  write(run, "frames/01-stop.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  write(run, "secret.txt", "not served\n");
  const other = path.join(dir, "other");
  write(other, "server/src/server.js", "// another tree\n");
  fs.mkdirSync(path.join(dir, "notatree"));
  const context = { mode: "checkout", version: "1.0.0", commit: "c0ffee", checkout, tree: null };
  return { dir, checkout, tree, other, run, context, stateFile: path.join(checkout, "_local", "gui.json") };
}

const body = (result) => result.body;

test("from a checkout it offers trees beside it, adds a typed one and remembers it; a vendored copy offers its own", async (t) => {
  const s = setup(t);
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fakeRun().run });
  const listed = body(await app.handle("GET", "/gui/api/trees")).trees;
  assert.deepStrictEqual(listed.map((tree) => [tree.name, tree.source, Boolean(tree.copy)]).sort(),
    [["other", "nearby", false], ["tree", "nearby", true]]);
  assert.strictEqual(listed.find((tree) => tree.name === "tree").copy.version, "9.9.9");

  const elsewhere = path.join(os.tmpdir(), `e2e-gui-far-${process.pid}`);
  write(elsewhere, "server/src/x.js", "\n");
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const added = await app.handle("POST", "/gui/api/trees", {}, { path: elsewhere });
  assert.strictEqual(added.statusCode, 200);
  assert.strictEqual(added.body.tree.source, "added");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.stateFile, "utf8")).trees, [path.resolve(elsewhere)]);

  for (const [text, error] of [[path.join(s.dir, "notatree"), /not an EveJS tree/], [path.join(s.dir, "nowhere"), /doesn't exist/],
    ["", /type the path/], [s.checkout, /not an EveJS tree|this evejs-e2e checkout/]]) {
    const refused = await app.handle("POST", "/gui/api/trees", {}, { path: text });
    assert.strictEqual(refused.statusCode, 400, text);
    assert.match(refused.body.error, error);
  }
  const forgot = await app.handle("POST", "/gui/api/trees/forget", {}, { tree: added.body.tree.id });
  assert.strictEqual(forgot.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.stateFile, "utf8")).trees, []);

  const own = gui.createGui({ context: { mode: "vendored", version: "9.9.9", commit: "c0ffee", checkout: null, tree: s.tree }, run: fakeRun().run });
  assert.deepStrictEqual(body(await own.handle("GET", "/gui/api/trees")).trees.map((tree) => tree.root), [s.tree.split(path.sep).join("/")]);
  assert.match((await own.handle("POST", "/gui/api/trees", {}, { path: s.other })).body.error, /manages its own tree only/);
});

test("a tree's summary names the copy, the shim, the config and what the tree still needs", async (t) => {
  const s = setup(t);
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fakeRun().run });
  const id = gui.treeID(s.tree);
  const tree = body(await app.handle("GET", "/gui/api/tree", { tree: id })).tree;
  assert.strictEqual(tree.copy.present, true);
  assert.strictEqual(tree.copy.version, "9.9.9");
  assert.strictEqual(tree.copy.upToDate, true, "same commit as the checkout");
  assert.strictEqual(tree.copy.ok, false, "the fake copy's files aren't in its manifest");
  assert.strictEqual(tree.shim, "missing");
  assert.strictEqual(tree.config.exists, false);
  assert.strictEqual(tree.serverUp, null);
  assert.deepStrictEqual(tree.prerequisites.map((row) => [row.name, row.ok]), [["reference data", false]]);
  assert.strictEqual((await app.handle("GET", "/gui/api/tree", { tree: "nope" })).statusCode, 404);
});

test("runs: the list with verdicts, a run's report and frames, and nothing outside the run's folder", async (t) => {
  const s = setup(t);
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fakeRun().run });
  const id = gui.treeID(s.tree);
  const runs = body(await app.handle("GET", "/gui/api/runs", { tree: id })).runs;
  assert.deepStrictEqual(runs.map((run) => [run.runID, run.result.passed, run.result.expectations]), [["20261001-120000-demo", true, 2]]);
  const detail = body(await app.handle("GET", "/gui/api/run", { tree: id, run: "20261001-120000-demo" }));
  assert.match(detail.report, /^# Scenario demo: PASSED/);
  assert.deepStrictEqual(detail.frames, ["01-stop.svg"]);
  assert.strictEqual(detail.hasTimeline, true);
  const frame = await app.handle("GET", "/gui/api/frame", { tree: id, run: "20261001-120000-demo", file: "01-stop.svg" });
  assert.strictEqual(frame.raw.contentType, "image/svg+xml");
  for (const query of [{ run: "..", file: "01-stop.svg" }, { run: "20261001-120000-demo", file: "../secret.txt" },
    { run: "20261001-120000-demo", file: "secret.txt" }, { run: "20261001-120000-demo", file: "..\\result.json" }]) {
    const refused = await app.handle("GET", "/gui/api/frame", { tree: id, ...query });
    assert.ok(refused.statusCode >= 400, JSON.stringify(query));
  }
  assert.strictEqual((await app.handle("GET", "/gui/api/run", { tree: id, run: "../tree" })).statusCode, 404);
  const timeline = body(await app.handle("GET", "/viewer/timeline", { tree: id, run: "20261001-120000-demo", from: 0 }));
  assert.match(timeline.text, /"START"/);
});

test("a write is previewed with --dry-run and then runs exactly that command once, by the preview's ID", async (t) => {
  const s = setup(t);
  const fake = fakeRun();
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fake.run });
  const id = gui.treeID(s.tree);
  const previewed = body(await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "patch-apply", id: "xmpp-port" })).preview;
  assert.strictEqual(previewed.ok, true);
  assert.deepStrictEqual(previewed.refused, []);
  assert.strictEqual(previewed.steps[0].command, "node tools/evejs-e2e/bin/e2e.js patch apply xmpp-port");
  assert.match(previewed.steps[0].output, /^would patch apply xmpp-port --dry-run/);
  assert.deepStrictEqual(fake.calls, [["help"], ["patch", "apply", "xmpp-port", "--dry-run"]]);

  const ran = body(await app.handle("POST", "/gui/api/run", {}, { previewID: previewed.previewID })).result;
  assert.strictEqual(ran.ok, true);
  assert.deepStrictEqual(fake.calls.at(-1), ["patch", "apply", "xmpp-port"]);
  const again = await app.handle("POST", "/gui/api/run", {}, { previewID: previewed.previewID });
  assert.strictEqual(again.statusCode, 409, "a preview runs once");

  const vendorPreview = body(await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "vendor", force: true })).preview;
  assert.deepStrictEqual(fake.calls.at(-1).slice(0, 4), ["vendor", "update", "--from", s.checkout]);
  assert.deepStrictEqual(fake.calls.at(-1).slice(-3), [s.tree, "--force", "--dry-run"]);
  assert.strictEqual(vendorPreview.ok, true);

  for (const bad of [{ action: "patch-apply", id: "../x" }, { action: "init", mode: "sideways" }, { action: "rm" }]) {
    const refused = await app.handle("POST", "/gui/api/preview", {}, { tree: id, ...bad });
    assert.strictEqual(refused.statusCode, 400, JSON.stringify(bad));
  }
  const noCopy = await app.handle("POST", "/gui/api/preview", {}, { tree: gui.treeID(s.other), action: "init", mode: "managed" });
  assert.match(noCopy.body.error, /no vendored copy yet/);
});

test("agent setup is previewed like any change, may run while the server is up, and names the agents ticked", async (t) => {
  const s = setup(t);
  const fake = fakeRun();
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fake.run });
  const id = gui.treeID(s.tree);
  const summary = body(await app.handle("GET", "/gui/api/tree", { tree: id })).tree;
  assert.deepStrictEqual(summary.agents.map((row) => row.id), ["claude", "codex"]);
  assert.ok(summary.agents.every((row) => typeof row.installed === "boolean" && Array.isArray(row.evidence)), JSON.stringify(summary.agents));

  write(s.tree, "_local/agentBridge/bridge.json", JSON.stringify({ port: 1, token: "t", pid: process.pid }));
  const previewed = body(await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "agents", agents: ["codex", "claude", "codex"] })).preview;
  assert.strictEqual(previewed.ok, true, JSON.stringify(previewed));
  assert.deepStrictEqual(previewed.refused, [], "a running server doesn't block it");
  assert.deepStrictEqual(fake.calls.at(-1), ["agents", "setup", "codex", "claude", "--dry-run"]);
  const ran = body(await app.handle("POST", "/gui/api/run", {}, { previewID: previewed.previewID })).result;
  assert.strictEqual(ran.ok, true);
  assert.deepStrictEqual(fake.calls.at(-1), ["agents", "setup", "codex", "claude"]);
  const patch = body(await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "patch-apply", id: "xmpp-port" })).preview;
  assert.match(patch.refused[0], /server is up/, "other changes still wait for it");

  for (const [agents, error] of [[[], /pick an agent/], [["cursor"], /no agent cursor/], [undefined, /pick an agent/]]) {
    const refused = await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "agents", agents });
    assert.strictEqual(refused.statusCode, 400);
    assert.match(refused.body.error, error);
  }
  assert.match((await app.handle("POST", "/gui/api/preview", {}, { tree: gui.treeID(s.other), action: "agents", agents: ["claude"] })).body.error,
    /no vendored copy yet/);
});

test("the config is written in auto mode unless another is picked", async (t) => {
  const s = setup(t);
  const fake = fakeRun();
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fake.run });
  const previewed = body(await app.handle("POST", "/gui/api/preview", {}, { tree: gui.treeID(s.tree), action: "init" })).preview;
  assert.strictEqual(previewed.ok, true);
  assert.deepStrictEqual(fake.calls.at(-1), ["init", "--mode", "auto", "--dry-run"]);
});

test("a copy whose command has no --dry-run isn't previewed at all, so an old copy can't make the change", async (t) => {
  const s = setup(t);
  const fake = fakeRun({ help: HELP.replace("[--force] [--dry-run]\n", "[--force]\n") });
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fake.run });
  const previewed = body(await app.handle("POST", "/gui/api/preview", {}, { tree: gui.treeID(s.tree), action: "init", mode: "managed" })).preview;
  assert.strictEqual(previewed.ok, false);
  assert.strictEqual(previewed.previewID, null);
  assert.match(previewed.refused[0], /has no --dry-run in this copy/);
  assert.deepStrictEqual(fake.calls, [["help"]], "only help ran");
});

test("a failed dry run, a running server or uncommitted changes to the targets refuse the change", async (t) => {
  const s = setup(t);
  const id = gui.treeID(s.tree);
  const failing = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fakeRun({ exitCode: 1 }).run });
  const failed = body(await failing.handle("POST", "/gui/api/preview", {}, { tree: id, action: "patch-revert", id: "xmpp-port" })).preview;
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.previewID, null);

  const fake = fakeRun();
  const app = gui.createGui({ context: s.context, stateFile: s.stateFile, run: fake.run });
  const ok = body(await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "patch-apply", id: "xmpp-port" })).preview;
  assert.strictEqual(ok.ok, true);
  // The server comes up between the preview and the run.
  write(s.tree, "_local/agentBridge/bridge.json", JSON.stringify({ port: 1, token: "t", pid: process.pid }));
  const ran = body(await app.handle("POST", "/gui/api/run", {}, { previewID: ok.previewID })).result;
  assert.strictEqual(ran.ok, false);
  assert.match(ran.refused[0], /server is up/);
  assert.notDeepStrictEqual(fake.calls.at(-1), ["patch", "apply", "xmpp-port"], "nothing ran");
  const up = body(await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "patch-apply", id: "xmpp-port" })).preview;
  assert.strictEqual(up.ok, false);
  assert.match(up.refused[0], /server is up/);
  fs.rmSync(path.join(s.tree, "_local", "agentBridge"), { recursive: true });

  git(s.tree, "init", "-q");
  write(s.tree, "e2e.config.json", "{}\n");
  git(s.tree, "add", "-A");
  git(s.tree, "commit", "-q", "-m", "tree");
  fs.writeFileSync(path.join(s.tree, "e2e.config.json"), "{ \"edited\": true }\n");
  const dirty = body(await app.handle("POST", "/gui/api/preview", {}, { tree: id, action: "init", mode: "managed" })).preview;
  assert.strictEqual(dirty.ok, false);
  assert.match(dirty.refused.join("\n"), /uncommitted changes in e2e\.config\.json/);
  assert.deepStrictEqual(fake.calls.at(-1).slice(0, 4), ["init", "--mode", "managed", "--force"], "an existing config is replaced with --force");
});

test("the page needs no token and carries no data; every data route needs it", async () => {
  let checked = false;
  const lines = [];
  const code = await gui.main(["--port", "0"], {
    stdout: { write: (text) => lines.push(text) },
    stderr: { write: (text) => lines.push(text) },
    waitForStop: async () => {
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/gui#token=([0-9a-f]{64})/.exec(lines.join(""));
      assert.ok(match, lines.join(""));
      const [, base, token] = match;
      const page = await fetch(`${base}/gui`);
      assert.strictEqual(page.status, 200);
      assert.match(page.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/);
      assert.strictEqual(page.headers.get("x-frame-options"), "DENY");
      assert.strictEqual((await fetch(`${base}/viewer`)).status, 200);
      for (const script of ["/gui/gui.js", "/gui/runs.js", "/gui/replay.js"]) {
        const served = await fetch(`${base}${script}`);
        assert.strictEqual(served.status, 200, script);
        assert.match(served.headers.get("content-type"), /^text\/javascript/, script);
      }
      assert.strictEqual((await fetch(`${base}/gui/api/trees`)).status, 401);
      assert.strictEqual((await fetch(`${base}/gui/api/trees`, { headers: { authorization: "Bearer nope" } })).status, 401);
      const context = await fetch(`${base}/gui/api/context`, { headers: { authorization: `Bearer ${token}` } });
      assert.strictEqual(context.status, 200);
      checked = true;
    },
  });
  assert.strictEqual(code, 0);
  assert.ok(checked);
  assert.deepStrictEqual(gui.parseGuiArgs(["--port", "5", "--tree", "x", "--open"]), { port: 5, trees: [path.resolve("x")], open: true });
  assert.throws(() => gui.parseGuiArgs(["--port", "nope"]), /--port takes a port number/);
  assert.throws(() => gui.parseGuiArgs(["--bogus"]), /unknown argument/);
});
