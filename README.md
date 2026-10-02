# evejs-e2e

End-to-end testing for EveJS (EVE.js) servers, with no EVE client. It
boots a tree's server, logs a headless character in through the web gateway, undocks it, runs slash
commands, flies and fights, and records the grid as a timeline. A scenario states what should
happen. The tool runs it and writes a report with tactical frames, and a browser viewer replays
the run. It also checks what the client would have been sent against what the server did.

It's written for agents first: every command is a CLI call or an MCP tool, and scenarios are JSON
an agent writes for the feature in front of it. A web GUI covers installing, patching and replaying.

- Node 24 or later, git, and an EveJS tree: stock EveJS 0.12.9, or a fork of it.
- No dependencies. Everything listens on `127.0.0.1` only.
- AGPL-3.0, as EveJS is. See [NOTICE](NOTICE).

## Quick start

These steps take a freshly unpacked stock EveJS zip to a recorded fight. Paths are examples. On
Windows, use forward slashes or quote the paths.

**1. Get the tool.**

```bash
git clone https://github.com/Clogs/evejs-e2e.git
cd evejs-e2e
```

**2. Prepare the tree.** Unpack the EveJS zip, for example to `F:/EveJS-0.12.9`, then install its
dependencies and build its reference data. This is the tree's own setup, which its `SetupEveJS.bat`
and `StartServer.bat` would otherwise do on first run. The 0.12.9 zip has no wrapper folder: the
folder you unpack into is the tree, with `server/` directly inside it.

```powershell
Expand-Archive G:/Downloads/EveJS-v0.12.9.zip -DestinationPath F:/EveJS-0.12.9   # PowerShell
C:\Windows\System32\tar.exe -xf G:\Downloads\EveJS-v0.12.9.zip -C F:\EveJS-0.12.9  # or Windows' tar
```

A `tar` from Git Bash is GNU tar, which reads `G:` as a remote host and can't read zips. Then:

```bash
cd F:/EveJS-0.12.9
npm ci
cd server && npm ci && cd ..
tools/DatabaseCreator/CreateDatabase.bat        # Windows; downloads the SDE build it names
```

Recent npm versions warn that `better-sqlite3` and `protobufjs` have install scripts not covered by
`allowScripts`. The server boots without approving them.

`CreateDatabase.bat` downloads the EVE static data export (several hundred MB), extracts it to
`_local/sde/`, and writes `_local/gameStore/data`. If you already have that build extracted, run the
generator directly instead, on any OS. The build number is `SDE_BUILD` in `CreateDatabase.bat`;
0.12.9 names 3396210:

```bash
node --max-old-space-size=8192 tools/DatabaseCreator/database-creator.js \
  --sde-dir <extracted eve-online-static-data-3396210-jsonl> --out _local/gameStore/data --build 3396210 \
  --sde-url https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-3396210-jsonl.zip --force
```

**3. Set the tree up.** From the evejs-e2e checkout, one command does the rest:

```bash
node bin/e2e.js setup --tree F:/EveJS-0.12.9 --dry-run   # every command it would run, and what each would change
node bin/e2e.js setup --tree F:/EveJS-0.12.9             # about two minutes on a new tree
```

