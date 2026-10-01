"use strict";

// Off-grid context for a watched system: hunts, flights heading there, flights
// entering and leaving, fights and losses. One walk of the flights per scan,
// and only while a watch runs. Read-only.
//
//   HUNT, HERE, INCOMING, ENTER, EXIT, ENGAGEMENT, LOSS

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function safe(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function centreDistance(a, b) {
  if (!a || !b) return null;
  const dx = Number(b.x) - Number(a.x);
  const dy = Number(b.y) - Number(a.y);
  const dz = Number(b.z) - Number(a.z);
  const value = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Number.isFinite(value) ? value : null;
}

function journeyDestinationSystemID(journey) {
  const destination = journey && ((journey.pending && journey.pending.destination) || journey.destination);
  return toPositiveInt(destination && destination.systemID);
}

function flightSummary(flight, describeSystem) {
  const systemID = toPositiveInt(flight.currentSystemID);
  const system = systemID && typeof describeSystem === "function" ? safe(() => describeSystem(systemID)) : null;
  return {
    flightID: String(flight.flightID || ""),
    family: flight.family ? String(flight.family) : null,
    faction: flight.homeFactionName ? String(flight.homeFactionName) : null,
    corporation: flight.homeCorporationName ? String(flight.homeCorporationName) : null,
    pirateRole: flight.pirateRole ? String(flight.pirateRole) : null,
    phase: flight.phase ? String(flight.phase) : null,
    count: Array.isArray(flight.actorIDs) ? flight.actorIDs.length : 0,
    systemID: systemID || null,
    systemName: system && system.name ? system.name : null,
  };
}

// luNowMs: the Living Universe clock. Hunt traces and journey deadlines are on it,
// and a restored or warped world runs it apart from the real time the watch keeps.
function createOffGridTracker({ inspect = null, describeSystem = null, characterID = 0, startedAtMs = Date.now(),
  luNowMs = null } = {}) {
  let first = true;
  let inSystem = new Set();
  let lastSystemID = 0;
  const incoming = new Map();
  const hunts = new Map();
  const encounters = new Map();
  let lastLossAtMs = startedAtMs;
  const systemName = (id) => {
    const row = id && typeof describeSystem === "function" ? safe(() => describeSystem(id)) : null;
    return row && row.name ? row.name : null;
  };

  function huntRelevant(flight, hunt, systemID) {
    const report = hunt.report || {};
    return toPositiveInt(report.systemID) === systemID ||
      toPositiveInt(flight.currentSystemID) === systemID ||
      toPositiveInt(report.location && report.location.exitSystemID) === systemID ||
      (characterID > 0 && toPositiveInt(report.targetCharacterID) === characterID);
  }

  function huntEvent(flight, hunt, entry, context, systemID, extra = {}) {
    const report = hunt.report || {};
    const contactSystemID = toPositiveInt(report.systemID);
    const position = report.location && report.location.position;
    const ego = context.egoPosition;
    return {
      kind: "HUNT",
      atMs: Number(entry.atMs) ? Number(entry.atMs) + (context.luOffsetMs || 0) : context.nowMs,
      huntID: String(hunt.id || ""),
      phase: String(entry.phase || hunt.phase || ""),
      reason: String(entry.reason || hunt.reason || ""),
      source: report.source ? String(report.source) : null,
      targetSelf: characterID > 0 && toPositiveInt(report.targetCharacterID) === characterID,
      targetLabel: context.labelFor ? context.labelFor(report.targetID) : null,
      observerID: toPositiveInt(report.observerID) || null,
      observerLabel: context.labelFor ? context.labelFor(report.observerID) : null,
      contactSystemID: contactSystemID || null,
      contactSystemName: systemName(contactSystemID),
      distanceMeters: contactSystemID === systemID && position && ego ? centreDistance(position, ego) : null,
      supportFlightIDs: (Array.isArray(hunt.supportIDs) ? hunt.supportIDs : []).map(String),
      leader: flightSummary(flight, describeSystem),
      ...extra,
    };
  }

  function scanHunt(flight, systemID, context, events, seen) {
    const hunt = flight.pirateHunt;
    const huntID = String(hunt.id || "");
    if (!huntID || !huntRelevant(flight, hunt, systemID)) return;
    seen.add(huntID);
    const trace = (Array.isArray(hunt.trace) ? hunt.trace : []).filter(Boolean);
    const known = hunts.get(huntID);
    if (!known) {
      // First sight of a running hunt: its current state, not its history.
      const latest = trace[trace.length - 1] || { atMs: hunt.changedAtMs, phase: hunt.phase, reason: hunt.reason };
      events.push(huntEvent(flight, hunt, latest, context, systemID, { initial: first }));
      if (!first && trace.length > 1) {
        // Started since the last scan: the earlier steps are news too.
        events.splice(events.length - 1, 0, ...trace.slice(0, -1).map((entry) =>
          huntEvent(flight, hunt, entry, context, systemID)));
      }
    } else {
      for (const entry of trace) {
        if ((Number(entry.atMs) || 0) > known.lastAtMs) events.push(huntEvent(flight, hunt, entry, context, systemID));
      }
    }
    const lastAtMs = trace.length ? Number(trace[trace.length - 1].atMs) || 0 : Number(hunt.changedAtMs) || 0;
    hunts.set(huntID, { leaderFlightID: String(flight.flightID || ""), lastAtMs: Math.max(lastAtMs, known ? known.lastAtMs : 0) });
  }

  function endedHunts(seen, context, systemID, events) {
    for (const [huntID, known] of hunts) {
      if (seen.has(huntID)) continue;
      hunts.delete(huntID);
      const leader = inspect && typeof inspect.getFlightByID === "function"
        ? safe(() => inspect.getFlightByID(known.leaderFlightID)) : null;
      const last = leader && leader.lastPirateHunt && String(leader.lastPirateHunt.id || "") === huntID
        ? leader.lastPirateHunt : null;
      if (last) {
        for (const entry of (Array.isArray(last.trace) ? last.trace : [])) {
          if ((Number(entry.atMs) || 0) > known.lastAtMs) events.push(huntEvent(leader, last, entry, context, systemID));
        }
      }
      events.push({
        kind: "HUNT",
        huntID,
        phase: "ended",
        reason: last ? String(last.reason || "") : "hunt-cleared",
        leader: leader ? flightSummary(leader, describeSystem) : { flightID: known.leaderFlightID },
      });
    }
  }

  // Encounters come from the flights already walked (flight.encounterID), not
  // from inspect.listConflicts: that builds the whole universe status, which
  // measured 56 ms a scan on a 1,717-flight world.
  // Phase and kind come from one keyed read per encounter found on that walk.
  function scanEncounters(present, events) {
    const lookup = inspect && typeof inspect.getEncounterByID === "function" ? inspect.getEncounterByID : null;
    for (const [id, row] of present) {
      const encounter = lookup ? safe(() => lookup(id)) : null;
      const phase = encounter && encounter.phase ? String(encounter.phase) : null;
      const before = encounters.get(id);
      const key = `${row.flightIDs.length}:${row.ships}:${phase || ""}`;
      if (before === key) continue;
      encounters.set(id, key);
      events.push({
        kind: "ENGAGEMENT",
        status: before === undefined ? (first ? "present" : "start") : "changed",
        encounterID: id,
        flightIDs: row.flightIDs,
        shipCount: row.ships,
        phase,
        encounterKind: encounter && encounter.kind ? String(encounter.kind) : null,
        battleClass: encounter && encounter.battleClass ? String(encounter.battleClass) : null,
      });
    }
    for (const id of [...encounters.keys()]) {
      if (present.has(id)) continue;
      encounters.delete(id);
      events.push({ kind: "ENGAGEMENT", status: "end", encounterID: id });
    }
  }

  function scanLosses(systemID, nowMs, events) {
    if (!inspect || typeof inspect.listShipLosses !== "function") return;
    const reply = safe(() => inspect.listShipLosses({ sinceMs: lastLossAtMs + 1, limit: 50 }, nowMs));
    const losses = (reply && Array.isArray(reply.losses) ? reply.losses : [])
      .filter((row) => toPositiveInt(row.systemID) === systemID)
      .sort((a, b) => a.lostAtMs - b.lostAtMs);
    for (const row of losses) {
      events.push({
        kind: "LOSS",
        atMs: Number(row.lostAtMs) || nowMs,
        actorID: row.actorID || null,
        pilotName: row.pilotName || null,
        shipName: row.shipName || null,
        corporation: row.corporationName || null,
        cause: row.cause || null,
        encounterID: row.encounterID || null,
        opponentName: row.opponentName || null,
      });
    }
    const newest = reply && Array.isArray(reply.losses) && reply.losses.length
      ? Math.max(...reply.losses.map((row) => Number(row.lostAtMs) || 0)) : 0;
    if (newest > lastLossAtMs) lastLossAtMs = newest;
  }

  // context: { nowMs, egoPosition, labelFor }
  function scan(systemID, context) {
    const events = [];
    const stats = { flights: 0 };
    if (!inspect || typeof inspect.listFlights !== "function" || !systemID) return { events, stats };
    if (systemID !== lastSystemID) {
      // A new system is a new baseline: say what is there and coming, once.
      first = true;
      inSystem = new Set();
      incoming.clear();
      encounters.clear();
      lastSystemID = systemID;
    }
    const nowMs = context.nowMs;
    const luNow = typeof luNowMs === "function" ? Number(safe(luNowMs)) : NaN;
    const luOffsetMs = Number.isFinite(luNow) ? nowMs - luNow : 0;
    context = { ...context, luOffsetMs };
    const flights = safe(() => inspect.listFlights()) || [];
    stats.flights = flights.length;
    const nowIn = new Set();
    const huntsSeen = new Set();
    const summaries = new Map();
    const encountersHere = new Map();
    for (const flight of flights) {
      if (!flight || !flight.flightID) continue;
      const flightID = String(flight.flightID);
      const pilots = Array.isArray(flight.actorIDs) ? flight.actorIDs.length : 0;
      const here = toPositiveInt(flight.currentSystemID) === systemID;
      if (here && pilots > 0 && flight.phase !== "destroyed") {
        nowIn.add(flightID);
        if (!first && !inSystem.has(flightID)) summaries.set(flightID, flight);
        if (flight.encounterID) {
          const id = String(flight.encounterID);
          const row = encountersHere.get(id) || { flightIDs: [], ships: 0 };
          row.flightIDs.push(flightID);
          row.ships += pilots;
          encountersHere.set(id, row);
        }
      }
      const journey = flight.missionJourney && typeof flight.missionJourney === "object" ? flight.missionJourney : null;
      if (journey && !here && pilots > 0 && journey.status !== "arrived" && journeyDestinationSystemID(journey) === systemID) {
        const key = `${journey.ownerID || journey.kind || ""}:${journey.startedAtMs || 0}`;
        if (incoming.get(flightID) !== key) {
          incoming.set(flightID, key);
          const dueAtMs = Number(journey.dueAtMs) || 0;
          const cursor = toPositiveInt(journey.cursor);
          const route = Array.isArray(journey.systemIDs) ? journey.systemIDs : [];
          events.push({
            kind: "INCOMING",
            ...flightSummary(flight, describeSystem),
            toSystemID: systemID,
            toSystemName: systemName(systemID),
            journeyKind: journey.kind ? String(journey.kind) : null,
            stage: journey.stage ? String(journey.stage) : null,
            ownerID: journey.ownerID ? String(journey.ownerID) : null,
            dueAtMs: dueAtMs ? dueAtMs + luOffsetMs : null,
            etaMs: dueAtMs ? Math.max(0, dueAtMs + luOffsetMs - nowMs) : null,
            jumpsRemaining: route.length ? Math.max(0, route.length - cursor - 1) : null,
            initial: first,
          });
        }
      } else if (incoming.has(flightID)) {
        incoming.delete(flightID);
      }
      if (flight.pirateHunt && typeof flight.pirateHunt === "object") {
        scanHunt(flight, systemID, { ...context, nowMs }, events, huntsSeen);
      }
    }
    if (first && nowIn.size) {
      // Who is in the system off grid, so later lines about them have a start.
      const here = [...nowIn].map((flightID) => safe(() => inspect.getFlightByID(flightID)))
        .filter(Boolean).map((flight) => flightSummary(flight, describeSystem));
      const byFamily = {};
      for (const flight of here) byFamily[flight.family || "other"] = (byFamily[flight.family || "other"] || 0) + 1;
      events.unshift({
        kind: "HERE",
        systemID,
        systemName: systemName(systemID),
        count: here.length,
        byFamily,
        // Pirates first: they are the flights a grid check is usually about.
        flights: here.sort((a, b) => Number(b.family === "pirate") - Number(a.family === "pirate") ||
          a.flightID.localeCompare(b.flightID)).slice(0, 40),
      });
    }
    if (!first) {
      for (const [flightID, flight] of summaries) {
        events.push({ kind: "ENTER", ...flightSummary(flight, describeSystem) });
        incoming.delete(flightID);
      }
      for (const flightID of inSystem) {
        if (nowIn.has(flightID)) continue;
        const flight = inspect.getFlightByID ? safe(() => inspect.getFlightByID(flightID)) : null;
        events.push(flight
          ? { kind: "EXIT", ...flightSummary(flight, describeSystem), fromSystemName: systemName(systemID) }
          : { kind: "EXIT", flightID, fromSystemName: systemName(systemID), phase: "gone" });
      }
    }
    inSystem = nowIn;
    endedHunts(huntsSeen, context, systemID, events);
    scanEncounters(encountersHere, events);
    scanLosses(systemID, nowMs, events);
    first = false;
    return { events, stats };
  }

  return { scan };
}

// The plugin's offGrid hook: one tracker per watch. Its stats name the
// flights it walked, which the watch's END prints as flightsScanned.
function createLuOffGrid({ inspect = null, describeSystem = null, luNowMs = null } = {}) {
  return {
    watch({ characterID, startedAtMs }) {
      const tracker = createOffGridTracker({ inspect, describeSystem, characterID, startedAtMs, luNowMs });
      return {
        scan(systemID, context) {
          const { events, stats } = tracker.scan(systemID, context);
          return { events, stats: { flightsScanned: stats.flights } };
        },
      };
    },
  };
}

module.exports = {
  createLuOffGrid,
  createOffGridTracker,
  flightSummary,
};
