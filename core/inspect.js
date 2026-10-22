"use strict";

// `gridcheck inspect <itemID>`: the bridge's entity record as a readable block.
// Pure text, no IO, so tests can pin it.

const { formatDistance } = require("./format");

function relative(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "?";
  const value = Math.round(Number(ms));
  return value >= 0 ? `in ${value} ms` : `${-value} ms ago`;
}

function ratioPct(ratio) {
  return ratio === null || ratio === undefined || !Number.isFinite(Number(ratio)) ? "-" : String(Math.round(Number(ratio) * 100));
}

function ids(list) {
  return list.length ? list.map((id) => `#${id}`).join(", ") : "none";
}

function short(value) {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function effectLines(effect) {
  const head = `  #${effect.moduleID} ${effect.typeName || effect.effectName || "?"}` +
    `${effect.effectName && effect.typeName ? ` (${effect.effectName})` : ""}` +
    `${effect.targetID ? ` on #${effect.targetID}` : ""}`;
  const timing = [
    effect.durationMs !== null ? `cycle ${effect.durationMs} ms` : null,
    effect.nextCycleInMs !== null ? `next ${relative(effect.nextCycleInMs)}` : null,
    effect.runningMs !== null ? `running ${effect.runningMs} ms` : null,
    effect.repeat !== null ? `repeat ${effect.repeat}` : null,
    effect.remainingCycles !== null ? `${effect.remainingCycles} cycles left` : null,
    effect.capNeed !== null ? `cap ${effect.capNeed}` : null,
  ].filter(Boolean).join(", ");
  const stopping = [
    effect.deactivationRequestedAtMs !== null ? `deactivation requested at ${effect.deactivationRequestedAtMs}` : null,
    effect.deactivateAtMs !== null ? `deactivates at ${effect.deactivateAtMs}` : null,
    effect.stopReason ? `stopReason ${effect.stopReason}` : null,
  ].filter(Boolean).join(", ");
  return [head, timing ? `      ${timing}` : null, stopping ? `      ${stopping}` : null].filter(Boolean);
}

function formatInspect(entity) {
  const lines = [];
  const where = entity.systemName ? `${entity.systemName} (${entity.systemID})` : entity.systemID ? `system ${entity.systemID}` : "?";
  lines.push(`#${entity.itemID} ${entity.name || entity.typeName || "?"}  ${entity.kind || "?"}  mode ${entity.mode || "-"}  in ${where}`);
  lines.push(`type ${entity.typeName || "?"} (${entity.typeID || "?"}), group ${entity.groupID || "-"}` +
    `${entity.isNpc ? `, NPC${entity.npcEntityType ? ` ${entity.npcEntityType}` : ""}` : ""}` +
    `${entity.targetEntityID ? `, target #${entity.targetEntityID}` : ""}`);
  lines.push(`owner ${entity.ownerID || "-"}, corp ${entity.corporationID || "-"}, character ${entity.characterID || "-"}`);
  const p = entity.position;
  lines.push(`position ${p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} m` : "?"}` +
    `  speed ${entity.speed === null || entity.speed === undefined ? "?" : `${entity.speed} m/s`}` +
    `${entity.maxVelocity ? ` (max ${Math.round(entity.maxVelocity)})` : ""}` +
    `${entity.radius ? `  radius ${formatDistance(entity.radius)}` : ""}`);
  lines.push(`S/A/H ${ratioPct(entity.shieldRatio)}/${ratioPct(entity.armorRatio)}/${ratioPct(entity.hullRatio)}`);

  const cap = entity.capacitor;
  lines.push(cap
    ? `capacitor ${cap.pct === null ? "?" : `${cap.pct}%`}` +
      `${cap.amount !== null && cap.capacity !== null ? ` (${cap.amount} of ${cap.capacity})` : cap.capacity !== null ? ` (capacity ${cap.capacity})` : ""}` +
      `${cap.rechargeMs ? `, recharge ${Math.round(cap.rechargeMs / 1000)} s` : ""}`
    : "capacitor: none on this entity");

  const locks = entity.locks || { locked: [], pending: [], lockedBy: [] };
  lines.push(`locks: ${ids(locks.locked)}` +
    `${locks.pending.length ? `; pending ${locks.pending.map((lock) => `#${lock.targetID} ${relative(lock.completeInMs)}`).join(", ")}` : ""}` +
    `${locks.lockedBy.length ? `; locked by ${ids(locks.lockedBy)}` : ""}`);

  const modules = entity.activeModules || [];
  lines.push(`modules running: ${modules.length}${modules.length ? "" : " (none)"}  [scene time ${entity.simTimeMs}]`);
  for (const effect of modules) lines.push(...effectLines(effect));
  if (Array.isArray(entity.fittedModules)) {
    lines.push(`fitted: ${entity.fittedModules.length}`);
    for (const item of entity.fittedModules) lines.push(`  #${item.itemID} ${item.typeName || item.typeID || "?"} flag ${item.flagID === null ? "-" : item.flagID}`);
  }

  const c = entity.controller;
  if (c) {
    lines.push(`controller: ${c.runtimeKind || "?"}${c.entityType ? ` ${c.entityType}` : ""}` +
      `  decision ${c.decision || "-"}` +
      `  target ${c.currentTargetID ? `#${c.currentTargetID}` : "-"}${c.preferredTargetID ? `, preferred #${c.preferredTargetID}` : ""}` +
      `  next think ${c.nextThinkInMs === null ? "never" : relative(c.nextThinkInMs)}` +
      `${c.paused ? `  PAUSED${c.pausedReason ? ` (${c.pausedReason})` : ""}` : ""}` +
      `${c.lifecycleState ? `  ${c.lifecycleState}` : ""}`);
    const scalars = Object.entries(c.fields || {}).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`);
    if (scalars.length) lines.push(`  ${scalars.join(", ")}`);
    const nested = Object.entries(c.nested || {}).map(([key, note]) => `${key} (${note})`);
    if (nested.length) lines.push(`  not shown: ${nested.join("; ")}`);
  } else {
    lines.push("controller: none");
  }

  for (const [plugin, data] of Object.entries(entity.ext || {})) {
    if (data !== null && data !== undefined) lines.push(`plugin ${plugin}: ${short(data)}`);
  }
  return lines.join("\n");
}

module.exports = { formatInspect };
