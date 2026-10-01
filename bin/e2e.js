#!/usr/bin/env node
"use strict";

// Headless observer for end-to-end grid checks: log a character in through
// the web gateway, undock it, run slash commands on its session and read its
// grid, with no EVE client. `e2e help` lists the commands, the plugins'
// included (core/plugins.js). Guide: docs/E2E-GRID-TESTING.md.

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { formatClock, formatGrid } = require("../core/format");
const { collectIDs, createReorderBuffer, formatTimelineEvent, mentionsAny, parseLogLine } = require("../core/timeline");
const { busyPorts, marketConfig, portsForTree, serverEnvironment, usableListeners } = require("../core/ports");
const { DEFAULT_TREE_ROOT, defaultRegistry } = require("../core/plugins");
const worlds = require("../core/worlds");
const scenarioTools = require("../core/scenario");
const frameTools = require("../core/frames");
const actionTools = require("../core/actions");
const vendor = require("../core/vendor");

const REPO_ROOT = DEFAULT_TREE_ROOT;
const REGISTRY = defaultRegistry();
const E2E_DIR = path.join(REPO_ROOT, "_local", "e2e");
const RUNS_DIR = path.join(E2E_DIR, "runs");
const STATE_PATH = path.join(E2E_DIR, "state.json");
const SERVER_OUT_PATH = path.join(E2E_DIR, "server.out.log");
const BRIDGE_HANDSHAKE_PATH = String(process.env.EVEJS_AGENT_BRIDGE_HANDSHAKE || "").trim() ||
  path.join(REPO_ROOT, "_local", "agentBridge", "bridge.json");
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
const LISTENERS = usableListeners(REGISTRY.listeners);
const TREE_PORTS = portsForTree(REPO_ROOT, process.env, LISTENERS);

const BOOLEAN_FLAGS = new Set(["all", "json", "any-pid", "force", "fresh", "no-market", "no-log", "help",
  "check", "keep-up", "positions", "once", "serve", ...REGISTRY.booleanFlags]);

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

// By default only NPC lines and the plugins' own tags (registry.logTags), and
// only those naming a flight or ball this watch has seen.
const DEFAULT_WATCH_LOG = `\\[(${["NpcController", ...REGISTRY.logTags].join("|")})\\]`;

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
          if (event.kind !== "POS") collectIDs(event, knownIDs, REGISTRY);
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
    runDir: path.join(RUNS_DIR, runID),
    print: (line) => console.log(flags.json ? JSON.stringify(line) : formatTimelineEvent(line, REGISTRY)),
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

// The first plugin handler of a core command whose flags this call passes, if any.
function pluginHandler(command, flags) {
  return (REGISTRY.handlers[command] || []).find((handler) => handler.flags.some((flag) => flags[flag] !== undefined)) || null;
}

