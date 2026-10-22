"use strict";

// What the bridge reads off a live entity, without a session: finding an
// entity in whichever scene holds it, its capacitor, its running module
// effects, its NPC controller. Read-only, and defensive: a field the tree
// doesn't have is null, never an error (stock EveJS 0.12.9 and forks differ).

// nextCycleAtMs and friends hold MAX_SAFE_INTEGER for "never".
const NEVER_MS = 1e15;

function finite(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(numeric) ? numeric : null;
}

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function safe(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

// A time that means something: set, and not the "never" sentinel.
function realTime(value) {
  const numeric = finite(value);
  return numeric !== null && numeric > 0 && numeric < NEVER_MS ? numeric : null;
}

function vectorOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const z = finite(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function speedOf(entity) {
  const velocity = vectorOf(entity && entity.velocity);
  return velocity ? Math.round(Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2) * 10) / 10 : null;
}

function simTimeOf(scene, fallbackMs = Date.now()) {
  if (scene && typeof scene.getCurrentSimTimeMs === "function") {
    const value = finite(safe(() => scene.getCurrentSimTimeMs()));
    if (value !== null) return value;
  }
  return fallbackMs;
}

// ---------- finding an entity ----------

function sceneList(space) {
  const scenes = space && space.scenes;
  if (!scenes || typeof scenes.values !== "function") return [];
  return [...scenes.values()].filter(Boolean);
}

function entityIn(scene, itemID) {
  if (typeof scene.getEntityByID === "function") {
    const found = safe(() => scene.getEntityByID(itemID));
    if (found) return found;
  }
  if (scene.dynamicEntities && typeof scene.dynamicEntities.get === "function") {
    const found = scene.dynamicEntities.get(itemID) || scene.dynamicEntities.get(String(itemID));
    if (found) return found;
  }
  if (scene.staticEntitiesByID && typeof scene.staticEntitiesByID.get === "function") {
    return scene.staticEntitiesByID.get(itemID) || null;
  }
  return null;
}

// find(itemID) -> { scene, entity } for the first loaded scene that holds it.
// explainMissing(itemID) says why there is none. describeItem(itemID) is the
// item store's record ({ locationID }), when the tree has one to ask.
function createEntityLocator({ space, describeItem = null, describeSystem = null }) {
  function find(itemID) {
    const id = toPositiveInt(itemID);
    if (!id) return null;
    for (const scene of sceneList(space)) {
      const entity = entityIn(scene, id);
      if (entity) return { scene, entity };
    }
    return null;
  }

  const systemName = (systemID) => {
    const row = typeof describeSystem === "function" ? safe(() => describeSystem(systemID)) : null;
    return row && row.name ? row.name : null;
  };

  function explainMissing(itemID) {
    const id = toPositiveInt(itemID);
    const scenes = sceneList(space);
    const loaded = scenes.map((scene) => toPositiveInt(scene.systemID)).filter(Boolean);
    const item = id && typeof describeItem === "function" ? safe(() => describeItem(id)) : null;
    const where = toPositiveInt(item && item.locationID);
    if (where) {
      const name = systemName(where);
      if (loaded.includes(where)) {
        return `Item ${id} is in ${name || `system ${where}`}, whose scene is loaded, but it is not an entity there ` +
          "(docked, in a hold, or not spawned in space).";
      }
      if (name) {
        return `Item ${id} is in ${name} (${where}), whose scene is not loaded, so nothing there can be read. ` +
          "A scene loads when a player enters the system or the server wakes it for NPC activity.";
      }
      return `Item ${id} is at location ${where} (a station, container or ship), not in a loaded scene.`;
    }
    const count = scenes.length;
    return `No entity ${id} in the ${count} loaded scene${count === 1 ? "" : "s"}` +
      `${loaded.length ? ` (systems ${loaded.slice(0, 8).join(", ")}${loaded.length > 8 ? ", ..." : ""})` : ""}. ` +
      (typeof describeItem === "function" ? "The item store has no such item. Check the ID."
        : "If its system's scene is not loaded it cannot be read: a scene loads when a player enters or the server wakes it for NPCs.");
  }

  return { find, explainMissing, scenes: () => sceneList(space) };
}

// ---------- capacitor ----------

function capacitorRatioOf(entity) {
  const ratio = finite(entity && entity.capacitorChargeRatio);
  return ratio === null ? null : Math.min(1, Math.max(0, ratio));
}

// 0-100 to one decimal, or null when the entity has no capacitor reading.
function capacitorPctOf(entity) {
  const ratio = capacitorRatioOf(entity);
  return ratio === null ? null : Math.round(ratio * 1000) / 10;
}

function describeCapacitor(entity) {
  const ratio = capacitorRatioOf(entity);
  const capacity = finite(entity && entity.capacitorCapacity);
  if (ratio === null && capacity === null) return null;
  return {
    ratio,
    pct: ratio === null ? null : Math.round(ratio * 1000) / 10,
    capacity,
    amount: ratio !== null && capacity !== null ? Math.round(capacity * ratio * 10) / 10 : null,
    // Dogma attribute rechargeRate: the full recharge time, in milliseconds.
    rechargeMs: finite(entity && entity.capacitorRechargeRate),
  };
}

// ---------- module effects ----------

function effectEntries(entity) {
  const effects = entity && entity.activeModuleEffects;
  return effects instanceof Map ? [...effects.entries()] : null;
}

function nameFor(describeType, typeID) {
  if (!typeID || typeof describeType !== "function") return null;
  return safe(() => describeType(typeID)) || null;
}

// The short form a grid row carries.
function activeModulesOf(entity, describeType = null) {
  const entries = effectEntries(entity);
  if (!entries) return [];
  return entries.filter(([, effect]) => effect && typeof effect === "object").map(([moduleID, effect]) => {
    const typeName = nameFor(describeType, toPositiveInt(effect.typeID));
    const effectName = effect.effectName ? String(effect.effectName) : null;
    return {
      moduleID: finite(effect.moduleID) !== null ? Number(effect.moduleID) : Number(moduleID),
      name: typeName || effectName,
      effectName,
      targetID: toPositiveInt(effect.targetID) || null,
    };
  });
}

// moduleID -> { state, moduleName }, holding the live effect objects so a
// later sample can still read the stopReason of one that has left the Map.
// null when the entity has no effects Map at all (nothing to compare).
function effectStatesOf(entity, describeType = null) {
  const entries = effectEntries(entity);
  if (!entries) return null;
  const states = new Map();
  for (const [moduleID, effect] of entries) {
    if (!effect || typeof effect !== "object") continue;
    const typeName = nameFor(describeType, toPositiveInt(effect.typeID));
    states.set(Number(moduleID), { state: effect, moduleName: typeName || (effect.effectName ? String(effect.effectName) : null) });
  }
  return states;
}

// The whole effect state, with times as "in N ms" from the scene's clock.
function describeEffect(moduleID, effect, { simNowMs, describeType = null } = {}) {
  const typeID = toPositiveInt(effect.typeID) || null;
  const startedAtMs = realTime(effect.startedAtMs);
  const nextCycleAtMs = realTime(effect.nextCycleAtMs);
  return {
    moduleID: finite(effect.moduleID) !== null ? Number(effect.moduleID) : Number(moduleID),
    typeID,
    typeName: nameFor(describeType, typeID),
    groupID: toPositiveInt(effect.groupID) || null,
    effectName: effect.effectName ? String(effect.effectName) : null,
    effectID: finite(effect.effectID),
    targetID: toPositiveInt(effect.targetID) || null,
    startedAtMs,
    runningMs: startedAtMs !== null ? Math.max(0, Math.round(simNowMs - startedAtMs)) : null,
    durationMs: finite(effect.durationMs),
    nextCycleAtMs,
    nextCycleInMs: nextCycleAtMs !== null ? Math.round(nextCycleAtMs - simNowMs) : null,
    repeat: finite(effect.repeat),
    remainingCycles: finite(effect.remainingCycles),
    capNeed: finite(effect.capNeed),
    deactivationRequestedAtMs: realTime(effect.deactivationRequestedAtMs),
    deactivateAtMs: realTime(effect.deactivateAtMs),
    stopReason: effect.stopReason ? String(effect.stopReason) : null,
  };
}

function describeFittedModules(entity, describeType = null) {
  const list = Array.isArray(entity && entity.fittedItems) ? entity.fittedItems
    : Array.isArray(entity && entity.fittedModules) ? entity.fittedModules : null;
  if (!list) return null;
  return list.filter((item) => item && typeof item === "object").map((item) => ({
    itemID: toPositiveInt(item.itemID) || null,
    typeID: toPositiveInt(item.typeID) || null,
    typeName: nameFor(describeType, toPositiveInt(item.typeID)),
    flagID: finite(item.flagID),
  }));
}

// ---------- locks ----------

function describeLocks(entity, simNowMs) {
  const locked = entity && entity.lockedTargets instanceof Map
    ? [...entity.lockedTargets.keys()].map(Number).filter((id) => id > 0) : [];
  const pending = entity && entity.pendingTargetLocks instanceof Map
    ? [...entity.pendingTargetLocks.entries()].map(([targetID, lock]) => {
      const completeAtMs = realTime(lock && lock.completeAtMs);
      return {
        targetID: Number(targetID),
        completeInMs: completeAtMs !== null ? Math.round(completeAtMs - simNowMs) : null,
        totalDurationMs: finite(lock && lock.totalDurationMs),
      };
    }) : [];
  const lockedBy = entity && entity.targetedBy instanceof Set
    ? [...entity.targetedBy].map(Number).filter((id) => id > 0) : [];
  return { locked, pending, lockedBy };
}

// ---------- NPC controller ----------

const SCALAR = new Set(["string", "number", "boolean"]);
// Named in the summary itself, so left out of fields.
const NAMED = new Set(["runtimeKind", "entityType", "lastDecision", "currentTargetID", "preferredTargetID",
  "controllerPaused", "pausedReason", "controllerLifecycleState", "nextThinkAtMs"]);

function nestedNote(value) {
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (value instanceof Map || value instanceof Set) return `${value instanceof Map ? "map" : "set"} of ${value.size}`;
  const keys = Object.keys(value);
  return `object, ${keys.length} key${keys.length === 1 ? "" : "s"}${keys.length ? `: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}` : ""}`;
}

