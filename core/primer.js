"use strict";

// What an agent needs to drive the tool with no other context, in topics: the
// workflow, the scenario format, the condition syntax, every event's fields,
// performance runs and each active plugin's primer. The MCP server sends a
// short brief as its instructions (clients cut long ones off) and serves the
// topics through its guide tool; `gridcheck primer [<topic>]` prints them for
// agents that use the CLI. One text, with each tool named the way the surface
// spells it. Guide: docs/GUIDE.md, docs/CLI.md.

const { describeFields, kindsOf } = require("./conditions");

const CLI = "node tools/gridcheck/bin/gridcheck.js";

// The topics, in the order the whole primer prints them.
const TOPICS = Object.freeze({
  start: "the workflow, the server mode, runs and the tools to use by hand",
  scenarios: "the scenario JSON: setup and during steps, player actions and targets, repeat, until and expect",
  conditions: "the syntax of until, expect and waitFor conditions",
  events: "every event kind and the fields a condition can test",
  perf: "performance runs: tick figures, the tick profiler, named phases",
  plugins: "the active plugins' own notes",
});

// name: the MCP tool without its prefix. mcp/cli: arguments as each surface writes them.
function namer(surface) {
  if (surface === "cli") {
    const commands = { run_scenario: "run" };
    return (name, _mcp = "", cli = "") => `\`gridcheck ${commands[name] || name}${cli ? ` ${cli}` : ""}\``;
  }
  return (name, mcp = "") => `\`${name}\`${mcp ? ` ${mcp}` : ""}`;
}

function modeText(mode, t) {
  const texts = {
    managed: `This tree is in managed mode: the CLI boots and stops its server (${t("up")}, ${t("down")}), and a run boots its own world, so call ${t("down")} first if the server is up.`,
    attach: `This tree is in attach mode: the user starts its server by hand (npm start or StartServer.bat), and the tools work on that live server. ${t("up")} and ${t("down")} refuse, and a run uses the server as it is: its world is not restored and the server stays up. If no server is up, ask the user to start one.`,
    auto: `This tree is in auto mode. When its server is up (one the user started, or one ${t("up")} started), the tools and runs use it as it is: a run doesn't restore its world, and the server stays up. When none is up, a run boots its own world and stops it after, and ${t("up")} starts one. ${t("down")} stops only a server ${t("up")} started. ${t("status")} says which applies now.`,
  };
  return texts[mode] || texts.auto;
}

// How each surface asks for a topic.
function topicCall(surface, topic) {
  return surface === "cli" ? `\`gridcheck primer ${topic}\`` : `\`guide\` { topic: "${topic}" }`;
}

