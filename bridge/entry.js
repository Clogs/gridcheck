/**
 * Agent bridge: lets the e2e CLI run slash commands on a character's session
 * and read that character's grid, so an agent can check on-grid behaviour
 * without an EVE client. Loopback only, bearer token from the handshake at
 * _local/agentBridge/bridge.json, and off unless EVEJS_AGENT_BRIDGE=1 -- the
 * shipped mod never listens on it. `e2e up` sets the variable.
 *
 * The tree loads this through its shim, server/src/_secondary/agentBridge/server.js,
 * which passes the server root in. The core reads stock modules only
 * (stock.js); anything mod-specific is a plugin (plugins.js). Routes are in
 * routes.js. Guide: docs/E2E-GRID-TESTING.md.
 */

"use strict";

const path = require("path");

const { createAgentBridgeHttp, removeHandshake } = require("./http");
const { createAgentBridgeRoutes } = require("./routes");
const { createGridReader } = require("./grid");
const { annotateRow, createGridWatch } = require("./watch");
const { createDestinyTee } = require("./destiny");
const { createAgentBridgeViewer } = require("./viewer");
const { createStock, serverRequire } = require("./stock");
const { DEFAULT_PLUGINS_DIR, loadPlugins, startPlugins, stopPlugins } = require("./plugins");
const { createToolRegistry, treeAt } = require("../core/plugins");

const DEFAULT_PORT = 26052;

function isEnabledByEnvironment(env = process.env) {
  const raw = String(env.EVEJS_AGENT_BRIDGE || "").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}

function defaultHandshakePath(treeRoot) {
  return path.join(treeRoot, "_local", "agentBridge", "bridge.json");
}

function handshakePath(treeRoot, env = process.env) {
  return String(env.EVEJS_AGENT_BRIDGE_HANDSHAKE || "").trim() || defaultHandshakePath(treeRoot);
}

function resolvePort(env = process.env) {
  const configured = Math.trunc(Number(env.EVEJS_AGENT_BRIDGE_PORT) || 0);
  return configured > 0 && configured < 65536 ? configured : DEFAULT_PORT;
}

function optional(load) {
  try {
    return load();
  } catch (_error) {
    return null;
  }
}

function quietLogger() {
  return { debug() {}, info() {}, warn() {}, err() {} };
}


function buildSeams(stock) {
  const itemTypes = stock.itemTypeRegistry;
  const worldData = stock.worldData;
  return {
    findSession: (characterID) => stock.sessionRegistry.findSessionByCharacterID(characterID),
    executeChatCommand: stock.chatCommands.executeChatCommand,
    describeType: (typeID) => {
      const record = itemTypes.resolveItemByTypeID(typeID);
      return record && record.name ? String(record.name) : null;
    },
    describeSystem: (systemID) => {
      const row = worldData.getSolarSystemByID(systemID);
      return row
        ? {
          name: row.solarSystemName ? String(row.solarSystemName) : null,
          security: Number.isFinite(Number(row.security)) ? Number(row.security) : null,
        }
        : null;
    },
  };
}

// stock, pluginsDir, env and port are for tests; the shim passes serverRoot only.
function createService({ serverRoot, stock: givenStock = null, pluginsDir = DEFAULT_PLUGINS_DIR, env = process.env,
  port = null }) {
  const treeRoot = path.resolve(serverRoot, "..");
  let bridge = null;
  let pluginStatus = null;

  function start() {
    if (bridge) return bridge;
    const stock = givenStock || createStock(serverRoot);
    const log = optional(() => stock.logger) || quietLogger();
    const seams = buildSeams(stock);
    const tree = treeAt(treeRoot, serverRoot);
    const loaded = loadPlugins({ pluginsDir, tree, log });
    const { hooks, skipped } = startPlugins(loaded, {
      stock, require: serverRequire(serverRoot), log, treeRoot, serverRoot, seams,
    }, { log });
    pluginStatus = { active: hooks.map((hook) => hook.name), skipped };
    const grid = createGridReader({
      space: stock.space,
      projectEntity: stock.webGateway.projectSpaceEntity,
      describeType: seams.describeType,
      describeSystem: seams.describeSystem,
    });
    // A PackagedAction carries its updates as marshalled bytes.
    const destinyTee = createDestinyTee({
      decodePackaged: (bytes) => stock.marshal.marshalDecodeExact(bytes),
    });
    const watcher = createGridWatch({
      findSession: seams.findSession,
      readGrid: grid.readGrid,
      hooks,
      killmails: optional(() => stock.killmailState),
      describeType: seams.describeType,
      destinyTee,
    });
    const routes = createAgentBridgeRoutes({
      findSession: seams.findSession,
      executeChatCommand: seams.executeChatCommand,
      readGrid: grid.readGrid,
      watcher,
      // The installed owner-process handler turns SIGTERM into hooks, a store
      // flush and a lease release. Emitting it from inside is the one graceful
      // stop Windows offers a detached server. Deferred so the reply goes first.
      requestShutdown: () => setTimeout(() => process.emit("SIGTERM", "SIGTERM"), 100),
      log,
      destinyTee,
      gridAnnotate: (row, entity, session) => annotateRow(hooks, row, entity, {
        nowMs: Date.now(),
        characterID: session && session.characterID,
      }),
      extraRoutes: hooks.map((hook) => ({ owner: `plugin ${hook.name}`, routes: hook.routes })),
      viewer: createAgentBridgeViewer({ runsDir: path.join(treeRoot, "_local", "e2e", "runs"),
        registry: createToolRegistry({ active: loaded.active.filter((entry) => hooks.some((hook) => hook.name === entry.name)), skipped }) }),
    });
    bridge = createAgentBridgeHttp({
      routes,
      port: port === null ? resolvePort(env) : port,
      handshakePath: handshakePath(treeRoot, env),
      log,
    });
    bridge.start().catch(() => { bridge = null; });
    stock.gameStore.registerShutdownHook("agent-bridge", () => {
      stopPlugins(hooks, log);
      const stopping = bridge ? bridge.stop() : Promise.resolve();
      bridge = null;
      return stopping;
    });
    return bridge;
  }

  return {
    enabled: true,
    serviceName: "agentBridge",
    exec() {
      if (!isEnabledByEnvironment(env)) {
        removeHandshake(handshakePath(treeRoot, env), { onlyIfOurs: true });
        return null;
      }
      return start();
    },
    __testing: {
      DEFAULT_HANDSHAKE_PATH: defaultHandshakePath(treeRoot),
      DEFAULT_PORT,
      handshakePath: (overrides) => handshakePath(treeRoot, overrides),
      isEnabledByEnvironment,
      pluginStatus: () => pluginStatus,
      resolvePort,
    },
  };
}

module.exports = {
  createService,
};
