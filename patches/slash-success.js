"use strict";

// Stock EveJS's slash commands answer { handled, message } and never say
// whether they did what was asked, so the tool can't tell a refusal from a
// success (the survey is in docs/PATCHES.md). This patch makes the commands
// the tool and its scenarios drive say so, with insertions only:
//
//   commandReplies.js  reportsOutcome(options) and doneOptions(options) mark a
//                      copy of the options a command answers with, and
//                      handledResult adds success: true or false when marked.
//   chatCommands.js    the dispatcher marks the commands below as reporting.
//   each handler       one `options = doneOptions(options)` before each way it
//                      succeeds, so every other way out reads as refused.
//
// Every other command still answers without `success`, which the bridge
// reports as unknown, not refused. The LU fork has its own (rejectedResult),
// so `detect` finds that.

const REPLIES = "services/chat/commands/commandReplies.js";
const DISPATCH = "services/chat/chatCommands.js";
const COMMANDS = ["tr", "dock", "heal", "npc", "concord", "npcclear", "gaterats", "naughty", "allskills", "giveskill",
  "giveskills", "fit", "unfit"];

function at(file) {
  return `services/chat/commands/${file}`;
}

// The handler files import from commandReplies inside a destructure that
// ends on its own line.
function importDone(file) {
  return { file: at(file), anchor: ["handledResult,", "} = require(path.join(__dirname, \"./commandReplies\"));"],
    insert: "after", at: 0, lines: ["  doneOptions,"] };
}

function done(file, anchor, { indent = 2, at: index = 0, insert = "before" } = {}) {
  return { file: at(file), anchor, insert, at: index, lines: [`${" ".repeat(indent)}options = doneOptions(options);`] };
}

const RETURN = ["return handledResult(", "chatHub,"];

