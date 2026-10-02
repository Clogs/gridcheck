"use strict";

// Pure text formatting for `gridcheck grid`. No IO, so tests can pin the output.

const AU_METERS = 149_597_870_700;
const DEFAULT_RANGE_KM = 10_000;

function formatDistance(meters) {
  if (meters === null || meters === undefined || !Number.isFinite(Number(meters))) return "?";
  const m = Number(meters);
  if (m === 0) return "0";
  if (m < 10_000) return `${Math.round(m).toLocaleString("en-US")} m`;
  if (m < 0.1 * AU_METERS) return `${Math.round(m / 1000).toLocaleString("en-US")} km`;
  return `${(m / AU_METERS).toFixed(1)} AU`;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function fit(text, width) {
  const value = String(text === null || text === undefined ? "" : text);
  // One column of the width is always the gap before the next column.
  return value.length > width - 1 ? `${value.slice(0, width - 2)}~ ` : value.padEnd(width);
}

function percent(ratio) {
  return ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))
    ? null
    : String(Math.round(Number(ratio) * 100));
}

function health(row) {
  const parts = [percent(row.shieldRatio), percent(row.armorRatio), percent(row.hullRatio)];
  return parts.every((part) => part === null) ? "-" : parts.map((part) => part || "-").join("/");
}

function whoIs(row) {
  if (row.isSelf) return "-";
  if (row.isNpc) return row.npcEntityType || "npc";
  if (row.kind === "ship" && row.characterID) return "player";
  return "-";
}

function targetLabel(targetID, byID, selfID) {
  if (!targetID) return "-";
  if (selfID && targetID === selfID) return "self";
  const target = byID.get(targetID);
  return target ? (target.name || target.typeName || `#${targetID}`) : `#${targetID}`;
}

function headerLine(grid, options = {}) {
  const place = grid.systemName || (grid.solarSystemID ? `system ${grid.solarSystemID}` : "unknown system");
  const security = Number.isFinite(Number(grid.security)) && grid.security !== null
    ? ` (${Number(grid.security).toFixed(1)})`
    : "";
  const clock = Number.isFinite(options.sinceMs) ? `  t+${formatClock(options.sinceMs)}` : "";
  if (!grid.inSpace) {
    const where = grid.stationID ? `docked in station ${grid.stationID}`
      : grid.structureID ? `docked in structure ${grid.structureID}` : "not in space";
    return `${place}${security}${clock}  self: ${grid.characterName || grid.characterID} (${where})`;
  }
  const self = grid.self || {};
  const ship = self.typeName || self.name || "ship";
  let line = `${place}${security}${clock}  self: ${ship} (in space, ${self.mode || "?"})`;
  const protection = self.protection;
  if (protection && protection.active) {
    line += protection.remainingMs > 0
      ? `  protected ${Math.ceil(protection.remainingMs / 1000)}s`
      : "  protected";
  }
  if (protection && protection.cloaked) line += "  cloaked";
  return line;
}

// options.all shows every row; otherwise rows beyond rangeKm are summarised in
// one footer line naming the nearest of them.
function formatGrid(grid, options = {}) {
  const lines = [headerLine(grid, options)];
  if (!grid.inSpace) return lines.join("\n");

  const rangeMeters = (Number.isFinite(options.rangeKm) ? options.rangeKm : DEFAULT_RANGE_KM) * 1000;
  const rows = Array.isArray(grid.entities) ? grid.entities : [];
  const shown = options.all
    ? rows
    : rows.filter((row) => row.isSelf || (row.distanceMeters !== null && row.distanceMeters <= rangeMeters));
  const hidden = rows.filter((row) => !shown.includes(row));
  const byID = new Map(rows.map((row) => [row.itemID, row]));
  const selfID = grid.self && grid.self.itemID;

  lines.push(`${fit("dist", 12)}${fit("name", 24)}${fit("type", 20)}${fit("who", 8)}${fit("mode", 9)}${fit("target", 18)}S/A/H`);
  for (const row of shown) {
    const name = row.isSelf ? `(self) ${row.name || row.typeName || ""}` : (row.name || row.typeName || `#${row.itemID}`);
    lines.push(
      fit(formatDistance(row.distanceMeters), 12) +
      fit(name, 24) +
      fit(row.typeName || row.kind || "-", 20) +
      fit(whoIs(row), 8) +
      fit(row.mode || "-", 9) +
      fit(targetLabel(row.targetEntityID, byID, selfID), 18) +
      health(row),
    );
  }
  if (hidden.length > 0) {
    const nearest = hidden[0];
    const rangeLabel = formatDistance(rangeMeters);
    lines.push(
      `+${hidden.length} beyond ${rangeLabel}; nearest ${nearest.name || nearest.typeName || `#${nearest.itemID}`} ` +
      `at ${formatDistance(nearest.distanceMeters)} (--all to list)`,
    );
  }
  return lines.join("\n");
}

module.exports = {
  AU_METERS,
  DEFAULT_RANGE_KM,
  formatClock,
  formatDistance,
  formatGrid,
};