// Scalars as they are, nested values as a one-line note. The few fields an
// agent asks about first (decision, targets, pause, next think) are named.
function describeController(controller, simNowMs) {
  if (!controller || typeof controller !== "object") return null;
  const fields = {};
  const nested = {};
  for (const [key, value] of Object.entries(controller)) {
    if (typeof value === "function" || NAMED.has(key)) continue;
    if (value === null || value === undefined || SCALAR.has(typeof value)) {
      fields[key] = value === undefined ? null : value;
    } else if (Array.isArray(value) && value.length <= 8 && value.every((item) => SCALAR.has(typeof item))) {
      fields[key] = value;
    } else if (typeof value === "object") {
      nested[key] = nestedNote(value);
    }
  }
  const nextThinkAtMs = realTime(controller.nextThinkAtMs);
  return {
    runtimeKind: controller.runtimeKind || null,
    entityType: controller.entityType || null,
    decision: typeof controller.lastDecision === "string" ? controller.lastDecision : null,
    currentTargetID: toPositiveInt(controller.currentTargetID) || null,
    preferredTargetID: toPositiveInt(controller.preferredTargetID) || null,
    paused: controller.controllerPaused === true,
    pausedReason: controller.pausedReason ? String(controller.pausedReason) : null,
    lifecycleState: controller.controllerLifecycleState ? String(controller.controllerLifecycleState) : null,
    nextThinkAtMs,
    nextThinkInMs: nextThinkAtMs !== null ? Math.round(nextThinkAtMs - simNowMs) : null,
    fields,
    nested,
  };
}

module.exports = {
  NEVER_MS,
  activeModulesOf,
  capacitorPctOf,
  capacitorRatioOf,
  createEntityLocator,
  describeCapacitor,
  describeController,
  describeEffect,
  describeFittedModules,
  describeLocks,
  effectStatesOf,
  finite,
  realTime,
  safe,
  simTimeOf,
  speedOf,
  toPositiveInt,
  vectorOf,
};
