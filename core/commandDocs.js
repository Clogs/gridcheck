"use strict";

// What each CLI command does, for `e2e help --json` and the GUI's Commands tab.
// The usage lines stay in bin/e2e.js's command table; this file adds a group,
// a one-line summary, tags and notes on the flags. A key is a command name, or
// "<command> <sub>" for one part of a usage line split at " | ". A plugin
// command carries its own summary (and needs, writes) beside its usage.
//
//   needs   "up" (a running server) or "down" (a stopped one), or absent
//   managed true when attach mode refuses it (auto or managed only)
//   writes  true when it changes files in the tree
//   mcp     the agents' tool for the same thing
//   flags   [flag, default or null, what it does]
//   examples [command, note or null]

const GROUPS = [
  { id: "setup", title: "Set up", text: "Install the tool, configure the tree and check what works." },
  { id: "worlds", title: "Worlds", text: "Build, save and copy the worlds a run starts from." },
  { id: "server", title: "Server", text: "Start, stop and inspect the tree's game server." },
  { id: "ship", title: "Character and ship", text: "Log in, move, fit and fight, through the calls a browser client is allowed." },
  { id: "watch", title: "Watch and read", text: "What's on grid, what changed, and how the server's ticks are doing." },
  { id: "scenarios", title: "Scenarios", text: "Run a whole check in one command, and get a report." },
  { id: "tool", title: "This tool", text: "The GUI and this list." },
];

