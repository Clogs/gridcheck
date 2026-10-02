"use strict";

// The patch engine (core/patches.js): anchored insertions that keep a file's
// line endings, refusals that write nothing, and a revert that gives the file
// back byte for byte or refuses. The last test runs each shipped patch against
// a copy of a real tree's files (npm run compat names one).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PatchError, changePatch, createReader, loadPatches, normalizePatch, patchState, planApply, planRevert, splitLines,
} = require("../core/patches");
const { NO_TREE, REAL_TREE, SERVER_ROOT } = require("./tree");

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-patches-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function tree(t, files) {
  const root = scratch(t);
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, "server", "src", ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return { treeRoot: root, serverRoot: path.join(root, "server") };
}

function bytes(root, file) {
  return fs.readFileSync(path.join(root.serverRoot, "src", ...file.split("/")));
}

const NO_GIT = () => ({ git: false });

// CRLF and LF lines in one file, and no line ending on the last line.
const MIXED = "\"use strict\";\r\n\r\nfunction run(options = {}) {\n  const port = 1;\r\n  return port;\n}\r\nmodule.exports = { run };";

const DEMO = normalizePatch({
  id: "demo",
  version: 2,
  title: "a demo",
  hunks: [
    { file: "a.js", anchor: ["const port = 1;"], insert: "after", lines: ["  if (options.port) return options.port;"] },
    { file: "a.js", anchor: ["function run(options = {}) {"], insert: "before", lines: ["// runs it"] },
  ],
  detect: ({ read }) => read("a.js").includes("options.port"),
});

test("lines split with their own endings and join back exactly", () => {
  const lines = splitLines(MIXED);
  assert.deepEqual(lines.map((line) => line.eol), ["\r\n", "\r\n", "\n", "\r\n", "\n", "\r\n", ""]);
  assert.equal(lines.map((line) => line.text + line.eol).join(""), MIXED);
});

