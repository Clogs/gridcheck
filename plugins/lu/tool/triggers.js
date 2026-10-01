"use strict";

// `e2e trigger` and the off-grid time flags of `e2e up`: argument parsing and
// the line each trigger prints. The bridge owns every rule; this only shapes
// requests and replies. Guide: docs/E2E-GRID-TESTING.md "Triggers".

// xeve.js: both settings take 1 through 100. They change the ratios between
// timers, so they suit smoke tests only; `e2e warp` keeps the ratios.
const OFFGRID_FLAGS = Object.freeze([
  { flag: "offgrid-travel", envVar: "EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER", name: "travel" },
  { flag: "offgrid-activity", envVar: "EVEJS_LIVING_UNIVERSE_OFFGRID_ACTIVITY_TIME_MULTIPLIER", name: "activity" },
]);

function offGridMultipliers(flags = {}) {
  const env = {};
  const values = {};
  for (const { flag, envVar, name } of OFFGRID_FLAGS) {
    if (flags[flag] === undefined) continue;
    const value = Number(flags[flag]);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      throw new Error(`--${flag} takes a number from 1 through 100`);
    }
    env[envVar] = String(value);
    values[name] = value;
  }
  const text = Object.entries(values).map(([name, value]) => `${name} x${value}`).join(", ");
  return { env, values: Object.keys(values).length ? values : null, text };
}

const TRIGGER_USAGE = [
  "e2e trigger scout [<system>] [--flight <flightID>]",
  "e2e trigger hunt [--flight <flightID>] [--phase stalking|committed]",
  "e2e trigger fleet <family> [--doctrine <key>] [--to self|<system>] [--anchor <itemID>] [--count 1-8]",
  "e2e trigger materialize <flightID> [--go]",
  "e2e trigger skirmish [--count 1-20] [--class <shipClass>] [--gap <meters>]",
].join("\n  ");

// The bridge body for one trigger. `resolveSystemID` turns a name or ID into an ID.
function triggerRequest(name, positionals, flags, { characterID, resolveSystemID }) {
  const body = { characterID };
  const words = positionals.join(" ").trim();
  if (flags.flight) body.flightID = String(flags.flight);
  switch (name) {
    case "scout":
      if (words) body.systemID = resolveSystemID(words);
      return body;
    case "hunt":
      if (flags.phase) body.phase = String(flags.phase);
      return body;
    case "fleet": {
      if (!positionals[0]) throw new Error(`fleet needs a family\n  ${TRIGGER_USAGE}`);
      body.family = String(positionals[0]);
      if (flags.doctrine) body.doctrine = String(flags.doctrine);
      if (flags.count !== undefined) body.count = Number(flags.count);
      if (flags.anchor !== undefined) body.anchorID = Number(flags.anchor);
      const to = flags.to === undefined ? "self" : String(flags.to);
      if (to === "self") body.to = "self";
      else body.systemID = resolveSystemID(to);
      return body;
    }
    case "skirmish": {
      // Not a bridge route: LU Monitor's /allianceskirmish, the alliance AI's own test button.
      if (flags.count !== undefined) {
        const count = Number(flags.count);
        if (!(Number.isInteger(count) && count >= 1 && count <= 20)) throw new Error("skirmish --count takes 1 through 20");
        body.hullsPerSide = count;
      }
      if (flags.class) body.shipClass = String(flags.class);
      if (flags.gap !== undefined) body.separationMeters = Number(flags.gap);
      return body;
    }
    case "materialize":
      if (!positionals[0]) throw new Error(`materialize needs a flightID\n  ${TRIGGER_USAGE}`);
      body.flightID = String(positionals[0]);
      if (flags.go) body.go = true;
      return body;
    default:
      throw new Error(`unknown trigger ${name || "(none)"}\n  ${TRIGGER_USAGE}`);
  }
}

// One line naming the ID to grep the watch for, then detail.
function formatTriggerReply(reply) {
  const f = (flight) => `${flight.flightID} (${[flight.family, flight.pirateRole, flight.doctrine].filter(Boolean).join(" ")}, ` +
    `${flight.hulls} hull${flight.hulls === 1 ? "" : "s"})`;
  switch (reply.trigger) {
    case "scout":
      return `scout ${reply.flightID}\n  ${f(reply.flight)} from system ${reply.fromSystemID}, ` +
        `${reply.jumps} jump${reply.jumps === 1 ? "" : "s"} to ${reply.systemID}; holds until ` +
        `${new Date(reply.holdsUntilMs).toISOString()}` +
        (reply.canHunt ? "" : "\n  it can't lead a hunt there: its way home leaves hunting grounds (pirateHuntCoordinator viable). " +
          "It still reports you; start a hunt with another pirate flight on the system (e2e trigger hunt).");
    case "hunt":
      return `hunt ${reply.huntID}\n  leader ${f(reply.flight)}, phase ${reply.phase}, from a ${reply.report.source} report; ` +
        `trace ${reply.trace.join(" > ")}`;
    case "fleet":
      return `fleet ${reply.ownerID}\n` + reply.flights.map((flight) =>
        `  ${f(flight)} from system ${flight.fromSystemID}, ${flight.jumps} jump${flight.jumps === 1 ? "" : "s"}`).join("\n") +
        `\n  to ${reply.grid ? "your grid" : `anchor ${reply.anchorID}`} in system ${reply.systemID}`;
    case "skirmish": {
      const side = (wing) => (wing ? `${wing.allianceName || "?"} ${wing.hulls} hull${wing.hulls === 1 ? "" : "s"}` : "?");
      const skirmish = reply.skirmish || {};
      return `skirmish ${side(skirmish.raid)} raid vs ${side(skirmish.defence)} defence\n  ${reply.message || ""}`;
    }
    case "materialize":
      return `materialize ${reply.flightID}\n  pinned; ` +
        `${reply.materialized ? "already materialized" : reply.madeDue ? "due now" : "not a mission journey, so not made due"}; ` +
        `system ${reply.systemID} ${reply.observed ? "observed" : "not observed: nothing stands up until a session is there"}` +
        `${reply.moved ? `\n  ${reply.moved.command} -> ${reply.moved.success ? "ok" : `refused: ${reply.moved.message}`}` : ""}`;
    default:
      return JSON.stringify(reply);
  }
}

module.exports = {
  OFFGRID_FLAGS,
  TRIGGER_USAGE,
  formatTriggerReply,
  offGridMultipliers,
  triggerRequest,
};
