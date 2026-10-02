"use strict";

// Server performance: the tick profiler's text (both formats, as each tree's
// own space/tickProfiler.js logged them), the bridge's tick sampler over a
// fake runtime ring, PERF and PROFILE on a watch, the /perf routes, the
// conditions and scenario keys, the phases a run's report splits at its
// steps, and the CLI and MCP arguments. The live path is docs/GUIDE.md
// "Performance testing".

const test = require("node:test");
const assert = require("node:assert");

const perfTools = require("../core/perf");
const { createPerfMonitor, profilerSettings } = require("../bridge/perf");
const { createGridWatch } = require("../bridge/watch");
const { createAgentBridgeRoutes } = require("../bridge/routes");
const { parseCondition } = require("../core/conditions");
const { createToolRegistry } = require("../core/plugins");
const { validateScenario, renderReport, resultRecord } = require("../core/scenario");
const { formatTimelineEvent } = require("../core/timeline");

// Captured from stock EveJS 0.12.9's space/tickProfiler.js and from the LU
// fork's, each run for two ticks with npc, npc.think and drone sections.
const STOCK_BLOCK = "[TickProfile] last 2 ticks — 2.301 ms/tick total scene work (sum across loaded scenes):\n" +
  "  npc                         1.530 ms/tick  66.5%  (1 calls / 2 ticks)\n" +
  "  npc.think                   0.509 ms/tick  22.1%  (1 calls / 2 ticks)\n" +
  "  drone                       0.255 ms/tick  11.1%  (1 calls / 2 ticks)\n" +
  "  other(movement/destiny)     0.008 ms/tick   0.3%  (2 ticks)";
const MARKED_BLOCK = "[TickProfile] last 2 ticks — 2.973 ms/tick total tick work (sum across loaded scenes):\n" +
  "  ↳ (memo) scene work total                       2.352 ms/tick  79.1%  (2 ticks)\n" +
  "    npc                                           1.568 ms/tick  52.7%  (1 calls / 2 ticks 3.135 ms/call)\n" +
  "    other(uninstrumented)                         1.150 ms/tick  38.7%  (2 ticks)\n" +
  "  ↳ npc.think                                     0.515 ms/tick  17.3%  (1 calls / 2 ticks 1.031 ms/call)\n" +
  "    drone                                         0.255 ms/tick   8.6%  (1 calls / 2 ticks 0.510 ms/call)\n" +
  "    tidiAutoscaler (after tick)                   0.103 ms/tick     --  (1 calls / 2 ticks 0.206 ms/call)";

const EMPTY_REGISTRY = createToolRegistry({ active: [], skipped: [] });
const STUBS = { worldExists: () => true, recipeExists: () => true, registry: EMPTY_REGISTRY, defaultName: "t" };

test("both tick profiler formats parse, with nesting and after-tick rows", () => {
  const stock = perfTools.parseTickProfile(STOCK_BLOCK);
  assert.strictEqual(stock.ticks, 2);
  assert.strictEqual(stock.totalMsPerTick, 2.301);
  assert.strictEqual(stock.totalLabel, "total scene work");
  assert.deepStrictEqual(stock.sections.map((row) => [row.label, row.msPerTick, row.nested]),
    [["npc", 1.53, false], ["npc.think", 0.509, true], ["drone", 0.255, false], ["other(movement/destiny)", 0.008, false]],
    "stock marks no nesting; npc.think is inside npc by its label");
  assert.strictEqual(stock.sections[0].msPerCall, 3.06, "worked out from the window when the line has no ms/call");

  const marked = perfTools.parseTickProfile(MARKED_BLOCK);
  assert.strictEqual(marked.totalLabel, "total tick work");
  const byLabel = Object.fromEntries(marked.sections.map((row) => [row.label, row]));
  assert.strictEqual(byLabel["(memo) scene work total"].nested, true);
  assert.strictEqual(byLabel["npc.think"].nested, true);
  assert.strictEqual(byLabel.npc.msPerCall, 3.135);
  assert.deepStrictEqual([byLabel.tidiAutoscaler.afterTick, byLabel.tidiAutoscaler.pct], [true, null]);
  assert.strictEqual(perfTools.topSection(marked).label, "npc", "the costliest addend, the remainder left out");

  assert.strictEqual(perfTools.parseTickProfile("[AgentBridge] something else"), null);
  assert.strictEqual(perfTools.parseTickProfile("[TickProfile] a line in another shape"), null);
});

