"use strict";

// Pure pieces of `e2e watch`: one text line per timeline event, the server
// log line parser, and a short reorder buffer that merges the bridge stream
// with log lines by server time. No IO, so tests can pin the output.

const { formatDistance } = require("./format");

const KIND_WIDTH = 10;
const BODY_WIDTH = 58;
const LOG_LINE = /^\[([^\]]+)\] \[pid (\d+)\] \[(\w+)\] (.*)$/;

function formatOffset(ms) {
  const value = Number(ms) || 0;
  const sign = value < 0 ? "-" : "+";
  const total = Math.floor(Math.abs(value) / 1000);
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return `t${sign}${parts.map((part) => String(part).padStart(2, "0")).join(":")}`;
}

function formatSeconds(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "?";
  const seconds = Math.round(Number(ms) / 1000);
  return seconds >= 120 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

// A journey's dueAtMs is set leg by leg, so a flight several jumps out can be
// "due" already. Jumps are the honest number then.
function etaText(event) {
  const jumps = event.jumpsRemaining ? `${event.jumpsRemaining} jump${event.jumpsRemaining === 1 ? "" : "s"}` : "";
  if (event.etaMs > 0) return `eta ${formatSeconds(event.etaMs)}${jumps ? ` (${jumps})` : ""}`;
  return jumps ? `${jumps} out, no ETA` : "due now";
}

function distanceText(meters) {
  return meters === null || meters === undefined ? null : formatDistance(meters);
}

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

function groupLabel(event) {
  const members = Array.isArray(event.members) ? event.members : [];
  if (members.length <= 1) return members[0] ? members[0].label : `#${event.itemID || "?"}`;
  const types = [...new Set(members.map((member) => member.typeName).filter(Boolean))].join("/");
  const who = owner(event.lu) || members[0].label;
  return `${who} x${members.length}${types ? ` (${types})` : ""}`;
}

function flightText(flight) {
  if (!flight) return "?";
  const who = flight.corporation || flight.faction || flight.family || "";
  const role = flight.pirateRole || "";
  const count = flight.count > 1 ? ` x${flight.count}` : "";
  return [flight.flightID, who, role].filter(Boolean).join(" ") + count;
}

function labelList(labels, limit = 4) {
  const list = (labels || []).filter(Boolean);
  const shown = list.slice(0, limit).join(", ");
  return list.length > limit ? `${shown} +${list.length - limit}` : shown;
}

// What the client was sent, from the destiny tee.
function clientBody(event) {
  const who = event.label || (event.itemID ? `#${event.itemID}` : "");
  switch (event.op) {
    case "attached":
      return [`client view ${event.newly ? "attached" : "held"}: ${event.balls} balls`,
        event.baselineAtMs ? "" : "no SetState yet: checks start at the next undock, jump or /tr"];
    case "unavailable":
      return [`no client view: ${event.error}`, ""];
    case "gap":
      return [`${event.dropped} client events dropped before this watch read them`, ""];
    case "SetState":
      return [`SetState: ${event.balls} balls`, ""];
    case "ballpark-cleared":
      return [`ballpark cleared by a session change (${(event.keys || []).join(", ")})`, ""];
    case "AddBalls":
      return [`AddBalls ${event.count}: ${labelList((event.balls || []).map((ball) => `${ball.label || `#${ball.itemID}`}` +
        `${ball.mode && ball.mode !== "STOP" ? ` ${ball.mode}` : ""}`))}`, ""];
    case "RemoveBalls":
      return [`RemoveBalls ${event.count}: ${labelList(event.labels || event.itemIDs)}`, ""];
    case "Damage":
      return [`${who} ${event.layer} ${event.fromPct} -> ${event.toPct}`, ""];
    case "Destruction":
      return [`${who} destruction effect`, ""];
    case "decode-error":
      return [`${event.update} not decoded: ${event.error}`, ""];
    default:
      return [`${who} ${event.op} -> ${event.mode || "?"}` +
        `${event.targetID ? ` on ${event.targetLabel || `#${event.targetID}`}` : ""}` +
        `${event.rangeMeters ? ` at ${distanceText(event.rangeMeters)}` : ""}`, ""];
  }
}

const DIVERGE_TEXT = {
  "server-only": (event) => `server shows it${event.distanceMeters ? ` at ${distanceText(event.distanceMeters)}` : ""}` +
    "; the client never got it",
  "client-only": () => "the client still holds it; the server has no such ball",
  mode: (event) => `client ${event.clientMode}, server ${event.serverMode}`,
  position: (event) => `${distanceText(event.errorMeters)} from where ${event.positionSource} put it`,
  "warp-landing": (event) => `landed ${distanceText(event.errorMeters)} from the client's warp destination`,
  "unknown-ball": (event) => `${event.update}${event.count > 1 ? ` x${event.count}` : ""} for a ball the client does not hold`,
  "no-ballpark": () => "in space, but the client has had no SetState since its ballpark was cleared",
};

function divergeBody(event) {
  const who = event.label || `#${event.itemID}`;
  if (event.status === "cleared") {
    return [`${event.reason} ${who} cleared after ${formatSeconds(event.durationMs)}`, ""];
  }
  const detail = DIVERGE_TEXT[event.reason] ? DIVERGE_TEXT[event.reason](event) : JSON.stringify(event);
  return [`${event.reason} ${who}: ${detail}`, event.status === "open" ? `for ${formatSeconds(event.sinceMs)}` : ""];
}

function eventBody(event) {
  switch (event.kind) {
    case "START":
      return [`character ${event.characterID}, ${Math.round(event.forMs / 1000)}s, sample every ` +
        `${event.everyMs / 1000}s, off grid every ${event.offGridEveryMs / 1000}s`,
      event.clientMode ? `client=${event.clientMode}` : ""];
    case "CLIENT":
      return clientBody(event);
    case "FX":
      return [`${event.label || `#${event.itemID}`} ${event.guid || "?"}` +
        `${event.targetID ? ` -> ${event.targetLabel || `#${event.targetID}`}` : ""}`,
      [event.offensive ? "offensive" : "", event.knownBall === false ? "ball not in client view" : ""]
        .filter(Boolean).join(", ")];
    case "DIVERGE":
      return divergeBody(event);
    case "GRID": {
      const self = event.self || {};
      const protection = self.protection && self.protection.active
        ? (self.protection.remainingMs > 0 ? `, protected ${Math.ceil(self.protection.remainingMs / 1000)}s` : ", protected")
        : "";
      const security = Number.isFinite(Number(event.security)) && event.security !== null
        ? ` (${Number(event.security).toFixed(1)})` : "";
      return [`${event.systemName || event.systemID}${security}  self: ${self.typeName || "?"} ` +
        `(${self.mode || "?"}${protection}), ${event.tracked} ball(s)`, ""];
    }
    case "PRESENT":
      return [`${groupLabel(event)} at ${distanceText(event.distanceMeters) || "?"}` +
        `${event.members && event.members.length === 1 && event.members[0].mode ? ` ${event.members[0].mode}` : ""}`,
      luTag(event.lu)];
    case "ARRIVE":
      return [`${groupLabel(event)}  ${event.warpIn ? "warp-in" : "at"} ${distanceText(event.distanceMeters) || "?"} ` +
        `from self${event.stillWarping ? " (still in warp)" : ""}`, luTag(event.lu)];
    case "LEAVE":
      return [`${groupLabel(event)}  ${event.warped ? "warped off" : "left grid"} at ` +
        `${distanceText(event.distanceMeters) || "?"}`, luTag(event.lu)];
    case "MODE":
      return [`${event.label}  ${event.from || "-"} -> ${event.to || "-"}` +
        `${event.targetLabel ? ` on ${event.targetLabel}` : ""}` +
        `${event.distanceMeters ? `  ${distanceText(event.distanceMeters)}` : ""}`, luTag(event.lu)];
    case "TARGET":
      return [`${event.sourceLabel} -> ${event.targetLabel} (${event.locked ? "locked" : "unlocked"})`, luTag(event.lu)];
    case "DAMAGE":
      return [`${event.label} ${event.layer} ${event.fromPct} -> ${event.toPct}`, luTag(event.lu)];
    case "DESTROYED":
      return [`${event.label}${event.typeName && event.label !== event.typeName ? ` (${event.typeName})` : ""} ` +
        `wreck #${event.wreckID}`, luTag(event.lu)];
    case "KILLMAIL":
      return [`${event.label} killmail ${event.killID}`, event.flightID || ""];
    case "SIGHTING":
      return [`${event.observerLabel} sighted self` +
        `${event.distanceMeters !== null && event.distanceMeters !== undefined ? ` at ${distanceText(event.distanceMeters)}` : ""}` +
        ` (${[event.source, event.certainty].filter(Boolean).join(", ") || "sensor"})`, luTag(event.lu)];
    case "HUNT": {
      const target = event.targetSelf ? "self" : event.targetLabel;
      const where = event.distanceMeters !== null && event.distanceMeters !== undefined
        ? ` at ${distanceText(event.distanceMeters)}`
        : event.contactSystemName ? ` in ${event.contactSystemName}` : "";
      const support = event.supportFlightIDs && event.supportFlightIDs.length
        ? ` support=${event.supportFlightIDs.length}` : "";
      return [`${flightText(event.leader)}  ${event.reason || "-"}${target ? ` target=${target}` : ""}${where}`,
        `phase=${event.phase || "?"}${support}${event.initial ? " (running at start)" : ""}`];
    }
    case "INCOMING":
      return [`${flightText(event)} ${event.systemName || event.systemID || "?"} -> ` +
        `${event.toSystemName || event.toSystemID}  ${etaText(event)}`,
      [event.journeyKind, event.stage, event.ownerID].filter(Boolean).join(" ")];
    case "HERE": {
      const families = Object.entries(event.byFamily || {}).sort((a, b) => b[1] - a[1])
        .map(([family, count]) => `${family} ${count}`).join(", ");
      const pirates = (event.flights || []).filter((flight) => flight.family === "pirate").map(flightText);
      return [`${event.count} flight(s) in ${event.systemName || event.systemID} off grid: ${families}`,
        pirates.length ? `pirates: ${pirates.join("; ")}` : ""];
    }
    case "ENTER":
      return [`${flightText(event)} entered the system (off grid)`, event.phase ? `phase=${event.phase}` : ""];
    case "EXIT":
      return [`${flightText(event)} left the system`, event.phase ? `phase=${event.phase}` : ""];
    case "ENGAGEMENT":
      return [`${event.encounterID} ${event.status}` +
        `${event.encounterKind ? ` ${event.encounterKind}` : ""}${event.battleClass ? ` ${event.battleClass}` : ""}` +
        `${event.shipCount ? ` ${event.shipCount} ships` : ""}`, event.phase ? `phase=${event.phase}` : ""];
    case "LOSS":
      return [`${event.shipName || "ship"}${event.pilotName ? ` (${event.pilotName})` : ""} of ` +
        `${event.corporation || "?"} lost${event.opponentName ? ` to ${event.opponentName}` : ""}`,
      event.cause ? `cause=${event.cause}` : ""];
    case "MOVED":
      return [`self moved ${distanceText(event.distanceMeters)} to a new grid`, ""];
    case "SYSTEM":
      return [`self now in ${event.toSystemName || event.toSystemID}`, ""];
    case "SELF":
      return [`self ship ${event.fromTypeName || event.fromItemID || "-"} -> ${event.toTypeName || event.toItemID || "-"}`, ""];
    case "DOCKED":
      return [`self docked${event.stationID ? ` in ${event.stationID}` : ""}`, ""];
    case "STEP":
      return [`${event.phase === "during" ? "during: " : ""}${event.ok ? "" : "FAILED "}${event.step}` +
        `${event.text ? `: ${event.text}` : ""}`.slice(0, 200), ""];
    case "STOP":
      return [event.reason === "until" ? `stop condition met: ${event.condition}` : `stopped: ${event.reason}`, ""];
    case "LOG":
      return [String(event.text || "").slice(0, 200), ""];
    case "POS":
      return [`${(event.balls || []).length} ball positions in ${event.systemName || event.systemID || "?"}`, ""];
    case "ERROR":
      return [String(event.error || "stream error"), ""];
    case "END": {
      const costs = event.costs || {};
      const client = event.client
        ? `; client ${event.client.notifications} updates, decode ${event.client.decodeMsAvg}/` +
          `${event.client.decodeMsMaxSinceAttach} ms`
        : "";
      return [`${event.reason}: ${event.samples} samples, ${event.events} events`,
        `sample ${costs.sampleMsAvg}/${costs.sampleMsMax} ms, off grid ${costs.offGridMsAvg}/${costs.offGridMsMax} ms ` +
        `over ${costs.flightsScanned} flights (avg/max)${client}`];
    }
    default:
      return [JSON.stringify(event), ""];
  }
}

function formatTimelineEvent(event) {
  const [body, tail] = eventBody(event);
  const kind = String(event.kind);
  const head = `${formatOffset(event.t)}  ${kind.padEnd(KIND_WIDTH)}${kind.length >= KIND_WIDTH ? " " : ""}`;
  if (!tail) return `${head}${body}`;
  return `${head}${body.length < BODY_WIDTH ? body.padEnd(BODY_WIDTH) : `${body}  `}${tail}`;
}

function parseLogLine(line) {
  const match = LOG_LINE.exec(line);
  if (!match) return null;
  const atMs = Date.parse(match[1]);
  return Number.isFinite(atMs)
    ? { atMs, pid: Number(match[2]), level: match[3], text: match[4] }
    : null;
}

// Every ID the watch has named, so a log line can be kept because it is about
// something on this timeline rather than about any hunt in the universe.
function collectIDs(event, into) {
  const add = (value) => { if (value) into.add(String(value)); };
  add(event.flightID);
  add(event.itemID);
  add(event.observerID);
  add(event.observerFlightID);
  add(event.huntID);
  add(event.sourceID);
  add(event.targetID);
  if (event.lu) add(event.lu.flightID);
  if (event.leader) add(event.leader.flightID);
  for (const member of event.members || []) add(member.itemID);
  for (const flight of event.flights || []) add(flight.flightID);
  for (const id of event.supportFlightIDs || []) add(id);
  return into;
}

function mentionsAny(text, ids) {
  for (const id of ids) {
    if (id.length >= 4 && text.includes(id)) return true;
  }
  return false;
}

// Holds events for holdMs and releases them in server-time order, so a log
// line written just before a sample prints before it.
function createReorderBuffer(holdMs, release) {
  let held = [];
  function flush(nowMs, all = false) {
    const cutoff = nowMs - holdMs;
    const ready = all ? held : held.filter((event) => event.atMs <= cutoff);
    if (!ready.length) return;
    held = all ? [] : held.filter((event) => event.atMs > cutoff);
    ready.sort((a, b) => a.atMs - b.atMs || (a.seq || 0) - (b.seq || 0));
    for (const event of ready) release(event);
  }
  return {
    push(event) { held.push(event); },
    flush,
    size: () => held.length,
  };
}

module.exports = {
  collectIDs,
  createReorderBuffer,
  formatOffset,
  formatTimelineEvent,
  luTag,
  mentionsAny,
  parseLogLine,
};
