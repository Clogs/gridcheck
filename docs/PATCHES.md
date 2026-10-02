# Optional stock patches

Stock EveJS lacks three things the tool can use. Each is an optional patch in `patches/`. The tool
works without them, with less.

| Patch | What it adds | Without it |
| --- | --- | --- |
| `xmpp-port` | `EVEJS_XMPP_SERVER_PORT` moves the XMPP chat listener | Two trees both want port 5222, so only one server runs at a time |
| `last-decision` | each NPC controller records the branch its last think took | grid rows carry no `decision`, and a watch reports no `DECISION` events |
| `slash-success` | the slash commands the tool drives say whether they refused | `gridcheck slash` can't tell a refusal from a success, and says so |

The LU fork has its own code for all three, so `gridcheck doctor` and `gridcheck patch status` show them there
as `detected`, and apply refuses them.

## Commands

```
node tools/gridcheck/bin/gridcheck.js patch list                  # each patch, its files and hunks
node tools/gridcheck/bin/gridcheck.js patch status [<id>]         # applied, detected, absent; whether apply would work
node tools/gridcheck/bin/gridcheck.js patch apply <id>... [--dry-run]
node tools/gridcheck/bin/gridcheck.js patch revert <id>... [--dry-run]
```

`--dry-run` prints each insertion: the file and line, the line it goes beside, the line ending it
will use, and the lines themselves. It writes nothing.

Apply refuses when:

- an anchor is missing, or occurs more than once;
- the patch is applied already, partly applied, or the tree has equivalent code without the marker;
- a target file has uncommitted changes. In a tree that isn't a git checkout, such as an unpacked
  zip, this can't be checked, and apply says so;
- the tree's server is up. The tool sees a server through its bridge handshake or `gridcheck up`'s
  record, so a server started with `EVEJS_AGENT_BRIDGE=0`, or before the tree had a
  `gridcheck.config.json`, isn't seen.

A refusal writes nothing. A patch that changes several files writes all of them or none.

After a change, the tool probes the tree's listeners again and rewrites the `listeners` in
`gridcheck.config.json` when one changed. That happens with `xmpp-port`, which makes the chat listener
movable.

## How a patch is written

A patch only inserts lines. Each hunk names the lines it goes beside, which must already be in the
file, once:

```js
{
  file: "edge/chat/chatEdgeRuntime.js",          // relative to server/src
  anchor: ["const address = Object.freeze({"],   // consecutive lines, compared trimmed
  insert: "before",                              // or "after"
  at: 0,                                         // which anchor line; default first (before) or last (after)
  lines: ["  if (...) {", "  }"],                // inserted as written
}
```

- **Marker.** Every hunk is written as a marker line, `// gridcheck:patch <id> v<n>`, followed by
  its lines. `doctor` reads a patch as applied by its markers, and as partial when only some are in
  place.
- **Line endings.** Each inserted line ends as its anchor line does, so a file that mixes CRLF and
  LF keeps both.
- **Revert.** Revert removes the marked lines, then applies the patch again to what's left. If that
  doesn't give the current file back byte for byte, revert refuses. That happens when someone edited
  an inserted line, or when the copy of the tool has a newer version of the patch than the one
  applied. An edit elsewhere in the file survives a revert.
- **`detect`.** A patch's `detect({ read })` recognises equivalent code that has no marker, as in
  the LU fork.
- **What it's for.** `headline`, `gain` and `without` are for the GUI's Patches tab: what the
  patch gets you in a few words, what you get with it, and what happens without it. Text in
  backticks shows as code. `patch status --json` passes them on, with the patch's `files` and its
  number of `hunks`.
- **Encoding.** A file that isn't UTF-8 is refused, because it couldn't be written back exactly.

## The patches

### `xmpp-port`

The patch adds one hunk in `edge/chat/chatEdgeRuntime.js`. When the caller passes no port and
`EVEJS_XMPP_SERVER_PORT` is set, the runtime's `options.port` takes the variable. The chat worker
binds whatever port the runtime hands it. `gridcheck up` sets the variable to the tree's own port, so with
the patch on both, two stock trees run at once.

### `last-decision`

The patch adds nine hunks in `space/npc/npcBehaviorLoop.js`, one for each way out of
`tickController`. They use the names the LU fork uses for the same branches:

| Decision | When |
| --- | --- |
| `order-stop` | a manual stop order |
| `order-return-home` | a manual return-home order |
| `assist` | no target, but the NPC is keeping assistance modules on |
| `drifter-travel` | no target, and a drifter is pursuing or regrouping |
| `idle-anchor-warp` | no target, warping back to its idle anchor |
| `idle-anchor-orbit` or `idle-return-home` | no target, orbiting its anchor, or heading home |
| `order-hold` | a manual attack, orbit or follow whose target is gone |
| `leash-return` | beyond its leash, heading home |
| `engage` | a target, so it moves, locks and fires |

The early return for a ship that has gone records nothing. Each think writes one string to the
controller. The run that measured this cost is in the plan's run log.

### `slash-success`

Stock's slash commands answer `{ handled, message }` and never say whether they did what was asked.
Every caller in stock ignores `success`. Without the patch, `gridcheck slash` reports `done (unconfirmed)`
and exits 0. The bridge's `/slash` reports `success: null`.

The patch doesn't convert every refusal in stock. That would take hundreds of hunks. It covers the
commands the tool, its scenarios and its loadouts drive: `/tr`, `/dock`, `/heal`, `/npc`,
`/concord`, `/npcclear`, `/gaterats`, `/naughty`, `/allskills`, `/giveskill`, `/fit` and `/unfit`.
It changes three places:

- **`commandReplies.js`** gains `reportsOutcome(options)` and `doneOptions(options)`. They mark a
  copy of the options a command answers with. When the options are marked, `handledResult` adds
  `success`.
- **The dispatcher in `chatCommands.js`** marks the commands above as reporting their outcome.
- **The handlers.** One `options = doneOptions(options)` goes before each way a handler succeeds,
  and every other way out reads as refused. `/dock` counts "already docked" as success. `/naughty`
  counts only an offence that was applied.

Every other command still answers with no `success`.

The survey behind the list found that no stock command reports success when it refused, because
none reports anything. It also found 37 dispatch sites in `chatCommands.js` that call a helper
returning `success`, then pass on only its message.
