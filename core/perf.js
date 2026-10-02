"use strict";

// Server performance, the pure half: no IO, so tests can pin it, and the
// bridge (bridge/perf.js), the CLI, the report and the GUI's model read the
// same numbers.
//
//   parseTickProfile(text)   one [TickProfile] block the tree's tick profiler
//                            logged (space/tickProfiler.js) -> its rows
//   summarizeTicks(ticks)    tick durations -> avg, percentiles, max, over budget
//   mergeProfiles(windows)   several profile windows -> one table, ms per tick
//   perfPhases(events)       a run's PERF events cut at its STEP lines
//   perfRecord(events)       what result.json keeps
//   formatPerf(...)          the text `e2e perf` prints
//
// A PERF event is one window of ticks, written by a watch with perf on (or
// answered by POST /perf). `series` holds every tick in it: `at` in ms before
// the event's atMs (zero or less) and `ms` the tick's duration. A PROFILE
// event is one profiler window: `sections` with ms per tick, share of the
// tick, calls, and whether the row is nested inside another (its time is
// already in its parent's) or ran after the tick's measured end.

//
// Node loads it as a module; the GUI's page gets it as window.E2EPerf
// (/gui/perf.js), so a run's Perf tab and its report agree.

(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.E2EPerf = api;
})(typeof self !== "undefined" ? self : this, () => {
  const DEFAULT_BUDGET_MS = 100;

  function round(value, places = 2) {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  }

  // Nearest-rank percentile of a sorted list.
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
    return sorted[rank - 1];
  }

  // ---------- the tick profiler's text ----------

  // Stock writes `  npc      2.033 ms/tick  11.5%  (500 calls / 50 ticks)`; a
  // tree may mark nested rows with ↳, add ` 0.004 ms/call`, write `--` for the
  // share of a row outside the tick, and name it `label (after tick)`.
  const PROFILE_HEAD = /^\[TickProfile\] last (\d+) ticks\s+\S+\s+(-?[\d.]+) ms\/tick\s+(.*?)\s*\(sum across loaded scenes\):?\s*$/;
  const PROFILE_ROW = /^\s*(↳)?\s*(.+?)\s+(-?[\d.]+) ms\/tick\s+(--|-?[\d.]+%)\s+\(([^)]*)\)\s*$/;
  const AFTER_TICK = / \(after tick\)$/;

  function isTickProfile(text) {
    return typeof text === "string" && text.startsWith("[TickProfile]");
  }

  // -> { ticks, totalMsPerTick, totalLabel, sections: [...] } or null.
  function parseTickProfile(text) {
    if (!isTickProfile(text)) return null;
    const lines = String(text).split(/\r?\n/);
    const head = PROFILE_HEAD.exec(lines[0]);
    if (!head) return null;
    const sections = [];
    for (const line of lines.slice(1)) {
      const row = PROFILE_ROW.exec(line);
      if (!row) continue;
      const [, mark, rawLabel, msPerTick, share, note] = row;
      const calls = /^(\d+) calls/.exec(note);
      const perCall = /([\d.]+) ms\/call/.exec(note);
      const afterTick = AFTER_TICK.test(rawLabel);
      sections.push({
        label: afterTick ? rawLabel.replace(AFTER_TICK, "") : rawLabel,
        msPerTick: Number(msPerTick),
        pct: share === "--" ? null : Number(share.slice(0, -1)),
        calls: calls ? Number(calls[1]) : 0,
        msPerCall: perCall ? Number(perCall[1]) : (calls && Number(calls[1]) > 0
          ? round((Number(msPerTick) * Number(head[1])) / Number(calls[1]), 4) : null),
        nested: mark === "↳" || rawLabel.startsWith("(memo)"),
        afterTick,
      });
    }
    // Stock marks no nesting, so apply the rule the marking trees use: a row is
    // inside another recorded row whose label is a dot-prefix of its own
    // (npc.think is inside npc; mv.entityLoop is top-level with no bare mv).
    const labels = new Set(sections.map((section) => section.label));
    for (const section of sections) {
      if (section.nested) continue;
      for (let cut = section.label.lastIndexOf("."); cut > 0; cut = section.label.lastIndexOf(".", cut - 1)) {
        if (labels.has(section.label.slice(0, cut))) {
          section.nested = true;
          break;
        }
      }
    }
    return {
      ticks: Number(head[1]),
      totalMsPerTick: Number(head[2]),
      totalLabel: head[3],
      sections,
    };
  }

  // The sections that add up to the tick: not nested, not after it, and not the
  // profiler's own remainder row.
  function isAddend(section) {
    return !section.nested && !section.afterTick;
  }

  function isRemainder(label) {
    return /^other\(/.test(String(label));
  }

  // Profile windows -> one table weighted by each window's ticks.
  function mergeProfiles(windows) {
    const list = (windows || []).filter((window) => window && Array.isArray(window.sections) && window.ticks > 0);
    const ticks = list.reduce((sum, window) => sum + window.ticks, 0);
    if (!ticks) return null;
    const rows = new Map();
    let totalMs = 0;
    for (const window of list) {
      totalMs += window.totalMsPerTick * window.ticks;
      for (const section of window.sections) {
        const key = `${section.label}\u0000${section.afterTick ? 1 : 0}`;
        let row = rows.get(key);
        if (!row) {
          row = { label: section.label, nested: section.nested, afterTick: section.afterTick, totalMs: 0, calls: 0 };
          rows.set(key, row);
        }
        row.nested = row.nested && section.nested;
        row.totalMs += section.msPerTick * window.ticks;
        row.calls += section.calls || 0;
      }
    }
    const totalMsPerTick = totalMs / ticks;
    const sections = [...rows.values()].map((row) => ({
      label: row.label,
      msPerTick: round(row.totalMs / ticks, 3),
      pct: row.afterTick || !(totalMsPerTick > 0) ? null : round((row.totalMs / ticks / totalMsPerTick) * 100, 1),
      calls: row.calls,
      msPerCall: row.calls ? round(row.totalMs / row.calls, 4) : null,
      nested: row.nested,
      afterTick: row.afterTick,
    })).sort((left, right) => right.msPerTick - left.msPerTick);
    return { windows: list.length, ticks, totalMsPerTick: round(totalMsPerTick, 3), sections };
  }

  // The section that costs most, the remainder excluded: what to look at first.
  function topSection(profile) {
    const rows = profile && Array.isArray(profile.sections) ? profile.sections : [];
    return rows.find((row) => isAddend(row) && !isRemainder(row.label)) || null;
  }

  // ---------- ticks ----------

  // ticks: [{ ms, lateMs? }] or numbers -> the window's tick figures.
  function summarizeTicks(ticks, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
    const list = (ticks || []).map((tick) => (typeof tick === "number" ? { ms: tick } : tick))
      .filter((tick) => tick && Number.isFinite(tick.ms));
    const durations = list.map((tick) => tick.ms).sort((a, b) => a - b);
    const late = list.map((tick) => tick.lateMs).filter(Number.isFinite);
    const sum = durations.reduce((total, value) => total + value, 0);
    return {
      ticks: durations.length,
      budgetMs,
      tickAvgMs: durations.length ? round(sum / durations.length) : null,
      tickP50Ms: round(percentile(durations, 50)),
      tickP95Ms: round(percentile(durations, 95)),
      tickP99Ms: round(percentile(durations, 99)),
      tickMaxMs: round(durations.length ? durations[durations.length - 1] : null),
      overBudget: durations.filter((value) => value > budgetMs).length,
      lateAvgMs: late.length ? round(late.reduce((total, value) => total + value, 0) / late.length) : null,
      lateMaxMs: late.length ? round(Math.max(...late)) : null,
    };
  }

  // Every tick a PERF event carries, as { atMs, ms }.
  function ticksOf(event) {
    const series = event && event.series;
    if (!series || !Array.isArray(series.at) || !Array.isArray(series.ms)) return [];
    const base = Number(event.atMs) || 0;
    const out = [];
    for (let index = 0; index < series.ms.length; index += 1) {
      const ms = Number(series.ms[index]);
      if (Number.isFinite(ms)) out.push({ atMs: base + (Number(series.at[index]) || 0), ms });
    }
    return out;
  }

  // ---------- a run's phases ----------

  const maxOf = (values) => {
    const list = values.filter(Number.isFinite);
    return list.length ? Math.max(...list) : null;
  };

  // A run's PERF events, cut where each runner STEP ended, so the time before a
  // spawn reads as the baseline and the time after it as the load. Each phase
  // names the step that opened it. Ticks are placed by their own time, so a
  // window that spans a step splits at it.
  function perfPhases(events, { budgetMs = null } = {}) {
    const list = Array.isArray(events) ? events : [];
    const perf = list.filter((event) => event && event.kind === "PERF");
    if (!perf.length) return [];
    const budget = budgetMs || perf.find((event) => event.budgetMs > 0)?.budgetMs || DEFAULT_BUDGET_MS;
    const ticks = perf.flatMap(ticksOf).sort((a, b) => a.atMs - b.atMs);
    const steps = list.filter((event) => event && event.kind === "STEP" && Number.isFinite(event.atMs))
      .sort((a, b) => a.atMs - b.atMs);
    const start = list.find((event) => event && event.kind === "START");
    const firstAt = Math.min(...[start && start.atMs, ticks[0] && ticks[0].atMs].filter(Number.isFinite));
    const bounds = [{ atMs: firstAt, label: "watch start", phase: "setup", step: null }];
    for (const step of steps) {
      bounds.push({ atMs: step.atMs, label: `after ${step.step}`, phase: step.phase || "setup", step: step.step, ok: step.ok });
    }
    const stopEvent = list.find((event) => event && event.kind === "STOP" && event.source === "runner");
    const endAt = Math.max(...[stopEvent && stopEvent.atMs, ...perf.map((event) => event.atMs)].filter(Number.isFinite));
    const phases = [];
    for (let index = 0; index < bounds.length; index += 1) {
      const last = index + 1 === bounds.length;
      const from = bounds[index].atMs;
      const to = last ? endAt : bounds[index + 1].atMs;
      // The last phase keeps every tick after its start, also those a late window brought.
      const inside = ticks.filter((tick) => tick.atMs >= from && (last || tick.atMs < to));
      if (!inside.length) continue;
      // Process figures come per window: a window belongs to the phase its end is in.
      const windows = perf.filter((event) => event.atMs > from && (last || event.atMs <= to));
      phases.push({
        label: bounds[index].label,
        step: bounds[index].step,
        phase: bounds[index].phase,
        fromMs: from,
        toMs: to,
        ...summarizeTicks(inside, { budgetMs: budget }),
        loopP99Ms: maxOf(windows.map((event) => event.loopP99Ms)),
        cpuPct: maxOf(windows.map((event) => event.cpuPct)),
        heapMB: maxOf(windows.map((event) => event.heapMB)),
        entities: maxOf(windows.map((event) => event.entities)),
      });
    }
    return phases;
  }

  // The whole run's figures, its phases and its profile, for result.json and
  // the report. null when the run has no PERF events.
  function perfRecord(events) {
    const list = Array.isArray(events) ? events : [];
    const perf = list.filter((event) => event && event.kind === "PERF");
    if (!perf.length) return null;
    const budgetMs = perf.find((event) => event.budgetMs > 0)?.budgetMs || DEFAULT_BUDGET_MS;
    const start = list.find((event) => event && event.kind === "START" && event.perf);
    const profiles = list.filter((event) => event && event.kind === "PROFILE");
    const missed = perf.reduce((sum, event) => sum + (Number(event.missedTicks) || 0), 0);
    return {
      profiler: Boolean(start && start.perf && start.perf.profiler) || profiles.length > 0,
      budgetMs,
      windows: perf.length,
      missedTicks: missed,
      overall: {
        ...summarizeTicks(perf.flatMap(ticksOf), { budgetMs }),
        loopP99Ms: maxOf(perf.map((event) => event.loopP99Ms)),
        loopMaxMs: maxOf(perf.map((event) => event.loopMaxMs)),
        cpuPctMax: maxOf(perf.map((event) => event.cpuPct)),
        heapMBMax: maxOf(perf.map((event) => event.heapMB)),
        rssMBMax: maxOf(perf.map((event) => event.rssMB)),
        entitiesMax: maxOf(perf.map((event) => event.entities)),
        tidiMin: (() => {
          const values = perf.map((event) => event.tidiMin).filter(Number.isFinite);
          return values.length ? Math.min(...values) : null;
        })(),
      },
      phases: perfPhases(list, { budgetMs }),
      profile: mergeProfiles(profiles),
    };
  }

  // ---------- text ----------

  const ms = (value) => (value === null || value === undefined ? "-" : `${Number(value).toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}`);

  // One PERF event's line body, for the timeline.
  function perfLine(event) {
    const over = event.overBudget ? `, ${event.overBudget} over ${event.budgetMs} ms` : "";
    const busiest = Array.isArray(event.busiest) && event.busiest[0]
      ? `  busiest ${event.busiest[0].systemName || event.busiest[0].systemID} ${ms(event.busiest[0].workAvgMs)} ms` : "";
    return [`tick ${ms(event.tickAvgMs)}/${ms(event.tickP95Ms)}/${ms(event.tickMaxMs)} ms avg/p95/max over ` +
      `${event.ticks} ticks${over}${event.missedTicks ? ` (${event.missedTicks} missed)` : ""}`,
    [event.loopP99Ms !== null && event.loopP99Ms !== undefined ? `loop p99 ${ms(event.loopP99Ms)} ms` : "",
      event.cpuPct !== null && event.cpuPct !== undefined ? `cpu ${Math.round(event.cpuPct)}%` : "",
      event.heapMB ? `heap ${Math.round(event.heapMB)} MB` : "",
      Number.isFinite(event.entities) ? `${event.entities} entities` : ""].filter(Boolean).join(", ") + busiest];
  }

  function profileLine(event) {
    const top = (event.sections || []).filter((row) => isAddend(row) && !isRemainder(row.label)).slice(0, 3)
      .map((row) => `${row.label} ${ms(row.msPerTick)}`).join(", ");
    return [`profile ${ms(event.totalMsPerTick)} ms/tick over ${event.ticks} ticks`, top ? `top ${top}` : ""];
  }

  function table(rows, header) {
    const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => String(row[index]).length)));
    const line = (cells) => cells.map((cell, index) => (index === 0 ? String(cell).padEnd(widths[index]) : String(cell).padStart(widths[index])))
      .join("  ").trimEnd();
    return [line(header), ...rows.map(line)];
  }

  function sectionRows(profile, limit = 12) {
    return (profile && profile.sections ? profile.sections : []).slice(0, limit)
      .map((row) => [`${row.nested ? "  ↳ " : ""}${row.label}${row.afterTick ? " (after tick)" : ""}`, ms(row.msPerTick),
        row.pct === null || row.pct === undefined ? "--" : `${Number(row.pct).toFixed(1)}%`, row.calls ? String(row.calls) : "-"]);
  }

  // What `e2e perf` prints for a POST /perf or GET /perf reply.
  function formatPerf(reply) {
    const perf = reply.perf || {};
    const lines = [];
    const profiler = reply.profiler || {};
    lines.push(`${reply.seconds ? `over ${reply.seconds} s` : "the last ticks the runtime kept"}: ${perf.ticks || 0} ticks, ` +
      `budget ${perf.budgetMs || DEFAULT_BUDGET_MS} ms a tick${perf.missedTicks ? `, ${perf.missedTicks} missed` : ""}`);
    if (perf.ticks) {
      lines.push(`  tick       avg ${ms(perf.tickAvgMs)}  p50 ${ms(perf.tickP50Ms)}  p95 ${ms(perf.tickP95Ms)}  ` +
        `p99 ${ms(perf.tickP99Ms)}  max ${ms(perf.tickMaxMs)} ms; ${perf.overBudget} over budget`);
      if (perf.lateAvgMs !== null && perf.lateAvgMs !== undefined) {
        lines.push(`  late       avg ${ms(perf.lateAvgMs)}  max ${ms(perf.lateMaxMs)} ms after the tick was due`);
      }
    }
    if (perf.loopP99Ms !== null && perf.loopP99Ms !== undefined) {
      lines.push(`  event loop p50 ${ms(perf.loopP50Ms)}  p99 ${ms(perf.loopP99Ms)}  max ${ms(perf.loopMaxMs)} ms delay`);
    }
    const proc = [perf.cpuPct !== null && perf.cpuPct !== undefined ? `cpu ${Math.round(perf.cpuPct)}% of a core` : "",
      perf.heapMB ? `heap ${Math.round(perf.heapMB)} MB` : "", perf.rssMB ? `rss ${Math.round(perf.rssMB)} MB` : ""].filter(Boolean);
    if (proc.length) lines.push(`  process    ${proc.join(", ")}`);
    if (Number.isFinite(perf.scenes)) {
      lines.push(`  world      ${perf.scenes} scene(s) ticking, ${perf.entities} entities` +
        `${perf.tidiMin !== null && perf.tidiMin !== undefined && perf.tidiMin < 1 ? `, time dilation down to ${perf.tidiMin}` : ""}`);
    }
    if (Array.isArray(perf.busiest) && perf.busiest.length) {
      lines.push("", ...table(perf.busiest.map((scene) => [scene.systemName || String(scene.systemID), ms(scene.workAvgMs), ms(scene.workMaxMs),
        String(scene.entities), String(scene.sessions)]), ["busiest scenes", "avg ms", "max ms", "entities", "sessions"]).map((line) => `  ${line}`));
    }
    const profile = reply.profile;
    if (!profiler.enabled) {
      lines.push("", "tick profiler off: no per-subsystem breakdown. Boot with `e2e up --profile` (EVEJS_TICK_PROFILE=1) for one.");
    } else if (!profile) {
      lines.push("", `tick profiler on (a window every ${profiler.everyTicks} ticks), but no window ended in this sample; sample for longer.`);
    } else {
      lines.push("", `tick profiler: ${profile.windows} window(s), ${profile.ticks} ticks, ${ms(profile.totalMsPerTick)} ms/tick in all`);
      lines.push(...table(sectionRows(profile), ["section", "ms/tick", "share", "calls"]).map((line) => `  ${line}`));
    }
    return lines.join("\n");
  }

  // ---------- the report ----------

  const cell = (text) => String(text === null || text === undefined ? "" : text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

  // The "Server performance" section of report.md, from perfRecord(). `offset`
  // formats a time on the watch's clock (t+00:00:12).
  function renderPerfSection(record, { offset = (ms) => `${Math.round(ms / 1000)} s`, watchStartedAtMs = null } = {}) {
    if (!record) return null;
    const lines = ["## Server performance", ""];
    const o = record.overall;
    lines.push(`${o.ticks} ticks in ${record.windows} window(s), budget ${record.budgetMs} ms a tick` +
      `${record.missedTicks ? `, ${record.missedTicks} ticks missed between samples` : ""}. ` +
      `Tick ${ms(o.tickAvgMs)} ms on average, p95 ${ms(o.tickP95Ms)}, p99 ${ms(o.tickP99Ms)}, max ${ms(o.tickMaxMs)}; ` +
      `${o.overBudget} over budget. Event loop delay p99 up to ${ms(o.loopP99Ms)} ms` +
      `${o.loopMaxMs !== null && o.loopMaxMs > o.loopP99Ms ? ` and once ${ms(o.loopMaxMs)} ms` : ""}, CPU up to ` +
      `${o.cpuPctMax === null ? "-" : Math.round(o.cpuPctMax)}% of a core, heap up to ${o.heapMBMax === null ? "-" : Math.round(o.heapMBMax)} MB` +
      `${o.tidiMin !== null && o.tidiMin < 1 ? `, time dilation down to ${o.tidiMin}` : ""}.`, "");
    if (record.phases.length) {
      lines.push("Each phase starts where a step ended, so the time before a spawn is the baseline for the time after it.", "");
      lines.push("| Phase | From | Ticks | Avg ms | p95 | p99 | Max | Over budget | Loop p99 | CPU % | Heap MB | Entities |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const phase of record.phases) {
        const from = watchStartedAtMs ? offset(Math.max(0, phase.fromMs - watchStartedAtMs)) : "";
        lines.push(`| ${cell(phase.label)} | ${from} | ${phase.ticks} | ${ms(phase.tickAvgMs)} | ${ms(phase.tickP95Ms)} | ` +
          `${ms(phase.tickP99Ms)} | ${ms(phase.tickMaxMs)} | ${phase.overBudget} | ${ms(phase.loopP99Ms)} | ` +
          `${phase.cpuPct === null ? "-" : Math.round(phase.cpuPct)} | ${phase.heapMB === null ? "-" : Math.round(phase.heapMB)} | ` +
          `${phase.entities === null ? "-" : phase.entities} |`);
      }
      lines.push("");
    }
    if (record.profile) {
      const top = topSection(record.profile);
      lines.push(`Tick profiler: ${record.profile.windows} window(s), ${ms(record.profile.totalMsPerTick)} ms a tick in all` +
        `${top ? `; ${top.label} costs most, ${ms(top.msPerTick)} ms a tick` : ""}. A ↳ row is inside the row above it, ` +
        "so it doesn't add to the total.", "");
      lines.push("| Section | ms/tick | Share | Calls |", "| --- | --- | --- | --- |");
      for (const row of sectionRows(record.profile, 15)) lines.push(`| ${row.map(cell).join(" | ")} |`);
      lines.push("");
    } else if (!record.profiler) {
      lines.push("No per-subsystem breakdown: the server ran without the tick profiler. Add `\"up\": { \"profile\": true }`.", "");
    }
    return lines.join("\n");
  }

  return {
    DEFAULT_BUDGET_MS,
    formatPerf,
    renderPerfSection,
    isAddend,
    isRemainder,
    isTickProfile,
    mergeProfiles,
    parseTickProfile,
    percentile,
    perfLine,
    perfPhases,
    perfRecord,
    profileLine,
    round,
    sectionRows,
    summarizeTicks,
    ticksOf,
    topSection,
  };
});
