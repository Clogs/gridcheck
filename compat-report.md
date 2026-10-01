# evejs-e2e compatibility report

**green**: 45 checks passed.

| | |
| --- | --- |
| Checkout | 6dd928569a6a |
| Node | v24.19.0 on win32 |
| Started | 2026-10-01T17:35:02.174Z |
| Took | 258 s |
| stock | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked in F:\LU\_compat\evejs-0.12.9 earlier |
| lu | F:\LU\e2e-grid on feat/evejs-e2e-phase5 at b745a693cf99 |

| Lane | Check | Result | Detail | s |
| --- | --- | --- | --- | --- |
| repo | npm test (no tree) | pass | 205 passed, 0 failed, 6 skipped | 4.5 |
| stock | unpack | pass | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked in F:\LU\_compat\evejs-0.12.9 earlier | 0.1 |
| stock | dependencies | pass | already installed | 0.0 |
| stock | reference data | pass | already built | 0.0 |
| stock | vendor this checkout | pass | vendored evejs-e2e 0.1.0-dev at 6dd92856 (HEAD) from F:/LU/evejs-e2e | 0.3 |
| stock | tests against the tree | pass | 175 passed, 0 failed, 36 skipped | 3.5 |
| stock | init (managed) | pass | next: e2e up --fresh (a new world) or e2e up --world <name>, then e2e login | 0.2 |
| stock | patches absent | pass | 3 patches absent, each applies cleanly | 0.1 |
| stock | doctor (files) | pass | 17 gateway calls allowed, client view on, patches last-decision absent, slash-success absent, xmpp-port absent, plugins none active | 0.7 |
| stock | up --fresh (managed) | pass | up in 16.1s: pid 5060, world fresh, slot 302: game :36040, gateway :36042, agent bridge :36047, market :36048 (rpc :36049), image :36041, redshift :36045, xmpp :36050 | 16.2 |
| stock | login (managed) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.4 |
| stock | grid (managed) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.1 |
| stock | watch (managed) | pass | t+00:00:10 END time: 6 samples, 3 events sample 1.09/2.02 ms, off grid 0/0 ms (avg/max); client 0 updates, decode 0/0.548 ms | 10.1 |
| stock | doctor (live) | pass | 17 gateway calls allowed, client view on, patches last-decision absent, slash-success absent, xmpp-port absent, plugins none active | 0.1 |
| stock | fixtures match a live capture | pass | 49 destiny encodings and the session and grid shape match | 2.7 |
| stock | down (managed) | pass | stopped in 0.5s | 0.6 |
| stock | run smoke-undock (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-173542-smoke-undock/report.md | 37.9 |
| stock | patch apply (all three) | pass | 17 gateway calls allowed, client view on, patches last-decision applied, slash-success applied, xmpp-port applied, plugins none active | 1.0 |
| stock | up --fresh (patched) | pass | up in 16.1s: pid 22372, world fresh, slot 302: game :36040, gateway :36042, agent bridge :36047, market :36048 (rpc :36049), image :36041, redshift :36045, xmpp :36050 | 16.2 |
| stock | login (patched) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | slash outcomes (patched) | pass | /dock ok, /fit of a missing module refused, /where unreported | 0.9 |
| stock | down (patched) | pass | stopped in 0.5s | 0.6 |
| stock | patch revert (all three), byte-identical | pass | 11 files byte-identical to before apply | 0.2 |
| stock | init (attach) | pass | next: start the server with EVEJS_AGENT_BRIDGE=1 set (`npm start` in the server folder, or StartServer.bat from a shell that has it), then e2e login | 0.2 |
| stock | up refuses (attach) | pass | e2e: `e2e up` needs managed mode; this tree is in attach mode (e2e.config.json). Start the server yourself with EVEJS_AGENT_BRIDGE=1 set, or let the CLI manage it: `e2e init --mode managed --force`. | 0.1 |
| stock | server started by hand (attach) | pass | pid 12200 ready in 16.1s, game :36040, gateway :36042 | 16.1 |
| stock | login (attach) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | undock (attach) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.4 |
| stock | grid (attach) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.1 |
| stock | dock (attach) | pass | Docked at Manifest V - AIR Laboratories Trade Center. | 0.1 |
| stock | run smoke-undock (attach) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-173656-smoke-undock/report.md | 18.7 |
| stock | server stopped (attach) | pass | pid 12200 stopped | 0.5 |
| lu | vendor this checkout | pass | vendored evejs-e2e 0.1.0-dev at 6dd92856 (HEAD) from F:/LU/evejs-e2e | 0.2 |
| lu | doctor (files) | pass | 17 gateway calls allowed, client view on, patches last-decision detected, slash-success detected, xmpp-port detected, plugins lu active | 0.4 |
| lu | tests against the tree | pass | 211 passed, 0 failed, 0 skipped | 4.5 |
| lu | up --world lowsec-docked (managed) | pass | up in 21.1s: pid 16648, world saved lowsec-docked, slot 251: game :35020, gateway :35022, agent bridge :35027, LU bridge :35026, market :35028 (rpc :35029), image :35021, redshift :35025, xmpp :35030 | 22.6 |
| lu | login (managed) | pass | logged in: Agent Observer (140000007) account e2eagent/5, docked in 60004603, system 30002537, ship 9988400013799 | 3.3 |
| lu | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 1.2 |
| lu | grid (managed) | pass | Amamake (0.4)  t+00:00:01  self: Rifter (in space, GOTO)  protected 30s | 0.2 |
| lu | watch (managed) | pass | t+00:00:11 END time: 6 samples, 3 events sample 1.01/2.11 ms, off grid 1/1.33 ms over 1717 flights (avg/max); client 0 updates, decode 0/0.471 ms | 11.8 |
| lu | doctor (live) | pass | 17 gateway calls allowed, client view on, patches last-decision detected, slash-success detected, xmpp-port detected, plugins lu active | 2.5 |
| lu | fixtures match a live capture | pass | 49 destiny encodings and the session shape match | 3.5 |
| lu | down (managed) | pass | stopped market daemon pid 14080 | 13.2 |
| lu | run smoke-undock --world lowsec-docked (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-173818-smoke-undock/report.md | 61.0 |

## Notes

- F:\LU\e2e-grid's vendored copy is back as committed
