#!/usr/bin/env node
"use strict";

// npm run fixtures:capture -- --tree <path> [--out <dir>] [--destiny-only]
//
// Records the fixtures npm test replays, from a real tree:
//   destiny.json  the tree's destiny encoders' output for every call the
//                 destiny tests make (test/fixtures/encoders.js)
//   live.json     a gateway session's shape and a grid read just after
//                 undock, from the tree's running server
//
// live.json needs that server up with this checkout vendored into the tree
// (the bridge's /capabilities): `gridcheck up --fresh` in managed mode, or the
// server started with EVEJS_AGENT_BRIDGE=1. The capture logs the test
// character in and undocks it. --out writes somewhere else, which is how the
// compatibility script compares a fresh capture with the committed one.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { loadTreeConfig } = require("../../core/treeConfig");
const { runTests } = require("../run");

const FIXTURES_DIR = __dirname;
const REPO_ROOT = path.join(__dirname, "..", "..");
const DESTINY_TEST = path.join(REPO_ROOT, "test", "agentBridgeDestiny.test.js");

class CaptureError extends Error {}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

// Runs the destiny tests against the tree's encoders and writes what they returned.
function captureDestiny({ tree, out }) {
  const result = runTests({ tree, files: [DESTINY_TEST], stdio: "pipe",
    extraEnv: { GRIDCHECK_FIXTURES: "record", GRIDCHECK_FIXTURES_OUT: out } });
  if (result.code !== 0 || !fs.existsSync(out)) {
    throw new CaptureError(`the destiny tests failed against ${tree}'s encoders:\n${(result.stdout + result.stderr).split(/\r?\n/)
      .filter((line) => /not ok|Error|expected|actual/.test(line)).slice(0, 20).join("\n")}`);
  }
  return readJSON(out);
}

