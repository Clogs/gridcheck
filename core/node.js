"use strict";

// Which node runs the tree's server and the CLI's own children. An MCP client
// built on Electron (Questline, VS Code and its forks) can start `node` as its
// own Electron binary with ELECTRON_RUN_AS_NODE. That node has another native
// ABI, so the server's better-sqlite3 won't load under it. In order:
//
//   GRIDCHECK_NODE          the environment names a node
//   "node" in the config    gridcheck.config.json names one (core/treeConfig.js)
//   this process's node     unless it is Electron's
//   the first node on PATH  that isn't Electron, when this process is
//
// Electron's node with no other on PATH is still used, with a warning.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch (_error) {
    return path.resolve(file);
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

// Every `node` on PATH, in PATH order. On Windows each PATHEXT extension too.
function nodesOnPath(env = process.env, platform = process.platform) {
  const pathText = env.PATH || env.Path || env.path || "";
  const names = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => `node${ext.toLowerCase()}`)
    : ["node"];
  const found = [];
  for (const dir of pathText.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir.replace(/^"|"$/g, ""), name);
      // A .cmd shim can't be spawned without a shell; only a real executable counts.
      if (platform === "win32" && !/\.exe$/i.test(file)) continue;
      if (isFile(file) && !found.includes(file)) found.push(file);
    }
  }
  return found;
}

// The Electron version a node binary reports, "" for plain Node, null when it doesn't run.
function electronVersionOf(file) {
  const result = spawnSync(file, ["-p", "process.versions.electron || ''"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim();
}

let cached = null;

// -> { path, source, warning }. configured: the config's "node", already
// resolved against the tree. probe(file) -> Electron version or "" (tests stub it).
function nodeExecutable({ env = process.env, execPath = process.execPath, versions = process.versions,
  configured = null, platform = process.platform, probe = electronVersionOf, useCache = true } = {}) {
  if (useCache && cached) return cached;
  const done = (answer) => {
    if (useCache) cached = answer;
    return answer;
  };
  const named = String(env.GRIDCHECK_NODE || "").trim();
  if (named) {
    if (!isFile(named)) return done({ path: execPath, source: "this process", warning: `GRIDCHECK_NODE is ${named}, which isn't a file; using ${execPath}` });
    return done({ path: named, source: "GRIDCHECK_NODE", warning: null });
  }
  if (configured) {
    if (!isFile(configured)) return done({ path: execPath, source: "this process", warning: `gridcheck.config.json names node ${configured}, which isn't a file; using ${execPath}` });
    return done({ path: configured, source: "gridcheck.config.json", warning: null });
  }
  if (!versions.electron) return done({ path: execPath, source: "this process", warning: null });
  const own = realPath(execPath);
  for (const candidate of nodesOnPath(env, platform)) {
    if (realPath(candidate) === own) continue;
    if (probe(candidate) === "") return done({ path: candidate, source: "PATH", warning: null });
  }
  return done({
    path: execPath,
    source: "this process",
    warning: `this runs under Electron ${versions.electron}'s node and no other node is on PATH; the server's native modules ` +
      "(better-sqlite3) may not load. Set GRIDCHECK_NODE, or \"node\" in gridcheck.config.json, to a Node install.",
  });
}

module.exports = {
  electronVersionOf,
  nodeExecutable,
  nodesOnPath,
};
