# Gridcheck from the command line, for agents

You are verifying a change to an EveJS server in game, with no EVE client: a headless character
logs in, undocks, flies and fights, and the tool records the grid as a timeline and judges it
against what you said should happen. This page is the whole workflow for an agent that drives the
tool through a shell. Agents with MCP have the same commands as tools; this page applies to them
too, with each `gridcheck <command>` read as its tool.

## Calling it

Run every command from the tree's root:

```
node tools/gridcheck/bin/gridcheck.js <command>
```

This page writes that as `gridcheck <command>`. Each call is its own process; the character and session
carry over in `_local/gridcheck/state.json`. `gridcheck help` lists every command and flag, and `gridcheck help --json`
gives the same as data. A message that names a command, such as "`gridcheck login` first", is the next
thing to run.

Long calls block your shell: a run takes one to three minutes, a first world build up to two, and
`gridcheck watch --for N` blocks for N seconds. Where your shell has a time limit, use `--detach` and
`report --wait` as below.

## The loop

Work through these in order. Each step ends on its own criterion.

1. **Orient.** `gridcheck status`, then `gridcheck doctor`. Done when you know the server mode (auto, attach
   or managed), whether a server is up, which scenarios and worlds exist, and that doctor reports
   no problem for what you need. In attach mode with no server up, ask the user to start one
   (`npm start` or `StartServer.bat`); nothing else will start it.
2. **Learn the format.** `gridcheck primer` prints the scenario format, the setup steps and player
   actions, the condition syntax, every event kind's fields, performance runs and each plugin's
   notes; `gridcheck primer <topic>` prints one part (`start`, `scenarios`, `conditions`, `events`,
   `perf`, `client`, `plugins`). Done when you have read it in this session: it is the only reference for
   those, and it matches this tree's plugins.
3. **Draft the scenario.** `gridcheck scenario new <name>` writes a draft to `_local/gridcheck/scenarios/` that
   checks out as it stands; `--from <scenario>` copies one closer to your case (`gridcheck run` lists
   them). Edit it so setup starts your feature the way the game would, `until` stops on the
   outcome, and each `expect` row is one thing a reviewer would check, with a `note`. Done when
   every expectation names something your change makes happen, not something that happens anyway.
4. **Check it.** `gridcheck run <name> --check`. It boots nothing. Done when it prints `ok`. A wrong field
   name gets the kind's real fields in the error.
5. **Run it.** `gridcheck run <name> --detach` prints a run ID. `gridcheck report <run> --wait 600` waits and
   prints the verdict; exit 3 means still running, so call it again. Without a time limit,
   `gridcheck run <name>` alone blocks to the verdict.
6. **Judge it.** Read "Expected against observed" in the report. Done when every row is explained:
   a MISSING row is a bug in the feature or a wrong expectation, and the timeline
   (`gridcheck report <run> --section full`) shows which. A met row whose first match is the wrong event
   is too loose: bind the ID with `"as"` and match on `$name`. Change and rerun until the verdict
   is the one the feature deserves.
7. **Keep it.** `gridcheck scenario new <name> --from _local/gridcheck/scenarios/<name>.json --save` copies the
   draft to `tools/gridcheck-scenarios/`; commit it with the feature. `gridcheck report <run> --section pr`
   prints markdown that cites the run in a PR description.

## Exit codes

| Code | `run`, `report` | Other commands |
| --- | --- | --- |
| 0 | passed | done |
| 1 | an expectation failed | an error; the message says what to run |
| 2 | the run did not complete, or no such run | the server refused it (`slash`, `act`, `loadout`) |
| 3 | (`report`) still running | |

## By hand

To look around before writing a scenario, or to see why one fails:

```
gridcheck up --world starter      # managed or auto mode; a run does this itself
gridcheck login
gridcheck undock
gridcheck grid                    # what's on grid now; --json shows the field names conditions use
gridcheck grid --at <itemID>      # the same around any entity, with no character logged in
gridcheck inspect <itemID>        # one entity's capacitor, running modules, locks and AI state
gridcheck loadout Tristan --into <officeID>   # a fitted ship left in a corp office, not boarded
gridcheck world items --location <id>         # read-only: what sits in a hangar, office or ship (--item <id> for one)
gridcheck slash "/npc 2"          # any GM command, as the character
gridcheck act lock nearest npc    # player actions: approach, orbit, lock, activate, launchDrones, ...
gridcheck watch --for 60          # what changed, as timeline lines
gridcheck log --grep NpcController
gridcheck down
```

