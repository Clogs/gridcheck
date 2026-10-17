"use strict";

// What each CLI command does, for `gridcheck help --json` and the GUI's Commands tab.
// The usage lines stay in bin/gridcheck.js's command table; this file adds a group,
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
  setup: {
    group: "setup", writes: true, needs: "down",
    summary: "Everything a tree needs before its first run, one command at a time: install the tool, write the config, connect agents, apply the patches, build starter and run smoke-undock. Skips what is done, so it can run again after a fix.",
    flags: [["--tree <path>", "the tree you're in", "The tree to set up."], ["--mode auto|attach|managed", "auto, or the config's", "The server mode to write."],
      ["--agents claude,codex,cli|none", "the agents found", "Which agents to connect."],
      ["--skip agents,patches,world,smoke", null, "Leave those steps out."], ["--force", null, "Replace a copy whose files were edited."],
      ["--dry-run", null, "Show each command and what it would change; write nothing."]],
    examples: [["gridcheck setup --tree <tree>", null], ["gridcheck setup --tree <tree> --dry-run", "see the plan first"]],
  },
  init: {
    group: "setup", writes: true,
    summary: "Writes the tree's gridcheck.config.json with its server mode, and probes which listeners the tree's source can move.",
    flags: [["--mode auto|attach|managed", "auto", "How runs get a server: use a running one, start their own, or both."],
      ["--force", null, "Replace an existing gridcheck.config.json."], ["--dry-run", null, "Print the config without writing it."]],
  },
  agents: {
    group: "setup", writes: true,
    summary: "Shows the Claude Code and Codex on this machine and whether each has this tree's gridcheck tools; setup adds them.",
    flags: [["status", null, "The default: what was found and what each agent already has."],
      ["setup [claude] [codex]", "both found", "Add the gridcheck MCP server to those agents. Only adds entries."],
      ["setup cli", null, "For any other agent: add a pointer to docs/CLI.md to the tree's AGENTS.md (or CLAUDE.md)."],
      ["--dry-run", null, "Show the lines setup would add."], ["--json", null, "Print the status as JSON."]],
  },
  doctor: {
    group: "setup", mcp: "doctor",
    summary: "Health check: asks the tree's copy which gateway calls, patches, listeners and client-view decoding work.",
    flags: [["--offline", null, "Read the tree's files even when a server is up."], ["--json", null, "Print the whole report."]],
  },
  "vendor update": {
    group: "setup", writes: true, needs: "down",
    summary: "Copies a Gridcheck checkout or tag into a tree's tools/gridcheck/, with the bridge shim.",
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
    examples: [["gridcheck world build starter", "every skill, a fitted Tristan docked in Amamake"]],
  },
  "world recipes": {
    group: "worlds",
    summary: "Lists the recipes, and whether each one's world is built and current.",
    flags: [["--json", null, "Print the list as JSON."]],
  },
  "world save": {
    group: "worlds", writes: true, needs: "down", managed: true,
    summary: "Snapshots the stopped world into _local/gridcheck/worlds/<name>/, so every run from it starts in the same place.",
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
    group: "server", managed: true, mcp: "up",
    summary: "Starts the server in the background with the agent bridge on, and waits until it's ready.",
    flags: [["--world <name>", null, "Replace the tree's world with a saved one before boot."],
      ["--fresh", null, "Delete the game store and boot a new one from the seed tables."],
      ["--no-market", null, "Don't start the market daemon."],
      ["--timeout", "600 s", "How long to wait for boot. After it, the server is left running."],
      ["--profile", null, "Boot with the tick profiler."], ["--profile-every", "50 ticks", "The profiler's window."]],
    note: "Refuses before touching the world when another process holds the world lease, a port in the tree's block is taken, " +
      "or the world is missing. Sets EVEJS_AGENT_BRIDGE=1 for you.",
    examples: [["gridcheck up --world starter", null]],
  },
  down: {
    group: "server", managed: true, mcp: "down",
    summary: "Stops the server cleanly: it runs the shutdown hooks, flushes the store and releases the world lease.",
    flags: [["--force", null, "Kill a server that has no bridge yet. Its lease stays live for 30 s."]],
  },
  status: {
    group: "server", mcp: "status",
    summary: "The mode, ports, server pid and boot time, gateway, bridge, daemons and the character held.",
  },
  ports: {
    group: "server",
    summary: "Prints this tree's block of 20 ports and what listens on each.",
  },
  log: {
    group: "server", mcp: "log",
    summary: "The tail of the server's log.",
    flags: [["--grep <regex>", null, "Keep matching lines, case-insensitively."], ["--lines", "40", "How many lines."],
      ["--any-pid", null, "Keep every process's lines, not only the running server's."]],
  },
  login: {
    group: "ship", needs: "up", mcp: "login",
    summary: "Logs a character in over the web gateway and starts the client view.",
    flags: [["--user", "e2eagent", "The account."], ["--name", null, "The character's name, for a new character."]],
  },
  client: {
    group: "ship", needs: "up",
    summary: "Starts a real EVE client logged in by token and in game, then reads and drives it from inside. Needs the opt-in client-agent patch.",
    flags: [["launch", null, "Start the client as the account's character and wait until it's in game, docked or in space. A client already in game on that account is used as it is."],
      ["console", null, "The end of the client's own console (its \"[CCP]\" window), where it prints its log and exceptions. --lines 0 for all, --grep to filter, --pid before an agent attaches."],
      ["status", null, "Whether the client agent is on, and which clients have attached, with their pid and build."],
      ["stop", null, "Have the client send its last events, then end its process."],
      ["ping", null, "The attached client's session, build and pid, and where it is (docked, in space, its ship's mode and speed)."],
      ["eval \"<python>\"", null, "Run Python in the client. An expression prints its value; statements print their last expression's, else what they leave in `result`. sm, session, uicore, blue and uthread are defined. assert works, though the client runs Python optimized."],
      ["ui", null, "The client's windows and UI tree from uicore.desktop. --class, --name or --text list every node containing it, with its path."],
      ["ui-state", null, "Every UI node, hidden ones too, flat, as JSON: path, rect, shown and enabled counting ancestors, opacity, full screen, scene, and which has focus and which is modal. --out saves it."],
      ["check-ui", null, "Assert on the UI: --spec '{\"selector\":{\"name\":...},\"count\":1,...}' or --file. Exits 1 unless it holds. A state cut short at --limit fails, since it can't show an absence."],
      ["screenshot", null, "What the client draws, as a PNG (or --out x.jpg), under _local/gridcheck/client/ or the run's client/ with --run. The client saves it, so it works while the window is covered or minimized."],
      ["ballpark", null, "The balls the client's ballpark holds: position, velocity, mode, nearest first."],
      ["diff", null, "The client's ballpark against the server's grid for the same character: missing, extra, moved and mode differences. Exits 1 on any."],
      ["events", null, "The client's exceptions, recorded notify events and actions, since it attached (the last --limit). A watch shows them as CLIENT_EXCEPTION and CLIENT_EVENT."],
      ["find", null, "One UI node by --path, or --class, --name and --text, and the node a click on it goes to."],
      ["click", null, "Click that node from inside the client, through its own click handler; prints any dialog it opened."],
      ["type \"<text>\"", null, "Type into the edit --path, --class, --name or --text names (the client has no focus while its window is in the background). --set sets the value at once, --enter presses enter after."],
      ["key <name>", null, "Press enter, escape, tab, backspace, f1-f12, a-z ... in the client; no ctrl, shift or alt, which it reads from the real keyboard."],
      ["cmd [<name>]", null, "Run a client command (OpenInventory, CmdStopShip ...) as its key binding would. No name lists them; --filter narrows the list."],
      ["act <action> [<target>]", null, "A player's action through the client's services: undock, dock, jump, warpTo, approach, orbit, keepAtRange, stop, lock, unlock, activate, deactivate, modules, logoff, select. Answers once it is done (in space, docked, in the new system, out of warp ...), with where the client is then and what it logged meanwhile; exits 1 when it isn't done in time. undock, dock and jump first wait out the client's session-change timer."],
      ["--user", "e2eclient for launch; the one attached client otherwise", "The account. Several clients run at once, one account each; never a headless pilot's."],
      ["--exe <exefile.exe>", "EVEJS_CLIENT_PATH from the launcher config", "launch: the client to start."],
      ["--resfileserver <url>", "the tree's gateway /resfiles/", "launch: where the client fetches resources."],
      ["--resfiles <folder>", "ResFiles beside the client's tq folder", "launch: the client's resource cache."],
      ["--wait <s>", "240", "How long launch waits for the client to reach the game; 0 doesn't wait."],
      ["--timeout <s>", "15", "How long a command waits for the client."],
      ["--file <py|json>", null, "eval: the Python, from a file (at most 256 KiB); check-ui: the check, from a JSON file."],
      ["--assert", null, "eval: exit 1 unless the value is exactly True."],
      ["--out <json>", null, "eval, ui-state, check-ui: also save the answer to this file."],
      ["--wait <s>", "0", "check-ui: read the UI again until the check holds, up to this long (at most 300)."],
      ["--stable <ms>", "0", "check-ui: the check must keep holding this long, on the same nodes, within --wait."],
      ["--any-build", null, "Run an op that uses the client's code on a build other than the one the agent was checked against (3396210)."],
      ["--depth N", "3, or 40 with a filter", "How deep ui walks."], ["--hidden", null, "ui also walks hidden nodes."],
      ["--source auto|client|window", "auto", "screenshot: client saves the back buffer; window draws the window from outside with PrintWindow (not while minimized, but works when the agent can't answer); auto tries client, then window."],
      ["--tolerance <m>", "1000", "diff: how far apart a ball may be, plus 2 s of its speed."],
      ["--notify OnA,OnB", "OnSessionChanged", "events: the notify events the client records from now on; \"\" for none."],
      ["--all", null, "events: every client's since the server started, not only the attached client's since it attached."],
      ["--since <seq>", null, "events: only those after this number, from any client; each listing ends with the one to pass next."],
      ["--limit N", "50 for events, 10000 for ui-state", "events: the most recent N; ui, ui-state, check-ui: the most nodes or matches."],
      ["--index N", null, "find, click, type, key: which of several matching nodes, from 0."],
      ["--wait <s>", "3", "click, cmd: how long to wait for what it started; past it, it reports still running (a dialog may be waiting)."],
      ["--wait <s>", "act: 120 warpTo; 60 undock, dock, jump, logoff, select, deactivate; 30 lock; 10 the rest", "act: the most to wait for the action to be done; 0 answers once it has started."],
      ["--range <m>", "warp: the client's default; orbit 5000; keepAtRange 10000", "act: the distance in metres."],
      ["--module <slot|itemID>", null, "act activate, deactivate: high1 ... low8, or the module's itemID (act modules lists them)."]],
    examples: [["gridcheck client launch", null], ["gridcheck client eval \"session.solarsystemid2\"", null],
      ["gridcheck client ui --text undock", null], ["gridcheck client diff", null],
      ["gridcheck client click --text undock", null], ["gridcheck client act warpTo 40491241", null],
      ["gridcheck client type \"rifter\" --name quickFilterInputBox", null], ["gridcheck client launch --user e2eclient2 --name \"Client Second\"", null]],
  },
  logout: {
    group: "ship", needs: "up",
    summary: "Releases the held character's session.",
  },
  undock: {
    group: "ship", needs: "up", mcp: "undock",
    summary: "Undocks the held character's ship.",
  },
  dock: {
    group: "ship", needs: "up",
    summary: "Docks with stock /dock, which goes back to the home station.",
  },
  slash: {
    group: "ship", needs: "up", mcp: "slash",
    summary: "Runs a slash command as the character.",
    examples: [["gridcheck slash \"/npc 2\"", "two hostile NPCs"], ["gridcheck slash \"/tr me 30002537\"", "move to a system by ID"]],
  },
  teleport: {
    group: "ship", needs: "up", mcp: "teleport",
    summary: "Moves the ship to another system, by name or ID.",
    examples: [["gridcheck teleport Rens", null]],
  },
  loadout: {
    group: "ship", needs: "up", mcp: "loadout",
    summary: "Gives the character a fitted ship, with modules, drones, cargo and charges named by item.",
    flags: [["--modules \"Name xN, ...\"", null, "Modules, fitted to the slots they need."], ["--drones", null, "Drones for the drone bay."],
      ["--cargo", null, "Items for the cargo hold."], ["--charges", null, "Charges to load into the modules."],
      ["--file <loadout.json> | --spec '<json>'", null, "The whole loadout as JSON instead."], ["--json", null, "Print the bridge's reply."]],
    examples: [["gridcheck loadout Tristan --modules \"Light Neutron Blaster II x2\" --drones \"Hobgoblin II x5\"", null]],
  },
  act: {
    group: "ship", needs: "up", mcp: "act",
    summary: "Makes the character act. The server applies every rule, so a refusal comes back in its own words.",
    flags: [["--range", "per action", "Orbit 5,000 m, keep at range 10,000 m, warp 0."], ["--target", "first locked", "Who activate aims at."],
      ["--once", null, "Activate a module for one cycle."], ["--charge", null, "The cargo charge loadAmmo loads."],
      ["--count", null, "How many drones launchDrones launches."], ["--timeout", "30 s", "How long lock waits for the server to list it."]],
    examples: [["gridcheck act lock nearest npc", "waits until the server lists the lock"], ["gridcheck act activate weapons", null],
      ["gridcheck act orbit \"name~Blood\" --range 2km", null], ["gridcheck act launchDrones --count 5", null],
      ["gridcheck act engageDrones nearest npc", null]],
  },
  grid: {
    group: "watch", needs: "up", mcp: "grid",
    summary: "Lists what's on grid, nearest first, with mode, target and shield, armour and hull.",
    flags: [["--range", "10,000 km", "The cut-off."], ["--all", null, "Everything the session can see."],
      ["--kind <kind>", null, "Only rows of this kind (planet, stargate, asteroid...). Without it, more than 10 of a kind that isn't a ship collapse to a count."],
      ["--json", null, "The bridge's full reply."]],
  },
  watch: {
    group: "watch", needs: "up", mcp: "watch",
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
    group: "watch", needs: "up", mcp: "perf",
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
    group: "scenarios", mcp: "run_scenario",
    summary: "Runs a scenario: boots its world, runs its steps, watches until it stops, and writes report.md. With no scenario, lists them.",
    flags: [["--check", null, "Only load and check the scenario. Boots nothing."], ["--run <id>", null, "Name the run folder."],
      ["--world <name>|fresh", "the scenario's", "Boot another world."], ["--keep-up", null, "Leave the server running afterwards."],
      ["--reuse", null, "Reset the server a --reuse run left up, instead of booting."],
      ["--detach", null, "Start the run in the background and print its ID; `gridcheck report <run> --wait 600` waits for it."],
      ["--json", null, "With no scenario, list them as JSON."]],
    examples: [["gridcheck run", "list the scenarios"], ["gridcheck run loadout-npc-fight", null], ["gridcheck run loadout-npc-fight --check", null],
      ["gridcheck run loadout-npc-fight --detach", "then gridcheck report <run> --wait 600"]],
  },
  scenario: {
    group: "scenarios", writes: true,
    summary: "Writes a new scenario to edit: a copy of another, or a template that checks out as it stands. Drafts go in _local/gridcheck/scenarios.",
    flags: [["--from <scenario>", "the template", "Copy this scenario (a name `gridcheck run` lists, or a path)."],
      ["--save", null, "Write it to the tree's tools/gridcheck-scenarios/, to commit with the feature."],
      ["--force", null, "Replace a scenario of that name."]],
    examples: [["gridcheck scenario new fleet-arrives", null], ["gridcheck scenario new my-fight --from loadout-npc-fight", null]],
  },
  report: {
    group: "scenarios", mcp: "report",
    summary: "Prints a run's report: its verdict, expected against observed, and its files. With no run, lists the recent runs. Exits 0 passed, 1 failed, 2 did not complete or no such run, 3 still running.",
    flags: [["<run>|latest", "the recent runs", "Which run."], ["--section summary|full|result|pr", "summary",
      "full adds the timeline, result is result.json, pr is markdown to cite the run in a PR."],
    ["--wait <s>", "0", "Wait up to this long for a run still going in the background."]],
    examples: [["gridcheck report", "the recent runs"], ["gridcheck report latest --wait 600", null], ["gridcheck report latest --section pr", null]],
  },
  primer: {
    group: "tool",
    summary: "Prints what an agent needs to drive the CLI: the workflow, the scenario format, the condition syntax, every event's fields and performance runs, with the active plugins' notes. A topic prints one part.",
    flags: [["<topic>", "all of them", "start, scenarios, conditions, events, perf or plugins."],
      ["--mcp", null, "The MCP server's version, naming its tools instead of commands."]],
    examples: [["gridcheck primer", null], ["gridcheck primer events", "each event kind's fields"]],
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
    prefix: "node tools/gridcheck/bin/gridcheck.js",
    groups: groups.filter((group) => commands.some((command) => command.group === group.id)),
    commands,
    mcpTools: mcpTools.map((tool) => ({ name: tool.name, description: String(tool.description || "").split(/(?<=\.)\s/)[0] })),
  };
}

