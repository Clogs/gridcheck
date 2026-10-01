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

A tree's runs, newest first, with each verdict (passed, failed, or did not complete) and how many
expectations were met. Pick one to see its frames and its `report.md`. "Open replay" opens the
[viewer](GUIDE.md#viewer) on that run in a new tab. The list refreshes every 15 s.

## Install

For the chosen tree:

1. **The vendored copy.** Not installed, or its version and commit, and whether it still matches
   its `VENDOR.json` (the drift check, with every edited, added or missing file listed). From a
   checkout it also says whether the copy is that checkout's commit. "Preview install" or "Preview
   update" runs `vendor update`. A copy with edits, or a folder that was never vendored, needs "replace
   edited files" (`--force`). The shim's state is shown below it.
2. **The tree's config.** Whether `e2e.config.json` exists, its mode and any problems in it.
   "Preview config" runs `e2e init --mode <mode>`, with `--force` when the file exists. Managed
   mode lets the tool start the server and build worlds; attach mode uses a server you start.
3. **What the tree needs to run.** Its npm dependencies (`node_modules` at the root and in `server/`,
   where their `package.json` lists any) and the reference data
   (the data dir's `solarSystems/data.json`), each with the command that fixes it. The GUI doesn't
   run these; they are the tree's own setup. Also whether the tree's server is up.
4. **Plugins and doctor.** The plugins that apply to the tree and the ones skipped, with the
   reason. "Run e2e doctor" runs the tree's `e2e doctor --json` and shows its report.
5. **Next.** The commands to run once the tree is ready.

## Patches

Each optional patch in the tree's copy with its state, from `e2e patch status --json`: `absent`
(with whether it applies cleanly), `applied`, `detected` (the tree already has equivalent code),
`partial` or `no-target`. An absent patch offers "Preview apply" and an applied one "Preview
revert". [PATCHES.md](PATCHES.md) describes the patches.

## Every change is previewed

Install, update, config, apply and revert all work the same way:

1. The page asks the server for a preview. The server runs the command with `--dry-run` and
   returns the command, the folder it runs in, and the dry run's output: the files a vendor update
   adds, changes and removes; the config `init` would write; the lines a patch inserts or removes,
   with their line endings.
2. The dialog shows it. If the change would be refused, it says why and offers no Run button.
3. Run asks the server to run that same command, without `--dry-run`, by the preview's ID. A preview
   runs once and expires after 10 minutes. The output and exit code replace the preview.

A change is refused when:

- the tree's server is up (a live bridge handshake, or a live `e2e up` run);
- a file it would change has uncommitted changes: `tools/evejs-e2e/` and the shim for a vendor
  update, `e2e.config.json` for config, a patch's targets for an apply. A tree that isn't a git
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
| `GET /gui/api/tree?tree=<id>` | The Install tab's summary. |
| `GET /gui/api/doctor?tree=<id>` | `e2e doctor --json`, parsed. |
| `GET /gui/api/patches?tree=<id>` | `e2e patch status --json`, parsed. |
| `POST /gui/api/preview` `{ "tree": "<id>", "action": "vendor" \| "init" \| "patch-apply" \| "patch-revert", "mode": "managed", "id": "xmpp-port", "force": false }` | The preview: `ok`, `refused`, each step's command and dry-run output, and a `previewID` when `ok`. |
| `POST /gui/api/run` `{ "previewID": "..." }` | Runs the previewed commands; each step's output and exit code. |
| `GET /gui/api/runs?tree=<id>` | The runs and their verdicts. |
| `GET /gui/api/run?tree=<id>&run=<run>` | A run's report, frame names and `result.json`. |
| `GET /gui/api/frame?tree=<id>&run=<run>&file=<name>.svg` | One frame. |

The replay viewer for a run is `/viewer#token=<token>&tree=<id>&run=<run>`.
