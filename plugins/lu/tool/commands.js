"use strict";

// The Living Universe plugin's CLI commands: scouts, trigger, clock, warp and
// economy, and `teleport --flight`, which pins a flight where it lands. Each
// takes the CLI's io (bin/e2e.js pluginIO). Guide: docs/E2E-GRID-TESTING.md.

const fs = require("node:fs");
const path = require("node:path");

const triggerTools = require("./triggers");
const warpTools = require("./warp");

// The LU Monitor bridge runs in the same server and knows the population:
// which flights exist, where, and how to pin one for materialization.
function luMonitorHandshakePath(io) {
  return String(process.env.EVEJS_LU_MONITOR_BRIDGE_HANDSHAKE || "").trim() ||
    path.join(io.treeRoot, "_local", "luMonitor", "bridge.json");
}

function luMonitor(io, method, route, body) {
  const file = luMonitorHandshakePath(io);
  const handshake = io.readJSON(file);
  if (!handshake || !handshake.token || !io.pidAlive(handshake.pid)) {
    throw new io.CliError(`no live LU Monitor bridge (${io.relativePath(file)})`);
  }
  return io.callBridge(handshake, method, route, body);
}

// Pirate scouts are single-hull pirate flights. Holding scouts sit at their
// patrol destination and are the ones worth visiting: a scout in transit jumps
// in and warps on before its sensors' first scan.
function selectScouts(fleets, { all = false } = {}) {
  const scouts = fleets.filter((flight) => flight.family === "pirate" && flight.pilotCount === 1);
  const holding = (flight) => flight.phase === "mission_holding";
  scouts.sort((left, right) => Number(holding(right)) - Number(holding(left)) ||
    String(left.flightID).localeCompare(String(right.flightID)));
  return all ? scouts : scouts.filter(holding);
}

async function cmdScouts(_positionals, flags, io) {
  const reply = await luMonitor(io, "GET", "/fleets?all=1");
  const systems = io.solarSystems();
  const place = (id) => {
    const row = systems.get(id);
    return row ? `${row.solarSystemName} (${Number(row.security).toFixed(2)})` : String(id || "-");
  };
  const scouts = selectScouts(Array.isArray(reply.fleets) ? reply.fleets : [], { all: Boolean(flags.all) });
  for (const flight of scouts) {
    const hull = (flight.members || []).map((member) => member.hull).filter(Boolean).join("/");
    io.print(
      `${flight.flightID}  ${flight.homeCorporationName || "?"} ${hull}  ${flight.phase}  ` +
      `in ${place(flight.currentSystemID)}  system ${flight.currentSystemID}` +
      `${flight.materialized ? "  materialized" : ""}`,
    );
  }
  io.print(`${scouts.length} scout(s)${flags.all ? "" : " holding (--all for every scout)"}`);
}

// `e2e teleport <system> --flight <id>`: the LU Monitor's /teleport, which pins
// the flight for materialization before the jump.
async function teleportWithFlight(positionals, flags, io) {
  const state = io.requireLogin(io.readState());
  const systemID = io.resolveSystemID(positionals.join(" "));
  const before = await io.currentSystemID(state);
  const reply = await luMonitor(io, "POST", "/teleport", {
    characterID: state.characterID,
    systemID,
    flightID: String(flags.flight),
  });
  const text = `${reply.command} -> ${reply.success ? "ok" : "refused"}\n${reply.message || ""}`.trim();
  io.print(text);
  if (!reply.success) io.setExitCode(2);
  else await io.bindRemotePark(state, { unlessIn: before });
  return { ok: Boolean(reply.success), text };
}

