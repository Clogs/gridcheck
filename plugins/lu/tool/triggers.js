"use strict";

// `e2e trigger` and the scenario step of the same name: argument parsing and
// the line each trigger prints. The bridge owns every rule; this only shapes
// requests and replies. Guide: docs/E2E-GRID-TESTING.md "Triggers".

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

// ---------- the scenario step ----------

// The keys a trigger step takes besides "trigger", "as", "retry" and "note".
const TRIGGER_KEYS = Object.freeze({
  scout: ["system", "flight"],
  hunt: ["flight", "phase"],
  fleet: ["family", "doctrine", "to", "count", "anchor"],
  materialize: ["flight", "go"],
  skirmish: ["count", "shipClass", "gap"],
});

// The flight or hunt IDs a trigger's reply names, for its `as` binding. A
// fleet binds its flights first, then its owner ID (INCOMING ownerID=$fleet);
// a hunt binds its hunt ID and its leader's flight.
function triggerIDs(reply) {
  if (!reply) return [];
  switch (reply.trigger) {
    case "scout":
    case "materialize":
      return [reply.flightID].filter(Boolean).map(String);
    case "hunt":
      return [reply.huntID, reply.flight && reply.flight.flightID].filter(Boolean).map(String);
    case "fleet":
      return [...(reply.flights || []).map((flight) => flight.flightID), reply.ownerID].filter(Boolean).map(String);
    default:
      return [];
  }
}

// raw: { "trigger": "fleet", "family": "pirate", ... } -> { name, positionals, flags },
// the same arguments `e2e trigger` takes. ctx (scenario.js): problem(key, message),
// bound(value, key), resolveSystemID(text).
function parseTriggerStep(raw, ctx) {
  const name = raw.trigger;
  if (!TRIGGER_KEYS[name]) {
    ctx.problem(null, `unknown trigger "${name}"; triggers are ${Object.keys(TRIGGER_KEYS).join(", ")}`);
    return null;
  }
  const positionals = [];
  const flags = {};
  if (name === "scout" && raw.system !== undefined) positionals.push(String(raw.system));
  if (name === "fleet" && raw.family !== undefined) positionals.push(String(raw.family));
  if (name === "materialize" && raw.flight !== undefined) positionals.push(String(raw.flight));
  if (name !== "materialize" && raw.flight !== undefined) flags.flight = String(raw.flight);
  if (raw.phase !== undefined) {
    if (!["stalking", "committed"].includes(raw.phase)) ctx.problem("phase", "stalking or committed");
    flags.phase = String(raw.phase);
  }
  for (const key of ["doctrine", "to"]) if (raw[key] !== undefined) flags[key] = String(raw[key]);
  if (raw.count !== undefined) {
    const most = name === "skirmish" ? 20 : 8;
    if (!(Number.isInteger(raw.count) && raw.count >= 1 && raw.count <= most)) ctx.problem("count", `1 through ${most}`);
    flags.count = raw.count;
  }
  if (raw.shipClass !== undefined) flags.class = String(raw.shipClass);
  if (raw.gap !== undefined) {
    if (!(typeof raw.gap === "number" && raw.gap >= 500 && raw.gap <= 200_000)) ctx.problem("gap", "500 through 200000 metres");
    flags.gap = raw.gap;
  }
  if (raw.anchor !== undefined) flags.anchor = raw.anchor;
  if (raw.go !== undefined) {
    if (typeof raw.go !== "boolean") ctx.problem("go", "true or false");
    else if (raw.go) flags.go = true;
  }
  ctx.bound(raw.flight, "flight");
  try {
    const flight = typeof raw.flight === "string" && raw.flight.startsWith("$") ? "living_flight_0" : null;
    triggerRequest(name, flight && name === "materialize" ? [flight] : positionals,
      flight && name !== "materialize" ? { ...flags, flight } : flags, { characterID: 0, resolveSystemID: ctx.resolveSystemID });
  } catch (error) {
    ctx.problem(null, error.message.split("\n")[0]);
  }
  return { name, positionals, flags };
}

function describeTriggerStep(step) {
  const args = [...step.positionals, ...Object.entries(step.flags)
    .map(([key, value]) => (value === true ? `--${key}` : `--${key} ${value}`))];
  return `trigger ${step.name}${args.length ? ` ${args.join(" ")}` : ""}`;
}

// The e2e_lu_trigger MCP tool's arguments, in the scenario step's names.
function triggerCliArgs(p) {
  const args = ["trigger"];
  const flag = (name, value) => {
    if (value === undefined || value === null || value === false || value === "") return;
    args.push(value === true ? `--${name}` : `--${name}=${value}`);
  };
  const positionals = [p.name];
  if (p.name === "scout" && p.system !== undefined) positionals.push(String(p.system));
  if (p.name === "fleet" && p.family !== undefined) positionals.push(String(p.family));
  if (p.name === "materialize" && p.flight !== undefined) positionals.push(String(p.flight));
  if (p.name !== "materialize") flag("flight", p.flight);
  flag("phase", p.phase);
  flag("doctrine", p.doctrine);
  flag("to", p.to);
  flag("count", p.count);
  flag("anchor", p.anchor);
  flag("go", p.go);
  flag("class", p.shipClass);
  flag("gap", p.gap);
  flag("json", p.json);
  args.push("--", ...positionals);
  return args;
}

module.exports = {
  TRIGGER_KEYS,
  TRIGGER_USAGE,
  describeTriggerStep,
  formatTriggerReply,
  parseTriggerStep,
  triggerCliArgs,
  triggerIDs,
  triggerRequest,
};
