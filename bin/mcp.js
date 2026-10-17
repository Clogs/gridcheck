#!/usr/bin/env node
"use strict";

// MCP server over the gridcheck CLI. Every tool runs `node tools/gridcheck/bin/gridcheck.js
// <command>` in this tree and returns what it printed, so the CLI stays the
// source of truth and anything a tool did can be repeated in a shell. The
// only things it does itself are writing a scenario file it was handed,
// running a scenario in the background, and reading a run's report files.
// MCP over stdio (JSON-RPC, one message per line), no dependencies and no
// listener. Registered in .mcp.json. Guide: docs/GUIDE.md
// "Agent MCP tools".

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_TREE_ROOT, defaultRegistry } = require("../core/plugins");
const { kindsOf } = require("../core/conditions");
const { DRAFT_SCENARIO_DIR, TREE_SCENARIO_DIR, scenarioPath } = require("../core/scenario");
const { defaultTreeConfig } = require("../core/treeConfig");
const { TOPICS, brief } = require("../core/primer");
const { createRuns, clip, compactSummary, consoleSummary, readText, reportSections, runStamp, safeRunID, sleep, tailLines } = require("../core/runs");

const REPO_ROOT = DEFAULT_TREE_ROOT;
const REGISTRY = defaultRegistry();
const CONFIG = defaultTreeConfig();
const MODE = CONFIG.mode;
const MANAGED = MODE === "managed";
const CLI_PATH = path.join(__dirname, "gridcheck.js");
const E2E_DIR = CONFIG.e2eDir;
const RUNS_DIR = CONFIG.runsDir;
const DRAFT_DIR = DRAFT_SCENARIO_DIR;

const SERVER_INFO = { name: "gridcheck", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// Claude Code warns above 10,000 tokens of tool output. The full text is
// always in a file the reply names.
const OUTPUT_LIMIT = 20_000;
const WATCH_DEFAULT_SECONDS = 60;
const MAX_WAIT_SECONDS = 600;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// A short brief (core/primer.js): clients cut long instructions off, so the
// scenario format and the plugins' primers are the guide tool's topics.
function instructions(registry = REGISTRY) {
  return brief({ registry, mode: MODE });
}

const INSTRUCTIONS = instructions();
const RUNS = createRuns({ treeRoot: REPO_ROOT, runsDir: RUNS_DIR, e2eDir: E2E_DIR, surface: "mcp" });
const { committedScenario, filesBlock, prCitation, readReport, recentRuns, runState } = RUNS;

// ---------- helpers ----------

function relativePath(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
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

function serverUp() {
  const handshake = readJSON(CONFIG.handshake);
  return Boolean(handshake && handshake.port && pidAlive(Math.trunc(Number(handshake.pid) || 0)));
}

class ToolError extends Error {}

// ---------- the CLI ----------

// Runs one CLI command to its end. stdout and stderr are kept in the order
// they came, as a person running it in a shell would see them.
function runCli(args, { signal, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let carry = "";
    let settled = false;
    const take = (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      if (!onLine) return;
      const lines = (carry + text).split(/\r?\n/);
      carry = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const abort = () => child.kill();
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", abort);
      resolve({
        code: typeof code === "number" ? code : 1,
        output: output.replace(/\r\n/g, "\n").trimEnd(),
        aborted: Boolean(signal && signal.aborted),
      });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(1);
    });
    child.on("close", finish);
  });
}

// The CLI arguments for the tools that are one command. Valued flags use
// --flag=value so a value starting with "--" is still a value, and free text
// goes after "--" so the CLI never reads it as flags.
function argList(command) {
  const args = [command];
  const flag = (name, value) => {
    if (value === undefined || value === null || value === false || value === "") return;
    args.push(value === true ? `--${name}` : `--${name}=${value}`);
  };
  return { args, flag };
}

