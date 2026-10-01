"use strict";

// `e2e warp`: durations, the economy report and the fidelity comparison. Pure
// functions over what the agent bridge's /economy and /warp return, so they
// are testable from literals.

const HOUR_MS = 60 * 60 * 1000;

// Step 1 of the simulation-clock phase set these. A warped run and a real-time
// run from the same saved world agree when every compared number is within its
// tolerance. Counts get a relative tolerance with an absolute floor, because a
// quiet window of 3 jobs against 5 is noise, not a divergence. See
// docs/E2E-GRID-TESTING.md "Warping the off-grid world".
const TOLERANCES = Object.freeze({
  industryJobsCompleted: { relative: 0.2, absolute: 5 },
  freightJobsDelivered: { relative: 0.2, absolute: 5 },
  freightUnitsDelivered: { relative: 0.3, absolute: 500 },
  stockUnits: { relative: 0.02, absolute: 1000 },
  targetFillPercent: { relative: 0, absolute: 2 },
});

function parseDuration(text) {
  const raw = String(text === undefined || text === null ? "" : text).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2] || "s";
  const factor = { ms: 1, s: 1000, m: 60_000, h: HOUR_MS, d: 24 * HOUR_MS }[unit];
  const ms = Math.round(value * factor);
  return ms > 0 ? ms : null;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

