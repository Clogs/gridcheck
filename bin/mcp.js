#!/usr/bin/env node
"use strict";

// MCP server over the e2e CLI. Every tool runs `node tools/evejs-e2e/bin/e2e.js
// <command>` in this tree and returns what it printed, so the CLI stays the
// source of truth and anything a tool did can be repeated in a shell. The
// only things it does itself are writing a scenario file it was handed,
// running a scenario in the background, and reading a run's report files.
// MCP over stdio (JSON-RPC, one message per line), no dependencies and no
// listener. Registered in .mcp.json. Guide: docs/E2E-GRID-TESTING.md
// "Agent MCP tools".

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { formatOffset, formatTimelineEvent } = require("../core/timeline");
const { DEFAULT_TREE_ROOT, defaultRegistry } = require("../core/plugins");
const { kindsOf } = require("../core/conditions");
const { TREE_SCENARIO_DIR, scenarioDirs } = require("../core/scenario");
const { defaultTreeConfig } = require("../core/treeConfig");

const REPO_ROOT = DEFAULT_TREE_ROOT;
const REGISTRY = defaultRegistry();
const CONFIG = defaultTreeConfig();
const MANAGED = CONFIG.mode === "managed";
const CLI_PATH = path.join(__dirname, "e2e.js");
const E2E_DIR = CONFIG.e2eDir;
const RUNS_DIR = CONFIG.runsDir;
const BACKGROUND_DIR = path.join(E2E_DIR, "mcp");
const DRAFT_DIR = path.join(E2E_DIR, "scenarios");

