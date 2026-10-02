# The GUI

`e2e gui` serves a page on loopback for installing the tool into EveJS trees, applying its patches
and replaying runs. Everything it does is a CLI command you could type, and the page shows each one
before it runs.

```bash
node bin/e2e.js gui                        # from an evejs-e2e checkout: any tree
node bin/e2e.js gui --tree F:/EveJS-0.12.9 --open
node tools/evejs-e2e/bin/e2e.js gui        # from a tree's vendored copy: that tree only
```

It prints a URL such as `http://127.0.0.1:52011/gui#token=<64 hex>` and runs until Ctrl-C.
`--open` opens it in the default browser, and `--port N` fixes the port (default: a free one).

## Which trees

Run from a checkout of this repo, the GUI manages any tree and vendors from that checkout's
committed `HEAD`. Its tree list holds:

- the trees given with `--tree`;
- trees added on the Install tab by typing a path, remembered in the checkout's `_local/gui.json`;
- the checkout's sibling folders that are EveJS trees (they have `server/src`).

Run from a tree's vendored copy, it manages that tree only. It can still update the copy, from a
checkout path you type.

## Runs

The Runs tab replays one run at a time, in either of two views. **View** at the right of the tab
bar switches between them, and the page remembers the choice. Both read the run's
`timeline.jsonl`, `result.json`, frames and `report.md`, and both follow a run that is still being
written.

### Workbench

Three panes:

- **The rail** lists the tree's runs grouped by scenario, newest group first. Each group shows the
  verdicts of its last 8 runs, oldest first: passed, failed, or did not complete. A run that is still
  being written is pinned at the top with **Follow**. The filter matches scenario names, and
  **Failing** keeps the scenarios with a failed run. The list refreshes every 15 s.
- **The replay** is a top-down map centred on self, with range rings, locks, shots, damage and
  DIVERGE rings. Click a ship to select it. Below the map are the play controls (step by event,
  next DIVERGE, speed, follow live) and a track with one lane per event kind. Click or drag the
  track to seek. The event list under it has a chip per kind to show or hide it, and a regex
  filter. CLIENT, PERF and PROFILE lines start hidden.
- **The inspector** has six tabs:
  - **Summary**: the totals, the expectations, the selected ship and the frames. The selected
    ship's shield, armour and hull come from its DAMAGE events; a layer the run never reports
    shows `?`. A run with `PERF` lines also gets a line with its worst ticks, which opens Perf.
  - **Expectations**: each condition, its note, its count and when it was first met.
  - **Perf**: the server's ticks ([below](#perf)).
  - **Frames**: the run's frames.
  - **Report**: the run's `report.md`.
  - **Facts**: the scenario file, world, commit, stop reason, bindings and steps.

  Clicking an expectation, a frame, a step or an event seeks the replay to it. **Viewer ↗** opens
  the standalone [viewer](GUIDE.md#viewer) on the run. `&tab=perf` (or `expect`, `frames`,
  `report`, `facts`) in the URL opens that tab.

Keys: space plays and pauses, left and right step by event, D jumps to the next DIVERGE, and Home
and End go to the ends.

### Trace

One timeline for the whole run, like a profiler trace:

- **Expectations** are numbered flags where each was first met. A missing one is a red flag at the
  right edge.
- **Frames** form a filmstrip, with a pin at each frame's time.
- **Server tick**, for a run with `PERF` lines: the worst tick in each column, green under half
  the 100 ms budget, amber above half and red over it.
- **Each ball has a lane**, up to 40 lanes. Self comes first, then the other ships, then each swarm
  of same-named drones or fighters as one lane.
  - A lane's spans are its modes, with the target when it moves relative to one. They come from
    the position samples, refined by MODE events. A swarm's span is what most of its members are
    doing.
  - Marks show locks, shots, hits, decisions and divergences, and ✕ marks a kill. Click a mark to
    select its event.
- **Divergence** and **log density** have their own rows.

The panes below follow the cursor:

- the map at that moment;
- the selected event, or the latest one, with its fields and raw JSON;
- what was diverging between server and client, the divergences ahead, and the log lines within
  2 s.

