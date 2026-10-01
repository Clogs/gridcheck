"use strict";

// A tree's e2e.config.json: where its server, data, log and runs live, how
// `e2e up` starts the server, which listeners can move and which daemons the
// tree has. `e2e init` probes the tree and writes it; the CLI, the MCP server
// and the bridge take every path from here. Paths are relative to the tree
// root with forward slashes, so the file can be committed with the tree.
//
//   mode "attach"   the default. You start the server with EVEJS_AGENT_BRIDGE=1
//                   and the CLI talks to it; up, down and world refuse.
//   mode "managed"  the CLI boots, restores and stops the tree's server itself.
//
// The environment wins over the file, as it does for the server:
// EVEJS_GAMESTORE_DATA_DIR moves the data dir and the game store beside it,
// EVEJS_DATA_ROOT the log, and EVEJS_AGENT_BRIDGE_HANDSHAKE the handshake.

const fs = require("node:fs");
const path = require("node:path");

const { LISTENER_ENV, OFFSETS } = require("./ports");

const CONFIG_NAME = "e2e.config.json";
const CONFIG_VERSION = 1;
const MODES = Object.freeze(["attach", "managed"]);
const PATH_KEYS = Object.freeze(["serverDir", "dataRoot", "dataDir", "gameStore", "manifest", "logFile", "e2eDir",
  "worldsDir", "runsDir", "scenariosDir", "handshake"]);
const KEYS = new Set(["configVersion", "mode", "start", "listeners", "daemons", ...PATH_KEYS]);
const MARKET_KEYS = new Set(["enabled", "dir", "config", "database"]);
const LISTENER_KEYS = new Set(["movable", "via"]);
const MARKET_DIR = "externalservices/market-server";
// Source files past this size are data, not code that reads a variable.
const SCAN_MAX_FILE_BYTES = 1_000_000;

class TreeConfigError extends Error {}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const slashes = (text) => String(text).split(path.sep).join("/");

function envText(env, name) {
  return String((env && env[name]) || "").trim();
}

// A path for the file: relative to the tree when inside it, else absolute.
function forFile(treeRoot, absolute) {
  const relative = path.relative(treeRoot, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? slashes(relative) : slashes(absolute);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

// `npm start` as argv: ["node", ...]. The CLI runs it with its own node.
function startArgv(treeRoot, serverDir = "server") {
  const pkg = readJSON(path.join(treeRoot, serverDir, "package.json"));
  const script = pkg && pkg.scripts && pkg.scripts.start;
  return String(script || "node .").split(/\s+/).filter(Boolean);
}

// The data dir the server will use, as server/src/gameStore/storeRoot.js
// picks it: the variable, else _local/gameStore/data once a database was
// generated there, else the copy shipped in the source.
function defaultDataDir(treeRoot, env) {
  const configured = envText(env, "EVEJS_GAMESTORE_DATA_DIR");
  if (configured) return path.resolve(configured);
  const local = path.join(treeRoot, "_local", "gameStore");
  if (fs.existsSync(path.join(local, "manifest.json")) || fs.existsSync(path.join(local, "data"))) return path.join(local, "data");
  return path.join(treeRoot, "server", "src", "gameStore", "data");
}

function defaultDataRoot(treeRoot, env) {
  const configured = envText(env, "EVEJS_DATA_ROOT");
  return configured ? path.resolve(configured) : path.join(treeRoot, "_local");
}

function marketDefaults(treeRoot) {
  const dir = path.join(treeRoot, ...MARKET_DIR.split("/"));
  const database = path.join(dir, "data", "generated", "market.sqlite");
  return {
    // A tree runs the market only when it has the source and a database.
    enabled: fs.existsSync(path.join(dir, "Cargo.toml")) && fs.existsSync(database),
    dir: MARKET_DIR,
    config: `${MARKET_DIR}/config/market-server.local.toml`,
    database: `${MARKET_DIR}/data/generated/market.sqlite`,
  };
}

// What `e2e init` writes before the listener scan; also what a tree with no
// file runs with.
function defaultConfig(treeRoot, env = process.env) {
  const dataDir = defaultDataDir(treeRoot, env);
  const dataRoot = defaultDataRoot(treeRoot, env);
  return {
    configVersion: CONFIG_VERSION,
    mode: "attach",
    serverDir: "server",
    start: startArgv(treeRoot),
    dataRoot: forFile(treeRoot, dataRoot),
    dataDir: forFile(treeRoot, dataDir),
    gameStore: forFile(treeRoot, path.join(path.dirname(dataDir), "gamestore.sqlite")),
    manifest: forFile(treeRoot, path.join(path.dirname(dataDir), "manifest.json")),
    logFile: forFile(treeRoot, path.join(dataRoot, "logs", "server.log")),
    e2eDir: "_local/e2e",
    worldsDir: "_local/e2e/worlds",
    runsDir: "_local/e2e/runs",
    scenariosDir: "tools/e2e-scenarios",
    handshake: "_local/agentBridge/bridge.json",
    listeners: {},
    daemons: { market: marketDefaults(treeRoot) },
  };
}

// Each .js file under server/src once, for the variables named. -> Set of names found.
function scanSource(serverRoot, names) {
  const wanted = [...new Set(names.filter(Boolean))];
  const found = new Set();
  if (!wanted.length) return found;
  const pattern = new RegExp(wanted.map((name) => name.replace(/[^A-Z0-9_]/g, "")).join("|"), "g");
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      if (found.size === wanted.length) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(file);
      } else if (entry.name.endsWith(".js")) {
        let text;
        try {
          if (fs.statSync(file).size > SCAN_MAX_FILE_BYTES) continue;
          text = fs.readFileSync(file, "utf8");
        } catch (_error) {
          continue;
        }
        for (const match of text.matchAll(pattern)) found.add(match[0]);
      }
    }
  };
  walk(path.join(serverRoot, "src"));
  return found;
}

