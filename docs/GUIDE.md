# The evejs-e2e guide

How an agent checks what happens on grid in an EveJS tree without the EVE client. A character logs
in through the web gateway, undocks, runs slash commands on its own session, flies and fights, and
reads its grid as a table or a timeline. Use it for final verification of a feature; it doesn't
replace a tree's own unit tests.

Commands here are run from the tree's root, where the tool is vendored as `tools/evejs-e2e/`. The
[README](../README.md) covers installing it. [TREES.md](TREES.md) covers a tree's config and the two
ways to run its server, [WORLDS.md](WORLDS.md) loadouts and world recipes, [PATCHES.md](PATCHES.md)
the optional stock edits, and [GUI.md](GUI.md) the web page.

```bash
node tools/evejs-e2e/bin/e2e.js world build starter        # a fitted Tristan docked in Amamake
node tools/evejs-e2e/bin/e2e.js up --world starter         # boot it
node tools/evejs-e2e/bin/e2e.js login                      # account e2eagent, character Agent Observer
node tools/evejs-e2e/bin/e2e.js undock
node tools/evejs-e2e/bin/e2e.js slash "/npc 2"             # any slash command, on the character's session
node tools/evejs-e2e/bin/e2e.js grid
node tools/evejs-e2e/bin/e2e.js act lock nearest npc       # fly, lock, fire, drones; see "Player actions"
node tools/evejs-e2e/bin/e2e.js watch --for 120            # what changed and where the client's view disagrees
node tools/evejs-e2e/bin/e2e.js down
node tools/evejs-e2e/bin/e2e.js run loadout-npc-fight      # all of that in one command, with a report
node tools/evejs-e2e/bin/e2e.js view                       # replay a run in a browser
```

`e2e help` lists every command, the active plugins' included. State (account, character,
`bridgeSessionID`) lives in `_local/e2e/state.json`, so each command is a separate process. An
agent can do all of this through the `e2e` MCP tools instead of a shell.

## Agent MCP tools

`tools/evejs-e2e/bin/mcp.js` is an MCP server over the CLI. Each tool runs
`node tools/evejs-e2e/bin/e2e.js <command>` in the tree and returns what the CLI printed, so a
session in a worktree drives that worktree's server. The CLI stays the source of truth: a tool adds
no rule of its own, and anything a tool did can be repeated in a shell. The server speaks MCP over
stdio, has no dependencies and opens no port.

### Setting up agents

`e2e agents` says which agents this machine has and whether each already runs this tree's server.
`e2e agents setup` registers it with every agent it finds; name `claude` or `codex` to choose, or
to set one up that it didn't find. `--dry-run` prints the lines it would add and writes nothing. The
GUI's Install tab runs the same command, with the agents it found ticked.

| Agent | Found by | Writes |
| --- | --- | --- |
| Claude Code | `claude` on `PATH`, `~/.claude` or `~/.claude.json` | `.mcp.json` at the tree's root: server `e2e`, `node tools/evejs-e2e/bin/mcp.js`. Start Claude Code in the tree; it asks once to approve the project's server. |
| Codex | `codex` on `PATH`, or `~/.codex` (`CODEX_HOME` moves it) | `[mcp_servers.e2e]` at the end of `config.toml`, with the copy's absolute path and `tool_timeout_sec = 600`. |

A setup only adds. It merges into an existing `.mcp.json` and keeps its other servers, and it
appends to `config.toml`, keeping every byte before its own table. Codex reads one file for every
folder. When another tree already has `e2e` there, this tree's server is named
`e2e-<folder>`. The one entry setup replaces is a Codex `e2e` whose `mcp.js` no longer exists. A
`config.toml` that defines `mcp_servers` inline isn't edited, and the error shows the table to add
by hand. When an entry already runs this tree's `mcp.js`, setup leaves it as it is.

