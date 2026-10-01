"use strict";

// Timeline lines for the Living Universe kinds, and what core lines carry about
// a flight. `help` is core/timeline.js's: distance(m) and seconds(ms).

function owner(lu) {
  return lu ? lu.corporation || lu.faction || lu.family || null : null;
}

// flight, phase, decision: the three answers to "why is it doing that".
function luTag(lu) {
  if (!lu) return "";
  const parts = [];
  if (lu.flightID) parts.push(lu.flightID);
  const phase = lu.huntPhase || lu.journeyStage || lu.phase;
  if (phase) parts.push(`phase=${phase}`);
  if (lu.decision) parts.push(`why=${lu.decision}`);
  if (lu.huntPhase && lu.huntReason) parts.push(`hunt=${lu.huntReason}`);
  return parts.join(" ");
}

function flightText(flight) {
  if (!flight) return "?";
  const who = flight.corporation || flight.faction || flight.family || "";
  const role = flight.pirateRole || "";
  const count = flight.count > 1 ? ` x${flight.count}` : "";
  return [flight.flightID, who, role].filter(Boolean).join(" ") + count;
}

// A journey's dueAtMs is set leg by leg, so a flight several jumps out can be
// "due" already. Jumps are the honest number then.
function etaText(event, help) {
  const jumps = event.jumpsRemaining ? `${event.jumpsRemaining} jump${event.jumpsRemaining === 1 ? "" : "s"}` : "";
  if (event.etaMs > 0) return `eta ${help.seconds(event.etaMs)}${jumps ? ` (${jumps})` : ""}`;
  return jumps ? `${jumps} out, no ETA` : "due now";
}

const at = (meters, help) => (meters !== null && meters !== undefined ? ` at ${help.distance(meters)}` : "");

const FORMAT = {
  SIGHTING: (event, help) => [`${event.observerLabel} sighted self${at(event.distanceMeters, help)}` +
    ` (${[event.source, event.certainty].filter(Boolean).join(", ") || "sensor"})`, luTag(event.lu)],
  HUNT: (event, help) => {
    const target = event.targetSelf ? "self" : event.targetLabel;
    const where = event.distanceMeters !== null && event.distanceMeters !== undefined
      ? at(event.distanceMeters, help)
      : event.contactSystemName ? ` in ${event.contactSystemName}` : "";
    const support = event.supportFlightIDs && event.supportFlightIDs.length
      ? ` support=${event.supportFlightIDs.length}` : "";
    return [`${flightText(event.leader)}  ${event.reason || "-"}${target ? ` target=${target}` : ""}${where}`,
      `phase=${event.phase || "?"}${support}${event.initial ? " (running at start)" : ""}`];
  },
  INCOMING: (event, help) => [`${flightText(event)} ${event.systemName || event.systemID || "?"} -> ` +
    `${event.toSystemName || event.toSystemID}  ${etaText(event, help)}`,
  [event.journeyKind, event.stage, event.ownerID].filter(Boolean).join(" ")],
  HERE: (event) => {
    const families = Object.entries(event.byFamily || {}).sort((a, b) => b[1] - a[1])
      .map(([family, count]) => `${family} ${count}`).join(", ");
    const pirates = (event.flights || []).filter((flight) => flight.family === "pirate").map(flightText);
    return [`${event.count} flight(s) in ${event.systemName || event.systemID} off grid: ${families}`,
      pirates.length ? `pirates: ${pirates.join("; ")}` : ""];
  },
  ENTER: (event) => [`${flightText(event)} entered the system (off grid)`, event.phase ? `phase=${event.phase}` : ""],
  EXIT: (event) => [`${flightText(event)} left the system`, event.phase ? `phase=${event.phase}` : ""],
  ENGAGEMENT: (event) => [`${event.encounterID} ${event.status}` +
    `${event.encounterKind ? ` ${event.encounterKind}` : ""}${event.battleClass ? ` ${event.battleClass}` : ""}` +
    `${event.shipCount ? ` ${event.shipCount} ships` : ""}`, event.phase ? `phase=${event.phase}` : ""],
  LOSS: (event) => [`${event.shipName || "ship"}${event.pilotName ? ` (${event.pilotName})` : ""} of ` +
    `${event.corporation || "?"} lost${event.opponentName ? ` to ${event.opponentName}` : ""}`,
  event.cause ? `cause=${event.cause}` : ""],
};

// IDs a server log line may name, so a watch keeps the line.
function ids(event, lu) {
  const out = [event.flightID, event.observerID, event.observerFlightID, event.huntID];
  if (lu) out.push(lu.flightID);
  if (event.leader) out.push(event.leader.flightID);
  for (const flight of event.flights || []) out.push(flight.flightID);
  out.push(...(event.supportFlightIDs || []));
  return out.filter(Boolean);
}

function costText(costs) {
  return costs && costs.flightsScanned !== undefined ? `over ${costs.flightsScanned} flights` : null;
}

module.exports = {
  FORMAT,
  costText,
  flightText,
  ids,
  luTag,
  owner,
};