// registry: the tool registry (core/plugins.js). mode: the tree's server mode.
// surface: "mcp" or "cli". scenarioDirs: { tree, drafts } as the tree names them.
// -> { start, scenarios, conditions, events, perf, plugins }, each a text.
function topicTexts({ registry, mode = "auto", surface = "mcp", scenarioDirs = { tree: "tools/gridcheck-scenarios", drafts: "_local/gridcheck/scenarios" } }) {
  const t = namer(surface);
  const cli = surface === "cli";
  const see = (topic) => topicCall(surface, topic);
  const upKeys = ["market", "timeout", "profile", "profileEvery", ...registry.upFlags.map((flag) => flag.key)].join(", ");
  const pluginSteps = Object.keys(registry.steps);
  const kinds = kindsOf(registry).filter((kind) => !["CLIENT", "FX", "DIVERGE"].includes(kind)).join(" ");
  const pluginTools = registry.mcpTools.map((tool) => `\`${cli ? `gridcheck ${tool.name.replace(/^[^_]+_/, "")}` : tool.name}\``);

  const intro = cli
    ? `End-to-end grid testing for EveJS with no EVE client. A server boots from a saved world; a character logs in through the web gateway, undocks, and you read its grid, run slash commands, act as the player and watch what happens as a timeline. Every command here is \`${CLI} <command>\`, run in this tree and written \`gridcheck <command>\` below; \`gridcheck help\` lists them all. The command reference for agents is tools/gridcheck/docs/CLI.md, and the full guide tools/gridcheck/docs/GUIDE.md.`
    : `End-to-end grid testing for EveJS with no EVE client. A server boots from a saved world; a character logs in through the web gateway, undocks, and you read its grid, run slash commands, act as the player and watch what happens as a timeline. Every tool runs the CLI \`${CLI}\` in this tree; the guide is tools/gridcheck/docs/GUIDE.md.`;

  const writeAndCheck = cli
    ? `Write the scenario to ${scenarioDirs.tree}/<name>.json to commit with the feature, or to ${scenarioDirs.drafts}/<name>.json as a draft (\`gridcheck scenario new <name>\` writes a starting point), then \`gridcheck run <name> --check\`: that validates it without booting.`
    : `Write the file with ${t("run_scenario", "{ name, scenario, check: true }")} first: that validates without booting. save:true writes it to ${scenarioDirs.tree}/ to commit with the feature; otherwise it goes to ${scenarioDirs.drafts}/.`;
  const trustCheck = "The check names every problem at once, and an unknown key, step, kind or field comes back with the valid ones listed, so a check that passes means every name in the scenario is right.";

  const runs = cli
    ? "Runs take minutes (boot about 25 s, then real-time grid behaviour). `gridcheck run <name>` blocks until the verdict; `gridcheck run <name> --detach` starts it in the background and prints its run ID, and `gridcheck report <run> --wait 600` waits for it and prints the verdict. Exit codes: 0 passed, 1 an expectation failed, 2 the run did not complete. `gridcheck report <run> --section pr` gives the markdown to cite the run in a PR description."
    : `Runs take minutes (boot about 25 s, then real-time grid behaviour). wait:false starts one in the background; ${t("report", "{ run, waitSeconds }")} waits for it and reads the verdict. ${t("report", "{ run, section: \"pr\" }")} gives the markdown to cite the run in a PR description.`;

  const byHand = ["up", "login", "undock", "loadout", "grid", "act", "watch", "slash", "teleport", "log", "perf", "down"]
    .map((name) => t(name, name === "up" ? "{ world }" : name === "watch" ? "{ seconds }" : "", name === "up" ? "--world <name>" : name === "watch" ? "--for <s>" : ""));

  const start = `${intro}

Start with ${t("status")}: it shows whether this tree's server is up, the saved worlds, the scenarios and the plugins that are active. ${t("doctor")} says what this tree supports: the gateway calls, the client view, the optional patches and the ports.

${modeText(mode, t)}

To verify a feature, write a scenario and run it (${t("run_scenario")}); ${see("scenarios")} has the format. ${writeAndCheck} ${trustCheck}

${runs}

By hand: ${byHand.join(", ")}${pluginTools.length ? `, and the plugins' ${pluginTools.join(", ")}` : ""}. A person can replay any run, or follow a live one, in the viewer: \`${CLI} view [<run>]\` prints its URL. ${cli
    ? "Running `gridcheck watch --for 60` in the background while you act lets you see an action's effect."
    : `Calling ${t("watch")} and an action in the same turn lets you see its effect. Replies are the CLI's own output, so a message naming a command such as \`gridcheck login\` means the tool ${t("login")}.`} A slash command that answers \`done (unconfirmed)\` ran, but the tree's stock commands don't say whether they refused; read the reply text. ${t("doctor")} says whether the slash-success patch, which makes them say, is applied.`;

  const scenarios = `A scenario is JSON:
{ "description": "...", "world": "<a saved world ${t("status")} lists, or fresh>" (or "recipe": "starter" instead, a world the run builds from worlds/starter.recipe.json: every skill and a fitted Tristan docked in Amamake),
  "setup": ["undock", { "teleport": "Siseide" }, { "slash": "/gaterats on" }, { "waitFor": "ARRIVE who=npc", "timeout": 120 }],
  "until": { "any": ["DESTROYED self"], "timeout": 300, "grace": 10 },
  "expect": ["ARRIVE who=npc", { "match": "TARGET self locked", "note": "why it matters" }, "no DIVERGE status=open"] }
- up: ${upKeys}.
- setup steps: "login" (implicit), "undock", "dock", { "slash": "/heal" }, { "teleport": "Amamake" }, { "loadout": { "ship": "Tristan", "modules": ["Light Neutron Blaster II x2"], "drones": ["Hobgoblin II x5"], "charges": ["Antimatter Charge S"] } }, { "wait": 30 }, { "waitFor": "<condition>", "timeout": 300 }, { "repeat": [<steps>], "every": 5, "times": 12 }${pluginSteps.length ? `, and the plugins' ${pluginSteps.join(", ")}` : ""}. Every step takes "note"; a waitFor's condition is the same syntax as expect's (${see("conditions")}).
- repeat: runs its steps a round every "every" seconds (start to start), "times" rounds, and the report shows it as one step. In during, leave "times" out and it repeats until the run stops: { "repeat": [{ "slash": "/heal" }], "every": 5 } keeps the ship alive through a fight. A step in a round that fails fails the repeat. A repeat can't hold another repeat or login.
- player actions are steps too, in setup and in "during" (a second list that runs after setup, beside the stop conditions, and stops when the run stops): { "lock": "<target>", "as": "mark", "timeout": 30 }, { "activate": "weapons", "target": "$mark", "once": false }, { "deactivate": "weapons" }, { "orbit": "<target>", "range": 5000 }, { "approach": "<target>" }, { "keepAtRange": "<target>", "range": 10000 }, { "warpTo": "<target>", "range": 0 }, "stop", { "unlock": "<target>" }, { "loadAmmo": "weapons", "charge": "EMP S" }, { "launchDrones": "all", "count": 5 }, { "engageDrones": "<target>" }; each also takes "retry": { "every": 15, "for": 120 }. Shots show as TARGET sourceLabel=self, FX self (needs "watch": { "client": "fx" }) and DAMAGE itemID=$mark.
- targets: the nearest ball the session sees that passes every term: "nearest npc", "name~Scout", "type~Rifter", "kind=station", "within=30km", "player", "$mark", an itemID. The session sees the system's celestials wherever they are, so "warpTo": "kind=planet" or "name~\\"Asteroid Belt\\"" reaches one off grid. Terms split at spaces: quote a value that has one (name~"Asteroid Belt"), or match the space with a dot. "as" on a lock binds the ball.
- "perf": "<name>" on any step opens a named phase in the report's performance table where the step begins (${see("perf")}).
- until: any (stop conditions), timeout (s after setup, required), grace (up to this many s more after a stop; it ends early once every expectation is met and graceMin, default 5, has passed), from ("setup" default: only events after setup count; "start": setup's own events count, e.g. the GRID an undock causes).
- expect: conditions that should be seen; "no <condition>" expects none. A missing one fails the run (exit 1) but the run keeps watching.
- watch: every (grid sample s, default 2), offgridEvery, client (all, fx, diverge (default) or off), divergeMeters, log, grep, perf.
${writeAndCheck} ${trustCheck}`;

  const conditions = `Conditions (until.any, expect, waitFor) are KIND then field tests, all of which must hold: ARRIVE who=npc count>=3, TARGET self locked, DAMAGE itemID=$mark, MODE self to=STOP.
- Kinds: ${kinds}, and CLIENT (needs "watch": { "client": "all" }), FX (needs "client": "fx" or "all") and DIVERGE. ${see("events")} lists each kind's fields.
- Tests: field=value, field!=value, field~regex (case-insensitive), field>=N (also > < <=), bare field (set), !field (unset). Units: 30km, 90s, 5min.
- "self" = the event is about your ship. $name = the IDs a step bound with "as".
- A field is looked up on the event, then one level down (mode on an ARRIVE is members.mode), then in the plugins' data. A list matches when any element does.
- Split at spaces like targets: quote a value that has one, label="Blood Raider".
- Field names are the ones ${t("watch", "with json:true", "--json")} prints. The check refuses an unknown kind or field and lists the valid ones.`;

  const described = describeFields(registry);
  const extLines = new Map();
  for (const row of described) {
    for (const [plugin, fields] of row.ext) {
      const key = `${plugin}\u0000${fields.join(",")}`;
      if (!extLines.has(key)) extLines.set(key, { plugin, fields, kinds: [] });
      extLines.get(key).kinds.push(row.kind);
    }
  }
  const events = [`Every event kind and the fields a condition can test. Unmarked fields are text or IDs (=, != or ~); :num is a number, :m metres (30km works), :ms milliseconds (90s and 5min work), :bool true or false. Every kind also has t:ms (since the watch began), atMs:ms, seq:num and source. A field one level down can be named alone (mode for members.mode); a.b names it outright.`,
    ...described.map((row) => `- ${row.kind}${row.plugin ? ` (plugin ${row.plugin})` : ""}: ${row.fields.join(", ") || "(no fields)"}`),
    ...[...extLines.values()].map((entry) => `- the ${entry.plugin} plugin's data on ${entry.kinds.join(", ")} (name a field alone or as ${entry.plugin}.<field>): ${entry.fields.join(", ")}`),
    "CLIENT and FX need \"watch\": { \"client\": \"all\" } (FX also \"fx\"); PERF needs the watch's perf, PROFILE the tick profiler."].join("\n");

  const perf = `Performance: how the server copes with a load. The bridge reads every tick's duration from the runtime (no flag needed); a server booted with the tick profiler (${t("up", "{ profile: true }", "--profile")}, or "up": { "profile": true } in a scenario) also breaks each window down by subsystem (npc, drone, movement and so on). By hand: ${t("up", "{ profile: true }", "--profile")}, ${t("login")}, ${t("undock")}, ${t("perf", "{ seconds: 10 }", "--for 10")} for a baseline, ${t("slash", "\"/npctest2 20\"", "\"/npctest2 20\"")} (20 NPCs fighting each other; "/npc 20" spawns 20 that attack you), then ${t("perf", "{ seconds: 30 }", "--for 30")} under load, and compare.
In a scenario, "up": { "profile": true } streams PERF (a window of ticks every 5 s: tickAvgMs, tickP95Ms, tickP99Ms, tickMaxMs, overBudget, loopP99Ms, cpuPct, heapMB, entities) and PROFILE (sections with msPerTick) into the timeline. The report's performance table splits the ticks into phases: at every step by default, so the time before a spawn is the baseline for the time after it, or, once any step has "perf": "<name>", only where those steps begin, each phase named for its step: { "wait": 15, "perf": "baseline" }, { "slash": "/npc 20", "perf": "fight" }, then a during { "repeat": [{ "slash": "/heal" }], "every": 5 } keeps the fight in one phase. The report also says when the slowest tick and the longest event-loop stall happened, and in which phase.
Expect a budget like "no PERF overBudget>=5" (no 5 s window with 5 ticks over the 100 ms a tick has) or "no PERF tickP99Ms>=100". A run on a server that is already up can't add the profiler; the report says so when the scenario asked for it. The perf-npc-load scenario does all of this.`;

  const plugins = registry.primers.map((entry) => entry.text);
  if (cli && plugins.length) {
    plugins.unshift("The plugin notes below name MCP tools: the tool `<plugin>_<name>` is the CLI command `gridcheck <name>`, and any other tool `<name>` is `gridcheck <name>`.");
  }

  return { start, scenarios, conditions, events, perf, plugins: plugins.length ? plugins.join("\n\n") : "No plugins are active in this tree." };
}

