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

// Where the last `client events` listing ended, for --since last: { serverPid, seq }. A
// cursor from another server process is no cursor, since its numbers start again.
function cursorPath(e2eDir) {
  return path.join(e2eDir, "client", "events-cursor.json");
}

function readEventsCursor(e2eDir, serverPid) {
  try {
    const value = JSON.parse(fs.readFileSync(cursorPath(e2eDir), "utf8"));
    return value && value.serverPid === serverPid && Number.isInteger(value.seq) ? value.seq : null;
  } catch (_error) {
    return null;
  }
}

function writeEventsCursor(e2eDir, serverPid, seq) {
  const file = cursorPath(e2eDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ serverPid, seq })}\n`);
}

// Every `client rpc` and plugin rpc call made through the CLI, one JSON line each, so the
// state a test changed can be put back: { atMs, serverPid, user, service, method, payload |
// args, ok, error }. Cut to the last RPC_LOG_KEEP lines once it passes RPC_LOG_MAX_BYTES.
const RPC_LOG_KEEP = 500;
const RPC_LOG_MAX_BYTES = 1024 * 1024;
// Methods named like a read. A guess from the name alone: the log lists the rest unless asked for all.
const READ_METHOD = /^(Get|List|Status|Is|Has|Find|Search|Query|Read|Describe|Ping|Check|Can)(?![a-z])/;

function rpcLogPath(e2eDir) {
  return path.join(e2eDir, "client", "rpc-log.jsonl");
}

function appendRpcLog(e2eDir, entry) {
  const file = rpcLogPath(e2eDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  if (fs.statSync(file).size > RPC_LOG_MAX_BYTES) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(-RPC_LOG_KEEP).join("\n")}\n`);
  }
}

// -> the calls made on that server process (all of them with serverPid null), oldest first.
function readRpcLog(e2eDir, { serverPid = null, reads = false } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(rpcLogPath(e2eDir), "utf8");
  } catch (_error) {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (_error) {
      // a line cut short by a crash
    }
  }
  return rows.filter((row) => (serverPid === null || row.serverPid === serverPid) && (reads || !READ_METHOD.test(String(row.method))));
}

module.exports = {
  LAUNCH_FLAGS,
  READ_METHOD,
  appendRpcLog,
  forgetLaunched,
  isClientProcess,
  processImage,
  readEventsCursor,
  readLaunched,
  readRpcLog,
  recordLaunched,
  recordPath,
  rpcLogPath,
  writeEventsCursor,
};
