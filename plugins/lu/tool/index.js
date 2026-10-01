"use strict";

// The Living Universe plugin's tool half: what the CLI, the scenarios and the
// MCP server know about the mod. Contract: core/plugins.js.

const { COMMANDS, HANDLES, cmdTrigger } = require("./commands");
const { FORMAT, costText, ids, luTag, owner } = require("./format");
const triggers = require("./triggers");
const { worldHooks } = require("./world");

// A Living Universe NPC's flight, hunt and current decision, joined to its grid
// row (server/join.js) and carried on the core events about it.
const LU = {
  flightID: "id", actorID: "id", family: "str", faction: "str", corporation: "str", pirateRole: "str",
  phase: "str", journeyKind: "str", journeyStage: "str", huntID: "id", huntRole: "str", huntPhase: "str",
  huntReason: "str", decision: "str", order: { obj: { mode: "str", role: "str" } },
};
const FLIGHT = {
  flightID: "id", family: "str", faction: "str", corporation: "str", pirateRole: "str", phase: "str",
  count: "num", systemID: "id", systemName: "str",
};

// The off-grid tracker's events (server/offGrid.js), and SIGHTING from the
// hunter reports on a grid NPC.
const KINDS = {
  SIGHTING: {
    observerID: "id", observerLabel: "str", observerFlightID: "id", source: "str", certainty: "str",
    observedAtMs: "ms", distanceMeters: "m", lu: { obj: LU },
  },
  HUNT: {
    huntID: "id", phase: "str", reason: "str", source: "str", targetSelf: "bool", targetLabel: "str",
    observerID: "id", observerLabel: "str", contactSystemID: "id", contactSystemName: "str", distanceMeters: "m",
    supportFlightIDs: { list: "id" }, leader: { obj: FLIGHT }, initial: "bool",
  },
  HERE: { systemID: "id", systemName: "str", count: "num", byFamily: { map: "num" }, flights: { list: FLIGHT } },
  INCOMING: {
    ...FLIGHT, toSystemID: "id", toSystemName: "str", journeyKind: "str", stage: "str", ownerID: "id",
    dueAtMs: "ms", etaMs: "ms", jumpsRemaining: "num", initial: "bool",
  },
  ENTER: FLIGHT,
  EXIT: { ...FLIGHT, fromSystemName: "str" },
  ENGAGEMENT: {
    status: "str", encounterID: "id", flightIDs: { list: "id" }, shipCount: "num", phase: "str",
    encounterKind: "str", battleClass: "str",
  },
  LOSS: {
    actorID: "id", pilotName: "str", shipName: "str", corporation: "str", cause: "str", encounterID: "id",
    opponentName: "str",
  },
};

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const bool = (description) => ({ type: "boolean", description });

const TRIGGER_TOOL = {
  name: "trigger",
  description: "Set a Living Universe feature in motion through the entry point the feature itself uses; every gate still " +
    "applies, and a refusal names the gate. The first line names the flight or hunt ID that watch lines carry. " +
    "scout {system?, flight?}: a pirate scout goes to the system (default yours) and holds. " +
    "hunt {flight?, phase?}: a materialized pirate flight on your system starts a hunt on you. " +
    "fleet {family, doctrine?, to?, count?, anchor?}: Living Universe flights of a family travel to your grid or a system. " +
    "materialize {flight, go?}: a flight stands up as ships now; go teleports you to it. " +
    "skirmish {count?, shipClass?, gap?}: an alliance skirmish on your grid.",
  inputSchema: {
    type: "object",
    properties: {
      name: str("The trigger.", { enum: Object.keys(triggers.TRIGGER_KEYS) }),
      system: str("scout: target system name or ID."),
      flight: str("scout, hunt: the flight to use; materialize: the flight to stand up."),
      phase: str("hunt: start phase.", { enum: ["stalking", "committed"] }),
      family: str("fleet: the flight family, e.g. pirate, police."),
      doctrine: str("fleet: doctrine key, e.g. sanshas."),
      to: str("fleet: self (default) or a system name or ID."),
      count: int("fleet: flights, 1 to 8; skirmish: hulls a side, 1 to 20.", { minimum: 1, maximum: 20 }),
      anchor: int("fleet: item ID to anchor the journey on."),
      go: bool("materialize: teleport there too."),
      shipClass: str("skirmish: ship class."),
      gap: num("skirmish: separation in metres, 500 to 200000."),
      json: bool("The raw reply as JSON."),
    },
    required: ["name"],
    additionalProperties: false,
  },
  args: triggers.triggerCliArgs,
};

