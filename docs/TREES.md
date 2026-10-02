# Running Gridcheck in an EveJS tree

Gridcheck runs in stock EveJS and in forks of it. This page covers setting a tree up, how a tree
tells the tool where things are, the three ways to run its server, what `gridcheck doctor` checks, and
how the tool itself is tested against real trees.

## Setting a tree up

`gridcheck setup --tree <path>`, from a checkout, takes a tree whose own setup is done (its `npm ci` and
its reference data) to a passing smoke test. It runs six commands, printing each before it runs:

| Step | Command | Skipped when |
| --- | --- | --- |
| 1 | `vendor update` from the checkout | the copy is at the checkout's `HEAD` and unedited; always, run from a tree's own copy. From an unpacked folder with no git it always runs; its output says which files changed |
| 2 | `init --mode <mode>` | `gridcheck.config.json` is there and valid, and `--mode` doesn't change it |
| 3 | `agents setup` | every agent asked for is set up; no agent was found and none was named |
| 4 | `patch apply` with each patch the copy reports absent | every patch is applied or detected |
| 5 | `world build starter` | `starter` is built and current; attach mode |
| 6 | `run smoke-undock` | attach mode, where you start the server yourself |

Before step 1 it refuses, changing nothing, while the tree's server is up, or when its
dependencies or reference data are missing; the message names the fix. A partly applied patch
stops it at step 4 with the `patch revert` to run. It stops at the first command that fails; run
it again after the fix, and the steps already done are skipped.

| Flag | Default | |
| --- | --- | --- |
| `--tree <path>` | the tree you're in | |
| `--mode auto\|attach\|managed` | the config's, or `auto` | |
| `--agents claude,codex,cli\|none` | the Claude Code and Codex found | `cli` adds the pointer to [CLI.md](CLI.md) for any other agent |
| `--skip agents,patches,world,smoke` | none | |
| `--force` | | replace a copy whose files were edited |
| `--dry-run` | | each command's own dry run; world and smoke are only shown |

Setup exits 0 when the tree is ready, 1 when a step failed, and 2 when it refused to start. The
GUI's **Do full setup for me…** previews `setup --dry-run` and then runs it ([GUI.md](GUI.md)).

## The tree's config

`gridcheck init` probes the tree and writes `gridcheck.config.json` at its root. Every path the CLI, the MCP
server and the agent bridge use comes from that file. Paths are relative to the tree root, so the
file can be committed with the tree.

```
node tools/gridcheck/bin/gridcheck.js init                  # auto mode, the default
node tools/gridcheck/bin/gridcheck.js init --mode managed   # the CLI always starts and stops the server
node tools/gridcheck/bin/gridcheck.js init --mode attach    # you always start the server
node tools/gridcheck/bin/gridcheck.js init --force          # replace an existing file
```

| Key | What it is | Default |
| --- | --- | --- |
| `mode` | `auto`, `attach` or `managed` | `auto` |
| `serverDir`, `start` | where the server is, and its `npm start` command as argv | `server`, read from `server/package.json` |
| `dataDir` | the generated reference data | `_local/gameStore/data` |
| `gameStore`, `manifest` | the world and its manifest, beside the data dir | `_local/gameStore/` |
| `dataRoot`, `logFile` | the server's data root and its log | `_local`, `_local/logs/server.log` |
| `e2eDir`, `runsDir`, `worldsDir` | the tool's state, runs and saved worlds | `_local/gridcheck/...` |
| `scenariosDir` | the tree's own scenarios, committed with it | `tools/gridcheck-scenarios` |
| `handshake` | where the bridge writes its port and token | `_local/agentBridge/bridge.json` |
| `listeners` | which ports `gridcheck up` can move, and how | probed |
| `daemons.market` | the market daemon and its database | on if the tree has its source and a database |

The environment wins over the file, as it does for the server: `EVEJS_GAMESTORE_DATA_DIR` moves the
data dir and the world beside it, `EVEJS_DATA_ROOT` moves the log, and
`EVEJS_AGENT_BRIDGE_HANDSHAKE` moves the handshake. A tree with no file runs with the defaults. A
file with a mistake stops every command except `init`, `doctor`, `help`, `vendor`, `gui` and
`agents`, and says what is wrong. `init --dry-run` prints the file it would write without writing it.

