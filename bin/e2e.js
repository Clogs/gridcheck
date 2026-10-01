#!/usr/bin/env node
"use strict";

// Headless observer for end-to-end grid checks: log a character in through
// the web gateway, undock it, run slash commands on its session and read its
// grid, with no EVE client. Guide: docs/E2E-GRID-TESTING.md.
//
//   node tools/evejs-e2e/bin/e2e.js world copy --from ../dev [--force]
//   node tools/evejs-e2e/bin/e2e.js world save <name> [--note "..."] [--force] | world list
//   node tools/evejs-e2e/bin/e2e.js up [--world <name> [--real-clock] | --fresh] [--no-market] [--timeout 600] [--offgrid-travel 1-100] [--offgrid-activity 1-100]
//   node tools/evejs-e2e/bin/e2e.js down [--force] | status | ports
//   node tools/evejs-e2e/bin/e2e.js login [--user e2eagent] [--name "Agent Observer"]
//   node tools/evejs-e2e/bin/e2e.js undock | dock | logout
//   node tools/evejs-e2e/bin/e2e.js slash "/tr me Amamake"
//   node tools/evejs-e2e/bin/e2e.js scouts [--all]
//   node tools/evejs-e2e/bin/e2e.js teleport Siseide [--flight living_flight_0908]
//   node tools/evejs-e2e/bin/e2e.js trigger scout [<system>] [--flight <id>] | trigger hunt [--flight <id>] [--phase stalking|committed]
//   node tools/evejs-e2e/bin/e2e.js trigger fleet <family> [--doctrine <key>] [--to self|<system>] [--count 1-8] | trigger materialize <flightID> [--go]
//   node tools/evejs-e2e/bin/e2e.js grid [--range 10000] [--all] [--json]
//   node tools/evejs-e2e/bin/e2e.js watch [--for 600] [--every 2] [--offgrid-every 5] [--grep <regex>] [--no-log] [--json] [--run <id>]
//                               [--client all|fx|diverge|off] [--diverge-meters 5000] [--positions]
//   node tools/evejs-e2e/bin/e2e.js act <approach|orbit|keepAtRange|warpTo|stop|lock|unlock|activate|deactivate|loadAmmo|launchDrones|engageDrones> [<target|modules>] [--range] [--target] [--once] [--charge] [--count] [--timeout]
//   node tools/evejs-e2e/bin/e2e.js view [<run>] [--serve] [--port N]
//   node tools/evejs-e2e/bin/e2e.js run [<scenario>] [--check] [--run <id>] [--keep-up]
//   node tools/evejs-e2e/bin/e2e.js log [--grep PirateHunt] [--lines 40] [--any-pid]
//   node tools/evejs-e2e/bin/e2e.js clock [--stages] [--json]
//   node tools/evejs-e2e/bin/e2e.js warp --for 24h [--step 1000] [--real] [--run <id>]
//   node tools/evejs-e2e/bin/e2e.js economy compare <reference run> <candidate run>

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { formatClock, formatGrid } = require("../core/format");
const { collectIDs, createReorderBuffer, formatTimelineEvent, mentionsAny, parseLogLine } = require("../core/timeline");
const { busyPorts, marketConfig, portsForTree, serverEnvironment } = require("../core/ports");
const worlds = require("../core/worlds");
const warpTools = require("../plugins/lu/tool/warp");
const triggerTools = require("../plugins/lu/tool/triggers");
const scenarioTools = require("../core/scenario");
const frameTools = require("../core/frames");
const actionTools = require("../core/actions");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const E2E_DIR = path.join(REPO_ROOT, "_local", "e2e");
const STATE_PATH = path.join(E2E_DIR, "state.json");
const SERVER_OUT_PATH = path.join(E2E_DIR, "server.out.log");
const BRIDGE_HANDSHAKE_PATH = String(process.env.EVEJS_AGENT_BRIDGE_HANDSHAKE || "").trim() ||
  path.join(REPO_ROOT, "_local", "agentBridge", "bridge.json");
const LU_MONITOR_HANDSHAKE_PATH = String(process.env.EVEJS_LU_MONITOR_BRIDGE_HANDSHAKE || "").trim() ||
  path.join(REPO_ROOT, "_local", "luMonitor", "bridge.json");
const SOLAR_SYSTEMS_PATH = path.join(REPO_ROOT, "_local", "gameStore", "data", "solarSystems", "data.json");
const SERVER_LOG_PATH = path.join(REPO_ROOT, "_local", "logs", "server.log");
const WORLD = worlds.worldPaths(REPO_ROOT);
const WORLD_PATH = WORLD.world;
const MANIFEST_PATH = WORLD.manifest;
const RUN_PATH = path.join(E2E_DIR, "run.json");
const MARKET_DIR = path.join(REPO_ROOT, "externalservices", "market-server");
const MARKET_EXE = path.join(MARKET_DIR, "target", "release", `market-server${process.platform === "win32" ? ".exe" : ""}`);
const MARKET_TRACKED_CONFIG = path.join(MARKET_DIR, "config", "market-server.local.toml");
const MARKET_CONFIG_PATH = path.join(E2E_DIR, "market-server.toml");
const MARKET_OUT_PATH = path.join(E2E_DIR, "market.out.log");
const MARKET_BUILD_PATH = path.join(E2E_DIR, "market.build.log");
const TREE_PORTS = portsForTree(REPO_ROOT);

const BOOLEAN_FLAGS = new Set(["all", "json", "any-pid", "force", "fresh", "no-market", "no-log", "help", "real", "stages", "go", "real-clock",
  "check", "keep-up", "positions", "once", "serve"]);

class CliError extends Error {}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
    } else if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
    } else if (index + 1 < argv.length) {
      flags[body] = argv[index + 1];
      index += 1;
    } else {
      throw new CliError(`--${body} needs a value`);
    }
  }
  return { command: positionals.shift() || "help", positionals, flags };
}

// ---------- state and handshake ----------

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