const DOCS = {
  init: {
    group: "setup", writes: true,
    summary: "Writes the tree's e2e.config.json with its server mode, and probes which listeners the tree's source can move.",
    flags: [["--mode auto|attach|managed", "auto", "How runs get a server: use a running one, start their own, or both."],
      ["--force", null, "Replace an existing e2e.config.json."], ["--dry-run", null, "Print the config without writing it."]],
  },
  agents: {
    group: "setup", writes: true,
    summary: "Shows the Claude Code and Codex on this machine and whether each has this tree's e2e tools; setup adds them.",
    flags: [["status", null, "The default: what was found and what each agent already has."],
      ["setup [claude] [codex]", "both found", "Add the e2e MCP server to those agents. Only adds entries."],
      ["setup cli", null, "For any other agent: add a pointer to docs/CLI.md to the tree's AGENTS.md (or CLAUDE.md)."],
      ["--dry-run", null, "Show the lines setup would add."], ["--json", null, "Print the status as JSON."]],
  },
  doctor: {
    group: "setup", mcp: "e2e_doctor",
    summary: "Health check: asks the tree's copy which gateway calls, patches, listeners and client-view decoding work.",
    flags: [["--offline", null, "Read the tree's files even when a server is up."], ["--json", null, "Print the whole report."]],
  },
  "vendor update": {
    group: "setup", writes: true, needs: "down",
    summary: "Copies an evejs-e2e checkout or tag into a tree's tools/evejs-e2e/, with the bridge shim.",
    flags: [["--from <checkout|tag>", "this checkout's HEAD", "What to copy."], ["--tree <path>", null, "The tree to update."],
      ["--force", null, "Replace files that were edited in the tree's copy."], ["--dry-run", null, "List what it would add, change and remove."]],
  },
  "vendor check": {
    group: "setup",
    summary: "Fails if any file in the tree's copy differs from its VENDOR.json.",
    flags: [["--tree <path>", "this tree", "The tree to check."]],
  },
  patch: {
    group: "setup", writes: true, needs: "down",
    summary: "Lists, applies or reverts the optional edits to stock EveJS. Revert gives each file back byte for byte.",
    flags: [["list", null, "Every patch and what it does."], ["status [<id>]", null, "Whether each is absent, applied, detected or partial."],
      ["apply|revert <id>...", null, "Apply or revert those patches."], ["--dry-run", null, "Show the lines it would insert or remove."],
      ["--json", null, "Print status as JSON."]],
  },
  "world build": {
    group: "worlds", writes: true, needs: "down", managed: true,
    summary: "Builds a world from a recipe and saves it under the recipe's name. A run that names the recipe builds it when it's missing or stale.",
    flags: [["<recipe>", null, "A recipe from world recipes, e.g. starter."],
      ["--force", null, "Replace a saved world of that name that no recipe built."]],
    examples: [["e2e world build starter", "every skill, a fitted Tristan docked in Amamake"]],
  },
  "world recipes": {
    group: "worlds",
    summary: "Lists the recipes, and whether each one's world is built and current.",
    flags: [["--json", null, "Print the list as JSON."]],
  },
  "world save": {
    group: "worlds", writes: true, needs: "down", managed: true,
    summary: "Snapshots the stopped world into _local/e2e/worlds/<name>/, so every run from it starts in the same place.",
    flags: [["<name>", null, "The saved world's name."], ["--note \"...\"", null, "What's in it."], ["--force", null, "Replace a saved world of that name."]],
  },
  "world list": {
    group: "worlds",
    summary: "Lists the saved worlds with their size, date and note.",
  },
  "world copy": {
    group: "worlds", writes: true, needs: "down", managed: true,
    summary: "Copies another tree's world into this one. The source is read-only, so it can be running.",
    flags: [["--from <tree>", null, "The tree to copy from."], ["--force", null, "Replace this tree's world."]],
  },
  up: {
    group: "server", managed: true, mcp: "e2e_up",
    summary: "Starts the server in the background with the agent bridge on, and waits until it's ready.",
    flags: [["--world <name>", null, "Replace the tree's world with a saved one before boot."],
      ["--fresh", null, "Delete the game store and boot a new one from the seed tables."],
      ["--no-market", null, "Don't start the market daemon."],
      ["--timeout", "600 s", "How long to wait for boot. After it, the server is left running."],
      ["--profile", null, "Boot with the tick profiler."], ["--profile-every", "50 ticks", "The profiler's window."]],
    note: "Refuses before touching the world when another process holds the world lease, a port in the tree's block is taken, " +
      "or the world is missing. Sets EVEJS_AGENT_BRIDGE=1 for you.",
    examples: [["e2e up --world starter", null]],
  },
  down: {
    group: "server", managed: true, mcp: "e2e_down",
    summary: "Stops the server cleanly: it runs the shutdown hooks, flushes the store and releases the world lease.",
    flags: [["--force", null, "Kill a server that has no bridge yet. Its lease stays live for 30 s."]],
  },
  status: {
    group: "server", mcp: "e2e_status",
    summary: "The mode, ports, server pid and boot time, gateway, bridge, daemons and the character held.",
  },
  ports: {
    group: "server",
    summary: "Prints this tree's block of 20 ports and what listens on each.",
  },
  log: {
    group: "server", mcp: "e2e_log",
    summary: "The tail of the server's log.",
    flags: [["--grep <regex>", null, "Keep matching lines, case-insensitively."], ["--lines", "40", "How many lines."],
      ["--any-pid", null, "Keep every process's lines, not only the running server's."]],
  },
  login: {
    group: "ship", needs: "up", mcp: "e2e_login",
    summary: "Logs a character in over the web gateway and starts the client view.",
    flags: [["--user", "e2eagent", "The account."], ["--name", null, "The character's name, for a new character."]],
  },
  logout: {
    group: "ship", needs: "up",
    summary: "Releases the held character's session.",
  },
  undock: {
    group: "ship", needs: "up", mcp: "e2e_undock",
    summary: "Undocks the held character's ship.",
  },
  dock: {
    group: "ship", needs: "up",
    summary: "Docks with stock /dock, which goes back to the home station.",
  },
  slash: {
    group: "ship", needs: "up", mcp: "e2e_slash",
    summary: "Runs a slash command as the character.",
    examples: [["e2e slash \"/npc 2\"", "two hostile NPCs"], ["e2e slash \"/tr me 30002537\"", "move to a system by ID"]],
  },
  teleport: {
    group: "ship", needs: "up", mcp: "e2e_teleport",
    summary: "Moves the ship to another system, by name or ID.",
    examples: [["e2e teleport Rens", null]],
  },
  loadout: {
    group: "ship", needs: "up", mcp: "e2e_loadout",
    summary: "Gives the character a fitted ship, with modules, drones, cargo and charges named by item.",
    flags: [["--modules \"Name xN, ...\"", null, "Modules, fitted to the slots they need."], ["--drones", null, "Drones for the drone bay."],
      ["--cargo", null, "Items for the cargo hold."], ["--charges", null, "Charges to load into the modules."],
      ["--file <loadout.json> | --spec '<json>'", null, "The whole loadout as JSON instead."], ["--json", null, "Print the bridge's reply."]],
    examples: [["e2e loadout Tristan --modules \"Light Neutron Blaster II x2\" --drones \"Hobgoblin II x5\"", null]],
  },
  act: {
    group: "ship", needs: "up", mcp: "e2e_act",
    summary: "Makes the character act. The server applies every rule, so a refusal comes back in its own words.",
    flags: [["--range", "per action", "Orbit 5,000 m, keep at range 10,000 m, warp 0."], ["--target", "first locked", "Who activate aims at."],
      ["--once", null, "Activate a module for one cycle."], ["--charge", null, "The cargo charge loadAmmo loads."],
      ["--count", null, "How many drones launchDrones launches."], ["--timeout", "30 s", "How long lock waits for the server to list it."]],
    examples: [["e2e act lock nearest npc", "waits until the server lists the lock"], ["e2e act activate weapons", null],
      ["e2e act orbit \"name~Blood\" --range 2km", null], ["e2e act launchDrones --count 5", null],
      ["e2e act engageDrones nearest npc", null]],
  },
  grid: {
    group: "watch", needs: "up", mcp: "e2e_grid",
    summary: "Lists what's on grid, nearest first, with mode, target and shield, armour and hull.",
    flags: [["--range", "10,000 km", "The cut-off."], ["--all", null, "Everything the session can see."], ["--json", null, "The bridge's full reply."]],
  },
  watch: {
    group: "watch", needs: "up", mcp: "e2e_watch",
    summary: "Prints what changed on grid and why, as one timeline, and saves it as a run.",
    flags: [["--for", "600 s", "How long to watch."], ["--every", "2 s", "How often the grid is sampled."],
      ["--offgrid-every", "5 s", "How often plugins scan the rest of the system."],
      ["--grep <regex>", null, "Keep every log line that matches."], ["--no-log", null, "Drop the server log lines."],
      ["--client all|fx|diverge|off", "all", "Which client-view lines to print."],
      ["--diverge-meters", "5,000 m", "How far apart client and server may be before DIVERGE."],
      ["--positions", null, "Write the positions the replay map needs."], ["--perf", null, "Add the server's ticks, every --perf-every 5 s."],
      ["--run <id>", null, "Name the run folder."], ["--json", null, "Print the timeline lines as JSON."]],
  },
  perf: {
    group: "watch", needs: "up", mcp: "e2e_perf",
    summary: "Samples the server's ticks over a window and prints them, with the busiest scenes and the profiler's sections.",
    flags: [["--for", "10 s", "How long to sample, 1 to 600 s."], ["--now", null, "The ticks the server holds now, at once."],
      ["--json", null, "Print the figures as JSON."]],
  },
  view: {
    group: "watch",
    summary: "Prints the URL of the standalone replay viewer for a run.",
    flags: [["<run>", "the newest", "Which run."], ["--serve", null, "Serve the page from the CLI, even with a server up."],
      ["--port N", "a free one", "The port --serve uses."]],
  },
  run: {
    group: "scenarios", mcp: "e2e_run_scenario",
    summary: "Runs a scenario: boots its world, runs its steps, watches until it stops, and writes report.md. With no scenario, lists them.",
    flags: [["--check", null, "Only load and check the scenario. Boots nothing."], ["--run <id>", null, "Name the run folder."],
      ["--world <name>|fresh", "the scenario's", "Boot another world."], ["--keep-up", null, "Leave the server running afterwards."],
      ["--reuse", null, "Reset the server a --reuse run left up, instead of booting."],
      ["--detach", null, "Start the run in the background and print its ID; `e2e report <run> --wait 600` waits for it."],
      ["--json", null, "With no scenario, list them as JSON."]],
    examples: [["e2e run", "list the scenarios"], ["e2e run loadout-npc-fight", null], ["e2e run loadout-npc-fight --check", null],
      ["e2e run loadout-npc-fight --detach", "then e2e report <run> --wait 600"]],
  },
  scenario: {
    group: "scenarios", writes: true,
    summary: "Writes a new scenario to edit: a copy of another, or a template that checks out as it stands. Drafts go in _local/e2e/scenarios.",
    flags: [["--from <scenario>", "the template", "Copy this scenario (a name `e2e run` lists, or a path)."],
      ["--save", null, "Write it to the tree's tools/e2e-scenarios/, to commit with the feature."],
      ["--force", null, "Replace a scenario of that name."]],
    examples: [["e2e scenario new fleet-arrives", null], ["e2e scenario new my-fight --from loadout-npc-fight", null]],
  },
  report: {
    group: "scenarios", mcp: "e2e_report",
    summary: "Prints a run's report: its verdict, expected against observed, and its files. With no run, lists the recent runs. Exits 0 passed, 1 failed, 2 did not complete or no such run, 3 still running.",
    flags: [["<run>|latest", "the recent runs", "Which run."], ["--section summary|full|result|pr", "summary",
      "full adds the timeline, result is result.json, pr is markdown to cite the run in a PR."],
    ["--wait <s>", "0", "Wait up to this long for a run still going in the background."]],
    examples: [["e2e report", "the recent runs"], ["e2e report latest --wait 600", null], ["e2e report latest --section pr", null]],
  },
  primer: {
    group: "tool",
    summary: "Prints what an agent needs to drive the CLI: the workflow, the scenario format and the condition syntax, with the active plugins' notes.",
    flags: [["--mcp", null, "The MCP server's version, naming its tools instead of commands."]],
  },
  gui: {
    group: "tool",
    summary: "Serves this page on loopback.",
    flags: [["--port N", "a free one", "The port."], ["--tree <path>", null, "Add a tree to the list; repeat for more."],
      ["--open", null, "Open it in the default browser."]],
  },
  help: {
    group: "tool",
    summary: "Prints every command. --json prints this list as data.",
  },
};

