"use strict";

// evejs-e2e phase 2: per-tree port blocks, the market daemon's generated
// config, and saved worlds. The live boot is checked by
// docs/E2E-GRID-TESTING.md.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ports = require("../core/ports");
const worlds = require("../core/worlds");

test("a tree's port block is stable, below the ephemeral range and overridable", () => {
  const a = ports.portsForTree("F:/LU/e2e-grid", {});
  assert.deepStrictEqual(ports.portsForTree("F:/LU/e2e-grid", {}), a);
  assert.strictEqual(a.game, ports.BLOCK_BASE + a.slot * ports.BLOCK_SIZE);
  assert.strictEqual(a.gatewayTls, a.gateway + 1);
  const top = ports.portsForSlot(ports.SLOT_COUNT - 1);
  assert.ok(Math.max(...Object.keys(ports.OFFSETS).map((name) => top[name])) < 49_152);
  assert.ok(Math.max(...Object.values(ports.OFFSETS)) < ports.BLOCK_SIZE);
  assert.strictEqual(ports.portsForTree("F:/LU/e2e-grid", { EVEJS_E2E_PORT_SLOT: "3" }).game, 30_060);
  assert.throws(() => ports.slotForTree("x", { EVEJS_E2E_PORT_SLOT: "800" }), /0 to 799/);
});

test("the server environment moves every configurable listener onto the block, plugin listeners included", () => {
  const core = {
    EVEJS_SERVER_PORT: "30000",
    EVEJS_IMAGE_SERVER_URL: "http://127.0.0.1:30001/",
    EVEJS_MICROSERVICES_PORT: "30002",
    EVEJS_MICROSERVICES_PUBLIC_URL: "http://127.0.0.1:30002/",
    EVEJS_PROXY_LOOPBACK_CDN_LISTEN_PORT: "30004",
    EVEJS_REDSHIFT_MONITOR_PORT: "30005",
    EVEJS_AGENT_BRIDGE_PORT: "30007",
    EVEJS_MARKET_DAEMON_PORT: "30009",
    EVEJS_XMPP_SERVER_PORT: "30010",
  };
  assert.deepStrictEqual(ports.serverEnvironment(ports.portsForSlot(0)), core);
  const listeners = [
    { name: "luMonitor", offset: 6, env: "EVEJS_LU_MONITOR_BRIDGE_PORT" },
    { name: "clash", offset: 7, env: "TAKEN" },
    { name: "outside", offset: 20, env: "OUTSIDE" },
  ];
  assert.deepStrictEqual(ports.usableListeners(listeners).map((listener) => listener.name), ["luMonitor"],
    "a plugin can't take a core offset or one outside the block");
  const block = ports.portsForSlot(0, listeners);
  assert.strictEqual(block.luMonitor, 30006);
  assert.deepStrictEqual(ports.serverEnvironment(block, listeners), { ...core, EVEJS_LU_MONITOR_BRIDGE_PORT: "30006" });
});

test("the market config keeps the tracked file and swaps ports and database", () => {
  const tracked = [
    "[network]", "port = 40110", "", "[rpc]", "enabled = true", "port = 40111", "",
    "[storage]", 'database_path = "data/generated/market.sqlite"', "", "[logging]", 'log_level = "info"',
  ].join("\r\n");
  const text = ports.marketConfig(tracked, ports.portsForSlot(0), path.join("F:", "t", "market.sqlite"));
  assert.match(text, /\[network\]\nport = 30008\n/);
  assert.match(text, /\[rpc\]\nenabled = true\nport = 30009\n/);
  assert.match(text, /database_path = "F:\/t\/market.sqlite"/);
  assert.match(text, /log_level = "info"/);
  assert.throws(() => ports.marketConfig("[network]\nport = 1\n", ports.portsForSlot(0), "m"), /no \[network\] port/);
});

function makeTree(root, { market = true, lease = null } = {}) {
  const paths = worlds.worldPaths(root);
  fs.mkdirSync(path.dirname(paths.world), { recursive: true });
  const db = new DatabaseSync(paths.world);
  db.exec("CREATE TABLE marker (value TEXT)");
  db.exec("CREATE TABLE _persistence_owners (owner_role TEXT, instance_id TEXT, active INTEGER, lease_expires_at INTEGER)");
  db.prepare("INSERT INTO marker VALUES (?)").run(path.basename(root));
  if (lease) db.prepare("INSERT INTO _persistence_owners VALUES ('world', ?, 1, ?)").run(lease.instanceID, lease.expiresAtMs);
  db.close();
  fs.writeFileSync(paths.manifest, "{}\n");
  if (market) {
    fs.mkdirSync(path.dirname(paths.market), { recursive: true });
    const marketDb = new DatabaseSync(paths.market);
    marketDb.exec(`CREATE TABLE orders (tree TEXT); INSERT INTO orders VALUES ('${path.basename(root)}')`);
    marketDb.close();
  }
  return paths;
}