function relativePath(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function readState() {
  return readJSON(STATE_PATH) || {};
}

function writeState(state) {
  fs.mkdirSync(E2E_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function readHandshake() {
  const handshake = readJSON(BRIDGE_HANDSHAKE_PATH);
  return handshake && handshake.port && handshake.token && pidAlive(handshake.pid) ? handshake : null;
}

// What `e2e up` started: server and market pids, the port block, boot time.
function readRun() {
  return readJSON(RUN_PATH);
}

function writeRun(run) {
  fs.mkdirSync(E2E_DIR, { recursive: true });
  fs.writeFileSync(RUN_PATH, `${JSON.stringify(run, null, 2)}\n`);
}

// The ports of the server this tree runs: the live run's, else this tree's
// block. EVEJS_MICROSERVICES_PORT still points the CLI at a server started
// some other way (StartServer.bat with EVEJS_AGENT_BRIDGE=1 uses 26002).
function activePorts() {
  const run = readRun();
  if (run && run.ports && pidAlive(run.pid)) return run.ports;
  const gateway = Math.trunc(Number(process.env.EVEJS_MICROSERVICES_PORT) || 0);
  return gateway ? { ...TREE_PORTS, gateway } : TREE_PORTS;
}

function gatewayBase(ports = activePorts()) {
  return `http://127.0.0.1:${ports.gateway}/_evejs-web/v1`;
}

// ---------- HTTP ----------

async function requestJSON(url, { method = "GET", headers = {}, body, timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error && error.cause && error.cause.code ? error.cause.code : error.message;
    throw new CliError(`${method} ${url} failed: ${cause}`);
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_error) {
    json = { raw: text };
  }
  return { status: response.status, json };
}

function gatewayHeaders() {
  const token = String(process.env.EVEJS_WEB_GATEWAY_TOKEN || "").trim();
  return token ? { "x-evejs-web-token": token } : {};
}

async function gateway(method, route, body) {
  const { status, json } = await requestJSON(`${gatewayBase()}${route}`, { method, body, headers: gatewayHeaders() });
  if (status >= 400 || json.ok === false) {
    // Gateway errors are { ok: false, error: "<CODE>", message }.
    const code = typeof json.error === "string" ? json.error : `HTTP ${status}`;
    const message = json.message || json.raw || "";
    throw new CliError(`gateway ${route}: ${code} ${message}`.trim());
  }
  return json;
}

function requireHandshake() {
  const handshake = readHandshake();
  if (!handshake) {
    throw new CliError(
      `no live agent bridge (${relativePath(BRIDGE_HANDSHAKE_PATH)}). ` +
      "Start the server with `e2e up`, or with EVEJS_AGENT_BRIDGE=1.",
    );
  }
  return handshake;
}

function bridge(method, route, body) {
  return callBridge(requireHandshake(), method, route, body);
}

// The LU Monitor bridge runs in the same server and knows the population:
// which flights exist, where, and how to pin one for materialization.
function luMonitor(method, route, body) {
  const handshake = readJSON(LU_MONITOR_HANDSHAKE_PATH);
  if (!handshake || !handshake.token || !pidAlive(handshake.pid)) {
    throw new CliError(`no live LU Monitor bridge (${relativePath(LU_MONITOR_HANDSHAKE_PATH)})`);
  }
  return callBridge(handshake, method, route, body);
}

async function callBridge(handshake, method, route, body) {
  const { status, json } = await requestJSON(`http://${handshake.host}:${handshake.port}${route}`, {
    method,
    body,
    headers: { authorization: `Bearer ${handshake.token}` },
  });
  if (status >= 400 || json.ok === false) {
    throw new CliError(`bridge ${route}: ${json.error || json.message || `HTTP ${status}`}`);
  }
  return json;
}

function requireLogin(state) {
  if (!state.characterID || !state.bridgeSessionID) {
    throw new CliError("no logged-in character. Run `e2e login` first.");
  }
  return state;
}

// A gateway call on the held session: refreshes its 30-minute idle timer and
// drains its notification backlog, which only gateway reads do.
async function keepAlive(state) {
  return gateway("POST", "/session/flight-status", {
    bridgeSessionID: state.bridgeSessionID,
    session: { userid: state.accountID },
  });
}

// The bridge keeps what the client would have been sent from here on. Done
// before undock, so the client view starts from the undock's SetState.
async function attachTee(state) {
  const handshake = readHandshake();
  if (!handshake) return null;
  try {
    const reply = await callBridge(handshake, "POST", "/tee", { characterID: state.characterID });
    return reply.client || null;
  } catch (error) {
    console.log(`client view not attached: ${error.message}`);
    return null;
  }
}

// A real client binds the remote park (Moniker('beyonce', solarSystemID))
// straight after undock, and that bind is what sends its SetState. Without it
// the server holds the SetState back for 15 to 20 s. A system change (/tr,
// /solar, teleport) needs a fresh bind too; `unlessIn` skips it when the
// character is still in that system.
async function bindRemotePark(state, { unlessIn = null } = {}) {
  try {
    const status = await keepAlive(state);
    const flight = status.flight || {};
    const systemID = Number(flight.solarSystemID);
    if (!systemID || flight.docked || (unlessIn && systemID === unlessIn)) return;
    await gateway("POST", "/bound/bind", {
      service: "beyonce",
      method: "MachoBindObject",
      args: [systemID, null],
      confirm: true,
      session: { userid: state.accountID },
      bridgeSessionID: state.bridgeSessionID,
    });
  } catch (error) {
    console.log(`remote park not bound: ${error.message}`);
  }
}

async function currentSystemID(state) {
  try {
    const status = await keepAlive(state);
    return status.flight && !status.flight.docked ? Number(status.flight.solarSystemID) || null : null;
  } catch (_error) {
    return null;
  }
}

// ---------- commands ----------

async function cmdLogin(flags) {
  const state = readState();
  const username = String(flags.user || state.username || "e2eagent");
  const wantedName = flags.name ? String(flags.name) : null;
  const created = await gateway("POST", "/account/create", { username });
  const accountID = Number(created.account && created.account.accountID);
  if (!accountID) throw new CliError(`account/create returned no accountID for ${username}`);

  const listed = await gateway("GET", `/characters?accountID=${accountID}`);
  const characters = Array.isArray(listed.characters) ? listed.characters : [];
  const character = wantedName
    ? characters.find((row) => String(row.characterName || row.name || "") === wantedName)
    : characters[0];
  let characterID = character ? Number(character.characterID || character.id) : 0;
  if (!characterID) {
    const name = wantedName || "Agent Observer";
    const made = await gateway("POST", "/call", {
      service: "charUnboundMgr",
      method: "CreateCharacterWithDoll",
      // Legacy signature: name, bloodline, gender, ancestry, charInfo, portraitInfo, school.
      args: [name, 1, 1, 1, {}, {}, 11],
      confirm: true,
      session: { userid: accountID },
    });
    characterID = Number(made.result);
    if (!characterID) throw new CliError(`CreateCharacterWithDoll returned ${JSON.stringify(made.result)}`);
    console.log(`created character ${name} (${characterID})`);
  }

  if (state.bridgeSessionID && state.characterID === characterID && state.accountID === accountID) {
    try {
      const status = await keepAlive(state);
      const text = `already logged in: ${state.characterName} (${characterID}) ${describeFlight(status.flight)}`;
      console.log(text);
      await attachTee(state);
      return text;
    } catch (_error) {
      // Expired or released; select again below.
    }
  }

  const selected = await gateway("POST", "/session/select", {
    args: [characterID],
    confirm: true,
    session: { userid: accountID },
  });
  const session = selected.session || {};
  writeState({
    username,
    accountID,
    characterID,
    characterName: session.characterName || null,
    bridgeSessionID: selected.bridgeSessionID,
    loggedInAtMs: Date.now(),
  });
  const where = session.stationID ? `docked in ${session.stationID}` : "in space";
  const text = `logged in: ${session.characterName} (${characterID}) account ${username}/${accountID}, ` +
    `${where}, system ${session.solarSystemID}, ship ${session.shipID}`;
  console.log(text);
  await attachTee({ characterID });
  return text;
}

function describeFlight(flight) {
  if (!flight || typeof flight !== "object") return "";
  const system = flight.solarSystemID || "?";
  return flight.docked
    ? `(docked in ${flight.stationID || flight.structureID}, system ${system})`
    : `(in space, system ${system}, ${flight.shipMode || "?"})`;
}

async function cmdUndock() {
  const state = requireLogin(readState());
  const status = await keepAlive(state);
  if (status.flight && status.flight.inSpace) {
    console.log(`already in space ${describeFlight(status.flight)}`);
    return `already in space ${describeFlight(status.flight)}`;
  }
  await attachTee(state);
  const result = await gateway("POST", "/call", {
    service: "ship",
    method: "Undock",
    args: [],
    confirm: true,
    session: { userid: state.accountID },
    bridgeSessionID: state.bridgeSessionID,
  });
  const notified = (result.notifications || []).map((row) => row.method).filter(Boolean);
  const text = `undocked${notified.length ? ` (${notified.join(", ")})` : ""}`;
  console.log(text);
  await bindRemotePark(state);
  return text;
}

async function runSlash(command) {
  const state = requireLogin(readState());
  const before = await currentSystemID(state);
  const reply = await bridge("POST", "/slash", { characterID: state.characterID, command });
  const verdict = !reply.handled ? "not a command" : reply.success ? "ok" : "refused";
  const text = `${command} -> ${verdict}${reply.message ? `\n${reply.message}` : ""}`;
  console.log(text);
  if (reply.handled && !reply.success) process.exitCode = 2;
  if (reply.success) await bindRemotePark(state, { unlessIn: before });
  return { ok: Boolean(reply.handled && reply.success), text };
}

async function cmdGrid(flags) {
  const state = requireLogin(readState());
  await keepAlive(state);
  const reply = await bridge("GET", `/grid?characterID=${state.characterID}`);
  if (flags.json) {
    console.log(JSON.stringify(reply.grid, null, 2));
    return;
  }
  const rangeKm = flags.range === undefined ? undefined : Number(flags.range);
  if (rangeKm !== undefined && !(rangeKm > 0)) throw new CliError("--range takes a positive number of km");
  console.log(formatGrid(reply.grid, {
    all: Boolean(flags.all),
    rangeKm,
    sinceMs: state.loggedInAtMs ? Date.now() - state.loggedInAtMs : undefined,
  }));
}

// Only LU, NPC and hostility lines by default, and only those naming a flight
// or ball this watch has seen. PirateHunt lines repeat the HUNT events.
// LivingRetaliation says whether being shot woke a flight to fight back.
const DEFAULT_WATCH_LOG = "\\[(LivingHostility|LivingRetaliation|NpcController|HunterIntel|LivingUniverse)\\]";

function runStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

// Reads what the server appends to its log while the watch runs.
function createLogTailer({ file, pid, pattern, keep, onEvent }) {
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch (_error) {
    offset = 0;
  }
  let carry = "";
  function poll() {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch (_error) {
      return;
    }
    if (size < offset) offset = 0;
    if (size === offset) return;
    const length = Math.min(size - offset, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    offset += length;
    const lines = (carry + buffer.toString("utf8")).split(/\r?\n/);
    carry = lines.pop();
    for (const line of lines) {
      const parsed = parseLogLine(line);
      if (!parsed || (pid && parsed.pid !== pid) || !pattern.test(parsed.text) || !keep(parsed.text)) continue;
      onEvent({ kind: "LOG", atMs: parsed.atMs, level: parsed.level, text: parsed.text });
    }
  }
  const timer = setInterval(poll, 1000);
  return { stop() { clearInterval(timer); poll(); } };
}

// One bridge watch: the NDJSON stream, the log tailer and the reorder buffer,
// writing timeline.jsonl in runDir. `push` adds an event of the caller's own
// (a scenario step) to the same timeline. Resolves once the bridge has
// accepted the watch; `ended` resolves with { reason, error } when it stops.
async function openWatch(state, handshake, { forSeconds, everySeconds, offGridEverySeconds, client, divergeMeters,
  positions = false, log = true, grep, runDir, print = (line) => console.log(line), onEvent = () => {} }) {
  fs.mkdirSync(runDir, { recursive: true });
  const timelinePath = path.join(runDir, "timeline.jsonl");
  const out = fs.openSync(timelinePath, "a");

  let startedAtMs = null;
  const knownIDs = new Set([String(state.characterID)]);
  const buffer = createReorderBuffer(1500, (event) => {
    const line = startedAtMs === null || event.t !== undefined ? event : { ...event, t: event.atMs - startedAtMs };
    fs.writeSync(out, `${JSON.stringify(line)}\n`);
    // Positions are for the frames, read back from the file; not a timeline line.
    if (line.kind === "POS") return;
    print(line);
    onEvent(line);
  });
  const flushTimer = setInterval(() => buffer.flush(Date.now()), 500);
  const aliveTimer = setInterval(() => { keepAlive(state).catch(() => {}); }, 60_000);
  let tailer = null;
  if (log) {
    const explicit = grep !== undefined && grep !== null;
    tailer = createLogTailer({
      file: SERVER_LOG_PATH,
      pid: handshake.pid,
      pattern: new RegExp(explicit ? String(grep) : DEFAULT_WATCH_LOG, "i"),
      keep: explicit ? () => true : (text) => mentionsAny(text, knownIDs),
      onEvent: (event) => buffer.push(event),
    });
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(flushTimer);
    clearInterval(aliveTimer);
    if (tailer) tailer.stop();
    buffer.flush(Date.now(), true);
    fs.closeSync(out);
  };

  const controller = new AbortController();
  let response;
  try {
    response = await fetch(`http://${handshake.host}:${handshake.port}/watch`, {
      method: "POST",
      headers: { authorization: `Bearer ${handshake.token}`, "content-type": "application/json" },
      body: JSON.stringify({ characterID: state.characterID, forSeconds, everySeconds, offGridEverySeconds, client,
        divergeMeters, positions: positions === true }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout((forSeconds + 120) * 1000)]),
    });
    if (!response.ok) {
      const reply = await response.json().catch(() => ({}));
      throw new CliError(`bridge /watch: ${reply.error || `HTTP ${response.status}`}`);
    }
  } catch (error) {
    close();
    throw error instanceof CliError ? error : new CliError(`bridge /watch failed: ${error.message}`);
  }

  const ended = (async () => {
    let end = null;
    let failure = null;
    try {
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const text = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!text) continue;
          const event = JSON.parse(text);
          if (event.kind === "START") startedAtMs = event.atMs;
          if (event.kind === "END") end = event;
          if (event.kind !== "POS") collectIDs(event, knownIDs);
          buffer.push(event);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) failure = error.message;
    } finally {
      close();
    }
    return {
      reason: end ? end.reason : controller.signal.aborted ? "stopped" : "stream-closed",
      error: failure,
      end,
    };
  })();

  return {
    timelinePath,
    push: (event) => { if (!closed) buffer.push(event); },
    stop: () => {
      controller.abort();
      return ended;
    },
    ended,
  };
}

async function cmdWatch(flags) {
  const state = requireLogin(readState());
  const handshake = requireHandshake();
  await keepAlive(state);
  const forSeconds = flags.for === undefined ? 600 : Number(flags.for);
  const everySeconds = flags.every === undefined ? 2 : Number(flags.every);
  const offGridEverySeconds = flags["offgrid-every"] === undefined ? undefined : Number(flags["offgrid-every"]);
  if (![forSeconds, everySeconds, offGridEverySeconds === undefined ? 1 : offGridEverySeconds].every((value) => value > 0)) {
    throw new CliError("--for, --every and --offgrid-every take positive seconds");
  }
  const client = flags.client === undefined ? "all" : String(flags.client);
  if (!["all", "fx", "diverge", "off"].includes(client)) throw new CliError("--client takes all, fx, diverge or off");
  const divergeMeters = flags["diverge-meters"] === undefined ? undefined : Number(flags["diverge-meters"]);
  if (divergeMeters !== undefined && !(divergeMeters > 0)) throw new CliError("--diverge-meters takes a positive number");
  const runID = flags.run ? String(flags.run).replace(/[^A-Za-z0-9._-]/g, "_") : `${runStamp(Date.now())}-watch`;

  const watch = await openWatch(state, handshake, {
    forSeconds, everySeconds, offGridEverySeconds, client, divergeMeters,
    // Positions feed the viewer (e2e view); a run always records them.
    positions: Boolean(flags.positions),
    log: !flags["no-log"],
    grep: flags.grep,
    runDir: path.join(E2E_DIR, "runs", runID),
    print: (line) => console.log(flags.json ? JSON.stringify(line) : formatTimelineEvent(line)),
  });
  const onInterrupt = () => { watch.stop(); };
  process.once("SIGINT", onInterrupt);
  let ended;
  try {
    ended = await watch.ended;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
  if (ended.error) throw new CliError(`bridge /watch failed: ${ended.error}`);
  console.log(`${ended.end ? "" : "stopped before the watch ended; "}timeline in ${relativePath(watch.timelinePath)}`);
}

let solarSystems = null;
// ---------- warp ----------

async function cmdClock(flags) {
  const { clock } = await bridge("GET", "/clock");
  if (flags.json) {
    console.log(JSON.stringify(clock, null, 2));
    return;
  }
  const marker = clock.marker;
  console.log(`LU clock ${new Date(clock.simNowMs).toISOString()}  offset ${warpTools.formatOffset(clock.offsetMs)}` +
    `  ${marker && marker.e2eWorld ? `e2e world (${marker.savedWorld || "?"})` : "no e2e marker: warp refused"}`);
  if (clock.warp) {
    const w = clock.warp;
    console.log(`warping: ${warpTools.formatDuration(w.simulatedMs)} of ${warpTools.formatDuration(w.targetSimMs)} ` +
      `in ${warpTools.formatDuration(w.realMs)} (${w.speed.toFixed(1)}x)`);
  }
  if (clock.backlog) {
    console.log(`backlog: oldest overdue flight ${warpTools.formatDuration(clock.backlog.flightsOverdueMs)}, ` +
      `deferred passes ${clock.backlog.deferredDuePasses}`);
  }
  if (clock.pulse) {
    const p = clock.pulse;
    const b = p.lastWorkBudget;
    console.log(`economy pulses ${p.completedPulses} (failed ${p.pulseFailures}): last ${p.lastDurationMs} ms, ` +
      `average ${p.averageDurationMs} ms, max ${p.maxDurationMs} ms` +
      (b ? `; last pulse ${b.wallMs} ms wall, ${b.externalWaitMs} ms in ${b.externalWaits} market waits, ` +
        `${b.yields} yields at ${b.budgetMs} ms slices` : ""));
    if (b && flags.stages) {
      for (const stage of b.stages) {
        console.log(`  ${stage.name.padEnd(32)} ${String(stage.wallMs).padStart(7)} ms wall  ` +
          `${String(stage.externalWaitMs).padStart(7)} ms market  ${stage.yields} yields`);
      }
    }
  }
}

function economyRunDir(flags, suffix) {
  const runID = flags.run ? String(flags.run).replace(/[^A-Za-z0-9._-]/g, "_") : `${runStamp(Date.now())}-${suffix}`;
  const runDir = path.join(E2E_DIR, "runs", runID);
  fs.mkdirSync(runDir, { recursive: true });
  return { runID, runDir };
}

// Real time or warped, the window is measured the same way: an /economy read
// before, one after, and the telemetry snapshots in between.
async function cmdWarp(flags) {
  const forMs = warpTools.parseDuration(flags.for);
  if (!forMs) throw new CliError("warp needs --for, e.g. --for 2h, --for 90m or --for 3600");
  const real = Boolean(flags.real);
  const run = readRun() || {};
  if (!real && !String(run.world || "").startsWith("saved ")) {
    throw new CliError(
      `this server's world is "${run.world || "unknown"}", not one restored from _local/e2e/worlds/. ` +
      "Warp only a copy: `e2e up --world <name>`. dev's own world must never get a clock offset.",
    );
  }
  const handshake = requireHandshake();
  const { runID, runDir } = economyRunDir(flags, real ? "real" : "warp");
  const clockBefore = (await bridge("GET", "/clock")).clock;
  // Reaching back one telemetry interval finds the snapshot the window starts from.
  const lookBackMs = 11 * 60 * 1000;
  const start = (await bridge("GET", `/economy?since=${clockBefore.simNowMs - lookBackMs}`)).economy;
  const startedAtReal = Date.now();
  console.log(`${real ? "watching" : "warping"} ${warpTools.formatDuration(forMs)} of Living Universe time from ` +
    `${new Date(start.simNowMs).toISOString()}; report in ${relativePath(runDir)}`);

  let final = null;
  if (real) {
    const targetMs = start.simNowMs + forMs;
    for (;;) {
      const { clock } = await bridge("GET", "/clock");
      if (clock.simNowMs >= targetMs) break;
      const remaining = targetMs - clock.simNowMs;
      console.log(`  +${warpTools.formatDuration(clock.simNowMs - start.simNowMs)}  ${warpTools.formatDuration(remaining)} to go`);
      await sleep(Math.min(remaining, 60_000));
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
        throw new CliError(`bridge /warp: ${reply.error || `HTTP ${response.status}`}`);
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
          if (event.kind === "ERROR") throw new CliError(`warp failed: ${event.error}`);
          if (event.kind === "PROGRESS" && Date.now() - lastPrintAt >= 10_000) {
            lastPrintAt = Date.now();
            console.log(`  +${warpTools.formatDuration(event.simulatedMs)} in ${warpTools.formatDuration(event.realMs)} ` +
              `(${event.speed.toFixed(1)}x)  passes ${event.passes}  pulse waits ${event.pulseWaits}` +
              (event.backlog ? `  oldest overdue ${warpTools.formatDuration(event.backlog.flightsOverdueMs)}` : ""));
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error instanceof CliError ? error : new CliError(`bridge /warp failed: ${error.message}`);
      }
      await bridge("POST", "/warp/stop", {}).catch(() => {});
    } finally {
      process.removeListener("SIGINT", onInterrupt);
    }
  }
  const realMs = Date.now() - startedAtReal;
  const end = (await bridge("GET", `/economy?since=${start.simNowMs - lookBackMs}`)).economy;
  const summary = warpTools.buildEconomySummary({ start, end, mode: real ? "real" : "warp", warp: final, realMs });
  const record = { runID, world: run.world || null, forMs, clockBefore, start, end, warp: final, summary };
  fs.writeFileSync(path.join(runDir, "economy.json"), `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, "economy.md"), warpTools.renderEconomyMarkdown(summary, { runID, world: run.world }));
  console.log(`${real ? "real time" : "warped"}: ${warpTools.formatDuration(summary.simulatedMs)} simulated in ` +
    `${warpTools.formatDuration(realMs)} real (${summary.speed.toFixed(1)}x)` +
    (final ? `, ended ${final.stopReason}` : ""));
  console.log(`industry jobs ${summary.industry.jobsCompleted}, freight deliveries ${summary.freight.jobsDelivered}, ` +
    `stock ${summary.stock.stockUnitsEnd === null ? "-" : summary.stock.stockUnitsEnd.toLocaleString("en-US")} units`);
  console.log(`report: ${relativePath(path.join(runDir, "economy.md"))}`);
}

function readEconomyRun(id) {
  const file = path.join(E2E_DIR, "runs", String(id), "economy.json");
  const record = readJSON(file);
  if (!record || !record.summary) throw new CliError(`no economy report in ${relativePath(file)}`);
  return record;
}

function cmdEconomy(positionals) {
  if (positionals[0] !== "compare" || positionals.length < 3) {
    throw new CliError("usage: e2e economy compare <reference run> <candidate run>");
  }
  const reference = readEconomyRun(positionals[1]);
  const candidate = readEconomyRun(positionals[2]);
  const result = warpTools.compareSummaries(reference.summary, candidate.summary);
  console.log(`reference ${reference.runID} (${reference.summary.mode}), candidate ${candidate.runID} (${candidate.summary.mode})`);
  for (const row of result.rows) {
    console.log(`${row.ok ? "ok  " : "FAIL"} ${row.name.padEnd(24)} ${String(row.a).padStart(12)} ${String(row.b).padStart(12)}` +
      `  diff ${row.difference >= 0 ? "+" : ""}${Math.round(row.difference * 100) / 100} (allowed ${Math.round(row.allowed * 100) / 100})`);
  }
  console.log(result.ok ? "agree within tolerances" : "DISAGREE");
  if (!result.ok) process.exitCode = 1;
}

function solarSystemTable() {
  if (!solarSystems) {
    const table = readJSON(SOLAR_SYSTEMS_PATH);
    if (!table || !Array.isArray(table.solarSystems)) {
      throw new CliError(`no static solar system table at ${relativePath(SOLAR_SYSTEMS_PATH)}`);
    }
    solarSystems = new Map(table.solarSystems.map((row) => [row.solarSystemID, row]));
  }
  return solarSystems;
}

function resolveSystemID(text) {
  const numeric = Math.trunc(Number(text) || 0);
  if (numeric > 0) return numeric;
  const wanted = String(text || "").trim().toLowerCase();
  for (const row of solarSystemTable().values()) {
    if (String(row.solarSystemName).toLowerCase() === wanted) return row.solarSystemID;
  }
  throw new CliError(`no solar system named ${text}`);
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

async function cmdScouts(flags) {
  const reply = await luMonitor("GET", "/fleets?all=1");
  const systems = solarSystemTable();
  const place = (id) => {
    const row = systems.get(id);
    return row ? `${row.solarSystemName} (${Number(row.security).toFixed(2)})` : String(id || "-");
  };
  const scouts = selectScouts(Array.isArray(reply.fleets) ? reply.fleets : [], { all: Boolean(flags.all) });
  for (const flight of scouts) {
    const hull = (flight.members || []).map((member) => member.hull).filter(Boolean).join("/");
    console.log(
      `${flight.flightID}  ${flight.homeCorporationName || "?"} ${hull}  ${flight.phase}  ` +
      `in ${place(flight.currentSystemID)}  system ${flight.currentSystemID}` +
      `${flight.materialized ? "  materialized" : ""}`,
    );
  }
  console.log(`${scouts.length} scout(s)${flags.all ? "" : " holding (--all for every scout)"}`);
}

async function cmdTeleport(positionals, flags) {
  const state = requireLogin(readState());
  if (!positionals[0]) throw new CliError("usage: e2e teleport <system name|ID> [--flight <flightID>]");
  const systemID = resolveSystemID(positionals.join(" "));
  const before = await currentSystemID(state);
  const reply = await luMonitor("POST", "/teleport", {
    characterID: state.characterID,
    systemID,
    flightID: flags.flight ? String(flags.flight) : undefined,
  });
  const text = `${reply.command} -> ${reply.success ? "ok" : "refused"}\n${reply.message || ""}`.trim();
  console.log(text);
  if (!reply.success) process.exitCode = 2;
  else await bindRemotePark(state, { unlessIn: before });
  return { ok: Boolean(reply.success), text };
}

// Prints the flight or hunt ID first, so the watch output can be grepped for it.
async function cmdTrigger(positionals, flags) {
  const state = requireLogin(readState());
  const name = positionals[0];
  let body;
  try {
    body = triggerTools.triggerRequest(name, positionals.slice(1), flags, { characterID: state.characterID, resolveSystemID });
  } catch (error) {
    throw error instanceof CliError ? error : new CliError(error.message);
  }
  if (name === "skirmish") {
    const reply = { trigger: "skirmish", ...(await luMonitor("POST", "/allianceskirmish", body)) };
    if (reply.success === false) throw new CliError(`trigger skirmish: ${reply.message || "refused"}`);
    console.log(flags.json ? JSON.stringify(reply, null, 2) : triggerTools.formatTriggerReply(reply));
    return reply;
  }
  const before = await currentSystemID(state);
  const handshake = requireHandshake();
  const { status, json } = await requestJSON(`http://${handshake.host}:${handshake.port}/trigger/${name}`, {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${handshake.token}` },
    timeoutMs: 90_000,
  });
  if (status >= 400 || json.ok === false) {
    const refusals = json.refusals && Object.keys(json.refusals).length
      ? `\n  refused: ${Object.entries(json.refusals).map(([reason, count]) => `${reason} x${count}`).join(", ")}` : "";
    const facts = json.facts ? `\n  facts: ${Object.entries(json.facts).map(([key, value]) => `${key}=${value}`).join(" ")}` : "";
    throw new CliError(`trigger ${name}: ${json.error || `HTTP ${status}`}${refusals}${facts}`);
  }
  console.log(flags.json ? JSON.stringify(json, null, 2) : triggerTools.formatTriggerReply(json));
  if (json.moved && json.moved.success) await bindRemotePark(state, { unlessIn: before });
  return json;
}

// ---------- player actions ----------

let itemTypes = null;
// typeID -> { name, groupName } from the static item table, read on first use.
function typeInfo(typeID) {
  if (!itemTypes) {
    const file = path.join(REPO_ROOT, "_local", "gameStore", "data", "itemTypes", "data.json");
    const table = readJSON(file);
    itemTypes = new Map((table && Array.isArray(table.types) ? table.types : [])
      .map((row) => [row.typeID, { name: row.name || null, groupName: row.groupName || null }]));
  }
  return itemTypes.get(Number(typeID)) || null;
}

// Every call goes through the gateway on the held session, as a client's
// would; the grid read comes from the bridge, with LU flights joined.
function actionIO(state, bindings = {}) {
  const session = { userid: state.accountID };
  return {
    bindings,
    call: async (service, method, args, kwargs) => (await gateway("POST", "/call", {
      service, method, args, kwargs: kwargs || undefined, confirm: true, session, bridgeSessionID: state.bridgeSessionID,
    })).result,
    grid: async () => (await bridge("GET", `/grid?characterID=${state.characterID}&lu=1`)).grid,
    listShip: async (shipID) => {
      const bound = await gateway("POST", "/bound/bind", {
        service: "invbroker", method: "GetInventoryFromId", args: [shipID], confirm: true, session,
        bridgeSessionID: state.bridgeSessionID,
      });
      const listed = await gateway("POST", "/bound/call", {
        service: "invbroker", method: "ListByFlags", args: [actionTools.LIST_FLAGS], confirm: true, session,
        bridgeSessionID: state.bridgeSessionID, boundHandle: bound.boundHandle,
      });
      return actionTools.shipItems(listed.result, typeInfo);
    },
  };
}

async function performAction(action, bindings = {}) {
  const state = requireLogin(readState());
  await keepAlive(state);
  let outcome;
  try {
    outcome = await actionTools.runAction(action, actionIO(state, bindings));
  } catch (error) {
    throw error instanceof CliError ? error : new CliError(`${action.type}: ${error.message}`);
  }
  const text = `${actionTools.describeAction(action)} -> ${outcome.ok ? "ok" : "refused"}\n${outcome.text}`;
  console.log(text);
  return { ok: outcome.ok, text: outcome.text, ids: outcome.ids };
}

async function cmdAct(positionals, flags) {
  let action;
  try {
    action = actionTools.actionFromArgs(positionals[0], positionals.slice(1), flags);
  } catch (error) {
    throw new CliError(error.message);
  }
  const outcome = await performAction(action);
  if (!outcome.ok) process.exitCode = 2;
  return outcome;
}

// ---------- viewer ----------

function viewerURL(port, token, runID) {
  return `http://127.0.0.1:${port}/viewer#token=${token}${runID ? `&run=${encodeURIComponent(runID)}` : ""}`;
}

// The bridge serves the viewer while this tree's server is up. Without one
// (a finished run, the server down) the CLI serves the same page itself, on
// loopback with its own token, until Ctrl-C.
async function cmdView(positionals, flags) {
  const runID = positionals[0] ? String(positionals[0]).replace(/[^A-Za-z0-9._-]/g, "_") : null;
  if (runID && !fs.existsSync(path.join(E2E_DIR, "runs", runID, "timeline.jsonl"))) {
    throw new CliError(`no timeline for run ${runID} in ${relativePath(path.join(E2E_DIR, "runs"))}`);
  }
  const handshake = flags.serve ? null : readHandshake();
  if (handshake && await httpOK(`http://${handshake.host}:${handshake.port}/viewer`)) {
    const url = viewerURL(handshake.port, handshake.token, runID);
    console.log(`viewer (served by this tree's agent bridge, pid ${handshake.pid}):\n${url}`);
    return url;
  }
  const { createAgentBridgeHttp } = require("../bridge/http");
  const { createAgentBridgeViewer } = require("../bridge/viewer");
  const viewer = createAgentBridgeViewer({ runsDir: path.join(E2E_DIR, "runs") });
  const port = flags.port === undefined ? 0 : Math.trunc(Number(flags.port));
  if (!(port >= 0 && port < 65536)) throw new CliError("--port takes a port number");
  const server = createAgentBridgeHttp({
    routes: {
      handlePublic: viewer.handlePublic,
      handle: (method, route, query) => (route.startsWith("/viewer/") ? viewer.handle(method, route, query)
        : { statusCode: 404, body: { ok: false, error: "this viewer serves runs only; `e2e up` for live calls" } }),
    },
    port,
    handshakePath: path.join(E2E_DIR, "viewer.json"),
    serviceName: "e2e-viewer",
  });
  const boundPort = await server.start();
  console.log(`viewer (served by this CLI${flags.serve ? "" : "; no server of this tree serves one"}). Ctrl-C stops it:\n` +
    `${viewerURL(boundPort, server.token, runID)}`);
  await new Promise((resolve) => process.once("SIGINT", resolve));
  await server.stop();
  return null;
}

// ---------- scenarios ----------

function savedWorldExists(name) {
  try {
    return fs.existsSync(path.join(worlds.savedWorldDir(REPO_ROOT, name), "gamestore.sqlite"));
  } catch (_error) {
    return false;
  }
}

function loadScenarioOrFail(name) {
  try {
    return scenarioTools.loadScenario(name, { worldExists: savedWorldExists, resolveSystemID });
  } catch (error) {
    throw new CliError(error.message);
  }
}

// The steps the CLI runs for a scenario. wait and waitFor are the runner's own.
async function runScenarioStep(step, bindings = {}) {
  if (step.action) return performAction(step.action, bindings);
  switch (step.type) {
    case "login": return { ok: true, text: await cmdLogin({ user: step.user, name: step.name }) };
    case "undock": return { ok: true, text: await cmdUndock() };
    case "dock": return runSlash("/dock");
    case "slash": return runSlash(step.command);
    case "teleport": return cmdTeleport([String(step.systemID)], { flight: step.flight });
    case "trigger": {
      const reply = await cmdTrigger([step.name, ...step.positionals], step.flags);
      return { ok: true, text: triggerTools.formatTriggerReply(reply), ids: scenarioTools.triggerIDs(reply) };
    }
    default: throw new CliError(`no such step: ${step.type}`);
  }
}

function printScenario(file, scenario) {
  const up = scenario.up;
  console.log(`${relativePath(file)}: ok`);
  console.log(`  world  ${scenario.world}${up.realClock ? " --real-clock" : ""}${up.market ? "" : " --no-market"}` +
    `${up.offgridTravel ? ` --offgrid-travel ${up.offgridTravel}` : ""}` +
    `${up.offgridActivity ? ` --offgrid-activity ${up.offgridActivity}` : ""}`);
  for (const step of scenario.setup) console.log(`  step   ${scenarioTools.describeStep(step)}`);
  for (const step of scenario.during) console.log(`  during ${scenarioTools.describeStep(step)}`);
  console.log(`  watch  every ${scenario.watch.every}s, off grid every ${scenario.watch.offgridEvery}s, ` +
    `client ${scenario.watch.client}${scenario.watch.log ? "" : ", no log"}`);
  for (const condition of scenario.until.any) console.log(`  until  ${condition.text}`);
  if (scenario.until.any.length) {
    console.log(`  until  matched ${scenario.until.from === "start" ? "from the watch's start, setup included" : "after setup ends"}`);
  }
  console.log(`  until  timeout ${scenario.until.timeout}s after setup` +
    `${scenario.until.grace ? `, then ${scenario.until.grace}s more` : ""}`);
  for (const entry of scenario.expect) console.log(`  expect ${entry.text}${entry.note ? `  (${entry.note})` : ""}`);
}

// up, setup, watch until a stop condition, down; then report.md and
// result.json beside the watch's timeline.jsonl. Exit 1 when an expectation
// is missing, 2 when the run could not finish.
// The code a run ran on, for citing it: HEAD, and whether the tree had
// changes on top (untracked files count; _local/ is ignored).
function gitCommit() {
  const git = (args) => spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  const head = git(["rev-parse", "--short=12", "HEAD"]);
  if (head.error || head.status !== 0) return null;
  const status = git(["status", "--porcelain"]);
  return { sha: head.stdout.trim(), dirty: Boolean(status.status === 0 && status.stdout.trim()) };
}

async function cmdRun(positionals, flags) {
  if (!positionals[0]) {
    const rows = scenarioTools.listScenarios();
    for (const row of rows) console.log(`${row.name.padEnd(28)} ${String(row.world || "?").padEnd(16)} ${row.description}`);
    if (!rows.length) console.log(`no scenarios in ${relativePath(scenarioTools.SCENARIO_DIR)}`);
    console.log("usage: e2e run <scenario> [--check] [--run <id>] [--keep-up]");
    return;
  }
  const { file, scenario } = loadScenarioOrFail(positionals.join(" "));
  if (flags.check) {
    printScenario(file, scenario);
    return;
  }
  const running = readHandshake();
  if (running) {
    throw new CliError(`this tree's server is running (pid ${running.pid}); a run boots its own world. \`e2e down\` first.`);
  }
  const runID = flags.run ? String(flags.run).replace(/[^A-Za-z0-9._-]/g, "_") : `${runStamp(Date.now())}-${scenario.name}`;
  const runDir = path.join(E2E_DIR, "runs", runID);
  if (fs.existsSync(runDir)) throw new CliError(`run ${runID} already exists (${relativePath(runDir)}); pass another --run`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(file, path.join(runDir, "scenario.json"));
  const commit = gitCommit();
  console.log(`run ${runID}: ${scenario.name} from world ${scenario.world}` +
    `${commit ? ` on ${commit.sha}${commit.dirty ? " plus uncommitted changes" : ""}` : ""}; report in ${relativePath(runDir)}`);

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.on("SIGINT", onInterrupt);
  const ops = {
    up: () => cmdUp({
      world: scenario.world,
      "real-clock": scenario.up.realClock || undefined,
      "no-market": scenario.up.market ? undefined : true,
      timeout: scenario.up.timeout || undefined,
      "offgrid-travel": scenario.up.offgridTravel || undefined,
      "offgrid-activity": scenario.up.offgridActivity || undefined,
    }),
    step: runScenarioStep,
    startWatch: (onEvent) => openWatch(requireLogin(readState()), requireHandshake(), {
      // The bridge's longest watch; the run stops it at its own stop condition.
      forSeconds: 3600,
      everySeconds: scenario.watch.every,
      offGridEverySeconds: scenario.watch.offgridEvery,
      client: scenario.watch.client,
      divergeMeters: scenario.watch.divergeMeters || undefined,
      positions: true,
      log: scenario.watch.log,
      grep: scenario.watch.grep === null ? undefined : scenario.watch.grep,
      runDir,
      print: (line) => console.log(formatTimelineEvent(line)),
      onEvent,
    }),
    down: async () => {
      if (flags["keep-up"]) console.log("--keep-up: the server stays up; `e2e down` stops it");
      else await cmdDown({});
    },
  };
  let result;
  try {
    result = await scenarioTools.runScenario(scenario, ops, {
      signal: controller.signal,
      log: (line) => console.log(`run: ${line}`),
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
  const reportPath = path.join(runDir, "report.md");
  const scenarioFile = relativePath(file);
  let frames = null;
  try {
    frames = frameTools.writeFrames(runDir, frameTools.readTimeline(path.join(runDir, "timeline.jsonl")));
    console.log(`run: ${frames.frames.length} tactical frame(s) from ${frames.positions} position samples`);
  } catch (error) {
    console.log(`run: tactical frames failed: ${error.message}`);
  }
  fs.writeFileSync(reportPath, scenarioTools.renderReport(result, { runID, scenario, scenarioFile, commit,
    framesSection: frameTools.renderFramesSection(frames) }));
  const record = scenarioTools.resultRecord(result, { runID, scenarioFile });
  record.commit = commit;
  record.frames = frames ? frames.frames.map(({ file: frameFile, reason, stop, t, seq }) => ({ file: frameFile, reason, stop, t, seq })) : [];
  fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`);
  for (const row of result.expectations) {
    const status = row.absent ? (row.met ? "clean  " : "SEEN   ") : (row.met ? "met    " : "MISSING");
    console.log(`${status} ${row.text}${row.first ? `  first at ${formatTimelineEvent(row.first).slice(0, 11)}` : ""}`);
  }
  if (result.failure) console.log(`${result.failure.stage} failed${result.failure.step ? ` at ${result.failure.step}` : ""}: ${result.failure.error}`);
  const met = result.expectations.filter((row) => row.met).length;
  console.log(`${result.failure ? "did not complete" : result.missing ? "FAILED" : "passed"}: ` +
    `${met} of ${result.expectations.length} expectations met; report ${relativePath(reportPath)}`);
  process.exitCode = scenarioTools.exitCodeFor(result);
}

async function cmdLogout() {
  const state = readState();
  if (!state.bridgeSessionID) {
    console.log("not logged in");
    return;
  }
  try {
    await gateway("POST", "/session/release", {
      bridgeSessionID: state.bridgeSessionID,
      session: { userid: state.accountID },
    });
    console.log(`released ${state.characterName || state.characterID}`);
  } finally {
    writeState({ ...state, bridgeSessionID: null });
  }
}

// Reads the tail of the shared server log. Every process that boots this tree
// writes to it, tests included, so lines are kept to the running server's pid
// unless --any-pid.
function selectLogLines(text, { grep, pid, lines }) {
  const pattern = grep ? new RegExp(grep, "i") : null;
  const pidTag = pid ? `[pid ${pid}]` : null;
  const kept = text.split(/\r?\n/).filter((line) =>
    line && (!pidTag || line.includes(pidTag)) && (!pattern || pattern.test(line)));
  return kept.slice(-lines);
}

function cmdLog(flags) {
  if (!fs.existsSync(SERVER_LOG_PATH)) throw new CliError(`no server log at ${SERVER_LOG_PATH}`);
  const lines = Math.max(1, Math.trunc(Number(flags.lines) || 40));
  const handshake = readHandshake();
  const pid = flags["any-pid"] ? null : handshake && handshake.pid;
  const size = fs.statSync(SERVER_LOG_PATH).size;
  const readBytes = Math.min(size, 16 * 1024 * 1024);
  const buffer = Buffer.alloc(readBytes);
  const fd = fs.openSync(SERVER_LOG_PATH, "r");
  try {
    fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
  } finally {
    fs.closeSync(fd);
  }
  for (const line of selectLogLines(buffer.toString("utf8"), { grep: flags.grep, pid, lines })) {
    console.log(line);
  }
}

async function gatewayReady(ports = activePorts()) {
  try {
    const { status, json } = await requestJSON(`${gatewayBase(ports)}/health`, { headers: gatewayHeaders(), timeoutMs: 3000 });
    return status === 200 && Boolean(json.runtime && json.runtime.ready);
  } catch (_error) {
    return false;
  }
}

async function httpOK(url) {
  try {
    const { status } = await requestJSON(url, { timeoutMs: 3000 });
    return status === 200;
  } catch (_error) {
    return false;
  }
}

function bridgeReady(handshake) {
  return httpOK(`http://${handshake.host}:${handshake.port}/health`);
}

// The game port opens in the last boot stage, after the gateway and bridges,
// so it is the signal that boot has finished.
function tcpOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopPid(pid) {
  try {
    process.kill(pid);
  } catch (_error) {
    // Already gone.
  }
}

async function waitForExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await sleep(500);
  }
  return !pidAlive(pid);
}

function serverStartArgs() {
  const pkg = readJSON(path.join(REPO_ROOT, "server", "package.json"));
  const script = pkg && pkg.scripts && pkg.scripts.start;
  const tokens = String(script || "node .").split(/\s+/).filter(Boolean);
  if (tokens[0] !== "node") throw new CliError(`server start script is not a node command: ${script}`);
  return tokens.slice(1);
}

function describeLeases(leases) {
  return leases.map((lease) => {
    const seconds = Math.max(0, Math.ceil((lease.expiresAtMs - Date.now()) / 1000));
    const holder = lease.pid ? `pid ${lease.pid}${pidAlive(lease.pid) ? "" : " (exited)"}` : lease.instanceID;
    return `${lease.role} lease held by ${holder}, ${seconds}s left`;
  }).join("; ");
}

// Nothing may replace or boot a world another process is running: this
// tree's server started some other way, or any server pointed at this store.
// A lease left by a process that has exited only delays boot, because the
// server waits out a lease before taking the world.
function requireWorldIdle() {
  const handshake = readHandshake();
  if (handshake) throw new CliError(`this tree's server is running (pid ${handshake.pid}); \`e2e down\` first`);
  const leases = worlds.liveLeases(WORLD_PATH);
  const held = leases.filter((lease) => !lease.pid || pidAlive(lease.pid));
  if (held.length) {
    throw new CliError(`another process is running this tree's world: ${describeLeases(held)}. Stop it first.`);
  }
  if (leases.length) console.log(`note: ${describeLeases(leases)}; boot waits for it to run out`);
}

function marketHealthURL(ports) {
  return `http://127.0.0.1:${ports.marketHttp}/health`;
}

// cargo decides whether the daemon is stale; a build with nothing to do takes
// about a second. The target folder is pinned to this tree's.
function buildMarket() {
  const env = { ...process.env, CARGO_TARGET_DIR: path.join(MARKET_DIR, "target") };
  const probe = spawnSync("cargo", ["--version"], { env, stdio: "ignore", windowsHide: true });
  if (probe.error || probe.status !== 0) {
    if (fs.existsSync(MARKET_EXE)) {
      console.log("cargo not found; starting the market daemon already built, which may be stale");
      return;
    }
    throw new CliError(`no market daemon at ${relativePath(MARKET_EXE)} and no cargo to build it. Install Rust, or pass --no-market.`);
  }
  if (!fs.existsSync(MARKET_EXE)) console.log("building the market daemon; a first build takes a few minutes");
  const out = fs.openSync(MARKET_BUILD_PATH, "w");
  let result;
  try {
    result = spawnSync("cargo", ["build", "--release"], { cwd: MARKET_DIR, env, stdio: ["ignore", out, out], windowsHide: true });
  } finally {
    fs.closeSync(out);
  }
  if (result.error || result.status !== 0) {
    throw new CliError(`market daemon build failed (${relativePath(MARKET_BUILD_PATH)}).\n${tailFile(MARKET_BUILD_PATH, 40)}`);
  }
}

// The daemon reads its ports only from TOML, so each run gets a generated
// copy of the tracked config with this tree's ports and database.
async function startMarket(ports, timeoutMs) {
  if (!fs.existsSync(WORLD.market)) {
    throw new CliError(
      `this tree has no market database (${relativePath(WORLD.market)}). ` +
      "`e2e world copy --from ../dev --force` copies one with the world, or pass --no-market.",
    );
  }
  buildMarket();
  fs.writeFileSync(MARKET_CONFIG_PATH, marketConfig(fs.readFileSync(MARKET_TRACKED_CONFIG, "utf8"), ports, WORLD.market));
  const out = fs.openSync(MARKET_OUT_PATH, "w");
  const child = spawn(MARKET_EXE, ["--config", MARKET_CONFIG_PATH, "serve"], {
    cwd: MARKET_DIR,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidAlive(child.pid)) throw new CliError(`market daemon exited during start.\n${tailFile(MARKET_OUT_PATH, 40)}`);
    if (await httpOK(marketHealthURL(ports))) return { pid: child.pid, seconds: (Date.now() - startedAt) / 1000 };
    await sleep(500);
  }
  stopPid(child.pid);
  throw new CliError(`market daemon not ready after ${timeoutMs / 1000}s.\n${tailFile(MARKET_OUT_PATH, 40)}`);
}

function describePorts(ports) {
  return `slot ${ports.slot}: game :${ports.game}, gateway :${ports.gateway}, agent bridge :${ports.agentBridge}, ` +
    `LU bridge :${ports.luMonitor}, market :${ports.marketHttp} (rpc :${ports.marketRpc}), image :${ports.image}, ` +
    `redshift :${ports.redshift}, xmpp :${ports.xmpp}`;
}

async function cmdUp(flags) {
  const running = readHandshake();
  if (running && await bridgeReady(running)) {
    console.log(`already up: pid ${running.pid}, ${describePorts(activePorts())}`);
    return;
  }
  if (flags.world && flags.fresh) throw new CliError("--world and --fresh both choose the world; pass one");
  if (flags["real-clock"] && !flags.world) throw new CliError("--real-clock applies to a restored world: pass --world <name>");
  let multipliers;
  try {
    multipliers = triggerTools.offGridMultipliers(flags);
  } catch (error) {
    throw new CliError(error.message);
  }

  const previous = readRun();
  if (previous && previous.marketPid && !pidAlive(previous.pid) && pidAlive(previous.marketPid) &&
    await httpOK(marketHealthURL(previous.ports))) {
    stopPid(previous.marketPid);
    await waitForExit(previous.marketPid, 10_000);
    console.log(`stopped market daemon pid ${previous.marketPid}, left by a server that exited`);
  }

  requireWorldIdle();
  const ports = TREE_PORTS;
  const busy = await busyPorts(ports);
  if (busy.length) {
    throw new CliError(
      `port(s) in use: ${busy.map((row) => `${row.name} :${row.port}`).join(", ")}. ` +
      `Another process holds this tree's block (slot ${ports.slot}); stop it, or run up with ` +
      "EVEJS_E2E_PORT_SLOT=<0-799> to choose another block.",
    );
  }

  try {
    if (flags.world) {
      const restored = worlds.restoreWorld(REPO_ROOT, String(flags.world), { realClock: Boolean(flags["real-clock"]) });
      console.log(`restored saved world ${restored.name}${restored.market ? " with its market" : "; market kept"}` +
        (flags["real-clock"] ? "; clock at real time (offset 0), deadlines as overdue as the copy is old" : ""));
    } else if (flags.fresh) {
      worlds.freshWorld(REPO_ROOT);
      console.log("removed this tree's game store; this boot seeds a fresh one from the reference data");
    }
  } catch (error) {
    throw error instanceof CliError ? error : new CliError(error.message);
  }
  if (!fs.existsSync(MANIFEST_PATH) || (!flags.fresh && !fs.existsSync(WORLD_PATH))) {
    throw new CliError(
      `this tree has no world (${relativePath(WORLD_PATH)} and manifest.json). ` +
      "Copy one with `e2e world copy --from ../dev`. e2e up will not create one: setup would " +
      "regenerate the static data through a linked data directory. " +
      "See docs/E2E-GRID-TESTING.md#a-world-to-run.",
    );
  }

  fs.mkdirSync(E2E_DIR, { recursive: true });
  fs.mkdirSync(path.join(REPO_ROOT, "server", "logs", "node-reports"), { recursive: true });
  const state = readState();
  if (state.bridgeSessionID) writeState({ ...state, bridgeSessionID: null });

  const market = flags["no-market"] ? null : await startMarket(ports, 120_000);
  if (market) console.log(`market daemon pid ${market.pid} ready in ${market.seconds.toFixed(1)}s`);

  const out = fs.openSync(SERVER_OUT_PATH, "w");
  const child = spawn(process.execPath, serverStartArgs(), {
    cwd: path.join(REPO_ROOT, "server"),
    env: { ...process.env, ...serverEnvironment(ports), ...multipliers.env, EVEJS_AGENT_BRIDGE: "1" },
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  const startedAtMs = Date.now();
  const run = {
    pid: child.pid,
    marketPid: market ? market.pid : null,
    ports,
    world: flags.world ? `saved ${flags.world}` : flags.fresh ? "fresh" : "kept",
    offGrid: multipliers.values,
    startedAtMs,
    readyAtMs: null,
    bootSeconds: null,
  };
  writeRun(run);
  console.log(`starting server pid ${child.pid}; console in ${relativePath(SERVER_OUT_PATH)}`);

  const timeoutMs = Math.max(10, Number(flags.timeout) || 600) * 1000;
  while (Date.now() - startedAtMs < timeoutMs) {
    if (!pidAlive(child.pid)) {
      if (market) stopPid(market.pid);
      const leases = worlds.liveLeases(WORLD_PATH)
        .filter((lease) => lease.pid !== child.pid && (!lease.pid || pidAlive(lease.pid)));
      throw new CliError(
        `server exited during boot${leases.length ? `; ${describeLeases(leases)}` : ""}.\n` +
        tailFile(SERVER_OUT_PATH, 40),
      );
    }
    const handshake = readHandshake();
    if (handshake && handshake.pid === child.pid && await bridgeReady(handshake) &&
      await gatewayReady(ports) && await tcpOpen(ports.game)) {
      run.readyAtMs = Date.now();
      run.bootSeconds = Number(((run.readyAtMs - startedAtMs) / 1000).toFixed(1));
      writeRun(run);
      console.log(`up in ${run.bootSeconds}s: pid ${child.pid}, world ${run.world}, ${describePorts(ports)}`);
      if (multipliers.text) console.log(`off-grid time: ${multipliers.text} (smoke tests only: the ratios between timers change)`);
      return;
    }
    await sleep(2000);
  }
  throw new CliError(
    `server not ready after ${timeoutMs / 1000}s; pid ${child.pid} is still running (\`e2e down\` stops it).\n` +
    tailFile(SERVER_OUT_PATH, 40),
  );
}

function tailFile(file, count) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-count).join("\n");
  } catch (_error) {
    return "(no console output)";
  }
}

async function cmdDown(flags) {
  const run = readRun() || {};
  const handshake = readHandshake();
  const serverPid = handshake ? handshake.pid : pidAlive(run.pid) ? run.pid : null;
  if (serverPid) {
    const timeoutMs = Math.max(5, Number(flags.timeout) || 120) * 1000;
    const startedAt = Date.now();
    if (handshake) {
      await bridge("POST", "/shutdown", {});
      console.log(`stopping pid ${serverPid}`);
    } else if (flags.force) {
      stopPid(serverPid);
      console.log(`killed pid ${serverPid}; its world lease stays live for up to 30s`);
    } else {
      throw new CliError(`server pid ${serverPid} has no agent bridge yet (still booting?). Wait, or \`e2e down --force\` to kill it.`);
    }
    if (!await waitForExit(serverPid, timeoutMs)) throw new CliError(`pid ${serverPid} still running after ${timeoutMs / 1000}s`);
    const state = readState();
    if (state.bridgeSessionID) writeState({ ...state, bridgeSessionID: null });
    console.log(`stopped in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } else {
    console.log("no server from this tree is running");
  }
  // Only a daemon still answering on the run's port is ours; a bare pid may
  // have been reused since.
  if (run.marketPid && pidAlive(run.marketPid) && run.ports && await httpOK(marketHealthURL(run.ports))) {
    stopPid(run.marketPid);
    await waitForExit(run.marketPid, 10_000);
    console.log(`stopped market daemon pid ${run.marketPid}`);
  }
  if (run.pid && !run.stoppedAtMs) writeRun({ ...run, stoppedAtMs: Date.now() });
}

const WORLD_USAGE = "usage: e2e world copy --from <tree> [--force] | world save <name> [--note text] [--force] | world list";

function cmdWorld(positionals, flags) {
  const action = positionals[0];
  const megabytes = (bytes) => Math.round(bytes / 1e6);
  try {
    if (action === "copy" && flags.from) {
      requireWorldIdle();
      const result = worlds.copyWorld(REPO_ROOT, String(flags.from), { force: Boolean(flags.force) });
      console.log(
        `copied ${result.source} -> ${relativePath(WORLD_PATH)} (${megabytes(result.bytes)} MB, ` +
        `${result.cleared} owner lease row(s) cleared), manifest.json` +
        (result.market ? " and the market database" : "; the source has no market database"),
      );
    } else if (action === "save" && positionals[1]) {
      requireWorldIdle();
      const result = worlds.saveWorld(REPO_ROOT, positionals[1], { force: Boolean(flags.force), note: flags.note });
      console.log(
        `saved ${result.name} (${megabytes(result.bytes)} MB${result.market ? ", market included" : ", no market database"}) ` +
        `in ${relativePath(result.dir)}`,
      );
    } else if (action === "list") {
      const rows = worlds.listWorlds(REPO_ROOT);
      for (const row of rows) {
        console.log(
          `${row.name.padEnd(24)} ${row.savedAt || "?"}  ${megabytes(row.bytes)} MB` +
          `${row.market ? "  +market" : ""}${row.note ? `  ${row.note}` : ""}`,
        );
      }
      if (!rows.length) console.log("no saved worlds (e2e world save <name>)");
    } else {
      throw new CliError(WORLD_USAGE);
    }
  } catch (error) {
    throw error instanceof CliError ? error : new CliError(error.message);
  }
}

async function cmdStatus() {
  const run = readRun();
  const handshake = readHandshake();
  const state = readState();
  const ports = activePorts();
  const [gatewayUp, marketUp] = await Promise.all([gatewayReady(ports), httpOK(marketHealthURL(ports))]);
  console.log(`ports  ${describePorts(ports)}`);
  if (run && pidAlive(run.pid)) {
    console.log(run.readyAtMs
      ? `server pid ${run.pid}  booted in ${run.bootSeconds}s, up ${formatClock(Date.now() - run.readyAtMs)}  world ${run.world}`
      : `server pid ${run.pid}  booting for ${formatClock(Date.now() - run.startedAtMs)}  world ${run.world}`);
  } else {
    console.log("server  none from e2e up");
  }
  console.log(`gateway  ${gatewayUp ? "ready" : "down"}`);
  console.log(handshake
    ? `agent bridge :${handshake.port}  pid ${handshake.pid}  started ${new Date(handshake.startedAtMs).toISOString()}`
    : "agent bridge  none from this tree");
  console.log(run && run.marketPid && pidAlive(run.marketPid)
    ? `market pid ${run.marketPid}  ${marketUp ? "ready" : "not answering"}`
    : `market  ${marketUp ? "answering, not started by e2e up" : "down"}`);
  console.log(state.characterID
    ? `character ${state.characterName || "?"} (${state.characterID})  account ${state.username}/${state.accountID}` +
      `  session ${state.bridgeSessionID ? "held" : "released"}`
    : "character  none (e2e login)");
}

const HELP = fs.readFileSync(__filename, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("//   node tools/evejs-e2e"))
  .map((line) => line.slice(5))
  .join("\n");

async function main(argv) {
  const { command, positionals, flags } = parseArgs(argv);
  switch (command) {
    case "up": return cmdUp(flags);
    case "down": return cmdDown(flags);
    case "status": return cmdStatus();
    case "ports":
      console.log(describePorts(activePorts()));
      return undefined;
    case "login": return cmdLogin(flags);
    case "logout": return cmdLogout();
    case "undock": return cmdUndock();
    case "dock": return runSlash("/dock");
    case "slash": {
      const line = positionals.join(" ").trim();
      if (!line) throw new CliError('slash needs a command, e.g. e2e slash "/where"');
      return runSlash(line);
    }
    case "grid": return cmdGrid(flags);
    case "watch": return cmdWatch(flags);
    case "act": return cmdAct(positionals, flags);
    case "view": return cmdView(positionals, flags);
    case "scouts": return cmdScouts(flags);
    case "teleport": return cmdTeleport(positionals, flags);
    case "trigger": return cmdTrigger(positionals, flags);
    case "run": return cmdRun(positionals, flags);
    case "log": return cmdLog(flags);
    case "world": return cmdWorld(positionals, flags);
    case "clock": return cmdClock(flags);
    case "warp": return cmdWarp(flags);
    case "economy": return cmdEconomy(positionals);
    case "help":
      console.log(HELP);
      return undefined;
    default:
      throw new CliError(`unknown command: ${command}\n${HELP}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`e2e: ${error instanceof CliError ? error.message : error.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CliError,
  parseArgs,
  selectLogLines,
  selectScouts,
};
