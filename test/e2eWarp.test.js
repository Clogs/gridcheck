"use strict";

// plugins/lu/tool/warp.js and the world marker in plugins/lu/tool/world.js:
// durations, the economy report a warp writes, the fidelity comparison, and
// the clock row a restored world gets.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const warp = require("../plugins/lu/tool/warp");
const worlds = require("../plugins/lu/tool/world");

test("durations read ms, s, m, h and d, and bare numbers are seconds", () => {
  assert.equal(warp.parseDuration("24h"), 86_400_000);
  assert.equal(warp.parseDuration("90m"), 5_400_000);
  assert.equal(warp.parseDuration("3600"), 3_600_000);
  assert.equal(warp.parseDuration("1.5d"), 129_600_000);
  assert.equal(warp.parseDuration("0"), null);
  assert.equal(warp.parseDuration("soon"), null);
  assert.equal(warp.formatDuration(7_260_000), "2h01m");
  assert.equal(warp.formatDuration(65_000), "1m05s");
});

function snapshot(sequence, capturedAtMs, { jobs = 0, delivered = 0, stock = 1000, fill = 10 } = {}) {
  return {
    sequence,
    baseline: false,
    capturedAtMs,
    periodSeconds: 600,
    industry: { jobsCompleted: jobs },
    freight: { jobsDelivered: delivered },
    market: { stockUnits: stock, targetFillPercent: fill, stockValue: 1, stations: [] },
  };
}

function economy(simNowMs, { jobs, delivered, units }, snapshots = []) {
  return {
    simNowMs,
    offsetMs: 0,
    status: {
      industry: { jobsCompleted: jobs, outputUnitsProduced: jobs * 10, activeJobs: 2 },
      freight: { jobsDelivered: delivered, jobsLost: 0, unitsDelivered: units },
      procurement: { openOrders: 5, spentISK: 100 },
      activeJobs: 3,
    },
    backlog: { flightsOverdueMs: 0, replacementFlightsOverdueMs: 0, deferredDuePasses: 0, eventBackpressurePasses: 0 },
    snapshots,
  };
}

test("a window is the change in the economy's own counters, and stock from the snapshots either side", () => {
  const start = economy(1_000_000, { jobs: 100, delivered: 50, units: 5_000 });
  const snapshots = [
    snapshot(7, 900_000, { stock: 1_000, fill: 10 }),
    snapshot(8, 1_500_000, { stock: 1_100, fill: 11, jobs: 3, delivered: 4 }),
    snapshot(9, 2_100_000, { stock: 1_200, fill: 12.5, jobs: 2, delivered: 1 }),
  ];
  const end = economy(8_200_000, { jobs: 112, delivered: 55, units: 5_600 }, snapshots);
  const summary = warp.buildEconomySummary({ start, end, mode: "warp", realMs: 720_000 });
  assert.equal(summary.simulatedMs, 7_200_000);
  assert.equal(summary.speed, 10);
  assert.equal(summary.industry.jobsCompleted, 12);
  assert.equal(summary.freight.jobsDelivered, 5);
  assert.equal(summary.freight.unitsDelivered, 600);
  assert.equal(summary.stock.stockUnitsStart, 1_000, "the snapshot at or before the start");
  assert.equal(summary.stock.stockUnitsEnd, 1_200);
  assert.equal(summary.stock.targetFillPercentEnd, 12.5);
  assert.deepEqual(summary.snapshots.map((row) => row.sequence), [8, 9]);

  const markdown = warp.renderEconomyMarkdown(summary, { runID: "probe", world: "saved econ" });
  assert.match(markdown, /NPC industry jobs completed \| 12 \|/);
  assert.match(markdown, /Freight deliveries \| 5 \|/);
  assert.match(markdown, /price history is left out/);
});