// tool name -> (params) -> CLI arguments. Plugin tools bring their own args().
const CLI_ARGS = {
  up(p) {
    const { args, flag } = argList("up");
    flag("world", p.world);
    flag("fresh", p.fresh);
    flag("no-market", p.market === false);
    for (const upFlag of REGISTRY.upFlags) flag(upFlag.flag, p[upFlag.key]);
    flag("profile", p.profile);
    flag("profile-every", p.profile ? p.profileEvery : undefined);
    flag("timeout", p.timeout);
    return args;
  },
  down(p) {
    const { args, flag } = argList("down");
    flag("force", p.force);
    return args;
  },
  login(p) {
    const { args, flag } = argList("login");
    flag("user", p.user);
    flag("name", p.name);
    return args;
  },
  guide: (p) => ["primer", "--mcp", ...(p.topic ? ["--", p.topic] : [])],
  undock: () => ["undock"],
  teleport: (p) => ["teleport", "--", String(p.system)],
  grid(p) {
    const { args, flag } = argList("grid");
    flag("range", p.range);
    flag("all", p.all);
    flag("kind", p.kind);
    flag("json", p.json);
    return args;
  },
  slash: (p) => ["slash", "--", String(p.command)],
  loadout(p) {
    const { args, flag } = argList("loadout");
    const spec = { ship: p.ship };
    for (const key of ["modules", "drones", "cargo", "charges"]) if (p[key] !== undefined) spec[key] = p[key];
    flag("spec", JSON.stringify(spec));
    flag("json", p.json);
    return args;
  },
  watch(p) {
    const { args, flag } = argList("watch");
    flag("for", p.seconds === undefined ? WATCH_DEFAULT_SECONDS : p.seconds);
    flag("every", p.every);
    flag("offgrid-every", p.offgridEvery);
    flag("grep", p.grep);
    flag("no-log", p.log === false);
    flag("client", p.client);
    flag("diverge-meters", p.divergeMeters);
    flag("positions", p.positions);
    flag("perf", p.perf && p.perfEvery === undefined);
    flag("perf-every", p.perfEvery);
    flag("run", p.run);
    flag("json", p.json);
    return args;
  },
  perf(p) {
    const { args, flag } = argList("perf");
    flag("for", p.now ? undefined : p.seconds);
    flag("now", p.now);
    flag("json", p.json);
    return args;
  },
  // The same argument names as a scenario's action step (scenario.js).
  act(p) {
    const { args, flag } = argList("act");
    flag("range", p.range);
    flag("target", p.action === "activate" ? p.target : undefined);
    flag("once", p.once);
    flag("charge", p.charge);
    flag("count", p.count);
    flag("timeout", p.timeout);
    const what = p.action === "activate" ? p.modules : (p.target || p.modules || p.drones);
    args.push("--", p.action, ...(what === undefined ? [] : [String(what)]));
    return args;
  },
  log(p) {
    const { args, flag } = argList("log");
    flag("grep", p.grep);
    flag("lines", p.lines);
    flag("any-pid", p.anyPid);
    return args;
  },
  doctor(p) {
    const { args, flag } = argList("doctor");
    flag("offline", p.offline);
    flag("json", p.json);
    return args;
  },
  client_launch(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("name", p.name);
    flag("exe", p.exe);
    flag("wait", p.wait);
    args.push("--", "launch");
    return args;
  },
  client_status: () => ["client", "--", "status"],
  client_stop(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    args.push("--", "stop");
    return args;
  },
  client_eval(p) {
    if ((p.code === undefined) === (p.file === undefined)) throw new Error("client_eval takes code or file, one of them");
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("timeout", p.timeout);
    flag("json", p.json);
    flag("file", p.file);
    flag("assert", p.assert);
    flag("out", p.out);
    args.push("--", "eval", ...(p.code === undefined ? [] : [String(p.code)]));
    return args;
  },
  client_ui_state(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("timeout", p.timeout);
    flag("limit", p.limit);
    flag("out", p.out);
    args.push("--", "ui-state");
    return args;
  },
  client_check_ui(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("timeout", p.timeout);
    flag("spec", JSON.stringify(p.spec));
    flag("wait", p.wait);
    flag("stable", p.stable);
    flag("limit", p.limit);
    flag("out", p.out);
    args.push("--", "check-ui");
    return args;
  },
  client_console(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("lines", p.lines);
    flag("grep", p.grep);
    args.push("--", "console");
    return args;
  },
  client_ui(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("class", p.cls);
    flag("name", p.name);
    flag("text", p.text);
    flag("depth", p.depth);
    flag("hidden", p.hidden);
    flag("limit", p.limit);
    flag("json", p.json);
    args.push("--", "ui");
    return args;
  },
  client_ballpark(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("range", p.range);
    flag("json", p.json);
    args.push("--", "ballpark");
    return args;
  },
  client_diff(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("tolerance", p.tolerance);
    flag("json", p.json);
    args.push("--", "diff");
    return args;
  },
  client_events(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("since", p.since);
    flag("all", p.all);
    flag("limit", p.limit);
    // An empty list is a value here: it stops recording notify events.
    if (Array.isArray(p.notify)) args.push(`--notify=${p.notify.join(",")}`);
    flag("json", p.json);
    args.push("--", "events");
    return args;
  },
  client_screenshot(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("run", p.run);
    flag("max-width", p.maxWidth === undefined ? 1600 : p.maxWidth);
    flag("format", p.format || "jpg");
    flag("source", p.source);
    args.push("--json", "--", "screenshot");
    return args;
  },
  client_find: (p) => clientDriveArgs("find", p),
  client_click: (p) => clientDriveArgs("click", p, (flag) => flag("double", p.double)),
  // text is what to type here; intoText finds the edit by its text.
  client_type: (p) => clientDriveArgs("type", { ...p, text: p.intoText }, (flag) => {
    flag("set", p.set);
    flag("enter", p.enter);
  }, p.text === undefined ? [] : [String(p.text)]),
  client_key: (p) => clientDriveArgs("key", p, null, [String(p.key)]),
  client_cmd(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("filter", p.filter);
    flag("wait", p.wait);
    flag("json", p.json);
    args.push("--", "cmd", ...(p.name ? [String(p.name), ...(p.args || []).map(String)] : []));
    return args;
  },
  client_act(p) {
    const { args, flag } = argList("client");
    flag("user", p.user);
    flag("range", p.range);
    flag("module", p.module);
    flag("wait", p.wait);
    flag("json", p.json);
    args.push("--", "act", String(p.action), ...(p.target === undefined ? [] : [String(p.target)]));
    return args;
  },
};

// The node flags (as client_ui lists nodes) and the subcommand after --.
// How the client_ drive tools name a node, as client_ui lists them.
function clientNodeProps() {
  return {
    path: str("The node's path exactly as client_ui prints it."),
    cls: str("Class name contains this, e.g. Button."),
    name: str("Node name contains this."),
    text: str("Label or caption contains this, e.g. Undock."),
    index: { type: "integer", minimum: 0, description: "Which of several matches, from 0." },
    hidden: bool("Also look in hidden nodes."),
  };
}

function clientDriveProps() {
  return {
    wait: num("Seconds to wait for what it started (default 3, at most 60); then it reports still running.", { minimum: 0, maximum: 60 }),
    user: { type: "string", description: "The client's account, when more than one is online." },
    json: { type: "boolean", description: "The answer as JSON." },
  };
}

function clientDriveArgs(sub, p, more = null, tail = []) {
  const { args, flag } = argList("client");
  flag("user", p.user);
  flag("path", p.path);
  flag("class", p.cls);
  flag("name", p.name);
  flag("text", p.text);
  flag("index", p.index);
  flag("hidden", p.hidden);
  if (more) more(flag);
  flag("wait", p.wait);
  flag("json", p.json);
  args.push("--", sub, ...tail);
  return args;
}

function cliArgs(tool, params = {}) {
  const plugin = REGISTRY.mcpTools.find((entry) => entry.name === tool && !CLI_ARGS[tool]);
  const build = CLI_ARGS[tool] || (plugin && plugin.args);
  if (!build) throw new ToolError(`no CLI command for ${tool}`);
  return build(params);
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text: text || "(no output)" }], isError: Boolean(isError) };
}

function cliResult({ code, output, aborted }, where = "") {
  const end = aborted ? "\n(cancelled)" : code ? `\n(exit ${code})` : "";
  return textResult(`${clip(output, OUTPUT_LIMIT, where)}${end}`, code !== 0 || aborted);
}

// ---------- scenarios and runs ----------

// A bare name is a tree scenario (the core's, then each plugin's), else a
// draft; a path is a path.
function resolveScenario(name) {
  const text = String(name);
  if (text.endsWith(".json") || text.includes("/") || text.includes("\\")) return path.resolve(REPO_ROOT, text);
  return scenarioPath(text, { registry: REGISTRY });
}