test("profile windows merge weighted by their ticks", () => {
  const one = { ticks: 10, totalMsPerTick: 4, sections: [{ label: "npc", msPerTick: 2, calls: 10, nested: false, afterTick: false }] };
  const two = { ticks: 30, totalMsPerTick: 8, sections: [{ label: "npc", msPerTick: 6, calls: 30, nested: false, afterTick: false },
    { label: "drone", msPerTick: 1, calls: 30, nested: false, afterTick: false }] };
  const merged = perfTools.mergeProfiles([one, two]);
  assert.strictEqual(merged.ticks, 40);
  assert.strictEqual(merged.totalMsPerTick, 7);
  assert.deepStrictEqual(merged.sections.map((row) => [row.label, row.msPerTick, row.calls]), [["npc", 5, 40], ["drone", 0.75, 30]]);
  assert.strictEqual(perfTools.mergeProfiles([]), null);
});

test("tick figures: nearest-rank percentiles, max and ticks over budget", () => {
  const ticks = Array.from({ length: 100 }, (_, index) => ({ ms: index + 1, lateMs: index % 10 }));
  const summary = perfTools.summarizeTicks(ticks, { budgetMs: 90 });
  assert.deepStrictEqual([summary.ticks, summary.tickP50Ms, summary.tickP95Ms, summary.tickP99Ms, summary.tickMaxMs, summary.overBudget],
    [100, 50, 95, 99, 100, 10]);
  assert.strictEqual(summary.tickAvgMs, 50.5);
  assert.strictEqual(summary.lateMaxMs, 9);
  assert.strictEqual(perfTools.summarizeTicks([]).tickP99Ms, null);
});

// A runtime with stock's ring: one summary a tick, newest last, at most 120.
function fakeRuntime() {
  const runtime = { _tickIntervalMs: 100, _recentTickSummaries: [], scenes: new Map() };
  const scene = { systemID: 30002537, _recentTickWorkMs: [], _recentFactors: [], dynamicEntities: new Map([[1, {}], [2, {}]]),
    sessions: new Map([[7, {}]]) };
  runtime.scenes.set(30002537, scene);
  let mono = 1000;
  runtime.tick = (durationMs, lateMs = 0) => {
    mono += 100 + lateMs;
    runtime._recentTickSummaries.push({ startedAtMonotonicMs: mono, tickDurationMs: durationMs, latenessMs: lateMs,
      actualIntervalMs: 100 + lateMs, tickedSceneCount: 1 });
    if (runtime._recentTickSummaries.length > 120) runtime._recentTickSummaries.shift();
    scene._recentTickWorkMs.push(durationMs * 0.8);
    scene._recentFactors.push(1);
    return mono;
  };
  runtime.mono = () => mono;
  return runtime;
}

function fakeLoop() {
  const state = { closed: 0, resets: 0 };
  return { state, make: () => ({ read: () => ({ p50: 1, p99: 4, max: 9 }), reset: () => { state.resets += 1; }, close: () => { state.closed += 1; } }) };
}

function monitorFor(runtime, overrides = {}) {
  const loop = fakeLoop();
  const monitor = createPerfMonitor({
    space: () => runtime,
    describeSystem: (id) => (id === 30002537 ? { name: "Amamake" } : null),
    env: {},
    now: () => 50_000 + runtime.mono(),
    perfNow: () => runtime.mono(),
    memoryUsage: () => ({ rss: 600 * 1048576, heapUsed: 300 * 1048576 }),
    cpuUsage: () => ({ user: 25_000, system: 25_000 }),
    loopDelay: loop.make,
    ...overrides,
  });
  return { monitor, loop };
}

