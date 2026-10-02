"use strict";

// bin/mcp.js: the MCP server over the gridcheck CLI. Covers the CLI argument
// mapping, argument checks, the JSON-RPC protocol, the PR citation, and one
// real stdio session that spawns the CLI without booting anything. Live runs
// through the tools are in docs/GUIDE.md "Agent MCP tools".

const test = require("node:test");
const assert = require("node:assert");
const { needsPlugin } = require("./tree");
const { spawn } = require("node:child_process");
const path = require("node:path");

const mcp = require("../bin/mcp");
const { renderReport } = require("../core/scenario");

const MCP_PATH = path.resolve(__dirname, "..", "bin", "mcp.js");

// These read the lu plugin through the default registry, so they need a tree
// it applies to: the fixture tree npm test names, or one with the mod.
const LU = needsPlugin("lu");

test("the spec's tools are listed, plugin tools named for their plugin, each with an object schema", LU, () => {
  const names = mcp.TOOLS.map((tool) => tool.name);
  for (const name of ["up", "down", "grid", "slash", "watch", "lu_trigger", "run_scenario", "report"]) {
    assert.ok(names.includes(name), `${name} is listed`);
  }
  for (const tool of mcp.TOOLS) {
    assert.strictEqual(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 40, `${tool.name} says what it does`);
  }
});

test("tools map onto CLI arguments; free text goes after --", LU, () => {
  assert.deepStrictEqual(mcp.cliArgs("up", { world: "lowsec-docked", realClock: true, market: false, offgridTravel: 5 }),
    ["up", "--world=lowsec-docked", "--no-market", "--real-clock", "--offgrid-travel=5"], "the lu plugin's up flags too");
  assert.deepStrictEqual(mcp.cliArgs("up", {}), ["up"]);
  assert.deepStrictEqual(mcp.cliArgs("slash", { command: "/tr me --weird Amamake" }), ["slash", "--", "/tr me --weird Amamake"]);
  assert.deepStrictEqual(mcp.cliArgs("teleport", { system: "New Caldari" }), ["teleport", "--", "New Caldari"]);
  assert.deepStrictEqual(mcp.cliArgs("watch", {}), ["watch", "--for=60"], "a shorter default than the CLI's 600 s");
  assert.deepStrictEqual(mcp.cliArgs("watch", { seconds: 30, log: false, client: "diverge", grep: "--x" }),
    ["watch", "--for=30", "--grep=--x", "--no-log", "--client=diverge"]);
  assert.deepStrictEqual(mcp.cliArgs("grid", { range: 100, json: true }), ["grid", "--range=100", "--json"]);
  assert.deepStrictEqual(mcp.cliArgs("log", { grep: "PirateHunt", lines: 5, anyPid: true }),
    ["log", "--grep=PirateHunt", "--lines=5", "--any-pid"]);
  assert.deepStrictEqual(mcp.cliArgs("down", { force: true }), ["down", "--force"]);
});

test("the lu plugin's trigger tool uses the scenario step's names", LU, () => {
  assert.deepStrictEqual(mcp.cliArgs("lu_trigger", { name: "scout", system: "Amamake", flight: "f1" }),
    ["trigger", "--flight=f1", "--", "scout", "Amamake"]);
  assert.deepStrictEqual(mcp.cliArgs("lu_trigger", { name: "hunt", phase: "committed" }),
    ["trigger", "--phase=committed", "--", "hunt"]);
  assert.deepStrictEqual(mcp.cliArgs("lu_trigger", { name: "fleet", family: "pirate", doctrine: "sanshas", to: "self", count: 2 }),
    ["trigger", "--doctrine=sanshas", "--to=self", "--count=2", "--", "fleet", "pirate"]);
  assert.deepStrictEqual(mcp.cliArgs("lu_trigger", { name: "materialize", flight: "f7", go: true }),
    ["trigger", "--go", "--", "materialize", "f7"], "materialize takes the flight as its positional");
  assert.deepStrictEqual(mcp.cliArgs("lu_trigger", { name: "skirmish", count: 5, shipClass: "cruiser", gap: 10000 }),
    ["trigger", "--count=5", "--class=cruiser", "--gap=10000", "--", "skirmish"]);
  assert.throws(() => mcp.cliArgs("trigger", {}), /no CLI command for trigger/, "no core trigger tool");
});