// The whole primer, or one topic of it. Throws on a topic it doesn't have.
function primer({ topic = null, ...options }) {
  const texts = topicTexts(options);
  if (topic) {
    if (!TOPICS[topic]) throw new Error(`no topic "${topic}"; the topics are ${Object.keys(TOPICS).join(", ")}`);
    return texts[topic];
  }
  const parts = Object.keys(TOPICS).filter((key) => key !== "plugins" || options.registry.primers.length).map((key) => texts[key]);
  return parts.join("\n\n");
}

// The MCP server's instructions: what the tool is, how to start, and where the
// rest is. Clients cut long instructions off, so this stays under BRIEF_LIMIT
// and the format lives in the guide tool.
const BRIEF_LIMIT = 2000;

function brief({ registry, mode = "auto" }) {
  const t = namer("mcp");
  const plugins = registry.primers.map((entry) => entry.plugin);
  const topics = Object.entries(TOPICS).filter(([key]) => key !== "plugins" || plugins.length)
    .map(([key, what]) => `"${key}" (${key === "plugins" ? `notes from ${plugins.join(", ")}` : what.split(":")[0]})`);
  return `End-to-end grid testing for EveJS with no EVE client: a server boots from a saved world, a character logs in through the web gateway and undocks, and you read its grid, run slash commands, act as the player and watch what happens as a timeline.

This is an outline. Before writing a scenario, read ${t("guide")} { topic }: ${topics.join(", ")}; no topic gives all of them.

Start with ${t("status")}. ${modeText(mode, t)}

The loop: ${t("run_scenario", "{ name, scenario, check: true }")} validates without booting; an unknown key, kind or field comes back with the valid ones listed, so trust a check that passes. Then ${t("run_scenario", "{ name }")} runs it (minutes) and ${t("report")} reads the verdict. By hand: ${["up", "login", "undock", "grid", "act", "watch", "slash", "perf", "down"].map((name) => t(name)).join(", ")}.`;
}

module.exports = { BRIEF_LIMIT, TOPICS, brief, primer, topicTexts };
