"use strict";

// The Living Universe plugin's server half: the flight join on grid rows, the
// sightings and decision labels on each sample, the off-grid tracker, and the
// /clock, /economy, /warp and /trigger routes. Each
// piece is optional, so a world with part of the mod switched off still gets
// the rest.

const { createLuAnnotate, createLuJoin } = require("./join");
const { createLuOffGrid } = require("./offGrid");
const { createLuOnGrid } = require("./onGrid");
const { createLuRoutes } = require("./routes");
const { createAgentBridgeTriggers } = require("./triggers");
const { createAgentBridgeWarp } = require("./warp");

function optional(load) {
  try {
    return load();
  } catch (_error) {
    return null;
  }
}

// `gridcheck warp`: the Living Universe clock and its step driver. The host is
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

function buildTriggers(engine, stock, seams, scouts) {
  const lu = optional(() => engine.livingUniverseRuntime);
  const clock = optional(() => engine.livingSimClock);
  if (!lu || !clock || !scouts) return null;
  return createAgentBridgeTriggers({
    findSession: seams.findSession,
    space: stock.space,
    lu,
    hunts: optional(() => engine.livingPirateHunts),
    simNow: () => clock.simNow(),
    staticAnchors: (systemID) => stock.worldData.getStaticSceneForSystem(systemID) || [],
    executeChatCommand: seams.executeChatCommand,
    scouts,
  });
}

function createLuServer({ stock, require: serverRequire, log, seams }) {
  const engine = serverRequire("modApi");
  const scouts = optional(() => serverRequire("_secondary/pirateScouts"));
  const universe = optional(() => engine.livingUniverseRuntime);
  const inspect = optional(() => universe && universe.inspect);
  const registry = optional(() => stock.npcRegistry);
  const huntOrders = optional(() => engine.pirateHuntOrders);
  const join = createLuJoin({
    inspect,
    controllerFor: registry ? (entityID) => registry.getControllerByEntityID(entityID) : null,
    huntOrderFor: huntOrders ? (entity, nowMs) => huntOrders.get(entity, nowMs) : null,
  });
  const luNowMs = optional(() => engine.livingSimClock) ? () => engine.livingSimClock.simNow() : null;
  const { warp, warpBridge } = buildWarp(engine, stock, log);
  return {
    annotate: createLuAnnotate(join),
    onGrid: createLuOnGrid(),
    offGrid: createLuOffGrid({ inspect, describeSystem: seams.describeSystem, luNowMs }),
    routes: createLuRoutes({ warp, warpBridge, triggers: buildTriggers(engine, stock, seams, scouts), log }),
  };
}

module.exports = {
  createLuServer,
};
