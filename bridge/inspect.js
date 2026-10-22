"use strict";

// `gridcheck inspect <itemID>`, server side: one entity, from whichever loaded
// scene holds it, with what the grid leaves out: its capacitor, every running
// module effect, its locks, its NPC controller and the plugins' data. It needs
// no character, so reading a ship does not put an observer in its system.
//
// Read-only. Times that are scene clock readings (effect starts, the next
// cycle, the controller's next think) are given as they are and as "in N ms"
// from the scene's own clock, which is not the wall clock.

const {
  describeCapacitor,
  describeController,
  describeEffect,
  describeFittedModules,
  describeLocks,
  finite,
  safe,
  simTimeOf,
  speedOf,
  toPositiveInt,
  vectorOf,
} = require("./entities");

// annotate(row, entity): the active plugins' annotate hooks (entry.js).
// controllerFor(itemID): the NPC controller, when the tree has one.
function createInspector({ locate, projectEntity = null, describeType = null, describeSystem = null,
  controllerFor = null, annotate = null }) {
  if (!locate || typeof locate.find !== "function") throw new TypeError("createInspector needs a locator");
  const typeName = (typeID) => (typeID && typeof describeType === "function" ? safe(() => describeType(typeID)) : null);

  function inspect(itemID) {
    const id = toPositiveInt(itemID);
    if (!id) return { statusCode: 400, body: { ok: false, error: "A positive itemID is required." } };
    const found = locate.find(id);
    if (!found) return { statusCode: 404, body: { ok: false, error: locate.explainMissing(id) } };
    const { scene, entity } = found;
    const simNowMs = simTimeOf(scene);
    const base = (typeof projectEntity === "function" ? safe(() => projectEntity(entity, 0)) : null) || {};
    const systemID = toPositiveInt(scene.systemID) || toPositiveInt(entity.systemID) || null;
    const system = systemID && typeof describeSystem === "function" ? safe(() => describeSystem(systemID)) : null;
    const typeID = toPositiveInt(base.typeID) || toPositiveInt(entity.slimTypeID) || toPositiveInt(entity.typeID) || null;
    const velocity = vectorOf(base.velocity) || vectorOf(entity.velocity);

    const row = {
      ...base,
      itemID: id,
      typeName: typeName(typeID),
      kind: base.kind || (typeof entity.kind === "string" ? entity.kind : null),
    };
    if (typeof annotate === "function") safe(() => annotate(row, entity));

    const controller = typeof controllerFor === "function" ? safe(() => controllerFor(id)) : null;
    const effects = entity.activeModuleEffects instanceof Map
      ? [...entity.activeModuleEffects.entries()].filter(([, effect]) => effect && typeof effect === "object")
        .map(([moduleID, effect]) => describeEffect(moduleID, effect, { simNowMs, describeType }))
      : [];

    return {
      statusCode: 200,
      body: {
        ok: true,
        entity: {
          itemID: id,
          name: base.name || String(entity.slimName || entity.itemName || "") || null,
          kind: row.kind,
          typeID,
          typeName: row.typeName,
          groupID: toPositiveInt(base.groupID) || toPositiveInt(entity.slimGroupID) || toPositiveInt(entity.groupID) || null,
          categoryID: toPositiveInt(base.categoryID) || toPositiveInt(entity.slimCategoryID) || toPositiveInt(entity.categoryID) || null,
          systemID,
          systemName: system && system.name ? system.name : null,
          simTimeMs: simNowMs,
          mode: typeof entity.mode === "string" ? entity.mode : null,
          position: vectorOf(base.position) || vectorOf(entity.position),
          velocity,
          speed: speedOf({ velocity }),
          maxVelocity: finite(base.maxVelocity) || finite(entity.maxVelocity),
          radius: finite(base.radius) !== null ? base.radius : finite(entity.radius),
          shieldRatio: finite(base.shieldRatio),
          armorRatio: finite(base.armorRatio),
          hullRatio: finite(base.hullRatio),
          ownerID: toPositiveInt(base.ownerID) || toPositiveInt(entity.ownerID) || null,
          corporationID: toPositiveInt(base.corporationID) || toPositiveInt(entity.corporationID) || null,
          characterID: toPositiveInt(base.characterID) || toPositiveInt(entity.characterID) || null,
          allianceID: toPositiveInt(base.allianceID) || toPositiveInt(entity.allianceID) || null,
          isNpc: base.isNpc === true || entity.nativeNpc === true,
          npcEntityType: base.npcEntityType || (typeof entity.npcEntityType === "string" ? entity.npcEntityType : null),
          targetEntityID: toPositiveInt(base.targetEntityID) || toPositiveInt(entity.targetEntityID) || null,
          capacitor: describeCapacitor(entity),
          activeModules: effects,
          fittedModules: describeFittedModules(entity, describeType),
          locks: describeLocks(entity, simNowMs),
          controller: describeController(controller, simNowMs),
          ext: row.ext || null,
          groupKey: row.groupKey || null,
        },
      },
    };
  }

  return { inspect };
}

module.exports = { createInspector };
