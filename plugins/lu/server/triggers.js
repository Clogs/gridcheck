"use strict";

// On-demand triggers for `e2e trigger`: put a feature in motion in one call
// instead of teleporting around and hoping. Each trigger calls the entry point
// the feature itself uses, so every gate still applies, and answers with the
// flight or hunt ID it touched, which the watch prints beside every line.
//
//   scout        an existing pirate scout takes a patrol leg to a system; it
//                spends no fresh patrol for 10 minutes, so it holds there.
//                Flights are minted only by the population plan, so nothing
//                spawns a new one.
//   hunt         a materialized pirate flight on your system scans you and the
//                hunt coordinator's own start runs on it, at stalking or committed.
//   fleet        ready flights of a family (and doctrine) are claimed onto a
//                journey to a system, or to your ship's grid, and hold there.
//                That journey keeps custody, so such a flight can't lead a hunt.
//   materialize  pin a flight so it skips the per-tick batch limit and, for a
//                mission journey, make it due now. --go also jumps you there.
//
// Guide: docs/E2E-GRID-TESTING.md "Triggers".

const SCOUT_HOLD_MS = 10 * 60 * 1000;
const MAX_SCOUT_PATH = 25;
const MAX_FLEET_COUNT = 8;
const HUNT_PHASES = new Set(["stalking", "committed"]);
// The hunt module ticks every 2 s, but straight after boot a world catching up
// its backlog was measured taking 20 s to reach it.
const TICK_TIMEOUT_MS = 60_000;

const AU = 149_597_870_700;
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;
const toPositiveInt = (value) => {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
};

class TriggerRefused extends Error {
  constructor(message, statusCode = 409, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

// Settles once, without Promise.race, whose losing input trips the server's
// multipleResolves warning.
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => settle(reject, onTimeout()), ms);
    promise.then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
}

function describeFlight(flight) {
  return {
    flightID: flight.flightID,
    family: flight.family || null,
    pirateRole: flight.pirateRole || null,
    doctrine: flight.doctrineFactionKey || null,
    hulls: (flight.actorIDs || []).length,
    systemID: Number(flight.currentSystemID) || null,
    phase: flight.phase || null,
  };
}

