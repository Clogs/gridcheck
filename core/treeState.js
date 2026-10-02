"use strict";

// Two facts about a tree that the GUI and `gridcheck setup` both check before they
// change it: is its server up, and does it have what a server needs to boot
// (its npm dependencies and its reference data).

const fs = require("node:fs");
const path = require("node:path");

const treeConfig = require("./treeConfig");

const slashed = (file) => String(file).split(path.sep).join("/");
const exists = (file) => {
  try {
    return fs.existsSync(file);
  } catch (_error) {
    return false;
  }
};

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

// -> { pid, byE2e } for a server that is up, or null.
function serverUpInfo(root, config = treeConfig.loadTreeConfig(root)) {
  const handshake = readJSON(config.handshake);
  if (handshake && handshake.port && pidAlive(Math.trunc(Number(handshake.pid) || 0))) return { pid: Number(handshake.pid), byE2e: false };
  const run = readJSON(path.join(config.e2eDir, "run.json"));
  if (run && !run.stoppedAtMs && pidAlive(Math.trunc(Number(run.pid) || 0))) return { pid: Number(run.pid), byE2e: true };
  return null;
}

function serverUpReason(root, config = treeConfig.loadTreeConfig(root)) {
  const up = serverUpInfo(root, config);
  if (!up) return null;
  return `the tree's server is up (pid ${up.pid}${up.byE2e ? ", started by gridcheck up" : ""})`;
}

// -> [{ name, path, ok, fix }]: the tree's npm dependencies and its reference data.
function prerequisites(root, config = treeConfig.loadTreeConfig(root)) {
  const rows = [];
  for (const dir of [root, config.serverDir]) {
    const pkg = readJSON(path.join(dir, "package.json"));
    if (!pkg || !Object.keys(pkg.dependencies || {}).length) continue;
    const where = slashed(path.relative(root, dir)) || ".";
    rows.push({
      name: where === "." ? "the tree's dependencies" : `${where} dependencies`,
      path: where === "." ? "node_modules/" : `${where}/node_modules/`,
      ok: exists(path.join(dir, "node_modules")),
      fix: `npm ci in ${where === "." ? "the tree's root" : where}`,
    });
  }
  rows.push({
    name: "reference data",
    path: `${slashed(path.relative(root, config.dataDir))}/`,
    ok: exists(path.join(config.dataDir, "solarSystems", "data.json")),
    fix: `build ${slashed(path.relative(root, config.dataDir))}: stock EveJS runs tools/DatabaseCreator/CreateDatabase.bat ` +
      "(README, Quick start)",
  });
  return rows;
}

module.exports = { prerequisites, serverUpInfo, serverUpReason };
