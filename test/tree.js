"use strict";

// Some tests need an EveJS tree: its server modules, or a plugin that applies
// only in a tree with its mod. `npm test` runs with none and skips them;
// `npm run test:tree -- <tree>` names one through EVEJS_E2E_TREE, which also
// sets the tree the default registry loads plugins for (core/plugins.js).

const path = require("node:path");

const { defaultRegistry } = require("../core/plugins");

const TREE_ROOT = String(process.env.EVEJS_E2E_TREE || "").trim()
  ? path.resolve(process.env.EVEJS_E2E_TREE.trim())
  : null;
const SERVER_ROOT = TREE_ROOT ? path.join(TREE_ROOT, "server") : null;
const NO_TREE = "needs an EveJS tree: npm run test:tree -- <tree>";

// A module under the tree's server/src. Call it inside a test that skips
// without a tree.
function serverModule(relativePath) {
  if (!SERVER_ROOT) throw new Error(NO_TREE);
  return require(path.join(SERVER_ROOT, "src", relativePath));
}

// test() options: skip unless a tree is named.
function needsTree() {
  return TREE_ROOT ? {} : { skip: NO_TREE };
}

// test() options: skip unless the default registry has the plugin, which
// needs a tree whose mod the plugin applies to.
function needsPlugin(name) {
  if (!TREE_ROOT) return { skip: `${NO_TREE} with plugin ${name}` };
  const skipped = defaultRegistry().skipped.find((row) => row.name === name);
  if (skipped) return { skip: `plugin ${name} skipped in ${TREE_ROOT}: ${skipped.reason}` };
  return defaultRegistry().plugins.some((row) => row.name === name) ? {} : { skip: `no plugin ${name}` };
}

module.exports = { NO_TREE, SERVER_ROOT, TREE_ROOT, needsPlugin, needsTree, serverModule };