## Running from a checkout

A tree always runs its own copy, so the CLI and the bridge inside its server are one version. A
checkout's CLI hands each command to that copy:

```
node bin/gridcheck.js --tree <tree> run smoke-undock          # from anywhere
cd <tree>/server && node <checkout>/bin/gridcheck.js status   # inside a tree, --tree isn't needed
```

`npm link` in the checkout puts `gridcheck` on `PATH`, so `gridcheck --tree <tree> <command>`, or `gridcheck <command>`
inside a tree, works from any shell. `vendor`, `gui` and `setup` read `--tree` themselves and run
from the checkout. A tree with no copy yet gets the `setup` command to run. `status` and `doctor`
add a note when the tree's copy isn't the checkout's `HEAD`. Developing the tool itself,
`GRIDCHECK_TREE=<tree>` runs the checkout's own code against the tree instead.

## Auto, attach and managed

In **auto** mode, the default, the tool uses the tree's server when it's up and starts its own when
it isn't. If a server is up, whether you started it yourself or `gridcheck up` did, a run uses it as attach mode does: the scenario's world isn't restored, and the server stays
up afterwards. If none is up, a run boots the scenario's world and stops the server at the end, as
managed mode does. `up` starts a server, and says so when one is already up. `down` stops only a
server `gridcheck up` started; it refuses one you started. `world copy`, `world save`, `world build`,
`up` and `run --world` need the server down. `gridcheck status` says which case applies now.

In **attach** mode you start the server and the tool talks to it: `npm start` in the server folder,
or `StartServer.bat`. Nothing needs setting. The bridge's handshake carries the server's game and gateway ports, its log
and its data dir, so the CLI finds the server wherever its ports are. `login`, `undock`, `grid`,
`watch`, `act`, `slash`, `doctor` and `run` work. `up`, `down`, `world copy` and `world save`
refuse. A scenario run uses the live server as it is: the scenario's world isn't restored and the
server stays up afterwards.

### Which servers gridcheck touches

The agent bridge is what lets gridcheck log in to, drive and stop a server. It's on in every
server a tree starts once the tree has a `gridcheck.config.json`, whichever way it's started.
`EVEJS_AGENT_BRIDGE=0` in the shell that starts the server turns it off, and
`EVEJS_AGENT_BRIDGE=1` turns it on in a tree with no config. A server started before the config
was written has no bridge until it restarts.

gridcheck only works on a server its tree's bridge reports. `login` and every other gateway
command refuse when no bridge is up, and `down` stops only a server through its bridge, or one
`gridcheck up` started. An Eve.js instance without gridcheck installed has no bridge, so gridcheck
never attaches to its server or stops it. The same goes for an instance where gridcheck is
installed but has no config, unless that server was started with `EVEJS_AGENT_BRIDGE=1`. Don't
install gridcheck in an instance people play on, and don't ship a build with
`gridcheck.config.json` in it.

In **managed** mode the CLI runs the server. `gridcheck up` restores or seeds a world, moves every
listener it can onto the tree's own port block, starts the server in the background and waits
until a character can log in. `gridcheck down` stops it cleanly. A run boots its scenario's world and
stops the server at the end.

A scenario names a saved world, `"world": "fresh"` for a new game store seeded from the
reference data, or `"recipe": "<name>"` for a world the tool builds ([WORLDS.md](WORLDS.md)).
`gridcheck run <scenario> --world <name>` boots another world than the one the scenario names. Every
core scenario uses `fresh` or the `starter` recipe, so they all run in any tree.

## What `gridcheck doctor` checks

`gridcheck doctor` asks the running server (`GET /capabilities` on the bridge) and reads the tree's files
when no server is up. `--offline` always reads the files; `--json` prints the whole report.

- **gateway**: whether the tree's web gateway allows each call the CLI makes, and which command
  needs a refused one.
