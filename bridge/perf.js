"use strict";

// Server performance, read inside the server. Guide: docs/GUIDE.md
// "Performance testing"; the pure figures are core/perf.js.
//
// Tick figures come from what the space runtime already keeps: the ring of
// its last 120 tick summaries (`_recentTickSummaries`, with tickDurationMs,
// latenessMs and actualIntervalMs per tick, in stock
// space/runtime/spaceRuntime/tick.js), and each scene's `_recentTickWorkMs`,
// `_recentFactors` (time dilation) and `dynamicEntities`. Reading them costs
// nothing the server doesn't already pay, and needs no flag. A sampler reads
// the ring once a watch sample (2 s), well inside the 12 s it holds, and
// counts what it missed if it falls further behind.
//
// The per-subsystem breakdown needs the tree's tick profiler
// (space/tickProfiler.js), which runs only with EVEJS_TICK_PROFILE=1 and
// logs one [TickProfile] info line every EVEJS_TICK_PROFILE_EVERY ticks
// (default 100). With the variable set the monitor wraps the logger's info to
// keep each block, parsed, in a ring of the last 720; the line is still
// logged. Without it nothing is wrapped. `gridcheck up --profile` sets both.
//
// A sampler also runs a perf_hooks event-loop delay histogram while it is
// open (20 ms resolution), so a watch without perf, or no watch, costs nothing.

const { monitorEventLoopDelay } = require("node:perf_hooks");

const { isTickProfile, mergeProfiles, parseTickProfile, round, summarizeTicks, DEFAULT_BUDGET_MS } = require("../core/perf");

const PROFILE_RING = 720;
const BUSIEST = 3;
const LIMITS = Object.freeze({ maxSampleSeconds: 600, maxConcurrent: 4, sampleEveryMs: 1000 });

function profilerSettings(env = process.env) {
  const everyTicks = Math.max(1, Math.trunc(Number(env.EVEJS_TICK_PROFILE_EVERY) || 0) || 100);
  return { enabled: String(env.EVEJS_TICK_PROFILE || "") === "1", everyTicks };
}

// The histogram records the whole interval between its timer's runs, so an
// idle process reads as the resolution itself; the delay is what's past it.
// Windows rounds timers up to its clock tick (15.6 ms by default), which
// leaves an idle floor of about 11 ms here.
const LOOP_RESOLUTION_MS = 20;

