"use strict";

// The tree's destiny encoders, recorded. The destiny tests build every
// payload through these, as they would through the tree's own modules:
//
//   npm test                    replays test/fixtures/destiny.json; no tree
//   GRIDCHECK_FIXTURES=record   calls the real encoders of GRIDCHECK_TREE and
//                               writes each result to GRIDCHECK_FIXTURES_OUT
//                               when the process exits
//
// `npm run fixtures:capture` records this way, and the compatibility script
// does too and fails when the recording differs from the committed file:
// that is the tree's wire layout changing under the decoder.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DESTINY_FIXTURE = path.join(__dirname, "destiny.json");

// JSON with what payloads carry and JSON can't: bigints, bytes, undefined,
// odd numbers and Maps. Keys are sorted, so a recording diffs cleanly.
function tag(value) {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === undefined) return { $undefined: true };
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) return { $number: String(Object.is(value, -0) ? "-0" : value) };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("hex") };
  if (value instanceof Map) return { $map: [...value.entries()].map(([key, entry]) => [tag(key), tag(entry)]) };
  if (Array.isArray(value)) return value.map(tag);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = tag(value[key]);
    return out;
  }
  return value;
}

function untag(value) {
  if (Array.isArray(value)) return value.map(untag);
  if (value && typeof value === "object") {
    if (typeof value.$bigint === "string") return BigInt(value.$bigint);
    if (value.$undefined === true) return undefined;
    if (typeof value.$number === "string") return value.$number === "-0" ? -0 : Number(value.$number);
    if (typeof value.$bytes === "string") return Buffer.from(value.$bytes, "hex");
    if (Array.isArray(value.$map)) return new Map(value.$map.map(([key, entry]) => [untag(key), untag(entry)]));
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = untag(entry);
    return out;
  }
  return value;
}

function keyFor(call, args) {
  return `${call}:${crypto.createHash("sha256").update(JSON.stringify(tag(args))).digest("hex").slice(0, 20)}`;
}

// The calls the destiny tests make, each run against the tree's modules.
// load(relativePath) -> a module under the tree's server/src.
function liveCalls(load) {
  const statePayloads = load("space/destiny/stream/statePayloads");
  const actions = load("space/destiny/stream/actions");
  const packagedAction = load("space/destiny/batching/packagedAction");
  const marshal = load("network/tcp/utils/marshal");
  const { buildDict, buildKeyVal } = load("services/_shared/serviceHelpers");
  const slimDeps = {
    buildSlimItemDict: (entity) => buildKeyVal([["itemID", entity.itemID], ["typeID", entity.typeID || 0]]),
  };
  const setStateDeps = {
    buildSlimItemObject: (entity) => buildKeyVal([["itemID", entity.itemID], ["typeID", entity.typeID || 0]]),
    buildDroneState: () => buildDict([]),
    buildSolItem: () => buildKeyVal([]),
    hasDamageableHealth: (entity) => entity.kind === "ship",
    buildDamageState: () => [[{ type: "real", value: 1 }, { type: "real", value: 1 }, { type: "long", value: 1n }],
      { type: "real", value: 1 }, { type: "real", value: 1 }],
  };
  return {
    ballState: (stamp, entities) => statePayloads.buildAddBallsStateBuffer(stamp, entities),
    destinyUpdate: (...payloads) => statePayloads.buildDestinyUpdatePayload(payloads.map((payload) => ({ stamp: 100, payload }))),
    setState: (entities, ego = 1) => statePayloads.buildDestinyUpdatePayload([{ stamp: 100,
      payload: statePayloads.buildSetStatePayload(100, { itemID: 30002537 }, ego, entities, 132000000000000000n, [], [], setStateDeps) }]),
    addBalls: (entities) => statePayloads.buildDestinyUpdatePayload([{ stamp: 100,
      payload: statePayloads.buildAddBalls2Payload(100, entities, 132000000000000000n, slimDeps) }]),
    action: (name, ...args) => {
      if (typeof actions[name] !== "function") throw new Error(`the tree's destiny actions have no ${name}`);
      return actions[name](...args);
    },
    packaged: (pairs) => packagedAction.buildPackagedActionPayload(pairs),
    marshalDecode: (bytes) => marshal.marshalDecodeExact(bytes),
  };
}

function readRecording(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

// -> the encoder calls, recorded or replayed per GRIDCHECK_FIXTURES.
function encoders({ env = process.env, fixture = DESTINY_FIXTURE } = {}) {
  const recording = String(env.GRIDCHECK_FIXTURES || "").trim() === "record";
  const names = ["ballState", "destinyUpdate", "setState", "addBalls", "action", "packaged", "marshalDecode"];
  if (recording) {
    const tree = String(env.GRIDCHECK_TREE || "").trim();
    const out = String(env.GRIDCHECK_FIXTURES_OUT || "").trim() || fixture;
    if (!tree) throw new Error("GRIDCHECK_FIXTURES=record needs GRIDCHECK_TREE");
    const live = liveCalls((relativePath) => require(path.join(path.resolve(tree), "server", "src", relativePath)));
    const recorded = {};
    process.once("exit", () => {
      const pkg = readRecording(path.join(path.resolve(tree), "server", "package.json")) || {};
      const sorted = Object.fromEntries(Object.keys(recorded).sort().map((key) => [key, recorded[key]]));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify({ evejs: pkg.version || null, encodings: sorted }, null, 2)}\n`);
    });
    return Object.fromEntries(names.map((call) => [call, (...args) => {
      // Keyed before the call, as the replay keys it, in case an encoder changes its arguments.
      const key = keyFor(call, args);
      const result = live[call](...args);
      recorded[key] = { call, result: tag(result) };
      return result;
    }]));
  }
  const saved = readRecording(fixture);
  const table = saved && saved.encodings ? saved.encodings : {};
  return Object.fromEntries(names.map((call) => [call, (...args) => {
    const hit = table[keyFor(call, args)];
    if (!hit) {
      throw new Error(`no recorded ${call} for these arguments in ${path.basename(fixture)}; ` +
        "record it from a tree: npm run fixtures:capture -- --tree <path>");
    }
    return untag(hit.result);
  }]));
}

module.exports = { DESTINY_FIXTURE, encoders, keyFor, tag, untag };