function writeScenario(name, scenario, { save = false } = {}) {
  if (!NAME_PATTERN.test(String(name || ""))) {
    throw new ToolError("name: a file name for the scenario, letters, digits, '.', '_' or '-' (e.g. \"fleet-arrives\")");
  }
  if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new ToolError("scenario: the scenario as a JSON object");
  }
  const dir = save ? TREE_SCENARIO_DIR : DRAFT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(scenario, null, 2)}\n`);
  return file;
}

// ---------- tools ----------

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const simple = (name) => async (params, context) => cliResult(await runCli(cliArgs(name, params), context));

const TOOLS = [
  {
    name: "status",
    description: "Where things stand in this tree: whether the gridcheck server is up (pid, ports, boot time), the held character, " +
      "the saved worlds a run can start from, the scenarios (the tree's tools/gridcheck-scenarios, the tool's and its plugins', and drafts in _local/gridcheck/scenarios), " +
      "background runs, and the most recent runs. Call this first.",
    inputSchema: schema(),
    async run(_params, context) {
      const parts = [];
      for (const [title, args] of [["Server", ["status"]], ["Saved worlds", ["world", "list"]], ["World recipes", ["world", "recipes"]],
        ["Scenarios", ["run"]]]) {
        const reply = await runCli(args, context);
        parts.push(`## ${title}\n${reply.output}`);
      }
      const runs = recentRuns(10);
      const running = runs.filter((row) => runState(row.name).running);
      if (running.length) parts.push(`## Background runs still going\n${running.map((row) => row.name).join("\n")}`);
      if (runs.length) parts.push(`## Recent runs\n${runs.map((row) => row.text).join("\n")}`);
      return textResult(parts.join("\n\n"));
    },
  },
  {
    name: "guide",
    description: "How to drive this tool, by topic; this server's instructions are only an outline. Read \"scenarios\" " +
      "before writing a scenario, and \"events\" for the fields a condition can test. No topic returns every topic.",
    inputSchema: schema({
      topic: str(Object.entries(TOPICS).map(([key, what]) => `${key}: ${what}`).join("; "), { enum: Object.keys(TOPICS) }),
    }),
    run: simple("guide"),
  },
  {
    name: "up",
    description: "Managed and auto mode. Start this tree's server (and market daemon) in the background and wait until a character can log in, " +
      "about 25 s warm. For grid checks pass world (a saved world status lists). Without world or fresh it keeps " +
      "the current world. Refuses if the server is already up. run_scenario does its own up and down, so don't " +
      "call this before a run.",
    inputSchema: schema({
      world: str("Saved world to restore before boot (status lists them)."),
      fresh: bool("Drop the game store; the boot seeds a new world from the reference data."),
      market: bool("Start the market daemon (default true)."),
      ...Object.fromEntries(REGISTRY.upFlags.map((flag) => [flag.key, flag.type === "bool"
        ? bool(flag.description || `--${flag.flag}`)
        : num(flag.description || `--${flag.flag}`, { minimum: flag.min, maximum: flag.max })])),
      profile: bool("Boot with the tree's tick profiler (EVEJS_TICK_PROFILE=1), so perf and a watch with perf " +
        "break each window of ticks down by subsystem. Tick durations need no profiler."),
      profileEvery: int("With profile: ticks per profiler window (default 50, 5 s at 10 Hz).", { minimum: 1, maximum: 10000 }),
      timeout: int("Seconds to wait for boot (default 600).", { minimum: 10 }),
    }),
    run: simple("up"),
  },
  {
    name: "down",
    description: "Stop this tree's server cleanly (store flushed, world lease released) and its market daemon. " +
      "Also ends a background run early: its watch ends and it writes its report.",
    inputSchema: schema({ force: bool("Kill a server that is still booting and has no agent bridge yet.") }),
    run: simple("down"),
  },
  {
    name: "login",
    description: "Log the test character in through the web gateway (account e2eagent, character Agent Observer by default). " +
      "Needed once after up, before undock, grid, slash, teleport, act or watch.",
    inputSchema: schema({ user: str("Account name (default e2eagent)."), name: str("Character name (default the account's first).") }),
    run: simple("login"),
  },
  {
    name: "undock",
    description: "Undock the logged-in character's ship. Undocking puts the session in the system's scene, so the system " +
      "counts as observed. The ship has undock protection for a while.",
    inputSchema: schema(),
    run: simple("undock"),
  },
  {
    name: "teleport",
    description: "Teleport the ship to a system with stock /tr.",
    inputSchema: schema({
      system: str("Solar system name or ID, e.g. Amamake."),
    }, ["system"]),
    run: simple("teleport"),
  },
  {
    name: "loadout",
    description: "Give the logged-in character a new ship by item name, fitted, with drones, cargo and loaded charges, and " +
      "board it where it is, docked or in space (in space the old ship is removed). Names must be exact item names; " +
      "\"Name xN\" is N of one. Every skill the hull, modules, drones and charges need is checked first: a refusal lists " +
      "the missing skills (or the unknown names) and changes nothing. /allskills grants every skill.",
    inputSchema: schema({
      ship: str("The hull, e.g. Tristan."),
      modules: { type: "array", items: { type: "string" }, description: "Fitted modules, e.g. [\"Light Neutron Blaster II x2\", \"1MN Afterburner II\"]." },
      drones: { type: "array", items: { type: "string" }, description: "Drone bay, e.g. [\"Hobgoblin II x5\"]." },
      cargo: { type: "array", items: { type: "string" }, description: "Cargo hold, e.g. [\"Antimatter Charge S x400\"]." },
      charges: { type: "array", items: { type: "string" }, description: "Charges to load: a full clip in every fitted module that takes one; no count." },
      json: bool("The bridge's reply as JSON."),
    }, ["ship"]),
    run: simple("loadout"),
  },
  {
    name: "grid",
    description: "The ship's grid now, as a table: distance, name, type, NPC kind, mode, target and shield/armour/hull, " +
      "nearest first, with the ship's protection countdown. More than 10 of one kind that isn't a ship (a belt's " +
      "asteroids) collapse to the nearest 3 and a count; kind lists them.",
    inputSchema: schema({
      range: num("Cut-off in km (default 10,000).", { exclusiveMinimum: 0 }),
      all: bool("Everything the session can see, nothing collapsed."),
      kind: str("Only rows of this kind, e.g. planet, stargate, station, asteroid; a kind no row has lists the kinds there are."),
      json: bool("The bridge's full reply as JSON (field names match scenario conditions)."),
    }),
    run: simple("grid"),
  },
  {
    name: "slash",
    description: "Run a slash command on the character's own session, as if typed in game chat, e.g. \"/tr me 30002537\", " +
      "\"/heal\", \"/dock\", \"/npc 3\", \"/ship Rifter\". Returns the command's reply. A refused command is an error.",
    inputSchema: schema({ command: str("The command line, starting with /.") }, ["command"]),
    run: simple("slash"),
  },
  {
    name: "watch",
    description: "Watch the ship's grid and system for a number of seconds and return what changed, one line per event: " +
      `${kindsOf(REGISTRY).filter((kind) => !["GRID", "CLIENT", "FX"].includes(kind)).join(", ")} and more, with what the ` +
      "active plugins know about each NPC. The call blocks for the whole watch. To see an action's effect, call it in " +
      "the same turn. The timeline is also written to _local/gridcheck/runs/<id>/timeline.jsonl.",
    inputSchema: schema({
      seconds: int(`How long to watch (default ${WATCH_DEFAULT_SECONDS}; the CLI's own default is 600).`, { minimum: 1, maximum: 3000 }),
      every: num("Grid sample interval, seconds (default 2).", { exclusiveMinimum: 0 }),
      offgridEvery: num("Off-grid scan interval, seconds (default 5).", { exclusiveMinimum: 0 }),
      client: str("What the client was sent: all (default), fx (DIVERGE plus special effects such as weapons firing), " +
        "diverge (only DIVERGE lines) or off.", { enum: ["all", "fx", "diverge", "off"] }),
      divergeMeters: num("Position error that counts as DIVERGE (default 5000).", { exclusiveMinimum: 0 }),
      positions: bool("Record ball positions too, so the viewer (gridcheck view) can draw this watch."),
      grep: str("Keep every server log line matching this regex instead of the default NPC and plugin lines."),
      log: bool("Include server log lines (default true)."),
      json: bool("Print events as JSON lines, with the field names scenario conditions use."),
      run: str("Run ID for the timeline directory (default: the start time)."),
      perf: bool("Add a PERF line every 5 s (the server's tick times, loop delay, CPU, heap), and the tick profiler's " +
        "PROFILE lines when the server runs it."),
      perfEvery: int("Seconds per PERF window (default 5); implies perf.", { minimum: 1, maximum: 60 }),
    }),
    run: simple("watch"),
  },
  {
    name: "perf",
    description: "How the server's ticks are doing: samples for some seconds, then gives tick duration (average, p50, " +
      "p95, p99, max) against the 100 ms budget, how many ticks ran over it, event-loop delay, CPU and heap, the busiest " +
      "scenes, and, when the server was booted with the tick profiler (up { profile: true }), the cost of each " +
      "subsystem per tick. Needs a server up, not a character. Take one before a load (slash \"/npctest2 20\") and " +
      "one during it, and compare.",
    inputSchema: schema({
      seconds: int("How long to sample (default 10).", { minimum: 1, maximum: 600 }),
      now: bool("Read the last ticks the server holds (about 12 s) at once, without CPU or loop delay."),
      json: bool("The bridge's reply as JSON, with every tick's duration."),
    }),
    run: simple("perf"),
  },
  {
    name: "act",
    description: "Act as the player, through the calls the web gateway allows a client: fly, lock, switch modules on and " +
      "off, load ammo and use drones. The server applies every rule (range, lock time, capacitor, ammo) and a refusal " +
      "is in its own words. A target is the nearest ball the session sees (on grid, or a celestial anywhere in the " +
      "system, so warpTo reaches planets and belts) that passes every term: \"nearest npc\", " +
      "\"name~Scout\", \"name~\\\"Asteroid Belt\\\"\" (terms split at spaces, so quote a value that has one), \"type~Rifter\", " +
      "\"kind=station\", \"within=30km\", \"player\" or an itemID" +
      `${Object.keys(REGISTRY.targetFields).length ? `, and the plugins' ${Object.keys(REGISTRY.targetFields).map((term) => `${term}=`).join(", ")}` : ""}. ` +
      "Modules: weapons (default), high, mid, low, all, name~..., group~..., " +
      "an itemID. Watch the effect with watch in the same turn (client: \"fx\" shows the guns firing).",
    inputSchema: schema({
      action: str("The action.", { enum: ["approach", "orbit", "keepAtRange", "warpTo", "stop", "lock", "unlock", "activate",
        "deactivate", "loadAmmo", "launchDrones", "engageDrones"] }),
      target: str("approach, orbit, keepAtRange, warpTo, lock, unlock, engageDrones: the ball; activate: what to fire at " +
        "(default the first locked target)."),
      modules: str("activate, deactivate, loadAmmo: which fitted modules (default weapons)."),
      drones: str("launchDrones: which drone-bay stacks, all (default) or name~..."),
      range: num("orbit (default 5000), keepAtRange (default 10000), warpTo (default 0): metres.", { minimum: 0 }),
      once: bool("activate: one cycle instead of repeating."),
      charge: str("loadAmmo: the charge in the cargo hold, e.g. \"EMP S\" or name~EMP."),
      count: int("launchDrones: how many.", { minimum: 1, maximum: 50 }),
      timeout: int("lock: seconds to wait for the lock (default 30).", { minimum: 1, maximum: 600 }),
    }, ["action"]),
    run: simple("act"),
  },
  {
    name: "log",
    description: "The tail of the server log, only the running server's lines unless anyPid.",
    inputSchema: schema({
      grep: str("Case-insensitive regex, e.g. NpcController."),
      lines: int("How many lines (default 40).", { minimum: 1, maximum: 2000 }),
      anyPid: bool("Keep every process's lines."),
    }),
    run: simple("log"),
  },
  {
    name: "doctor",
    description: "What this tree can do for the tool: which gateway calls the CLI makes it allows, whether the client " +
      "view can run (the destiny layout check), which optional patches it has, which plugins are active or skipped and " +
      "why, and which ports can move. Asks the running server when there is one, else reads the tree's files.",
    inputSchema: schema({
      offline: bool("Read the tree's files even when a server is up."),
      json: bool("The whole report as JSON."),
    }),
    run: simple("doctor"),
  },
  {
    name: "client_launch",
    description: "Start a real EVE client (the tree's Play.bat client) logged in by token as its own account (e2eclient, " +
      "character Client Observer by default) and wait until it is in game, about 20 s. Needs the opt-in client-agent patch: " +
      "doctor says whether it is applied. The client then runs the client agent, which the other client_ tools talk to.",
    inputSchema: schema({
      user: str("Account name (default e2eclient). Not the headless character's account."),
      name: str("Character name, for a new character (default Client Observer)."),
      exe: str("exefile.exe to start (default the one the tree's launcher config names)."),
      wait: int("Seconds to wait for the client to reach the game (default 240; 0 returns at once).", { minimum: 0 }),
    }),
    run: simple("client_launch"),
  },
  {
    name: "client_status",
    description: "Whether the client agent is on in this server, and each client that attached: account, character, " +
      "online or gone, pid and build.",
    inputSchema: schema(),
    run: simple("client_status"),
  },
  {
    name: "client_stop",
    description: "End an attached EVE client's process (the pid its agent reported).",
    inputSchema: schema({ user: str("The client's account, when more than one is online.") }),
    run: simple("client_stop"),
  },
  {
    name: "client_eval",
    description: "Run Python 2.7 inside the EVE client, on its own tasklet. An expression answers its repr; statements " +
      "answer what they leave in `result`. sm, session, uicore and agent are defined, and names persist between calls. " +
      "Code that loops without yielding stalls the client. assert works, though the client runs Python optimized.",
    inputSchema: schema({
      code: str("Python, e.g. cfg.evelocations.Get(session.solarsystemid2).name. Give code or file."),
      file: str("A Python file to run instead of code, at most 256 KiB."),
      assert: bool("Fail unless the value is exactly True (1, None and False fail)."),
      out: str("Also save the answer to this JSON file."),
      user: str("The client's account, when more than one is online."),
      timeout: int("Seconds to wait for the answer (default 15).", { minimum: 1, maximum: 300 }),
      json: bool("The value as JSON too, when it is plain data."),
    }),
    run: simple("client_eval"),
  },
  {
    name: "client_ui_state",
    description: "Every node of the EVE client's UI, hidden ones too, flat, as JSON: path, rect, whether it is shown and " +
      "enabled counting its ancestors, opacity, full screen, whether it holds a 3D scene, and which node has focus and " +
      "which is the modal window. For assertions, client_check_ui.",
    inputSchema: schema({
      limit: int("Most nodes (default 10000). A state cut short can't show that a node is gone.", { minimum: 1, maximum: 20000 }),
      out: str("Also save the state to this JSON file."),
      user: str("The client's account, when more than one is online."),
      timeout: int("Seconds to wait for the answer (default 15).", { minimum: 1, maximum: 300 }),
    }),
    run: simple("client_ui_state"),
  },
  {
    name: "client_check_ui",
    description: "Assert on the EVE client's UI and fail unless it holds: how many nodes match a selector, and whether " +
      "they are enabled, focused, modal, full screen, hold a scene, their size, whether they fit the desktop, their " +
      "opacity. Optionally waits until it holds, and for it to keep holding. A UI state cut short fails.",
    inputSchema: schema({
      spec: {
        type: "object",
        description: "{ selector: { path | cls | name | text, exact? }, count (default 1), visible (default true; false, " +
          "or \"any\"), enabled, focused, modal, fullscreen, scene, withinDesktop, minWidth, minHeight, opacityMin, opacityMax }. " +
          "To check a UI is gone, not just hidden: count 0, visible \"any\".",
      },
      wait: int("Seconds to keep reading until it holds (default 0: once).", { minimum: 0, maximum: 300 }),
      stable: int("Milliseconds it must keep holding, within wait.", { minimum: 0, maximum: 300000 }),
      limit: int("Most nodes to read (default 10000).", { minimum: 1, maximum: 20000 }),
      out: str("Also save the check and its result to this JSON file."),
      user: str("The client's account, when more than one is online."),
      timeout: int("Seconds each read waits for the client (default 15).", { minimum: 1, maximum: 300 }),
    }, ["spec"]),
    run: simple("client_check_ui"),
  },
  {
    name: "client_console",
    description: "The end of the EVE client's own console window, where it prints its startup, its log lines and full " +
      "exception reports (EXCEPTION #n ... EXCEPTION END), and the agent's GRIDCHECK_CLIENT: lines.",
    inputSchema: schema({
      lines: int("How many lines from the end (default 60; 0 for all).", { minimum: 0 }),
      grep: str("Keep lines matching this case-insensitive regex."),
      user: str("The client's account, when more than one is online."),
    }),
    run: simple("client_console"),
  },
  {
    name: "client_ui",
    description: "The EVE client's open windows and its UI tree from uicore.desktop: each node's class, name, text, " +
      "absolute rect, whether it is shown and enabled. With cls, name or text, every node at any depth containing it " +
      "(case-insensitive), with its path, instead of the tree.",
    inputSchema: schema({
      cls: str("Class name contains this, e.g. Button."),
      name: str("Node name contains this."),
      text: str("Label or caption contains this, e.g. Undock."),
      depth: int("How deep to walk (default 3, or 40 with a filter).", { minimum: 0, maximum: 60 }),
      hidden: bool("Also walk hidden nodes."),
      limit: int("Most nodes (tree) or matches to list.", { minimum: 1, maximum: 20000 }),
      user: str("The client's account, when more than one is online."),
      json: bool("The answer as JSON."),
    }),
    run: simple("client_ui"),
  },
  {
    name: "client_screenshot",
    description: "A picture of the EVE client. By default the client saves what it last drew, which works while its window " +
      "is covered or minimized; if it can't, the window is drawn with PrintWindow from outside. Saved under " +
      "_local/gridcheck/client/ (or the run's client/ folder) and returned as an image.",
    inputSchema: schema({
      run: str("Save it in this run's folder."),
      source: str("auto (default), client (only the client's own picture) or window (only PrintWindow, not while minimized).",
        { enum: ["auto", "client", "window"] }),
      maxWidth: int("Scale down to this width in pixels (default 1600; 0 keeps full size).", { minimum: 0 }),
      format: str("jpg (default) or png.", { enum: ["jpg", "png"] }),
      user: str("The client's account, when more than one is online."),
    }),
    async run(params, context) {
      const reply = await runCli(cliArgs("client_screenshot", params), context);
      if (reply.code !== 0) return cliResult(reply);
      let shot;
      try {
        shot = JSON.parse(reply.output.slice(reply.output.indexOf("{")));
      } catch (_error) {
        return cliResult(reply);
      }
      const data = fs.readFileSync(shot.file).toString("base64");
      return {
        content: [
          { type: "image", data, mimeType: /\.png$/i.test(shot.file) ? "image/png" : "image/jpeg" },
          { type: "text", text: `${relativePath(shot.file)} (${shot.width}x${shot.height}${shot.title ? `, "${shot.title}"` : ""})` },
        ],
        isError: false,
      };
    },
  },
  {
    name: "client_ballpark",
    description: "What the EVE client's ballpark (michelle) holds: every ball with an item, its position, velocity, " +
      "mode and distance from the client's ship, nearest first. Empty when docked.",
    inputSchema: schema({
      range: num("Only balls within this many km of the ship.", { exclusiveMinimum: 0 }),
      user: str("The client's account, when more than one is online."),
      json: bool("The answer as JSON."),
    }),
    run: simple("client_ballpark"),
  },
  {
    name: "client_diff",
    description: "The EVE client's ballpark against the server's grid for the same character: balls the server sent " +
      "that the client lacks, balls only the client holds (celestials aside), balls further apart than tolerance plus " +
      "2 s of their speed, and mode differences. Errors (exit 1) when they disagree.",
    inputSchema: schema({
      tolerance: num("Metres two positions may differ before speed (default 1000).", { minimum: 0 }),
      user: str("The client's account, when more than one is online."),
      json: bool("The answer as JSON."),
    }),
    run: simple("client_diff"),
  },
  {
    name: "client_events",
    description: "The EVE client's logged exceptions (unhandled tasklet errors included), the notify events it records " +
      "(OnSessionChanged by default), its actions and the agent's own errors, oldest first: the attached client's since it " +
      "attached, the last 50. The answer ends with the since to pass for newer ones. A watch shows the same as " +
      "CLIENT_EXCEPTION and CLIENT_EVENT lines beside the server's.",
    inputSchema: schema({
      since: int("Only events after this sequence number, from any client.", { minimum: 0 }),
      all: bool("Every client's events since the server started."),
      limit: int("The most recent this many (default 50).", { minimum: 1, maximum: 1000 }),
      notify: { type: "array", items: { type: "string" }, description: "Record these notify events from now on instead, e.g. [\"OnSessionChanged\", \"OnDamageStateChange\"]; [] records none." },
      user: str("The client's account, when more than one is online."),
      json: bool("The answer as JSON."),
    }),
    run: simple("client_events"),
  },
  {
    name: "client_find",
    description: "One displayed node of the EVE client's UI, by path (as client_ui prints it) or by cls, name and text " +
      "(contains, case-insensitive), and the node a click on it goes to (it or the nearest one above with a click " +
      "handler). Of nested matches, such as a button and its own label, the outermost counts. Several matches is an " +
      "error listing them; pass index or path.",
    inputSchema: schema({ ...clientNodeProps(), user: str("The client's account, when more than one is online."),
      json: bool("The answer as JSON.") }),
    run: simple("client_find"),
  },
  {
    name: "client_click",
    description: "Click a node of the EVE client's UI (found as client_find finds it) from inside the client: its own " +
      "click handler runs (a button's press, which checks it is enabled), so the client's window may stay in the " +
      "background. Answers whether what it started finished within wait, and any dialog it opened (then " +
      "client_click that dialog's button).",
    inputSchema: schema({ ...clientNodeProps(), double: bool("Double-click (OnDblClick)."), ...clientDriveProps() }),
    run: simple("client_click"),
  },
  {
    name: "client_type",
    description: "Type into an edit of the EVE client, character by character through the client's own key input " +
      "(uilib._OnChar), or set its value at once. The client drops its focus while its window is in the background, " +
      "so name the edit (path, cls, name or intoText).",
    inputSchema: schema({
      text: str("What to type."),
      ...clientNodeProps(),
      intoText: str("Find the edit by its text (contains)."),
      set: bool("Set the edit's value with its SetValue instead of typing."),
      enter: bool("Press enter after."),
      user: str("The client's account, when more than one is online."),
      json: bool("The answer as JSON."),
    }),
    run: simple("client_type"),
  },
  {
    name: "client_key",
    description: "Press one key in the EVE client (down, its character, up) through its own key input, so the focused " +
      "edit and the key bindings see it. Ctrl, shift and alt can't be held: the client reads them from the real " +
      "keyboard; client_cmd runs what a combination is bound to. Escape opens the settings menu, as for a player.",
    inputSchema: schema({
      key: str("enter, escape, tab, backspace, space, delete, home, end, pageup, pagedown, up, down, left, right, insert, a-z, 0-9 or f1-f12."),
      ...clientNodeProps(),
      user: str("The client's account, when more than one is online."),
      json: bool("The answer as JSON."),
    }, ["key"]),
    run: simple("client_key"),
  },
  {
    name: "client_cmd",
    description: "The EVE client's commands (uicore.cmd: what its key bindings run, such as OpenInventory or " +
      "CmdStopShip). Without a name, lists them with label, shortcut and whether they are enabled (filter narrows " +
      "it). With one, runs it through the client's own checks. Some toggle (OpenInventory closes an open " +
      "inventory). The navigation ones (CmdApproachItem, CmdWarpToItem ...) only arm a click on a target; use client_act.",
    inputSchema: schema({
      name: str("The command, e.g. OpenInventory."),
      args: { type: "array", items: { type: ["string", "number"] }, description: "Arguments for the command, rarely needed." },
      filter: str("Without name: list only commands whose name or label contains this."),
      ...clientDriveProps(),
    }),
    run: simple("client_cmd"),
  },
  {
    name: "client_act",
    description: "A player's action in the EVE client, through the client's own services as CCP's code calls them, so " +
      "the server sees what a real client sends. undock; dock (target, else the nearest station or structure); jump " +
      "(gate, station or structure: target); warpTo, approach, orbit (range default 5000), keepAtRange (range default " +
      "10000): target; stop; lock, unlock: target (answers where the locks stand: a refused lock is dropped); " +
      "activate, deactivate: module (itemID or slot such as high1, med2), activate with target for a targeted module; " +
      "modules: the HUD's modules and the locked targets; logoff: back to character selection; select: target, a " +
      "characterID, from character selection (the client picks a character by itself only at its first login). " +
      "Answers once the action is done (in space, docked, in the new system, out of warp, orbiting, locked ...), " +
      "first waiting out the client's session-change timer for undock, dock and jump; then where the client is and the " +
      "exceptions and notify events it logged meanwhile. Not done in time is an error. " +
      "A refusal from the server comes back as the error.",
    inputSchema: schema({
      action: str("What to do.", { enum: ["undock", "dock", "jump", "warpTo", "approach", "orbit", "keepAtRange", "stop",
        "lock", "unlock", "activate", "deactivate", "modules", "logoff", "select"] }),
      target: { type: ["string", "number"], description: "An itemID (client_ballpark lists them), or a characterID for select." },
      range: num("Metres: the warp's landing distance, the orbit or keep-at-range distance.", { minimum: 0 }),
      module: str("activate, deactivate: the module's itemID or slot (high1 ... low8)."),
      ...clientDriveProps(),
      wait: num("Most seconds to wait for the action to be done (default 120 for warpTo, 60 for undock, dock, jump, " +
        "logoff, select and deactivate, 30 for lock, 10 for the rest); 0 answers once it has started.", { minimum: 0, maximum: 280 }),
    }, ["action"]),
    run: simple("client_act"),
  },
  {
    name: "run_scenario",
    description: (MANAGED
      ? "Run a scenario: boot its world, run setup, watch until a stop condition, shut down, and write a "
      : MODE === "attach"
        ? "Run a scenario on the live server (attach mode: its world is not restored and the server stays up): run setup, " +
          "watch until a stop condition, and write a "
        : "Run a scenario (auto mode): when the server is up, on it as it is (its world is not restored and it stays up); " +
          "when none is, boot the scenario's world and shut it down after. Run setup, watch until a stop condition, and write a ") +
      "report of expected against observed with tactical frames. Pass name to run a scenario file, or name and scenario " +
      "(the JSON object) to write one first. check: true only validates it, which boots nothing; do that first. " +
      (MANAGED ? "The server must be down (down). " : "") +
      "A run takes minutes; wait: false returns at once and report waits. " +
      "The scenario format: guide { topic: \"scenarios\" }.",
    inputSchema: schema({
      name: str("A scenario in tools/gridcheck-scenarios, tools/gridcheck/scenarios, a plugin's scenarios or _local/gridcheck/scenarios (without .json), or a path. With scenario: the file name to write."),
      scenario: { type: "object", description: "The scenario JSON to write as <name>.json before checking or running it." },
      save: bool("With scenario: write it to tools/gridcheck-scenarios/ (to commit with the feature) instead of _local/gridcheck/scenarios/."),
      check: bool("Only load and check the scenario; boot nothing."),
      run: str("Run ID (default: start time and scenario name). Must be new."),
      keepUp: bool("Leave the server running after the run, to look around with the other tools."),
      reuse: bool("For a scenario that names a recipe, while iterating on it: skip the boot by resetting the server the last reuse run left up (NPCs, gate rats, debris and crimewatch cleared, the recipe run again), and leave it up. What else a run changed stays, so check the final version without it."),
      world: str("When the run boots its own world (managed mode, or auto with no server up): this saved world (or fresh) instead of the scenario's."),
      wait: bool("Wait for the run to finish (default true). false: start it in the background and return its run ID."),
    }),
    async run(params, context) {
      let target;
      let wrote = null;
      if (params.scenario !== undefined) {
        wrote = writeScenario(params.name, params.scenario, { save: params.save === true });
        target = wrote;
      } else if (params.name) {
        target = resolveScenario(params.name);
      } else {
        throw new ToolError("pass name (a scenario file), or name and scenario (the JSON to write); status lists scenarios");
      }
      const prefix = wrote ? `wrote ${relativePath(wrote)}\n` : "";
      const check = await runCli(["run", "--check", "--", target], context);
      if (params.check || check.code !== 0) {
        const result = cliResult(check);
        result.content[0].text = `${prefix}${result.content[0].text}`;
        return result;
      }
      const scenarioName = (params.scenario && params.scenario.name) || path.basename(target, ".json");
      const runID = params.run ? safeRunID(params.run) : `${runStamp(Date.now())}-${scenarioName}`;
      if (fs.existsSync(path.join(RUNS_DIR, runID))) throw new ToolError(`run ${runID} already exists; pass another run`);
      const args = ["run", `--run=${runID}`, ...(params.keepUp ? ["--keep-up"] : []), ...(params.reuse ? ["--reuse"] : []),
        ...(params.world ? [`--world=${params.world}`] : []), "--", target];

      if (params.wait === false) {
        const started = RUNS.startBackground({ cliPath: CLI_PATH, args, runID, scenarioFile: relativePath(target) });
        return textResult(`${prefix}${check.output.split("\n")[0]}\nstarted run ${runID} in the background (pid ${started.pid}); ` +
          `console in ${started.log}.\n${RUNS.detachedText(runID, MAX_WAIT_SECONDS)}`);
      }

      // Auto mode boots only when no server is up; a server it attached to isn't the run's to stop.
      const boots = MANAGED || (MODE === "auto" && !serverUp());
      const reply = await runCli(args, context);
      if (reply.aborted) {
        // A killed CLI can't run its own `down`.
        const down = boots ? (await runCli(["down"])).output : "";
        return textResult(`${prefix}run ${runID} cancelled.\n${tailLines(reply.output, 20)}\n${down}`, true);
      }
      const state = runState(runID);
      if (!state.result) return textResult(`${prefix}${clip(reply.output)}\n(exit ${reply.code}; no report written)`, true);
      const reportPath = path.join(state.dir, "report.md");
      const report = readText(reportPath) || "";
      const console_ = consoleSummary(reply.output);
      const summary = compactSummary(report, OUTPUT_LIMIT - console_.length - prefix.length - 1500, reportPath);
      return textResult(`${prefix}${console_}\n\n${summary}\n\n${filesBlock(state)}`, state.result.exitCode === 2);
    },
  },
  {
    name: "report",
    description: "Read a run's report. Without run: the recent runs and their verdicts. section: summary (default: verdict, " +
      "expected against observed, stop conditions, frames, setup), full (with the timeline), result (result.json), or pr " +
      "(markdown to paste into a PR description, plus the frame files to attach). For a run still going in the background, " +
      "waitSeconds waits up to that long for it to finish. For a plain watch run it gives the last timeline lines.",
    inputSchema: schema({
      run: str("Run ID, or \"latest\"."),
      section: str("What to return (default summary).", { enum: ["summary", "full", "result", "pr"] }),
      waitSeconds: int(`Wait up to this long for a background run to finish (0 to ${MAX_WAIT_SECONDS}).`, { minimum: 0, maximum: MAX_WAIT_SECONDS }),
    }),
    async run(params, context) {
      const reply = await readReport({ run: params.run, section: params.section || "summary",
        waitSeconds: Math.min(MAX_WAIT_SECONDS, Number(params.waitSeconds) || 0), signal: context.signal, onLine: context.onLine });
      return textResult(reply.text, reply.isError);
    },
  },
];