| Tool | CLI | Notes |
| --- | --- | --- |
| `e2e_status` | `status`, `world list`, `run` | Start here: server, character, saved worlds and recipes, scenarios, active plugins, recent runs and background runs. |
| `e2e_doctor` | `doctor` | What the tree supports: gateway calls, the client view, patches, plugins, ports, loadouts. |
| `e2e_up`, `e2e_down` | `up`, `down` | Auto and managed mode. In auto mode `down` stops only a server `up` started. |
| `e2e_login`, `e2e_undock`, `e2e_teleport` | `login`, `undock`, `teleport` | `e2e_teleport` is stock `/tr`. |
| `e2e_loadout` | `loadout` | A ship and its fit by item name, skills checked first. |
| `e2e_grid` | `grid` | `json: true` prints the field names conditions use. |
| `e2e_slash` | `slash` | The command goes after `--`, so it is never read as flags. A refused command is a tool error. |
| `e2e_watch` | `watch` | `seconds` defaults to 60, not the CLI's 600, because the call blocks for the whole watch. Call `e2e_act` in the same turn to watch its effect. |
| `e2e_act` | `act` | A player action, with the names a scenario's action step uses: `action`, `target`, `modules`, `drones`, `range`, `once`, `charge`, `count`, `timeout`. |
| `e2e_log` | `log` | |
| `e2e_perf` | `perf` | `seconds` (default 10) to sample, or `now`. See [Performance testing](#performance-testing). `e2e_up` takes `profile` and `profileEvery`, and `e2e_watch` takes `perf` and `perfEvery`. |
| `e2e_run_scenario` | `run` | Writes a scenario it is handed, checks it, runs it. See below. |
| `e2e_report` | none | Reads a run's `report.md` and `result.json`; waits for a background run. |

A plugin's tools are named `e2e_<plugin>_<tool>`. The server's MCP instructions carry a primer:
the workflow, the scenario format and the condition syntax, then each active plugin's own primer.
An agent with no other context can write a scenario from them. When an argument fails its schema
check, the tool returns an error naming the argument, and the CLI never runs. CLI messages name CLI
commands: "`e2e login` first" means the `e2e_login` tool.

**Runs.** `e2e_run_scenario` takes `name`: a scenario in the tree's `tools/e2e-scenarios/`, the
tool's `tools/evejs-e2e/scenarios/` or a plugin's `plugins/<name>/scenarios/`, or a path. With
`scenario`, a JSON object, it first writes `<name>.json`: to `_local/e2e/scenarios/` as a draft,
or with `save: true` to `tools/e2e-scenarios/` to commit with the feature. It always runs
`e2e run --check` first and stops there on a problem, or when `check: true`. Then:

- by default it waits for the run and returns the end of the console, the report without its
  timeline, and the paths of the report, timeline and frames. With a progress token it sends one
  progress notification a second with the latest console line;
- `wait: false` starts the run detached and returns its run ID at once, with the console in
  `_local/e2e/background/<run>.log`. `e2e_report { run, waitSeconds: 600 }` waits for it, up to 600 s a
  call. Use this where the client limits a tool call's time (Codex: 60 s by default);
- cancelling the call kills the CLI and runs `e2e down`, since a killed CLI can't, unless the run
  was using a server that was already up (attach mode, or auto mode with a server up). `e2e_down`
  ends a background run early, and the run still writes its report.

`e2e_report` with no `run` lists recent runs and their verdicts; `run: "latest"` is the newest.
`section` is `summary` (the default), `full` (with the timeline), `result` (`result.json`) or `pr`
(see [Citing a run in a PR](#citing-a-run-in-a-pr)).

Every tool has a CLI form, for agents that don't use MCP. `e2e run <scenario> --detach` is
`wait: false`, `e2e report [<run>|latest] [--section ...] [--wait <s>]` is `e2e_report`, and
`e2e primer` prints these instructions naming CLI commands. [CLI.md](CLI.md) is the reference.

## What runs where

| Piece | Where | What it does |
| --- | --- | --- |
| Web gateway | the tree's `server/src/_secondary/express/` | Account, character, session select, `ship.Undock`, and the player calls. Stock EveJS. |
| Agent bridge | `tools/evejs-e2e/bridge/`, loaded by the shim `server/src/_secondary/agentBridge/server.js` | `/slash`, `/grid`, `/watch`, `/tee`, `/loadout`, `/capabilities`, `/shutdown`, the [viewer](#viewer) at `/viewer`, and the plugins' routes. Off unless `EVEJS_AGENT_BRIDGE=1`. |
| CLI | `tools/evejs-e2e/bin/e2e.js`, with `core/` | Calls the gateway and the bridge, and runs the plugins' commands and steps. Writes `_local/e2e/`. |
| MCP server | `tools/evejs-e2e/bin/mcp.js` | The CLI as MCP tools over stdio. |
| GUI | `tools/evejs-e2e/gui/`, `core/gui.js` | `e2e gui`: runs, install and patches in a browser ([GUI.md](GUI.md)). |
| Plugins | `tools/evejs-e2e/plugins/<name>/` | What a mod adds, on both sides. Skipped in a tree without the mod. |
| Tree config | `e2e.config.json` at the tree's root | The tree's paths, the mode, which listeners move, optional daemons ([TREES.md](TREES.md)). |
| Market daemon | `externalservices/market-server/`, in trees that have one | Started by `e2e up` when the config turns it on. Stock EveJS has none. |

The gateway session is a real registered session. After `undock` it sits in the scene's
`sessions` map, as a client's would. Slash commands go through the bridge, which calls the tree's
`executeChatCommand(session, line, null, {})`. The `null` chat hub sends the reply back to the
caller, and every rule stays in the command handler.

The bridge listens on `127.0.0.1` only. Its bearer token is in the handshake file
(`_local/agentBridge/bridge.json` by default), written at listen and removed at shutdown, with the
server's ports, log and data dir. `GET /health` needs no token. Override the port with
`EVEJS_AGENT_BRIDGE_PORT` and the handshake path with `EVEJS_AGENT_BRIDGE_HANDSHAKE`.

### Plugins

The core reads only stock EveJS modules (`bridge/stock.js`) and names no mod: a test
(`test/e2ePurity.test.js`) fails if `core/`, `bridge/`, `bin/` or the core scenarios name a mod's
identifiers. Anything a mod adds is a plugin in `tools/evejs-e2e/plugins/<name>/plugin.js`. The
loader (`core/plugins.js`) scans that folder only; the bridge loads it only when
`EVEJS_AGENT_BRIDGE=1`. A plugin exports `name`, `apiVersion: 1`, `applies(tree)`, `server(ctx)`
and `tool`:

- `applies({ treeRoot, serverRoot, resolve })` answers `true` or `{ ok: false, reason }`. A
  plugin that doesn't apply, has another `apiVersion`, or throws is skipped on both sides. The
  server log then has one line saying why, for example `[AgentBridge] plugin lu skipped: no Living
  Universe in this tree (no server/src/modApi.js)`, and `e2e doctor`, `e2e status` and `e2e help`
  say the same.
- `server(ctx)` gets `ctx.stock` (the stock modules), `ctx.require(path)` for a module under
  `server/src`, `ctx.seams` (`findSession`, `executeChatCommand`, `describeType`,
  `describeSystem`) and `ctx.log`. It answers any of:
  - `annotate(entity, { row, nowMs, characterID })` returns `{ groupKey, ext, hidden, pos }` for
    one grid row. `ext` lands on the row as `ext.<name>` and rides on every event about the
    ball. `groupKey` groups balls that arrive and leave together. `hidden` is for the plugin's
    own `onGrid` hook and never reaches an event. `pos` is the few fields a tactical frame keeps
    for the plugin's colours.
  - `onGrid.watch({ characterID, startedAtMs })` returns one stepper per watch. Its
    `step(entries, ctx)` runs on every sample in space, before the differ builds its events. It
    may replace an entry's `ext` and returns events of its own.
  - `offGrid.watch({ characterID, startedAtMs })` returns one scanner per watch. Its
    `scan(systemID, context)` returns `{ events, stats }`.
  - `routes` maps `"METHOD /path"` to a handler. A path ending in `/*` matches everything under
    it. A plugin can't replace a core route.
  - `stop()`.
- `tool` is plain data and functions for the CLI, the scenarios and the MCP server, every key
  optional: event `kinds` with their field schemas, what `self` means for them, `extFields` (the
  plugin's data on core events), line `format`ters, `tag(ext)` and `owner(ext)` for core lines,
  `ids` for the log filter, scenario `steps`, CLI `commands`, `handles` (a core command the
  plugin takes over for some flags), `mcpTools`, a `primer`, `colours`, `upFlags`, `listeners`,
  `logTags`, saved-`world` hooks and `targetFields`. `core/plugins.js` lists each key's shape.

Every watch times each server hook and reports it in END, as `costs.hooks["<plugin>.annotate"]`,
`costs.hooks["<plugin>.onGrid"]` and `costs.hooks["<plugin>.offGrid"]` (`runs`, `msAvg`,
`msMax`). A plugin can't add whole-world cost without it showing there.

The repo ships one plugin, `plugins/lu`, for the X-Eve Living Universe fork. Its guide is that
tree's `docs/E2E-GRID-TESTING.md`.

## Worlds

A world is the tree's game store (`gamestore.sqlite` and `manifest.json` beside the data dir), and
the market daemon's database in trees that have one. The reference data in the data dir belongs to
the tree and is never copied or rewritten by the tool.

Three kinds of world can start a run:

- **`fresh`**: `up --fresh` deletes `gamestore.sqlite` and keeps `manifest.json`. The boot seeds a
  new store from the reference data's seed tables, which is what a first boot does. A fresh world
  has only the seed accounts, so `login` creates `e2eagent` again.
- **A recipe**: `e2e world build <recipe>` builds a world from nothing and saves it, and a
  scenario that names the recipe gets it built when it's missing or stale. `starter` gives the
  character every skill and a fitted Tristan docked in Amamake. [WORLDS.md](WORLDS.md) has the
  format.
- **A saved world**: a snapshot taken with `e2e world save`.

```bash
node tools/evejs-e2e/bin/e2e.js world save my-world --note "what's in it"
node tools/evejs-e2e/bin/e2e.js world list
node tools/evejs-e2e/bin/e2e.js up --world my-world      # restore it, then boot
node tools/evejs-e2e/bin/e2e.js world copy --from ../other-tree
```

- `world save` needs a stopped world. It snapshots the databases and `manifest.json` into
  `_local/e2e/worlds/<name>/` with a `world.json` note. Plugins keep their own data there under
  `ext.<plugin>`. `--force` replaces a saved world.
- `up --world <name>` replaces the tree's world with the saved copy before boot, then lets each
  plugin mark the copy. Every run from it starts in the same place; nothing from the last run
  survives.
- `world copy --from <tree>` copies another tree's world. Both databases are opened read-only and
  copied with `VACUUM INTO`, which is consistent even while the source server runs. The copy's
  `_persistence_owners` rows are cleared, or this tree's server would find the source's live lease
  and refuse to own the world. An existing world here is kept unless you pass `--force`.
- Saved worlds belong to one tree. To use one elsewhere, `world copy --from` that tree after
  restoring it there.

`up`, `down`, `world copy`, `world save` and `world build` need auto or managed mode, and the
world commands need the server down.

## Starting and stopping

In auto mode, the default, the tool uses the tree's server when it's up and starts its own when it
isn't. In attach mode you start the server with `EVEJS_AGENT_BRIDGE=1` set, and the tool works on
it. In managed mode the CLI starts and stops it. [TREES.md](TREES.md) has all three, and
`e2e status` prints the mode and, in auto mode, which case applies now.

`e2e up` starts any daemons the config turns on, then the server's own start command, in the
background, with `EVEJS_AGENT_BRIDGE=1` and every listener it can move on the tree's port block. It
waits until the bridge answers `/health`, the gateway reports ready and the game port accepts a
connection, which happens in the last boot stage. It prints the ports and the boot time and
records them in `_local/e2e/run.json`.

- **Refusals.** `up` exits non-zero, before touching the world, when:
  - another process holds the tree's world lease, such as a server started by hand. The message
    names each role and pid;
  - any port in the block is taken. It names the port;
  - the world or manifest is missing.
  A lease left by a process that has exited only delays boot: the server waits it out (30 s).
- **Boot failure.** If the server dies during boot, `up` stops the daemons it started and prints
  the last 40 console lines, plus any live lease another process holds. After `--timeout`
  (600 s) it leaves the server running and says so.
- `e2e down` asks the bridge to stop. The bridge emits `SIGTERM` inside the server, which runs the
  shutdown hooks, flushes the store and releases the world lease. Windows has no other graceful
  stop for a detached process. `down` waits for the pid to exit, then stops the daemons.
  `down --force` kills a server that has no bridge yet, leaving its lease live for 30 s.
- `e2e status` shows the ports, server pid and boot time, gateway, bridge, daemons and the held
  character.

### Ports

Each tree has a block of 20 ports from 30000 to 45999, chosen from a hash of the tree's path, so
two trees can run at once and neither takes the stock ports (26000 and up) a hand-started server
uses. `e2e ports` prints the block:

| Offset | Listener | Set by |
| --- | --- | --- |
| +0 | Game (MachoNet) | `EVEJS_SERVER_PORT` |
| +1 | Image server | `EVEJS_IMAGE_SERVER_URL` |
| +2 | Web gateway | `EVEJS_MICROSERVICES_PORT` and `EVEJS_MICROSERVICES_PUBLIC_URL` |
| +3 | Gateway TLS responder | always gateway + 1 |
| +4 | Loopback CDN (stock: 443) | `EVEJS_PROXY_LOOPBACK_CDN_LISTEN_PORT` |
| +5 | Redshift monitor | `EVEJS_REDSHIFT_MONITOR_PORT` |
| +7 | Agent bridge | `EVEJS_AGENT_BRIDGE_PORT` |
| +8, +9 | Market daemon HTTP and RPC | generated TOML; the server gets `EVEJS_MARKET_DAEMON_PORT` |
| +10 | XMPP chat (stock: 5222) | `EVEJS_XMPP_SERVER_PORT`, with the `xmpp-port` patch |

A plugin declares its own listeners at free offsets (`tool.listeners`; the lu plugin takes +6);
`e2e up` sets each one's variable and checks its port with the rest. A listener moves only when
the tree's source reads its variable, which `e2e init` probes. Stock EveJS fixes chat at 5222, so
two stock trees clash there until the `xmpp-port` patch is applied. An EVE client can't use an
e2e server, since it only connects to chat on 5222.

If two trees hash to the same block, or something else holds a port, `up` names the port. Run
`up` with `EVEJS_E2E_PORT_SLOT=<0-799>` to pick another block. Later commands read the running
server's ports from `run.json`, so they don't need the variable.

## Reading the grid

```
Amamake (0.4)  t+00:07:10  self: Tristan (in space, STOP)
dist        name                    type                who     mode     target            S/A/H
0           (self) Tristan          Tristan             -       STOP     -                 100/100/100
4,251 m     Blood Raider            Cruor               npc     ORBIT    self              100/100/100
12 km       Stargate (Siseide)      Stargate (Minmatar~ -       -        -                 -
+103 beyond 100 km; nearest Stargate (Auga) at 21,920 km (--all to list)
```

- `dist` is surface distance from your ship. Rows are nearest first.
- `who` is the NPC kind (`npc`, `concord`, `drifter`), `player`, or `-`.
- `mode` and `target` come from the server's own ball state. `target` names the ball the
  entity is acting on; `self` means you.
- `S/A/H` is shield, armour and hull in percent.
- `protected Ns` is the ship's undock or timed invulnerability, measured in scene time.
- `--range <km>` changes the cut-off (default 10,000 km), `--all` lists everything the session
  can see, `--json` prints the bridge's full reply.

Each `grid` also makes one gateway call on the held session. That refreshes the gateway's
30-minute idle timer and drains the session's notification backlog. A session that only reads the
grid stays alive.

## Watching a grid over time

`e2e watch` prints what changed on the grid and why, as one timeline, until `--for` runs out
(default 600 s). It makes one HTTP call: the bridge samples the grid on the server every `--every`
seconds (default 2) and streams each change as a line of NDJSON. The watch follows you across
`/tr` and jumps: a `SYSTEM` line, then a fresh baseline.

```
t+00:00:05  ARRIVE    Blood Raider  at 4,251 m from self
t+00:00:06  MODE      Blood Raider  STOP -> ORBIT on self  3,900 m
t+00:00:06  DECISION  Blood Raider  decided - -> engage on self
t+00:00:10  TARGET    Blood Raider -> self (locked)
t+00:00:10  DAMAGE    self shield 100 -> 88
t+00:00:12  DESTROYED Blood Raider wreck #980350000000
t+00:00:13  KILLMAIL  Blood Raider killmail 1
```

From the ships, drones, wrecks, containers and structures the session can see:

| Kind | When |
| --- | --- |
| `GRID`, `PRESENT` | The first sample in a system: where you are, and what is already there. |
| `ARRIVE`, `LEAVE` | A ball appears or goes. Members of one group (`groupKey`) are one line. A ship first seen in warp is printed when it drops out, so the distance is where it landed (after 30 s it is printed anyway, marked still in warp). |
| `MODE` | Ball mode changes, e.g. `ORBIT -> WARP`, with the ball it acts on. |
| `DECISION` | An NPC controller's last think took another branch. Needs the `last-decision` patch, or a tree that records it. |
| `TARGET` | A lock gained or lost, from the entity's own `lockedTargets`. |
| `DAMAGE` | Shield, armour or hull drops across a quarter band (100, 75, 50, 25), or returns to full after a repair or `/heal`. Regeneration climbing through the bands is not printed. |
| `DESTROYED`, `KILLMAIL` | A ship replaced by a wreck within 20 km. The killmail ID follows when the killmail worker writes it, within 20 s. |
| `SELF`, `DOCKED`, `SYSTEM`, `MOVED` | Your own ship, dock state or system changed, or you jumped more than 1,000 km inside a system (warp, `/tr me <celestial>`). The last two start a new baseline. |
| `LOG` | A server log line tagged `NpcController`, or with a tag a plugin lists, that names a ball the watch has seen. `--grep <regex>` keeps every line matching it instead; `--no-log` drops them. |
| `PERF`, `PROFILE` | With `--perf`: the server's ticks every 5 s, and each tick profiler window. See [Performance testing](#performance-testing). |

Plugins add kinds of their own, often from an off-grid scan of the system you are in. In
`timeline.jsonl` each core event about a ball carries its `groupKey` and the plugins' data at
`ext.<plugin>`, and each NPC line ends with each plugin's tag.

Stock's logger writes no `[pid N]` tag, so in a stock tree `LOG` lines can't be told from another
process's that writes the same file.

The timeline is also written to `_local/e2e/runs/<id>/timeline.jsonl`, one event per line with
`seq`, `t` (ms since the watch started), `atMs` (server time) and `kind`. The run ID is the start
time, or `--run <id>`. `--json` prints those lines instead of text. Lines are held for 1.5 s and
released in server-time order, so log lines interleave with samples.

**Cost.** Nothing runs unless a watch does, at most four at once. Each sample is the `/grid` read
plus the plugins' hooks, which END times. The `END` line reports the sample and scan times it
measured, average and maximum.

## What the client was sent

Everything above is server state. A bug can also live in what the client receives: a ball the
server never sends, a movement command for a ball the client doesn't have, a warp-in that lands
somewhere other than where the client was told. The gateway drops `DoDestinyUpdate` for browser
sessions, so the bridge keeps its own copy.

**The tee.** The bridge wraps `sendNotification` and `sendSessionChange` on web gateway sessions,
which have a clientID of 2,000,000,000 or more and a socket that can't write. It never wraps a
retail client's session. The tee decodes each `DoDestinyUpdate` before the gateway drops it and
keeps the ball set a client would hold. It reads AddBalls2 and SetState ball state,
PackagedAction, the movement commands `GotoPoint`, `Orbit`, `FollowBall`, `WarpTo` and `Stop`,
`SetBallPosition`, damage state, `OnSpecialFX`, removals and destruction effects. A session change
that docks, undocks or changes system empties the set, as it empties a client's ballpark. The
wrapper returns the original's result, so delivery accounting doesn't change. No stock file
changes; the code is `bridge/destiny.js`.

At boot the bridge has the tree's own encoder write a set of test balls and reads them back. If
the layout differs from what the decoder knows, the client view stays off and says so in the log,
on `/tee` and in every watch's `START` line, rather than reporting DIVERGEs that aren't there.

`e2e login` attaches the tee through `POST /tee`, so the client view starts from the undock's
SetState. A watch also attaches it, but the view then stays empty until the next undock, jump or
`/tr`, and the `CLIENT` line says so. A real client binds the remote park straight after undock
or a jump, and that bind makes the server send SetState. `e2e undock`, `e2e teleport` and any
`e2e slash` that changes system make the same call, `beyonce.MachoBindObject` through
`/bound/bind`.

`e2e watch` prints these lines beside the server ones. Each carries `source: "client"` in
`timeline.jsonl`.

| Kind | When |
| --- | --- |
| `CLIENT` | What the client was sent: `SetState`, `AddBalls` with the mode each ball arrives in, `RemoveBalls`, a movement command that changes a ball's mode or target, a shield, armour or hull band crossed in the client's damage state, a destruction effect, and `ballpark cleared` on a session change. A payload the decoder can't read prints as `decode-error`. |
| `FX` | An effect the client would start: weapons, repairers, warp and cloak effects, with the target. The same ship, effect and target prints once per 30 s. `ball not in client view` means the effect names a ball the client doesn't hold, so it would not render. |
| `DIVERGE` | The client's view and the server's grid disagree, below. |

`DIVERGE` reasons:

| Reason | Means |
| --- | --- |
| `server-only` | The server grid has a ship, drone, fighter, wreck, container or structure the client was never sent. |
| `client-only` | The client still holds a free ball, anything that moves, that the server no longer shows. |
| `mode` | A ship, drone or fighter is in one mode on the client and another on the server, e.g. client `ORBIT`, server `STOP`. |
| `position` | AddBalls, SetState or `SetBallPosition` gave the client a position. At the next sample, the server's ball is more than `--diverge-meters` from that position carried on in a straight line. The default is 5,000 m. Missiles are left out, and so is any velocity above 15 km/s, which can only be left over from warp. |
| `warp-landing` | A ball the client saw warp landed more than `--diverge-meters` beyond the minimum range from the client's warp destination. |
| `unknown-ball` | A movement command or `SetBallPosition` named a ball the client doesn't hold. |
| `no-ballpark` | You are in space, but the client has had no SetState since its ballpark was cleared. |

Delivery runs a destiny tick or two behind the server; in a 20-ship fight the client got its
`Orbit` and `FollowBall` commands 2 s after the server changed mode. So `server-only`,
`client-only`, `mode` and `no-ballpark` open only after two samples and 3 s, and print
`cleared after Ns` when they end. The others print once. After `SYSTEM`, `MOVED` or `DOCKED` every
check starts again.

`--client diverge` prints only `DIVERGE` and decode errors. `--client fx` adds the `FX` lines
(weapons firing and other effects) without the `CLIENT` ones. `--client off` leaves the client out.

**What it does not model.** The client view moves a ball only when the server tells it to. It
runs no destiny physics, so the checker tests each position once, at the next sample, and never
in between. It doesn't model shield regeneration between damage updates either.

**Cost.** The tee runs on at most eight gateway sessions, the ones the bridge was asked about. It
keeps running between watches, so the view is current when one starts. It holds one record per
ball the client has and a ring of the last 2,048 decoded events. A watch that falls behind
prints how many events it missed, and the `END` line reports decode time. On 2026-10-01 a Dominix
fought 20 `/npc` hostiles for 150 s; the tee decoded 740 destiny notifications at 0.011 ms each on
average and 0.69 ms at most, under 0.1% of the tick.

## Player actions

`e2e act` makes the character act, through the calls the web gateway already allows a browser
client. The server applies every rule, so a refusal comes back in its own words: out of range, no
charges, not enough capacitor.

```bash
node tools/evejs-e2e/bin/e2e.js act lock nearest npc                 # waits until the server lists the lock
node tools/evejs-e2e/bin/e2e.js act activate weapons                 # at the first locked target; --target, --once
node tools/evejs-e2e/bin/e2e.js act orbit "name~Blood" --range 2km
node tools/evejs-e2e/bin/e2e.js act loadAmmo --charge "Antimatter Charge S"   # from the cargo hold
node tools/evejs-e2e/bin/e2e.js act launchDrones --count 5
node tools/evejs-e2e/bin/e2e.js act engageDrones nearest npc
node tools/evejs-e2e/bin/e2e.js act warpTo kind=planet --range 20km
node tools/evejs-e2e/bin/e2e.js act stop
```

| Action | Gateway call | Arguments |
| --- | --- | --- |
| `approach <target>` | `beyonce.CmdFollowBall(id, 0)` | |
| `orbit <target>` | `beyonce.CmdOrbit(id, range)` | `--range`, default 5,000 m |
| `keepAtRange <target>` | `beyonce.CmdFollowBall(id, range)` | `--range`, default 10,000 m |
| `warpTo <target>` | `beyonce.CmdWarpToStuff("item", id, minRange=)` | `--range`, default 0 |
| `stop` | `beyonce.CmdStop()` | |
| `lock <target>` | `dogmaIM.AddTarget(id)`, then `GetTargets` until it is listed | `--timeout`, default 30 s |
| `unlock <target>` | `dogmaIM.RemoveTarget(id)` | |
| `activate [<modules>]` | `dogmaIM.Activate(module, "", target, -1)` for each | `--target` (default the first locked target), `--once` |
| `deactivate [<modules>]` | `dogmaIM.Deactivate(module, effect)` | An already-off module counts as done. |
| `loadAmmo [<modules>] --charge <charge>` | `dogmaIM.LoadAmmo(ship, [module], [charge], ship)` for each | The charge is a cargo item by name, `name~` or `group~`. |
| `launchDrones [<drones>]` | `ship.LaunchDrones([[stack, qty]])` | `--count`. The call answers success even when it refuses, so the action counts this ship's new drones on grid. |
| `engageDrones <target>` | `entity.CmdEngage(drones, id)` | This ship's drones in space. |

- **Targets.** A target is the nearest ball on grid, never your own ship, that passes every
  term: `npc`, `player`, `name~<regex>`, `type~<regex>`, `kind=station`, `within=30km`, or an
  item ID, plus any terms the plugins add. `nearest` reads well but changes nothing. In a
  scenario, `$name` matches a ball an earlier step bound, or its group.
- **Modules.** `weapons` (the default: high-slot turrets and launchers), `high`, `mid`, `low`,
  `all`, `name~<regex>`, `group~<regex>` or an item ID. Several terms must all hold:
  `"mid name~afterburner"`. Module names come from the static item table, read once a command.
- **What the run sees.** Your lock is `TARGET sourceLabel=self`. Your guns firing are `FX self`
  lines, which need `--client fx` (or `all`) on the watch. Hits are `DAMAGE` bands on the
  target.

## Scenarios

`e2e run <scenario>` runs a whole check in one command. In managed mode it boots the scenario's
world, runs setup, watches until a stop condition, shuts the server down and writes a report of
expected against observed. In attach mode it uses the live server as it is. In auto mode it does
the first when no server is up and the second when one is. Scenarios are JSON
files in the tree's `tools/e2e-scenarios/`, in `tools/evejs-e2e/scenarios/` and in each active
plugin's `plugins/<name>/scenarios/`; `e2e run` lists them all, and `e2e run --json` lists each
with its world, timeout, expectations and any problem loading it. Pass a name or a path.

```bash
node tools/evejs-e2e/bin/e2e.js run                               # list the scenarios
node tools/evejs-e2e/bin/e2e.js run loadout-npc-fight --check     # load and check it; boots nothing
node tools/evejs-e2e/bin/e2e.js run loadout-npc-fight             # [--run <id>] [--world <name>|fresh] [--keep-up | --reuse]
node tools/evejs-e2e/bin/e2e.js run loadout-npc-fight --reuse     # again: resets the server it left up instead of booting
```

```json
{
  "description": "Two frigates attack the ship; it fights back and kills one.",
  "recipe": "starter",
  "setup": ["undock", { "waitFor": "GRID", "timeout": 30 },
    { "slash": "/npc 2 parity_blood_raider_pulse_frigate" },
    { "launchDrones": "all" },
    { "lock": "nearest npc", "as": "mark" },
    { "engageDrones": "$mark" },
    { "activate": "weapons", "target": "$mark" }],
  "watch": { "client": "fx" },
  "until": { "any": ["DESTROYED itemID=$mark", "DESTROYED self"], "timeout": 120, "grace": 10 },
  "expect": ["ARRIVE who=npc", { "match": "DAMAGE itemID=$mark", "note": "the rat takes damage" },
    "DESTROYED itemID=$mark", "no DESTROYED self"]
}
```

| Key | What it holds |
| --- | --- |
| `world` or `recipe` | A saved world (`e2e world list`), `"fresh"`, or `"recipe": "<name>"` for a world the tool builds ([WORLDS.md](WORLDS.md)). One is required. |
| `up` | `market` (default `true`), `timeout` (boot, seconds), `profile` (boot with the tick profiler; turns `watch.perf` on), `profileEvery` (ticks per profiler window, default 50), and the plugins' `up` flags. |
| `setup` | Steps, in order. A login runs first if the list doesn't start with one. |
| `during` | Steps that run after setup, beside the stop conditions; see [During](#during). Optional. |
| `watch` | `every` (2 s), `offgridEvery` (5 s), `client` (`diverge` by default; `FX` lines need `"fx"` or `"all"`, `CLIENT` lines `"all"`), `divergeMeters`, `log` (`true`), `grep`, `perf` (`true` for a `PERF` window every 5 s, or seconds). |
| `until` | `any`: stop conditions; the first one met stops the run. `timeout`: seconds after setup, required. `grace`: at most this many seconds more after a stop condition, e.g. for the `KILLMAIL` after a `DESTROYED`. Grace ends early once every expectation that isn't a `no` is met, but not before `graceMin` (default 5 s, or all of a shorter grace), which gives a `no DIVERGE` time to open: the watch delivers lines 1.5 s late and a divergence settles over 3 s. Set `graceMin` to `grace` when a `no` expectation needs the whole window. The report says how long grace ran and why it ended. `from`: `"setup"` (default) matches only events after setup ends; `"start"` matches every event since the watch began, for a stop condition that setup itself causes, such as the `GRID` after an undock. |
| `expect` | Expected observations, as conditions. `"no <condition>"` or `{ "match": ..., "absent": true }` expects none. `{ "match": ..., "note": ... }` adds a note to the report. |
| `name`, `description` | Default name: the file name. |

Steps:

| Step | Does |
| --- | --- |
| `"login"` or `{ "login": { "user": ..., "name": ... } }` | `e2e login`. First, or left out. |
| `"undock"`, `"dock"` | `e2e undock`, `e2e dock`. |
| `{ "slash": "/heal" }` | `e2e slash`. A refused command fails setup; in a tree that doesn't report refusals (stock without `slash-success`) every command counts as done. |
| `{ "teleport": "Amamake" }` | `e2e teleport`, stock `/tr`. |
| `{ "loadout": { "ship": "Tristan", "modules": [...], "drones": [...], "cargo": [...], "charges": [...] } }` | `e2e loadout` ([WORLDS.md](WORLDS.md)). |
| `{ "wait": 30 }` | Waits that many seconds. Prefer `waitFor` on the event you are waiting for: a `GRID` with the new `systemName` after a teleport, or the first `GRID` after an undock. |
| `{ "waitFor": "<condition>", "timeout": 300 }` | Waits for an event, seen after the step starts, that matches the condition. Setup fails if none comes before the timeout (default 300 s). |
| `{ "lock": "nearest npc", "as": "mark" }`, `{ "activate": "weapons", "target": "$mark" }`, `"stop"`, ... | A [player action](#player-actions): `approach`, `orbit`, `keepAtRange`, `warpTo`, `stop`, `lock`, `unlock`, `activate`, `deactivate`, `loadAmmo`, `launchDrones`, `engageDrones`. The value is the target, or the modules or drones; the other arguments are keys (`range`, `target`, `once`, `charge`, `count`, `timeout`). `as` binds the target's item ID, or the drones launched. A refused action fails the step. |

Player actions, and plugin steps that allow it, take `"retry": { "every": 15, "for": 480 }`, which
tries a refused step again every `every` seconds until it is accepted or `for` runs out. Use it
where the feature refuses for now, rather than a fixed `wait`. Plugins add steps of their own.

### During

`during` is a second list of steps. It starts when setup ends and runs beside the stop
conditions, so a step there can cause what a stop condition or expectation waits for: lock and
fire on an NPC, then see whether it shoots back. It takes every step but `login`. When the run
stops (a stop condition, the timeout or a failure) the step under way is cut short, and the
rest don't run. A cut-short step shows as `stopped` in the report and writes no `STEP` line. A
step that fails ends the run as not completed (exit 2), because the test didn't do what it says.
`during` waits run inside `until.timeout`, so they add nothing to the run's 3,000 s budget.

```json
"during": [
  { "wait": 5, "note": "the rats close in" },
  { "lock": "nearest npc", "as": "mark", "retry": { "every": 5, "for": 60 } },
  { "activate": "weapons", "target": "$mark" },
  { "orbit": "$mark", "range": 2000 }
]
```

The report gets a "During" table after "Setup", with each step's time, and the timeline marks
those `STEP` lines `during:`.

### Conditions

A condition names an event kind, then field tests, with the names `e2e watch --json` writes:

```
ARRIVE who=npc count>=2
DESTROYED self
TARGET self locked sourceLabel~frigate
DAMAGE itemID=$mark layer=armor
FX label~Hobgoblin targetID=$mark offensive=true
SYSTEM toSystemName=Jita t<=5min
```

- **Fields.** A field is looked up on the event, then one level down, then in each plugin's data
  under `ext.<plugin>`. So `typeName` on an `ARRIVE` is `members.typeName`. A dotted name picks
  the path. `groupKey` names the group a plugin put the ball in, and `!groupKey` a ball in none. A
  list matches when any element does. Every event has `t`, the time since the watch started.
- **Tests.** `=` and `!=` compare text without case and IDs exactly. `~` is a case-insensitive
  regex. `>`, `>=`, `<` and `<=` compare numbers. A bare field is true when set, and `!field`
  when not. Values with spaces go in double quotes: `label="Blood Raider"`.
- **Units.** Distances take `m` or `km`, times take `ms`, `s`, `min` or `h`. A bare number is
  metres or milliseconds.
- **`self`** means the event is about your ship: `DESTROYED` with `self`, a `TARGET` lock on
  you, and otherwise an event whose `label` is `self`. A plugin says what it means for its own
  kinds.
- **`$name`** is what a step bound with `as`. It matches none of the IDs until that step
  has run.
- **Kinds** are the core's and the active plugins'. In a tree without a plugin's mod, the plugin's
  kinds and fields are unknown, so a scenario that names them fails its check.

Each condition is checked when the scenario loads, before anything boots. The check refuses an
unknown kind or field and lists the fields the kind has. It also refuses an operator the field's
type can't take, a `$name` no earlier step binds, a `CLIENT` condition without
`"client": "all"`, an `FX` one without `"fx"` or `"all"`, and waits that don't fit in one bridge
watch (3,000 s). It also checks each action's target, modules and arguments. `--check` prints the
checked scenario.

### What a run does

1. In managed mode, refuses if the tree's server is already running, so a run always starts from
   its world. In auto mode, a server that's up means the run uses it and skips the boot. When the
   run boots, a recipe world is built first when it's missing or stale.
2. Runs `up --world <world>` when it boots, then the login.
3. Starts one watch, so the timeline covers the whole of setup.
4. Runs the other setup steps, and records each one as a `STEP` line in the timeline.
5. Starts the `during` steps, if any, and waits for a stop condition. By default only events
   after setup ends count, judged by each event's own time, so a line the watch delivers late
   still belongs to setup. With `"from": "start"`, setup's events count too, and a condition setup
   already met stops the run at once. The timeout counts from the end of setup. `expect` always
   matches the whole timeline.
6. Watches for up to `until.grace` more, and less once every expectation is met.
7. Writes a `STOP` line, stops the watch and runs `down` when it booted. `down` runs whatever
   happened before it: a failed boot, a refused step or Ctrl-C. `--keep-up` leaves the server
   running.

### Reusing the server

A boot takes about 16 s on stock EveJS and about 50 s on LU's `lowsec-docked`, before the
scenario starts. While you iterate on a scenario that names a recipe, `--reuse` skips it (managed
or auto mode):

- The first `--reuse` run boots as usual and leaves the server up.
- The next one resets that server instead of booting, in about 2 s. In each system earlier runs
  saw, it teleports there and runs `/npcclear system all`, `/gaterats off` and `/sysjunkclear`.
  Then it runs `/cwatch clear` and `/dock`, and the recipe's steps again, which board a new
  fitted ship where the recipe leaves it. Its report's world reads `<recipe>, reused server pid
  <n> reset in place`.
- A reset doesn't undo everything a run changed. Drones left in space stay, and so do some
  wrecks: stock `/sysjunkclear` misses some. They show as `PRESENT` on the first grid. Killmails,
  the wallet, standings, skills and whatever a plugin keeps stay too. So run the final version
  without `--reuse`, from a fresh boot.
- A server is reused only when a `--reuse` run left it up, on the scenario's recipe world, with
  the same `up` options and a world that is current with its recipe. Otherwise the run stops it
  and boots. A server you started yourself is never reset. `e2e down` stops a reused server.

Boot time itself is the server's own work. On stock, about 5 s of it validates the content
packs' hashes and 2.5 s builds the dungeon cache. Node's compile cache (`NODE_COMPILE_CACHE`)
didn't shorten it.

`_local/e2e/runs/<id>/` then holds:

- `report.md`: the verdict, a table of expected against observed, the stop conditions and which
  one fired, the tactical frames, the setup and `during` steps with their replies, and every
  timeline line. Each observed cell is the first matching line and its time.
- `timeline.jsonl`: every event, as `e2e watch` writes it, plus the runner's `STEP` and `STOP`,
  and the `POS` samples the frames are drawn from.
- `frames/*.svg`: the tactical frames, below.
- `result.json`: the same verdict for scripts, with the frames and the commit the run ran on.
- `scenario.json`: the file as it ran.

| Exit | Means |
| --- | --- |
| 0 | Every expectation met. A run that stopped at its timeout can still pass. |
| 1 | An expectation missing, or a `no ...` expectation seen. |
| 2 | The run didn't finish: boot, setup, the watch or `down` failed, or it was interrupted. Expectations are still judged on what was seen. |

### Tactical frames

`e2e run` also draws `frames/*.svg` in the run dir: a top-down view of the grid at each key event.

- **When.** The first `ARRIVE` of each group, the first `TARGET` lock on self, each
  `DESTROYED`, and the stop condition. Balls in no group (a `/npc` spawn, CONCORD) landing in one
  sample share a frame. When the stop condition is one of those events, that frame also marks the
  stop. A run keeps at most 40 frames. Destructions, the lock and the stop always stay, so
  arrivals are dropped first, and the report counts them.
- **What.** Self sits in the centre. x runs right and z up; height is dropped. The frame is sized
  to what the event is about, plus ships within 50 km or twice that distance. A scale bar sits
  bottom left, with range rings one bar apart. Anything beyond the frame is an arrow on the edge.
  Ships there are labelled with their distance; stargates, stations and other landmarks are listed
  under the legend with distance and bearing (N is +z). The ringed balls are what the frame is
  about. A solid line is a lock (red when it is on you), and a dashed line is an orbit or follow.
  The legend numbers every ship, drone, wreck and container, with its distance, mode and type. The
  header carries the event's timeline line, and the footer says which sample the positions came
  from.
- **Where the positions come from.** A run asks the watch for `POS` events (`positions: true` on
  `POST /watch`). The bridge writes one after any sample with an on-grid event, and at least every
  10 s in space. Each lists up to 150 balls within 1,000 km, with position, mode, target, locks,
  group and the plugins' frame fields. Colours are the core's (self, CONCORD, players) and the
  plugins', then one per group. They go to `timeline.jsonl` only: they are not printed, matched or
  listed in the report. A plain `e2e watch` writes none unless it has `--positions`.
- **In the report.** A "Tactical frames" table links each frame with its time, reason and event
  line, and the stop frame is embedded below it. The GUI's Runs tab shows them too.

### Core scenarios

They start from `fresh` or the `starter` recipe, so they run in any tree.

| Scenario | Checks | Setup | Stops at |
| --- | --- | --- | --- |
| `smoke-undock` | The tool itself: login, undock, a grid | `undock` | the undock's `GRID` |
| `selftest-unmet` | That a missing expectation fails a run | `undock` | the undock's `GRID`; its `SYSTEM toSystemName=Jita` is MISSING by design (exit 1) |
| `gate-rats` | Stock gate rats (`/gaterats`) | `teleport Siseide` (lands on a gate), `/gaterats on` | `DESTROYED self` |
| `concord-highsec` | CONCORD in high sec | `teleport Rens`, `/naughty` | `DESTROYED self` |
| `loadout-npc-fight` | A fitted ship's drones and guns | `/npc 2` Blood Raider frigates; launch and engage drones, lock, orbit, fire | the locked rat destroyed, then 10 s |
| `perf-npc-load` | How the tick copes with a fight, with the profiler on | `undock`, 15 s of baseline, `/npctest2 20` | 60 s of the fight |

On the unpacked stock zip with the three patches applied, `starter` built in 18 s and
`loadout-npc-fight` passed 8 of 8 in 55 s, boot and shutdown included.

### Writing a scenario for a feature

A scenario is the final check for a feature you built: it starts the feature the way the game
would, and states what a person watching the grid should see.

1. **Start from a world** where the feature can happen: `starter`, a recipe of your own, or a
   saved world.
2. **Set the feature off in setup**, with a slash command, a teleport, `/npc`, a player action or
   a plugin's step. If nothing reaches your feature on demand, add a slash command or a plugin
   step that calls its entry point. Don't copy the feature's rules into the test. Bind the IDs a
   step returns with `"as"`, so conditions name what you started, not something that happened to
   pass. Where an action can be refused for a while, use `"retry"` rather than a fixed `wait`.
3. **Stop on the outcome.** `until.any` is the event that ends the story, such as the arrival, the
   kill or the departure, plus a safety stop like `DESTROYED self`. Set `timeout` to the longest
   wait you would accept. Add `grace` to catch what follows, such as a `KILLMAIL` after the
   `DESTROYED`. If your stop condition is something setup itself causes, such as an undock's
   `GRID`, set `"from": "start"`.
4. **Write each expectation as one thing a reviewer would check**, with a `note` saying why it
   matters. Include the steps on the way, not only the outcome, so a failed run shows where the
   behaviour stopped. Add `"no DIVERGE reason=server-only"` when what the client receives matters.
5. **Find field names** with `e2e_watch { json: true }` or `e2e_grid { json: true }`, or name a
   field and let the check list the kind's fields.
6. **Check, then run.** `--check` (or `check: true`) costs nothing. Once the run has finished, read
   the observed column: a met expectation whose first match is the wrong event means the condition
   is too loose. Tighten it with `$name`.
7. **Judge the feature from the report.** A missing expectation can be a bug in the feature or a
   wrong scenario, and the timeline shows which.
8. **Commit the scenario with the feature** in the tree's `tools/e2e-scenarios/` (`save: true`
   from MCP), so a reviewer can run it again. Don't save into `tools/evejs-e2e/`: that folder is
   vendored, and `vendor check` fails on an edited copy.

### Citing a run in a PR

`report.md` is the evidence. A PR description should carry its verdict, its "Expected against
observed" table and its frames, and name the run ID, the scenario file and the commit the run
ran on. `e2e run` records the commit (`git rev-parse HEAD`) in `result.json` and in the report's
table, marked "plus uncommitted changes" when the tree had any, untracked files included. Evidence
from a dirty tree is weaker, so commit first and run again before citing.

`e2e_report { run, section: "pr" }` writes that markdown: the verdict, the table, the frames to
attach and the command that reproduces the run. The run dir is under `_local/`, which isn't
committed, so don't link into it; attach the SVGs, or PNGs rendered from them with headless
Chrome: `chrome --headless=new --screenshot=frame.png --window-size=1100,760 file:///<path>.svg`.
When the scenario isn't in a folder a reviewer has, the citation warns that it can't be rerun. A
failed run is cited the same way: its MISSING rows and timeline are the finding.

## Performance testing

How the server copes with a load. Take a baseline, add the load, and compare the server's ticks
before and after. The space runtime ticks every 100 ms, so a tick has 100 ms of budget.

```bash
node tools/evejs-e2e/bin/e2e.js up --world starter --profile   # boot with the tick profiler
node tools/evejs-e2e/bin/e2e.js login
node tools/evejs-e2e/bin/e2e.js undock
node tools/evejs-e2e/bin/e2e.js perf --for 10                  # the baseline
node tools/evejs-e2e/bin/e2e.js slash "/npctest2 20"           # 20 NPCs fighting each other
node tools/evejs-e2e/bin/e2e.js perf --for 30                  # the load
node tools/evejs-e2e/bin/e2e.js run perf-npc-load              # all of that, with a report
```

`/npctest2 20` spawns 20 NPCs that fight each other and leave your ship alone. `/npc 20` spawns 20
that attack you. From Git Bash, set `MSYS_NO_PATHCONV=1`, or Git Bash turns `/npctest2` into a
Windows path before the CLI sees it.

```
over 30 s: 273 ticks, budget 100 ms a tick
  tick       avg 16.3  p50 14.7  p95 31.5  p99 37.1  max 39.3 ms; 0 over budget
  late       avg 9.67  max 12.7 ms after the tick was due
  event loop p50 11.3  p99 28.4  max 48.7 ms delay
  process    cpu 21% of a core, heap 2062 MB, rss 2348 MB
  world      1 scene(s) ticking, 21 entities

  busiest scenes  avg ms  max ms  entities  sessions
  Amamake           16.9    36.8        21         1

tick profiler: 5 window(s), 250 ticks, 15.6 ms/tick in all
  section                  ms/tick  share  calls
  mv.visibility               7.07  45.4%    250
  mv.entityLoop               3.21  20.7%    250
  npc                         2.80  18.0%    250
  ...
```

### Where the figures come from

- **Ticks need no flag.** The space runtime keeps a ring of its last 120 tick summaries: each
  tick's duration, how late it started, and the interval since the last one. The bridge reads that
  ring (`bridge/perf.js`), so the figures cost the server nothing it doesn't already spend. Stock
  EveJS keeps the ring on a runtime object it doesn't export. The bridge finds it with a one-shot
  wrapper on the runtime's `tick()`, which the first tick removes.
- **The breakdown needs the tick profiler.** `e2e up --profile` sets `EVEJS_TICK_PROFILE=1` and
  `EVEJS_TICK_PROFILE_EVERY` (`--profile-every`, default 50 ticks, 5 s). The tree's own profiler
  (`space/tickProfiler.js`) then logs a `[TickProfile]` block each window. The bridge parses each
  one as it is logged, and the line still reaches the log. A `↳` row is inside the row above it, so
  it doesn't add to the total. `other(...)` is tick work outside any named section. A row marked
  `(after tick)` ran after the tick's measured end. Stock marks no nesting, so the bridge treats a
  row as nested when another row's label is a dot-prefix of its own (`npc.think` is inside `npc`).
- **The process.** CPU as a share of one core, heap and RSS, and event-loop delay from a
  `perf_hooks` histogram that runs only while something samples. Windows rounds timers up to its
  15.6 ms clock tick, so an idle server shows about 11 ms of loop delay there.
- **The world.** How many scenes ticked, their entities, the lowest time dilation, and the three
  busiest scenes by work per tick.

`e2e status` says whether the running server has the profiler. In auto or attach mode, a server you
started has it only if you set `EVEJS_TICK_PROFILE=1`. Without it you still get every tick figure.

### Commands

| Command | Does |
| --- | --- |
| `e2e perf [--for 10] [--json]` | Samples that many seconds (1 to 600), then prints the ticks, the process, the busiest scenes and the profiler's sections merged over the windows that ended in the sample. Needs a server up, not a character. |
| `e2e perf --now` | The ticks the runtime holds now, about the last 12 s, at once. No CPU or loop delay, which need a window to measure over. |
| `e2e up --profile [--profile-every 50]` | Boots with the tick profiler. |
| `e2e watch --perf [--perf-every 5]` | Adds a `PERF` line per window and a `PROFILE` line per profiler window to the timeline. |

The bridge routes are `GET /perf` and `POST /perf { seconds }`, and `perfEverySeconds` on
`POST /watch`. At most four samples run at once.

### In a scenario

`"up": { "profile": true }` boots with the profiler and turns `watch.perf` on. `"watch": { "perf":
true }` alone records ticks without the breakdown. Both kinds can be matched:

| Kind | Fields |
| --- | --- |
| `PERF` | `windowMs`, `ticks`, `missedTicks`, `budgetMs`, `tickAvgMs`, `tickP50Ms`, `tickP95Ms`, `tickP99Ms`, `tickMaxMs`, `overBudget` (ticks over 100 ms), `lateAvgMs`, `lateMaxMs`, `loopP50Ms`, `loopP99Ms`, `loopMaxMs`, `cpuPct`, `rssMB`, `heapMB`, `scenes`, `entities`, `tidiMin`, and `busiest` (`systemName`, `workAvgMs`, `workMaxMs`, `entities`, `sessions`). Each event also carries `series`, every tick's time and duration, for the report and the GUI. |
| `PROFILE` | `ticks`, `totalMsPerTick`, `totalLabel`, and `sections` (`label`, `msPerTick`, `pct`, `calls`, `msPerCall`, `nested`, `afterTick`). |

```json
"expect": [
  { "match": "no PERF overBudget>=5", "note": "no 5 s window has 5 of its 50 ticks over budget" },
  { "match": "no PERF tickP99Ms>=100ms" },
  "PROFILE sections.label=npc"
]
```

A condition on a list matches when any element passes each term, and each term can pass on a
different element. So `PROFILE sections.label=npc sections.msPerTick>5` doesn't mean npc took
5 ms. A `PERF` condition needs `watch.perf`, and a `PROFILE` one needs `up.profile`; the check says
so before anything boots.

The report gets a "Server performance" section. It gives the whole run's figures, then a table of
phases. Each phase starts where a setup or `during` step ended and is named for that step, so the
time before a spawn is the baseline for the time after it. Ticks go to a phase by their own time,
so a window that spans a step splits at it. Then come the profiler's sections, merged over the
whole run. `result.json` has the same figures under `perf`. The GUI's Perf tab draws them
([GUI.md](GUI.md#perf)).

`perf-npc-load` runs on stock: 15 s of one ship on grid, then 20 NPCs for 60 s. On 2026-10-02 on
the unpacked 0.12.9 zip, the baseline tick averaged 2.4 ms (p99 6.5 ms). With the fight it averaged
20.2 ms (p99 48.6 ms, max 65.6 ms). `mv.visibility` cost 8.1 ms of the 15.8 ms the profiler
named. A second run's fight went to 38.8 ms on average, with 3 ticks over budget, so judge a change
against several runs.

## Viewer

A small page that draws a run's tactical view in a browser, as a replay or live while the run
writes it. Any run with a `timeline.jsonl` works. An `e2e run`, or an `e2e watch --positions`,
also has the positions the map needs. The GUI's Runs tab opens it for any run.

```bash
node tools/evejs-e2e/bin/e2e.js view                          # the newest run
node tools/evejs-e2e/bin/e2e.js view <run>                    # a given run
node tools/evejs-e2e/bin/e2e.js view --serve [--port 35099]   # serve it from the CLI, even with a server up
```

`e2e view` prints a URL such as `http://127.0.0.1:35027/viewer#token=<token>&run=<run>`. While the
tree's server is up, its agent bridge serves the page. Otherwise the CLI serves the same page on a
free loopback port until Ctrl-C.

- **Map.** The same top-down view as the tactical frames: self in the centre, x right and z up,
  range rings and a scale bar, locks as solid lines and orbits as dashed ones. Weapons firing at a
  target (`FX` lines) are an orange line for as long as the module cycles. A ball that just took
  damage gets an orange ring, and one with a recent `DIVERGE` a purple dashed ring with its
  reason. Between two position samples the balls move in a straight line. Zoom is auto, or fixed
  from 5 km to 500 km.
- **Scrubber.** Play and pause (space bar), 1x to 60x, previous and next event (arrow keys), and
  next `DIVERGE`. Ticks above the slider mark `DIVERGE` (purple), destructions, locks on self,
  arrivals, runner steps and your own shots. While a run is still being written, "Follow live"
  keeps the view on its newest sample. The page reads the new lines once a second.
- **Lists.** The balls on grid with distance, mode and type; every `DIVERGE` line, each one a
  link to its moment; and the timeline, with the current line highlighted. Click any line to
  jump there. `CLIENT` and `FX` lines are hidden until you tick them, and a regex filters the
  rest.
- **Linking a moment.** Add `&t=<seconds>` to start a replay there, and `&zoom=5000` (or
  20000, 50000, 150000, 500000) to fix the zoom.

The page and its script load without the token and carry no data. It reads runs through
`GET /viewer/runs` and `GET /viewer/timeline?run=<id>&from=<byte>`, and the plugins' colours
through `GET /viewer/config`, which take the bearer token like every other route. The page knows
only the core's event kinds: the timeline reply carries the plugin's own text for each line of a
plugin's kind, so the page runs no plugin code. The page takes the token from the URL fragment,
which the browser never sends to the server, and keeps it in that tab's session storage. A run ID
must name a directory in the runs dir. The page is served under a content security policy that
allows only its own script, styles and calls.

To look at a moment as an image, render the URL with headless Chrome:
`chrome --headless=new --virtual-time-budget=8000 --screenshot=view.png --window-size=1400,1100 "<url>&t=44&zoom=5000"`.

## Server log

`e2e log` prints the tail of the server's log (`_local/logs/server.log` by default, or what the
config and the handshake name). In a tree whose logger tags lines with `[pid N]` it keeps only the
running server's lines; stock's logger doesn't, so every line stays. `--grep <regex>` filters
case-insensitively, `--lines N` sets the count, and `--any-pid` keeps every process.

## Things that will look wrong

- **"Session has been unable to receive destiny updates for 15s and is being recovered"** and
  **"Beyonce bind wait timed out … forcing initial ballpark bootstrap"**. The server holds a
  session's SetState until it binds the remote park, as a real client does straight after undock
  or a jump. `e2e undock`, `e2e teleport` and any `e2e slash` that changes system bind it, so these
  lines mean something else entered space unbound, e.g. a gateway call made directly.
- **"done (this tree doesn't say whether it refused)"** after `e2e slash`. Stock's slash commands
  report no outcome. The `slash-success` patch makes the commands the tool drives report one.
- **Protection.** Undock sets undock invulnerability; the grid header shows it. NPCs may ignore a
  protected ship, so wait out any countdown first.
- **The ship stays in space after `logout`.** Releasing the session takes the character offline
  where it is. The next `login` resumes in space.
- **A run that names a recipe takes 18 s longer than the last one.** Every vendoring changes the
  tool's commit, which is part of the recipe world's fingerprint, so the world is rebuilt.
