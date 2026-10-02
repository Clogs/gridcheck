"use strict";

// What `gridcheck warp` and `gridcheck economy` read and drive: the Living Universe clock,
// the warp driver, and the economy telemetry a report is built from. Every
// engine reach is a seam passed in, so the projections are testable from
// literals.

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

// The scheduler's own numbers for "is the world keeping up". A warp that falls
// behind shows it here instead of looking healthy.
function projectBacklog(scheduler) {
  if (!scheduler || typeof scheduler !== "object") return null;
  const metrics = scheduler.metrics || {};
  return {
    flightsOverdueMs: finite(scheduler.generalOldestOverdueMs),
    replacementFlightsOverdueMs: finite(scheduler.replacementPriorityOldestOverdueMs),
    deferredDuePasses: finite(metrics.deferredDuePasses),
    eventBackpressurePasses: finite(metrics.eventBackpressurePasses),
    nextEconomyWakeInMs: scheduler.nextEconomyWakeInMs === null ? null : finite(scheduler.nextEconomyWakeInMs),
  };
}

function projectPulseTiming(pulseTiming) {
  if (!pulseTiming || typeof pulseTiming !== "object") return null;
  const budget = pulseTiming.lastWorkBudget || null;
  const stages = budget && budget.stages
    ? Object.entries(budget.stages)
      .map(([name, stage]) => ({
        name,
        wallMs: Math.round(finite(stage.totalWallDurationMs)),
        externalWaitMs: Math.round(finite(stage.externalWaitMs)),
        yields: finite(stage.cooperativeYields),
      }))
      .sort((left, right) => right.wallMs - left.wallMs)
    : [];
  return {
    completedPulses: finite(pulseTiming.completedPulses),
    pulseFailures: finite(pulseTiming.pulseFailures),
    consecutivePulseFailures: finite(pulseTiming.consecutivePulseFailures),
    lastDurationMs: Math.round(finite(pulseTiming.lastDurationMs)),
    averageDurationMs: Math.round(finite(pulseTiming.averageDurationMs)),
    maxDurationMs: Math.round(finite(pulseTiming.maxDurationMs)),
    lastWorkBudget: budget
      ? {
        budgetMs: finite(budget.budgetMs),
        wallMs: Math.round(finite(budget.wallDurationMs)),
        externalWaits: finite(budget.externalWaits),
        externalWaitMs: Math.round(finite(budget.totalExternalWaitMs)),
        yields: finite(budget.yields),
        maximumSliceMs: Math.round(finite(budget.maximumSliceMs) * 10) / 10,
        stages,
      }
      : null,
  };
}

// One telemetry snapshot, reduced to what the report compares.
function projectSnapshot(snapshot) {
  const industry = snapshot.industry || {};
  const traders = snapshot.traders || {};
  const market = snapshot.market || {};
  const deltas = snapshot.metricDeltas || {};
  return {
    sequence: finite(snapshot.sequence),
    baseline: snapshot.baseline === true,
    capturedAtMs: finite(snapshot.capturedAtMs),
    periodSeconds: finite(snapshot.periodSeconds),
    industry: {
      jobsInstalled: finite(industry.jobsInstalled),
      jobsCompleted: finite(industry.jobsCompleted),
      outputUnitsProduced: finite(industry.outputUnitsProduced),
      outputValueISK: finite(industry.outputValueISK),
    },
    freight: {
      jobsPurchased: finite(traders.jobsPurchased),
      jobsDelivered: finite(traders.jobsDelivered),
      jobsLost: finite(traders.jobsLost),
      unitsSold: finite(traders.unitsSold),
    },
    market: {
      targetFillPercent: finite(market.targetFillPercent),
      stockUnits: finite(market.stockUnits),
      stockValue: finite(market.stockValue),
      stationCount: finite(market.stationCount),
      stations: Array.isArray(market.stations)
        ? market.stations.map((station) => ({
          stationID: finite(station.stationID),
          stationName: String(station.stationName || ""),
          targetFillPercent: finite(station.targetFillPercent),
          stockUnits: finite(station.stockUnits),
        }))
        : [],
    },
    deltas: {
      jobsDelivered: finite(deltas.jobsDelivered),
      unitsDelivered: finite(deltas.unitsDelivered),
      unitsProduced: finite(deltas.unitsProduced),
      miningDepositsDelivered: finite(deltas.miningDepositsDelivered),
    },
  };
}

function projectEconomyStatus(status) {
  if (!status || typeof status !== "object") return null;
  const industry = status.industry || {};
  const metrics = status.metrics || {};
  const procurement = status.procurement || {};
  return {
    lastPulseAtMs: finite(status.lastPulseAtMs, null),
    lastPulseError: status.lastPulseError || null,
    activeJobs: finite(status.activeJobs),
    jobStatuses: status.jobStatuses || {},
    industry: {
      activeJobs: finite(industry.activeJobs),
      jobsCompleted: finite(industry.jobsCompleted),
      outputUnitsProduced: finite(industry.outputUnitsProduced),
    },
    freight: {
      jobsDelivered: finite(metrics.jobsDelivered),
      jobsLost: finite(metrics.jobsLost),
      unitsDelivered: finite(metrics.unitsDelivered),
    },
    procurement: {
      openOrders: finite(procurement.openOrders),
      cashISK: finite(procurement.cashISK),
      escrowISK: finite(procurement.escrowISK),
      spentISK: finite(procurement.spentISK),
    },
    telemetry: status.telemetry
      ? { snapshots: finite(status.telemetry.snapshots), intervalMs: finite(status.telemetry.intervalMs) }
      : null,
  };
}

function createAgentBridgeWarp({ warp, clock, economy, universe }) {
  const backlog = () => {
    try {
      return projectBacklog(universe.getSchedulerStatus(clock.now()));
    } catch (_error) {
      return null;
    }
  };

  function clockStatus() {
    let pulse = null;
    try {
      pulse = projectPulseTiming(economy.getStatus().pulseTiming);
    } catch (_error) {
      pulse = null;
    }
    return { ...warp.status(), backlog: backlog(), pulse };
  }

  function economyReport(sinceSimMs) {
    const since = finite(sinceSimMs, 0);
    let status = null;
    try {
      status = projectEconomyStatus(economy.getStatus());
    } catch (_error) {
      status = null;
    }
    return {
      simNowMs: clock.now(),
      offsetMs: clock.getOffsetMs(),
      since,
      status,
      backlog: backlog(),
      snapshots: economy.listTelemetrySnapshots(since).map(projectSnapshot),
    };
  }

  return { clockStatus, economyReport, backlog };
}

module.exports = {
  createAgentBridgeWarp,
  projectBacklog,
  projectPulseTiming,
  projectSnapshot,
  projectEconomyStatus,
};
