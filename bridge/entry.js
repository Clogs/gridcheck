/**
 * Agent bridge: lets the e2e CLI run slash commands on a character's session
 * and read that character's grid, so an agent can check on-grid behaviour
 * without an EVE client. Loopback only, bearer token from the handshake
 * (e2e.config.json handshake, _local/agentBridge/bridge.json by default), and
 * off unless EVEJS_AGENT_BRIDGE=1 -- the shipped mod never listens on it.
 * `e2e up` sets the variable; in attach mode you set it yourself. The
 * handshake also carries this server's ports, log and data dir, which is how
 * the CLI finds a server it didn't start.
 *
 * The tree loads this through its shim, server/src/_secondary/agentBridge/server.js,
 * which passes the server root in. The core reads stock modules only
 * (stock.js); anything mod-specific is a plugin (plugins.js). Routes are in
 * routes.js. Guide: docs/GUIDE.md.
 */

"use strict";

const path = require("path");

const { createAgentBridgeHttp, removeHandshake } = require("./http");
const { createAgentBridgeRoutes } = require("./routes");
const { createGridReader } = require("./grid");
const { annotateRow, createGridWatch } = require("./watch");
const { createDestinyTee, probeDestinyLayout } = require("./destiny");
const { createAgentBridgeViewer } = require("./viewer");
const { createLoadout, loadLoadoutModules } = require("./loadout");
const { createPerfMonitor } = require("./perf");
const { createStock, serverRequire } = require("./stock");
const { DEFAULT_PLUGINS_DIR, loadPlugins, startPlugins, stopPlugins } = require("./plugins");
const { createToolRegistry, treeAt } = require("../core/plugins");
const { loadTreeConfig } = require("../core/treeConfig");
const { buildReport, copyInfo, sessionShape } = require("../core/capabilities");

const DEFAULT_PORT = 26052;

function isEnabledByEnvironment(env = process.env) {
  const raw = String(env.EVEJS_AGENT_BRIDGE || "").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}

function handshakePath(treeRoot, env = process.env) {
  return loadTreeConfig(treeRoot, { env }).handshake;
}

// The server's own game and gateway ports, as its config resolved them.
function serverPorts(stock) {
  const config = optional(() => stock.config) || {};
  const port = (value) => {
    const numeric = Math.trunc(Number(value) || 0);
    return numeric > 0 && numeric < 65536 ? numeric : null;
  };
  return { game: port(config.serverPort), gateway: port(config.microservicesPort) };
}

// The client view runs only if the decoder reads this tree's ball layout.
function probeLayout(stock) {
  const encoder = optional(() => stock.statePayloads);
  if (!encoder || typeof encoder.buildAddBallsStateBuffer !== "function") {
    return { ok: false, error: "the tree has no ball state encoder (space/destiny/stream/statePayloads)", balls: 0 };
  }
  return probeDestinyLayout((stamp, entities) => encoder.buildAddBallsStateBuffer(stamp, entities));
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
    const config = loadTreeConfig(treeRoot, { env });
    for (const problem of config.problems) log.warn(`[AgentBridge] ${config.file}: ${problem}`);
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
      npcDecision: (entity) => {
        const npcs = optional(() => stock.npcRegistry);
        const controller = npcs && typeof npcs.getControllerByEntityID === "function"
          ? npcs.getControllerByEntityID(entity.itemID) : null;
        return controller && typeof controller.lastDecision === "string" ? controller.lastDecision : null;
      },
    });
    const layout = probeLayout(stock);
    if (!layout.ok) log.warn(`[AgentBridge] client view off: ${layout.error}`);
    // Loaded on the first loadout or capabilities call: the ship runtime pulls
    // in half the server, which must not happen while the loader only scans.
    let loadoutBuilder = null;
    const loadout = () => {
      if (!loadoutBuilder) {
        const { modules, missing } = loadLoadoutModules(serverRequire(serverRoot));
        loadoutBuilder = missing.length ? { error: missing.join("; "), missing } : { run: createLoadout(modules), missing: [] };
        if (missing.length) log.warn(`[AgentBridge] loadout off: ${loadoutBuilder.error}`);
      }
      return loadoutBuilder;
    };
    // A PackagedAction carries its updates as marshalled bytes.
    const destinyTee = createDestinyTee({
      decodePackaged: (bytes) => stock.marshal.marshalDecodeExact(bytes),
      off: layout.ok ? null : layout.error,
    });
    // Tick figures from the runtime's ring; the profiler's windows when the
    // server runs with EVEJS_TICK_PROFILE=1 (perf.js).
    const perf = createPerfMonitor({
      space: () => stock.space,
      logger: optional(() => stock.logger),
      describeSystem: seams.describeSystem,
      env,
    });
    if (perf.profiler.enabled) log.info(`[AgentBridge] tick profiler on: a PROFILE window every ${perf.profiler.everyTicks} ticks`);
    const watcher = createGridWatch({
      findSession: seams.findSession,
      readGrid: grid.readGrid,
      hooks,
      killmails: optional(() => stock.killmailState),
      describeType: seams.describeType,
      destinyTee,
      perf,
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
      loadout,
      perf,
      gridAnnotate: (row, entity, session) => annotateRow(hooks, row, entity, {
        nowMs: Date.now(),
        characterID: session && session.characterID,
      }),
      extraRoutes: hooks.map((hook) => ({ owner: `plugin ${hook.name}`, routes: hook.routes })),
      viewer: createAgentBridgeViewer({ runsDir: config.runsDir,
        registry: createToolRegistry({ active: loaded.active.filter((entry) => hooks.some((hook) => hook.name === entry.name)), skipped }) }),
      capabilities: ({ session, characterID }) => buildReport({
        treeRoot,
        serverRoot,
        config,
        registry: pluginStatus,
        probe: {
          allowlist: optional(() => stock.webGateway.WEB_CALL_ALLOWLIST),
          allowlistError: "the gateway exports no WEB_CALL_ALLOWLIST",
          destiny: layout,
          loadout: { missing: loadout().missing },
        },
        live: {
          pid: process.pid,
          ports: { ...serverPorts(stock), agentBridge: bridge ? bridge.port() : null },
          ...(characterID ? { characterID, session: sessionShape(session) } : {}),
        },
      }),
    });
    bridge = createAgentBridgeHttp({
      routes,
      port: port === null ? resolvePort(env) : port,
      handshakePath: config.handshake,
      log,
      // What attach mode needs to find this server's gateway, log and store.
      handshakeExtra: () => ({
        treeRoot,
        ports: serverPorts(stock),
        logFile: optional(() => stock.dataRoot.resolveDataRootPath("logs", "server.log")) || config.logFile,
        dataDir: optional(() => stock.storeRoot.resolveDataDir()) || config.dataDir,
        tool: copyInfo(),
        profiler: perf.profiler,
      }),
    });
    bridge.start().catch(() => { bridge = null; });
    stock.gameStore.registerShutdownHook("agent-bridge", () => {
      stopPlugins(hooks, log);
      perf.stop();
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
      DEFAULT_HANDSHAKE_PATH: handshakePath(treeRoot, {}),
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