// The plugins' tools (registry.mcpTools), each one CLI command: name
// <plugin>_<tool>, description, inputSchema and args(params).
for (const tool of REGISTRY.mcpTools) {
  if (TOOLS.some((other) => other.name === tool.name)) continue;
  const inputSchema = tool.inputSchema && tool.inputSchema.type === "object"
    ? { properties: {}, required: [], ...tool.inputSchema } : schema();
  TOOLS.push({ name: tool.name, description: String(tool.description || tool.name), inputSchema, run: simple(tool.name) });
}

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// Enough of JSON Schema for these tools: types, enums, bounds and required.
function checkParams(tool, params) {
  const problems = [];
  const { properties, required } = tool.inputSchema;
  for (const key of required) if (params[key] === undefined) problems.push(`${key} is required`);
  for (const [key, value] of Object.entries(params)) {
    const rule = properties[key];
    if (!rule) {
      problems.push(`unknown argument ${key}; ${tool.name} takes ${Object.keys(properties).join(", ") || "none"}`);
      continue;
    }
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = rule.type === "integer" ? Number.isInteger(value) : rule.type === type;
    if (!ok) {
      problems.push(`${key} must be ${rule.type === "integer" ? "an integer" : `a ${rule.type}`}`);
      continue;
    }
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} must be one of ${rule.enum.join(", ")}`);
    if (rule.minimum !== undefined && value < rule.minimum) problems.push(`${key} must be at least ${rule.minimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) problems.push(`${key} must be at most ${rule.maximum}`);
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) problems.push(`${key} must be above ${rule.exclusiveMinimum}`);
  }
  return problems;
}

