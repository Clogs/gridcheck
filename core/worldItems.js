"use strict";

// `gridcheck world items`: a read-only listing of what sits in a place, or of
// one item and what's inside it. The query and the answer are the same whether
// the live server's item store answers (GET /items, bridge/items.js) or the
// tree's gamestore.sqlite does (core/worlds.js readItems); each brings a source:
//
//   item(id)             -> the stored item, or null
//   inLocation(id)       -> every item whose locationID is id
//   contentsCounts(ids)  -> Map itemID -> how many items sit directly in it
//   typeName(typeID)     -> the type's name, or null

const { slotOf } = require("./actions");

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
const SHIP_CATEGORY = 6;
const HANGAR_FLAG = 4;
const FIRST_CORP_HANGAR_FLAG = 115;
const LAST_CORP_HANGAR_FLAG = 121;

const USAGE = "give --location <id> or --item <id>; --owner, --flag and --type narrow what it lists";

const toInt = (value) => Math.trunc(Number(value) || 0);

// An ID or count as typed: digits only.
function whole(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : NaN;
  return /^\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN;
}

// raw: { location, owner, flag, type, item, limit }, each a number or a string
// (CLI flags and the route's query string both arrive that way).
// -> { query, problems }
function parseQuery(raw = {}) {
  const problems = [];
  const query = { limit: DEFAULT_LIMIT };
  const present = (key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== "" && raw[key] !== true;
  for (const [key, minimum] of [["location", 1], ["owner", 1], ["item", 1], ["flag", 0], ["limit", 1]]) {
    if (raw[key] === true) problems.push(`--${key} needs a value`);
    if (!present(key)) continue;
    const value = whole(raw[key]);
    if (!(value >= minimum)) problems.push(`${key}: ${minimum ? "a positive" : "a"} whole number, got ${JSON.stringify(raw[key])}`);
    else query[key] = value;
  }
  if (query.limit > MAX_LIMIT) problems.push(`limit: at most ${MAX_LIMIT}`);
  if (raw.type === true) problems.push("--type needs a value");
  if (present("type")) {
    const text = String(raw.type).trim();
    query.type = /^\d+$/.test(text) ? { typeID: Number(text) } : { name: text };
  }
  if (query.item && query.location) problems.push("--item and --location are separate questions; give one");
  else if (!query.item && !query.location) problems.push(USAGE);
  return { query, problems };
}

function describeQuery(query) {
  const parts = [];
  if (query.item) parts.push(`item ${query.item}`);
  if (query.location) parts.push(`location ${query.location}`);
  if (query.owner) parts.push(`owner ${query.owner}`);
  if (query.flag !== undefined) parts.push(`flag ${query.flag}`);
  if (query.type) parts.push(`type ${query.type.typeID || JSON.stringify(query.type.name)}`);
  return parts.join(", ");
}

function toRow(raw, typeName, contents) {
  const singleton = toInt(raw.singleton);
  const stored = typeof raw.itemName === "string" ? raw.itemName.trim() : "";
  return {
    itemID: toInt(raw.itemID),
    typeID: toInt(raw.typeID),
    typeName: typeName || null,
    ownerID: toInt(raw.ownerID),
    locationID: toInt(raw.locationID),
    flagID: toInt(raw.flagID),
    quantity: singleton > 0 ? 1 : Math.max(1, toInt(raw.stacksize) || toInt(raw.quantity)),
    singleton,
    assembled: singleton === 1,
    // Stock stores the type's name when nobody renamed the item.
    name: stored && typeName && stored.toLowerCase() !== typeName.toLowerCase() ? stored : null,
    contents,
  };
}

// -> { ok: true, query, total, truncated, rows[, item] } or { ok: false, error }
function runQuery(source, query) {
  const names = new Map();
  const nameOf = (typeID) => {
    if (!names.has(typeID)) names.set(typeID, source.typeName(typeID) || null);
    return names.get(typeID);
  };
  const wantedName = query.type && query.type.name ? query.type.name.toLowerCase() : null;
  const matches = (raw) => (query.owner === undefined || toInt(raw.ownerID) === query.owner)
    && (query.flag === undefined || toInt(raw.flagID) === query.flag)
    && (!query.type || (wantedName === null
      ? toInt(raw.typeID) === query.type.typeID
      : String(nameOf(toInt(raw.typeID)) || "").toLowerCase() === wantedName));

  let anchor = null;
  let pool;
  if (query.item) {
    anchor = source.item(query.item);
    if (!anchor) return { ok: false, error: `no item ${query.item}` };
    pool = source.inLocation(query.item);
  } else {
    pool = source.inLocation(query.location);
  }
  const found = pool.filter(matches).sort((left, right) => toInt(left.flagID) - toInt(right.flagID)
    || toInt(left.itemID) - toInt(right.itemID));
  const shown = found.slice(0, query.limit);

  // A ship or container shows what it holds; so does anything else that holds something.
  const counts = source.contentsCounts([...shown, ...(anchor ? [anchor] : [])]
    .filter((raw) => toInt(raw.singleton) === 1).map((raw) => toInt(raw.itemID)));
  const row = (raw) => {
    const held = counts.get(toInt(raw.itemID)) || 0;
    return toRow(raw, nameOf(toInt(raw.typeID)), held > 0 || toInt(raw.categoryID) === SHIP_CATEGORY ? held : null);
  };
  return {
    ok: true,
    query,
    total: found.length,
    truncated: found.length > shown.length,
    ...(anchor ? { item: row(anchor) } : {}),
    rows: shown.map(row),
  };
}

function flagLabel(flagID) {
  if (flagID === HANGAR_FLAG) return "hangar";
  if (flagID >= FIRST_CORP_HANGAR_FLAG && flagID <= LAST_CORP_HANGAR_FLAG) return `corp hangar ${flagID - FIRST_CORP_HANGAR_FLAG + 1}`;
  return slotOf(flagID) || "";
}

function formatRow(row) {
  const flag = flagLabel(row.flagID);
  const packing = row.assembled ? "assembled" : row.singleton === 2 ? "copy" : "packaged";
  return [String(row.itemID), `${row.typeName || "?"} (${row.typeID})`, String(row.ownerID), String(row.locationID),
    `${row.flagID}${flag ? ` ${flag}` : ""}`, String(row.quantity), packing, row.name ? JSON.stringify(row.name) : "",
    row.contents === null ? "" : `${row.contents} inside`];
}

function table(rows) {
  const header = ["itemID", "type", "owner", "location", "flag", "qty", "state", "name", "contents"];
  const cells = [header, ...rows.map(formatRow)];
  const widths = header.map((_title, column) => Math.max(...cells.map((line) => line[column].length)));
  return cells.map((line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
}

// reply: runQuery's answer; sourceText: which side answered it.
function formatItemsReply(reply, sourceText) {
  const lines = [`source: ${sourceText}`];
  if (reply.item) {
    lines.push("the item:", ...table([reply.item]).map((line) => `  ${line}`));
    lines.push(reply.rows.length ? `inside it (${reply.truncated ? `${reply.rows.length} of ${reply.total}` : reply.total}):` : "nothing inside it");
  }
  if (reply.rows.length) lines.push(...table(reply.rows).map((line) => (reply.item ? `  ${line}` : line)));
  else if (!reply.item) lines.push(`no items match ${describeQuery(reply.query)}`);
  if (reply.truncated && !reply.item) lines.push(`showing ${reply.rows.length} of ${reply.total}; --limit N shows more`);
  else if (reply.truncated) lines.push(`showing ${reply.rows.length} of ${reply.total} inside; --limit N shows more`);
  return lines.join("\n");
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  describeQuery,
  formatItemsReply,
  parseQuery,
  runQuery,
};
