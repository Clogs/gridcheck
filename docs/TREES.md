# Running evejs-e2e in an EveJS tree

evejs-e2e runs in stock EveJS and in forks of it. This page covers how a tree tells the tool where
things are, the two ways to run its server, what `e2e doctor` checks, and how the tool itself is
tested against real trees.

## The tree's config

`e2e init` probes the tree and writes `e2e.config.json` at its root. Every path the CLI, the MCP
server and the agent bridge use comes from that file. Paths are relative to the tree root, so the
file can be committed with the tree.

```
node tools/evejs-e2e/bin/e2e.js init                  # attach mode, the default
node tools/evejs-e2e/bin/e2e.js init --mode managed   # the CLI starts and stops the server
node tools/evejs-e2e/bin/e2e.js init --force          # replace an existing file
```

| Key | What it is | Default |
| --- | --- | --- |
| `mode` | `attach` or `managed` | `attach` |
| `serverDir`, `start` | where the server is, and its `npm start` command as argv | `server`, read from `server/package.json` |
| `dataDir` | the generated reference data | `_local/gameStore/data` |
| `gameStore`, `manifest` | the world and its manifest, beside the data dir | `_local/gameStore/` |
| `dataRoot`, `logFile` | the server's data root and its log | `_local`, `_local/logs/server.log` |
| `e2eDir`, `runsDir`, `worldsDir` | the tool's state, runs and saved worlds | `_local/e2e/...` |
| `scenariosDir` | the tree's own scenarios, committed with it | `tools/e2e-scenarios` |
| `handshake` | where the bridge writes its port and token | `_local/agentBridge/bridge.json` |
| `listeners` | which ports `e2e up` can move, and how | probed |
| `daemons.market` | the market daemon and its database | on if the tree has its source and a database |

The environment wins over the file, as it does for the server: `EVEJS_GAMESTORE_DATA_DIR` moves the
data dir and the world beside it, `EVEJS_DATA_ROOT` moves the log, and
`EVEJS_AGENT_BRIDGE_HANDSHAKE` moves the handshake. A tree with no file runs with the defaults. A
file with a mistake stops every command except `init`, `doctor`, `help`, `vendor` and `gui`, and
says what is wrong. `init --dry-run` prints the file it would write without writing it.

## Attach and managed

In **attach** mode you start the server and the tool talks to it. Set `EVEJS_AGENT_BRIDGE=1` in
the shell that starts it, for example `npm start` in the server folder, or `StartServer.bat`
run from that shell. The bridge's handshake carries the server's game and gateway ports, its log
and its data dir, so the CLI finds the server wherever its ports are. `login`, `undock`, `grid`,
`watch`, `act`, `slash`, `doctor` and `run` work. `up`, `down`, `world copy` and `world save`
refuse. A scenario run uses the live server as it is: the scenario's world isn't restored and the
server stays up afterwards.

In **managed** mode the CLI runs the server. `e2e up` restores or seeds a world, moves every
listener it can onto the tree's own port block, starts the server in the background and waits
until a character can log in. `e2e down` stops it cleanly. A run boots its scenario's world and
stops the server at the end.

A scenario names a saved world, `"world": "fresh"` for a new game store seeded from the
reference data, or `"recipe": "<name>"` for a world the tool builds ([WORLDS.md](WORLDS.md)).
`e2e run <scenario> --world <name>` boots another world than the one the scenario names. Every
core scenario uses `fresh` or the `starter` recipe, so they all run in any tree.

## What `e2e doctor` checks

`e2e doctor` asks the running server (`GET /capabilities` on the bridge) and reads the tree's files
when no server is up. `--offline` always reads the files; `--json` prints the whole report.

- **gateway**: whether the tree's web gateway allows each call the CLI makes, and which command
  needs a refused one.
- **destiny**: the bridge has the tree's own encoder write a set of test balls and reads them back
  with its decoder. If the layout differs, the client view stays off and the bridge says so in its
  log, on `/tee` and in every watch's `START` line, rather than reporting DIVERGEs that aren't there.
- **patches**: each optional stock edit in `patches/` as `applied` (its marker comments are in the
  file), `partial` (some are), `detected` (equivalent code without the marker, as in the LU fork),
  `absent`, or `no-target` (a file it changes isn't in the tree). `e2e patch` applies and reverts
  them ([PATCHES.md](PATCHES.md)).
- **plugins**: which are active, and why the rest were skipped.
- **listeners**: which ports can move. A listener moves when the tree's source reads its
  variable. Stock EveJS doesn't read `EVEJS_XMPP_SERVER_PORT`, so two stock trees clash on the chat
  port until the `xmpp-port` patch is applied.
- **session**: with a character logged in, whether its session is one the client view can attach
  to.
- **loadout**: whether the tree has the stock ship helpers `e2e loadout` builds a ship from.
  Without a running server it reads each module's exports from its file, without loading it.

## Stock EveJS's differences

- Stock's logger writes no `[pid N]` tag, so `e2e log` and a watch's log lines can't tell this
  server's lines from another process's.
- Stock's slash commands don't say whether they refused. `e2e slash` prints `done (this tree
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

`compat` unpacks the zip outside the repo (`F:/LU/_compat` by default, `--scratch` to change it) and
reuses the unpacked tree while the zip is unchanged. It builds the zip's reference data from an
extracted SDE (`--sde`, `EVEJS_E2E_SDE_DIR`, or the one the LU tree's data comes from) and vendors
this checkout's HEAD into each tree. Then it runs `init`, `doctor`, `login`, `undock`, `grid`,
`watch` and `smoke-undock`: on stock in managed and in attach mode, on LU in managed mode on its
saved world `lowsec-docked`. On stock with the three patches applied it also checks that a
fresh character's loadout is refused with its missing skills, builds `starter`, and runs the five
core scenarios on it. It drives `e2e gui` through its API against the stock tree: the tree's
summary, its patches, a run's report and frame, and one patch applied and reverted by preview. It
records the fixtures again and fails if they no longer match the
committed ones: the encodings exactly, the session and grid by shape. It runs the tests that need a
real tree and puts LU's vendored copy back (`--keep-lu` leaves it). The lanes run one after the
other, because two large servers at once can lose a persistence lease on one machine.
