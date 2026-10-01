#!/usr/bin/env node
"use strict";

// npm test                     every test here, with no EveJS tree; tests that need one skip
// npm run test:tree -- <tree>  the same tests against a tree (EVEJS_E2E_TREE)

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEST_DIR = __dirname;

function testFiles(dir = TEST_DIR) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join(dir, name));
}

// -> { tree } or { error }
function parseRunArgs(argv) {
  const index = argv.indexOf("--tree");
  if (index < 0) return { tree: null };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return { error: "--tree needs a path: npm run test:tree -- <tree>" };
  const tree = path.resolve(value);
  if (!fs.existsSync(path.join(tree, "server", "src"))) return { error: `${tree} is not an EveJS tree (no server/src)` };
  return { tree };
}

function main(argv = process.argv.slice(2)) {
  const args = parseRunArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  const env = { ...process.env };
  delete env.EVEJS_E2E_TREE;
  if (args.tree) env.EVEJS_E2E_TREE = args.tree;
  process.stdout.write(args.tree ? `tests against ${args.tree}\n` : "tests with no tree; tree tests skip\n");
  const result = spawnSync(process.execPath, ["--test", ...testFiles()], { env, stdio: "inherit" });
  return result.status === null ? 1 : result.status;
}

if (require.main === module) process.exitCode = main();

module.exports = { parseRunArgs, testFiles };