test("two runs agree within tolerance, and a counted divergence fails", () => {
  const base = (jobs, delivered, stock, fill) => ({
    industry: { jobsCompleted: jobs },
    freight: { jobsDelivered: delivered, unitsDelivered: delivered * 100 },
    stock: { stockUnitsEnd: stock, targetFillPercentEnd: fill },
  });
  const reference = base(40, 30, 1_000_000, 12);
  assert.equal(warp.compareSummaries(reference, base(44, 27, 1_010_000, 13)).ok, true);
  assert.equal(warp.compareSummaries(reference, base(3, 2, 1_000_000, 12)).ok, false, "jobs far off");
  assert.equal(warp.compareSummaries(reference, base(40, 30, 1_000_000, 16)).ok, false, "fill 4 points off");
  // Small counts: the absolute floor keeps 2 against 5 from failing on noise.
  assert.equal(warp.compareSummaries(base(2, 1, 100, 1), base(5, 4, 100, 1)).ok, true);
});

function scratchWorld() {
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-warp-"));
  const file = path.join(dir, "gamestore.sqlite");
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE "npcRuntimeState" (key TEXT PRIMARY KEY, json TEXT NOT NULL)');
  db.close();
  return { dir, file };
}

test("a restored world is marked as an e2e world and told where to resume", (t) => {
  const { dir, file } = scratchWorld();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(worlds.readSimClock(file), null);
  const marked = worlds.markE2eWorld(file, "econ", { resumeAtSimMs: 123_456 });
  assert.equal(marked.e2eWorld, true);
  assert.equal(marked.offsetMs, 0);
  const row = worlds.readSimClock(file);
  assert.equal(row.savedWorld, "econ");
  assert.equal(row.resumeAtSimMs, 123_456);
});

test("marking keeps an offset the world already has, and a world's time includes it", (t) => {
  const { dir, file } = scratchWorld();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO "npcRuntimeState" (key, json) VALUES (?, ?)')
    .run("livingSimClock", JSON.stringify({ e2eWorld: true, offsetMs: 3_600_000 }));
  db.close();
  const before = worlds.worldSimNowMs(file);
  const mtime = fs.statSync(file).mtimeMs;
  assert.ok(Math.abs(before - (mtime + 3_600_000)) < 2, "last write plus the offset");
  const marked = worlds.markE2eWorld(file, "again");
  assert.equal(marked.offsetMs, 3_600_000);
  assert.equal(marked.resumeAtSimMs, null);
  // up --world --real-clock: grid checks need scene and Living Universe time to agree.
  const real = worlds.markE2eWorld(file, "grid", { resumeAtSimMs: 123_456, realClock: true });
  assert.equal(real.offsetMs, 0);
  assert.equal(real.resumeAtSimMs, null);
  assert.equal(worlds.readSimClock(file).offsetMs, 0);
});

test("the world hooks: a save records the clock, a restore marks the copy from it", (t) => {
  const { dir, file } = scratchWorld();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { savedSimNowMs } = worlds.worldHooks.onSave({ world: file });
  assert.ok(Math.abs(savedSimNowMs - fs.statSync(file).mtimeMs) < 2, "no offset yet: the last write");
  const note = worlds.worldHooks.onRestore({ world: file, source: file, name: "econ",
    saved: { ext: { lu: { savedSimNowMs: 42_000 } } }, options: {} });
  assert.equal(note, null);
  assert.equal(worlds.readSimClock(file).resumeAtSimMs, 42_000);
  worlds.worldHooks.onRestore({ world: file, source: file, name: "old", saved: { savedSimNowMs: 7_000 }, options: {} });
  assert.equal(worlds.readSimClock(file).resumeAtSimMs, 7_000, "a world saved before plugins kept it at the top");
  assert.match(worlds.worldHooks.onRestore({ world: file, source: file, name: "grid", saved: {}, options: { realClock: true } }),
    /clock at real time/);
  assert.equal(worlds.readSimClock(file).resumeAtSimMs, null);
});

test("a world with no Living Universe table is left unmarked", (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-warp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gamestore.sqlite");
  new DatabaseSync(file).close();
  assert.equal(worlds.markE2eWorld(file, "empty"), null);
});
