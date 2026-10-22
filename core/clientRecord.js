"use strict";

// The EVE clients `gridcheck client launch` started, by account, in
// <e2eDir>/client/launched.json: each one's pid (the client's own, as its agent
// reported it) and the launch options, never its token. `client stop` and
// `down` use it when the bridge is gone (the server stopped first), and
// `restart --clients` launches the same clients again.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The launch options worth keeping for a relaunch, as `client launch` flags.
const LAUNCH_FLAGS = Object.freeze(["user", "name", "exe", "resfiles", "resfileserver", "settings-profile", "graphics", "no-console"]);
const CLIENT_IMAGE = /^exefile(\.exe)?$/i;

function recordPath(e2eDir) {
  return path.join(e2eDir, "client", "launched.json");
}

function readLaunched(e2eDir) {
  try {
    const value = JSON.parse(fs.readFileSync(recordPath(e2eDir), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (_error) {
    return {};
  }
}

function writeLaunched(e2eDir, rows) {
  const file = recordPath(e2eDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
}

// entry: { pid, characterID, accountID, flags }. flags: the launch's, cut to LAUNCH_FLAGS.
function recordLaunched(e2eDir, username, entry) {
  const rows = readLaunched(e2eDir);
  const flags = Object.fromEntries(Object.entries(entry.flags || {}).filter(([key, value]) => LAUNCH_FLAGS.includes(key) && value !== undefined));
  rows[username] = { pid: entry.pid || null, characterID: entry.characterID || null, accountID: entry.accountID || null,
    launchedAtMs: entry.launchedAtMs || Date.now(), flags: { ...flags, user: username } };
  writeLaunched(e2eDir, rows);
  return rows[username];
}

function forgetLaunched(e2eDir, username) {
  const rows = readLaunched(e2eDir);
  if (!(username in rows)) return;
  delete rows[username];
  writeLaunched(e2eDir, rows);
}

// The image name of a live process, or null. Windows hands a dead client's
// pid to another process, so a pid alone isn't proof.
function processImage(pid, { platform = process.platform, run = spawnSync } = {}) {
  const id = Math.trunc(Number(pid) || 0);
  if (id <= 0) return null;
  if (platform === "win32") {
    const result = run("tasklist", ["/FI", `PID eq ${id}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (result.error || result.status !== 0) return null;
    const match = /^"([^"]+)","(\d+)"/m.exec(String(result.stdout || ""));
    return match && Number(match[2]) === id ? match[1] : null;
  }
  const result = run("ps", ["-p", String(id), "-o", "comm="], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) return null;
  const name = String(result.stdout || "").trim();
  return name ? path.basename(name) : null;
}

function isClientProcess(pid, options = {}) {
  const image = processImage(pid, options);
  return Boolean(image && CLIENT_IMAGE.test(image));
}

module.exports = {
  LAUNCH_FLAGS,
  forgetLaunched,
  isClientProcess,
  processImage,
  readLaunched,
  recordLaunched,
  recordPath,
};
