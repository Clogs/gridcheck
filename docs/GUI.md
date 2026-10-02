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

On Windows, `OpenGui.bat` runs `e2e gui --open` from the folder it sits in, so double-click it in
a checkout, or in a tree's `tools/evejs-e2e/` for that tree. It passes its arguments on
(`OpenGui.bat --tree F:/EveJS-0.12.9`). It checks for Node 24 first. Closing its window stops the
GUI, and the window stays open on an error so you can read it.

## Which trees

Run from a checkout of this repo, the GUI manages any tree and vendors from that checkout's
committed `HEAD`. Its tree list holds:

- the trees given with `--tree`;
- trees added on the Install tab by typing a path, remembered in the checkout's `_local/gui.json`;
- the checkout's sibling folders that are EveJS trees (they have `server/src`).

The **Tree** picker in the header lists, in columns, each tree with its path, its EveJS version (from
`server/package.json`; each version gets its own colour), whether e2e is installed, and its scenario
runs with a pass bar and passed and failed counts. Trees with the most runs come first. Arrow keys,
Enter and Escape work in the list. The tag beside the picker (installed or not installed) opens the
Install tab.

Run from a tree's vendored copy, it manages that tree only. It can still update the copy, from a
checkout path you type.

Under the tabs, the context bar describes the chosen tree. The server has the block on the left:
whether it's up (with its pid), and what a run does about that in the tree's mode, for example
"Managed mode starts it for each run" or, with a server up in managed mode, that a run needs it
stopped first. To its right are the mode, the EveJS version, the copy, the active plugins and the
tree's folder; on the Runs tab also the run's world and client view. Hover or focus a fact for
more: the copy's card has its installed and checked-out versions, whether its files still match,
and **Update…** when there's a newer commit. Click the folder to copy it.

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

The tree list on the left is split into trees with e2e installed ("Set up") and the rest. Each
tree shows its path and its EveJS version, read from the tree's `server/package.json` (or its root
`package.json`). Set-up trees also show the copy's version, the mode and whether the server is up. A
filter box appears once there are six trees or more.