const TAG_KEYS = ["needs", "managed", "writes", "mcp"];

// A usage table's lines, joined where a line continues the one before (it
// starts with spaces), then split at " | " into parts that each start with
// the command's name. A part that doesn't ("--spec '<json>'") stays with the
// one before.
function usageParts(name, usage) {
  const lines = [];
  for (const line of usage || [name]) {
    if (/^\s/.test(line) && lines.length) lines[lines.length - 1] += ` ${line.trim()}`;
    else lines.push(line.trim());
  }
  const parts = [];
  for (const line of lines) {
    for (const piece of line.split(" | ")) {
      if ((piece === name || piece.startsWith(`${name} `)) || !parts.length) parts.push(piece);
      else parts[parts.length - 1] += ` | ${piece}`;
    }
  }
  return parts;
}

// The doc key a usage part belongs to: "<name> <sub>" when DOCS has it, else the name.
function docKeyFor(name, part) {
  const sub = part.slice(name.length).trim().split(/\s+/)[0];
  return sub && DOCS[`${name} ${sub}`] ? `${name} ${sub}` : name;
}

function entryFrom(key, usage, doc, extra = {}) {
  const tags = {};
  for (const tag of TAG_KEYS) if (doc[tag]) tags[tag] = doc[tag];
  return { name: key, group: doc.group || "tool", summary: doc.summary || "", usage, ...tags,
    flags: (doc.flags || []).map(([flag, value, text]) => ({ flag, default: value, text })),
    examples: (doc.examples || []).map(([command, note]) => ({ command, note })), note: doc.note || null, ...extra };
}