module.exports = {
  id: "slash-success",
  version: 1,
  title: "Slash commands the tool drives say whether they refused",
  headline: "Know when a slash command refused",
  gain: "A refused command fails the scenario or `gridcheck slash` call instead of passing quietly. Covers the commands Gridcheck uses:",
  without: "Stock commands never say whether they worked. Gridcheck reports `done (this tree doesn't say whether it refused)` and carries on.",
  commands: COMMANDS,
  hunks: [
    { file: REPLIES, anchor: ["function handledResult(chatHub, session, options, message) {"], insert: "before", lines: [
      "const SLASH_OUTCOME = Symbol.for(\"evejs-e2e.slashOutcome\");",
      "function reportsOutcome(options) {",
      "  return { ...(options || {}), [SLASH_OUTCOME]: false };",
      "}",
      "function doneOptions(options) {",
      "  return options && options[SLASH_OUTCOME] === false ? { ...options, [SLASH_OUTCOME]: true } : options;",
      "}",
      "",
    ] },
    { file: REPLIES, anchor: ["return {", "handled: true,", "message,"], insert: "after", at: 1, lines: [
      "    ...(options && typeof options[SLASH_OUTCOME] === \"boolean\" ? { success: options[SLASH_OUTCOME] } : {}),",
    ] },
    { file: REPLIES, anchor: ["module.exports = {", "getFeedbackChannel,", "emitChatFeedback,", "handledResult,"], insert: "after",
      lines: ["  reportsOutcome,", "  doneOptions,"] },

    { file: DISPATCH, anchor: ["handledResult,", "} = require(path.join(__dirname, \"./commands/commandReplies\"));"],
      insert: "after", at: 0, lines: ["  reportsOutcome,"] },
    { file: DISPATCH, anchor: ["const command = normalizeCommandName(commandName);"], insert: "after", lines: [
      `  if (${JSON.stringify(COMMANDS).replace(/,/g, ", ")}.includes(command)) {`,
      "    options = reportsOutcome(options);",
      "  }",
    ] },

    importDone("transport.js"),
    // /tr on a character: a local move, then any other move.
    done("transport.js", ["flushPendingLocalChannelSync(chatHub, requestSession);", ...RETURN, "requestSession,",
      "getPostLocalMoveFeedbackOptions(options),"], { indent: 4, at: 1 }),
    done("transport.js", [...RETURN, "requestSession,", "options,", "`Transported ${targetLabel} to ${destinationLabel}.`,"]),
    // /tr on a runtime entity or a point.
    done("transport.js", [...RETURN, "session,", "options,", "`Transported ${targetLabel} to ${destinationLabel}.`,"]),
    // /dock: already there counts.
    done("transport.js", [...RETURN, "session,", "options,", "`Already docked at home station ${homeStationID}.`,"], { indent: 4 }),
    done("transport.js", ["flushPendingLocalChannelSync(chatHub, session);", ...RETURN, "session,",
      "getPostLocalMoveFeedbackOptions(options),", "`Docked at ${station ? station.stationName : `station ${homeStationID}`}.`,"],
    { at: 1 }),

    importDone("shipHealth.js"),
    done("shipHealth.js", ["return handledResult(chatHub, session, options, message);", "}", "", "return handledResult(",
      "chatHub,", "session,", "options,",
      "\"Restored full shields, armor, hull, capacitor, and fitted modules on your active ship.\","], { indent: 4, at: 3 }),
    done("shipHealth.js", ["\"Active ship not found.\",", ");", "}", "", "return handledResult("], { at: 4 }),

    importDone("npcCommands.js"),
    done("npcCommands.js", [...RETURN, "session,", "options,", "formatNpcSpawnSummary(result, \"/npc\"),"]),
    done("npcCommands.js", [...RETURN, "session,", "options,", "formatNpcSpawnSummary(result, \"/concord\"),"]),
    done("npcCommands.js", [...RETURN, "session,", "options,",
      "`Cleared ${result.data.destroyedCount} ${entityLabel} controller${result.data.destroyedCount === 1 ? \"\" : \"s\"} ${scopeText}.`,"]),
    // /gaterats; /gateconcord shares the handler but isn't marked, so this does nothing there.
    done("npcCommands.js", [...RETURN, "session,", "options,", "formatGateOperatorStatus(label, result.data),"]),

    importDone("crimewatch.js"),
    // /naughty: only an offense that was applied counts.
    done("crimewatch.js", ["securityPenalty && securityPenalty.applied === true",
      "? ` Security status is now ${Number(securityPenalty.nextSecurityStatus || 0).toFixed(2)}.`", ": \"\";",
      "return handledResult("], { at: 3 }),

    importDone("skills.js"),
    // /allskills; /gmskills and /removeskill have blocks shaped the same, so these anchors run long.
    done("skills.js", [...RETURN, "session,", "options,", "[", "grantedSkills.length > 0",
      "? `Ensured ${grantedSkills.length} published skills are at level V. You now have ${publishedSkillTypes.length}/${publishedSkillTypes.length}.`"]),
    done("skills.js", ["if (skillDescriptor.selector === \"all\") {", ...RETURN, "session,", "options,", "[",
      "`Set all published skills for ${targetLabel} to level ${normalizedLevelLabel}.`,"], { indent: 4, at: 1 }),
    done("skills.js", ["if (skillDescriptor.selector === \"super\") {", "return handledResult("], { indent: 4, at: 1 }),
    done("skills.js", ["const skillType = skillDescriptor.skillType;", ...RETURN, "session,", "options,", "[",
      "changedSkills.length > 0",
      "? `Set ${skillType.name}(${skillType.typeID}) for ${targetLabel} to level ${normalizedLevelLabel}.`"], { at: 1 }),

    // /fit and /unfit answer through one reply() for every outcome.
    { file: at("fitModule.js"), anchor: ["const { handledResult } = require(\"./commandReplies\");"], insert: "after",
      lines: ["const { doneOptions } = require(\"./commandReplies\");"] },
    done("fitModule.js", ["const offline = onlineState.online === false", "? ` Fitted offline: ${onlineState.reason}.`", ": \"\";"],
      { insert: "after", at: 2 }),
    { file: at("unfitModule.js"), anchor: ["const { handledResult } = require(\"./commandReplies\");"], insert: "after",
      lines: ["const { doneOptions } = require(\"./commandReplies\");"] },
    done("unfitModule.js", ["const destination = docked ? \"hangar\" : \"ship's cargo hold\";"], { insert: "after" }),
  ],
  detect({ read }) {
    const text = read(REPLIES);
    return text !== null && /\bfunction rejectedResult\b/.test(text) && /success/.test(text);
  },
};
