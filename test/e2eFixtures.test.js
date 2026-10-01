"use strict";

// The core against what a real stock server sent (test/fixtures/live.json,
// recorded by npm run fixtures:capture): a web gateway session's shape and a
// grid read just after undock. If EveJS changes either, the compatibility
// script's fresh capture stops matching and these are recorded again.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { createDestinyTee, isGatewaySession } = require("../bridge/destiny");
const { createGridWatch } = require("../bridge/watch");
const { parseCondition } = require("../core/conditions");
const { formatGrid } = require("../core/format");
const { emptyRegistry } = require("../core/plugins");
const { compareCaptures, liveSignature } = require("./fixtures/capture");

const LIVE = require(path.join(__dirname, "fixtures", "live.json"));
const REGISTRY = emptyRegistry();

// A session object with the recorded shape: the fields the tee reads, with
// stand-in functions where the server had functions.
function recordedSession() {
  const shape = LIVE.session;
  return {
    clientID: shape.clientID,
    characterID: shape.characterID,
    socket: shape.socket ? (shape.socketWrites ? { write() {}, destroyed: false } : { destroyed: false }) : null,
    sendNotification: shape.sendNotification ? () => undefined : undefined,
    sendSessionChange: shape.sendSessionChange ? () => undefined : undefined,
  };
}

test("the recorded gateway session is one the client view attaches to", () => {
  const session = recordedSession();
  assert.strictEqual(isGatewaySession(session), true, JSON.stringify(LIVE.session));
  const attached = createDestinyTee().attach(session);
  assert.strictEqual(attached.ok, true);
  assert.ok(LIVE.session.keys.includes("sendNotification") && LIVE.session.keys.includes("clientID"));
});

test("the recorded grid reads as a table with its system and the player's ship", () => {
  const text = formatGrid(LIVE.grid, { all: true });
  assert.match(text, new RegExp(`^${LIVE.grid.systemName} `));
  assert.match(text, /\(self\) /);
  assert.match(text, /protected \d+s/);
});

async function watchRecordedGrid() {
  let clock = LIVE.grid.sampledAtMs || 1_000;
  const lines = [];
  const watch = createGridWatch({
    findSession: () => recordedSession(),
    readGrid: () => LIVE.grid,
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  await watch.run({ characterID: LIVE.session.characterID, forMs: 4_000, everyMs: 2_000, offGridEveryMs: 60_000, clientMode: "off" },
    { write: (event) => lines.push(event), closed: () => false });
  return lines;
}

test("a watch over the recorded grid emits the GRID the core scenarios expect", async () => {
  const lines = await watchRecordedGrid();
  const grid = lines.find((event) => event.kind === "GRID");
  assert.ok(grid, lines.map((event) => event.kind).join(" "));
  for (const text of ["GRID", "GRID self.protection.active", `GRID systemName=${LIVE.grid.systemName}`]) {
    assert.strictEqual(parseCondition(text, { registry: REGISTRY }).test(grid), true, text);
  }
});

test("every field a watch emits from the recorded grid can be named in a condition", async () => {
  const lines = await watchRecordedGrid();
  const unnamed = [];
  const isGroup = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  // A bare `self` is the keyword, and a group of fields is named field by field.
  const check = (kind, field, value) => {
    if (field === "self" || (isGroup(value) && !nameable(kind, field))) {
      for (const [sub, inner] of Object.entries(value || {})) check(kind, `${field}.${sub}`, inner);
      return;
    }
    try {
      parseCondition(`${kind} ${field}`, { registry: REGISTRY });
    } catch (error) {
      unnamed.push(`${kind}.${field}: ${error.message}`);
    }
  };
  const nameable = (kind, field) => {
    try {
      parseCondition(`${kind} ${field}`, { registry: REGISTRY });
      return true;
    } catch (error) {
      return !/group of fields/.test(error.message);
    }
  };
  for (const event of lines) {
    if (["START", "END"].includes(event.kind)) continue;
    for (const [key, value] of Object.entries(event)) {
      if (!["kind", "atMs", "t"].includes(key)) check(event.kind, key, value);
    }
  }
  assert.deepStrictEqual(unnamed, []);
});

test("a capture matches by shape: values may change, keys and session checks may not", () => {
  const committed = { live: LIVE };
  const moved = JSON.parse(JSON.stringify(LIVE));
  moved.grid.entities[0].position = { x: 1, y: 2, z: 3 };
  moved.session.clientID += 5;
  assert.deepStrictEqual(compareCaptures(committed, { live: moved }), []);

  const grown = JSON.parse(JSON.stringify(LIVE));
  grown.grid.entities.find((row) => row.isSelf).newField = 1;
  grown.session.socketWrites = true;
  const differences = compareCaptures(committed, { live: grown });
  assert.ok(differences.some((line) => line.startsWith("session: ")), differences.join("\n"));
  assert.ok(differences.some((line) => line.startsWith("grid self: ")), differences.join("\n"));
  assert.deepStrictEqual(compareCaptures(committed, { live: grown }, { sections: ["destiny"] }), []);
  assert.deepStrictEqual(liveSignature(LIVE).session, { gatewayClientID: true, socket: true, socketWrites: false,
    sendNotification: true, sendSessionChange: true });
});
