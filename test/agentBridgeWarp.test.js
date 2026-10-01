"use strict";

// The agent bridge's warp routes and the projections `e2e warp` reads.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAgentBridgeRoutes } = require("../bridge/routes");
const {
  createAgentBridgeWarp,
  projectBacklog,
  projectPulseTiming,
  projectSnapshot,
} = require("../plugins/lu/server/warp");

function fakeWarp({ refuse = null } = {}) {
  const calls = [];
  let progress = null;
  let finish = null;
  return {
    calls,
    emit: (event) => progress(event),
    end: (final) => finish(final),
    start(options, onProgress) {
      calls.push(options);
      if (refuse) return { ok: false, error: refuse };
      progress = onProgress;
      const done = new Promise((resolve) => { finish = resolve; });
      return { ok: true, done, status: () => ({ running: true, targetSimMs: options.forMs }) };
    },
    stop: () => { calls.push("stop"); return true; },
  };
}

function sink() {
  const lines = [];
  let closed = false;
  return { lines, write: (event) => lines.push(event), closed: () => closed, close: () => { closed = true; } };
}

test("/warp streams START, PROGRESS and END, and a hung-up caller stops the warp", async () => {
  const warp = fakeWarp();
  const routes = createAgentBridgeRoutes({ findSession: () => null, warp, warpBridge: {} });
  const reply = routes.handle("POST", "/warp", {}, { forSeconds: 7200, stepMs: 1000 });
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(warp.calls[0], { forMs: 7_200_000, stepMs: 1000, sliceMs: undefined, economyBudgetMs: undefined });
  const out = sink();
  const streaming = reply.stream(out);
  warp.emit({ simulatedMs: 1000 });
  out.close();
  warp.emit({ simulatedMs: 2000 });
  warp.end({ stopReason: "stopped" });
  await streaming;
  assert.deepEqual(out.lines.map((line) => line.kind), ["START", "PROGRESS", "END"]);
  assert.equal(warp.calls.at(-1), "stop");
});

test("/warp answers 409 with the driver's reason when it refuses", () => {
  const routes = createAgentBridgeRoutes({
    findSession: () => null, warp: fakeWarp({ refuse: "no e2e marker" }), warpBridge: {},
  });
  const reply = routes.handle("POST", "/warp", {}, { forSeconds: 60 });
  assert.equal(reply.statusCode, 409);
  assert.equal(reply.body.error, "no e2e marker");
});

test("/clock and /economy answer from the warp bridge, and 503 without one", () => {
  const warpBridge = { clockStatus: () => ({ offsetMs: 5 }), economyReport: (since) => ({ since }) };
  const routes = createAgentBridgeRoutes({ findSession: () => null, warpBridge });
  assert.deepEqual(routes.handle("GET", "/clock", {}, null).body, { ok: true, clock: { offsetMs: 5 } });
  assert.deepEqual(routes.handle("GET", "/economy", { since: "12" }, null).body, { ok: true, economy: { since: "12" } });
  const bare = createAgentBridgeRoutes({ findSession: () => null });
  assert.equal(bare.handle("GET", "/clock", {}, null).statusCode, 503);
  assert.equal(bare.handle("POST", "/warp", {}, {}).statusCode, 503);
});

test("the projections keep what a report compares and survive missing fields", () => {
  assert.equal(projectBacklog(null), null);
  assert.deepEqual(projectBacklog({ generalOldestOverdueMs: 1200, metrics: { deferredDuePasses: 3 }, nextEconomyWakeInMs: null }), {
    flightsOverdueMs: 1200,
    replacementFlightsOverdueMs: 0,
    deferredDuePasses: 3,
    eventBackpressurePasses: 0,
    nextEconomyWakeInMs: null,
  });
  const pulse = projectPulseTiming({
    completedPulses: 4,
    lastDurationMs: 1500.4,
    lastWorkBudget: {
      budgetMs: 250, wallDurationMs: 1500, totalExternalWaitMs: 200, externalWaits: 9, yields: 3,
      stages: { procurement: { totalWallDurationMs: 300, externalWaitMs: 150, cooperativeYields: 1 },
        freightPlanning: { totalWallDurationMs: 900, externalWaitMs: 0, cooperativeYields: 2 } },
    },
  });
  assert.equal(pulse.lastDurationMs, 1500);
  assert.deepEqual(pulse.lastWorkBudget.stages.map((stage) => stage.name), ["freightPlanning", "procurement"]);
  const row = projectSnapshot({ sequence: 3, capturedAtMs: 10, industry: { jobsCompleted: 2 }, market: {} });
  assert.equal(row.industry.jobsCompleted, 2);
  assert.equal(row.freight.jobsDelivered, 0);
  assert.deepEqual(row.market.stations, []);
});

test("the economy report lists the snapshots since the time asked for", () => {
  const clock = { now: () => 5_000, getOffsetMs: () => 0 };
  const economy = {
    getStatus: () => ({ industry: { jobsCompleted: 7 }, metrics: { jobsDelivered: 2 }, procurement: {} }),
    listTelemetrySnapshots: (since) => [{ sequence: 1, capturedAtMs: 4_000 }, { sequence: 2, capturedAtMs: 4_500 }]
      .filter((snapshot) => snapshot.capturedAtMs >= since),
  };
  const universe = { getSchedulerStatus: () => ({ generalOldestOverdueMs: 0, metrics: {} }) };
  const bridge = createAgentBridgeWarp({ warp: { status: () => ({}) }, clock, economy, universe });
  const report = bridge.economyReport("4200");
  assert.equal(report.status.industry.jobsCompleted, 7);
  assert.equal(report.status.freight.jobsDelivered, 2);
  assert.deepEqual(report.snapshots.map((snapshot) => snapshot.sequence), [2]);
});