// Which listeners `e2e up` can move onto the tree's port block. A listener
// moves when the tree's source reads its variable; the rest stay on their
// stock ports, so two such trees can't run at once.
// pluginListeners: core/plugins.js registry.listeners.
function probeListeners(serverRoot, { pluginListeners = [], market = true } = {}) {
  const variables = { ...LISTENER_ENV };
  for (const listener of pluginListeners) if (listener.env) variables[listener.name] = listener.env;
  const found = scanSource(serverRoot, Object.values(variables));
  const listeners = {};
  for (const name of [...Object.keys(OFFSETS), ...pluginListeners.map((listener) => listener.name)]) {
    if (listeners[name]) continue;
    if (variables[name]) {
      listeners[name] = { movable: found.has(variables[name]), via: variables[name] };
    } else if (name === "gatewayTls") {
      listeners[name] = { movable: found.has(LISTENER_ENV.gateway), via: "gateway port + 1" };
    } else if (name === "agentBridge") {
      listeners[name] = { movable: true, via: "EVEJS_AGENT_BRIDGE_PORT" };
    } else if (name === "marketHttp") {
      listeners[name] = { movable: Boolean(market), via: "the market's generated TOML" };
    } else {
      listeners[name] = { movable: false, via: "nothing this tool knows" };
    }
  }
  return listeners;
}

// -> { config, notes }: the file `e2e init` writes.
function probeTree(treeRoot, { env = process.env, pluginListeners = [], mode = "attach" } = {}) {
  const config = defaultConfig(treeRoot, env);
  config.mode = mode;
  const serverRoot = path.join(treeRoot, config.serverDir);
  config.listeners = probeListeners(serverRoot, { pluginListeners, market: config.daemons.market.enabled });
  const notes = [];
  if (config.start[0] !== "node") notes.push(`server start script is not a node command: ${config.start.join(" ")}`);
  if (!fs.existsSync(path.join(treeRoot, ...config.manifest.split("/")))) {
    notes.push(`no generated reference data (${config.manifest}); run the tree's database setup first`);
  }
  if (envText(env, "EVEJS_GAMESTORE_DATA_DIR")) notes.push(`data dir from EVEJS_GAMESTORE_DATA_DIR: ${config.dataDir}`);
  const fixed = Object.entries(config.listeners).filter(([, listener]) => !listener.movable).map(([name]) => name);
  if (fixed.length) notes.push(`listeners that stay on their stock ports: ${fixed.join(", ")}`);
  return { config, notes };
}

const validPath = (value) => typeof value === "string" && value.trim() !== "";
const validStart = (value) => Array.isArray(value) && value[0] === "node" && value.every((token) => typeof token === "string" && token);

function validateConfig(raw) {
  const problems = [];
  if (!isObject(raw)) return ["the file is not a JSON object"];
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) problems.push(`unknown key ${key}`);
  if (raw.configVersion !== CONFIG_VERSION) problems.push(`configVersion is ${JSON.stringify(raw.configVersion)}; this tool reads ${CONFIG_VERSION}`);
  if (raw.mode !== undefined && !MODES.includes(raw.mode)) problems.push(`mode is attach or managed, not ${JSON.stringify(raw.mode)}`);
  for (const key of PATH_KEYS) if (raw[key] !== undefined && !validPath(raw[key])) problems.push(`${key} is a path`);
  if (raw.start !== undefined && !validStart(raw.start)) problems.push('start is an argv starting with "node", e.g. ["node", "."]');
  if (raw.listeners !== undefined) {
    if (!isObject(raw.listeners)) problems.push("listeners is an object");
    else {
      for (const [name, listener] of Object.entries(raw.listeners)) {
        if (!isObject(listener) || typeof listener.movable !== "boolean") problems.push(`listeners.${name}.movable is true or false`);
        else for (const key of Object.keys(listener)) if (!LISTENER_KEYS.has(key)) problems.push(`listeners.${name}: unknown key ${key}`);
      }
    }
  }
  if (raw.daemons !== undefined) {
    if (!isObject(raw.daemons)) problems.push("daemons is an object");
    else {
      for (const name of Object.keys(raw.daemons)) if (name !== "market") problems.push(`daemons.${name}: the only daemon is market`);
      const market = raw.daemons.market;
      if (market !== undefined) {
        if (!isObject(market)) problems.push("daemons.market is an object");
        else {
          for (const key of Object.keys(market)) if (!MARKET_KEYS.has(key)) problems.push(`daemons.market: unknown key ${key}`);
          if (market.enabled !== undefined && typeof market.enabled !== "boolean") problems.push("daemons.market.enabled is true or false");
        }
      }
    }
  }
  return problems;
}

