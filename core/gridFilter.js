"use strict";

// `gridcheck grid --json` with filters: rows within a range, of one kind, only
// NPCs, and only some keys of each row. A grid's JSON runs to hundreds of KB in
// a busy system; these cut it to what the question needs. No filter, no change.

// The keys a row can carry: the gateway's projection (projectSpaceEntity),
// what the bridge adds, and the plugins' data.
const GRID_FIELDS = Object.freeze([
  "kind", "itemID", "typeID", "groupID", "categoryID", "name", "ownerID", "radius", "position", "velocity", "isSelf",
  "shieldRatio", "armorRatio", "hullRatio", "characterID", "corporationID", "allianceID", "securityStatus",
  "maxVelocity", "mode", "targetEntityID", "capacitorRatio", "isNpc", "npcEntityType", "compressionFacility",
  "controllerID", "controllerOwnerID", "droneActivity", "miningYieldTypeID", "beltID", "remainingQuantity",
  "typeName", "distanceMeters", "decision", "capacitorPct", "activeModules", "anchor", "groupKey", "ext",
  "lockedTargetIDs",
]);

// "a,b,c" -> ["a", "b", "c"]; an unknown name is an error that lists the valid ones.
function parseFields(text) {
  const names = String(text === undefined || text === null ? "" : text).split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new Error(`--fields takes field names, e.g. itemID,name,capacitorPct. Valid fields: ${GRID_FIELDS.join(", ")}`);
  const unknown = names.filter((name) => !GRID_FIELDS.includes(name));
  if (unknown.length) {
    throw new Error(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Valid fields: ${GRID_FIELDS.join(", ")}`);
  }
  return [...new Set(names)];
}

const focal = (row) => row.isSelf === true || row.anchor === true;

// options: { rangeKm, kind, npc, fields: [names], all }. The ship (or anchor)
// the distances are from always stays. `filtered` says what was cut. A row
// without a named field has it as null.
function filterGrid(grid, options = {}) {
  const wantsRange = options.rangeKm !== undefined && options.rangeKm !== null && !options.all;
  const kind = options.kind ? String(options.kind).toLowerCase() : null;
  const fields = Array.isArray(options.fields) && options.fields.length ? options.fields : null;
  if (!wantsRange && !kind && !options.npc && !fields) return grid;
  const rows = Array.isArray(grid.entities) ? grid.entities : [];
  const rangeMeters = wantsRange ? Number(options.rangeKm) * 1000 : null;
  const kept = rows.filter((row) => {
    if (focal(row)) return true;
    if (rangeMeters !== null && !(row.distanceMeters !== null && row.distanceMeters !== undefined && row.distanceMeters <= rangeMeters)) return false;
    if (kind && String(row.kind || "").toLowerCase() !== kind) return false;
    if (options.npc && row.isNpc !== true) return false;
    return true;
  });
  const entities = fields
    ? kept.map((row) => Object.fromEntries(fields.map((name) => [name, name in row ? row[name] : null])))
    : kept;
  return { ...grid, entities, filtered: { rows: entities.length, of: rows.length } };
}

module.exports = { GRID_FIELDS, filterGrid, parseFields };