test("a sampler reads each tick once, in windows, and counts what fell out of the ring", () => {
  const runtime = fakeRuntime();
  for (let i = 0; i < 5; i += 1) runtime.tick(2);
  const { monitor, loop } = monitorFor(runtime);
  const sampler = monitor.createSampler();
  for (let i = 0; i < 10; i += 1) runtime.tick(i === 9 ? 150 : 4);
  sampler.take();
  sampler.take();
  const window = sampler.window();
  assert.strictEqual(window.ticks, 10, "only the ticks after the sampler opened, each once");
  assert.deepStrictEqual([window.tickMaxMs, window.overBudget, window.budgetMs], [150, 1, 100]);
  assert.strictEqual(window.series.ms.length, 10);
  assert.ok(window.series.at.every((at) => at <= 0), "each tick's time is before the window's end");
  assert.strictEqual(window.series.at[9], 0, "the newest tick started as the window closed here");
  assert.deepStrictEqual([window.loopP99Ms, window.heapMB, window.rssMB, window.entities, window.scenes], [4, 300, 600, 2, 1]);
  assert.strictEqual(window.busiest[0].systemName, "Amamake");
  assert.strictEqual(loop.state.resets, 1, "each window starts a fresh loop histogram");

  for (let i = 0; i < 200; i += 1) runtime.tick(3);
  const next = sampler.window();
  assert.strictEqual(next.ticks, 120, "the ring holds 120");
  assert.strictEqual(next.missedTicks, 80, "and the 80 before them are counted, not invented");
  sampler.close();
  assert.strictEqual(loop.state.closed, 1);
});

test("stock's exported runtime is a copy: the first tick names the object that keeps the ring, then the probe goes", () => {
  // As stock space/runtime.js: tick() on the prototype, the timer on the
  // original, and a copy of its fields as the module's exports.
  class Runtime {
    constructor() {
      this.scenes = new Map();
      this._tickIntervalMs = 100;
    }
  }
  let mono = 0;
  Object.defineProperty(Runtime.prototype, "tick", {
    writable: true, configurable: true, enumerable: false,
    value() {
      mono += 100;
      if (!Array.isArray(this._recentTickSummaries)) this._recentTickSummaries = [];
      this._recentTickSummaries.push({ startedAtMonotonicMs: mono, tickDurationMs: 7, latenessMs: 0 });
    },
  });
  const original = Runtime.prototype.tick;
  const singleton = new Runtime();
  const exportsCopy = Object.setPrototypeOf(Object.assign({}, singleton), Runtime.prototype);
  const monitor = createPerfMonitor({ space: () => exportsCopy, env: {}, perfNow: () => mono, loopDelay: fakeLoop().make });
  assert.notStrictEqual(Runtime.prototype.tick, original, "a probe waits for the first tick");
  singleton.tick();
  assert.strictEqual(Runtime.prototype.tick, original, "and takes itself off after it");
  singleton.tick();
  assert.strictEqual(monitor.snapshot().perf.ticks, 2, "the ring is read from the object that ticks");
  assert.strictEqual(exportsCopy._recentTickSummaries, undefined);
});