const NEEDS_TEXT = { up: "a running server", down: "a stopped server" };

// `gridcheck <command> --help` and `gridcheck help <command> [<sub>]`: the
// command's usage, summary, flags and examples from the catalog, or null when
// it has no such command. With sub, only that part: its usage, its own row, the
// flags whose text names it or names no part at all, and its examples.
function commandHelp(catalog, name, sub) {
  const entries = catalog.commands.filter((entry) => entry.name === name || entry.name.startsWith(`${name} `));
  if (!entries.length) return null;
  const own = sub && entries.find((entry) => entry.name === `${name} ${sub}`);
  const narrow = Boolean(sub && !own);
  const lines = [];
  for (const entry of own ? [own] : entries) {
    let { usage, flags, examples } = entry;
    if (narrow) {
      const words = flags.filter((row) => !row.flag.startsWith("-")).map((row) => row.flag.split(/\s/)[0]);
      if (!words.includes(sub)) {
        throw new Error(`${name} has no ${sub}; it has ${words.join(", ")}. \`gridcheck ${name} --help\` shows them all.`);
      }
      const named = (text) => words.filter((word) => new RegExp(`\\b${word}\\b`).test(text));
      usage = usage.filter((part) => part.slice(name.length).trim().split(/\s/)[0].split("|").includes(sub));
      flags = flags.filter((row) => (row.flag.startsWith("-")
        ? named(row.text).length === 0 || named(row.text).includes(sub)
        : row.flag.split(/\s/)[0] === sub));
      examples = examples.filter((example) => example.command.startsWith(`gridcheck ${name} ${sub}`));
    }
    for (const part of usage) lines.push(`gridcheck ${part}`);
    if (!narrow) {
      if (entry.summary) lines.push("", entry.summary);
      const tags = [entry.needs && `needs ${NEEDS_TEXT[entry.needs] || entry.needs}`, entry.managed && "not in attach mode",
        entry.writes && "changes files in the tree", entry.mcp && `MCP tool: ${entry.mcp}`].filter(Boolean);
      if (tags.length) lines.push(`(${tags.join("; ")})`);
    }
    if (flags.length) {
      const width = Math.min(28, Math.max(...flags.map((row) => row.flag.length)) + 2);
      lines.push("");
      for (const row of flags) lines.push(`  ${row.flag.padEnd(width)}${row.text}${row.default ? ` (default: ${row.default})` : ""}`);
    }
    if (examples.length) {
      lines.push("", "Examples:");
      for (const example of examples) lines.push(`  ${example.command}${example.note ? `   # ${example.note}` : ""}`);
    }
    if (entry.note && !narrow) lines.push("", entry.note);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

module.exports = { DOCS, GROUPS, buildCatalog, commandHelp, docKeyFor, usageParts };
