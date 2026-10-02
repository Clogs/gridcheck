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
const { primer } = require("../core/primer");
const { createRuns, clip, readText, reportSections, reportSummary, runStamp, safeRunID, sleep, tailLines } = require("../core/runs");

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

// The core's instructions, then each plugin's primer (core/primer.js).
function instructions(registry = REGISTRY) {
  return primer({ registry, mode: MODE, surface: "mcp",
    scenarioDirs: { tree: relativePath(TREE_SCENARIO_DIR), drafts: relativePath(DRAFT_DIR) } });
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
  undock: () => ["undock"],
  teleport: (p) => ["teleport", "--", String(p.system)],
  grid(p) {
    const { args, flag } = argList("grid");
    flag("range", p.range);
    flag("all", p.all);
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
};

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
      "nearest first, with the ship's protection countdown.",
    inputSchema: schema({
      range: num("Cut-off in km (default 10,000).", { exclusiveMinimum: 0 }),
      all: bool("Everything the session can see."),
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
      "is in its own words. A target is the nearest ball on grid that passes every term: \"nearest npc\", " +
      "\"name~Scout\", \"type~Rifter\", \"kind=station\", \"within=30km\", \"player\" or an itemID" +
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
      "The scenario format is in this server's instructions and docs/GUIDE.md \"Scenarios\".",
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
      const report = readText(path.join(state.dir, "report.md")) || "";
      const console_ = clip(reply.output, 4000, path.join(state.dir, "timeline.jsonl"));
      return textResult(`${prefix}${console_}\n\n${clip(reportSummary(report), OUTPUT_LIMIT - 6000)}\n\n${filesBlock(state)}`,
        state.result.exitCode === 2);
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
