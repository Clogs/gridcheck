"use strict";

// What one character's session can see, as rows an agent can read: the web
// gateway's own ball projection plus a type name, a surface distance from the
// character's ship, and the ship's protection window. Sorted nearest first.
//
// Read-only. It calls the scene's visibility query the gateway's snapshot
// calls and never steps or mutates the scene.
//
// readGridAt reads the same rows around any entity instead, with no session:
// nobody has to be logged in to the system, so reading it adds no player to it.

const { activeModulesOf, capacitorPctOf, createEntityLocator, simTimeOf } = require("./entities");

// How far from the anchor readGridAt looks: the stock public-grid box.
const AT_RANGE_METERS = 7_864_320;

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function surfaceDistanceMeters(from, to) {
  const a = from && from.position;
  const b = to && to.position;
  if (!a || !b) return null;
  const dx = Number(b.x) - Number(a.x);
  const dy = Number(b.y) - Number(a.y);
  const dz = Number(b.z) - Number(a.z);
  const centre = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(centre)) return null;
  return Math.max(0, centre - (Number(from.radius) || 0) - (Number(to.radius) || 0));
}

// Whether the ship can be seen and shot yet: its undock and timed
// invulnerability and its cloak, so "why has nothing noticed me" has an answer
// on the grid itself. Timestamps are scene sim time (transitions.js stamps
// them from getCurrentSimTimeMs).
function describeProtection(entity, simNowMs) {
  if (!entity) return null;
  const untilMs = Math.max(
    Number(entity.timedInvulnerabilityUntilMs) || 0,
    Number(entity.undockInvulnerabilityUntilMs) || 0,
  );
  const timed = untilMs > 0
    ? untilMs > simNowMs
    : entity.timedInvulnerabilityActive === true || entity.undockInvulnerabilityActive === true;
  const flagged = entity.invulnerable === true || entity.isInvulnerable === true;
  const cloaked = Boolean(entity.isCloaked || entity.cloakMode || entity.cloaked);
  return {
    active: timed || flagged,
    untilMs: untilMs > 0 ? untilMs : null,
    remainingMs: untilMs > simNowMs ? untilMs - simNowMs : 0,
    cloaked,
  };
}

