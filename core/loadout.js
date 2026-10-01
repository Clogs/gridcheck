"use strict";

// A loadout is a ship and what goes in it, by item name:
//
//   { "ship": "Tristan",
//     "modules": ["Light Neutron Blaster II x2", "1MN Afterburner II"],
//     "drones": ["Hobgoblin II x5"],
//     "cargo": ["Antimatter Charge S x400"],
//     "charges": ["Antimatter Charge S"] }
//
// "Name xN" is N of that item. A charge loads a full clip into every fitted
// module that takes it, so it takes no count; spares go in the cargo. The
// bridge's POST /loadout (bridge/loadout.js) builds it; this file only reads
// and describes one, so the CLI, a scenario step and the MCP tool check a
// loadout the same way before anything reaches a server.

const LISTS = Object.freeze(["modules", "drones", "cargo", "charges"]);
const KEYS = Object.freeze(["ship", ...LISTS]);
const MAX_QUANTITY = 1_000_000;
const COUNT = /^(.*?)\s+x(\d+)$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// "Hobgoblin II x5" -> { name: "Hobgoblin II", quantity: 5, counted: true }
function parseEntry(text) {
  const trimmed = String(text === undefined || text === null ? "" : text).trim().replace(/\s+/g, " ");
  const match = COUNT.exec(trimmed);
  if (!match) return { name: trimmed, quantity: 1, counted: false };
  return { name: match[1].trim(), quantity: Number(match[2]), counted: true };
}

// A comma-separated list as typed on the command line.
function splitList(text) {
  if (text === undefined || text === null || text === true) return [];
  return String(text).split(",").map((part) => part.trim()).filter(Boolean);
}

// raw -> { loadout, problems }. The loadout keeps one entry per name, its
// quantities added up, in the order first named.
function normalizeLoadout(raw) {
  const problems = [];
  if (!isObject(raw)) return { loadout: null, problems: ["a loadout is an object: { ship, modules, drones, cargo, charges }"] };
  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) problems.push(`${key}: unknown key; a loadout has ${KEYS.join(", ")}`);
  }
  const ship = typeof raw.ship === "string" ? parseEntry(raw.ship) : null;
  if (!ship || !ship.name) problems.push("ship: the hull's item name, e.g. \"Tristan\"");
  else if (ship.counted) problems.push("ship: one hull; leave out the count");
  const loadout = { ship: ship ? ship.name : "" };
  for (const key of LISTS) {
    const value = raw[key] === undefined ? [] : typeof raw[key] === "string" ? [raw[key]] : raw[key];
    if (!Array.isArray(value)) {
      problems.push(`${key}: a list of item names, e.g. ["Hobgoblin II x5"]`);
      loadout[key] = [];
      continue;
    }
    const byName = new Map();
    value.forEach((item, index) => {
      if (typeof item !== "string") {
        problems.push(`${key}[${index}]: an item name, with " xN" for more than one`);
        return;
      }
      const entry = parseEntry(item);
      if (!entry.name) problems.push(`${key}[${index}]: an item name`);
      else if (key === "charges" && entry.counted) {
        problems.push(`${key}[${index}]: a charge fills every module that takes it; put spares in cargo instead of "x${entry.quantity}"`);
      } else if (!(entry.quantity >= 1 && entry.quantity <= MAX_QUANTITY)) {
        problems.push(`${key}[${index}]: a count from 1 through ${MAX_QUANTITY}`);
      } else {
        const known = byName.get(entry.name.toLowerCase());
        if (known) known.quantity += entry.quantity;
        else byName.set(entry.name.toLowerCase(), { name: entry.name, quantity: entry.quantity });
      }
    });
    loadout[key] = [...byName.values()];
  }
  return { loadout: problems.length ? null : loadout, problems };
}

// The loadout back as the JSON a step or POST /loadout takes.
function loadoutBody(loadout) {
  const entry = ({ name, quantity }) => (quantity > 1 ? `${name} x${quantity}` : name);
  const body = { ship: loadout.ship };
  for (const key of LISTS) if (loadout[key].length) body[key] = loadout[key].map(entry);
  return body;
}

function describeLoadout(loadout) {
  const count = (list) => list.reduce((sum, entry) => sum + entry.quantity, 0);
  const parts = [];
  if (loadout.modules.length) parts.push(`${count(loadout.modules)} module(s)`);
  if (loadout.drones.length) parts.push(`${count(loadout.drones)} drone(s)`);
  if (loadout.charges.length) parts.push(`${loadout.charges.map((entry) => entry.name).join(", ")} loaded`);
  if (loadout.cargo.length) parts.push(`${loadout.cargo.length} cargo stack(s)`);
  return `loadout ${loadout.ship}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

// What the bridge answered, as the CLI prints it.
function formatLoadoutReply(reply) {
  const lines = [];
  if (reply.ok) {
    lines.push(`boarded ${reply.ship.name} ${reply.ship.itemID} ${reply.docked ? `docked in ${reply.locationID}` : `in space, system ${reply.systemID}`}` +
      `${reply.replacedShipID ? `; the old ship ${reply.replacedShipID} was removed` : ""}`);
    for (const module of reply.modules || []) {
      lines.push(`  ${String(module.slot || "slot").padEnd(5)} ${module.name}${module.charge ? ` (${module.charge.name} x${module.charge.quantity})` : ""}`);
    }
    for (const drone of reply.drones || []) lines.push(`  drone ${drone.name} x${drone.quantity}`);
    for (const stack of reply.cargo || []) lines.push(`  cargo ${stack.name} x${stack.quantity}`);
    lines.push(`  skills: ${reply.skillsChecked} requirement(s) checked, all met`);
    return lines.join("\n");
  }
  lines.push(`refused: ${reply.error}`);
  for (const name of reply.unknown || []) {
    lines.push(`  unknown ${name.list === "ship" ? "ship" : name.list.replace(/s$/, "")} "${name.name}"` +
      `${name.why ? `: ${name.why}` : ""}${name.suggestions && name.suggestions.length ? ` (did you mean ${name.suggestions.join("; ")}?)` : ""}`);
  }
  for (const skill of reply.missingSkills || []) {
    lines.push(`  missing ${skill.name} ${skill.level} (has ${skill.has}) for ${skill.for.join(", ")}`);
  }
  if (reply.done && reply.done.length) lines.push(`  done before it stopped: ${reply.done.join("; ")}`);
  return lines.join("\n");
}

module.exports = {
  KEYS,
  LISTS,
  describeLoadout,
  formatLoadoutReply,
  loadoutBody,
  normalizeLoadout,
  parseEntry,
  splitList,
};
