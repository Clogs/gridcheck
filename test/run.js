#!/usr/bin/env node
"use strict";

// npm test   every test, against the fixture tree (test/fixtures/tree): no
//            EveJS tree needed. Destiny encodings and live samples replay
//            from test/fixtures/.
//
// The compatibility script runs the same tests against a real tree with
// --tree <path>, which is where the few that need server modules run.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEST_DIR = __dirname;
const FIXTURE_TREE = path.join(TEST_DIR, "fixtures", "tree");

function testFiles(dir = TEST_DIR) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join(dir, name));
}

// -> { tree } or { error }
function parseRunArgs(argv) {
  const index = argv.indexOf("--tree");
  if (index < 0) return { tree: null };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return { error: "--tree needs a path" };
  const tree = path.resolve(value);
  if (!fs.existsSync(path.join(tree, "server", "src"))) return { error: `${tree} is not an EveJS tree (no server/src)` };
  return { tree };
}

// -> exit code. extraEnv is for the compatibility script (fixture recording).
function runTests({ tree = null, files = testFiles(), extraEnv = {}, stdio = "inherit" } = {}) {
  const env = { ...process.env, ...extraEnv, GRIDCHECK_TREE: tree || FIXTURE_TREE };
  const result = spawnSync(process.execPath, ["--test", ...files], { env, stdio, encoding: "utf8" });
  return { code: result.status === null ? 1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function main(argv = process.argv.slice(2)) {
  const args = parseRunArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  process.stdout.write(args.tree ? `tests against ${args.tree}\n` : "tests against the fixture tree; tests that need a real tree skip\n");
  return runTests({ tree: args.tree }).code;
}

if (require.main === module) process.exitCode = main();

module.exports = { FIXTURE_TREE, parseRunArgs, runTests, testFiles };