test("apply inserts each hunk with its anchor line's ending, and revert gives the bytes back", (t) => {
  const root = tree(t, { "a.js": MIXED });
  const before = bytes(root, "a.js");
  const applied = changePatch("apply", "demo", { ...root, patches: [DEMO], dirtyCheck: NO_GIT });
  assert.deepEqual(applied.files, ["a.js"]);
  assert.ok(applied.notes.some((note) => /isn't a git checkout/.test(note)));
  const text = bytes(root, "a.js").toString("utf8");
  assert.ok(text.includes("  const port = 1;\r\n  // gridcheck:patch demo v2\r\n  if (options.port) return options.port;\r\n  return port;\n"), text);
  assert.ok(text.includes("\r\n// gridcheck:patch demo v2\n// runs it\nfunction run(options = {}) {\n"), text);
  assert.equal(patchState(DEMO, createReader(root.serverRoot)).state, "applied");
  assert.equal(patchState(DEMO, createReader(root.serverRoot)).version, 2);

  changePatch("revert", "demo", { ...root, patches: [DEMO] });
  assert.ok(bytes(root, "a.js").equals(before), "revert restores every byte, line endings included");
});

test("a patch applied before the rename, with evejs-e2e markers, reads as applied and reverts byte for byte", (t) => {
  const root = tree(t, { "a.js": MIXED });
  const before = bytes(root, "a.js");
  changePatch("apply", "demo", { ...root, patches: [DEMO], dirtyCheck: NO_GIT });
  const file = path.join(root.serverRoot, "src", "a.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("gridcheck:patch").join("evejs-e2e:patch"));
  assert.equal(patchState(DEMO, createReader(root.serverRoot)).state, "applied");
  assert.match(planApply(DEMO, createReader(root.serverRoot)).problems.join("\n"), /already has this patch's marker/);
  changePatch("revert", "demo", { ...root, patches: [DEMO], dirtyCheck: NO_GIT });
  assert.ok(bytes(root, "a.js").equals(before), "the old markers come out too");
});

test("a missing or repeated anchor refuses the whole patch and writes nothing", (t) => {
  const root = tree(t, { "a.js": MIXED, "b.js": "x\nx\n" });
  const before = bytes(root, "a.js");
  const patch = normalizePatch({ id: "two", version: 1, hunks: [
    { file: "a.js", anchor: ["const port = 1;"], insert: "after", lines: ["  // ok"] },
    { file: "b.js", anchor: ["x"], insert: "after", lines: ["y"] },
    { file: "a.js", anchor: ["not in the file"], insert: "before", lines: ["z"] },
  ] });
  assert.throws(() => changePatch("apply", "two", { ...root, patches: [patch], dirtyCheck: NO_GIT }),
    (error) => error instanceof PatchError && /b\.js: anchor "x" occurs 2 times/.test(error.message) &&
      /a\.js: anchor "not in the file" is missing/.test(error.message));
  assert.ok(bytes(root, "a.js").equals(before));
  const state = patchState(patch, createReader(root.serverRoot));
  assert.equal(state.state, "absent");
  assert.equal(state.applies, false);
});

test("apply refuses an applied, partly applied or equivalent patch, a running server and a dirty target", (t) => {
  const root = tree(t, { "a.js": MIXED });
  const options = { ...root, patches: [DEMO], dirtyCheck: NO_GIT };
  assert.throws(() => changePatch("apply", "demo", { ...options, serverUp: "this tree's server is up (pid 7)" }),
    /apply demo refused: this tree's server is up \(pid 7\)/);
  assert.throws(() => changePatch("apply", "demo", { ...options, dirtyCheck: () => ({ git: true, dirty: ["server/src/a.js"] }) }),
    /uncommitted changes in server\/src\/a\.js/);
  assert.equal(bytes(root, "a.js").toString("utf8"), MIXED, "a refusal writes nothing");

  const dryRun = changePatch("apply", "demo", { ...options, serverUp: "up", dryRun: true,
    dirtyCheck: () => ({ git: true, dirty: ["server/src/a.js"] }) });
  assert.equal(dryRun.dryRun, true, "a dry run previews even with the server up");
  assert.ok(dryRun.preview.some((line) => /a\.js:5 inserts 2 lines before "return port;" \(CRLF\)/.test(line)), dryRun.preview.join("\n"));
  assert.deepEqual(dryRun.blockers, ["up. Stop it first (gridcheck down)", "uncommitted changes in server/src/a.js. Commit or discard them first"],
    "and says what would refuse the real change");
  assert.equal(bytes(root, "a.js").toString("utf8"), MIXED, "a dry run writes nothing");

  changePatch("apply", "demo", options);
  assert.throws(() => changePatch("apply", "demo", options), /already applied \(v2\)/);

  const equivalent = tree(t, { "a.js": MIXED.replace("const port = 1;", "const port = options.port || 1;") });
  assert.throws(() => changePatch("apply", "demo", { ...equivalent, patches: [DEMO], dirtyCheck: NO_GIT }),
    /already has equivalent code/);
  assert.equal(patchState(DEMO, createReader(equivalent.serverRoot)).state, "detected");

  const partial = tree(t, { "a.js": MIXED.replace("function run", "// gridcheck:patch demo v2\n// runs it\nfunction run") });
  assert.equal(patchState(DEMO, createReader(partial.serverRoot)).state, "partial");
  assert.throws(() => changePatch("apply", "demo", { ...partial, patches: [DEMO], dirtyCheck: NO_GIT }), /partly applied/);
});

test("revert refuses when an inserted line was edited, or the patch version moved on", (t) => {
  const root = tree(t, { "a.js": MIXED });
  changePatch("apply", "demo", { ...root, patches: [DEMO], dirtyCheck: NO_GIT });
  const file = path.join(root.serverRoot, "src", "a.js");
  const applied = fs.readFileSync(file, "utf8");

  fs.writeFileSync(file, applied.replace("return options.port;", "return Number(options.port);"));
  assert.throws(() => changePatch("revert", "demo", { ...root, patches: [DEMO] }), /1 of 2 inserted blocks were edited or moved/);

  fs.writeFileSync(file, applied);
  const newer = normalizePatch({ ...DEMO, version: 3 });
  assert.throws(() => changePatch("revert", "demo", { ...root, patches: [newer] }), /applied at v2, and this copy has v3/);

  // An edit elsewhere in the file survives a revert.
  fs.writeFileSync(file, applied.replace("module.exports = { run };", "module.exports = { run, extra: 1 };"));
  changePatch("revert", "demo", { ...root, patches: [DEMO] });
  assert.equal(fs.readFileSync(file, "utf8"), MIXED.replace("module.exports = { run };", "module.exports = { run, extra: 1 };"));
});

test("a file that isn't UTF-8 is refused rather than rewritten", (t) => {
  const root = tree(t, {});
  const target = path.join(root.serverRoot, "src", "a.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat([Buffer.from("const port = 1;\n"), Buffer.from([0xff, 0xfe, 0x0a])]));
  const plan = planApply(DEMO, createReader(root.serverRoot));
  assert.equal(plan.ok, false);
  assert.match(plan.problems.join(";"), /not UTF-8/);
});

test("the shipped patches load with hunks and a check for equivalent code", () => {
  const patches = loadPatches();
  assert.deepEqual(patches.map((patch) => patch.id), ["last-decision", "slash-success", "xmpp-port"]);
  for (const patch of patches) {
    assert.ok(patch.hunks.length > 0, `${patch.id} has hunks`);
    assert.equal(typeof patch.detect, "function", `${patch.id} has detect`);
    for (const hunk of patch.hunks) {
      assert.ok(["before", "after"].includes(hunk.insert), `${patch.id}: ${hunk.file} insert`);
      assert.ok(hunk.anchor.length && hunk.lines.length, `${patch.id}: ${hunk.file} anchor and lines`);
    }
  }
});

// Each shipped patch against a copy of the tree's own target files: on stock
// EveJS it applies and reverts to the same bytes; on a tree with equivalent
// code (the LU fork) it reads as detected and apply refuses.
test("each shipped patch round-trips on a copy of the tree's files", REAL_TREE ? {} : { skip: NO_TREE }, (t) => {
  for (const patch of loadPatches()) {
    const copy = { treeRoot: scratch(t) };
    copy.serverRoot = path.join(copy.treeRoot, "server");
    for (const file of patch.files) {
      const target = path.join(copy.serverRoot, "src", ...file.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(SERVER_ROOT, "src", ...file.split("/")), target);
    }
    const state = patchState(patch, createReader(copy.serverRoot));
    if (state.state === "detected") {
      assert.throws(() => changePatch("apply", patch.id, { ...copy, dirtyCheck: NO_GIT }), /equivalent code/);
      continue;
    }
    assert.equal(state.state, "absent", `${patch.id}: ${JSON.stringify(state)}`);
    assert.equal(state.applies, true, `${patch.id}: ${JSON.stringify(state.problems)}`);
    const before = patch.files.map((file) => bytes(copy, file));
    changePatch("apply", patch.id, { ...copy, dirtyCheck: NO_GIT });
    assert.equal(patchState(patch, createReader(copy.serverRoot)).state, "applied", patch.id);
    for (const file of patch.files) {
      const text = bytes(copy, file).toString("utf8");
      // Every inserted line ends as the lines around it do.
      const lines = splitLines(text);
      lines.forEach((line, index) => {
        if (!line.text.includes("gridcheck:patch")) return;
        assert.equal(line.eol, lines[index + 1].eol, `${patch.id} ${file}:${index + 1}`);
      });
    }
    const plan = planRevert(patch, createReader(copy.serverRoot));
    assert.ok(plan.ok, plan.problems.join("; "));
    changePatch("revert", patch.id, { ...copy });
    patch.files.forEach((file, index) => assert.ok(bytes(copy, file).equals(before[index]), `${patch.id} ${file} byte-identical`));
  }
});