// npcDecision(entity): the branch an NPC's last think took, where the tree
// records one (the last-decision patch), else null.
// locate: the entity locator readGridAt finds its anchor with (entities.js).
function createGridReader({ space, projectEntity, describeType, describeSystem, npcDecision = null, locate = null }) {
  if (!space || typeof space.getSceneForSession !== "function") {
    throw new TypeError("createGridReader needs a space runtime with getSceneForSession");
  }
  if (typeof projectEntity !== "function") {
    throw new TypeError("createGridReader needs projectEntity");
  }
  const locator = locate || createEntityLocator({ space, describeSystem });
  const typeName = (typeID) => {
    if (!typeID || typeof describeType !== "function") return null;
    try {
      return describeType(typeID) || null;
    } catch (_error) {
      return null;
    }
  };
  const systemInfo = (systemID) => {
    if (!systemID || typeof describeSystem !== "function") return { name: null, security: null };
    try {
      return describeSystem(systemID) || { name: null, security: null };
    } catch (_error) {
      return { name: null, security: null };
    }
  };

  // What the gateway projection leaves out and a ship's state turns on: the
  // capacitor and the modules running. Other entities get neither key.
  function addRuntimeFields(row, entity) {
    const capacitorPct = capacitorPctOf(entity);
    if (capacitorPct === null && entity.kind !== "ship" && !(entity.activeModuleEffects instanceof Map)) return;
    row.capacitorPct = capacitorPct;
    row.activeModules = activeModulesOf(entity, describeType);
  }

  // options.annotate(row, entity) lets a caller add fields from the live
  // entity, which the gateway projection leaves out. `gridcheck watch` uses it.
  function readGrid(session, options = {}) {
    const annotate = typeof options.annotate === "function" ? options.annotate : null;
    const spaceState = session && session._space && typeof session._space === "object"
      ? session._space
      : null;
    const solarSystemID = toPositiveInt(
      (spaceState && spaceState.systemID) || session.solarsystemid2 || session.solarsystemid,
    );
    const system = systemInfo(solarSystemID);
    const grid = {
      characterID: toPositiveInt(session.characterID || session.charid),
      characterName: String(session.characterName || "") || null,
      solarSystemID: solarSystemID || null,
      systemName: system.name,
      security: system.security,
      stationID: toPositiveInt(session.stationid || session.stationID) || null,
      structureID: toPositiveInt(session.structureid || session.structureID) || null,
      inSpace: Boolean(spaceState),
      sampledAtMs: Date.now(),
      self: null,
      entities: [],
    };
    if (!spaceState) return grid;

    const scene = space.getSceneForSession(session);
    if (!scene) return grid;
    const ego = typeof scene.getShipEntityForSession === "function"
      ? scene.getShipEntityForSession(session)
      : null;
    const visible = typeof scene.getVisibleEntitiesForSession === "function"
      ? scene.getVisibleEntitiesForSession(session) || []
      : [];
    const simNowMs = typeof scene.getCurrentSimTimeMs === "function"
      ? Number(scene.getCurrentSimTimeMs()) || grid.sampledAtMs
      : grid.sampledAtMs;
    grid.sampledAtMs = simNowMs;
    const egoItemID = toPositiveInt(ego && ego.itemID);

    const rows = [];
    let sawSelf = false;
    for (const entity of visible) {
      const row = projectEntity(entity, egoItemID);
      if (!row) continue;
      if (row.isSelf) sawSelf = true;
      row.typeName = typeName(row.typeID);
      row.distanceMeters = row.isSelf ? 0 : surfaceDistanceMeters(ego, entity);
      if (npcDecision && row.isNpc) {
        const decision = npcDecision(entity);
        if (decision) row.decision = decision;
      }
      addRuntimeFields(row, entity);
      if (annotate) annotate(row, entity);
      rows.push(row);
    }
    if (ego && !sawSelf) {
      const row = projectEntity(ego, egoItemID);
      if (row) {
        row.typeName = typeName(row.typeID);
        row.distanceMeters = 0;
        addRuntimeFields(row, ego);
        if (annotate) annotate(row, ego);
        rows.push(row);
      }
    }
    rows.sort((left, right) => {
      const l = left.distanceMeters === null ? Infinity : left.distanceMeters;
      const r = right.distanceMeters === null ? Infinity : right.distanceMeters;
      return l - r || left.itemID - right.itemID;
    });
    grid.entities = rows;

    if (ego) {
      const selfRow = rows.find((row) => row.isSelf) || null;
      grid.self = {
        itemID: egoItemID || null,
        typeID: selfRow ? selfRow.typeID : null,
        typeName: selfRow ? selfRow.typeName : null,
        name: selfRow ? selfRow.name : null,
        mode: typeof ego.mode === "string" ? ego.mode : null,
        protection: describeProtection(ego, simNowMs),
      };
    }
    return grid;
  }

  // The grid around one entity, read from its scene with no session. Stock
  // decides what a session sees from its public grid, bubbles and dungeon
  // scopes; this takes what lies within options.rangeMeters of the anchor,
  // dynamic and static entities alike, cloaked ones too. The anchor takes the
  // "self" part for distances but is marked anchor: true, with isSelf false on
  // every row, so nothing reads it as a player's ship. null: no such entity.
  function readGridAt(anchorItemID, options = {}) {
    const annotate = typeof options.annotate === "function" ? options.annotate : null;
    const found = locator.find(anchorItemID);
    if (!found) return null;
    const { scene, entity: anchor } = found;
    const rangeMeters = Number(options.rangeMeters) > 0 ? Number(options.rangeMeters) : AT_RANGE_METERS;
    const solarSystemID = toPositiveInt(scene.systemID) || toPositiveInt(anchor.systemID);
    const system = systemInfo(solarSystemID);
    const simNowMs = simTimeOf(scene);
    const anchorID = toPositiveInt(anchor.itemID);

    const candidates = [];
    if (Array.isArray(scene.staticEntities)) candidates.push(...scene.staticEntities);
    if (scene.dynamicEntities && typeof scene.dynamicEntities.values === "function") {
      candidates.push(...scene.dynamicEntities.values());
    }
    const rows = [];
    const seen = new Set();
    for (const entity of candidates) {
      if (!entity || typeof entity !== "object") continue;
      const isAnchor = toPositiveInt(entity.itemID) === anchorID;
      const distance = isAnchor ? 0 : surfaceDistanceMeters(anchor, entity);
      if (!isAnchor && (distance === null || distance > rangeMeters)) continue;
      const row = projectEntity(entity, 0);
      if (!row || seen.has(row.itemID)) continue;
      seen.add(row.itemID);
      row.isSelf = false;
      if (isAnchor) row.anchor = true;
      row.typeName = typeName(row.typeID);
      row.distanceMeters = distance;
      if (npcDecision && row.isNpc) {
        const decision = npcDecision(entity);
        if (decision) row.decision = decision;
      }
      addRuntimeFields(row, entity);
      if (annotate) annotate(row, entity);
      rows.push(row);
    }
    rows.sort((left, right) => {
      const l = left.distanceMeters === null ? Infinity : left.distanceMeters;
      const r = right.distanceMeters === null ? Infinity : right.distanceMeters;
      return l - r || left.itemID - right.itemID;
    });
    const anchorRow = rows.find((row) => row.anchor) || null;
    return {
      characterID: null,
      characterName: null,
      solarSystemID: solarSystemID || null,
      systemName: system.name,
      security: system.security,
      stationID: null,
      structureID: null,
      inSpace: true,
      sampledAtMs: simNowMs,
      rangeMeters,
      anchor: {
        itemID: anchorID || null,
        kind: anchorRow ? anchorRow.kind : null,
        typeID: anchorRow ? anchorRow.typeID : null,
        typeName: anchorRow ? anchorRow.typeName : null,
        name: anchorRow ? anchorRow.name : null,
        mode: typeof anchor.mode === "string" ? anchor.mode : null,
        protection: describeProtection(anchor, simNowMs),
      },
      self: null,
      entities: rows,
    };
  }

  return { readGrid, readGridAt };
}

module.exports = {
  AT_RANGE_METERS,
  createGridReader,
  describeProtection,
  surfaceDistanceMeters,
};
