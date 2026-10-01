"use strict";

// The Living Universe clock in a saved world: the row
// server/src/space/npc/ambientTraffic/livingSimClock.js keeps. Only a world
// restored from _local/e2e/worlds/ carries e2eWorld, and the server refuses to
// warp any other, so dev's world never gets a clock offset. An offset the
// saved world already has is kept: its stored deadlines are in that time.

const fs = require("node:fs");

const SIM_CLOCK_TABLE = "npcRuntimeState";
const SIM_CLOCK_KEY = "livingSimClock";

function openDatabase(file, options = {}) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file, options);
}

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

// core/worlds.js calls these. A save records the world's own time; a restore
// marks the copy so it may be warped, resuming from that time.
const worldHooks = {
  onSave({ world }) {
    return { savedSimNowMs: worldSimNowMs(world) };
  },
  // saved: the saved world's world.json, ext.lu from onSave. Worlds saved
  // before plugins kept savedSimNowMs at the top.
  onRestore({ world, source, name, saved = {}, options = {} }) {
    const mine = saved.ext && saved.ext.lu ? saved.ext.lu : saved;
    const resumeAtSimMs = Number(mine.savedSimNowMs) > 0 ? Number(mine.savedSimNowMs) : worldSimNowMs(source);
    markE2eWorld(world, name, { resumeAtSimMs, realClock: options.realClock === true });
    return options.realClock ? "clock at real time (offset 0), deadlines as overdue as the copy is old" : null;
  },
};

module.exports = {
  markE2eWorld,
  readSimClock,
  worldHooks,
  worldSimNowMs,
};
