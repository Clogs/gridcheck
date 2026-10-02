"use strict";

// What an agent needs to drive the tool with no other context: the workflow,
// the scenario format and the condition syntax, then each active plugin's
// primer. The MCP server sends it as its instructions; `gridcheck primer` prints it
// for agents that use the CLI. One text, with each tool named the way the
// surface spells it. Guide: docs/GUIDE.md, docs/CLI.md.

const { kindsOf } = require("./conditions");

const CLI = "node tools/gridcheck/bin/gridcheck.js";

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
    attach: `This tree is in attach mode: its server is started by hand with EVEJS_AGENT_BRIDGE=1 set, and the tools work on that live server. ${t("up")} and ${t("down")} refuse, and a run uses the server as it is: its world is not restored and the server stays up. If no server is up, ask the user to start one.`,
    auto: `This tree is in auto mode. When its server is up (one the user started with EVEJS_AGENT_BRIDGE=1 set, or one ${t("up")} started), the tools and runs use it as it is: a run doesn't restore its world, and the server stays up. When none is up, a run boots its own world and stops it after, and ${t("up")} starts one. ${t("down")} stops only a server ${t("up")} started. ${t("status")} says which applies now.`,
  };
  return texts[mode] || texts.auto;
}

// registry: the tool registry (core/plugins.js). mode: the tree's server mode.
// surface: "mcp" or "cli". scenarioDirs: { tree, drafts } as the tree names them.
function primer({ registry, mode = "auto", surface = "mcp", scenarioDirs = { tree: "tools/gridcheck-scenarios", drafts: "_local/gridcheck/scenarios" } }) {
  const t = namer(surface);
  const cli = surface === "cli";
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

  const runs = cli
    ? "Runs take minutes (boot about 25 s, then real-time grid behaviour). `gridcheck run <name>` blocks until the verdict; `gridcheck run <name> --detach` starts it in the background and prints its run ID, and `gridcheck report <run> --wait 600` waits for it and prints the verdict. Exit codes: 0 passed, 1 an expectation failed, 2 the run did not complete. `gridcheck report <run> --section pr` gives the markdown to cite the run in a PR description."
    : `Runs take minutes (boot about 25 s, then real-time grid behaviour). wait:false starts one in the background; ${t("report", "{ run, waitSeconds }")} waits for it and reads the verdict. ${t("report", "{ run, section: \"pr\" }")} gives the markdown to cite the run in a PR description.`;

  const byHand = ["up", "login", "undock", "loadout", "grid", "act", "watch", "slash", "teleport", "log", "perf", "down"]
    .map((name) => t(name, name === "up" ? "{ world }" : name === "watch" ? "{ seconds }" : "", name === "up" ? "--world <name>" : name === "watch" ? "--for <s>" : ""));

  const core = `${intro}

Start with ${t("status")}: it shows whether this tree's server is up, the saved worlds, the scenarios and the plugins that are active. ${t("doctor")} says what this tree supports: the gateway calls, the client view, the optional patches and the ports.

${modeText(mode, t)}

To verify a feature, write a scenario and run it (${t("run_scenario")}). A scenario is JSON:
{ "description": "...", "world": "<a saved world ${t("status")} lists, or fresh>" (or "recipe": "starter" instead, a world the run builds from worlds/starter.recipe.json: every skill and a fitted Tristan docked in Amamake),
  "setup": ["undock", { "teleport": "Siseide" }, { "slash": "/gaterats on" }, { "waitFor": "ARRIVE who=npc", "timeout": 120 }],
  "until": { "any": ["DESTROYED self"], "timeout": 300, "grace": 10 },
  "expect": ["ARRIVE who=npc", { "match": "TARGET self locked", "note": "why it matters" }, "no DIVERGE status=open"] }
- up: ${upKeys}.
- setup steps: "login" (implicit), "undock", "dock", { "slash": "/heal" }, { "teleport": "Amamake" }, { "loadout": { "ship": "Tristan", "modules": ["Light Neutron Blaster II x2"], "drones": ["Hobgoblin II x5"], "charges": ["Antimatter Charge S"] } }, { "wait": 30 }, { "waitFor": "<condition>", "timeout": 300 }${pluginSteps.length ? `, and the plugins' ${pluginSteps.join(", ")}` : ""}.
- player actions are steps too, in setup and in "during" (a second list that runs after setup, beside the stop conditions, and stops when the run stops): { "lock": "<target>", "as": "mark", "timeout": 30 }, { "activate": "weapons", "target": "$mark", "once": false }, { "deactivate": "weapons" }, { "orbit": "<target>", "range": 5000 }, { "approach": "<target>" }, { "keepAtRange": "<target>", "range": 10000 }, { "warpTo": "<target>", "range": 0 }, "stop", { "unlock": "<target>" }, { "loadAmmo": "weapons", "charge": "EMP S" }, { "launchDrones": "all", "count": 5 }, { "engageDrones": "<target>" }; each also takes "retry". A target is the nearest ball passing every term: "nearest npc", "name~Scout", "type~Rifter", "kind=station", "within=30km", "player", "$mark", an itemID. "as" on a lock binds the ball. Shots show as TARGET sourceLabel=self, FX self (needs "watch": { "client": "fx" }) and DAMAGE itemID=$mark.
- until: any (stop conditions), timeout (s after setup, required), grace (up to this many s more after a stop; it ends early once every expectation is met and graceMin, default 5, has passed), from ("setup" default: only events after setup count; "start": setup's own events count, e.g. the GRID an undock causes).
- expect: conditions that should be seen; "no <condition>" expects none. A missing one fails the run (exit 1) but the run keeps watching.
- Conditions: KIND then field tests. Kinds: ${kinds}, and CLIENT (needs "watch": { "client": "all" }), FX (needs "client": "fx" or "all") and DIVERGE. Tests: field=value, field!=value, field~regex, field>=N (also > < <=), bare field (set), !field (unset). Units: 30km, 90s, 5min. "self" = about your ship. $name = IDs a step bound with "as". A field is looked up on the event, then one level down. Field names are the ones ${t("watch", "with json:true", "--json")} prints; a check lists a kind's fields when you name a wrong one.
${writeAndCheck}

Performance: how the server copes with a load. The bridge reads every tick's duration from the runtime (no flag needed); a server booted with the tick profiler (${t("up", "{ profile: true }", "--profile")}, or "up": { "profile": true } in a scenario) also breaks each window down by subsystem (npc, drone, movement and so on). By hand: ${t("up", "{ profile: true }", "--profile")}, ${t("login")}, ${t("undock")}, ${t("perf", "{ seconds: 10 }", "--for 10")} for a baseline, ${t("slash", "\"/npctest2 20\"", "\"/npctest2 20\"")} (20 NPCs fighting each other; "/npc 20" spawns 20 that attack you), then ${t("perf", "{ seconds: 30 }", "--for 30")} under load, and compare. In a scenario, "up": { "profile": true } streams PERF (a window of ticks every 5 s: tickAvgMs, tickP95Ms, tickP99Ms, tickMaxMs, overBudget, loopP99Ms, cpuPct, heapMB, entities) and PROFILE (sections with msPerTick) into the timeline; the report splits the ticks at each setup step, so the time before a spawn is the baseline for the time after it. Expect a budget like "no PERF overBudget>=5" (no 5 s window with 5 ticks over the 100 ms a tick has) or "no PERF tickP99Ms>=100". The perf-npc-load scenario does all of this.

${runs}

By hand: ${byHand.join(", ")}${pluginTools.length ? `, and the plugins' ${pluginTools.join(", ")}` : ""}. A person can replay any run, or follow a live one, in the viewer: \`${CLI} view [<run>]\` prints its URL. ${cli
    ? "Running `gridcheck watch --for 60` in the background while you act lets you see an action's effect."
    : `Calling ${t("watch")} and an action in the same turn lets you see its effect. Replies are the CLI's own output, so a message naming a command such as \`gridcheck login\` means the tool ${t("login")}.`}`;

  const plugins = registry.primers.map((entry) => entry.text);
  if (cli && plugins.length) {
    plugins.unshift("The plugin notes below name MCP tools: the tool `<plugin>_<name>` is the CLI command `gridcheck <name>`, and any other tool `<name>` is `gridcheck <name>`.");
  }
  return [core, ...plugins].join("\n\n");
}

module.exports = { primer };
