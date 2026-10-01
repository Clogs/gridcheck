/**
 * Agent bridge: lets the e2e CLI run slash commands on a character's session
 * and read that character's grid, so an agent can check on-grid behaviour
 * without an EVE client. Loopback only, bearer token from the handshake at
 * _local/agentBridge/bridge.json, and off unless EVEJS_AGENT_BRIDGE=1 -- the
 * shipped mod never listens on it. `e2e up` sets the variable.
 *
 * The tree loads this through its shim, server/src/_secondary/agentBridge/server.js,
 * which passes the server root in. Routes are in routes.js. Guide:
 * docs/E2E-GRID-TESTING.md.
 */

"use strict";

const path = require("path");

const { createAgentBridgeHttp, removeHandshake } = require("./http");
const { createAgentBridgeRoutes } = require("./routes");
const { createGridReader } = require("./grid");
const { createGridWatch, createLuJoin } = require("./watch");
const { createDestinyTee } = require("./destiny");
const { createAgentBridgeViewer } = require("./viewer");
const { createStock } = require("./stock");
const { createAgentBridgeWarp } = require("../plugins/lu/server/warp");
const { createAgentBridgeTriggers } = require("../plugins/lu/server/triggers");

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
    space: stock.space,
    projectEntity: stock.webGateway.projectSpaceEntity,
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

// What `e2e watch` joins each NPC to. All optional: a tree without Living
// Universe still gets the grid changes, without the flight columns.
function buildWatchSeams(engine, stock) {
  const lu = optional(() => engine.livingUniverseRuntime);
  const inspect = optional(() => lu && lu.inspect);
  const registry = optional(() => stock.npcRegistry);
  const huntOrders = optional(() => engine.pirateHuntOrders);
  return {
    inspect,
    luJoin: createLuJoin({
      inspect,
      controllerFor: registry ? (entityID) => registry.getControllerByEntityID(entityID) : null,
      huntOrderFor: huntOrders ? (entity, nowMs) => huntOrders.get(entity, nowMs) : null,
    }),
    killmails: optional(() => stock.killmailState),
  };
}

// `e2e warp`: the Living Universe clock and its step driver. The host is
// resolved on first use, because the space tick creates it with the profiler's
// section hook and must be the first to ask.
function buildWarp(engine, stock, log) {
  const clock = optional(() => engine.livingSimClock.getDefaultLivingSimClock());
  const economy = optional(() => engine.livingEconomyRuntime);
  const universe = optional(() => engine.livingUniverseRuntime);
  if (!clock || !economy || !universe) return { warp: null, warpBridge: null };
  let warpBridge = null;
  const warp = engine.livingSimWarp.createSimWarp({
    clock,
    getHost: () => engine.livingModuleHost.getDefaultLivingModuleHost(),
    getRuntime: () => stock.space,
    economy,
    getBacklog: () => warpBridge.backlog(),
    log,
  });
  warpBridge = createAgentBridgeWarp({ warp, clock, economy, universe });
  return { warp, warpBridge };
}

// `e2e trigger`: optional like the watch seams, so a tree without Living
// Universe still serves every other route.
function buildTriggers(engine, stock, seams, scouts) {
  const lu = optional(() => engine.livingUniverseRuntime);
  const clock = optional(() => engine.livingSimClock);
  if (!lu || !clock || !scouts) return null;
  return createAgentBridgeTriggers({
    findSession: seams.findSession,
    space: seams.space,
    lu,
    hunts: optional(() => engine.livingPirateHunts),
    simNow: () => clock.simNow(),
    staticAnchors: (systemID) => stock.worldData.getStaticSceneForSystem(systemID) || [],
    executeChatCommand: seams.executeChatCommand,
    scouts,
  });
}

function createService({ serverRoot }) {
  const treeRoot = path.resolve(serverRoot, "..");
  let bridge = null;

  function start() {
    if (bridge) return bridge;
    const stock = createStock(serverRoot);
    const log = optional(() => stock.logger) || quietLogger();
    const seams = buildSeams(stock);
    // Living Universe reaches go through this fork's modApi until they move
    // behind the plugin loader.
    const engine = optional(() => require(path.join(serverRoot, "src", "modApi"))) || {};
    const scouts = optional(() => require(path.join(serverRoot, "src", "_secondary", "pirateScouts")));
    const { warp, warpBridge } = buildWarp(engine, stock, log);
    const grid = createGridReader(seams);
    const watchSeams = buildWatchSeams(engine, stock);
    // A PackagedAction carries its updates as marshalled bytes.
    const destinyTee = createDestinyTee({
      decodePackaged: (bytes) => stock.marshal.marshalDecodeExact(bytes),
    });
    const watcher = createGridWatch({
      findSession: seams.findSession,
      readGrid: grid.readGrid,
      luJoin: watchSeams.luJoin,
      inspect: watchSeams.inspect,
      killmails: watchSeams.killmails,
      describeSystem: seams.describeSystem,
      describeType: seams.describeType,
      destinyTee,
      luNowMs: optional(() => engine.livingSimClock) ? () => engine.livingSimClock.simNow() : null,
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
      warp,
      warpBridge,
      destinyTee,
      triggers: buildTriggers(engine, stock, seams, scouts),
      gridAnnotate: (row, entity, session) => {
        if (!row.isNpc && !(entity && entity.livingUniverseFlightID)) return;
        const lu = watchSeams.luJoin.annotate(entity, Date.now(), session && session.characterID);
        if (lu) {
          row.flightID = lu.flightID;
          row.family = lu.family;
        }
      },
      viewer: createAgentBridgeViewer({ runsDir: path.join(treeRoot, "_local", "e2e", "runs") }),
    });
    bridge = createAgentBridgeHttp({
      routes,
      port: resolvePort(),
      handshakePath: handshakePath(treeRoot),
      log,
    });
    bridge.start().catch(() => { bridge = null; });
    stock.gameStore.registerShutdownHook("agent-bridge", () => {
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
      if (!isEnabledByEnvironment()) {
        removeHandshake(handshakePath(treeRoot), { onlyIfOurs: true });
        return null;
      }
      return start();
    },
    __testing: {
      DEFAULT_HANDSHAKE_PATH: defaultHandshakePath(treeRoot),
      DEFAULT_PORT,
      handshakePath: (env) => handshakePath(treeRoot, env),
      isEnabledByEnvironment,
      resolvePort,
    },
  };
}

module.exports = {
  createService,
};