test("the instructions are a brief clients won't cut off; the guide tool has the rest by topic", LU, async () => {
  const { emptyRegistry, defaultRegistry } = require("../core/plugins");
  const { BRIEF_LIMIT, primer } = require("../core/primer");
  assert.ok(mcp.INSTRUCTIONS.length <= BRIEF_LIMIT, `${mcp.INSTRUCTIONS.length} characters`);
  assert.match(mcp.INSTRUCTIONS, /read `guide` \{ topic \}: "start" .*"scenarios" .*"events" .*"plugins" \(notes from lu\)/);
  assert.match(mcp.INSTRUCTIONS, /`run_scenario` \{ name, scenario, check: true \}/);
  assert.doesNotMatch(mcp.instructions(emptyRegistry()), /"plugins"/, "no plugins topic without plugins");
  assert.deepStrictEqual(mcp.cliArgs("guide", { topic: "events" }), ["primer", "--mcp", "--", "events"]);
  assert.deepStrictEqual(mcp.cliArgs("guide", {}), ["primer", "--mcp"]);
  assert.match(mcp.checkParams(mcp.TOOLS.find((tool) => tool.name === "guide"), { topic: "nope" })[0], /topic must be one of start, scenarios/);
  const registry = defaultRegistry();
  const topic = (name) => primer({ registry, surface: "mcp", topic: name });
  assert.match(topic("plugins"), /Living Universe \(plugin lu\)[\s\S]*lu_trigger/);
  assert.match(topic("conditions"), /Kinds: GRID PRESENT .*SIGHTING HUNT/);
  assert.match(topic("events"), /^- MODE: itemID, label, from, to, targetID, targetLabel, distanceMeters:m, groupKey$/m);
  assert.match(topic("events"), /^- HUNT \(plugin lu\): huntID, phase/m);
  assert.match(topic("events"), /^- the lu plugin's data on PRESENT, ARRIVE, .*KILLMAIL \(name a field alone or as lu\.<field>\): flightID/m);
  assert.match(topic("scenarios"), /\{ "repeat": \[<steps>\], "every": 5, "times": 12 \}/);
  assert.match(topic("scenarios"), /quote a value that has one \(name~"Asteroid Belt"\)/);
  assert.match(topic("perf"), /"perf": "<name>"/);
  assert.throws(() => topic("nope"), /no topic "nope"; the topics are start, scenarios, conditions, events, perf, plugins/);
  const whole = primer({ registry, surface: "mcp" });
  assert.ok(whole.length < 20_000, `the whole guide fits one reply (${whole.length})`);
  for (const name of ["start", "scenarios", "events", "plugins"]) assert.ok(whole.includes(topic(name)), `${name} is in the whole guide`);
});

test("player actions use the scenario step's names, and the CLI reads them back as the same action", () => {
  const { parseArgs } = require("../bin/gridcheck");
  const { actionFromArgs } = require("../core/actions");
  const roundTrip = (params) => {
    const parsed = parseArgs(mcp.cliArgs("act", params));
    assert.strictEqual(parsed.command, "act");
    return actionFromArgs(parsed.positionals[0], parsed.positionals.slice(1), parsed.flags);
  };
  assert.deepStrictEqual(mcp.cliArgs("act", { action: "orbit", target: "nearest npc", range: 2000 }),
    ["act", "--range=2000", "--", "orbit", "nearest npc"]);
  assert.deepStrictEqual(roundTrip({ action: "orbit", target: "nearest npc", range: 2000 }),
    { type: "orbit", target: "nearest npc", range: 2000 });
  assert.deepStrictEqual(roundTrip({ action: "activate", modules: "high", target: "name~--Patrol", once: true }),
    { type: "activate", modules: "high", target: "name~--Patrol", once: true });
  assert.deepStrictEqual(roundTrip({ action: "loadAmmo", charge: "EMP S" }),
    { type: "loadAmmo", modules: "weapons", charge: "EMP S" });
  assert.deepStrictEqual(roundTrip({ action: "launchDrones", drones: "name~Warrior", count: 2 }),
    { type: "launchDrones", drones: "name~Warrior", count: 2 });
  assert.deepStrictEqual(roundTrip({ action: "stop" }), { type: "stop" });
  assert.deepStrictEqual(mcp.cliArgs("watch", { client: "fx", positions: true }),
    ["watch", "--for=60", "--client=fx", "--positions"]);
});

test("arguments are checked against each tool's schema before the CLI runs", LU, () => {
  const tool = (name) => mcp.TOOLS.find((row) => row.name === name);
  assert.deepStrictEqual(mcp.checkParams(tool("slash"), {}), ["command is required"]);
  assert.match(mcp.checkParams(tool("grid"), { range: "far" })[0], /range must be a number/);
  assert.match(mcp.checkParams(tool("grid"), { radius: 5 })[0], /unknown argument radius; grid takes range, all, kind, json/);
  assert.match(mcp.checkParams(tool("lu_trigger"), { name: "nuke" })[0], /name must be one of scout, hunt/);
  assert.match(mcp.checkParams(tool("watch"), { seconds: 1.5 })[0], /seconds must be an integer/);
  assert.match(mcp.checkParams(tool("watch"), { seconds: 4000 })[0], /at most 3000/);
  assert.match(mcp.checkParams(tool("up"), { offgridTravel: 0 })[0], /at least 1/);
  assert.deepStrictEqual(mcp.checkParams(tool("report"), { run: "latest", section: "pr", waitSeconds: 0 }), []);
});

test("a bad scenario name is refused before anything is written", async () => {
  const result = await mcp.callTool("run_scenario", { name: "../escape", scenario: { world: "x" }, check: true });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /name: a file name for the scenario/);
  const missing = await mcp.callTool("run_scenario", {});
  assert.match(missing.content[0].text, /pass name \(a scenario file\), or name and scenario/);
});