async function callTool(name, params = {}, context = {}) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return null;
  const problems = checkParams(tool, params);
  if (problems.length) return textResult(`${name}: ${problems.join("; ")}`, true);
  const full = { signal: context.signal, onLine: context.onLine || (() => {}) };
  try {
    return await tool.run(params, full);
  } catch (error) {
    return textResult(`${name}: ${error instanceof ToolError ? error.message : error.stack || error}`, true);
  }
}

// ---------- the protocol ----------

function createServer({ write, log = () => {} }) {
  const inFlight = new Map();
  const send = (message) => write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  async function handleCall(id, params) {
    const name = params && params.name;
    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) {
      fail(id, -32602, `unknown tool: ${name}`);
      return;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    const token = params._meta && params._meta.progressToken;
    let progress = 0;
    let lastSentMs = 0;
    const onLine = (line) => {
      if (token === undefined) return;
      progress += 1;
      const now = Date.now();
      if (now - lastSentMs < 1000) return;
      lastSentMs = now;
      send({ method: "notifications/progress", params: { progressToken: token, progress, message: line.slice(0, 300) } });
    };
    try {
      const result = await callTool(name, params.arguments || {}, { signal: controller.signal, onLine });
      if (!controller.signal.aborted) reply(id, result);
    } finally {
      inFlight.delete(id);
    }
  }

  function handle(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      fail(null, -32600, "not a JSON-RPC 2.0 message");
      return null;
    }
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    if (!method) return null; // a response to nothing we sent
    switch (method) {
      case "initialize": {
        const asked = params && params.protocolVersion;
        reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
        return null;
      }
      case "ping":
        reply(id, {});
        return null;
      case "tools/list":
        reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        return null;
      case "tools/call":
        return handleCall(id, params || {}).catch((error) => {
          log(`tools/call failed: ${error.stack || error}`);
          fail(id, -32603, String(error.message || error));
        });
      case "notifications/cancelled": {
        const controller = params && inFlight.get(params.requestId);
        if (controller) controller.abort();
        return null;
      }
      default:
        if (isRequest) fail(id, -32601, `method not found: ${method}`);
        return null;
    }
  }

  function receive(line) {
    if (!line.trim()) return null;
    let message;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      fail(null, -32700, "parse error");
      return null;
    }
    return handle(message);
  }

  return {
    receive,
    pending: () => [...inFlight.values()],
  };
}

function main() {
  const server = createServer({
    write: (text) => process.stdout.write(text),
    log: (text) => process.stderr.write(`gridcheck mcp: ${text}\n`),
  });
  const work = new Set();
  let carry = "";
  process.stdin.on("data", (chunk) => {
    const lines = (carry + chunk.toString("utf8")).split(/\r?\n/);
    carry = lines.pop();
    for (const line of lines) {
      const pending = server.receive(line);
      if (pending) {
        work.add(pending);
        pending.finally(() => work.delete(pending));
      }
    }
  });
  // The client went away: stop what is running and let foreground runs shut
  // their server down before exiting.
  process.stdin.on("end", async () => {
    for (const controller of server.pending()) controller.abort();
    await Promise.race([Promise.allSettled([...work]), sleep(120_000)]);
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = {
  INSTRUCTIONS,
  TOOLS,
  callTool,
  checkParams,
  cliArgs,
  committedScenario,
  createServer,
  instructions,
  prCitation,
  reportSections,
  resolveScenario,
};