Click or drag anywhere on the timeline to move the cursor. The − / fit / + buttons zoom, and so do
Ctrl + wheel and the + and − keys. Shift + wheel pans a zoomed timeline.

### Perf

A run has the server's ticks when its scenario has `"up": { "profile": true }` or
`"watch": { "perf": true }`, or when `e2e watch --perf` wrote it
([GUIDE.md](GUIDE.md#performance-testing)). The tab computes its figures with the same code as the
report's "Server performance" section (`core/perf.js`, served as `/gui/perf.js`), so the two agree.

- **Totals.** Ticks, average, p95, p99, max and ticks over budget. A figure is green under half the
  100 ms budget, amber above half and red over it.
- **Tick time.** Every tick of the run on the run's clock. The band is the worst tick in each pixel
  column and the line is the average. The budget is a dashed red line, and a red mark sits above any
  column that went over it. Dashed blue lines mark where steps ended, numbered as in the phase
  table. The scale fits the run's own ticks, so a quiet run isn't a flat line under the budget.
  Click to seek. The white line is the replay's time.
- **Phases.** One row per step that ended, with ticks, average, p95, max and ticks over budget. The
  phase the replay is in is marked. Click a row to seek to its start.
- **Process.** The worst window's event-loop delay (p99), CPU and heap, the most entities at once,
  the lowest time dilation, and the number of profiler windows.
- **Subsystems.** The tick profiler's sections over the whole run, costliest first, in ms per tick
  and share of the tick. Nested rows are indented and lighter, because their time is already in the
  row above. Without the profiler the tab says how to turn it on.

## Install

For the chosen tree:

1. **The vendored copy.** Not installed, or its version and commit, and whether it still matches
   its `VENDOR.json` (the drift check, with every edited, added or missing file listed). From a
   checkout it also says whether the copy is that checkout's commit. "Preview install" or "Preview
   update" runs `vendor update`. A copy with edits, or a folder that was never vendored, needs "replace
   edited files" (`--force`). The shim's state is shown below it.
2. **The tree's config.** Whether `e2e.config.json` exists, its mode and any problems in it.
   "Preview config" runs `e2e init --mode <mode>`, with `--force` when the file exists. Auto mode,
   the default, uses the tree's server when it's up and starts its own when it isn't. Managed mode
   always starts its own; attach mode only uses a server you start.
3. **Agents.** Claude Code and Codex: whether each is on this machine (and what gave it away),
   and whether it already runs this tree's MCP server. The agents found and not set up yet start
   ticked. "Preview setup" runs `e2e agents setup <agents>`, and the preview shows the lines it adds
   to the tree's `.mcp.json` and to Codex's `config.toml`. Setup only adds entries.
   [GUIDE.md](GUIDE.md#setting-up-agents) has the rules.
4. **What the tree needs to run.** Its npm dependencies (`node_modules` at the root and in `server/`,
   where their `package.json` lists any) and the reference data
   (the data dir's `solarSystems/data.json`), each with the command that fixes it. The GUI doesn't
   run these; they are the tree's own setup. Also whether the tree's server is up.
5. **Plugins and doctor.** The plugins that apply to the tree and the ones skipped, with the
   reason. "Run e2e doctor" runs the tree's `e2e doctor --json` and shows its report.
6. **Next.** The commands to run once the tree is ready.

## Patches

Each optional patch in the tree's copy with its state, from `e2e patch status --json`: `absent`
(with whether it applies cleanly), `applied`, `detected` (the tree already has equivalent code),
`partial` or `no-target`. An absent patch offers "Preview apply" and an applied one "Preview
revert". [PATCHES.md](PATCHES.md) describes the patches.

## Every change is previewed

Install, update, config, agent setup, apply and revert all work the same way:

1. The page asks the server for a preview. The server runs the command with `--dry-run` and
   returns the command, the folder it runs in, and the dry run's output: the files a vendor update
   adds, changes and removes; the config `init` would write; the lines a patch inserts or removes,
   with their line endings.
2. The dialog shows it. If the change would be refused, it says why and offers no Run button.
3. Run asks the server to run that same command, without `--dry-run`, by the preview's ID. A preview
   runs once and expires after 10 minutes. The output and exit code replace the preview.

A change is refused when:

- the tree's server is up (a live bridge handshake, or a live `e2e up` run). Agent setup is the
  exception: it doesn't touch the server;
- a file it would change has uncommitted changes: `tools/evejs-e2e/` and the shim for a vendor
  update, `e2e.config.json` for config, `.mcp.json` for Claude Code's setup, a patch's targets for
  an apply. A tree that isn't a git
  checkout, such as an unpacked zip, can't be checked, and the preview says so;
- the dry run fails, for example `vendor update` on a drifted copy without `--force`, or a patch
  whose anchor is missing;
- the copy's own `e2e help` doesn't list `--dry-run` for the command. An older copy would ignore
  the flag and make the change during the preview, so the GUI asks you to update the copy first.

The checks run again when you press Run, so a server started after the preview still stops the
change.

## Security

The server listens on `127.0.0.1` only. The page and its script carry no data and load without the
token. Every other route needs the bearer token, which reaches the page in the URL's fragment, so
it never reaches a server log, and which the page keeps in the tab's session storage. Pages are
served with the viewer's policy: only the GUI's own scripts, styles and calls, no framing, and
frames shown from `blob:` URLs the page fetched with the token. Reports and tree data are put on
the page as text, never as HTML. Run IDs and frame names are checked against the run's own folder.
Commands run as `node <script> <args>` without a shell, so a typed path can't run anything else.

## Driving it from a script

The page uses a small JSON API, and a script or an agent can call it the same way, with
`Authorization: Bearer <token>` from the printed URL. A tree's `id` comes from `/gui/api/trees`.

| Call | Does |
| --- | --- |
| `GET /gui/api/context` | Checkout or vendored copy, its version and commit. |
| `GET /gui/api/trees` | The tree list: `id`, `root`, copy version, mode, server up. |
| `POST /gui/api/trees` `{ "path": "F:/EveJS-0.12.9" }` | Add a tree. |
| `GET /gui/api/tree?tree=<id>` | The Install tab's summary: `copy`, `shim`, `config`, `prerequisites` (each `{ name, ok, fix }`), `serverUp`, `plugins`, `agents` (each `{ id, name, installed, evidence, file, registered, serverName, problem }`). |
| `GET /gui/api/doctor?tree=<id>` | `e2e doctor --json`, parsed. |
| `GET /gui/api/patches?tree=<id>` | `e2e patch status --json`, parsed. |
| `POST /gui/api/preview` `{ "tree": "<id>", "action": "vendor" \| "init" \| "agents" \| "patch-apply" \| "patch-revert", "mode": "auto", "agents": ["claude", "codex"], "id": "xmpp-port", "force": false }` | The preview: `ok`, `refused`, each step's command and dry-run output, and a `previewID` when `ok`. |
| `POST /gui/api/run` `{ "previewID": "..." }` | Runs the previewed commands; each step's output and exit code. |
| `GET /gui/api/runs?tree=<id>` | The runs, newest first, each with `result`: `name`, `world`, `startedAtMs`, `stoppedAtMs`, `passed`, `exitCode`, `missing`, `expectations` (a count). |
| `GET /viewer/timeline?tree=<id>&run=<run>&from=<byte>` | The next chunk of a run's `timeline.jsonl`, as the Runs tab reads it. |
| `GET /gui/api/run?tree=<id>&run=<run>` | `{ run, dir, report, frames, hasTimeline, result }`: the run's ID, folder, `report.md`, frame names and `result.json`. |
| `GET /gui/api/frame?tree=<id>&run=<run>&file=<name>.svg` | One frame. |

A run in the Runs tab is `/gui#tab=runs&tree=<id>&run=<run>&view=workbench` (or `view=trace`), and
`&t=<seconds>` opens it at that moment. The standalone replay viewer for a run is
`/viewer#token=<token>&tree=<id>&run=<run>`.