function createAgentBridgeTriggers({
  findSession, space, lu, hunts, simNow, staticAnchors, executeChatCommand = null, tickTimeoutMs = TICK_TIMEOUT_MS,
  scouts,
}) {
  // _secondary/pirateScouts, passed in so this file loads in any tree.
  const { isScout, patrolOwner } = scouts;
  let fleetSeq = 0;

  function sessionFor(characterID) {
    const id = toPositiveInt(characterID);
    if (!id) throw new TriggerRefused("A positive characterID is required.", 400);
    const session = findSession(id);
    if (!session) throw new TriggerRefused("That character has no live session. Log it in first (e2e login).");
    return session;
  }

  function systemOf(session) {
    return toPositiveInt((session._space && session._space.systemID) || session.solarsystemid2 || session.solarsystemid);
  }

  // The character's ship in its scene, or a refusal saying why there is none.
  function shipOf(session) {
    const scene = session._space ? space.getSceneForSession(session) : null;
    const ship = scene && typeof scene.getShipEntityForSession === "function" ? scene.getShipEntityForSession(session) : null;
    if (!ship) throw new TriggerRefused("The character is docked or has no ship in space. Undock first (e2e undock).");
    return { scene, ship, systemID: systemOf(session) };
  }

  function inTick(run) {
    if (!hunts || typeof hunts.requestInTick !== "function") {
      throw new TriggerRefused("This server has no pirate hunt module loaded.", 503);
    }
    // A request the caller gave up on must not act when its tick finally comes.
    let abandoned = false;
    const queued = hunts.requestInTick((tools) => {
      if (abandoned) throw new TriggerRefused("abandoned: the caller timed out", 503);
      return run(tools);
    });
    return withTimeout(queued, tickTimeoutMs, () => {
      abandoned = true;
      return new TriggerRefused(`The pirate hunt tick did not run within ${tickTimeoutMs / 1000}s, so nothing was done. ` +
        "Right after boot the Living Universe can be catching up; retry. Otherwise check livingUniversePirateHuntsEnabled.", 503);
    });
  }

  // Patrol custody, the way patrolScouts takes it: a scout already on a patrol
  // diverts, an idle one claims a patrol leg.
  function scout(body) {
    const session = sessionFor(body.characterID);
    const systemID = toPositiveInt(body.systemID) || systemOf(session);
    if (!systemID) throw new TriggerRefused("No systemID, and the character's system is unknown.", 400);
    const wanted = body.flightID ? String(body.flightID) : null;
    return inTick((t) => {
      const now = t.nowMs;
      const refusals = {};
      const note = (reason) => { refusals[reason] = (refusals[reason] || 0) + 1; };
      const candidates = [];
      for (const f of t.flights) {
        if (!isScout(f) || (wanted && f.flightID !== wanted)) continue;
        if (f.huntLeaderID || f.pirateHunt || f.encounterID) { note("in-a-hunt-or-encounter"); continue; }
        // Its own patrol may redirect it mid-journey (applied at the next leg boundary);
        // patrolScouts only waits for arrival to pace its laps. Anything else must be free.
        if (patrolOwner(f) ? t.patrol.pinned(f, now) : !t.assignments.ready(f, now)) {
          note(patrolOwner(f) ? "pinned-by-combat" : "reserved-or-unsupplied");
          continue;
        }
        if (!t.patrol.safe(f, systemID)) { note("outside-its-hunting-corridors"); continue; }
        // The coordinator's own test, as it will run once the scout is there: a way home
        // through hunting grounds only. Home is the journey's, or here for a fresh patrol leg.
        // A scout that fails it still patrols there and still reports; it just never leads a hunt.
        const there = { ...f, currentSystemID: systemID,
          missionJourney: f.missionJourney || { home: { systemID: Number(f.currentSystemID) } } };
        const canHunt = Boolean(t.coordinator.viable(there, { systemID }));
        if (!canHunt) note("could-not-hunt-there");
        const path = Number(f.currentSystemID) === systemID ? [systemID] : t.patrol.path(f.currentSystemID, systemID);
        if (!path || path.length > MAX_SCOUT_PATH || path.some((id) => t.patrol.blocked(id))) { note("no-route"); continue; }
        candidates.push({ f, path, canHunt });
      }
      candidates.sort((a, b) => Number(b.canHunt) - Number(a.canHunt) || a.path.length - b.path.length ||
        String(a.f.flightID).localeCompare(String(b.f.flightID)));
      const anchor = t.patrol.anchor(systemID);
      if (!anchor) throw new TriggerRefused(`System ${systemID} has no stargate, planet or station to patrol to.`);
      for (const { f, path, canHunt } of candidates) {
        const owner = patrolOwner(f);
        const result = owner ? t.journeys.divert(f.flightID, owner, anchor, now)
          : t.patrol.claim(f, { ownerID: `pirate-scout:${f.flightID}`, kind: "pirate_scout_patrol", destination: anchor }, now);
        if (!result || !result.success) { note(`journey-${(result && result.errorMsg) || "refused"}`); continue; }
        f.scoutPatrolAtMs = now + SCOUT_HOLD_MS;
        t.patrol.mark(f);
        return { trigger: "scout", flightID: f.flightID, flight: describeFlight(f), fromSystemID: Number(path[0]),
          systemID, anchorID: anchor.anchorID, jumps: path.length - 1, holdsUntilMs: f.scoutPatrolAtMs, canHunt, refusals };
      }
      throw new TriggerRefused(wanted ? `Scout ${wanted} can't go to ${systemID}.` : `No scout can go to ${systemID}.`,
        409, { refusals });
    });
  }

  // The coordinator's own start, on a report the flight's own sensors made.
  function hunt(body) {
    const session = sessionFor(body.characterID);
    const { ship, systemID } = shipOf(session);
    const phase = body.phase === undefined || body.phase === null ? "stalking" : String(body.phase);
    if (!HUNT_PHASES.has(phase)) throw new TriggerRefused("phase must be stalking or committed.", 400);
    const wanted = body.flightID ? String(body.flightID) : null;
    return inTick((t) => {
      const now = t.nowMs;
      const scene = t.space.scenes.get(systemID);
      const nearest = (f) => Math.min(...t.entities(f).map((e) => distance(e.position, ship.position)));
      let leader = wanted ? t.state.flights[wanted] : null;
      if (wanted && !leader) throw new TriggerRefused(`No flight ${wanted}.`, 404);
      if (!leader) {
        const here = t.flights.filter((f) => Number(f.currentSystemID) === systemID && !f.pirateHunt &&
          !f.huntLeaderID && t.entities(f).length);
        // First the flights start would accept: free (or on their own patrol) and able to get home.
        const fit = (f) => Number(Boolean(t.assignments.ready(f, now, { handoffOwnerID: patrolOwner(f) }))) * 2 +
          Number(Boolean(t.coordinator.viable(f, { systemID })));
        here.sort((a, b) => fit(b) - fit(a) || Number(isScout(b)) - Number(isScout(a)) || nearest(a) - nearest(b));
        leader = here[0];
      }
      if (!leader) {
        throw new TriggerRefused(`No materialized pirate flight in system ${systemID}. ` +
          "Send one (e2e trigger scout), then stand it up (e2e trigger materialize <flightID>).");
      }
      if (Number(leader.currentSystemID) !== systemID) {
        throw new TriggerRefused(`${leader.flightID} is in system ${leader.currentSystemID}, not yours (${systemID}).`);
      }
      const observer = t.entities(leader).sort((a, b) => distance(a.position, ship.position) - distance(b.position, ship.position))[0];
      if (!observer) throw new TriggerRefused(`${leader.flightID} has no hulls on this system yet (e2e trigger materialize ${leader.flightID}).`);
      const controller = t.registry.getControllerByEntityID(observer.itemID);
      if (!controller) throw new TriggerRefused(`${leader.flightID}'s ship has no NPC controller.`);
      let unseen = null;
      // Sensors run on scene time, as the behaviour loop runs them; the coordinator on LU time.
      const sceneNow = scene && typeof scene.getCurrentSimTimeMs === "function" ? Number(scene.getCurrentSimTimeMs()) : now;
      const report = t.hunterIntel.scanTarget(scene, observer, controller, ship, sceneNow, (reason) => { unseen = reason; });
      if (!report) {
        // The gates are hunterIntel's; these are only the facts they read.
        const facts = { distanceAU: Number((distance(observer.position, ship.position) / AU).toFixed(2)),
          scoutMode: observer.mode || null, scoutWarping: Boolean(observer.warpState),
          youMode: ship.mode || null, youWarping: Boolean(ship.warpState),
          youProtectedUntilMs: Math.max(Number(ship.timedInvulnerabilityUntilMs) || 0,
            Number(ship.undockInvulnerabilityUntilMs) || 0) || null };
        throw new TriggerRefused(`${leader.flightID}'s scan refused you: ${unseen}.`, 409, { reason: unseen, facts });
      }
      let refusal = null;
      const offered = t.reports(leader).filter((r) => r.targetID === ship.itemID);
      const started = t.coordinator.start(leader, offered, now, (reason) => { refusal = reason; });
      if (!started) {
        throw new TriggerRefused(`The hunt coordinator refused ${leader.flightID}: ${refusal}.`, 409, {
          reason: refusal,
          facts: { nowMs: now, huntCancelledAtMs: leader.huntCancelledAtMs || 0, reports: offered.length,
            report: offered.map((r) => `${r.source}/${r.observerFlightID}/obs${r.observedAtMs}/exp${r.expiresAtMs}`).join(",") },
        });
      }
      if (phase === "committed") t.coordinator.commit(leader, "trigger-committed", now);
      const h = leader.pirateHunt;
      return { trigger: "hunt", huntID: h.id, flightID: leader.flightID, flight: describeFlight(leader),
        phase: h.phase, report: { source: report.source, targetID: report.targetID },
        trace: (h.trace || []).map((step) => `${step.phase}:${step.reason}`) };
    });
  }

  function destinationFor(body, session) {
    const toSelf = body.grid === true || body.to === "self";
    if (toSelf) {
      const { ship, systemID } = shipOf(session);
      return { systemID, anchorID: Number(ship.itemID), grid: true };
    }
    const systemID = toPositiveInt(body.systemID) || systemOf(session);
    if (!systemID) throw new TriggerRefused("No systemID, and the character's system is unknown.", 400);
    const anchor = toPositiveInt(body.anchorID) ? { itemID: toPositiveInt(body.anchorID) }
      : staticAnchors(systemID).find((a) => a.kind === "stargate") || staticAnchors(systemID).find((a) => a.stationID);
    if (!anchor) throw new TriggerRefused(`System ${systemID} has no stargate or station to send a fleet to.`);
    return { systemID, anchorID: Number(anchor.itemID || anchor.stationID), grid: false };
  }

  function matchesDoctrine(flight, doctrine) {
    if (!doctrine) return true;
    const wanted = doctrine.toLowerCase();
    return [flight.doctrineFactionKey, flight.spawnGroupID, flight.pirateRole]
      .some((value) => value && String(value).toLowerCase().includes(wanted));
  }

  // The dispatch pattern every LU feature uses (allianceDefence, protection,
  // salvage): ready, then claim; the claim checks custody and route legality.
  function fleet(body) {
    const session = sessionFor(body.characterID);
    const family = String(body.family || "").trim().toLowerCase();
    if (!family) throw new TriggerRefused("family is required, e.g. pirate, police, defence, miner.", 400);
    const count = Math.min(MAX_FLEET_COUNT, toPositiveInt(body.count) || 1);
    const doctrine = body.doctrine ? String(body.doctrine) : null;
    const destination = destinationFor(body, session);
    const now = simNow();
    const refusals = {};
    const note = (reason) => { refusals[reason] = (refusals[reason] || 0) + 1; };
    const candidates = [];
    for (const f of lu.inspect.listFlights()) {
      if (String(f.family || "").toLowerCase() !== family || !matchesDoctrine(f, doctrine)) continue;
      if (isScout(f) && !(doctrine && /scout/i.test(doctrine))) continue;
      if (!lu.assignments.ready(f, now)) { note("reserved-or-unsupplied"); continue; }
      const path = Number(f.currentSystemID) === destination.systemID ? [destination.systemID]
        : lu.journeys.pathTo(Number(f.currentSystemID), destination.systemID, f);
      if (!path) { note("no-route"); continue; }
      candidates.push({ f, path });
    }
    candidates.sort((a, b) => a.path.length - b.path.length || String(a.f.flightID).localeCompare(String(b.f.flightID)));
    fleetSeq += 1;
    const ownerID = `e2e-fleet:${now}:${fleetSeq}`;
    const sent = [];
    for (const { f, path } of candidates) {
      if (sent.length >= count) break;
      // No holdPosition: that keeps a flight already in the system where it is. It holds on arrival.
      const result = lu.assignments.claim(f, { ownerID, kind: "e2e_fleet",
        destination: { systemID: destination.systemID, anchorID: destination.anchorID } }, now);
      if (!result || !result.success) { note(`claim-${(result && result.errorMsg) || "refused"}`); continue; }
      sent.push({ ...describeFlight(f), fromSystemID: Number(path[0]), jumps: path.length - 1 });
    }
    if (!sent.length) {
      throw new TriggerRefused(`No ${family}${doctrine ? ` ${doctrine}` : ""} flight could be sent to ${destination.systemID}.`,
        409, { refusals, considered: candidates.length });
    }
    return { trigger: "fleet", ownerID, systemID: destination.systemID, anchorID: destination.anchorID,
      grid: destination.grid, flights: sent, refusals };
  }

  function materialize(body) {
    const flightID = String((body && body.flightID) || "").trim();
    if (!flightID) throw new TriggerRefused("flightID is required.", 400);
    const now = simNow();
    const result = lu.machines.materializeFlightNow(flightID, now);
    if (!result || !result.success) throw new TriggerRefused(`No flight ${flightID}.`, 404);
    const flight = result.flight;
    const systemID = Number(flight.currentSystemID) || 0;
    let moved = null;
    if (body.go === true) {
      const session = sessionFor(body.characterID);
      if (systemOf(session) !== systemID) {
        if (typeof executeChatCommand !== "function") throw new TriggerRefused("No chat command handler to jump with.", 503);
        const reply = executeChatCommand(session, `/solar ${systemID}`, null, {});
        moved = { command: `/solar ${systemID}`, success: Boolean(reply && reply.success), message: String((reply && reply.message) || "") };
      }
    }
    const scene = space.scenes.get(systemID);
    return { trigger: "materialize", flightID: flight.flightID, flight: describeFlight(flight), systemID,
      pinned: true, madeDue: result.madeDue, materialized: Boolean(flight.materialized),
      observed: Boolean(scene && scene.sessions && scene.sessions.size > 0), moved };
  }

  const TRIGGERS = { scout, hunt, fleet, materialize };

  async function run(name, body) {
    const trigger = TRIGGERS[name];
    if (!trigger) {
      return { statusCode: 404, body: { ok: false, error: `no trigger ${name}; known: ${Object.keys(TRIGGERS).join(", ")}` } };
    }
    try {
      return { statusCode: 200, body: { ok: true, ...(await trigger(body || {})) } };
    } catch (error) {
      if (!(error instanceof TriggerRefused)) throw error;
      return { statusCode: error.statusCode, body: { ok: false, error: error.message, ...error.details } };
    }
  }

  return { run, names: () => Object.keys(TRIGGERS) };
}

module.exports = {
  createAgentBridgeTriggers,
  SCOUT_HOLD_MS,
  TriggerRefused,
};