// A clock offset: negative for a world resumed behind real time.
function formatOffset(ms) {
  const value = Number(ms) || 0;
  return `${value < 0 ? "-" : "+"}${formatDuration(Math.abs(value))}`;
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function delta(end, start, pick) {
  return number(pick(end)) - number(pick(start));
}

// The snapshot a window starts from: the newest captured at or before its start.
function snapshotAtOrBefore(snapshots, atMs) {
  let found = null;
  for (const snapshot of snapshots) {
    if (snapshot.capturedAtMs <= atMs && (!found || snapshot.capturedAtMs > found.capturedAtMs)) found = snapshot;
  }
  return found;
}

// start and end are /economy replies; the end reply's snapshots reach back to
// before the window's start, so the stock the window started with is in them.
function buildEconomySummary({ start, end, mode, warp = null, realMs }) {
  const startStatus = start && start.status || {};
  const endStatus = end && end.status || {};
  const windowStartMs = number(start && start.simNowMs);
  const windowEndMs = number(end && end.simNowMs);
  const snapshots = Array.isArray(end && end.snapshots) ? end.snapshots : [];
  const inWindow = snapshots.filter((snapshot) => snapshot.capturedAtMs > windowStartMs && !snapshot.baseline);
  const first = snapshotAtOrBefore(snapshots, windowStartMs) || inWindow[0] || null;
  const last = inWindow.length ? inWindow[inWindow.length - 1] : first;
  const simulatedMs = Math.max(0, windowEndMs - windowStartMs);
  return {
    mode,
    windowStartMs,
    windowEndMs,
    simulatedMs,
    realMs: number(realMs),
    speed: number(realMs) > 0 ? simulatedMs / number(realMs) : 0,
    offsetMs: number(end && end.offsetMs),
    industry: {
      jobsCompleted: delta(endStatus, startStatus, (s) => s.industry && s.industry.jobsCompleted),
      outputUnitsProduced: delta(endStatus, startStatus, (s) => s.industry && s.industry.outputUnitsProduced),
      activeJobsAtEnd: number(endStatus.industry && endStatus.industry.activeJobs),
    },
    freight: {
      jobsDelivered: delta(endStatus, startStatus, (s) => s.freight && s.freight.jobsDelivered),
      jobsLost: delta(endStatus, startStatus, (s) => s.freight && s.freight.jobsLost),
      unitsDelivered: delta(endStatus, startStatus, (s) => s.freight && s.freight.unitsDelivered),
      activeJobsAtEnd: number(endStatus.activeJobs),
    },
    stock: {
      startSnapshot: first ? first.sequence : null,
      endSnapshot: last ? last.sequence : null,
      stockUnitsStart: first ? number(first.market.stockUnits) : null,
      stockUnitsEnd: last ? number(last.market.stockUnits) : null,
      targetFillPercentStart: first ? number(first.market.targetFillPercent) : null,
      targetFillPercentEnd: last ? number(last.market.targetFillPercent) : null,
      stockValueEnd: last ? number(last.market.stockValue) : null,
      lowestStations: last && Array.isArray(last.market.stations) ? last.market.stations.slice(0, 8) : [],
    },
    procurement: {
      openOrdersStart: number(startStatus.procurement && startStatus.procurement.openOrders),
      openOrdersEnd: number(endStatus.procurement && endStatus.procurement.openOrders),
      spentISK: delta(endStatus, startStatus, (s) => s.procurement && s.procurement.spentISK),
    },
    pulses: {
      lastPulseError: endStatus.lastPulseError || null,
    },
    backlog: end && end.backlog || null,
    snapshots: inWindow.map((snapshot) => ({
      sequence: snapshot.sequence,
      atOffsetMs: snapshot.capturedAtMs - windowStartMs,
      industryJobsCompleted: snapshot.industry.jobsCompleted,
      freightJobsDelivered: snapshot.freight.jobsDelivered,
      stockUnits: snapshot.market.stockUnits,
      targetFillPercent: snapshot.market.targetFillPercent,
    })),
    warp: warp ? {
      passes: number(warp.passes),
      stepMs: number(warp.stepMs),
      pulseWaits: number(warp.pulseWaits),
      pulseWaitMs: number(warp.pulseWaitMs),
      maxPulseWaitMs: number(warp.maxPulseWaitMs),
      passWorkMs: number(warp.passWorkMs),
      maxPassMs: number(warp.maxPassMs),
      stopReason: warp.stopReason || null,
    } : null,
  };
}

function fmt(value, digits = 0) {
  if (value === null || value === undefined) return "-";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function renderEconomyMarkdown(summary, { runID, world } = {}) {
  const lines = [];
  lines.push(`# Economy report: ${runID || "run"}`);
  lines.push("");
  lines.push(`- Mode: ${summary.mode === "warp" ? "warped" : "real time"}`);
  if (world) lines.push(`- World: ${world}`);
  lines.push(`- Simulated: ${formatDuration(summary.simulatedMs)} in ${formatDuration(summary.realMs)} real ` +
    `(${fmt(summary.speed, 1)}x)`);
  lines.push(`- Living Universe clock: ${new Date(summary.windowStartMs).toISOString()} to ` +
    `${new Date(summary.windowEndMs).toISOString()}, offset ${formatOffset(summary.offsetMs)}`);
  lines.push("- Market price history is left out: the daemon groups trades by real calendar day.");
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("| --- | --- |");
  lines.push(`| NPC industry jobs completed | ${fmt(summary.industry.jobsCompleted)} |`);
  lines.push(`| Industry output units | ${fmt(summary.industry.outputUnitsProduced)} |`);
  lines.push(`| Industry jobs active at end | ${fmt(summary.industry.activeJobsAtEnd)} |`);
  lines.push(`| Freight deliveries | ${fmt(summary.freight.jobsDelivered)} |`);
  lines.push(`| Freight units delivered | ${fmt(summary.freight.unitsDelivered)} |`);
  lines.push(`| Freight jobs lost | ${fmt(summary.freight.jobsLost)} |`);
  lines.push(`| Freight jobs active at end | ${fmt(summary.freight.activeJobsAtEnd)} |`);
  lines.push(`| Regional stock units, start -> end | ${fmt(summary.stock.stockUnitsStart)} -> ${fmt(summary.stock.stockUnitsEnd)} |`);
  lines.push(`| Regional target fill, start -> end | ${fmt(summary.stock.targetFillPercentStart, 2)}% -> ` +
    `${fmt(summary.stock.targetFillPercentEnd, 2)}% |`);
  lines.push(`| Procurement orders open, start -> end | ${fmt(summary.procurement.openOrdersStart)} -> ` +
    `${fmt(summary.procurement.openOrdersEnd)} |`);
  lines.push(`| Procurement ISK spent | ${fmt(summary.procurement.spentISK)} |`);
  lines.push("");
  lines.push("## Backlog");
  lines.push("");
  const backlog = summary.backlog;
  if (backlog) {
    lines.push(`- Oldest overdue flight: ${formatDuration(backlog.flightsOverdueMs)}; ` +
      `replacement freight: ${formatDuration(backlog.replacementFlightsOverdueMs)}.`);
    lines.push(`- Passes that left due flights for the next pass: ${fmt(backlog.deferredDuePasses)} (since boot); ` +
      `passes skipped for economy backpressure: ${fmt(backlog.eventBackpressurePasses)}.`);
  } else {
    lines.push("- Not available.");
  }
  if (summary.pulses.lastPulseError) lines.push(`- Last economy pulse error: ${summary.pulses.lastPulseError}`);
  if (summary.warp) {
    const w = summary.warp;
    lines.push("");
    lines.push("## Warp");
    lines.push("");
    lines.push(`- ${fmt(w.passes)} passes of ${fmt(w.stepMs)} ms; pass work ${formatDuration(w.passWorkMs)} ` +
      `(max ${fmt(w.maxPassMs, 1)} ms).`);
    lines.push(`- Waited on ${fmt(w.pulseWaits)} economy pulses for ${formatDuration(w.pulseWaitMs)} ` +
      `(max ${fmt(w.maxPulseWaitMs)} ms).`);
    lines.push(`- Ended: ${w.stopReason || "?"}.`);
  }
  lines.push("");
  lines.push("## Telemetry snapshots in the window");
  lines.push("");
  if (summary.snapshots.length) {
    lines.push("| # | At | Industry jobs | Freight deliveries | Stock units | Target fill |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of summary.snapshots) {
      lines.push(`| ${row.sequence} | +${formatDuration(row.atOffsetMs)} | ${fmt(row.industryJobsCompleted)} | ` +
        `${fmt(row.freightJobsDelivered)} | ${fmt(row.stockUnits)} | ${fmt(row.targetFillPercent, 2)}% |`);
    }
  } else {
    lines.push("None: the window was shorter than one telemetry interval.");
  }
  if (summary.stock.lowestStations.length) {
    lines.push("");
    lines.push("## Lowest-filled stations at the end");
    lines.push("");
    lines.push("| Station | Target fill | Stock units |");
    lines.push("| --- | --- | --- |");
    for (const station of summary.stock.lowestStations) {
      lines.push(`| ${station.stationName || station.stationID} | ${fmt(station.targetFillPercent, 2)}% | ${fmt(station.stockUnits)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function within(left, right, tolerance) {
  const a = number(left);
  const b = number(right);
  const allowed = Math.max(tolerance.absolute, tolerance.relative * Math.max(Math.abs(a), Math.abs(b)));
  return { a, b, difference: b - a, allowed, ok: Math.abs(b - a) <= allowed };
}

function compareSummaries(reference, candidate, tolerances = TOLERANCES) {
  const rows = [
    ["industryJobsCompleted", reference.industry.jobsCompleted, candidate.industry.jobsCompleted],
    ["freightJobsDelivered", reference.freight.jobsDelivered, candidate.freight.jobsDelivered],
    ["freightUnitsDelivered", reference.freight.unitsDelivered, candidate.freight.unitsDelivered],
    ["stockUnits", reference.stock.stockUnitsEnd, candidate.stock.stockUnitsEnd],
    ["targetFillPercent", reference.stock.targetFillPercentEnd, candidate.stock.targetFillPercentEnd],
  ].map(([name, a, b]) => ({ name, ...within(a, b, tolerances[name]) }));
  return { ok: rows.every((row) => row.ok), rows };
}

module.exports = {
  TOLERANCES,
  buildEconomySummary,
  compareSummaries,
  formatDuration,
  formatOffset,
  parseDuration,
  renderEconomyMarkdown,
  snapshotAtOrBefore,
};