It installs the tool into `tools/evejs-e2e/`, writes `e2e.config.json` in auto mode, connects the
Claude Code and Codex it finds, applies the three optional patches, builds the `starter` world and
runs `smoke-undock`, printing each command before it runs it. It skips what is already done and
stops at the first step that fails, so run it again after a fix. `--agents cli` points any other
agent at [docs/CLI.md](docs/CLI.md) instead, `--agents none` connects none, and `--skip` leaves
steps out ([docs/TREES.md](docs/TREES.md#setting-a-tree-up)).

**Or set it up from the GUI.** From the evejs-e2e checkout:

```bash
node bin/e2e.js gui --tree F:/EveJS-0.12.9 --open
```

On Windows, double-clicking `OpenGui.bat` in the checkout does the same without `--tree`: add the
tree by its path on the Install tab. Open the printed URL if no browser opens. **Set up everything…**
on the Install tab runs the same `setup`, previewed first. Or work through the tab's checklist,
whose banner says when the tree is ready to run tests:

1. "Install…", read what it will copy, then **Run**. That vendors this checkout into
   `tools/evejs-e2e/` and adds a one-file shim the server's loader finds.
2. Under "Choose a server mode", keep **Auto**, "Write config…", then **Run**. That writes
   `e2e.config.json`. In auto mode the tool uses the tree's server when it's up and starts its own
   when it isn't.
3. Under **AI agents**, "Connect…" next to each agent found on this machine (Claude Code, Codex)
   shows the entry it gets, then **Run** writes it. Agents are optional.
4. Check that "Dependencies and reference data" has a tick, and run the **health check**
   (`e2e doctor`) on the Plugins row.

An unpacked zip isn't a git checkout, so the GUI can't check its files for uncommitted changes,
and each preview says so. In a tree that is a git checkout, a change to a file with uncommitted
edits is refused.

On the **Patches** tab, apply `last-decision`, `slash-success` and `xmpp-port`. They're optional
and revert byte for byte. Without them stock reports no NPC decisions and no slash-command
outcomes, and two stock trees can't run at once. Each change shows its preview first.
[docs/GUI.md](docs/GUI.md) describes every tab.

Step by step without the GUI, these are the commands `setup` runs:

```bash
node bin/e2e.js vendor update --tree F:/EveJS-0.12.9                     # in the evejs-e2e checkout
cd F:/EveJS-0.12.9
node tools/evejs-e2e/bin/e2e.js init                                     # auto mode
node tools/evejs-e2e/bin/e2e.js agents setup                             # the agents it finds
node tools/evejs-e2e/bin/e2e.js patch apply last-decision slash-success xmpp-port
node tools/evejs-e2e/bin/e2e.js world build starter                      # every skill, a fitted Tristan docked in Amamake
node tools/evejs-e2e/bin/e2e.js run smoke-undock
```

**4. Run a fight.** From the checkout, `--tree` runs the tree's own copy; in the tree, run the copy
directly:

```bash
node bin/e2e.js --tree F:/EveJS-0.12.9 run loadout-npc-fight   # two rats spawn; drones and guns kill one
node tools/evejs-e2e/bin/e2e.js run loadout-npc-fight          # the same, in the tree
```

`npm link` in the checkout puts `e2e` on your `PATH`, so `e2e --tree <tree> <command>` works from any
folder, and `e2e <command>` inside a tree ([docs/TREES.md](docs/TREES.md#running-from-a-checkout)).

With no server up, the run boots one, plays the scenario, stops the server, and prints its verdict
and the path of its `report.md`. If you started the tree's server yourself with
`EVEJS_AGENT_BRIDGE=1` set, the run uses it instead and leaves it running. In a new tree the first `starter` build took 80 s, most of it the first boot
seeding a game store; a rebuild takes about 20 s. The fight took about 50 s, boot and shutdown
included.

**5. Replay it.** In the GUI's **Runs** tab, pick the run on the left. The replay plays in the
middle, and its expectations, frames and report sit on the right. **Trace** shows the run as one
timeline with a lane per ship. From a shell, `node tools/evejs-e2e/bin/e2e.js view` prints the
standalone viewer's URL.

## Agents

### MCP

`tools/evejs-e2e/bin/mcp.js` is an MCP server over stdio with the CLI's commands as tools. Its
instructions teach an agent the workflow and the scenario format.

The GUI's **Agents** step, or `node tools/evejs-e2e/bin/e2e.js agents setup` in the tree, registers
it with the Claude Code and Codex it finds on this machine. `e2e agents` shows what it found and
what each already has. [docs/GUIDE.md](docs/GUIDE.md#setting-up-agents) has the rules. By hand,
it's these entries.

Claude Code: add `.mcp.json` at the tree's root, and start the session in the tree.

```json
{
  "mcpServers": {
    "e2e": { "type": "stdio", "command": "node", "args": ["tools/evejs-e2e/bin/mcp.js"] }
  }
}
```

Codex: add the server to `~/.codex/config.toml`, with the tree's absolute path. The server finds
its tree from its own location, so it doesn't depend on the working directory. A run takes minutes,
so raise the tool timeout, or use `wait: false` and `e2e_report`.

```toml
[mcp_servers.e2e]
command = "node"
args = ["F:/EveJS-0.12.9/tools/evejs-e2e/bin/mcp.js"]
tool_timeout_sec = 600
```

Start with `e2e_status` and `e2e_doctor`. To check a feature, have the agent write a scenario and
run it with `e2e_run_scenario`. [docs/GUIDE.md](docs/GUIDE.md#agent-mcp-tools) lists the tools.

### The CLI, for agents without MCP

Any agent that can run a shell can use the CLI instead. `e2e agents setup cli` adds a short pointer
to the tree's `AGENTS.md` (or `CLAUDE.md`) that sends the agent to [docs/CLI.md](docs/CLI.md), the
whole workflow in one page. `e2e primer` prints the scenario format for it, and
`e2e run <scenario> --detach` with `e2e report <run> --wait 600` keeps each call short.

### The CLI

`node tools/evejs-e2e/bin/e2e.js help` lists every command, and the GUI's **Commands** tab says what
each one does, with its flags. The ones used most, with `e2e` standing for
`node tools/evejs-e2e/bin/e2e.js` in the tree:

```bash
e2e up --world starter | down | status | doctor | agents
e2e login | undock | grid | slash "/npc 2" | teleport Rens
e2e loadout Tristan --modules "Light Neutron Blaster II x2" --drones "Hobgoblin II x5"
e2e act lock nearest npc | act activate weapons | act launchDrones | act engageDrones nearest npc
e2e watch --for 120
e2e run <scenario> [--check]
e2e view | gui
```

## Documentation

| Page | Covers |
| --- | --- |
| [docs/CLI.md](docs/CLI.md) | The workflow for an agent that drives the tool from a shell, with no MCP. |
| [docs/GUIDE.md](docs/GUIDE.md) | Everything the tool does: grids, watches, the client view, player actions, scenarios, frames, the viewer, plugins. |
| [docs/TREES.md](docs/TREES.md) | A tree's `e2e.config.json`, attach and managed mode, `e2e doctor`, and how the tool is tested. |
| [docs/WORLDS.md](docs/WORLDS.md) | Loadouts by item name, and world recipes such as `starter`. |
| [docs/PATCHES.md](docs/PATCHES.md) | The optional stock edits and how apply and revert work. |
| [docs/GUI.md](docs/GUI.md) | The GUI, its rules for changes, and its API for scripts. |

## Keeping a tree's copy current

A tree runs a vendored copy: `tools/evejs-e2e/`, the shim at
`server/src/_secondary/agentBridge/server.js`, and `tools/evejs-e2e/VENDOR.json`, which records the
commit and a sha256 for every file. In a tree kept in git, commit all three. Change the tool here,
never in a tree's copy:

```bash
node bin/e2e.js vendor update --tree <tree>                # this checkout's HEAD
node bin/e2e.js vendor update --from v0.1.0 --tree <tree>  # a tag
node tools/evejs-e2e/bin/e2e.js vendor check               # in the tree: fails on any edited file
```

A tree's own scenarios go in its `tools/e2e-scenarios/`, outside the copy.

## Plugins

A mod adds its own events, scenario steps, commands and MCP tools as a plugin in
`plugins/<name>/plugin.js`. Each plugin says whether it applies to a tree, and the core skips it
in trees without its mod. [docs/GUIDE.md](docs/GUIDE.md#plugins) has the contract. This repo ships
`plugins/lu` for the X-Eve Living Universe fork.

## Testing the tool

```bash
npm test                                                           # no EveJS tree needed
npm run compat -- --stock <EveJS zip> --lu <LU fork tree>          # live round trips in both lanes
```

`npm test` replays fixtures recorded from a stock tree. `npm run compat` unpacks the zip, vendors
this checkout into each tree, boots them, and writes `compat-report.md`. [docs/TREES.md](docs/TREES.md#testing-the-tool)
has the details.
