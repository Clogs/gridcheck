"use strict";

// A tree's world is its game store (gamestore.sqlite and manifest.json) plus
// its market daemon's database. Everything here copies whole SQLite files with
// VACUUM INTO, which reads a consistent snapshot (WAL included) through a
// read-only connection, so a source world is never written.
//
// Static reference data (the data dir, usually a link into another tree) and
// content-pack state (content-packs beside it, files only) are not part of a
// world and are never touched. Where each lives is the tree's e2e.config.json
// (treeConfig.js).

const fs = require("node:fs");
const path = require("node:path");

const { loadTreeConfig } = require("./treeConfig");

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A scenario's "world": "fresh" boots a new game store, so no saved world may take the name.
const FRESH = "fresh";

function worldPaths(treeRoot) {
  const config = loadTreeConfig(treeRoot);
  return {
    world: config.gameStore,
    manifest: config.manifest,
    market: config.market.database,
    saved: config.worldsDir,
  };
}

function savedWorldDir(treeRoot, name) {
  if (!NAME_PATTERN.test(String(name || ""))) {
    throw new Error(`world names are letters, digits, '.', '_' and '-' (got ${JSON.stringify(name)})`);
  }
  return path.join(worldPaths(treeRoot).saved, name);
}

function removeSqlite(file) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
}

function openDatabase(file, options = {}) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file, options);
}

