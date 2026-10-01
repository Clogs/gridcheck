"use strict";

// Each NPC on a watched grid, joined to its Living Universe flight, hunt and
// current decision. Read-only, like livingUniverseInspector: nothing here
// writes to a flight, a controller or a hunter report. hunterIntel.fresh()
// prunes the reports it reads, so sightings are read off
// controller.hunterReports directly.

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

// What the controller is doing, from state it already keeps. The NPC engine
// records no per-think reason, so this reads the fields that decide one:
// paused, a manual order, a hunt order, a target, the way home.
function describeDecision(controller, order) {
  if (!controller) return null;
  if (controller.controllerPaused) return `paused:${controller.pausedReason || "paused"}`;
  const manual = controller.manualOrder && controller.manualOrder.kind;
  // pirateHuntOrders answers "staging" for every living pirate with no hunt;
  // only an order a hunt issued (it carries huntID) is a hunt decision.
  const hunting = order && order.mode && (order.huntID || order.mode !== "staging");
  const huntText = hunting ? `hunt:${order.mode}${order.role ? `/${order.role}` : ""}` : null;
  const targetID = toPositiveInt(controller.currentTargetID);
  // The branch the last think returned through (npcBehaviorLoop tickController).
  const last = typeof controller.lastDecision === "string" ? controller.lastDecision : "";
  if (last) {
    if (last === "engage") return huntText && order.mode !== "staging" ? `${huntText}+engaging:${targetID}` : `engaging:${targetID}`;
    if (last === "flee" || last === "flee-warp") return `${last === "flee" ? "fleeing" : "flee-warp"}:${targetID}`;
    if (last === "hunt-order") return huntText || last;
    if (last.startsWith("order-") && manual) return `${last}:${manual}`;
    return last;
  }
  // Before the first think: read the fields that decide one.
  if (manual) return `order:${manual}`;
  if (hunting && order.mode !== "staging") return huntText;
  if (targetID) return `engaging:${targetID}`;
  if (controller.returningHome) return "returning-home";
  if (hunting) return huntText;
  return "idle";
}

function createLuJoin({ inspect = null, controllerFor = null, huntOrderFor = null } = {}) {
  const flightByID = (flightID) => (flightID && inspect && typeof inspect.getFlightByID === "function"
    ? safe(() => inspect.getFlightByID(flightID))
    : null);

  function huntOf(flight) {
    if (!flight) return { leader: null, hunt: null };
    if (flight.pirateHunt && typeof flight.pirateHunt === "object") return { leader: flight, hunt: flight.pirateHunt };
    if (flight.huntLeaderID) {
      const leader = flightByID(flight.huntLeaderID);
      if (leader && leader.pirateHunt) return { leader, hunt: leader.pirateHunt };
    }
    return { leader: null, hunt: null };
  }

  // One O(1) flight lookup, at most one more for the hunt leader, one
  // controller lookup and one order lookup per NPC on the watched grid.
  function annotate(entity, nowMs, characterID = 0) {
    if (!entity) return null;
    const flightID = entity.livingUniverseFlightID ? String(entity.livingUniverseFlightID) : "";
    const controller = typeof controllerFor === "function" ? safe(() => controllerFor(entity.itemID)) : null;
    if (!flightID && !controller) return null;
    const order = typeof huntOrderFor === "function" ? safe(() => huntOrderFor(entity, nowMs)) : null;
    const flight = flightByID(flightID);
    const { leader, hunt } = huntOf(flight);
    const journey = flight && flight.missionJourney && typeof flight.missionJourney === "object"
      ? flight.missionJourney : null;
    const reports = controller && Array.isArray(controller.hunterReports) && characterID
      ? controller.hunterReports.filter((report) => report && toPositiveInt(report.targetCharacterID) === characterID)
      : [];
    return {
      flightID: flightID || null,
      actorID: entity.livingUniverseActorID ? String(entity.livingUniverseActorID) : null,
      family: flight && flight.family ? String(flight.family) : null,
      faction: flight && flight.homeFactionName ? String(flight.homeFactionName) : null,
      corporation: flight && flight.homeCorporationName ? String(flight.homeCorporationName) : null,
      pirateRole: flight && flight.pirateRole ? String(flight.pirateRole) : null,
      phase: flight && flight.phase ? String(flight.phase) : null,
      journeyKind: journey ? String(journey.kind || "") || null : null,
      journeyStage: journey ? String(journey.stage || "") || null : null,
      huntID: hunt ? String(hunt.id || "") || null : null,
      huntRole: hunt ? (leader === flight ? "leader" : "support") : null,
      huntPhase: hunt ? String(hunt.phase || "") || null : null,
      huntReason: hunt ? String(hunt.reason || "") || null : null,
      order: order && order.mode ? { mode: String(order.mode), role: order.role ? String(order.role) : null } : null,
      decision: describeDecision(controller, order),
      sightings: reports.map((report) => ({
        observerID: toPositiveInt(report.observerID),
        source: String(report.source || ""),
        certainty: report.certainty ? String(report.certainty) : null,
        observedAtMs: Number(report.observedAtMs) || 0,
        observerFlightID: report.observerFlightID ? String(report.observerFlightID) : null,
      })),
    };
  }

  return { annotate, flightByID, huntOf };
}

// The plugin's annotate hook: only NPCs and Living Universe ships are joined,
// so a player or a wreck costs one property check. The hunter reports go to
// the onGrid hook (onGrid.js), not onto every event about the ball, and a
// frame keeps only the family it colours by.
function createLuAnnotate(join) {
  return function annotate(entity, { row, nowMs, characterID }) {
    if (!(row && row.isNpc) && !(entity && entity.livingUniverseFlightID)) return null;
    const joined = join.annotate(entity, nowMs, characterID);
    if (!joined) return null;
    const { sightings, ...lu } = joined;
    return {
      groupKey: lu.flightID ? `flight:${lu.flightID}` : null,
      ext: lu,
      hidden: sightings.length ? { sightings } : null,
      pos: lu.family ? { family: lu.family } : null,
    };
  };
}

module.exports = {
  createLuAnnotate,
  createLuJoin,
  describeDecision,
};
