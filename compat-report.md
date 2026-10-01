# evejs-e2e compatibility report

**green**: 39 checks passed.

| | |
| --- | --- |
| Checkout | a2204a1cb3d0 |
| Node | v24.19.0 on win32 |
| Started | 2026-10-01T16:53:22.742Z |
| Took | 317 s |
| stock | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked into F:\LU\_compat\evejs-0.12.9 |
| lu | F:\LU\e2e-grid on feat/evejs-e2e-phase4 at c6538033b0b1 |

| Lane | Check | Result | Detail | s |
| --- | --- | --- | --- | --- |
| repo | npm test (no tree) | pass | 195 passed, 0 failed, 5 skipped | 4.5 |
| stock | unpack | pass | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked into F:\LU\_compat\evejs-0.12.9 | 6.6 |
| stock | dependencies | pass | npm ci in server, . | 3.4 |
| stock | reference data | pass | built from F:\LU\main\_local\sde\eve-online-static-data-3396210-jsonl: Manifest: F:\LU\_compat\evejs-0.12.9\_local\gameStore\manifest.json | 7.3 |
| stock | vendor this checkout | pass | vendored evejs-e2e 0.1.0-dev at a2204a1c (HEAD) from F:/LU/evejs-e2e | 0.2 |
| stock | tests against the tree | pass | 164 passed, 0 failed, 36 skipped | 3.2 |
| stock | init (managed) | pass | next: e2e up --fresh (a new world) or e2e up --world <name>, then e2e login | 19.0 |
| stock | doctor (files) | pass | 17 gateway calls allowed, client view on, patches last-decision absent, slash-success unknown, xmpp-port absent, plugins none active | 0.7 |
| stock | up --fresh (managed) | pass | up in 76.4s: pid 41360, world fresh, slot 302: game :36040, gateway :36042, agent bridge :36047, market :36048 (rpc :36049), image :36041, redshift :36045, xmpp :36050 | 76.5 |
| stock | login (managed) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.4 |
| stock | grid (managed) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.1 |
| stock | watch (managed) | pass | t+00:00:10 END time: 6 samples, 3 events sample 1.17/2.18 ms, off grid 0/0 ms (avg/max); client 0 updates, decode 0/0.52 ms | 10.1 |
| stock | doctor (live) | pass | 17 gateway calls allowed, client view on, patches last-decision absent, slash-success unknown, xmpp-port absent, plugins none active | 0.1 |
| stock | fixtures match a live capture | pass | 49 destiny encodings and the session and grid shape match | 2.6 |
| stock | down (managed) | pass | stopped in 0.5s | 0.6 |
| stock | run smoke-undock (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-165538-smoke-undock/report.md | 37.9 |
| stock | init (attach) | pass | next: start the server with EVEJS_AGENT_BRIDGE=1 set (`npm start` in the server folder, or StartServer.bat from a shell that has it), then e2e login | 0.2 |
| stock | up refuses (attach) | pass | e2e: `e2e up` needs managed mode; this tree is in attach mode (e2e.config.json). Start the server yourself with EVEJS_AGENT_BRIDGE=1 set, or let the CLI manage it: `e2e init --mode managed --force`. | 0.1 |
| stock | server started by hand (attach) | pass | pid 39976 ready in 16.1s, game :36040, gateway :36042 | 16.1 |
| stock | login (attach) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | undock (attach) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.4 |
| stock | grid (attach) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.1 |
| stock | dock (attach) | pass | Docked at Manifest V - AIR Laboratories Trade Center. | 0.1 |
| stock | run smoke-undock (attach) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-165633-smoke-undock/report.md | 18.7 |
| stock | server stopped (attach) | pass | pid 39976 stopped | 0.5 |
| lu | vendor this checkout | pass | vendored evejs-e2e 0.1.0-dev at a2204a1c (HEAD) from F:/LU/evejs-e2e | 0.2 |
| lu | init (managed) | pass | next: e2e up --fresh (a new world) or e2e up --world <name>, then e2e login | 0.2 |
| lu | doctor (files) | pass | 17 gateway calls allowed, client view on, patches last-decision detected, slash-success unknown, xmpp-port detected, plugins lu active | 0.4 |
| lu | tests against the tree | pass | 200 passed, 0 failed, 0 skipped | 4.5 |
| lu | up --world lowsec-docked (managed) | pass | up in 23.7s: pid 36360, world saved lowsec-docked, slot 251: game :35020, gateway :35022, agent bridge :35027, LU bridge :35026, market :35028 (rpc :35029), image :35021, redshift :35025, xmpp :35030 | 25.2 |
| lu | login (managed) | pass | logged in: Agent Observer (140000007) account e2eagent/5, docked in 60004603, system 30002537, ship 9988400013799 | 0.3 |
| lu | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 1.3 |
| lu | grid (managed) | pass | Amamake (0.4)  t+00:00:01  self: Rifter (in space, GOTO)  protected 30s | 0.3 |
| lu | watch (managed) | pass | t+00:00:10 END time: 6 samples, 3 events sample 0.97/1.97 ms, off grid 1.21/1.32 ms over 1717 flights (avg/max); client 0 updates, decode 0/0.551 ms | 10.4 |
| lu | doctor (live) | pass | 17 gateway calls allowed, client view on, patches last-decision detected, slash-success unknown, xmpp-port detected, plugins lu active | 0.1 |
| lu | fixtures match a live capture | pass | 49 destiny encodings and the session shape match | 2.9 |
| lu | down (managed) | pass | stopped market daemon pid 32792 | 0.6 |
| lu | run smoke-undock --world lowsec-docked (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-165739-smoke-undock/report.md | 59.9 |

## Notes

- F:\LU\e2e-grid's vendored copy is back as committed
