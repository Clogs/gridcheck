"use strict";

// Records which branch an NPC's think took (controller.lastDecision), so a
// watch can say why an NPC did what it did: grid rows carry it as `decision`,
// and DECISION events report a change. One string write per think, on the NPC
// hot path, so it stays optional.
//
// One hunk per way out of stock's tickController (space/npc/npcBehaviorLoop.js),
// named as the LU fork names the same branches. Each lands at the top of its
// branch, or just before its return when the label depends on what the branch
// did. The early return for a ship that has gone records nothing.

const TARGET = "space/npc/npcBehaviorLoop.js";

function set(indent, value) {
  return [`${" ".repeat(indent)}controller.lastDecision = ${value};`];
}

module.exports = {
  id: "last-decision",
  version: 1,
  title: "NPC controllers record their last decision",
  hunks: [
    { file: TARGET, anchor: ["if (manualOrder && manualOrder.type === \"stop\") {", "clearNpcCombatState(scene, entity, controller, {"],
      insert: "after", at: 0, lines: set(4, "\"order-stop\"") },
    { file: TARGET, anchor: ["if (manualOrder && manualOrder.type === \"returnHome\") {", "clearNpcCombatState(scene, entity, controller, {"],
      insert: "after", at: 0, lines: set(4, "\"order-return-home\"") },
    { file: TARGET, anchor: ["const maintainedAssistance = syncNpcAssistanceModules(scene, entity, controller);",
      "if (maintainedAssistance) {"], insert: "after", lines: set(6, "\"assist\"") },
    { file: TARGET, anchor: ["if (drifterTravel && drifterTravel.handled === true) {"], insert: "after",
      lines: set(6, "\"drifter-travel\"") },
    { file: TARGET, anchor: ["if (idleAnchorWarp && idleAnchorWarp.handled === true) {"], insert: "after",
      lines: set(8, "\"idle-anchor-warp\"") },
    { file: TARGET, anchor: ["const handledIdleAnchorOrbit = syncNpcIdleAnchorOrbit(", "scene,", "entity,", "controller,",
      "behaviorProfile,", ");"], insert: "after",
    lines: set(6, "handledIdleAnchorOrbit ? \"idle-anchor-orbit\" : \"idle-return-home\"") },
    // A manual attack, orbit or follow whose target is gone holds where it is.
    { file: TARGET, anchor: ["scheduleNextThink(controller, behaviorProfile, now);", "return;", "}", "",
      "controller.lastCombatTickAtMs = now;"], insert: "before",
    lines: ["    if (targetOnlyManualOrder) controller.lastDecision = \"order-hold\";"] },
    { file: TARGET, anchor: ["if (isBeyondLeash(entity, controller, behaviorProfile)) {"], insert: "after",
      lines: set(4, "\"leash-return\"") },
    { file: TARGET, anchor: ["scheduleNextThink(controller, behaviorProfile, now, nextThinkOverrideMs, {"], insert: "before",
      lines: set(2, "\"engage\"") },
  ],
  detect({ read }) {
    const text = read(TARGET);
    return text !== null && /\blastDecision\s*=/.test(text);
  },
};