test("a bare scenario name is the tree's file, the core's or a plugin's; a path is a path", LU, () => {
  const tree = path.resolve(__dirname, "..", "scenarios");
  assert.strictEqual(mcp.resolveScenario("smoke-undock"), path.join(tree, "smoke-undock.json"));
  assert.strictEqual(mcp.resolveScenario("fleet-to-grid"),
    path.resolve(__dirname, "..", "plugins", "lu", "scenarios", "fleet-to-grid.json"));
  const { DEFAULT_TREE_ROOT } = require("../core/plugins");
  assert.strictEqual(mcp.resolveScenario("tools/gridcheck/scenarios/x.json"),
    path.join(DEFAULT_TREE_ROOT, "tools", "gridcheck", "scenarios", "x.json"), "a path is from the tree's root");
  assert.ok(mcp.committedScenario("tools/gridcheck/plugins/lu/scenarios/fleet-to-grid.json"));
  // The tree's configured folder: tools/gridcheck-scenarios by default, tools/e2e-scenarios in trees set up before the rename.
  const treeScenarios = path.relative(DEFAULT_TREE_ROOT, require("../core/scenario").TREE_SCENARIO_DIR).split(path.sep).join("/");
  assert.ok(mcp.committedScenario(`${treeScenarios}/fleet-arrives.json`), "the tree's own scenarios");
  assert.ok(!mcp.committedScenario("_local/gridcheck/scenarios/fleet-to-grid.json"));
});

function protocol() {
  const sent = [];
  const server = mcp.createServer({ write: (text) => sent.push(JSON.parse(text)) });
  return { sent, receive: (message) => server.receive(typeof message === "string" ? message : JSON.stringify(message)) };
}

