# evejs-e2e compatibility report

**green**: 53 checks passed.

| | |
| --- | --- |
| Checkout | d5c6626dec29 |
| Node | v24.19.0 on win32 |
| Started | 2026-10-01T19:24:09.185Z |
| Took | 629 s |
| stock | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked in F:\LU\_compat\evejs-0.12.9 earlier |
| lu | F:\LU\e2e-grid on feat/evejs-e2e-phase7 at 76b78ffe608f |

| Lane | Check | Result | Detail | s |
| --- | --- | --- | --- | --- |
| repo | npm test (no tree) | pass | 228 passed, 0 failed, 6 skipped | 4.5 |
| stock | unpack | pass | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked in F:\LU\_compat\evejs-0.12.9 earlier | 0.1 |
| stock | dependencies | pass | already installed | 0.0 |
| stock | reference data | pass | already built | 0.0 |
| stock | vendor this checkout | pass | vendored evejs-e2e 0.1.0 at d5c6626d (HEAD) from F:/LU/evejs-e2e | 0.3 |
| stock | patches absent | pass | 3 patches absent, each applies cleanly | 0.2 |
| stock | tests against the tree | pass | 198 passed, 0 failed, 36 skipped | 4.3 |
| stock | init (managed) | pass | next: e2e up --fresh (a new world) or e2e up --world <name>, then e2e login | 0.2 |
| stock | doctor (files) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision absent, slash-success absent, xmpp-port absent, plugins none active | 0.7 |
| stock | up --fresh (managed) | pass | up in 16.1s: pid 43576, world fresh, slot 302: game :36040, gateway :36042, agent bridge :36047, market :36048 (rpc :36049), image :36041, redshift :36045, xmpp :36050 | 16.2 |
| stock | login (managed) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.4 |
| stock | grid (managed) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.1 |
| stock | watch (managed) | pass | t+00:00:10 END time: 6 samples, 3 events sample 1.3/1.96 ms, off grid 0/0 ms (avg/max); client 0 updates, decode 0/0.549 ms | 10.2 |
| stock | doctor (live) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision absent, slash-success absent, xmpp-port absent, plugins none active | 0.1 |
| stock | fixtures match a live capture | pass | 49 destiny encodings and the session and grid shape match | 2.6 |
| stock | down (managed) | pass | stopped in 0.5s | 0.6 |
| stock | run smoke-undock (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-192449-smoke-undock/report.md | 37.9 |
| stock | gui: summary, runs, a patch by preview | pass | tree f1fbb5ae93ad: copy matches at d5c6626d, 3 patches absent, 38 runs (report and 1 frame(s) of 20261001-192449-smoke-undock); xmpp-port previewed, applied and reverted byte for byte | 1.0 |
| stock | patch apply (all three) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision applied, slash-success applied, xmpp-port applied, plugins none active | 1.0 |
| stock | up --fresh (patched) | pass | up in 16.1s: pid 26884, world fresh, slot 302: game :36040, gateway :36042, agent bridge :36047, market :36048 (rpc :36049), image :36041, redshift :36045, xmpp :36050 | 16.2 |
| stock | login (patched) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | slash outcomes (patched) | pass | /dock ok, /fit of a missing module refused, /where unreported | 0.9 |
| stock | loadout without the skills refused (patched) | pass | refused with 6 missing skill(s): Drones 5, Gallente Drone Specialization 1, Gallente Frigate 1, Light Drone Operation 5, Small Blaster Specialization 1, Small Hybrid Turret 5 | 0.1 |
| stock | down (patched) | pass | stopped in 0.5s | 0.6 |
| stock | world build starter (patched) | pass | built starter in 18 s (6 MB) in _local/e2e/worlds/starter; boarded Tristan 9988400000118 docked in 60015249 | 18.0 |
| stock | run smoke-undock (patched) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-192605-smoke-undock/report.md | 37.9 |
| stock | run gate-rats (patched) | pass | passed: 5 of 5 expectations met; report _local/e2e/runs/20261001-192643-gate-rats/report.md | 95.9 |
| stock | run concord-highsec (patched) | pass | passed: 6 of 6 expectations met; report _local/e2e/runs/20261001-192819-concord-highsec/report.md | 91.3 |
| stock | run loadout-npc-fight (patched) | pass | passed: 8 of 8 expectations met; report _local/e2e/runs/20261001-192951-loadout-npc-fight/report.md | 45.6 |
| stock | run selftest-unmet (patched) | pass | FAILED: 1 of 2 expectations met, MISSING SYSTEM toSystemName=Jita | 38.5 |
| stock | patch revert (all three), byte-identical | pass | 11 files byte-identical to before apply | 0.6 |
| stock | init (attach) | pass | next: start the server with EVEJS_AGENT_BRIDGE=1 set (`npm start` in the server folder, or StartServer.bat from a shell that has it), then e2e login | 0.2 |
| stock | up refuses (attach) | pass | e2e: `e2e up` needs managed mode; this tree is in attach mode (e2e.config.json). Start the server yourself with EVEJS_AGENT_BRIDGE=1 set, or let the CLI manage it: `e2e init --mode managed --force`. | 0.1 |
| stock | server started by hand (attach) | pass | pid 19784 ready in 34.1s, game :36040, gateway :36042 | 34.1 |
| stock | login (attach) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | undock (attach) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.8 |
| stock | grid (attach) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.2 |
| stock | dock (attach) | pass | Docked at Manifest V - AIR Laboratories Trade Center. | 0.2 |
| stock | run smoke-undock (attach) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-193151-smoke-undock/report.md | 18.8 |
| stock | server stopped (attach) | pass | pid 19784 stopped | 0.5 |
| lu | vendor this checkout | pass | vendored evejs-e2e 0.1.0 at d5c6626d (HEAD) from F:/LU/evejs-e2e | 0.3 |
| lu | doctor (files) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision detected, slash-success detected, xmpp-port detected, plugins lu active | 0.4 |
| lu | tests against the tree | pass | 234 passed, 0 failed, 0 skipped | 4.6 |
| lu | up --world lowsec-docked (managed) | pass | up in 46.7s: pid 41196, world saved lowsec-docked, slot 251: game :35020, gateway :35022, agent bridge :35027, LU bridge :35026, market :35028 (rpc :35029), image :35021, redshift :35025, xmpp :35030 | 48.8 |
| lu | login (managed) | pass | logged in: Agent Observer (140000007) account e2eagent/5, docked in 60004603, system 30002537, ship 9988400013799 | 0.8 |
| lu | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 3.1 |
| lu | grid (managed) | pass | Amamake (0.4)  t+00:00:03  self: Rifter (in space, GOTO)  protected 30s | 0.6 |
| lu | watch (managed) | pass | t+00:00:11 END time: 6 samples, 3 events sample 2.02/4.68 ms, off grid 2.25/3.45 ms over 1717 flights (avg/max); client 0 updates, decode 0/1.048 ms | 11.3 |
| lu | doctor (live) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision detected, slash-success detected, xmpp-port detected, plugins lu active | 0.4 |
| lu | fixtures match a live capture | pass | 49 destiny encodings and the session shape match | 4.6 |
| lu | down (managed) | pass | stopped market daemon pid 35080 | 0.6 |
| lu | run smoke-undock --world lowsec-docked (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-193326-smoke-undock/report.md | 71.6 |

## Notes

- F:\LU\e2e-grid's vendored copy is back as committed