function defaultLoopDelay() {
  const histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  histogram.enable();
  const value = (ns) => (Number.isFinite(ns) && ns > 0 && ns < 9e18 ? round(Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS)) : null);
  return {
    read() {
      if (!histogram.count) return { p50: null, p99: null, max: null };
      return { p50: value(histogram.percentile(50)), p99: value(histogram.percentile(99)), max: value(histogram.max) };
    },
    reset: () => histogram.reset(),
    close: () => histogram.disable(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// () -> the object that keeps the tick ring. Stock EveJS 0.12.9 builds its
// runtime once and exports a copy of it (space/runtime.js:
// Object.assign(runtimeExports, runtimeSingleton)), but the tick timer, set in
// the constructor, runs on the original, so the ring is on an object nothing
// exports. The two share a prototype, which holds tick(): a one-shot wrapper
// there names the object the first tick runs on, then puts the method back,
// so it costs one call. A tree whose exported runtime ticks itself (the LU
// fork starts ticking on the exports) is named the same way.
function findTicker(exported) {
  let ticker = null;
  let probing = false;
  return () => {
    if (ticker) return ticker;
    const runtime = exported();
    if (!runtime || typeof runtime !== "object") return null;
    if (Array.isArray(runtime._recentTickSummaries)) {
      ticker = runtime;
      return ticker;
    }
    const proto = Object.getPrototypeOf(runtime);
    if (!probing && proto && Object.prototype.hasOwnProperty.call(proto, "tick") && typeof proto.tick === "function") {
      probing = true;
      const original = proto.tick;
      const probe = function tick(...args) {
        try {
          return original.apply(this, args);
        } finally {
          if (this && typeof this === "object" && Array.isArray(this._recentTickSummaries)) {
            ticker = this;
            if (proto.tick === probe) proto.tick = original;
          }
        }
      };
      try {
        proto.tick = probe;
      } catch (_error) {
        // A frozen prototype: tick figures stay empty, nothing else changes.
      }
    }
    return runtime;
  };
}

// space: () -> the space runtime (loaded on first use). logger: the tree's
// logger module, whose info the monitor wraps when the profiler is on.
// describeSystem: (systemID) -> { name } or null. The rest are for tests.
function createPerfMonitor({
  space,
  logger = null,
  describeSystem = () => null,
  env = process.env,
  now = Date.now,
  perfNow = () => performance.now(),
  memoryUsage = () => process.memoryUsage(),
  cpuUsage = (previous) => process.cpuUsage(previous),
  loopDelay = defaultLoopDelay,
  wait = sleep,
} = {}) {
  const profiler = profilerSettings(env);
  const exported = () => {
    try {
      return typeof space === "function" ? space() : space;
    } catch (_error) {
      return null;
    }
  };
  const runtime = findTicker(exported);
  runtime();

  // ---------- the profiler's windows ----------

  const profiles = [];
  let profileID = 0;
  let unwrap = () => {};
  if (profiler.enabled && logger && typeof logger.info === "function") {
    const original = logger.info;
    const wrapped = function info(...args) {
      if (isTickProfile(args[0])) {
        try {
          const parsed = parseTickProfile(args[0]);
          if (parsed) {
            profileID += 1;
            profiles.push({ id: profileID, atMs: now(), ...parsed });
            if (profiles.length > PROFILE_RING) profiles.shift();
          }
        } catch (_error) {
          // A line we can't read is still logged.
        }
      }
      return original.apply(this, args);
    };
    logger.info = wrapped;
    unwrap = () => {
      if (logger.info === wrapped) logger.info = original;
    };
  }

  function profilesSince(id) {
    return profiles.filter((entry) => entry.id > id);
  }

  // ---------- the runtime ----------

  function budgetMs() {
    const target = Number(runtime() && runtime()._tickIntervalMs);
    return target > 0 ? target : DEFAULT_BUDGET_MS;
  }

  function ring() {
    const list = runtime() && runtime()._recentTickSummaries;
    return Array.isArray(list) ? list : [];
  }

  // The scenes that ticked: their count, entities, time dilation and the
  // busiest few, each over its last `ticks` ticks.
  function world(ticks = 50) {
    const scenes = runtime() && runtime().scenes;
    const rows = [];
    let entities = 0;
    let tidiMin = null;
    if (scenes && typeof scenes.values === "function") {
      for (const scene of scenes.values()) {
        const work = Array.isArray(scene._recentTickWorkMs) ? scene._recentTickWorkMs.slice(-Math.max(1, ticks)) : [];
        if (!work.length) continue;
        const count = scene.dynamicEntities instanceof Map ? scene.dynamicEntities.size : 0;
        entities += count;
        const factors = Array.isArray(scene._recentFactors) ? scene._recentFactors.slice(-Math.max(1, ticks)).filter(Number.isFinite) : [];
        if (factors.length) tidiMin = Math.min(tidiMin === null ? 1 : tidiMin, ...factors);
        const systemID = Number(scene.systemID) || null;
        let systemName = null;
        try {
          const described = systemID ? describeSystem(systemID) : null;
          systemName = described && described.name ? described.name : null;
        } catch (_error) {
          systemName = null;
        }
        rows.push({
          systemID,
          systemName,
          workAvgMs: round(work.reduce((sum, value) => sum + value, 0) / work.length),
          workMaxMs: round(Math.max(...work)),
          entities: count,
          sessions: scene.sessions instanceof Map ? scene.sessions.size : 0,
        });
      }
    }
    rows.sort((left, right) => right.workAvgMs - left.workAvgMs);
    const last = ring()[ring().length - 1];
    return {
      scenes: last && Number.isFinite(last.tickedSceneCount) ? last.tickedSceneCount : rows.length,
      entities,
      tidiMin: tidiMin === null ? null : round(tidiMin, 3),
      busiest: rows.slice(0, BUSIEST),
    };
  }

  function memory() {
    try {
      const usage = memoryUsage();
      return { rssMB: round(usage.rss / 1048576, 1), heapMB: round(usage.heapUsed / 1048576, 1) };
    } catch (_error) {
      return { rssMB: null, heapMB: null };
    }
  }

  // A tick summary as a tick: wall time from the runtime's performance.now() stamp.
  function tickOf(summary, wallNow, monoNow) {
    const started = Number(summary.startedAtMonotonicMs);
    return {
      mono: started,
      atMs: Math.round(wallNow - (monoNow - started)),
      ms: Number(summary.tickDurationMs) || 0,
      lateMs: Number.isFinite(Number(summary.latenessMs)) ? Number(summary.latenessMs) : null,
    };
  }

  function buildWindow(ticks, { atMs, windowMs, missedTicks = 0, cpuPct = null, loop = null, budget = budgetMs() }) {
    const series = { at: ticks.map((tick) => tick.atMs - atMs), ms: ticks.map((tick) => round(tick.ms)) };
    return {
      windowMs: Math.round(windowMs),
      ...summarizeTicks(ticks, { budgetMs: budget }),
      missedTicks,
      loopP50Ms: loop ? loop.p50 : null,
      loopP99Ms: loop ? loop.p99 : null,
      loopMaxMs: loop ? loop.max : null,
      cpuPct: cpuPct === null ? null : round(cpuPct, 1),
      ...memory(),
      ...world(ticks.length || 50),
      series,
    };
  }

  // One sampler per watch or POST /perf: its own cursor into the ring, CPU
  // baseline and loop histogram. take() reads the ticks since the last call;
  // window() closes a window and starts the next.
  function createSampler() {
    const startRing = ring();
    let lastMono = startRing.length ? Number(startRing[startRing.length - 1].startedAtMonotonicMs) : -Infinity;
    let pending = [];
    let missed = 0;
    let cpuMark = cpuUsage();
    let markedAt = perfNow();
    let profileMark = profileID;
    const delay = loopDelay();

    function take() {
      const list = ring();
      if (!list.length) return 0;
      const monoNow = perfNow();
      const wallNow = now();
      const fresh = list.filter((summary) => Number(summary.startedAtMonotonicMs) > lastMono);
      // The ring was full and starts after our cursor: ticks fell out unread.
      if (Number.isFinite(lastMono) && fresh.length === list.length && list.length >= 120) {
        const gapMs = Number(list[0].startedAtMonotonicMs) - lastMono;
        missed += Math.max(0, Math.round(gapMs / budgetMs()) - 1);
      }
      for (const summary of fresh) pending.push(tickOf(summary, wallNow, monoNow));
      if (fresh.length) lastMono = Number(fresh[fresh.length - 1].startedAtMonotonicMs);
      return fresh.length;
    }

    function closeWindow() {
      take();
      const monoNow = perfNow();
      const elapsedMs = Math.max(1, monoNow - markedAt);
      const cpu = cpuUsage(cpuMark);
      const cpuPct = ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100;
      const event = buildWindow(pending, { atMs: now(), windowMs: elapsedMs, missedTicks: missed, cpuPct, loop: delay.read() });
      pending = [];
      missed = 0;
      cpuMark = cpuUsage();
      markedAt = monoNow;
      delay.reset();
      return event;
    }

    // The profiler windows that ended since the last call.
    function newProfiles() {
      const fresh = profilesSince(profileMark);
      if (fresh.length) profileMark = fresh[fresh.length - 1].id;
      return fresh;
    }

    return { take, window: closeWindow, profiles: newProfiles, close: () => delay.close() };
  }

  // GET /perf: the ticks the ring holds now. No CPU or loop delay, which need
  // a window to measure over.
  function snapshot() {
    const list = ring();
    const monoNow = perfNow();
    const wallNow = now();
    const ticks = list.map((summary) => tickOf(summary, wallNow, monoNow));
    const span = ticks.length ? monoNow - ticks[0].mono : 0;
    const last = profiles[profiles.length - 1] || null;
    return {
      profiler,
      perf: buildWindow(ticks, { atMs: wallNow, windowMs: span }),
      profile: last ? { windows: 1, ticks: last.ticks, totalMsPerTick: last.totalMsPerTick, sections: last.sections, atMs: last.atMs } : null,
    };
  }

  let sampling = 0;

  // POST /perf: sample for `seconds`, then answer the window and the profiler
  // windows that ended inside it, merged.
  async function sample(seconds) {
    if (sampling >= LIMITS.maxConcurrent) return { busy: true };
    sampling += 1;
    const sampler = createSampler();
    try {
      const endAt = perfNow() + seconds * 1000;
      while (perfNow() < endAt) {
        await wait(Math.min(LIMITS.sampleEveryMs, Math.max(0, endAt - perfNow())));
        sampler.take();
      }
      const perf = sampler.window();
      const windows = sampler.profiles();
      return { profiler, seconds, perf, profile: windows.length ? mergeProfiles(windows) : null };
    } finally {
      sampler.close();
      sampling -= 1;
    }
  }

  return {
    profiler,
    createSampler,
    snapshot,
    sample,
    stop: () => unwrap(),
  };
}

module.exports = {
  LIMITS,
  createPerfMonitor,
  profilerSettings,
};
