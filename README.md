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
and `StartServer.bat` would otherwise do on first run.

```bash
cd F:/EveJS-0.12.9
npm ci
cd server && npm ci && cd ..
tools/DatabaseCreator/CreateDatabase.bat        # Windows; downloads the SDE build it names
```

`CreateDatabase.bat` downloads the EVE static data export (several hundred MB), extracts it to
`_local/sde/`, and writes `_local/gameStore/data`. If you already have that build extracted, run the
generator directly instead, on any OS. The build number is `SDE_BUILD` in `CreateDatabase.bat`;
0.12.9 names 3396210:

```bash
node --max-old-space-size=8192 tools/DatabaseCreator/database-creator.js \
  --sde-dir <extracted eve-online-static-data-3396210-jsonl> --out _local/gameStore/data --build 3396210 \
  --sde-url https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-3396210-jsonl.zip --force
```

**3. Install the tool into the tree, from the GUI.** From the evejs-e2e checkout:

```bash
node bin/e2e.js gui --tree F:/EveJS-0.12.9 --open
```

Open the printed URL if no browser opens. Then, on the **Install** tab:

1. "Preview install", read what it will copy, then **Run**. That vendors this checkout into
   `tools/evejs-e2e/` and adds a one-file shim the server's loader finds.
2. Choose **managed** mode, "Preview config", then **Run**. That writes `e2e.config.json`; managed
   mode lets the tool start and stop the server and build worlds.
3. Check that "What the tree needs to run" is all ticked, and run **e2e doctor**.

On the **Patches** tab, apply `last-decision`, `slash-success` and `xmpp-port`. They're optional
and revert byte for byte. Without them stock reports no NPC decisions and no slash-command
outcomes, and two stock trees can't run at once. Each change shows its preview first.
[docs/GUI.md](docs/GUI.md) describes every tab.

Without the GUI, the same three steps are:

```bash
node bin/e2e.js vendor update --tree F:/EveJS-0.12.9                     # in the evejs-e2e checkout
cd F:/EveJS-0.12.9
node tools/evejs-e2e/bin/e2e.js init --mode managed
node tools/evejs-e2e/bin/e2e.js patch apply last-decision slash-success xmpp-port
```

**4. Build a starting world and run a fight.** In the tree:

```bash
node tools/evejs-e2e/bin/e2e.js world build starter        # every skill, a fitted Tristan docked in Amamake
node tools/evejs-e2e/bin/e2e.js run loadout-npc-fight      # two rats spawn; drones and guns kill one
```

The run boots the server, plays the scenario, stops the server, and prints its verdict and the path
of its `report.md`. `starter` takes about 20 s to build and the fight about a minute.

**5. Replay it.** In the GUI's **Runs** tab, pick the run to see its report and frames, then
**Open replay** for the viewer. From a shell, `node tools/evejs-e2e/bin/e2e.js view` prints the
viewer's URL.

## Agents

### MCP

`tools/evejs-e2e/bin/mcp.js` is an MCP server over stdio with the CLI's commands as tools. Its
instructions teach an agent the workflow and the scenario format.

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

### The CLI

`node tools/evejs-e2e/bin/e2e.js help` lists every command. The ones used most, with `e2e` standing
for `node tools/evejs-e2e/bin/e2e.js` in the tree:

```bash
e2e up --world starter | down | status | doctor
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
| [docs/GUIDE.md](docs/GUIDE.md) | Everything the tool does: grids, watches, the client view, player actions, scenarios, frames, the viewer, plugins. |
| [docs/TREES.md](docs/TREES.md) | A tree's `e2e.config.json`, attach and managed mode, `e2e doctor`, and how the tool is tested. |
| [docs/WORLDS.md](docs/WORLDS.md) | Loadouts by item name, and world recipes such as `starter`. |
| [docs/PATCHES.md](docs/PATCHES.md) | The optional stock edits and how apply and revert work. |
| [docs/GUI.md](docs/GUI.md) | The GUI, its rules for changes, and its API for scripts. |

## Keeping a tree's copy current

A tree runs a vendored copy: `tools/evejs-e2e/`, the shim at
`server/src/_secondary/agentBridge/server.js`, and `tools/evejs-e2e/VENDOR.json`, which records the
commit and a sha256 for every file. Commit all three in the tree. Change the tool here, never in a
tree's copy:

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