test("with EVEJS_TICK_PROFILE=1 the logger's info is wrapped; each block is kept and still logged", () => {
  const logged = [];
  const logger = { info: (text) => logged.push(text) };
  const runtime = fakeRuntime();
  const off = createPerfMonitor({ space: () => runtime, logger, env: {} });
  assert.strictEqual(off.profiler.enabled, false);
  assert.strictEqual(logger.info.name, "info", "nothing is wrapped without the variable");

  const original = logger.info;
  const { monitor } = monitorFor(runtime, { logger, env: { EVEJS_TICK_PROFILE: "1", EVEJS_TICK_PROFILE_EVERY: "50" } });
  assert.deepStrictEqual(monitor.profiler, { enabled: true, everyTicks: 50 });
  assert.notStrictEqual(logger.info, original);
  const sampler = monitor.createSampler();
  logger.info(STOCK_BLOCK);
  logger.info("[SpaceRuntime] an ordinary line");
  assert.deepStrictEqual(logged, [STOCK_BLOCK, "[SpaceRuntime] an ordinary line"], "every line still reaches the log");
  const windows = sampler.profiles();
  assert.strictEqual(windows.length, 1);
  assert.strictEqual(windows[0].sections[0].label, "npc");
  assert.deepStrictEqual(sampler.profiles(), [], "a window is handed out once per sampler");
  assert.strictEqual(monitor.snapshot().profile.totalMsPerTick, 2.301);
  monitor.stop();
  assert.strictEqual(logger.info, original, "stop puts the logger back");
  assert.deepStrictEqual(profilerSettings({ EVEJS_TICK_PROFILE: "1" }), { enabled: true, everyTicks: 100 }, "the profiler's own default");
});

test("POST /perf samples for its seconds; GET /perf reads the ring at once", async () => {
  const runtime = fakeRuntime();
  for (let i = 0; i < 30; i += 1) runtime.tick(5);
  const { monitor } = monitorFor(runtime, { wait: async () => { for (let i = 0; i < 10; i += 1) runtime.tick(6); } });
  const routes = createAgentBridgeRoutes({ findSession: () => null, perf: monitor });
  const now = routes.handle("GET", "/perf", {}, {});
  assert.strictEqual(now.statusCode, 200);
  assert.strictEqual(now.body.perf.ticks, 30);
  assert.strictEqual(now.body.perf.cpuPct, null, "a snapshot has no window to measure CPU over");
  assert.strictEqual(routes.handle("POST", "/perf", {}, { seconds: 0 }).statusCode, 400);
  assert.strictEqual(routes.handle("POST", "/perf", {}, { seconds: 601 }).statusCode, 400);
  const sampled = await routes.handle("POST", "/perf", {}, { seconds: 2 });
  assert.strictEqual(sampled.statusCode, 200);
  assert.strictEqual(sampled.body.seconds, 2);
  assert.strictEqual(sampled.body.perf.ticks, 20, "two sample rounds of ten new ticks");
  assert.strictEqual(sampled.body.perf.tickAvgMs, 6);
  assert.strictEqual(sampled.body.profile, null);
  assert.strictEqual(createAgentBridgeRoutes({ findSession: () => null }).handle("GET", "/perf", {}, {}).statusCode, 503);
});

test("/watch takes perfEverySeconds and refuses it with no monitor", () => {
  const calls = [];
  const watcher = { busy: () => false, run: (params) => { calls.push(params); } };
  const without = createAgentBridgeRoutes({ findSession: () => ({ characterID: 7 }), watcher });
  assert.strictEqual(without.handle("POST", "/watch", {}, { characterID: 7, perfEverySeconds: 5 }).statusCode, 503);
  const routes = createAgentBridgeRoutes({ findSession: () => ({ characterID: 7 }), watcher, perf: { createSampler() {} } });
  assert.strictEqual(routes.handle("POST", "/watch", {}, { characterID: 7, perfEverySeconds: 0.5 }).statusCode, 400);
  routes.handle("POST", "/watch", {}, { characterID: 7, perfEverySeconds: 5 }).stream({ write() {}, closed: () => false });
  assert.strictEqual(calls[0].perfEveryMs, 5000);
});

