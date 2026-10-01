"use strict";

// Records which branch an NPC's think took (controller.lastDecision), so a
// watch can say why an NPC did what it did. One string write per think, so it
// stays optional.

const TARGET = "space/npc/npcBehaviorLoop.js";

module.exports = {
  id: "last-decision",
  version: 1,
  title: "NPC controllers record their last decision",
  files: [TARGET],
  detect({ read }) {
    const text = read(TARGET);
    return text !== null && /\blastDecision\s*=/.test(text);
  },
};