// Stock /tr takes a system ID and lands on the system's first stargate.
// A plugin may take the command over for its own flags (registry.handlers).
async function cmdTeleport(positionals, flags) {
  if (!positionals[0]) throw new CliError("usage: e2e teleport <system name|ID>");
  const handler = pluginHandler("teleport", flags);
  if (handler) return handler.run(positionals, flags, pluginIO());
  const systemID = resolveSystemID(positionals.join(" "));
  return runSlash(`/tr me ${systemID}`);
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
// would; the grid read comes from the bridge, with the plugins' annotations.
function actionIO(state, bindings = {}) {
  const session = { userid: state.accountID };
  return {
    bindings,
    call: async (service, method, args, kwargs) => (await gateway("POST", "/call", {
      service, method, args, kwargs: kwargs || undefined, confirm: true, session, bridgeSessionID: state.bridgeSessionID,
    })).result,
    grid: async () => (await bridge("GET", `/grid?characterID=${state.characterID}&ext=1`)).grid,
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
  if (runID && !fs.existsSync(path.join(RUNS_DIR, runID, "timeline.jsonl"))) {
    throw new CliError(`no timeline for run ${runID} in ${relativePath(RUNS_DIR)}`);
  }
  const handshake = flags.serve ? null : readHandshake();
  if (handshake && await httpOK(`http://${handshake.host}:${handshake.port}/viewer`)) {
    const url = viewerURL(handshake.port, handshake.token, runID);
    console.log(`viewer (served by this tree's agent bridge, pid ${handshake.pid}):\n${url}`);
    return url;
  }
  const { createAgentBridgeHttp } = require("../bridge/http");
  const { createAgentBridgeViewer } = require("../bridge/viewer");
  const viewer = createAgentBridgeViewer({ runsDir: RUNS_DIR, registry: REGISTRY });
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

// ---------- plugins ----------

// What a plugin command, handler or step gets to work with.
function pluginIO() {
  return {
    CliError,
    treeRoot: REPO_ROOT,
    e2eDir: E2E_DIR,
    runsDir: RUNS_DIR,
    print: (line) => console.log(line),
    setExitCode: (code) => { process.exitCode = code; },
    readJSON,
    pidAlive,
    relativePath,
    runStamp,
    sleep,
    readState,
    requireLogin,
    readRun,
    readHandshake,
    requireHandshake,
    bridge,
    callBridge,
    requestJSON,
    gateway,
    currentSystemID,
    bindRemotePark,
    resolveSystemID,
    solarSystems: solarSystemTable,
    runSlash,
  };
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
    return scenarioTools.loadScenario(name, { worldExists: savedWorldExists, resolveSystemID, registry: REGISTRY });
  } catch (error) {
    throw new CliError(error.message);
  }
}

// The steps the CLI runs for a scenario. wait and waitFor are the runner's
// own; plugin steps run with the same io as plugin commands.
const STEP_RUNNERS = {
  login: async (step) => ({ ok: true, text: await cmdLogin({ user: step.user, name: step.name }) }),
  undock: async () => ({ ok: true, text: await cmdUndock() }),
  dock: () => runSlash("/dock"),
  slash: (step) => runSlash(step.command),
  teleport: (step) => cmdTeleport([String(step.systemID)], {}),
};

async function runScenarioStep(step, bindings = {}) {
  if (step.action) return performAction(step.action, bindings);
  if (STEP_RUNNERS[step.type]) return STEP_RUNNERS[step.type](step, bindings);
  const plugin = REGISTRY.steps[step.type];
  if (plugin) return plugin.run(step, pluginIO(), bindings);
  throw new CliError(`no such step: ${step.type}`);
}

// A scenario's `up` as the flags `e2e up` takes.
function upFlagsFor(up) {
  const flags = {
    "no-market": up.market ? undefined : true,
    timeout: up.timeout || undefined,
  };
  for (const flag of REGISTRY.upFlags) {
    const value = up[flag.key];
    if (value === undefined || value === null || value === false) continue;
    flags[flag.flag] = flag.type === "bool" ? true : value;
  }
  return flags;
}

function printScenario(file, scenario) {
  const up = upFlagsFor(scenario.up);
  const upText = Object.entries(up).filter(([key, value]) => key !== "timeout" && value !== undefined)
    .map(([key, value]) => (value === true ? ` --${key}` : ` --${key} ${value}`)).join("");
  console.log(`${relativePath(file)}: ok`);
  console.log(`  world  ${scenario.world}${upText}`);
  for (const step of scenario.setup) console.log(`  step   ${scenarioTools.describeStep(step, REGISTRY)}`);
  for (const step of scenario.during) console.log(`  during ${scenarioTools.describeStep(step, REGISTRY)}`);
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

// The code a run ran on, for citing it: HEAD, and whether the tree had
// changes on top (untracked files count; _local/ is ignored).
function gitCommit() {
  const git = (args) => spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  const head = git(["rev-parse", "--short=12", "HEAD"]);
  if (head.error || head.status !== 0) return null;
  const status = git(["status", "--porcelain"]);
  return { sha: head.stdout.trim(), dirty: Boolean(status.status === 0 && status.stdout.trim()) };
}

// up, setup, watch until a stop condition, down; then report.md and
// result.json beside the watch's timeline.jsonl. Exit 1 when an expectation
// is missing, 2 when the run could not finish.
async function cmdRun(positionals, flags) {
  if (!positionals[0]) {
    const rows = scenarioTools.listScenarios({ registry: REGISTRY });
    for (const row of rows) {
      console.log(`${row.name.padEnd(28)} ${String(row.world || "?").padEnd(16)} ${row.plugin ? `[${row.plugin}] ` : ""}${row.description}`);
    }
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
  const runDir = path.join(RUNS_DIR, runID);
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
    up: () => cmdUp({ world: scenario.world, ...upFlagsFor(scenario.up) }),
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
      print: (line) => console.log(formatTimelineEvent(line, REGISTRY)),
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
    frames = frameTools.writeFrames(runDir, frameTools.readTimeline(path.join(runDir, "timeline.jsonl")), { registry: REGISTRY });
    console.log(`run: ${frames.frames.length} tactical frame(s) from ${frames.positions} position samples`);
  } catch (error) {
    console.log(`run: tactical frames failed: ${error.message}`);
  }
  fs.writeFileSync(reportPath, scenarioTools.renderReport(result, { runID, scenario, scenarioFile, commit,
    framesSection: frameTools.renderFramesSection(frames), registry: REGISTRY }));
  const record = scenarioTools.resultRecord(result, { runID, scenarioFile });
  record.commit = commit;
  record.frames = frames ? frames.frames.map(({ file: frameFile, reason, stop, t, seq }) => ({ file: frameFile, reason, stop, t, seq })) : [];
  fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`);
  for (const row of result.expectations) {
    const status = row.absent ? (row.met ? "clean  " : "SEEN   ") : (row.met ? "met    " : "MISSING");
    console.log(`${status} ${row.text}${row.first ? `  first at ${formatTimelineEvent(row.first, REGISTRY).slice(0, 11)}` : ""}`);
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
  const plugins = LISTENERS.filter((listener) => ports[listener.name])
    .map((listener) => `${listener.label || listener.name} :${ports[listener.name]}, `).join("");
  return `slot ${ports.slot}: game :${ports.game}, gateway :${ports.gateway}, agent bridge :${ports.agentBridge}, ` +
    `${plugins}market :${ports.marketHttp} (rpc :${ports.marketRpc}), image :${ports.image}, ` +
    `redshift :${ports.redshift}, xmpp :${ports.xmpp}`;
}

// The plugins' `e2e up` options (registry.upFlags) read from the flags:
// { values: { key: value }, env, restore: { key: value } }. A number flag sets
// its environment variable for the server; a bool flag goes to the plugins'
// world restore.
function upOptions(flags) {
  const values = {};
  const env = {};
  const restore = {};
  for (const flag of REGISTRY.upFlags) {
    const raw = flags[flag.flag];
    if (raw === undefined) continue;
    if (flag.type === "bool") {
      if (flag.restore && !flags.world) throw new CliError(`--${flag.flag} applies to a restored world: pass --world <name>`);
      values[flag.key] = true;
      if (flag.restore) restore[flag.key] = true;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < flag.min || value > flag.max) {
      throw new CliError(`--${flag.flag} takes a number from ${flag.min} through ${flag.max}`);
    }
    values[flag.key] = value;
    if (flag.env) env[flag.env] = String(value);
  }
  return { values, env, restore };
}

async function cmdUp(flags) {
  const running = readHandshake();
  if (running && await bridgeReady(running)) {
    console.log(`already up: pid ${running.pid}, ${describePorts(activePorts())}`);
    return;
  }
  if (flags.world && flags.fresh) throw new CliError("--world and --fresh both choose the world; pass one");
  const options = upOptions(flags);

  const previous = readRun();
  if (previous && previous.marketPid && !pidAlive(previous.pid) && pidAlive(previous.marketPid) &&
    await httpOK(marketHealthURL(previous.ports))) {
    stopPid(previous.marketPid);
    await waitForExit(previous.marketPid, 10_000);
    console.log(`stopped market daemon pid ${previous.marketPid}, left by a server that exited`);
  }

  requireWorldIdle();
  const ports = TREE_PORTS;
  const busy = await busyPorts(ports, LISTENERS);
  if (busy.length) {
    throw new CliError(
      `port(s) in use: ${busy.map((row) => `${row.name} :${row.port}`).join(", ")}. ` +
      `Another process holds this tree's block (slot ${ports.slot}); stop it, or run up with ` +
      "EVEJS_E2E_PORT_SLOT=<0-799> to choose another block.",
    );
  }

  try {
    if (flags.world) {
      const restored = worlds.restoreWorld(REPO_ROOT, String(flags.world), { hooks: REGISTRY.worldHooks, options: options.restore });
      console.log(`restored saved world ${restored.name}${restored.market ? " with its market" : "; market kept"}` +
        restored.notes.map((note) => `; ${note}`).join(""));
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
    env: { ...process.env, ...serverEnvironment(ports, LISTENERS), ...options.env, EVEJS_AGENT_BRIDGE: "1" },
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
    options: Object.keys(options.values).length ? options.values : null,
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
      for (const upNote of REGISTRY.upNotes) {
        try {
          const note = upNote(options.values);
          if (note) console.log(note);
        } catch (_error) {
          // A note is a courtesy.
        }
      }
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
      const result = worlds.saveWorld(REPO_ROOT, positionals[1], { force: Boolean(flags.force), note: flags.note,
        hooks: REGISTRY.worldHooks });
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

const VENDOR_USAGE = "usage: e2e vendor update [--from <checkout|tag>] [--tree <path>] [--force] | vendor check [--tree <path>]";

const slashed = (file) => String(file).split(path.sep).join("/");

// --tree defaults to the tree this copy is vendored into.
function cmdVendor(positionals, flags) {
  const action = positionals[0];
  const tree = flags.tree ? path.resolve(String(flags.tree)) : REPO_ROOT;
  const target = slashed(path.join(tree, vendor.VENDOR_DIR));
  try {
    if (action === "update") {
      const result = vendor.updateVendored({ tree, from: flags.from, force: Boolean(flags.force) });
      const { manifest, counts } = result;
      console.log(`vendored ${manifest.name} ${manifest.version} at ${manifest.commit.slice(0, 8)} (${manifest.ref}) ` +
        `from ${slashed(result.checkout)}`);
      console.log(`  ${target}: ${Object.keys(manifest.files).length} files, ${counts.added} added, ` +
        `${counts.changed} changed, ${counts.removed} removed; shim ${result.shim}`);
      if (result.dirty) console.log(`  ${slashed(result.checkout)} has uncommitted changes; they were not vendored`);
      console.log(`  commit ${slashed(vendor.VENDOR_DIR)}/ and ${slashed(vendor.SHIM_PATH)} in ${slashed(tree)}`);
    } else if (action === "check") {
      const result = vendor.checkVendored({ tree });
      if (!result.ok) {
        throw new CliError([`${target} differs from ${vendor.MANIFEST_NAME}; change the evejs-e2e repo and ` +
          "run e2e vendor update:", ...vendor.problemLines(result.problems)].join("\n"));
      }
      const { manifest } = result;
      console.log(`${target} matches ${vendor.MANIFEST_NAME}: ${manifest.name} ${manifest.version} at ` +
        `${String(manifest.commit).slice(0, 8)}, ${Object.keys(manifest.files).length} files and the shim`);
    } else {
      throw new CliError(VENDOR_USAGE);
    }
  } catch (error) {
    throw error instanceof vendor.VendorError ? new CliError(error.message) : error;
  }
}

function describePlugins() {
  const active = REGISTRY.plugins.map((plugin) => plugin.name);
  const skipped = REGISTRY.skipped.map((entry) => `${entry.name} (${entry.reason})`);
  return `plugins  ${active.length ? active.join(", ") : "none"} active` +
    `${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}` +
    `${REGISTRY.warnings.length ? `\nplugin warnings: ${REGISTRY.warnings.join("; ")}` : ""}`;
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
  console.log(describePlugins());
}

// ---------- the command table ----------

function upUsage() {
  const plugin = REGISTRY.upFlags.map((flag) => (flag.type === "bool" ? `[--${flag.flag}]` : `[--${flag.flag} ${flag.min}-${flag.max}]`));
  return [`up [--world <name> | --fresh] [--no-market] [--timeout 600]${plugin.length ? ` ${plugin.join(" ")}` : ""}`];
}

// name -> { usage: [lines], run(positionals, flags) }. Plugin commands
// (registry.commands) run with pluginIO() and can't take a core name.
const CORE_COMMANDS = {
  world: {
    usage: ["world copy --from ../dev [--force]", "world save <name> [--note \"...\"] [--force] | world list"],
    run: cmdWorld,
  },
  vendor: {
    usage: ["vendor update [--from <checkout|tag>] [--tree <path>] [--force] | vendor check [--tree <path>]"],
    run: cmdVendor,
  },
  up: { usage: upUsage(), run: (_positionals, flags) => cmdUp(flags) },
  down: { usage: ["down [--force]"], run: (_positionals, flags) => cmdDown(flags) },
  status: { usage: ["status"], run: () => cmdStatus() },
  ports: {
    usage: ["ports"],
    run: () => { console.log(describePorts(activePorts())); },
  },
  login: { usage: ["login [--user e2eagent] [--name \"Agent Observer\"]"], run: (_positionals, flags) => cmdLogin(flags) },
  logout: { usage: ["logout"], run: () => cmdLogout() },
  undock: { usage: ["undock"], run: () => cmdUndock() },
  dock: { usage: ["dock"], run: () => runSlash("/dock") },
  slash: {
    usage: ["slash \"/tr me 30002537\""],
    run: (positionals) => {
      const line = positionals.join(" ").trim();
      if (!line) throw new CliError('slash needs a command, e.g. e2e slash "/where"');
      return runSlash(line);
    },
  },
  teleport: { usage: ["teleport <system name|ID>"], run: cmdTeleport },
  grid: { usage: ["grid [--range 10000] [--all] [--json]"], run: (_positionals, flags) => cmdGrid(flags) },
  watch: {
    usage: ["watch [--for 600] [--every 2] [--offgrid-every 5] [--grep <regex>] [--no-log] [--json] [--run <id>]",
      "      [--client all|fx|diverge|off] [--diverge-meters 5000] [--positions]"],
    run: (_positionals, flags) => cmdWatch(flags),
  },
  act: {
    usage: ["act <approach|orbit|keepAtRange|warpTo|stop|lock|unlock|activate|deactivate|loadAmmo|launchDrones|engageDrones>",
      "    [<target|modules>] [--range] [--target] [--once] [--charge] [--count] [--timeout]"],
    run: cmdAct,
  },
  view: { usage: ["view [<run>] [--serve] [--port N]"], run: cmdView },
  run: { usage: ["run [<scenario>] [--check] [--run <id>] [--keep-up]"], run: cmdRun },
  log: { usage: ["log [--grep NpcController] [--lines 40] [--any-pid]"], run: (_positionals, flags) => cmdLog(flags) },
  help: { usage: ["help"], run: () => { console.log(helpText()); } },
};

function pluginCommands() {
  return Object.fromEntries(Object.entries(REGISTRY.commands).filter(([name]) => !CORE_COMMANDS[name]));
}

function helpText() {
  const lines = [];
  const push = (name, entry) => {
    for (const usage of entry.usage || [name]) lines.push(`  ${usage.startsWith(" ") ? "  " : "e2e "}${usage}`);
  };
  for (const [name, command] of Object.entries(CORE_COMMANDS)) push(name, command);
  for (const [command, handlers] of Object.entries(REGISTRY.handlers)) {
    for (const handler of handlers) push(command, { usage: handler.usage || [`${command} --${handler.flags.join(" --")}`] });
  }
  for (const [name, command] of Object.entries(pluginCommands())) push(name, command);
  return `node tools/evejs-e2e/bin/e2e.js <command>\n${lines.join("\n")}\n${describePlugins()}`;
}

async function main(argv) {
  const { command, positionals, flags } = parseArgs(argv);
  const core = CORE_COMMANDS[command];
  if (core) return core.run(positionals, flags);
  const plugin = pluginCommands()[command];
  if (plugin) return plugin.run(positionals, flags, pluginIO());
  throw new CliError(`unknown command: ${command}\n${helpText()}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`e2e: ${error instanceof CliError ? error.message : error.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CORE_COMMANDS,
  CliError,
  helpText,
  parseArgs,
  selectLogLines,
  upOptions,
};