test("a watch with perf streams PERF windows and PROFILE blocks, and closes its sampler", async () => {
  const runtime = fakeRuntime();
  let clock = 0;
  let index = 0;
  let alive = true;
  const logger = { info() {} };
  const loop = fakeLoop();
  const monitor = createPerfMonitor({ space: () => runtime, logger, env: { EVEJS_TICK_PROFILE: "1" }, now: () => clock,
    perfNow: () => runtime.mono(), memoryUsage: () => ({ rss: 1, heapUsed: 1 }), cpuUsage: () => ({ user: 0, system: 0 }),
    loopDelay: loop.make });
  const watch = createGridWatch({
    findSession: () => (alive ? { characterID: 7 } : null),
    readGrid: () => ({ inSpace: false, solarSystemID: 30002537, entities: [] }),
    perf: monitor,
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => {
      for (let i = 0; i < ms / 100; i += 1) runtime.tick(3);
      if (index === 1) logger.info(STOCK_BLOCK);
      clock += ms;
      index += 1;
      if (index >= 4) alive = false;
    },
  });
  const lines = [];
  await watch.run({ characterID: 7, forMs: 60_000, everyMs: 2000, offGridEveryMs: 5000, perfEveryMs: 4000 },
    { write: (event) => lines.push(event), closed: () => false });
  const kinds = lines.map((event) => event.kind);
  assert.deepStrictEqual(lines[0].perf, { everyMs: 4000, profiler: true, everyTicks: 100 });
  assert.ok(kinds.includes("PROFILE"), kinds.join(" "));
  const perfLines = lines.filter((event) => event.kind === "PERF");
  assert.strictEqual(perfLines.reduce((sum, event) => sum + event.ticks, 0), 80, "every tick of the watch, in its windows");
  assert.strictEqual(kinds[kinds.length - 1], "END");
  assert.strictEqual(kinds[kinds.length - 2], "PERF", "the last window closes before END");
  assert.strictEqual(loop.state.closed, 1);

  const plain = [];
  await createGridWatch({ findSession: () => null, readGrid: () => ({}), perf: monitor }).run({ characterID: 7, forMs: 1000,
    everyMs: 1000, offGridEveryMs: 1000 }, { write: (event) => plain.push(event), closed: () => false });
  assert.strictEqual(plain[0].perf, undefined, "no perf unless the watch asks");
});

const PERF_EVENT = { kind: "PERF", t: 5000, atMs: 105_000, ticks: 50, budgetMs: 100, tickAvgMs: 4, tickP95Ms: 9, tickP99Ms: 30,
  tickMaxMs: 140, overBudget: 1, loopP99Ms: 12, cpuPct: 40, heapMB: 512, entities: 25,
  busiest: [{ systemID: 30002537, systemName: "Amamake", workAvgMs: 3.5, workMaxMs: 20, entities: 25, sessions: 1 }] };

test("PERF and PROFILE conditions read their fields, with units", () => {
  const registry = EMPTY_REGISTRY;
  assert.strictEqual(parseCondition("PERF tickP99Ms>=25", { registry }).test(PERF_EVENT), true);
  assert.strictEqual(parseCondition("PERF tickP99Ms>=0.1s", { registry }).test(PERF_EVENT), false);
  assert.strictEqual(parseCondition("PERF overBudget>0 busiest.systemName=Amamake", { registry }).test(PERF_EVENT), true);
  const profile = { kind: "PROFILE", ...perfTools.parseTickProfile(STOCK_BLOCK) };
  assert.strictEqual(parseCondition("PROFILE sections.label=npc", { registry }).test(profile), true);
  assert.strictEqual(parseCondition("PROFILE totalMsPerTick>2", { registry }).test(profile), true);
  assert.throws(() => parseCondition("PERF p99>1", { registry }), /PERF has no field "p99". Fields: windowMs, ticks/);
});

