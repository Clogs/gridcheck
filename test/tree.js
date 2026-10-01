"use strict";

// The tree a test process runs against, named by EVEJS_E2E_TREE, which also
// sets the tree the default registry loads plugins for (core/plugins.js).
// `npm test` names test/fixtures/tree: no EveJS code, only the files the lu
// plugin checks for, so the plugins' tool halves load and every test that
// reads one runs. The compatibility script (test/compat.js) names a real tree
// for the few tests that need its server modules.

const fs = require("node:fs");
const path = require("node:path");

const { defaultRegistry } = require("../core/plugins");

const FIXTURE_TREE = path.join(__dirname, "fixtures", "tree");
const TREE_ROOT = String(process.env.EVEJS_E2E_TREE || "").trim()
  ? path.resolve(process.env.EVEJS_E2E_TREE.trim())
  : null;
const SERVER_ROOT = TREE_ROOT ? path.join(TREE_ROOT, "server") : null;
// A real tree has a server; the fixture tree only has the plugin's stand-ins.
const REAL_TREE = Boolean(SERVER_ROOT && fs.existsSync(path.join(SERVER_ROOT, "src", "space", "runtime.js")));
const NO_TREE = "needs an EveJS tree's server modules: npm run compat runs it against one";

// A module under the tree's server/src. Call it inside a test that skips
// without a real tree.
function serverModule(relativePath) {
  if (!REAL_TREE) throw new Error(NO_TREE);
  return require(path.join(SERVER_ROOT, "src", relativePath));
}

function pluginSkip(name) {
  if (!TREE_ROOT) return `no tree named, so no plugin ${name} (npm test names the fixture tree)`;
  const skipped = defaultRegistry().skipped.find((row) => row.name === name);
  if (skipped) return `plugin ${name} skipped in ${TREE_ROOT}: ${skipped.reason}`;
  return defaultRegistry().plugins.some((row) => row.name === name) ? null : `no plugin ${name}`;
}

// test() options: skip unless a real tree is named, and, given a plugin
// name, unless that plugin applies to it.
function needsTree(plugin = null) {
  if (!REAL_TREE) return { skip: NO_TREE };
  const skip = plugin ? pluginSkip(plugin) : null;
  return skip ? { skip } : {};
}

// test() options: skip unless the default registry has the plugin. The
// fixture tree has every shipped plugin.
function needsPlugin(name) {
  const skip = pluginSkip(name);
  return skip ? { skip } : {};
}

module.exports = { FIXTURE_TREE, NO_TREE, REAL_TREE, SERVER_ROOT, TREE_ROOT, needsPlugin, needsTree, serverModule };