test("JSON-RPC: initialize, tools/list, ping and the errors", async () => {
  const { sent, receive } = protocol();
  receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.strictEqual(sent[0].result.protocolVersion, "2025-03-26", "a version both sides know is kept");
  assert.deepStrictEqual(sent[0].result.capabilities, { tools: {} });
  assert.match(sent[0].result.instructions, /run_scenario/);
  receive({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.strictEqual(sent[1].result.protocolVersion, "2025-06-18", "an unknown version gets the newest");
  receive({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.strictEqual(sent.length, 2, "a notification gets no reply");
  receive({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.strictEqual(sent[2].result.tools.length, mcp.TOOLS.length);
  assert.deepStrictEqual(Object.keys(sent[2].result.tools[0]).sort(), ["description", "inputSchema", "name"]);
  receive({ jsonrpc: "2.0", id: 4, method: "ping" });
  assert.deepStrictEqual(sent[3], { jsonrpc: "2.0", id: 4, result: {} });
  receive({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  assert.strictEqual(sent[4].error.code, -32601);
  receive("{not json");
  assert.strictEqual(sent[5].error.code, -32700);
  await receive({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nothing" } });
  assert.strictEqual(sent[6].error.code, -32602);
  await receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slash", arguments: {} } });
  assert.deepStrictEqual(sent[7].result, { content: [{ type: "text", text: "slash: command is required" }], isError: true },
    "a bad argument is a tool error the agent can read, not a protocol error");
});

function citationRun({ scenarioFile, commit }) {
  const result = {
    name: "fleet-to-grid",
    world: "lowsec-docked",
    scenarioFile,
    startedAtMs: 0,
    stoppedAtMs: 61_000,
    failure: null,
    missing: 0,
    exitCode: 0,
    stop: { reason: "until", condition: "ARRIVE flightID=$fleet", event: { t: 30_000 } },
    down: { ok: true },
    until: [{ text: "ARRIVE flightID=$fleet", fired: true }],
    steps: [],
    events: [],
    eventCount: 4,
    expectations: [{ text: "INCOMING flightID=$fleet", met: true, first: { kind: "INCOMING", t: 5000, flightID: "f1" }, count: 1 }],
    commit,
    frames: [{ file: "frames/01-stop-arrive.svg", reason: "stop", stop: true, t: 30_000 }],
  };
  const report = renderReport(result, { runID: "r1", scenario: null, scenarioFile, commit });
  return { state: { runID: "r1", dir: path.join("runs", "r1"), result }, report };
}

test("the report names the commit the run ran on", () => {
  const { report } = citationRun({ scenarioFile: "tools/gridcheck/scenarios/fleet-to-grid.json", commit: { sha: "56559e01f27a", dirty: true } });
  assert.match(report, /\| Commit \| `56559e01f27a` plus uncommitted changes \|/);
  assert.doesNotMatch(renderReport({ ...citationRun({ scenarioFile: null }).state.result }, { runID: "r1" }), /\| Commit/);
});

test("the PR citation carries the verdict, commit, expectations and frames to attach", () => {
  const { state, report } = citationRun({ scenarioFile: "tools/gridcheck/plugins/lu/scenarios/fleet-to-grid.json",
    commit: { sha: "abc123", dirty: false } });
  const text = mcp.prCitation(state, report);
  assert.match(text, /^### End-to-end check `fleet-to-grid`: PASSED/);
  assert.match(text, /Run `r1` of `tools\/gridcheck\/plugins\/lu\/scenarios\/fleet-to-grid\.json` on commit `abc123`, from world `lowsec-docked`, 61 s/);
  assert.match(text, /1 of 1 expectations met\./);
  assert.match(text, /#### Expected against observed\n\n\| Result \| Expected \| Observed \|/);
  assert.match(text, /\| t\+00:00:30 \| stop \| 01-stop-arrive\.svg \(attached\) \|/);
  assert.match(text, /Reproduce: `node tools\/gridcheck\/bin\/gridcheck\.js run fleet-to-grid`/);
  assert.ok(text.includes(path.join("runs", "r1", "frames", "01-stop-arrive.svg")), "the frame file to attach");
  assert.doesNotMatch(text, /can't rerun it/);

  const draft = citationRun({ scenarioFile: "_local/gridcheck/scenarios/fleet-to-grid.json", commit: null });
  const draftText = mcp.prCitation(draft.state, draft.report);
  assert.match(draftText, /commit not recorded/);
  assert.match(draftText, /a reviewer can't rerun it\. Save it there/);
});

test("report sections split at ## headings", () => {
  const sections = mcp.reportSections("# Title\n\nline\n\n## A\n\nbody a\n\n## B\nbody b");
  assert.deepStrictEqual(Object.keys(sections), ["head", "A", "B"]);
  assert.strictEqual(sections.A, "## A\n\nbody a");
});

test("over stdio, a tool runs the CLI and returns what it printed", async () => {
  const child = spawn(process.execPath, [MCP_PATH], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (message.id !== undefined) replies.get(message.id)(message);
    }
  });
  const call = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.strictEqual(init.result.serverInfo.name, "gridcheck");
    const checked = await call(2, "tools/call", { name: "run_scenario", arguments: { name: "no-such-scenario-here", check: true } });
    assert.strictEqual(checked.result.isError, true);
    assert.match(checked.result.content[0].text, /no-such-scenario-here\.json:\n {2}no such scenario file\. `gridcheck run` lists the scenarios.*\n\(exit 1\)/,
      "the CLI's own refusal and exit code");
    const guide = await call(3, "tools/call", { name: "guide", arguments: { topic: "conditions" } });
    assert.strictEqual(guide.result.isError, false);
    assert.match(guide.result.content[0].text, /^Conditions \(until\.any, expect, waitFor\) are KIND then field tests/);
  } finally {
    child.stdin.end();
  }
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.strictEqual(code, 0, "the server exits when its client goes away");
});