`gridcheck up` returns once a character can log in (`--timeout`, default 600 s), so run it in the
foreground; don't background it and poll its log. `--env NAME=VALUE`, repeatable, sets a variable in
the server's environment, such as a feature switch the tree's config leaves off. A scenario sets the
same with `"up": { "env": { "NAME": "value" } }`. New characters skip the AIR tutorial, which EveJS
261018.1's config turns on; `--env EVEJS_NEW_CHARACTER_EXPERIENCE_MODE=tutorial` keeps it.

After changing the server's code, `gridcheck restart` stops it and boots it again with the world
kept; `--clients` launches the EVE clients you had attached again. Log the headless character in
again after. `gridcheck slash "<command>" --as client` runs a command as the real client's
character, and `gridcheck teleport <name>` takes a system name, which stock `/tr` can miss.

Start `gridcheck watch --for 60` in the background before you act, to see the action's effect. `gridcheck
perf --for 10` measures server ticks; the primer covers performance runs.

## A real EVE client

When the bug is in the client itself (its UI, what its ballpark holds, an exception it logs),
`gridcheck client` starts the real EVE client and reads it from inside. The tree needs the opt-in
`client-agent` patch; `gridcheck doctor` says whether it's applied and what else is missing.

```
gridcheck client launch            # logged in and in game; its own account, e2eclient
gridcheck client ui --text undock  # UI nodes whose text contains it, with path, rect and state
gridcheck client screenshot        # what it draws, as a PNG; works while covered or minimized
gridcheck client screenshot --window <window> --fresh   # one window, drawn after this call
gridcheck client ballpark          # the balls the client holds
gridcheck client diff              # those against the server's grid; exit 1 when they disagree
gridcheck client events --since last   # its exceptions since you last asked; noise hidden
gridcheck client events --frame <file>  # only exceptions from that code, with tracebacks
gridcheck client console --grep EXCEPTION
gridcheck client eval "<python>"   # Python 2.7 inside the client; --vars '<json>' sets names first
gridcheck client inspect <Class>   # a loaded class: module, default_* attributes, methods
gridcheck client rpc <svc> <method> --payload '<json>' --shape   # a reply's outline
gridcheck client rpc-log           # the calls that may have changed state, to put it back
gridcheck client act warpTo <id>   # a player's action, answered once it's done: undock, dock, warpTo, orbit, lock ...
gridcheck client click --text undock               # a UI node's own click handler; --window keeps to one window
gridcheck client type "rifter" --name <edit>       # name the edit; key enter, escape, f1 ... too
gridcheck client cmd OpenInventory                 # a client command; `client cmd` lists them
gridcheck client stop              # stop the client when you're done
```

Driving runs inside the client, so its window can stay in the background. Several clients run at
once, each on its own account (`launch --user e2eclient2 --name "Client Second"`; `--user` picks
one), never a headless pilot's. `gridcheck primer client` has the details. The client opens a
window on the user's desktop.

On a Living Universe tree, `gridcheck lu-reload [<module>]` reloads a client module the server
delivers at login in the running client, with no new login; errors name `file.py:line`, `--check`
only compiles, and `--then "<python>"` runs after install.

A scenario can do all of this as steps (`clientLaunch`, `clientUi`, `clientClick`, `clientAct`,
`clientEval`, `clientDiff`, `clientScreenshot`), expect on what the client held (`CLIENT_BALLPARK`,
and `CLIENT_BALL` with `"watch": { "ballpark": true }`), and put screenshots in its report.
`gridcheck run client-undock` is the example; `gridcheck primer scenarios` lists the steps. A run
stops the clients it launched.

## Keeping to your files

`tools/gridcheck/` is a vendored copy; `vendor check` fails if it changes. Your scenarios go in
`tools/gridcheck-scenarios/` or the drafts folder, and your fixes go in the tree's own code. When the
tool itself is wrong, say so to the user with the command and its output.

## More

The [guide](GUIDE.md) covers every part in depth: grids, watches, the client view, actions,
scenarios, frames and the viewer. [WORLDS.md](WORLDS.md) covers loadouts and world recipes.
