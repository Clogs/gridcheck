"use strict";

// Every tree's e2e server gets its own block of ports, chosen from a hash of
// the tree's path, so two trees can run at once and neither takes the stock
// ports StartServer.bat uses. Blocks sit below Windows' ephemeral range
// (49152 and up), where outgoing connections would otherwise grab them.

const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");

const BLOCK_BASE = 30_000;
const BLOCK_SIZE = 20;
const SLOT_COUNT = 800;

// Offsets inside a block. gatewayTls is not configurable: the gateway always
// opens its local TLS responder on its own port + 1. Plugins add their own
// listeners at free offsets (core/plugins.js registry.listeners).
const OFFSETS = Object.freeze({
  game: 0,
  image: 1,
  gateway: 2,
  gatewayTls: 3,
  cdn: 4,
  redshift: 5,
  agentBridge: 7,
  marketHttp: 8,
  marketRpc: 9,
  xmpp: 10,
});

// The plugin listeners that fit: inside the block, on an offset nothing else
// has, under a name nothing else has.
function usableListeners(listeners = []) {
  const taken = new Set(Object.values(OFFSETS));
  const names = new Set(Object.keys(OFFSETS));
  const usable = [];
  for (const listener of listeners) {
    if (!(listener.offset >= 0 && listener.offset < BLOCK_SIZE) || taken.has(listener.offset) || names.has(listener.name)) continue;
    taken.add(listener.offset);
    names.add(listener.name);
    usable.push(listener);
  }
  return usable;
}

function slotForTree(treeRoot, env = process.env) {
  const override = String(env.EVEJS_E2E_PORT_SLOT || "").trim();
  if (override) {
    const slot = Number(override);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
      throw new RangeError(`EVEJS_E2E_PORT_SLOT must be an integer from 0 to ${SLOT_COUNT - 1}`);
    }
    return slot;
  }
  // Windows paths are case-insensitive, so F:\LU\x and f:/lu/x are one tree.
  let normalized = path.resolve(treeRoot);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0) % SLOT_COUNT;
}

function portsForSlot(slot, listeners = []) {
  const base = BLOCK_BASE + slot * BLOCK_SIZE;
  const ports = { slot };
  for (const [name, offset] of Object.entries(OFFSETS)) ports[name] = base + offset;
  for (const listener of usableListeners(listeners)) ports[listener.name] = base + listener.offset;
  return Object.freeze(ports);
}

function portsForTree(treeRoot, env = process.env, listeners = []) {
  return portsForSlot(slotForTree(treeRoot, env), listeners);
}

// The environment that moves every listener of `npm start` onto the block.
// The public URL carries the gateway port too: store and CDN links are built
// from it, and the config loader derives the listen port from it.
function serverEnvironment(ports, listeners = []) {
  const env = {
    EVEJS_SERVER_PORT: String(ports.game),
    EVEJS_IMAGE_SERVER_URL: `http://127.0.0.1:${ports.image}/`,
    EVEJS_MICROSERVICES_PORT: String(ports.gateway),
    EVEJS_MICROSERVICES_PUBLIC_URL: `http://127.0.0.1:${ports.gateway}/`,
    EVEJS_PROXY_LOOPBACK_CDN_LISTEN_PORT: String(ports.cdn),
    EVEJS_REDSHIFT_MONITOR_PORT: String(ports.redshift),
    EVEJS_AGENT_BRIDGE_PORT: String(ports.agentBridge),
    EVEJS_MARKET_DAEMON_PORT: String(ports.marketRpc),
    EVEJS_XMPP_SERVER_PORT: String(ports.xmpp),
  };
  for (const listener of usableListeners(listeners)) {
    if (listener.env && ports[listener.name]) env[listener.env] = String(ports[listener.name]);
  }
  return env;
}

// The market daemon reads its ports only from TOML. Rewrites the two port
// lines and the database path of the tracked config.
function marketConfig(trackedToml, ports, databasePath) {
  let section = "";
  let seen = 0;
  const lines = String(trackedToml).split(/\r?\n/).map((line) => {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) section = header[1].trim();
    if (/^\s*port\s*=/.test(line) && (section === "network" || section === "rpc")) {
      seen += 1;
      return `port = ${section === "network" ? ports.marketHttp : ports.marketRpc}`;
    }
    if (/^\s*database_path\s*=/.test(line) && section === "storage") {
      seen += 1;
      return `database_path = ${JSON.stringify(databasePath.split(path.sep).join("/"))}`;
    }
    return line;
  });
  if (seen !== 3) throw new Error("market config has no [network] port, [rpc] port and [storage] database_path");
  return `${lines.join("\n")}\n`;
}

function portFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function busyPorts(ports, listeners = []) {
  const busy = [];
  for (const name of [...Object.keys(OFFSETS), ...usableListeners(listeners).map((listener) => listener.name)]) {
    if (ports[name] && !await portFree(ports[name])) busy.push({ name, port: ports[name] });
  }
  return busy;
}

module.exports = {
  BLOCK_BASE,
  BLOCK_SIZE,
  OFFSETS,
  SLOT_COUNT,
  busyPorts,
  marketConfig,
  portsForSlot,
  portsForTree,
  serverEnvironment,
  slotForTree,
  usableListeners,
};
