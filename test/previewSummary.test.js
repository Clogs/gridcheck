"use strict";

// core/previewSummary.js: the preview dialog's cards come from the dry-run
// text the tree's copy prints. The vendor case reads real dry-run output from
// this checkout; the others use the lines bin/gridcheck.js prints.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { summarizePreview } = require("../core/previewSummary");
const vendor = require("../core/vendor");

const ROOT = path.join(os.tmpdir(), "tree");
const only = (...present) => (full) => present.some((file) => path.resolve(ROOT, file) === full);

test("agent setup: a new .mcp.json, an existing file outside the tree, an agent already set up, and what to do next", () => {
  const output = [
    "Claude Code: would add server gridcheck to .mcp.json",
    "  +   \"gridcheck\": {",
    "  +     \"type\": \"stdio\"",
    "  +   }",
    "Codex: would replace server gridcheck in C:/Users/me/.codex/config.toml; its old entry ran F:/old/mcp.js, which is gone",
    "  - [mcp_servers.gridcheck]",
    "  + [mcp_servers.gridcheck]",
    "CLI only: would add a pointer to docs/CLI.md in AGENTS.md",
    "  + See docs/CLI.md",
    "nothing was written (--dry-run)",
    "next, Claude Code: start it in this tree's folder; it asks once to approve the project's MCP server",
  ].join("\n");
  const summary = summarizePreview("agents", ROOT, [{ output }], { exists: only("AGENTS.md", "C:/Users/me/.codex/config.toml") });
  const [claude, codex, cli] = summary.changes;
  assert.deepStrictEqual([claude.path, claude.outside, claude.exists, claude.change, claude.entry], [".mcp.json", false, false, "add", "gridcheck"]);
  assert.deepStrictEqual(claude.added, ["  \"gridcheck\": {", "    \"type\": \"stdio\"", "  }"], "the entry's own indentation is kept");
  assert.deepStrictEqual([codex.outside, codex.exists, codex.change, codex.gone], [true, true, "replace", "F:/old/mcp.js"]);
  assert.deepStrictEqual([codex.removed, codex.added], [["[mcp_servers.gridcheck]"], ["[mcp_servers.gridcheck]"]]);
  assert.deepStrictEqual([cli.agent, cli.path, cli.exists, cli.entry], ["CLI only", "AGENTS.md", true, "a pointer to docs/CLI.md"]);
  assert.deepStrictEqual(summary.next, [{ who: "Claude Code", text: "start it in this tree's folder; it asks once to approve the project's MCP server" }]);

  const same = summarizePreview("agents", ROOT, [{ output: "Claude Code: already runs this tree's server as gridcheck (.mcp.json)\nnothing to write" }],
    { exists: () => true });
  assert.deepStrictEqual(same.changes.map((row) => [row.path, row.change, row.entry]), [[".mcp.json", "none", "gridcheck"]]);
});

test("vendor: a first install only adds files, an update says which existing files change", (t) => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "preview-summary-"));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tree, "server", "src"), { recursive: true });
  const from = path.join(__dirname, "..");
  const dryRun = () => vendor.runVendor("update", { tree, from, dryRun: true }).join("\n");

  const fresh = summarizePreview("vendor", tree, [{ output: dryRun() }]);
  const [folder, shim] = fresh.changes;
  assert.strictEqual(folder.path, "tools/gridcheck");
  assert.strictEqual(folder.exists, false);
  assert.ok(folder.counts.added > 0 && folder.counts.added === folder.files, JSON.stringify(folder.counts));
  assert.deepStrictEqual([folder.counts.changed, folder.counts.removed, folder.changed.length], [0, 0, 0]);
  assert.strictEqual(folder.added.length + folder.more.added, folder.counts.added, "listed plus 'and N more' is the whole count");
  assert.deepStrictEqual([shim.path, shim.exists, shim.change], ["server/src/_secondary/agentBridge/server.js", false, "add"]);
  assert.match(fresh.source.version, /^\d/);

  vendor.runVendor("update", { tree, from });
  // A drifted copy needs --force, which the GUI's Install tab offers.
  fs.writeFileSync(path.join(tree, "tools", "gridcheck", "package.json"), "{}\n");
  fs.writeFileSync(path.join(tree, "tools", "gridcheck", "gone.js"), "\n");
  const again = summarizePreview("vendor", tree, [{ output: vendor.runVendor("update", { tree, from, force: true, dryRun: true }).join("\n") }]);
  const [copy, sameShim] = again.changes;
  assert.strictEqual(copy.exists, true);
  assert.deepStrictEqual([copy.changed, copy.removed, copy.counts.added], [["package.json"], ["gone.js"], 0]);
  assert.deepStrictEqual([sameShim.exists, sameShim.change], [true, "none"]);
});

test("patches: each target with the lines it inserts, and what would refuse it", () => {
  const output = [
    "would apply xmpp-port in edge/chat/chatEdgeRuntime.js",
    "  edge/chat/chatEdgeRuntime.js:42 inserts 2 lines before \"const port = 5222;\" (CRLF)",
    "    + // gridcheck: xmpp-port",
    "    + ",
    "note: this tree isn't a git checkout, so uncommitted changes to the targets weren't checked",
    "refused when run: the tree's server is up (pid 7). Stop it first (gridcheck down)",
  ].join("\n");
  const srcDir = path.join(ROOT, "server", "src");
  const summary = summarizePreview("patch-apply", ROOT, [{ output }], { srcDir, exists: () => true });
  assert.strictEqual(summary.changes.length, 1);
  const [file] = summary.changes;
  assert.deepStrictEqual([file.path, file.change], ["server/src/edge/chat/chatEdgeRuntime.js", "replace"]);
  assert.deepStrictEqual(file.hunks, [{ line: 42, removes: false, where: "before", near: "const port = 5222;", eol: "CRLF",
    lines: ["// gridcheck: xmpp-port", ""] }]);
  assert.match(summary.notes[0], /isn't a git checkout/);
  assert.deepStrictEqual(summary.refusedWhenRun, ["the tree's server is up (pid 7). Stop it first (gridcheck down)"]);
});

test("init: the file it would write, new or replacing one", () => {
  const output = ["would write gridcheck.config.json, mode auto", "  server     F:/t/server: npm start",
    "nothing was written (--dry-run). The file would be:", "{", "  \"mode\": \"auto\"", "}", ""].join("\n");
  const [fresh] = summarizePreview("init", ROOT, [{ output }], { exists: () => false }).changes;
  assert.deepStrictEqual([fresh.path, fresh.change, fresh.mode, fresh.added], ["gridcheck.config.json", "add", "auto", ["{", "  \"mode\": \"auto\"", "}"]]);
  assert.strictEqual(summarizePreview("init", ROOT, [{ output }], { exists: () => true }).changes[0].change, "replace");
});

test("output it doesn't recognise gives no cards, so the dialog falls back to the raw output", () => {
  for (const action of ["agents", "vendor", "patch-apply", "init", "setup"]) {
    assert.deepStrictEqual(summarizePreview(action, ROOT, [{ output: "would do something else entirely\n" }]).changes, [], action);
  }
});