const PRIMER = `Living Universe (plugin lu). The saved world lowsec-docked is a docked Rifter in Amamake with the Living Universe running.
- up: realClock (default true in scenarios: the Living Universe clock runs at real time, which grid checks need), offgridTravel/offgridActivity (1-100, smoke tests only).
- The trigger step and e2e_lu_trigger: { "trigger": "scout|hunt|fleet|materialize|skirmish", <args>, "as": "name", "retry": { "every": 15, "for": 480 } }. Args: system, flight, phase (stalking|committed), family, doctrine, to (self|system), count, anchor, go, shipClass, gap. "as" binds the flight or hunt IDs the reply names.
- Kinds: SIGHTING HUNT HERE INCOMING ENTER EXIT ENGAGEMENT LOSS, from the off-grid tracker and hunter reports. Core grid events carry each NPC's flight, family, hunt phase and controller decision at lu (family on ARRIVE is lu.family); "self" on HUNT means the hunt targets you.
- Example: "setup": ["undock", { "trigger": "fleet", "family": "pirate", "to": "self", "as": "fleet" }, { "waitFor": "INCOMING flightID=$fleet", "timeout": 300 }], "until": { "any": ["ARRIVE flightID=$fleet"], "timeout": 600 }, "expect": ["ARRIVE flightID=$fleet warpIn distanceMeters<=30km"].
- A target can name a flight: "flight=$fleet", "family=police". The saved world's Rifter has no ammo, so give and load it in setup ({ "slash": "/giveitem EMP S 1000" }, { "loadAmmo": "weapons", "charge": "EMP S" }).
- By hand: e2e_lu_trigger, then e2e_watch in the same turn to see its effect. e2e_teleport has no flight pin; trigger materialize with go does that.`;

module.exports = {
  kinds: KINDS,
  self: {
    HUNT: (event) => event.targetSelf === true,
    SIGHTING: () => true,
  },
  extFields: LU,
  format: FORMAT,
  tag: luTag,
  owner,
  ids,
  costText,
  steps: {
    trigger: {
      binds: true,
      retries: true,
      keys: (raw) => triggers.TRIGGER_KEYS[raw.trigger] || [],
      parse: triggers.parseTriggerStep,
      describe: triggers.describeTriggerStep,
      async run(step, io) {
        const reply = await cmdTrigger([step.name, ...step.positionals], step.flags, io);
        return { ok: true, text: triggers.formatTriggerReply(reply), ids: triggers.triggerIDs(reply) };
      },
    },
  },
  commands: COMMANDS,
  handles: HANDLES,
  mcpTools: [TRIGGER_TOOL],
  primer: PRIMER,
  colours: [
    { match: { family: "pirate" }, colour: "#d1242f", label: "red pirate" },
    { match: { family: "concord" }, colour: "#bf8700" },
  ],
  upFlags: {
    realClock: {
      flag: "real-clock",
      type: "bool",
      restore: true,
      scenarioDefault: true,
      description: "With world: start the Living Universe clock at real time (offset 0). Use it for grid checks.",
      describe: (value) => (value ? "real clock" : "saved clock"),
    },
    offgridTravel: {
      flag: "offgrid-travel",
      type: "number",
      min: 1,
      max: 100,
      env: "EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER",
      description: "Off-grid travel time multiplier, 1 to 100. Smoke tests only.",
      describe: (value) => `off-grid travel x${value}`,
    },
    offgridActivity: {
      flag: "offgrid-activity",
      type: "number",
      min: 1,
      max: 100,
      env: "EVEJS_LIVING_UNIVERSE_OFFGRID_ACTIVITY_TIME_MULTIPLIER",
      description: "Off-grid activity time multiplier, 1 to 100. Smoke tests only.",
      describe: (value) => `off-grid activity x${value}`,
    },
  },
  // xeve.js: both multipliers change the ratios between timers, so they suit
  // smoke tests only; `e2e warp` keeps the ratios.
  upNote(values) {
    const set = [["travel", values.offgridTravel], ["activity", values.offgridActivity]].filter(([, value]) => value);
    return set.length
      ? `off-grid time: ${set.map(([name, value]) => `${name} x${value}`).join(", ")} (smoke tests only: the ratios between timers change)`
      : null;
  },
  listeners: {
    luMonitor: { offset: 6, env: "EVEJS_LU_MONITOR_BRIDGE_PORT", label: "LU bridge" },
  },
  // LivingRetaliation says whether being shot woke a flight to fight back.
  // PirateHunt lines repeat the HUNT events, so they're left out.
  logTags: ["LivingHostility", "LivingRetaliation", "HunterIntel", "LivingUniverse"],
  world: worldHooks,
  targetFields: { family: "family", flight: "flightID" },
};