test("a scenario's perf: up.profile turns PERF on; PERF and PROFILE conditions need what makes them", () => {
  const base = { world: "fresh", setup: ["undock"], until: { timeout: 30 } };
  const profiled = validateScenario({ ...base, up: { profile: true, profileEvery: 20 },
    expect: ["no PERF tickP99Ms>=100", "PROFILE"] }, STUBS);
  assert.deepStrictEqual([profiled.up.profile, profiled.up.profileEvery, profiled.watch.perf], [true, 20, 5]);
  assert.strictEqual(validateScenario({ ...base, watch: { perf: 10 }, expect: ["PERF"] }, STUBS).watch.perf, 10);
  assert.strictEqual(validateScenario({ ...base, expect: ["GRID"] }, STUBS).watch.perf, 0, "off unless asked");
  const problems = (raw) => {
    try {
      validateScenario(raw, STUBS);
      return "";
    } catch (error) {
      return error.problems.join("\n");
    }
  };
  assert.match(problems({ ...base, expect: ["PERF"] }), /PERF needs "watch": \{ "perf": true \}/);
  assert.match(problems({ ...base, watch: { perf: true }, expect: ["PROFILE"] }), /PROFILE needs the tick profiler/);
  assert.match(problems({ ...base, up: { profileEvery: 20 }, expect: ["GRID"] }), /up.profileEvery: the tick profiler's window; add "profile": true/);
  assert.match(problems({ ...base, up: { profile: "yes" }, expect: ["GRID"] }), /up.profile: true or false/);
  assert.match(problems({ ...base, watch: { perf: 0.5 }, expect: ["GRID"] }), /watch.perf: true/);
});

// A run's timeline: a baseline, a spawn step, then load, with the ticks in
// each PERF window spread across it.
function perfTimeline() {
  const start = 100_000;
  const window = (endAt, ms) => ({ ...PERF_EVENT, atMs: endAt, t: endAt - start, ticks: 50, tickMaxMs: Math.max(...ms),
    series: { at: ms.map((_, i) => -((ms.length - 1 - i) * 100) - 50), ms } });
  return [
    { kind: "START", seq: 1, t: 0, atMs: start, perf: { everyMs: 5000, profiler: true, everyTicks: 50 } },
    window(start + 5000, Array(50).fill(2)),
    { kind: "STEP", source: "runner", atMs: start + 5000, t: 5000, index: 2, step: "slash /npctest2 20", ok: true },
    window(start + 10_000, Array(50).fill(8)),
    { kind: "PROFILE", atMs: start + 10_000, t: 10_000, ...perfTools.parseTickProfile(STOCK_BLOCK) },
    window(start + 15_000, [...Array(49).fill(9), 140]),
    { kind: "STOP", source: "runner", atMs: start + 15_000, t: 15_000, reason: "timeout" },
  ];
}

test("a run's ticks split at its steps: the baseline before the spawn, the load after it", () => {
  const record = perfTools.perfRecord(perfTimeline());
  assert.strictEqual(record.profiler, true);
  assert.strictEqual(record.overall.ticks, 150);
  assert.strictEqual(record.overall.overBudget, 1);
  assert.deepStrictEqual(record.phases.map((phase) => [phase.label, phase.ticks, phase.tickAvgMs, phase.tickMaxMs]),
    [["watch start", 50, 2, 2], ["after slash /npctest2 20", 100, 9.81, 140]]);
  assert.strictEqual(record.profile.windows, 1);
  assert.strictEqual(perfTools.perfRecord([{ kind: "GRID" }]), null);
});

test("the report gets a Server performance section, and result.json the same figures", () => {
  const events = perfTimeline();
  const result = { name: "perf-npc-load", world: "starter", startedAtMs: 99_000, stoppedAtMs: 116_000, watchStartedAtMs: 100_000,
    stop: { reason: "timeout", waitedMs: 10_000 }, failure: null, down: { ok: true }, steps: [], bindings: {}, until: [],
    expectations: [], missing: 0, eventCount: events.length, events, passed: true };
  const report = renderReport(result, { runID: "r1", registry: EMPTY_REGISTRY });
  assert.match(report, /## Server performance/);
  assert.match(report, /\| after slash \/npctest2 20 \| t\+00:00:05 \| 100 \| 9\.81 \|/);
  assert.match(report, /Tick profiler: 1 window\(s\)/);
  assert.match(report, /\| npc \| 1\.53 \| 66\.5% \| 1 \|/);
  const record = resultRecord(result, { runID: "r1", scenarioFile: "x.json" });
  assert.strictEqual(record.perf.overall.tickMaxMs, 140);
  assert.strictEqual(resultRecord({ ...result, events: [] }, { runID: "r1" }).perf, null);
});

test("PERF and PROFILE print as one timeline line each", () => {
  const perfLine = formatTimelineEvent(PERF_EVENT, EMPTY_REGISTRY);
  assert.match(perfLine, /^t\+00:00:05  PERF      tick 4\.00\/9\.00\/140 ms avg\/p95\/max over 50 ticks, 1 over 100 ms/);
  assert.match(perfLine, /loop p99 12\.0 ms, cpu 40%, heap 512 MB, 25 entities  busiest Amamake 3\.50 ms/);
  const profileLine = formatTimelineEvent({ kind: "PROFILE", t: 10_000, ...perfTools.parseTickProfile(MARKED_BLOCK) }, EMPTY_REGISTRY);
  assert.match(profileLine, /PROFILE   profile 2\.97 ms\/tick over 2 ticks/);
  assert.match(profileLine, /top npc 1\.57, drone 0\.26$/, "the remainder and nested rows aren't the top");
  const start = formatTimelineEvent({ kind: "START", t: 0, characterID: 7, forMs: 60_000, everyMs: 2000, offGridEveryMs: 5000,
    clientMode: "diverge", perf: { everyMs: 5000, profiler: false, everyTicks: 100 } }, EMPTY_REGISTRY);
  assert.match(start, /client=diverge, perf every 5s, profiler off$/);
});

test("gridcheck perf's text: ticks, process, busiest scenes, then the profiler or how to turn it on", () => {
  const reply = { profiler: { enabled: false, everyTicks: 100 }, seconds: 10, perf: { ...PERF_EVENT, scenes: 1, tidiMin: 0.8 }, profile: null };
  const text = perfTools.formatPerf(reply);
  assert.match(text, /^over 10 s: 50 ticks, budget 100 ms a tick/);
  assert.match(text, /tick {7}avg 4\.00 {2}p50 - {2}p95 9\.00 {2}p99 30\.0 {2}max 140 ms; 1 over budget/);
  assert.match(text, /time dilation down to 0\.8/);
  assert.match(text, /Amamake +3\.50 +20\.0 +25 +1/);
  assert.match(text, /tick profiler off: .*gridcheck up --profile/);
  const on = perfTools.formatPerf({ ...reply, profiler: { enabled: true, everyTicks: 50 },
    profile: perfTools.mergeProfiles([perfTools.parseTickProfile(MARKED_BLOCK)]) });
  assert.match(on, /tick profiler: 1 window\(s\), 2 ticks/);
  assert.match(on, / {4}↳ npc\.think +0\.52/);
});

test("the MCP tools map perf and profile onto the CLI", () => {
  const mcp = require("../bin/mcp.js");
  assert.ok(mcp.TOOLS.some((tool) => tool.name === "perf"));
  assert.deepStrictEqual(mcp.cliArgs("perf", {}), ["perf"]);
  assert.deepStrictEqual(mcp.cliArgs("perf", { seconds: 30, json: true }), ["perf", "--for=30", "--json"]);
  assert.deepStrictEqual(mcp.cliArgs("perf", { now: true, seconds: 30 }), ["perf", "--now"]);
  assert.ok(mcp.cliArgs("up", { profile: true, profileEvery: 20 }).includes("--profile-every=20"));
  assert.ok(!mcp.cliArgs("up", { profileEvery: 20 }).some((arg) => arg.startsWith("--profile")), "profileEvery only with profile");
  assert.deepStrictEqual(mcp.cliArgs("watch", { perf: true }).slice(1), ["--for=60", "--perf"]);
  assert.deepStrictEqual(mcp.cliArgs("watch", { perf: true, perfEvery: 10 }).slice(1), ["--for=60", "--perf-every=10"]);
  assert.match(mcp.instructions(), /`perf` \{ seconds: 30 \}/);
});
