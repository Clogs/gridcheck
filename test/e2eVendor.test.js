"use strict";

// e2e vendor update and check (core/vendor.js), against a throwaway source
// repo and a throwaway tree, so they need neither this checkout's state nor a
// real EveJS tree.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const vendor = require("../core/vendor");

const SHIM = '"use strict";\nmodule.exports = { serviceName: "agentBridge" };\n';
const CRLF = "line one\r\nline two\r\n";
const MIXED = "lf\ncrlf\r\nlf\n";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid",
    ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, file, text) {
  const full = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vendor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A source checkout with a CRLF file, a mixed one, tests and dotfiles, and a
// tree with only server/src.
function setup(t) {
  const dir = scratch(t);
  const source = path.join(dir, "evejs-e2e");
  fs.mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  write(source, "package.json", JSON.stringify({ name: "evejs-e2e", version: "1.2.3" }));
  write(source, "bridge/shim.js", SHIM);
  write(source, "bridge/entry.js", "module.exports = {};\n");
  write(source, "core/crlf.js", CRLF);
  write(source, "core/mixed.js", MIXED);
  write(source, "test/x.test.js", "// not vendored\n");
  write(source, ".gitattributes", "* -text\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "one");
  git(source, "tag", "v1");
  const tree = path.join(dir, "tree");
  fs.mkdirSync(path.join(tree, "server", "src"), { recursive: true });
  const target = path.join(tree, "tools", "evejs-e2e");
  return { dir, source, tree, target, shim: path.join(tree, ...vendor.SHIM_PATH.split(path.sep)) };
}

test("update copies a commit's files byte for byte, installs the shim and records every file", (t) => {
  const s = setup(t);
  const result = vendor.updateVendored({ tree: s.tree, from: s.source });
  assert.strictEqual(fs.readFileSync(path.join(s.target, "core", "crlf.js"), "latin1"), CRLF);
  assert.strictEqual(fs.readFileSync(path.join(s.target, "core", "mixed.js"), "latin1"), MIXED);
  assert.strictEqual(fs.readFileSync(s.shim, "utf8"), SHIM);
  assert.ok(!fs.existsSync(path.join(s.target, "test")), "tests stay in the repo");
  assert.ok(!fs.existsSync(path.join(s.target, ".gitattributes")), "dotfiles stay in the repo");
  const manifest = JSON.parse(fs.readFileSync(path.join(s.target, "VENDOR.json"), "utf8"));
  assert.strictEqual(manifest.version, "1.2.3");
  assert.strictEqual(manifest.commit, git(s.source, "rev-parse", "HEAD"));
  assert.deepStrictEqual(Object.keys(manifest.files), ["bridge/entry.js", "bridge/shim.js", "core/crlf.js", "core/mixed.js", "package.json"]);
  assert.strictEqual(manifest.shim.path, "server/src/_secondary/agentBridge/server.js");
  assert.deepStrictEqual(result.counts, { added: 5, changed: 0, removed: 0, same: 0 });
  assert.strictEqual(result.shim, "installed");
  assert.deepStrictEqual(vendor.checkVendored({ tree: s.tree }), { ok: true, manifest, problems: [] });
});

test("check names every edited, missing and added file, and an edited shim", (t) => {
  const s = setup(t);
  vendor.updateVendored({ tree: s.tree, from: s.source });
  // A CRLF -> LF rewrite is an edit too.
  fs.writeFileSync(path.join(s.target, "core", "crlf.js"), CRLF.replace(/\r\n/g, "\n"));
  fs.rmSync(path.join(s.target, "core", "mixed.js"));
  write(s.target, "core/extra.js", "x\n");
  fs.appendFileSync(s.shim, "// local\n");
  const result = vendor.checkVendored({ tree: s.tree });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.problems, [
    { file: "core/crlf.js", problem: "edited" },
    { file: "core/extra.js", problem: "added" },
    { file: "core/mixed.js", problem: "missing" },
    { file: "server/src/_secondary/agentBridge/server.js", problem: "shim edited" },
  ]);
});

test("update refuses a drifted copy or an unvendored folder unless forced, and then the check passes", (t) => {
  const s = setup(t);
  write(s.target, "bridge/entry.js", "// hand-made\n");
  assert.throws(() => vendor.updateVendored({ tree: s.tree, from: s.source }), /no VENDOR\.json.*--force/);
  vendor.updateVendored({ tree: s.tree, from: s.source, force: true });
  fs.writeFileSync(path.join(s.target, "bridge", "entry.js"), "// edited\n");
  assert.throws(() => vendor.updateVendored({ tree: s.tree, from: s.source }), /differs from its VENDOR\.json.*\n {2}edited +bridge\/entry\.js/s);
  assert.strictEqual(fs.readFileSync(path.join(s.target, "bridge", "entry.js"), "utf8"), "// edited\n", "a refusal changes nothing");
  const result = vendor.updateVendored({ tree: s.tree, from: s.source, force: true });
  assert.deepStrictEqual(result.counts, { added: 0, changed: 1, removed: 0, same: 4 });
  assert.strictEqual(vendor.checkVendored({ tree: s.tree }).ok, true);
});

test("update takes a commit, not the working files, and a removed file leaves the copy", (t) => {
  const s = setup(t);
  vendor.updateVendored({ tree: s.tree, from: s.source });
  fs.rmSync(path.join(s.source, "core", "mixed.js"));
  git(s.source, "commit", "-q", "-am", "two");
  write(s.source, "core/crlf.js", "uncommitted\n");
  const result = vendor.updateVendored({ tree: s.tree, from: s.source });
  assert.strictEqual(result.dirty, true);
  assert.deepStrictEqual(result.counts, { added: 0, changed: 0, removed: 1, same: 4 });
  assert.strictEqual(fs.readFileSync(path.join(s.target, "core", "crlf.js"), "latin1"), CRLF, "uncommitted work isn't vendored");
  assert.ok(!fs.existsSync(path.join(s.target, "core", "mixed.js")));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(s.target)), ["evejs-e2e"], "no staging folders are left");
});