- **destiny**: the bridge has the tree's own encoder write a set of test balls and reads them back
  with its decoder. If the layout differs, the client view stays off and the bridge says so in its
  log, on `/tee` and in every watch's `START` line, rather than reporting DIVERGEs that aren't there.
- **patches**: each optional stock edit in `patches/` as `applied` (its marker comments are in the
  file), `partial` (some are), `detected` (equivalent code without the marker, as in the LU fork),
  `absent`, or `no-target` (a file it changes isn't in the tree). `gridcheck patch` applies and reverts
  them ([PATCHES.md](PATCHES.md)).
- **plugins**: which are active, and why the rest were skipped.
- **listeners**: which ports can move. A listener moves when the tree's source reads its
  variable. Stock EveJS doesn't read `EVEJS_XMPP_SERVER_PORT`, so two stock trees clash on the chat
  port until the `xmpp-port` patch is applied.
- **session**: with a character logged in, whether its session is one the client view can attach
  to.
- **loadout**: whether the tree has the stock ship helpers `gridcheck loadout` builds a ship from.
  Without a running server it reads each module's exports from its file, without loading it.

## Stock EveJS's differences

- Stock's logger writes no `[pid N]` tag, so `gridcheck log` keeps an untagged line by its timestamp:
  only lines written since this server's process started (the bridge's handshake records it), or
  since the last `gridcheck up` with no server up. `--any-pid` shows every line. A watch reads only what
  the log gains while it runs, so it needs neither.
- Stock's slash commands don't say whether they refused. `gridcheck slash` prints `done (this tree
  doesn't say whether it refused)` until the `slash-success` patch is applied.
- Stock's NPCs record no decision, so grid rows have no `decision` and a watch reports no
  `DECISION` events until the `last-decision` patch is applied.
- Stock's reference data comes from its own database creator. The compatibility script builds it
  from an extracted SDE of the build `tools/DatabaseCreator/CreateDatabase.bat` names.

## Testing the tool

In the repo:

```
npm test                                                     # no EveJS tree needed
npm run fixtures:capture -- --tree <path>                    # record the fixtures again
npm run compat -- --stock <EveJS zip> --lu <LU tree>         # both live lanes, then compat-report.md
```

`npm test` runs against `test/fixtures/tree`. That folder has no EveJS code, only the files the lu
plugin checks for, so the plugins' tool halves load. Two recorded fixtures stand in for a tree:

- `destiny.json`: what the tree's destiny encoders returned for every call the destiny tests make.
  The tests build payloads through `test/fixtures/encoders.js`, which replays it.
- `live.json`: a web gateway session's shape and a grid read just after undock, from a fresh stock
  world.

`fixtures:capture` records `destiny.json` by running the destiny tests against the tree's real
encoders. It records `live.json` from the tree's running server, with this checkout vendored into
the tree, by logging the test character in and undocking it.

`compat` unpacks the zip outside the repo (`gridcheck-compat` in your home folder by default, `--scratch` to change it) and
reuses the unpacked tree while the zip is unchanged. It builds the zip's reference data from an
extracted SDE (`--sde`, `GRIDCHECK_SDE_DIR`, or the one the LU tree's data comes from) and vendors
this checkout's HEAD into each tree. Then it runs `init`, `doctor`, `login`, `undock`, `grid`,
`watch` and `smoke-undock`: on stock in managed and in attach mode, on LU in managed mode on its
saved world `lowsec-docked`. On stock in auto mode it runs `smoke-undock` with no server up, then
with a server started by hand, which `down` must refuse to stop and the run must leave up. On stock with the three patches applied it also checks that a
fresh character's loadout is refused with its missing skills, builds `starter`, and runs the five
core scenarios on it, the last one with `--reuse` and then again on the server it left up. It drives `gridcheck gui` through its API against the stock tree: the tree's
summary, its patches, a run's report and frame, and one patch applied and reverted by preview. It
records the fixtures again and fails if they no longer match the
committed ones: the encodings exactly, the session and grid by shape. It runs the tests that need a
real tree and puts LU's vendored copy back (`--keep-lu` leaves it). The lanes run one after the
other, because two large servers at once can lose a persistence lease on one machine.