// Prints the flight or hunt ID first, so the watch output can be grepped for it.
async function cmdTrigger(positionals, flags, io) {
  const state = io.requireLogin(io.readState());
  const name = positionals[0];
  let body;
  try {
    body = triggerTools.triggerRequest(name, positionals.slice(1), flags,
      { characterID: state.characterID, resolveSystemID: io.resolveSystemID });
  } catch (error) {
    throw error instanceof io.CliError ? error : new io.CliError(error.message);
  }
  if (name === "skirmish") {
    const reply = { trigger: "skirmish", ...(await luMonitor(io, "POST", "/allianceskirmish", body)) };
    if (reply.success === false) throw new io.CliError(`trigger skirmish: ${reply.message || "refused"}`);
    io.print(flags.json ? JSON.stringify(reply, null, 2) : triggerTools.formatTriggerReply(reply));
    return reply;
  }
  const before = await io.currentSystemID(state);
  const handshake = io.requireHandshake();
  const { status, json } = await io.requestJSON(`http://${handshake.host}:${handshake.port}/trigger/${name}`, {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${handshake.token}` },
    timeoutMs: 90_000,
  });
  if (status >= 400 || json.ok === false) {
    const refusals = json.refusals && Object.keys(json.refusals).length
      ? `\n  refused: ${Object.entries(json.refusals).map(([reason, count]) => `${reason} x${count}`).join(", ")}` : "";
    const facts = json.facts ? `\n  facts: ${Object.entries(json.facts).map(([key, value]) => `${key}=${value}`).join(" ")}` : "";
    throw new io.CliError(`trigger ${name}: ${json.error || `HTTP ${status}`}${refusals}${facts}`);
  }
  io.print(flags.json ? JSON.stringify(json, null, 2) : triggerTools.formatTriggerReply(json));
  if (json.moved && json.moved.success) await io.bindRemotePark(state, { unlessIn: before });
  return json;
}

async function cmdClock(_positionals, flags, io) {
  const { clock } = await io.bridge("GET", "/clock");
  if (flags.json) {
    io.print(JSON.stringify(clock, null, 2));
    return;
  }
  const marker = clock.marker;
  io.print(`LU clock ${new Date(clock.simNowMs).toISOString()}  offset ${warpTools.formatOffset(clock.offsetMs)}` +
    `  ${marker && marker.e2eWorld ? `e2e world (${marker.savedWorld || "?"})` : "no e2e marker: warp refused"}`);
  if (clock.warp) {
    const w = clock.warp;
    io.print(`warping: ${warpTools.formatDuration(w.simulatedMs)} of ${warpTools.formatDuration(w.targetSimMs)} ` +
      `in ${warpTools.formatDuration(w.realMs)} (${w.speed.toFixed(1)}x)`);
  }
  if (clock.backlog) {
    io.print(`backlog: oldest overdue flight ${warpTools.formatDuration(clock.backlog.flightsOverdueMs)}, ` +
      `deferred passes ${clock.backlog.deferredDuePasses}`);
  }
  if (clock.pulse) {
    const p = clock.pulse;
    const b = p.lastWorkBudget;
    io.print(`economy pulses ${p.completedPulses} (failed ${p.pulseFailures}): last ${p.lastDurationMs} ms, ` +
      `average ${p.averageDurationMs} ms, max ${p.maxDurationMs} ms` +
      (b ? `; last pulse ${b.wallMs} ms wall, ${b.externalWaitMs} ms in ${b.externalWaits} market waits, ` +
        `${b.yields} yields at ${b.budgetMs} ms slices` : ""));
    if (b && flags.stages) {
      for (const stage of b.stages) {
        io.print(`  ${stage.name.padEnd(32)} ${String(stage.wallMs).padStart(7)} ms wall  ` +
          `${String(stage.externalWaitMs).padStart(7)} ms market  ${stage.yields} yields`);
      }
    }
  }
}

function economyRunDir(flags, suffix, io) {
  const runID = flags.run ? String(flags.run).replace(/[^A-Za-z0-9._-]/g, "_") : `${io.runStamp(Date.now())}-${suffix}`;
  const runDir = path.join(io.runsDir, runID);
  fs.mkdirSync(runDir, { recursive: true });
  return { runID, runDir };
}

// Real time or warped, the window is measured the same way: an /economy read
// before, one after, and the telemetry snapshots in between.
async function cmdWarp(_positionals, flags, io) {
  const forMs = warpTools.parseDuration(flags.for);
  if (!forMs) throw new io.CliError("warp needs --for, e.g. --for 2h, --for 90m or --for 3600");
  const real = Boolean(flags.real);
  const run = io.readRun() || {};
  if (!real && !String(run.world || "").startsWith("saved ")) {
    throw new io.CliError(
      `this server's world is "${run.world || "unknown"}", not one restored from _local/e2e/worlds/. ` +
      "Warp only a copy: `e2e up --world <name>`. dev's own world must never get a clock offset.",
    );
  }
  const handshake = io.requireHandshake();
  const { runID, runDir } = economyRunDir(flags, real ? "real" : "warp", io);
  const clockBefore = (await io.bridge("GET", "/clock")).clock;
  // Reaching back one telemetry interval finds the snapshot the window starts from.
  const lookBackMs = 11 * 60 * 1000;
  const start = (await io.bridge("GET", `/economy?since=${clockBefore.simNowMs - lookBackMs}`)).economy;
  const startedAtReal = Date.now();
  io.print(`${real ? "watching" : "warping"} ${warpTools.formatDuration(forMs)} of Living Universe time from ` +
    `${new Date(start.simNowMs).toISOString()}; report in ${io.relativePath(runDir)}`);

  let final = null;
  if (real) {
    const targetMs = start.simNowMs + forMs;
    for (;;) {
      const { clock } = await io.bridge("GET", "/clock");
      if (clock.simNowMs >= targetMs) break;
      const remaining = targetMs - clock.simNowMs;
      io.print(`  +${warpTools.formatDuration(clock.simNowMs - start.simNowMs)}  ${warpTools.formatDuration(remaining)} to go`);
      await io.sleep(Math.min(remaining, 60_000));
    }
  } else {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    try {
      const response = await fetch(`http://${handshake.host}:${handshake.port}/warp`, {
        method: "POST",
        headers: { authorization: `Bearer ${handshake.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          forSeconds: forMs / 1000,
          stepMs: flags.step === undefined ? undefined : Number(flags.step),
          sliceMs: flags.slice === undefined ? undefined : Number(flags.slice),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const reply = await response.json().catch(() => ({}));
        throw new io.CliError(`bridge /warp: ${reply.error || `HTTP ${response.status}`}`);
      }
      const decoder = new TextDecoder();
      let pending = "";
      let lastPrintAt = 0;
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const text = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!text) continue;
          const event = JSON.parse(text);
          if (event.kind === "END") final = event;
          if (event.kind === "ERROR") throw new io.CliError(`warp failed: ${event.error}`);
          if (event.kind === "PROGRESS" && Date.now() - lastPrintAt >= 10_000) {
            lastPrintAt = Date.now();
            io.print(`  +${warpTools.formatDuration(event.simulatedMs)} in ${warpTools.formatDuration(event.realMs)} ` +
              `(${event.speed.toFixed(1)}x)  passes ${event.passes}  pulse waits ${event.pulseWaits}` +
              (event.backlog ? `  oldest overdue ${warpTools.formatDuration(event.backlog.flightsOverdueMs)}` : ""));
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error instanceof io.CliError ? error : new io.CliError(`bridge /warp failed: ${error.message}`);
      }
      await io.bridge("POST", "/warp/stop", {}).catch(() => {});
    } finally {
      process.removeListener("SIGINT", onInterrupt);
    }
  }
  const realMs = Date.now() - startedAtReal;
  const end = (await io.bridge("GET", `/economy?since=${start.simNowMs - lookBackMs}`)).economy;
  const summary = warpTools.buildEconomySummary({ start, end, mode: real ? "real" : "warp", warp: final, realMs });
  const record = { runID, world: run.world || null, forMs, clockBefore, start, end, warp: final, summary };
  fs.writeFileSync(path.join(runDir, "economy.json"), `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, "economy.md"), warpTools.renderEconomyMarkdown(summary, { runID, world: run.world }));
  io.print(`${real ? "real time" : "warped"}: ${warpTools.formatDuration(summary.simulatedMs)} simulated in ` +
    `${warpTools.formatDuration(realMs)} real (${summary.speed.toFixed(1)}x)` +
    (final ? `, ended ${final.stopReason}` : ""));
  io.print(`industry jobs ${summary.industry.jobsCompleted}, freight deliveries ${summary.freight.jobsDelivered}, ` +
    `stock ${summary.stock.stockUnitsEnd === null ? "-" : summary.stock.stockUnitsEnd.toLocaleString("en-US")} units`);
  io.print(`report: ${io.relativePath(path.join(runDir, "economy.md"))}`);
}

function readEconomyRun(id, io) {
  const file = path.join(io.runsDir, String(id), "economy.json");
  const record = io.readJSON(file);
  if (!record || !record.summary) throw new io.CliError(`no economy report in ${io.relativePath(file)}`);
  return record;
}

function cmdEconomy(positionals, _flags, io) {
  if (positionals[0] !== "compare" || positionals.length < 3) {
    throw new io.CliError("usage: e2e economy compare <reference run> <candidate run>");
  }
  const reference = readEconomyRun(positionals[1], io);
  const candidate = readEconomyRun(positionals[2], io);
  const result = warpTools.compareSummaries(reference.summary, candidate.summary);
  io.print(`reference ${reference.runID} (${reference.summary.mode}), candidate ${candidate.runID} (${candidate.summary.mode})`);
  for (const row of result.rows) {
    io.print(`${row.ok ? "ok  " : "FAIL"} ${row.name.padEnd(24)} ${String(row.a).padStart(12)} ${String(row.b).padStart(12)}` +
      `  diff ${row.difference >= 0 ? "+" : ""}${Math.round(row.difference * 100) / 100} (allowed ${Math.round(row.allowed * 100) / 100})`);
  }
  io.print(result.ok ? "agree within tolerances" : "DISAGREE");
  if (!result.ok) io.setExitCode(1);
}

const COMMANDS = {
  scouts: { usage: ["scouts [--all]"], run: cmdScouts },
  trigger: {
    usage: [
      "trigger scout [<system>] [--flight <id>] | trigger hunt [--flight <id>] [--phase stalking|committed]",
      "trigger fleet <family> [--doctrine <key>] [--to self|<system>] [--count 1-8] | trigger materialize <flightID> [--go]",
      "trigger skirmish [--count 1-20] [--class <shipClass>] [--gap <meters>]",
    ],
    booleanFlags: ["go"],
    run: cmdTrigger,
  },
  clock: { usage: ["clock [--stages] [--json]"], booleanFlags: ["stages"], run: cmdClock },
  warp: { usage: ["warp --for 24h [--step 1000] [--real] [--run <id>]"], booleanFlags: ["real"], run: cmdWarp },
  economy: { usage: ["economy compare <reference run> <candidate run>"], run: cmdEconomy },
};

const HANDLES = {
  teleport: { flags: ["flight"], usage: ["teleport <system> --flight <flightID>  (pins the flight to stand up there)"], run: teleportWithFlight },
};

module.exports = {
  COMMANDS,
  HANDLES,
  cmdTrigger,
  selectScouts,
};