// The tree's own copy of the CLI, as a person would run it.
function treeCli(tree) {
  const vendored = path.join(tree, "tools", "gridcheck", "bin", "gridcheck.js");
  return (args) => {
    const env = { ...process.env, GRIDCHECK_TREE: tree };
    const result = spawnSync(process.execPath, [vendored, ...args], { cwd: tree, env, encoding: "utf8", timeout: 180_000,
      windowsHide: true });
    return { code: result.status, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
  };
}

async function bridgeCall(handshake, route) {
  const response = await fetch(`http://${handshake.host}:${handshake.port}${route}`, {
    headers: { authorization: `Bearer ${handshake.token}` }, signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new CaptureError(`bridge ${route}: ${body.error || `HTTP ${response.status}`}`);
  return body;
}

// Logs in, docks if it can and undocks, then reads the session and the grid.
async function captureLive({ tree }) {
  const config = loadTreeConfig(tree);
  const handshake = readJSON(config.handshake);
  if (!handshake || !handshake.token) {
    throw new CaptureError(`no live agent bridge in ${tree} (${config.handshake}). Start its server (gridcheck up --fresh, ` +
      "or by hand with EVEJS_AGENT_BRIDGE=1), or pass --destiny-only.");
  }
  const cli = treeCli(tree);
  const login = cli(["login"]);
  if (login.code !== 0) throw new CaptureError(`gridcheck login failed:\n${login.out}`);
  cli(["dock"]);
  const undock = cli(["undock"]);
  if (undock.code !== 0) throw new CaptureError(`gridcheck undock failed:\n${undock.out}`);
  const state = readJSON(path.join(config.e2eDir, "state.json")) || {};
  if (!state.characterID) throw new CaptureError("gridcheck login left no character in state.json");
  // The grid an undock produces: the ship, protected, among the station's neighbours.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const capabilities = await bridgeCall(handshake, `/capabilities?characterID=${state.characterID}`);
  const grid = (await bridgeCall(handshake, `/grid?characterID=${state.characterID}&ext=1`)).grid;
  const pkg = readJSON(path.join(tree, "server", "package.json")) || {};
  return { evejs: pkg.version || null, session: capabilities.live && capabilities.live.session, grid };
}

const sortedKeys = (object) => Object.keys(object || {}).sort();

// What a capture must keep to match the committed fixtures: the session
// fields the client view checks, and the grid's shape (its keys, the self
// row's, and every row key by kind), not its values.
function liveSignature(live) {
  const session = live && live.session ? live.session : {};
  const grid = live && live.grid ? live.grid : {};
  const rows = Array.isArray(grid.entities) ? grid.entities : [];
  const byKind = {};
  for (const row of rows) {
    const keys = byKind[row.kind] || (byKind[row.kind] = new Set());
    for (const key of Object.keys(row)) keys.add(key);
  }
  return {
    session: {
      gatewayClientID: Boolean(session.gatewayClientID),
      socket: Boolean(session.socket),
      socketWrites: Boolean(session.socketWrites),
      sendNotification: Boolean(session.sendNotification),
      sendSessionChange: Boolean(session.sendSessionChange),
    },
    grid: sortedKeys(grid),
    self: sortedKeys(rows.find((row) => row.isSelf)),
    rows: Object.fromEntries(Object.keys(byKind).sort().map((kind) => [kind, [...byKind[kind]].sort()])),
  };
}

// -> differences between a committed fixture and a fresh capture, as lines.
// sections: which parts to compare (a tree whose world differs compares only
// the session and the destiny encodings).
function compareCaptures(committed, fresh, { sections = ["destiny", "session", "grid"] } = {}) {
  const lines = [];
  if (sections.includes("destiny")) {
    const before = (committed.destiny && committed.destiny.encodings) || {};
    const after = (fresh.destiny && fresh.destiny.encodings) || {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!before[key]) lines.push(`destiny: ${key} is new`);
      else if (!after[key]) lines.push(`destiny: ${key} is no longer called`);
      else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) lines.push(`destiny: ${key} encodes differently`);
    }
  }
  if (committed.live && fresh.live) {
    const before = liveSignature(committed.live);
    const after = liveSignature(fresh.live);
    if (sections.includes("session") && JSON.stringify(before.session) !== JSON.stringify(after.session)) {
      lines.push(`session: ${JSON.stringify(before.session)} became ${JSON.stringify(after.session)}`);
    }
    if (sections.includes("grid")) {
      for (const part of ["grid", "self", "rows"]) {
        if (JSON.stringify(before[part]) !== JSON.stringify(after[part])) {
          lines.push(`grid ${part}: ${JSON.stringify(before[part])} became ${JSON.stringify(after[part])}`);
        }
      }
    }
  }
  return lines;
}

function committedFixtures(dir = FIXTURES_DIR) {
  return { destiny: readJSON(path.join(dir, "destiny.json")), live: readJSON(path.join(dir, "live.json")) };
}

function parseArgs(argv) {
  const flags = { tree: null, out: FIXTURES_DIR, destinyOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--tree") flags.tree = argv[++index];
    else if (token === "--out") flags.out = argv[++index];
    else if (token === "--destiny-only") flags.destinyOnly = true;
    else throw new CaptureError(`unknown argument ${token}`);
  }
  if (!flags.tree) throw new CaptureError("usage: npm run fixtures:capture -- --tree <path> [--out <dir>] [--destiny-only]");
  flags.tree = path.resolve(flags.tree);
  flags.out = path.resolve(flags.out);
  if (!fs.existsSync(path.join(flags.tree, "server", "src", "space", "runtime.js"))) {
    throw new CaptureError(`${flags.tree} is not an EveJS tree`);
  }
  return flags;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  fs.mkdirSync(flags.out, { recursive: true });
  const destiny = captureDestiny({ tree: flags.tree, out: path.join(flags.out, "destiny.json") });
  console.log(`destiny.json: ${Object.keys(destiny.encodings).length} encodings from EveJS ${destiny.evejs || "?"}`);
  if (flags.destinyOnly) return 0;
  const live = await captureLive({ tree: flags.tree });
  fs.writeFileSync(path.join(flags.out, "live.json"), `${JSON.stringify(live, null, 2)}\n`);
  console.log(`live.json: a ${live.session && live.session.gatewayClientID ? "gateway " : ""}session and a grid of ` +
    `${live.grid && live.grid.entities ? live.grid.entities.length : 0} balls in ${live.grid && live.grid.systemName}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`fixtures:capture: ${error instanceof CaptureError ? error.message : error.stack}`);
    process.exitCode = 1;
  });
}

module.exports = { CaptureError, captureDestiny, captureLive, committedFixtures, compareCaptures, liveSignature };