// core: name -> { usage }; plugins: name -> { usage, plugin, summary, needs, writes }
// (registry.commands); handlers: name -> [{ usage, flags, plugin, summary }].
function buildCatalog({ core = {}, plugins = {}, handlers = {}, mcpTools = [] } = {}) {
  const commands = [];
  for (const [name, command] of Object.entries(core)) {
    const byKey = new Map();
    for (const part of usageParts(name, command.usage)) {
      const key = docKeyFor(name, part);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(part);
    }
    for (const [key, usage] of byKey) commands.push(entryFrom(key, usage, DOCS[key] || {}, DOCS[key] ? {} : { undocumented: true }));
  }
  const groups = GROUPS.map((group) => ({ ...group }));
  const pluginGroup = (plugin) => {
    const id = `plugin:${plugin}`;
    if (!groups.some((group) => group.id === id)) {
      groups.push({ id, title: `Plugin: ${plugin}`, text: `Commands the ${plugin} plugin adds. Only in trees it applies to.`, plugin });
    }
    return id;
  };
  for (const [name, command] of Object.entries(plugins)) {
    const doc = { group: pluginGroup(command.plugin), summary: command.summary, needs: command.needs, writes: command.writes };
    commands.push(entryFrom(name, usageParts(name, command.usage), doc, { plugin: command.plugin }));
  }
  for (const [name, rows] of Object.entries(handlers)) {
    for (const handler of rows) {
      const key = `${name} --${handler.flags.join(" --")}`;
      const doc = { group: pluginGroup(handler.plugin), summary: handler.summary, needs: handler.needs };
      commands.push(entryFrom(key, (handler.usage || [key]).map((line) => line.trim()), doc, { plugin: handler.plugin }));
    }
  }
  return {
    prefix: "node tools/evejs-e2e/bin/e2e.js",
    groups: groups.filter((group) => commands.some((command) => command.group === group.id)),
    commands,
    mcpTools: mcpTools.map((tool) => ({ name: tool.name, description: String(tool.description || "").split(/(?<=\.)\s/)[0] })),
  };
}

module.exports = { DOCS, GROUPS, buildCatalog, docKeyFor, usageParts };