function readMarker(file, table = "marker") {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { ...db.prepare(`SELECT * FROM ${table}`).get() };
  } finally {
    db.close();
  }
}

test("live leases name their holder; copies and saves clear them", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-worlds-"));
  try {
    const now = 1_000_000;
    const donor = makeTree(path.join(scratch, "donor"), {
      lease: { instanceID: "world-supervisor:4242:abc", expiresAtMs: now + 5000 },
    });
    assert.deepStrictEqual(worlds.liveLeases(donor.world, now), [
      { role: "world", instanceID: "world-supervisor:4242:abc", pid: 4242, expiresAtMs: now + 5000 },
    ]);
    assert.deepStrictEqual(worlds.liveLeases(donor.world, now + 6000), []);

    const here = path.join(scratch, "here");
    const copied = worlds.copyWorld(here, path.join(scratch, "donor"));
    assert.strictEqual(copied.cleared, 1);
    assert.strictEqual(copied.market, true);
    assert.deepStrictEqual(worlds.liveLeases(worlds.worldPaths(here).world, now), []);
    assert.deepStrictEqual(worlds.liveLeases(donor.world, now).length, 1, "the source is left as it was");
    assert.throws(() => worlds.copyWorld(here, path.join(scratch, "donor")), /--force/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("save, list and restore round-trip the world and its market", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-worlds-"));
  try {
    const root = path.join(scratch, "tree");
    const paths = makeTree(root);
    const saved = worlds.saveWorld(root, "lowsec-docked", { note: "Rifter in Amamake" });
    assert.strictEqual(saved.market, true);
    assert.throws(() => worlds.saveWorld(root, "lowsec-docked"), /--force/);
    assert.throws(() => worlds.saveWorld(root, "../escape"), /world names/);

    const db = new DatabaseSync(paths.world);
    db.exec("UPDATE marker SET value = 'changed'");
    db.close();
    fs.writeFileSync(`${paths.world}-wal`, "stale");

    assert.deepStrictEqual(worlds.listWorlds(root).map((row) => [row.name, row.market, row.note]), [
      ["lowsec-docked", true, "Rifter in Amamake"],
    ]);
    const restored = worlds.restoreWorld(root, "lowsec-docked");
    assert.deepStrictEqual(restored.notes, [], "no plugin hooks, no notes");
    assert.strictEqual(fs.existsSync(`${paths.world}-wal`), false);
    assert.deepStrictEqual(readMarker(paths.world), { value: "tree" });
    assert.deepStrictEqual(readMarker(paths.market, "orders"), { tree: "tree" });
    assert.throws(() => worlds.restoreWorld(root, "missing"), /no saved world missing \(saved: lowsec-docked\)/);

    worlds.freshWorld(root);
    assert.strictEqual(fs.existsSync(paths.world), false);
    assert.strictEqual(fs.existsSync(paths.manifest), true, "a fresh world keeps the manifest");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("plugin world hooks keep their data in world.json and see it again on restore", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-worlds-"));
  try {
    const root = path.join(scratch, "tree");
    const paths = makeTree(root, { market: false });
    const seen = [];
    const hooks = [{
      plugin: "demo",
      onSave: ({ world, name }) => ({ world: path.basename(world), name }),
      onRestore: (ctx) => {
        seen.push(ctx);
        return ctx.options.fast ? "restored fast" : null;
      },
    }];
    const saved = worlds.saveWorld(root, "w1", { hooks });
    assert.deepStrictEqual(saved.ext, { demo: { world: "gamestore.sqlite", name: "w1" } });
    const restored = worlds.restoreWorld(root, "w1", { hooks, options: { fast: true } });
    assert.deepStrictEqual(restored.notes, ["restored fast"]);
    assert.strictEqual(seen[0].world, paths.world);
    assert.strictEqual(seen[0].source, path.join(saved.dir, "gamestore.sqlite"));
    assert.deepStrictEqual(seen[0].saved.ext, { demo: { world: "gamestore.sqlite", name: "w1" } });
    const broken = [{ plugin: "bad", onRestore: () => { throw new Error("no table"); } }];
    assert.throws(() => worlds.restoreWorld(root, "w1", { hooks: broken }), /plugin bad: world onRestore failed: no table/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