const SERVER_INFO = { name: "e2e", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// Claude Code warns above 10,000 tokens of tool output. The full text is
// always in a file the reply names.
const OUTPUT_LIMIT = 20_000;
const WATCH_DEFAULT_SECONDS = 60;
const MAX_WAIT_SECONDS = 600;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// The core's instructions, then each plugin's primer.
function instructions(registry = REGISTRY) {
  const upKeys = ["market", "timeout", ...registry.upFlags.map((flag) => flag.key)].join(", ");
  const pluginSteps = Object.keys(registry.steps);
  const kinds = kindsOf(registry).filter((kind) => !["CLIENT", "FX", "DIVERGE"].includes(kind)).join(" ");
  const pluginTools = registry.mcpTools.map((tool) => tool.name);
  const core = `End-to-end grid testing for EveJS with no EVE client. A server boots from a saved world; a character logs in through the web gateway, undocks, and you read its grid, run slash commands, act as the player and watch what happens as a timeline. Every tool runs the CLI \`node tools/evejs-e2e/bin/e2e.js\` in this tree; the guide is docs/E2E-GRID-TESTING.md.

Start with e2e_status: it shows whether this tree's server is up, the saved worlds, the scenarios and the plugins that are active. e2e_doctor says what this tree supports: the gateway calls, the client view, the optional patches and the ports.

${MANAGED
    ? "This tree is in managed mode: the CLI boots and stops its server (e2e_up, e2e_down), and a run boots its own world, so call e2e_down first if the server is up."
    : "This tree is in attach mode: its server is started by hand with EVEJS_AGENT_BRIDGE=1 set, and the tools work on that live server. e2e_up and e2e_down refuse, and a run uses the server as it is: its world is not restored and the server stays up. If no server is up, ask the user to start one."}

To verify a feature, write a scenario and run it (e2e_run_scenario). A scenario is JSON:
{ "description": "...", "world": "<a saved world e2e_status lists, or fresh>",
  "setup": ["undock", { "teleport": "Siseide" }, { "slash": "/gaterats on" }, { "waitFor": "ARRIVE who=npc", "timeout": 120 }],
  "until": { "any": ["DESTROYED self"], "timeout": 300, "grace": 10 },
  "expect": ["ARRIVE who=npc", { "match": "TARGET self locked", "note": "why it matters" }, "no DIVERGE status=open"] }
- up: ${upKeys}.
- setup steps: "login" (implicit), "undock", "dock", { "slash": "/heal" }, { "teleport": "Amamake" }, { "wait": 30 }, { "waitFor": "<condition>", "timeout": 300 }${pluginSteps.length ? `, and the plugins' ${pluginSteps.join(", ")}` : ""}.
- player actions are steps too, in setup and in "during" (a second list that runs after setup, beside the stop conditions, and stops when the run stops): { "lock": "<target>", "as": "mark", "timeout": 30 }, { "activate": "weapons", "target": "$mark", "once": false }, { "deactivate": "weapons" }, { "orbit": "<target>", "range": 5000 }, { "approach": "<target>" }, { "keepAtRange": "<target>", "range": 10000 }, { "warpTo": "<target>", "range": 0 }, "stop", { "unlock": "<target>" }, { "loadAmmo": "weapons", "charge": "EMP S" }, { "launchDrones": "all", "count": 5 }, { "engageDrones": "<target>" }; each also takes "retry". A target is the nearest ball passing every term: "nearest npc", "name~Scout", "type~Rifter", "kind=station", "within=30km", "player", "$mark", an itemID. "as" on a lock binds the ball. Shots show as TARGET sourceLabel=self, FX self (needs "watch": { "client": "fx" }) and DAMAGE itemID=$mark.
- until: any (stop conditions), timeout (s after setup, required), grace (s more after a stop), from ("setup" default: only events after setup count; "start": setup's own events count, e.g. the GRID an undock causes).
- expect: conditions that should be seen; "no <condition>" expects none. A missing one fails the run (exit 1) but the run keeps watching.
- Conditions: KIND then field tests. Kinds: ${kinds}, and CLIENT (needs "watch": { "client": "all" }), FX (needs "client": "fx" or "all") and DIVERGE. Tests: field=value, field!=value, field~regex, field>=N (also > < <=), bare field (set), !field (unset). Units: 30km, 90s, 5min. "self" = about your ship. $name = IDs a step bound with "as". A field is looked up on the event, then one level down. Field names are the ones e2e_watch with json:true prints; a check lists a kind's fields when you name a wrong one.
Write the file with e2e_run_scenario { name, scenario, check: true } first: that validates without booting. save:true writes it to ${relativePath(TREE_SCENARIO_DIR)}/ to commit with the feature; otherwise it goes to ${relativePath(DRAFT_DIR)}/.

Runs take minutes (boot about 25 s, then real-time grid behaviour). wait:false starts one in the background; e2e_report { run, waitSeconds } waits for it and reads the verdict. e2e_report { run, section: "pr" } gives the markdown to cite the run in a PR description.

By hand: e2e_up { world }, e2e_login, e2e_undock, e2e_grid, e2e_act, e2e_watch { seconds }, e2e_slash, e2e_teleport, e2e_log, e2e_down${pluginTools.length ? `, and the plugins' ${pluginTools.join(", ")}` : ""}. A person can replay any run, or follow a live one, in the viewer: \`node tools/evejs-e2e/bin/e2e.js view [<run>]\` prints its URL. Calling e2e_watch and an action in the same turn lets you see its effect. Replies are the CLI's own output, so a message naming a command such as \`e2e login\` means the tool e2e_login.`;
  return [core, ...registry.primers.map((primer) => primer.text)].join("\n\n");
}

const INSTRUCTIONS = instructions();

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

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
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

// Same form as the CLI's run IDs.
function runStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function safeRunID(text) {
  return String(text).replace(/[^A-Za-z0-9._-]/g, "_");
}

function clip(text, limit = OUTPUT_LIMIT, where = "") {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.3);
  return `${text.slice(0, head)}\n... ${text.length - limit} characters cut` +
    `${where ? `; the full text is in ${where}` : ""} ...\n${text.slice(-(limit - head))}`;
}

function tailLines(text, count) {
  return String(text || "").trimEnd().split("\n").slice(-count).join("\n");
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
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
  e2e_up(p) {
    const { args, flag } = argList("up");
    flag("world", p.world);
    flag("fresh", p.fresh);
    flag("no-market", p.market === false);
    for (const upFlag of REGISTRY.upFlags) flag(upFlag.flag, p[upFlag.key]);
    flag("timeout", p.timeout);
    return args;
  },
  e2e_down(p) {
    const { args, flag } = argList("down");
    flag("force", p.force);
    return args;
  },
  e2e_login(p) {
    const { args, flag } = argList("login");
    flag("user", p.user);
    flag("name", p.name);
    return args;
  },
  e2e_undock: () => ["undock"],
  e2e_teleport: (p) => ["teleport", "--", String(p.system)],
  e2e_grid(p) {
    const { args, flag } = argList("grid");
    flag("range", p.range);
    flag("all", p.all);
    flag("json", p.json);
    return args;
  },
  e2e_slash: (p) => ["slash", "--", String(p.command)],
  e2e_watch(p) {
    const { args, flag } = argList("watch");
    flag("for", p.seconds === undefined ? WATCH_DEFAULT_SECONDS : p.seconds);
    flag("every", p.every);
    flag("offgrid-every", p.offgridEvery);
    flag("grep", p.grep);
    flag("no-log", p.log === false);
    flag("client", p.client);
    flag("diverge-meters", p.divergeMeters);
    flag("positions", p.positions);
    flag("run", p.run);
    flag("json", p.json);
    return args;
  },
  // The same argument names as a scenario's action step (scenario.js).
  e2e_act(p) {
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
  e2e_log(p) {
    const { args, flag } = argList("log");
    flag("grep", p.grep);
    flag("lines", p.lines);
    flag("any-pid", p.anyPid);
    return args;
  },
  e2e_doctor(p) {
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
// draft the MCP wrote; a path is a path.
function resolveScenario(name) {
  const text = String(name);
  if (text.endsWith(".json") || text.includes("/") || text.includes("\\")) return path.resolve(REPO_ROOT, text);
  const tree = scenarioDirs({ registry: REGISTRY }).map(({ dir }) => path.join(dir, `${text}.json`));
  const found = tree.find((file) => fs.existsSync(file));
  if (found) return found;
  const draft = path.join(DRAFT_DIR, `${text}.json`);
  return fs.existsSync(draft) ? draft : tree[0];
}

// A scenario committed with the tree or the tool, which a reviewer can rerun by name.
function committedScenario(scenarioFile) {
  const file = String(scenarioFile || "");
  return file.startsWith(`${relativePath(TREE_SCENARIO_DIR)}/`) || file.startsWith("tools/evejs-e2e/scenarios/") ||
    /^tools\/evejs-e2e\/plugins\/[^/]+\/scenarios\//.test(file);
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

function backgroundRecord(runID) {
  return readJSON(path.join(BACKGROUND_DIR, `${runID}.json`));
}

function runState(runID) {
  const dir = path.join(RUNS_DIR, runID);
  const result = readJSON(path.join(dir, "result.json"));
  const background = backgroundRecord(runID);
  return {
    runID,
    dir,
    exists: fs.existsSync(dir),
    result,
    background,
    running: !result && Boolean(background && pidAlive(background.pid)),
    hasTimeline: fs.existsSync(path.join(dir, "timeline.jsonl")),
  };
}

function verdictOf(result) {
  if (!result) return null;
  return result.failure ? "DID NOT COMPLETE" : result.exitCode === 1 ? "FAILED" : "PASSED";
}

function recentRuns(limit = 15) {
  let names = [];
  try {
    names = fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (_error) {
    return [];
  }
  return names
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(RUNS_DIR, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map(({ name, mtimeMs }) => {
      const state = runState(name);
      const met = state.result ? state.result.expectations.filter((row) => row.met).length : 0;
      const what = state.result
        ? `${verdictOf(state.result)} ${met}/${state.result.expectations.length}  ${state.result.name}`
        : state.running ? "running"
          : state.hasTimeline ? "watch, no report" : "no timeline";
      return { name, mtimeMs, text: `${new Date(mtimeMs).toISOString().slice(0, 16)}  ${name.padEnd(36)} ${what}` };
    });
}

function frameWhy(frame) {
  return `${frame.reason}${frame.stop && frame.reason !== "stop" ? " + stop" : ""}`;
}

function frameLines(state) {
  const frames = (state.result && Array.isArray(state.result.frames)) ? state.result.frames : [];
  if (!frames.length) return [];
  return [`- frames (SVG; render a PNG with headless Chrome, see the guide):`,
    ...frames.map((frame) => `  - ${path.join(state.dir, frame.file)}  ${frameWhy(frame)}`)];
}

function filesBlock(state) {
  return [
    "Files:",
    `- report: ${path.join(state.dir, "report.md")}`,
    `- result: ${path.join(state.dir, "result.json")}`,
    `- timeline: ${path.join(state.dir, "timeline.jsonl")}`,
    ...frameLines(state),
  ].join("\n");
}

// report.md split at its "## " headings.
function reportSections(text) {
  const sections = { head: [] };
  let current = "head";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      sections[current] = [];
    }
    sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join("\n").trim()]));
}

function reportSummary(report) {
  const index = report.indexOf("\n## Timeline");
  return index >= 0 ? `${report.slice(0, index).trimEnd()}\n\n(The timeline is left out; section "full" has it.)` : report;
}

// Markdown to paste into a PR description: what ran, on what, and what was
// seen. Frame links in report.md are relative to the run dir, so they are
// listed as files to attach instead.
function prCitation(state, report) {
  const result = state.result;
  const sections = reportSections(report);
  const verdictLine = sections.head.split("\n").find((line) => /expectations met\./.test(line)) || "";
  const scenarioFile = String(result.scenarioFile || "");
  const inTree = committedScenario(scenarioFile);
  const reproduce = inTree ? path.basename(scenarioFile, ".json") : scenarioFile || result.name;
  const commit = result.commit
    ? `\`${result.commit.sha}\`${result.commit.dirty ? " plus uncommitted changes" : ""}`
    : "(commit not recorded: run before the CLI recorded it)";
  const seconds = Math.round((result.stoppedAtMs - result.startedAtMs) / 1000);
  const frames = (Array.isArray(result.frames) ? result.frames : []);
  const lines = [
    `### End-to-end check \`${result.name}\`: ${verdictOf(result)}`,
    "",
    `Run \`${state.runID}\` of \`${scenarioFile || result.name}\` on commit ${commit}, ` +
      `from world \`${result.world}\`, ${seconds} s including boot and shutdown.`,
    "",
    verdictLine,
    "",
  ];
  if (sections["Expected against observed"]) lines.push(sections["Expected against observed"].replace(/^## /, "#### "), "");
  if (frames.length) {
    lines.push("#### Tactical frames", "");
    lines.push("| t | Why | Frame |", "| --- | --- | --- |");
    for (const frame of frames) {
      lines.push(`| ${formatOffset(frame.t || 0)} | ${frameWhy(frame)} | ${path.basename(frame.file)} (attached) |`);
    }
    lines.push("");
  }
  lines.push(`Reproduce: \`node tools/evejs-e2e/bin/e2e.js run ${reproduce}\`.`);
  const attach = frames.map((frame) => path.join(state.dir, frame.file));
  return [
    lines.join("\n"),
    "",
    "---",
    ...(inTree ? [] : [`The scenario is not in tools/e2e-scenarios/, so a reviewer can't rerun it. Save it there ` +
      "(e2e_run_scenario with save: true) and commit it with the feature."]),
    `Paste the markdown above. Attach these, or PNGs rendered from them, so reviewers see the frames:`,
    ...(attach.length ? attach.map((file) => `- ${file}`) : ["- (no frames in this run)"]),
    `Full report: ${path.join(state.dir, "report.md")}. _local/ is not committed, so don't link into it.`,
  ].join("\n");
}

function lastTimelineLines(state, count = 60) {
  const text = readText(path.join(state.dir, "timeline.jsonl")) || "";
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.kind !== "POS") events.push(event);
    } catch (_error) {
      // A line cut off by a watch still writing.
    }
  }
  return events.slice(-count).map((event) => formatTimelineEvent(event)).join("\n");
}

function describeRunning(state) {
  const background = state.background;
  const log = readText(path.join(REPO_ROOT, background.log)) || "";
  const seconds = Math.round((Date.now() - background.startedAtMs) / 1000);
  return `run ${state.runID} is still running (pid ${background.pid}, ${seconds} s so far). ` +
    `Call e2e_report again with waitSeconds to wait for it.\nLast lines of its console (${background.log}):\n` +
    tailLines(log, 30);
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
    name: "e2e_status",
    description: "Where things stand in this tree: whether the e2e server is up (pid, ports, boot time), the held character, " +
      "the saved worlds a run can start from, the scenarios (the tree's tools/e2e-scenarios, the tool's and its plugins', and drafts in _local/e2e/scenarios), " +
      "background runs, and the most recent runs. Call this first.",
    inputSchema: schema(),
    async run(_params, context) {
      const parts = [];
      for (const [title, args] of [["Server", ["status"]], ["Saved worlds", ["world", "list"]], ["Scenarios", ["run"]]]) {
        const reply = await runCli(args, context);
        parts.push(`## ${title}\n${reply.output}`);
      }
      let drafts = [];
      try {
        drafts = fs.readdirSync(DRAFT_DIR).filter((name) => name.endsWith(".json")).map((name) => path.basename(name, ".json"));
      } catch (_error) {
        drafts = [];
      }
      if (drafts.length) parts.push(`## Draft scenarios (${relativePath(DRAFT_DIR)})\n${drafts.join("\n")}`);
      const runs = recentRuns(10);
      const running = runs.filter((row) => runState(row.name).running);
      if (running.length) parts.push(`## Background runs still going\n${running.map((row) => row.name).join("\n")}`);
      if (runs.length) parts.push(`## Recent runs\n${runs.map((row) => row.text).join("\n")}`);
      return textResult(parts.join("\n\n"));
    },
  },
  {
    name: "e2e_up",
    description: "Managed mode only. Start this tree's server (and market daemon) in the background and wait until a character can log in, " +
      "about 25 s warm. For grid checks pass world (a saved world e2e_status lists). Without world or fresh it keeps " +
      "the current world. Refuses if the server is already up. e2e_run_scenario does its own up and down, so don't " +
      "call this before a run.",
    inputSchema: schema({
      world: str("Saved world to restore before boot (e2e_status lists them)."),
      fresh: bool("Drop the game store; the boot seeds a new world from the reference data."),
      market: bool("Start the market daemon (default true)."),
      ...Object.fromEntries(REGISTRY.upFlags.map((flag) => [flag.key, flag.type === "bool"
        ? bool(flag.description || `--${flag.flag}`)
        : num(flag.description || `--${flag.flag}`, { minimum: flag.min, maximum: flag.max })])),
      timeout: int("Seconds to wait for boot (default 600).", { minimum: 10 }),
    }),
    run: simple("e2e_up"),
  },
  {
    name: "e2e_down",
    description: "Stop this tree's server cleanly (store flushed, world lease released) and its market daemon. " +
      "Also ends a background run early: its watch ends and it writes its report.",
    inputSchema: schema({ force: bool("Kill a server that is still booting and has no agent bridge yet.") }),
    run: simple("e2e_down"),
  },
  {
    name: "e2e_login",
    description: "Log the test character in through the web gateway (account e2eagent, character Agent Observer by default). " +
      "Needed once after e2e_up, before undock, grid, slash, teleport, act or watch.",
    inputSchema: schema({ user: str("Account name (default e2eagent)."), name: str("Character name (default the account's first).") }),
    run: simple("e2e_login"),
  },
  {
    name: "e2e_undock",
    description: "Undock the logged-in character's ship. Undocking puts the session in the system's scene, so the system " +
      "counts as observed. The ship has undock protection for a while.",
    inputSchema: schema(),
    run: simple("e2e_undock"),
  },
  {
    name: "e2e_teleport",
    description: "Teleport the ship to a system with stock /tr.",
    inputSchema: schema({
      system: str("Solar system name or ID, e.g. Amamake."),
    }, ["system"]),
    run: simple("e2e_teleport"),
  },
  {
    name: "e2e_grid",
    description: "The ship's grid now, as a table: distance, name, type, NPC kind, mode, target and shield/armour/hull, " +
      "nearest first, with the ship's protection countdown.",
    inputSchema: schema({
      range: num("Cut-off in km (default 10,000).", { exclusiveMinimum: 0 }),
      all: bool("Everything the session can see."),
      json: bool("The bridge's full reply as JSON (field names match scenario conditions)."),
    }),
    run: simple("e2e_grid"),
  },
  {
    name: "e2e_slash",
    description: "Run a slash command on the character's own session, as if typed in game chat, e.g. \"/tr me 30002537\", " +
      "\"/heal\", \"/dock\", \"/npc 3\", \"/ship Rifter\". Returns the command's reply. A refused command is an error.",
    inputSchema: schema({ command: str("The command line, starting with /.") }, ["command"]),
    run: simple("e2e_slash"),
  },
  {
    name: "e2e_watch",
    description: "Watch the ship's grid and system for a number of seconds and return what changed, one line per event: " +
      `${kindsOf(REGISTRY).filter((kind) => !["GRID", "CLIENT", "FX"].includes(kind)).join(", ")} and more, with what the ` +
      "active plugins know about each NPC. The call blocks for the whole watch. To see an action's effect, call it in " +
      "the same turn. The timeline is also written to _local/e2e/runs/<id>/timeline.jsonl.",
    inputSchema: schema({
      seconds: int(`How long to watch (default ${WATCH_DEFAULT_SECONDS}; the CLI's own default is 600).`, { minimum: 1, maximum: 3000 }),
      every: num("Grid sample interval, seconds (default 2).", { exclusiveMinimum: 0 }),
      offgridEvery: num("Off-grid scan interval, seconds (default 5).", { exclusiveMinimum: 0 }),
      client: str("What the client was sent: all (default), fx (DIVERGE plus special effects such as weapons firing), " +
        "diverge (only DIVERGE lines) or off.", { enum: ["all", "fx", "diverge", "off"] }),
      divergeMeters: num("Position error that counts as DIVERGE (default 5000).", { exclusiveMinimum: 0 }),
      positions: bool("Record ball positions too, so the viewer (e2e view) can draw this watch."),
      grep: str("Keep every server log line matching this regex instead of the default NPC and plugin lines."),
      log: bool("Include server log lines (default true)."),
      json: bool("Print events as JSON lines, with the field names scenario conditions use."),
      run: str("Run ID for the timeline directory (default: the start time)."),
    }),
    run: simple("e2e_watch"),
  },
  {
    name: "e2e_act",
    description: "Act as the player, through the calls the web gateway allows a client: fly, lock, switch modules on and " +
      "off, load ammo and use drones. The server applies every rule (range, lock time, capacitor, ammo) and a refusal " +
      "is in its own words. A target is the nearest ball on grid that passes every term: \"nearest npc\", " +
      "\"name~Scout\", \"type~Rifter\", \"kind=station\", \"within=30km\", \"player\" or an itemID" +
      `${Object.keys(REGISTRY.targetFields).length ? `, and the plugins' ${Object.keys(REGISTRY.targetFields).map((term) => `${term}=`).join(", ")}` : ""}. ` +
      "Modules: weapons (default), high, mid, low, all, name~..., group~..., " +
      "an itemID. Watch the effect with e2e_watch in the same turn (client: \"fx\" shows the guns firing).",
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
    run: simple("e2e_act"),
  },
  {
    name: "e2e_log",
    description: "The tail of the server log, only the running server's lines unless anyPid.",
    inputSchema: schema({
      grep: str("Case-insensitive regex, e.g. NpcController."),
      lines: int("How many lines (default 40).", { minimum: 1, maximum: 2000 }),
      anyPid: bool("Keep every process's lines."),
    }),
    run: simple("e2e_log"),
  },
  {
    name: "e2e_doctor",
    description: "What this tree can do for the tool: which gateway calls the CLI makes it allows, whether the client " +
      "view can run (the destiny layout check), which optional patches it has, which plugins are active or skipped and " +
      "why, and which ports can move. Asks the running server when there is one, else reads the tree's files.",
    inputSchema: schema({
      offline: bool("Read the tree's files even when a server is up."),
      json: bool("The whole report as JSON."),
    }),
    run: simple("e2e_doctor"),
  },
  {
    name: "e2e_run_scenario",
    description: (MANAGED
      ? "Run a scenario: boot its world, run setup, watch until a stop condition, shut down, and write a "
      : "Run a scenario on the live server (attach mode: its world is not restored and the server stays up): run setup, " +
        "watch until a stop condition, and write a ") +
      "report of expected against observed with tactical frames. Pass name to run a scenario file, or name and scenario " +
      "(the JSON object) to write one first. check: true only validates it, which boots nothing; do that first. " +
      (MANAGED ? "The server must be down (e2e_down). " : "") +
      "A run takes minutes; wait: false returns at once and e2e_report waits. " +
      "The scenario format is in this server's instructions and docs/E2E-GRID-TESTING.md \"Scenarios\".",
    inputSchema: schema({
      name: str("A scenario in tools/e2e-scenarios, tools/evejs-e2e/scenarios, a plugin's scenarios or _local/e2e/scenarios (without .json), or a path. With scenario: the file name to write."),
      scenario: { type: "object", description: "The scenario JSON to write as <name>.json before checking or running it." },
      save: bool("With scenario: write it to tools/e2e-scenarios/ (to commit with the feature) instead of _local/e2e/scenarios/."),
      check: bool("Only load and check the scenario; boot nothing."),
      run: str("Run ID (default: start time and scenario name). Must be new."),
      keepUp: bool("Leave the server running after the run, to look around with the other tools."),
      world: str("Managed mode: boot this saved world (or fresh) instead of the scenario's."),
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
        throw new ToolError("pass name (a scenario file), or name and scenario (the JSON to write); e2e_status lists scenarios");
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
      const args = ["run", `--run=${runID}`, ...(params.keepUp ? ["--keep-up"] : []),
        ...(params.world ? [`--world=${params.world}`] : []), "--", target];

      if (params.wait === false) {
        fs.mkdirSync(BACKGROUND_DIR, { recursive: true });
        const logPath = path.join(BACKGROUND_DIR, `${runID}.log`);
        const out = fs.openSync(logPath, "w");
        const child = spawn(process.execPath, [CLI_PATH, ...args], {
          cwd: REPO_ROOT,
          detached: true,
          stdio: ["ignore", out, out],
          windowsHide: true,
        });
        child.unref();
        fs.closeSync(out);
        fs.writeFileSync(path.join(BACKGROUND_DIR, `${runID}.json`), `${JSON.stringify({
          runID, pid: child.pid, startedAtMs: Date.now(), scenario: relativePath(target), log: relativePath(logPath), args,
        }, null, 2)}\n`);
        return textResult(`${prefix}${check.output.split("\n")[0]}\nstarted run ${runID} in the background (pid ${child.pid}); ` +
          `console in ${relativePath(logPath)}.\nCall e2e_report with run "${runID}" and waitSeconds (up to ${MAX_WAIT_SECONDS}) ` +
          "to wait for it and read the verdict.");
      }

      const reply = await runCli(args, context);
      if (reply.aborted) {
        // A killed CLI can't run its own `down`. In attach mode the server isn't the run's to stop.
        const down = MANAGED ? (await runCli(["down"])).output : "";
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
    name: "e2e_report",
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
      if (!params.run) {
        const runs = recentRuns(15);
        return textResult(runs.length ? `Recent runs, newest first:\n${runs.map((row) => row.text).join("\n")}` : "no runs yet");
      }
      const runID = params.run === "latest" ? (recentRuns(1)[0] || {}).name : safeRunID(params.run);
      if (!runID) return textResult("no runs yet", true);
      let state = runState(runID);
      const deadline = Date.now() + Math.min(MAX_WAIT_SECONDS, Number(params.waitSeconds) || 0) * 1000;
      let lastLine = "";
      while (state.running && Date.now() < deadline && !(context.signal && context.signal.aborted)) {
        await sleep(2000, context.signal);
        const line = tailLines(readText(path.join(REPO_ROOT, state.background.log)) || "", 1);
        if (line && line !== lastLine) context.onLine(line);
        lastLine = line;
        state = runState(runID);
      }
      if (state.running) return textResult(describeRunning(state));
      if (!state.result) {
        if (state.background) {
          const log = readText(path.join(REPO_ROOT, state.background.log)) || "";
          return textResult(`run ${runID} ended without a report. Last lines of its console (${state.background.log}):\n` +
            tailLines(log, 40), true);
        }
        if (state.hasTimeline) {
          return textResult(`${runID} is a watch with no report. Last timeline lines:\n${lastTimelineLines(state)}\n\n` +
            `Timeline: ${path.join(state.dir, "timeline.jsonl")}`);
        }
        const runs = recentRuns(10);
        return textResult(`no run ${runID}. Recent runs:\n${runs.map((row) => row.text).join("\n")}`, true);
      }
      const reportPath = path.join(state.dir, "report.md");
      const report = readText(reportPath) || "";
      switch (params.section || "summary") {
        case "full": return textResult(clip(report, OUTPUT_LIMIT, reportPath));
        case "result": return textResult(clip(JSON.stringify(state.result, null, 2)));
        case "pr": return textResult(prCitation(state, report));
        default: return textResult(`${clip(reportSummary(report))}\n\n${filesBlock(state)}`);
      }
    },
  },
];

// The plugins' tools (registry.mcpTools), each one CLI command: name
// e2e_<plugin>_<tool>, description, inputSchema and args(params).
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
    log: (text) => process.stderr.write(`e2e mcp: ${text}\n`),
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
