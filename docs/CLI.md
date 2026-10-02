# evejs-e2e from the command line, for agents

You are verifying a change to an EveJS server in game, with no EVE client: a headless character
logs in, undocks, flies and fights, and the tool records the grid as a timeline and judges it
against what you said should happen. This page is the whole workflow for an agent that drives the
tool through a shell. Agents with MCP have the same commands as tools; this page applies to them
too, with each `e2e <command>` read as its tool.

## Calling it

Run every command from the tree's root:

```
node tools/evejs-e2e/bin/e2e.js <command>
```

This page writes that as `e2e <command>`. Each call is its own process; the character and session
carry over in `_local/e2e/state.json`. `e2e help` lists every command and flag, and `e2e help --json`
gives the same as data. A message that names a command, such as "`e2e login` first", is the next
thing to run.

Long calls block your shell: a run takes one to three minutes, a first world build up to two, and
`e2e watch --for N` blocks for N seconds. Where your shell has a time limit, use `--detach` and
`report --wait` as below.

## The loop

Work through these in order. Each step ends on its own criterion.

1. **Orient.** `e2e status`, then `e2e doctor`. Done when you know the server mode (auto, attach
   or managed), whether a server is up, which scenarios and worlds exist, and that doctor reports
   no problem for what you need. In attach mode with no server up, ask the user to start one with
   `EVEJS_AGENT_BRIDGE=1` set; nothing else will start it.
2. **Learn the format.** `e2e primer` prints the scenario format, the setup steps and player
   actions, the condition syntax and each plugin's notes. Done when you have read it in this
   session: it is the only reference for those, and it matches this tree's plugins.
3. **Draft the scenario.** `e2e scenario new <name>` writes a draft to `_local/e2e/scenarios/` that
   checks out as it stands; `--from <scenario>` copies one closer to your case (`e2e run` lists
   them). Edit it so setup starts your feature the way the game would, `until` stops on the
   outcome, and each `expect` row is one thing a reviewer would check, with a `note`. Done when
   every expectation names something your change makes happen, not something that happens anyway.
4. **Check it.** `e2e run <name> --check`. It boots nothing. Done when it prints `ok`. A wrong field
   name gets the kind's real fields in the error.
5. **Run it.** `e2e run <name> --detach` prints a run ID. `e2e report <run> --wait 600` waits and
   prints the verdict; exit 3 means still running, so call it again. Without a time limit,
   `e2e run <name>` alone blocks to the verdict.
6. **Judge it.** Read "Expected against observed" in the report. Done when every row is explained:
   a MISSING row is a bug in the feature or a wrong expectation, and the timeline
   (`e2e report <run> --section full`) shows which. A met row whose first match is the wrong event
   is too loose: bind the ID with `"as"` and match on `$name`. Change and rerun until the verdict
   is the one the feature deserves.
7. **Keep it.** `e2e scenario new <name> --from _local/e2e/scenarios/<name>.json --save` copies the
   draft to `tools/e2e-scenarios/`; commit it with the feature. `e2e report <run> --section pr`
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
e2e up --world starter      # managed or auto mode; a run does this itself
e2e login
e2e undock
e2e grid                    # what's on grid now; --json shows the field names conditions use
e2e slash "/npc 2"          # any GM command, as the character
e2e act lock nearest npc    # player actions: approach, orbit, lock, activate, launchDrones, ...
e2e watch --for 60          # what changed, as timeline lines
e2e log --grep NpcController
e2e down
```

Start `e2e watch --for 60` in the background before you act, to see the action's effect. `e2e
perf --for 10` measures server ticks; the primer covers performance runs.

## Keeping to your files

`tools/evejs-e2e/` is a vendored copy; `vendor check` fails if it changes. Your scenarios go in
`tools/e2e-scenarios/` or the drafts folder, and your fixes go in the tree's own code. When the
tool itself is wrong, say so to the user with the command and its output.

## More

The [guide](GUIDE.md) covers every part in depth: grids, watches, the client view, actions,
scenarios, frames and the viewer. [WORLDS.md](WORLDS.md) covers loadouts and world recipes.
