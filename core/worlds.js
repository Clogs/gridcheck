"use strict";

// A tree's world is its game store (gamestore.sqlite and manifest.json) plus
// its market daemon's database. Everything here copies whole SQLite files with
// VACUUM INTO, which reads a consistent snapshot (WAL included) through a
// read-only connection, so a source world is never written.
//
// Static reference data (_local/gameStore/data, usually a link into another
// tree) and content-pack state (_local/gameStore/content-packs, files only)
// are not part of a world and are never touched.

const fs = require("node:fs");
const path = require("node:path");

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function worldPaths(treeRoot) {
  const store = path.join(treeRoot, "_local", "gameStore");
  return {
    world: path.join(store, "gamestore.sqlite"),
    manifest: path.join(store, "manifest.json"),
    market: path.join(treeRoot, "externalservices", "market-server", "data", "generated", "market.sqlite"),
    saved: path.join(treeRoot, "_local", "e2e", "worlds"),
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

function saveWorld(treeRoot, name, { force = false, note = "" } = {}) {
  const here = worldPaths(treeRoot);
  requireWorld(here, "this tree");
  const dir = savedWorldDir(treeRoot, name);
  if (fs.existsSync(dir) && !force) throw new Error(`saved world ${name} exists; pass --force to replace it`);
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
    savedSimNowMs: worldSimNowMs(here.world),
    tree: treeRoot,
    market,
    note: String(note || ""),
  };
  fs.writeFileSync(path.join(staging, "world.json"), `${JSON.stringify(info, null, 2)}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  return { ...info, dir, bytes: dirBytes(dir) };
}

// The Living Universe clock's row (server/src/space/npc/ambientTraffic/livingSimClock.js).
// Only a world restored from _local/e2e/worlds/ carries e2eWorld, and the server
// refuses to warp any other, so dev's world never gets a clock offset. An offset
// the saved world already has is kept: its stored deadlines are in that time.
const SIM_CLOCK_TABLE = "npcRuntimeState";
const SIM_CLOCK_KEY = "livingSimClock";

function readSimClockRow(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(SIM_CLOCK_TABLE);
  if (!exists) return { exists: false, row: null };
  const found = db.prepare(`SELECT json FROM "${SIM_CLOCK_TABLE}" WHERE key = ?`).get(SIM_CLOCK_KEY);
  let row = null;
  try {
    row = found ? JSON.parse(found.json) : null;
  } catch (_error) {
    row = null;
  }
  return { exists: true, row };
}

// The Living Universe time a stopped world had reached: its last write, which is
// the shutdown flush, on its own clock.
function worldSimNowMs(file) {
  let lastWriteMs = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      lastWriteMs = Math.max(lastWriteMs, fs.statSync(`${file}${suffix}`).mtimeMs);
    } catch (_error) {
      // No WAL beside a snapshot.
    }
  }
  if (!lastWriteMs) return 0;
  const row = readSimClock(file);
  const offsetMs = row && Number.isFinite(Number(row.offsetMs)) ? Number(row.offsetMs) : 0;
  return Math.round(lastWriteMs + offsetMs);
}

// realClock: the clock runs at real time from this boot, offset 0, so on-grid and
// Living Universe times agree; stored deadlines come back as overdue as the copy is old.
function markE2eWorld(file, savedWorld, { resumeAtSimMs = 0, realClock = false } = {}) {
  const db = openDatabase(file);
  try {
    const { exists, row } = readSimClockRow(db);
    if (!exists) return null;
    const next = {
      offsetMs: 0,
      ...(row && typeof row === "object" ? row : {}),
      e2eWorld: true,
      savedWorld: String(savedWorld || ""),
      markedAtMs: Date.now(),
      resumeAtSimMs: !realClock && Number(resumeAtSimMs) > 0 ? Math.round(Number(resumeAtSimMs)) : null,
      ...(realClock ? { offsetMs: 0 } : {}),
    };
    db.prepare(`INSERT INTO "${SIM_CLOCK_TABLE}" (key, json) VALUES (?, ?) ` +
      "ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(SIM_CLOCK_KEY, JSON.stringify(next));
    return next;
  } finally {
    db.close();
  }
}

// What a world file says about its clock, read only.
function readSimClock(file) {
  if (!fs.existsSync(file)) return null;
  const db = openDatabase(file, { readOnly: true });
  try {
    return readSimClockRow(db).row;
  } finally {
    db.close();
  }
}

// Replace this tree's world with a saved one. A saved world without a market
// leaves this tree's market as it is.
function restoreWorld(treeRoot, name, { realClock = false } = {}) {
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
  let info = {};
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8"));
  } catch (_error) {
    // A hand-made folder: resume from the copy's own time.
  }
  const resumeAtSimMs = Number(info.savedSimNowMs) > 0 ? Number(info.savedSimNowMs) : worldSimNowMs(world);
  markE2eWorld(here.world, name, { resumeAtSimMs, realClock });
  fs.copyFileSync(path.join(dir, "manifest.json"), here.manifest);
  const market = path.join(dir, "market.sqlite");
  const restoredMarket = fs.existsSync(market);
  if (restoredMarket) {
    fs.mkdirSync(path.dirname(here.market), { recursive: true });
    removeSqlite(here.market);
    fs.copyFileSync(market, here.market);
  }
  return { name, market: restoredMarket };
}

// A fresh world: drop the game store and let the next boot seed it from the
// reference data's seed tables, which is what a first StartServer.bat boot
// does after CreateDatabase. CreateDatabase itself is not run: it deletes and
// rewrites _local/gameStore/data, which in a linked tree is another tree's.
function freshWorld(treeRoot) {
  const here = worldPaths(treeRoot);
  if (!fs.existsSync(here.manifest)) {
    throw new Error("--fresh needs this tree's manifest.json; copy a world once with `e2e world copy --from ../dev`");
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
  clearOwnerLeases,
  copyWorld,
  freshWorld,
  listWorlds,
  liveLeases,
  markE2eWorld,
  readSimClock,
  worldSimNowMs,
  restoreWorld,
  saveWorld,
  savedWorldDir,
  worldPaths,
};