function absolute(treeRoot, value) {
  return path.resolve(treeRoot, ...String(value).split("/"));
}

// The tree's config with absolute paths. Never throws: `problems` lists what
// is wrong with the file, and the defaults stand in for anything unusable.
// The CLI refuses to run on problems; the bridge logs them.
function loadTreeConfig(treeRoot, { env = process.env } = {}) {
  const file = path.join(treeRoot, CONFIG_NAME);
  const defaults = defaultConfig(treeRoot, env);
  let raw = null;
  const problems = [];
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      problems.push(`not JSON: ${error.message}`);
    }
    if (raw !== null) problems.push(...validateConfig(raw));
  }
  const given = isObject(raw) ? raw : {};
  const merged = { ...defaults };
  if (MODES.includes(given.mode)) merged.mode = given.mode;
  if (validStart(given.start)) merged.start = given.start;
  for (const key of PATH_KEYS) if (validPath(given[key])) merged[key] = given[key];
  const market = { ...defaults.daemons.market, ...(isObject(given.daemons) && isObject(given.daemons.market) ? given.daemons.market : {}) };

  // The server takes the data dir and data root from its environment; so does this.
  const dataDir = envText(env, "EVEJS_GAMESTORE_DATA_DIR") ? path.resolve(envText(env, "EVEJS_GAMESTORE_DATA_DIR"))
    : absolute(treeRoot, merged.dataDir);
  const dataRoot = envText(env, "EVEJS_DATA_ROOT") ? path.resolve(envText(env, "EVEJS_DATA_ROOT"))
    : absolute(treeRoot, merged.dataRoot);
  // The server keeps gamestore.sqlite beside its data dir; a file that says otherwise is wrong.
  const gameStore = path.join(path.dirname(dataDir), "gamestore.sqlite");
  if (given.gameStore !== undefined && !envText(env, "EVEJS_GAMESTORE_DATA_DIR") &&
    path.resolve(absolute(treeRoot, given.gameStore)) !== path.resolve(gameStore)) {
    problems.push(`gameStore must sit beside the data dir (${forFile(treeRoot, gameStore)}): the server puts it there`);
  }
  const logFile = given.logFile !== undefined && !envText(env, "EVEJS_DATA_ROOT")
    ? absolute(treeRoot, merged.logFile) : path.join(dataRoot, "logs", "server.log");
  const handshake = envText(env, "EVEJS_AGENT_BRIDGE_HANDSHAKE") || absolute(treeRoot, merged.handshake);
  const e2eDir = absolute(treeRoot, merged.e2eDir);
  return {
    treeRoot,
    file,
    exists: raw !== null,
    problems,
    mode: merged.mode,
    serverDir: absolute(treeRoot, merged.serverDir),
    start: merged.start,
    dataRoot,
    dataDir,
    gameStore,
    manifest: path.join(path.dirname(dataDir), "manifest.json"),
    logFile,
    e2eDir,
    worldsDir: given.worldsDir !== undefined ? absolute(treeRoot, merged.worldsDir) : path.join(e2eDir, "worlds"),
    runsDir: given.runsDir !== undefined ? absolute(treeRoot, merged.runsDir) : path.join(e2eDir, "runs"),
    scenariosDir: absolute(treeRoot, merged.scenariosDir),
    handshake,
    listeners: isObject(given.listeners) ? given.listeners : {},
    market: {
      enabled: Boolean(market.enabled),
      dir: absolute(treeRoot, market.dir),
      config: absolute(treeRoot, market.config),
      database: absolute(treeRoot, market.database),
    },
  };
}

let cachedDefault = null;

// The config of the tree this copy runs for (core/plugins.js DEFAULT_TREE_ROOT), read once.
function defaultTreeConfig() {
  if (!cachedDefault) cachedDefault = loadTreeConfig(require("./plugins").DEFAULT_TREE_ROOT);
  return cachedDefault;
}

function writeTreeConfig(treeRoot, config, { force = false } = {}) {
  const file = path.join(treeRoot, CONFIG_NAME);
  if (fs.existsSync(file) && !force) throw new TreeConfigError(`${CONFIG_NAME} exists; pass --force to replace it`);
  const problems = validateConfig(config);
  if (problems.length) throw new TreeConfigError(`refusing to write a bad ${CONFIG_NAME}: ${problems.join("; ")}`);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

module.exports = {
  CONFIG_NAME,
  CONFIG_VERSION,
  MODES,
  TreeConfigError,
  defaultConfig,
  defaultTreeConfig,
  loadTreeConfig,
  probeListeners,
  probeTree,
  scanSource,
  validateConfig,
  writeTreeConfig,
};