test("a tag is read from the checkout the tool runs from; anything else that isn't a checkout is refused", (t) => {
  const s = setup(t);
  assert.throws(() => vendor.updateVendored({ tree: s.tree, from: path.join(s.source, "core") }), /not the root of an evejs-e2e checkout/);
  assert.throws(() => vendor.updateVendored({ tree: s.tree, from: s.dir }), /not a git checkout/);
  assert.throws(() => vendor.updateVendored({ tree: path.join(s.dir, "nowhere"), from: s.source }), /not an EveJS tree/);
  assert.throws(() => vendor.updateVendored({ tree: s.tree, from: "no-such-ref-here" }), /no commit "no-such-ref-here"/);
  // This repo vendors from its own HEAD: the files are what git has, test/ left out.
  const own = vendor.readSource({});
  assert.ok(own.files.has("core/vendor.js") && own.files.has("bridge/shim.js"));
  assert.ok(![...own.files.keys()].some((file) => file.startsWith("test/") || file.startsWith(".")));
});

test("the installed shim loads the vendored bridge from where the stock loader finds it", (t) => {
  const s = setup(t);
  const real = path.resolve(__dirname, "..");
  // The real shim and an entry.js that reports the server root it was given.
  write(s.source, "bridge/shim.js", fs.readFileSync(path.join(real, "bridge", "shim.js"), "utf8"));
  write(s.source, "bridge/entry.js", "exports.createService = ({ serverRoot }) => ({ serviceName: 'agentBridge', serverRoot });\n");
  git(s.source, "commit", "-q", "-am", "real shim");
  vendor.updateVendored({ tree: s.tree, from: s.source });
  const service = require(s.shim);
  assert.strictEqual(service.serviceName, "agentBridge");
  assert.strictEqual(service.serverRoot, path.join(s.tree, "server"));
});

test("vendor check runs from a copy whose other files no longer load, and names them", (t) => {
  const dir = scratch(t);
  const tree = path.join(dir, "tree");
  fs.mkdirSync(path.join(tree, "server", "src"), { recursive: true });
  // This repo's own HEAD, so the real bin/e2e.js runs: commit a change to
  // bin/e2e.js or core/vendor.js before this tests it.
  vendor.updateVendored({ tree });
  const bin = path.join(tree, "tools", "evejs-e2e", "bin", "e2e.js");
  const run = (...args) => spawnSync(process.execPath, [bin, "vendor", ...args], { encoding: "utf8", windowsHide: true,
    env: { ...process.env, EVEJS_E2E_TREE: "" } });
  assert.strictEqual(run("check").status, 0);
  fs.appendFileSync(path.join(tree, "tools", "evejs-e2e", "core", "plugins.js"), "this is not javascript (\n");
  const broken = run("check");
  assert.strictEqual(broken.status, 1);
  assert.match(broken.stderr, /edited +core\/plugins\.js/);
  assert.doesNotMatch(broken.stderr, /SyntaxError/);
  assert.strictEqual(run("check", "--bogus").status, 1);
});

test("vendor arguments: an action, --tree and --from take values, --force doesn't", () => {
  assert.deepStrictEqual(vendor.parseVendorArgs(["update", "--from", "v1", "--tree", "x", "--force"]),
    { action: "update", from: "v1", tree: "x", force: true });
  assert.throws(() => vendor.parseVendorArgs(["check", "--tree"]), /--tree needs a value/);
  assert.throws(() => vendor.parseVendorArgs(["check", "extra"]), /unknown argument extra/);
  assert.throws(() => vendor.runVendor("nope"), /usage: e2e vendor/);
});
