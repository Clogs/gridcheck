# evejs-e2e compatibility report

**green**: 52 checks passed.

| | |
| --- | --- |
| Checkout | 1b296e1f4c86 |
| Node | v24.19.0 on win32 |
| Started | 2026-10-01T18:38:56.423Z |
| Took | 671 s |
| stock | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked in F:\LU\_compat\evejs-0.12.9 earlier |
| lu | F:\LU\e2e-grid on feat/evejs-e2e-phase6 at 76b78ffe608f |

| Lane | Check | Result | Detail | s |
| --- | --- | --- | --- | --- |
| repo | npm test (no tree) | pass | 220 passed, 0 failed, 6 skipped | 4.5 |
| stock | unpack | pass | G:\Downloads\EveJS-v0.12.9.zip (sha256 4a1204c73384), unpacked in F:\LU\_compat\evejs-0.12.9 earlier | 0.1 |
| stock | dependencies | pass | already installed | 0.0 |
| stock | reference data | pass | already built | 0.0 |
| stock | vendor this checkout | pass | vendored evejs-e2e 0.1.0-dev at 1b296e1f (HEAD) from F:/LU/evejs-e2e | 0.2 |
| stock | patches absent | pass | 3 patches absent, each applies cleanly | 0.2 |
| stock | tests against the tree | pass | 190 passed, 0 failed, 36 skipped | 4.0 |
| stock | init (managed) | pass | next: e2e up --fresh (a new world) or e2e up --world <name>, then e2e login | 0.2 |
| stock | doctor (files) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision absent, slash-success absent, xmpp-port absent, plugins none active | 0.8 |
| stock | up --fresh (managed) | pass | up in 16.1s: pid 43128, world fresh, slot 302: game :36040, gateway :36042, agent bridge :36047, market :36048 (rpc :36049), image :36041, redshift :36045, xmpp :36050 | 16.2 |
| stock | login (managed) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.1 |
| stock | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.4 |
| stock | grid (managed) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.1 |
| stock | watch (managed) | pass | t+00:00:10 END time: 6 samples, 3 events sample 1.37/2.54 ms, off grid 0/0 ms (avg/max); client 0 updates, decode 0/0.642 ms | 10.1 |
| stock | doctor (live) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision absent, slash-success absent, xmpp-port absent, plugins none active | 0.1 |
| stock | fixtures match a live capture | pass | 49 destiny encodings and the session and grid shape match | 2.8 |
| stock | down (managed) | pass | stopped in 0.5s | 0.6 |
| stock | run smoke-undock (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-183937-smoke-undock/report.md | 46.5 |
| stock | patch apply (all three) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision applied, slash-success applied, xmpp-port applied, plugins none active | 1.0 |
| stock | up --fresh (patched) | pass | up in 16.1s: pid 40040, world fresh, slot 302: game :36040, gateway :36042, agent bridge :36047, market :36048 (rpc :36049), image :36041, redshift :36045, xmpp :36050 | 16.2 |
| stock | login (patched) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.1 |
| stock | slash outcomes (patched) | pass | /dock ok, /fit of a missing module refused, /where unreported | 0.9 |
| stock | loadout without the skills refused (patched) | pass | refused with 6 missing skill(s): Drones 5, Gallente Drone Specialization 1, Gallente Frigate 1, Light Drone Operation 5, Small Blaster Specialization 1, Small Hybrid Turret 5 | 0.1 |
| stock | down (patched) | pass | stopped in 0.5s | 0.6 |
| stock | world build starter (patched) | pass | built starter in 18 s (7 MB) in _local/e2e/worlds/starter; boarded Tristan 9988400000118 docked in 60015249 | 17.9 |
| stock | run smoke-undock (patched) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-184100-smoke-undock/report.md | 37.9 |
| stock | run gate-rats (patched) | pass | passed: 5 of 5 expectations met; report _local/e2e/runs/20261001-184138-gate-rats/report.md | 105.5 |
| stock | run concord-highsec (patched) | pass | passed: 6 of 6 expectations met; report _local/e2e/runs/20261001-184323-concord-highsec/report.md | 93.2 |
| stock | run loadout-npc-fight (patched) | pass | passed: 8 of 8 expectations met; report _local/e2e/runs/20261001-184457-loadout-npc-fight/report.md | 54.8 |
| stock | run selftest-unmet (patched) | pass | FAILED: 1 of 2 expectations met, MISSING SYSTEM toSystemName=Jita | 49.0 |
| stock | patch revert (all three), byte-identical | pass | 11 files byte-identical to before apply | 0.2 |
| stock | init (attach) | pass | next: start the server with EVEJS_AGENT_BRIDGE=1 set (`npm start` in the server folder, or StartServer.bat from a shell that has it), then e2e login | 0.2 |
| stock | up refuses (attach) | pass | e2e: `e2e up` needs managed mode; this tree is in attach mode (e2e.config.json). Start the server yourself with EVEJS_AGENT_BRIDGE=1 set, or let the CLI manage it: `e2e init --mode managed --force`. | 0.1 |
| stock | server started by hand (attach) | pass | pid 18096 ready in 28.1s, game :36040, gateway :36042 | 28.1 |
| stock | login (attach) | pass | logged in: Agent Observer (140000005) account e2eagent/3, docked in 60015249, system 30100032, ship 9988400000114 | 0.2 |
| stock | undock (attach) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 0.5 |
| stock | grid (attach) | pass | Manifest (1.0)  t+00:00:00  self: Ibis (in space, GOTO)  protected 30s | 0.1 |
| stock | dock (attach) | pass | Docked at Manifest V - AIR Laboratories Trade Center. | 0.2 |
| stock | run smoke-undock (attach) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-184710-smoke-undock/report.md | 18.7 |
| stock | server stopped (attach) | pass | pid 18096 stopped | 0.5 |
| lu | vendor this checkout | pass | vendored evejs-e2e 0.1.0-dev at 1b296e1f (HEAD) from F:/LU/evejs-e2e | 0.2 |
| lu | doctor (files) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision detected, slash-success detected, xmpp-port detected, plugins lu active | 0.4 |
| lu | tests against the tree | pass | 226 passed, 0 failed, 0 skipped | 4.5 |
| lu | up --world lowsec-docked (managed) | pass | up in 39.1s: pid 42420, world saved lowsec-docked, slot 251: game :35020, gateway :35022, agent bridge :35027, LU bridge :35026, market :35028 (rpc :35029), image :35021, redshift :35025, xmpp :35030 | 67.2 |
| lu | login (managed) | pass | logged in: Agent Observer (140000007) account e2eagent/5, docked in 60004603, system 30002537, ship 9988400013799 | 0.6 |
| lu | undock (managed) | pass | undocked (OnItemsChanged, OnSessionChanged, OnInvulunOnUndockingUpdated) | 2.1 |
| lu | grid (managed) | pass | Amamake (0.4)  t+00:00:02  self: Rifter (in space, GOTO)  protected 30s | 0.4 |
| lu | watch (managed) | pass | t+00:00:10 END time: 6 samples, 3 events sample 1.86/3.55 ms, off grid 1.84/2.35 ms over 1717 flights (avg/max); client 0 updates, decode 0/0.948 ms | 11.4 |
| lu | doctor (live) | pass | 17 gateway calls allowed, client view on, loadout on, patches last-decision detected, slash-success detected, xmpp-port detected, plugins lu active | 0.3 |
| lu | fixtures match a live capture | pass | 49 destiny encodings and the session shape match | 4.6 |
| lu | down (managed) | pass | stopped market daemon pid 40984 | 0.6 |
| lu | run smoke-undock --world lowsec-docked (managed) | pass | passed: 3 of 3 expectations met; report _local/e2e/runs/20261001-184902-smoke-undock/report.md | 64.8 |

## Notes

- F:\LU\e2e-grid's vendored copy is back as committed