function snapshotSqlite(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  removeSqlite(destination);
  const db = openDatabase(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function hasOwnerTable(db) {
  return Boolean(db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_persistence_owners'")
    .get());
}

// A copied world still carries its source's owner rows. Left live, this
// tree's server would wait out the source's lease and then refuse the world.
function clearOwnerLeases(file) {
  const db = openDatabase(file);
  try {
    if (!hasOwnerTable(db)) return 0;
    return Number(db.prepare("UPDATE _persistence_owners SET active = 0, lease_expires_at = 0").run().changes);
  } finally {
    db.close();
  }
}

// Owner rows whose lease has not run out: some process is (or just was)
// running this world. The instance ID reads "<role>-supervisor:<pid>:<uuid>".
function liveLeases(file, nowMs = Date.now()) {
  if (!fs.existsSync(file)) return [];
  const db = openDatabase(file, { readOnly: true });
  try {
    if (!hasOwnerTable(db)) return [];
    return db.prepare(
      "SELECT owner_role AS role, instance_id AS instanceID, lease_expires_at AS expiresAtMs " +
      "FROM _persistence_owners WHERE active = 1 AND lease_expires_at > ? ORDER BY owner_role",
    ).all(nowMs).map((row) => {
      const pid = Number(String(row.instanceID || "").split(":")[1]) || null;
      return { role: row.role, instanceID: row.instanceID, pid, expiresAtMs: Number(row.expiresAtMs) };
    });
  } finally {
    db.close();
  }
}

function requireWorld(paths, label) {
  if (!fs.existsSync(paths.world) || !fs.existsSync(paths.manifest)) {
    throw new Error(`${label} has no world (gamestore.sqlite and manifest.json)`);
  }
}

// Give this tree another tree's world, market included.
function copyWorld(treeRoot, fromTree, { force = false } = {}) {
  const here = worldPaths(treeRoot);
  const source = worldPaths(path.resolve(fromTree));
  if (path.resolve(source.world) === path.resolve(here.world)) throw new Error("--from names this tree");
  requireWorld(source, path.resolve(fromTree));
  if (fs.existsSync(here.world) && !force) {
    throw new Error("this tree already has a world; pass --force to replace it");
  }
  snapshotSqlite(source.world, here.world);
  const cleared = clearOwnerLeases(here.world);
  fs.copyFileSync(source.manifest, here.manifest);
  let market = false;
  if (fs.existsSync(source.market)) {
    snapshotSqlite(source.market, here.market);
    market = true;
  }
  return { source: source.world, bytes: fs.statSync(here.world).size, cleared, market };
}

// hooks: the plugins' world hooks (core/plugins.js registry.worldHooks).
//   onSave({ world, name }) -> data kept in world.json at ext.<plugin>
//   onRestore({ world, source, name, saved, options }) -> a note for the user, or null
// `world` is this tree's game store, `source` the saved copy, `saved` the
// saved world.json, `options` the `e2e up` flags the plugins declared.
function runHook(hook, method, ctx) {
  if (typeof hook[method] !== "function") return null;
  try {
    return hook[method](ctx);
  } catch (error) {
    throw new Error(`plugin ${hook.plugin}: world ${method} failed: ${error.message}`);
  }
}

function saveWorld(treeRoot, name, { force = false, note = "", hooks = [] } = {}) {
  const here = worldPaths(treeRoot);
  requireWorld(here, "this tree");
  if (name === FRESH) throw new Error(`"${FRESH}" names a new game store in a scenario; save under another name`);
  const dir = savedWorldDir(treeRoot, name);
  if (fs.existsSync(dir) && !force) throw new Error(`saved world ${name} exists; pass --force to replace it`);
  const ext = {};
  for (const hook of hooks) {
    const data = runHook(hook, "onSave", { world: here.world, name });
    if (data && typeof data === "object") ext[hook.plugin] = data;
  }
  const staging = `${dir}.saving`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  snapshotSqlite(here.world, path.join(staging, "gamestore.sqlite"));
  clearOwnerLeases(path.join(staging, "gamestore.sqlite"));
  fs.copyFileSync(here.manifest, path.join(staging, "manifest.json"));
  const market = fs.existsSync(here.market);
  if (market) snapshotSqlite(here.market, path.join(staging, "market.sqlite"));
  const info = {
    name,
    savedAt: new Date().toISOString(),
    tree: treeRoot,
    market,
    note: String(note || ""),
    ...(Object.keys(ext).length ? { ext } : {}),
  };
  fs.writeFileSync(path.join(staging, "world.json"), `${JSON.stringify(info, null, 2)}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  return { ...info, dir, bytes: dirBytes(dir) };
}

// Replace this tree's world with a saved one. A saved world without a market
// leaves this tree's market as it is.
function restoreWorld(treeRoot, name, { hooks = [], options = {} } = {}) {
  const here = worldPaths(treeRoot);
  const dir = savedWorldDir(treeRoot, name);
  const world = path.join(dir, "gamestore.sqlite");
  if (!fs.existsSync(world) || !fs.existsSync(path.join(dir, "manifest.json"))) {
    const known = listWorlds(treeRoot).map((row) => row.name);
    throw new Error(`no saved world ${name}${known.length ? ` (saved: ${known.join(", ")})` : ""}`);
  }
  fs.mkdirSync(path.dirname(here.world), { recursive: true });
  removeSqlite(here.world);
  fs.copyFileSync(world, here.world);
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8"));
  } catch (_error) {
    // A hand-made folder: the hooks read the copy itself.
  }
  const notes = [];
  for (const hook of hooks) {
    const note = runHook(hook, "onRestore", { world: here.world, source: world, name, saved, options });
    if (note) notes.push(String(note));
  }
  fs.copyFileSync(path.join(dir, "manifest.json"), here.manifest);
  const market = path.join(dir, "market.sqlite");
  const restoredMarket = fs.existsSync(market);
  if (restoredMarket) {
    fs.mkdirSync(path.dirname(here.market), { recursive: true });
    removeSqlite(here.market);
    fs.copyFileSync(market, here.market);
  }
  return { name, market: restoredMarket, notes };
}

// A fresh world: drop the game store and let the next boot seed it from the
// reference data's seed tables, which is what a first StartServer.bat boot
// does after CreateDatabase. CreateDatabase itself is not run: it deletes and
// rewrites _local/gameStore/data, which in a linked tree is another tree's.
function freshWorld(treeRoot) {
  const here = worldPaths(treeRoot);
  if (!fs.existsSync(here.manifest)) {
    throw new Error(`--fresh needs the tree's generated reference data (${here.manifest}); ` +
      "run the tree's database setup first, or copy a world with `e2e world copy --from <tree>`");
  }
  removeSqlite(here.world);
}

function listWorlds(treeRoot) {
  const root = worldPaths(treeRoot).saved;
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NAME_PATTERN.test(entry.name) && !entry.name.endsWith(".saving"))
    .map((entry) => {
      const dir = path.join(root, entry.name);
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8"));
      } catch (_error) {
        // A hand-made folder: list it with what the files say.
      }
      return { name: entry.name, savedAt: info.savedAt || null, market: fs.existsSync(path.join(dir, "market.sqlite")), note: info.note || "", bytes: dirBytes(dir) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function dirBytes(dir) {
  return fs.readdirSync(dir).reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0);
}

module.exports = {
  FRESH,
  clearOwnerLeases,
  copyWorld,
  freshWorld,
  listWorlds,
  liveLeases,
  restoreWorld,
  saveWorld,
  savedWorldDir,
  worldPaths,
};
