"use strict";

// What one character's session can see, as rows an agent can read: the web
// gateway's own ball projection plus a type name, a surface distance from the
// character's ship, and the ship's protection window. Sorted nearest first.
//
// Read-only. It calls the scene's visibility query the gateway's snapshot
// calls and never steps or mutates the scene.

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

// The same fields and the same rule hunterIntel.observable reads, so "why has
// the scout not seen me" has an answer on the grid itself. Timestamps are scene
// sim time (transitions.js stamps them from getCurrentSimTimeMs).
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

function createGridReader({ space, projectEntity, describeType, describeSystem }) {
  if (!space || typeof space.getSceneForSession !== "function") {
    throw new TypeError("createGridReader needs a space runtime with getSceneForSession");
  }
  if (typeof projectEntity !== "function") {
    throw new TypeError("createGridReader needs projectEntity");
  }
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

  // options.annotate(row, entity) lets a caller add fields from the live
  // entity, which the gateway projection leaves out. `e2e watch` uses it.
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
      if (annotate) annotate(row, entity);
      rows.push(row);
    }
    if (ego && !sawSelf) {
      const row = projectEntity(ego, egoItemID);
      if (row) {
        row.typeName = typeName(row.typeID);
        row.distanceMeters = 0;
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

  return { readGrid };
}

module.exports = {
  createGridReader,
  describeProtection,
  surfaceDistanceMeters,
};