For the chosen tree, a banner at the top says whether it can run tests: "Ready to run tests", how
many things are left to do, or "Not set up yet". While anything other than the tree's own
dependencies keeps it from running tests, the banner offers **Set up everything…**, which runs
[`e2e setup`](TREES.md#setting-a-tree-up): install, config, the agents found, the patches, the
`starter` world and a smoke test, skipping what is done. A tree with no copy also gets "Install
only…". A bar under its text has
one segment per row. Below it is a checklist. Each row has an icon for its topic with a badge for
its state (done, needed, optional, a problem, or information), one line on its state and at most
one button. Click a row to open its details. Rows that need you start open. The Install tab's
count is the number of rows that keep the tree from running tests.

Paths, commands, commits, versions and environment variables on this tab are coloured chips, one
colour and icon per kind; the legend above the banner shows them. Click a chip to copy it.

1. **e2e is installed.** Not installed, or its version and commit, and whether it still matches
   its `VENDOR.json` (the drift check, with every edited, added or missing file in the details).
   From a checkout it also says whether the copy is that checkout's commit, and offers "Update…"
   when it isn't. "Install…", "Update…" and "Replace edited files…" run `vendor update`. The last
   adds `--force`, as does replacing a folder that was never vendored. The shim's state is in the
   details.
2. **Server mode.** The mode from `e2e.config.json`, or "Choose a server mode" when there's no
   file. The details have the three modes side by side, and "Write config…" runs
   `e2e init --mode <mode>`, with `--force` when the file exists. Auto mode uses the tree's
   server when it's up and starts its own when it isn't. Managed mode always starts its own; attach
   mode only uses a server you start.
3. **AI agents.** Claude Code and Codex: whether each is on this machine and whether it already
   runs this tree's MCP server. Each agent that isn't connected has its own "Connect…" button
   ("Set up anyway…" when it wasn't found), which runs `e2e agents setup <agent>`. The preview
   shows the lines it adds to the tree's `.mcp.json` or to Codex's `config.toml`. "Other agents
   (CLI)" has "Add pointer…", which adds a pointer to [CLI.md](CLI.md) to the tree's `AGENTS.md` or
   `CLAUDE.md`, for agents without MCP. Setup only adds entries.
   [GUIDE.md](GUIDE.md#setting-up-agents) has the rules. Agents are optional.
4. **Dependencies and reference data.** Its npm dependencies (`node_modules` at the root and in
   `server/`, where their `package.json` lists any) and the reference data (the data dir's
   `solarSystems/data.json`), each missing one with the command that fixes it. The GUI doesn't run
   these; they are the tree's own setup.
5. **Plugins.** The plugins that apply to the tree and the ones skipped, with the reason. "Run
   health check" runs the tree's `e2e doctor --json` and shows its report in the row.
6. **The game server.** Whether it's up, and what that means in the tree's mode. It never blocks
   the banner.

Under the checklist, **Run a test** shows how to run one once the tree is ready, in two steps:

1. **The world.** For a scenario that names a recipe, `e2e world build <recipe>` with a label under
   each part, whether that world is built and current, what each recipe step does, where it's
   saved, and that it needs the server down. The step is optional, since a run builds a missing or
   stale recipe world itself. A scenario on a fresh or saved world has nothing to build. In attach
   mode this step is `e2e login` on the server you started.
2. **The scenario.** Pick one of the tree's scenarios (its own, the core's, each plugin's; a chip's
   colour is its last run's verdict, and one that doesn't load is struck through). The card shows
   the command, the scenario's description, what it checks, where it starts and when it stops, its
   last run and the scenario file. `--check`, `--keep-up` and `--reuse` change the command.

A note under the steps says how many of the Patches tab's patches are on. The scenarios and
recipes come from the tree's own copy (`e2e run --json`, `e2e world recipes --json`). A copy too
old for them gets the two fixed commands instead, with a note to update it.

The second tab, **Ask your agent**, names the connected agents, offers requests to copy and lists
the MCP tools they have.

## Commands

Every command the tree's copy has, from its `e2e help --json`, in groups: set up, worlds, server,
character and ship, watch and read, scenarios, this tool, and one group per active plugin. Each row
has the command, a one-line summary, its usage and tags:

| Tag | Means |
| --- | --- |
| server up | It needs a running server. |
| server down | It needs the server stopped. |
| auto · managed | Attach mode refuses it. |
| writes files | It changes files in the tree. |
| MCP | Agents have a tool for the same thing. |

Open a row for every usage line, its flags with their defaults, its choices (such as `act`'s
actions), examples and notes. The search box matches names, summaries, usage and flags; **Works
now** keeps the commands the tree can run with its server as it is. The copy button on each row
copies `node tools/evejs-e2e/bin/e2e.js <command>`. A copy older than `help --json`, or a tree
without one, shows the list of the e2e running the page, and says so. The summaries live in
`core/commandDocs.js` beside the command table's usage lines; a test fails when a command has
none.

## Patches

Each optional patch in the tree's copy with its state, from `e2e patch status --json`: `absent`
(with whether it applies cleanly), `applied`, `detected` (the tree already has equivalent code),
`partial` or `no-target`. An absent patch offers "Preview apply" and an applied one "Preview
revert". [PATCHES.md](PATCHES.md) describes the patches.

## Every change is previewed

Set up everything, install, update, config, agent setup, apply and revert all work the same way:

1. The page asks the server for a preview. The server runs the command with `--dry-run` and
   returns the command, the folder it runs in, and the dry run's output: the files a vendor update
   adds, changes and removes; the config `init` would write; the lines a patch inserts or removes,
   with their line endings.
2. The dialog shows it. If the change would be refused, it says why and offers no Run button.
3. Run asks the server to run that same command, without `--dry-run`, by the preview's ID. A preview
   runs once and expires after 10 minutes. The output and exit code replace the preview. A command
   gets 5 minutes, and Set up everything 20, since a first setup builds a world and boots twice.

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
| `GET /gui/api/trees` | The tree list: `id`, `root`, EveJS version (`evejs`), copy version, mode, server up, and `runs` (`total`, `passed`, `failed` scenario runs). |
| `POST /gui/api/trees` `{ "path": "F:/EveJS-0.12.9" }` | Add a tree. |
| `GET /gui/api/tree?tree=<id>` | The Install tab's summary: `copy`, `shim`, `config`, `prerequisites` (each `{ name, path, ok, fix }`), `serverUp`, `serverPid`, `plugins`, `agents` (each `{ id, name, installed, evidence, file, registered, serverName, problem }`). |
| `GET /gui/api/scenarios?tree=<id>` | `scenarios` (the copy's `run --json`: each `{ name, file, plugin, description, world, recipe, timeout, expect, problem }`) and `recipes` (`world recipes --json`: each `{ name, description, state, why, savedAt, steps }`); `null` for a copy without them. |
| `GET /gui/api/commands?tree=<id>` | The copy's `help --json`: `prefix`, `groups`, `commands` (each `{ name, group, summary, usage, needs, managed, writes, mcp, flags, examples, note, plugin }`) and `mcpTools`, with `source` `tree`, or `tool` and a `note` when it's this copy's list. |
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
