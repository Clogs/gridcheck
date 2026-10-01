"use strict";

// Tactical frames for `e2e run` (core/frames.js) and the POS events the
// bridge watch writes for them (agentBridgeWatch positionFrame). The live
// path is in docs/GUIDE.md "Tactical frames".

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildFrames,
  niceLength,
  positionsFor,
  renderFramesSection,
  selectKeyEvents,
  writeFrames,
} = require("../core/frames");
const { POSITIONS, createGridWatch, positionFrame } = require("../bridge/watch");

const SELF_ROW = { kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", mode: "STOP", distanceMeters: 0,
  position: { x: 0, y: 0, z: 0 }, radius: 30 };

function row(itemID, x, z, extra = {}) {
  return { kind: "ship", itemID, name: `Guristas ${itemID}`, typeName: "Worm", isNpc: true, npcEntityType: "npc",
    mode: "ORBIT", targetEntityID: 1, position: { x, y: 0, z }, distanceMeters: Math.hypot(x, z),
    groupKey: "flight:living_flight_4420", posExt: { lu: { family: "pirate" } }, ...extra };
}

function grid(entities) {
  return { inSpace: true, solarSystemID: 30002537, systemName: "Amamake", self: { itemID: 1 }, entities: [SELF_ROW, ...entities] };
}

test("POS keeps self and balls in range, nearest first, and counts the rest", () => {
  const frame = positionFrame(grid([
    row(2, 12_000.4, 0, { lockedTargetIDs: [1] }),
    { kind: "stargate", itemID: 9, name: "Stargate (Auga)", position: { x: 0, y: 0, z: 30_000 }, distanceMeters: 30_000 },
    row(3, 2_000_000, 0),
  ]), { rangeMeters: 1_000_000, maxBalls: 10 });
  assert.strictEqual(frame.kind, "POS");
  assert.strictEqual(frame.selfID, 1);
  assert.deepStrictEqual(frame.balls.map((ball) => ball.id), [1, 2, 9]);
  assert.strictEqual(frame.omitted, 1);
  const npc = frame.balls[1];
  assert.deepStrictEqual([npc.x, npc.label, npc.who, npc.type, npc.mode, npc.target, npc.group, npc.ext],
    [12_000, "Guristas 2", "npc", "Worm", "ORBIT", 1, "flight:living_flight_4420", { lu: { family: "pirate" } }]);
  assert.deepStrictEqual(npc.locks, [1]);
  assert.strictEqual(frame.balls[2].who, undefined, "a celestial has no who");
  assert.strictEqual(positionFrame(grid([row(2, 10, 0), row(3, 20, 0)]), { maxBalls: 2 }).omitted, 1, "the cap counts too");
});

test("a watch asked for positions writes POS after a sample with grid events, and every 10 s", async () => {
  let clock = 0;
  const samples = [grid([]), grid([]), grid([row(2, 5_000, 0)]), grid([row(2, 5_000, 0)])];
  let index = 0;
  const watch = createGridWatch({
    findSession: () => ({ characterID: 7 }),
    readGrid: () => samples[Math.min(index++, samples.length - 1)],
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  const lines = [];
  const out = { write: (event) => lines.push(event), closed: () => false };
  await watch.run({ characterID: 7, forMs: 2_000 * 10, everyMs: 2_000, offGridEveryMs: 60_000, positions: true }, out);
  const pos = lines.filter((event) => event.kind === "POS");
  // t=0 baseline (GRID), t=4 s ARRIVE, then the 10 s heartbeat at t=14 s.
  assert.deepStrictEqual(pos.map((event) => event.t), [0, 4_000, 14_000]);
  assert.strictEqual(POSITIONS.everyMs, 10_000);
  const arrive = lines.find((event) => event.kind === "ARRIVE");
  assert.strictEqual(pos[1].atMs, arrive.atMs, "the frame is the ARRIVE's own sample");
  assert.ok(pos[1].seq > arrive.seq);

  lines.length = 0;
  index = 0;
  await watch.run({ characterID: 7, forMs: 8_000, everyMs: 2_000, offGridEveryMs: 60_000 }, out);
  assert.strictEqual(lines.filter((event) => event.kind === "POS").length, 0, "off unless asked for");
});

const at = (t) => 1_000_000 + t;
function pos(t, balls, extra = {}) {
  return { seq: 1000 + t, t, atMs: at(t), kind: "POS", systemName: "Amamake", selfID: 1, rangeMeters: 1_000_000,
    omitted: 0, balls, ...extra };
}
const SELF = { id: 1, kind: "ship", label: "self", who: "self", type: "Rifter", mode: "STOP", x: 0, y: 0, z: 0 };
const ball = (id, x, z, extra = {}) => ({ id, kind: "ship", label: `Dominations Roamer ${id}`, who: "npc", type: "Dramiel",
  mode: "ORBIT", target: 1, group: "flight:living_flight_1125", ext: { lu: { family: "pirate" } }, x, y: 0, z, ...extra });

function stalkingTimeline() {
  return [
    { seq: 1, t: 0, atMs: at(0), kind: "START" },
    pos(0, [SELF]),
    { seq: 2, t: 2_000, atMs: at(2_000), kind: "ARRIVE", groupKey: "flight:living_flight_1125", count: 2, warpIn: true,
      distanceMeters: 7_536, members: [{ itemID: 2, label: "Dominations Roamer 2" }, { itemID: 3, label: "Dominations Roamer 3" }],
      ext: { lu: { flightID: "living_flight_1125", family: "pirate" } } },
    pos(2_000, [SELF, ball(2, 7_536, 0), ball(3, 8_000, 2_000)]),
    { seq: 3, t: 4_000, atMs: at(4_000), kind: "ARRIVE", groupKey: "flight:living_flight_1125", count: 1, members: [{ itemID: 4 }] },
    { seq: 4, t: 6_000, atMs: at(6_000), kind: "TARGET", sourceID: 2, sourceLabel: "Dominations Roamer 2", targetID: 1,
      targetLabel: "self", locked: true },
    pos(6_000, [SELF, ball(2, 5_000, 0, { locks: [1] }), ball(3, 8_000, 2_000)]),
    { seq: 5, t: 7_000, atMs: at(7_000), kind: "TARGET", sourceID: 3, targetID: 1, targetLabel: "self", locked: true },
    { seq: 6, t: 9_000, atMs: at(9_000), kind: "ARRIVE", groupKey: null, count: 1, members: [{ itemID: 7, label: "CONCORD Police" }] },
    { seq: 7, t: 12_000, atMs: at(12_000), kind: "DESTROYED", itemID: 1, label: "self", self: true, typeName: "Rifter",
      wreckID: 8, wreckLabel: "Minmatar Frigate Wreck" },
    pos(12_000, [{ ...SELF, id: 5, type: "Capsule" }, ball(2, 5_000, 0),
      { id: 8, kind: "wreck", label: "Minmatar Frigate Wreck", x: 0, y: 0, z: 0 }], { selfID: 5 }),
    { source: "runner", t: 13_000, atMs: at(13_000), kind: "STOP", reason: "until", condition: "DESTROYED self", matchedSeq: 7 },
  ];
}

test("key events: first ARRIVE per group, first lock on self, each DESTROYED, the stop merged with its event", () => {
  const { keys, skipped } = selectKeyEvents(stalkingTimeline());
  assert.deepStrictEqual(keys.map((key) => `${key.reason}:${key.event.seq}`), ["arrive:2", "target:4", "arrive:6", "destroyed:7"]);
  assert.ok(keys[3].alsoStop, "the stop matched the DESTROYED, so its frame is that one");
  assert.strictEqual(skipped, 0);

  const timeout = [...stalkingTimeline().slice(0, -1),
    { source: "runner", t: 60_000, atMs: at(60_000), kind: "STOP", reason: "timeout", condition: null, matchedSeq: null }];
  const last = selectKeyEvents(timeout).keys.at(-1);
  assert.deepStrictEqual([last.reason, last.event.kind], ["stop", "STOP"]);

  const many = [];
  for (let i = 0; i < 50; i += 1) many.push({ seq: i, t: i, atMs: i, kind: "ARRIVE", groupKey: `gang:f${i}` });
  many.push({ seq: 99, t: 99, atMs: 99, kind: "DESTROYED", itemID: 1, self: true });
  const capped = selectKeyEvents(many, { maxFrames: 10 });
  assert.strictEqual(capped.keys.length, 10);
  assert.strictEqual(capped.skipped, 41);
  assert.ok(capped.keys.some((key) => key.reason === "destroyed"), "a destruction is never dropped for an arrival");
});

test("a key event uses the sample at or before it, else one shortly after", () => {
  const samples = [pos(2_000, []), pos(6_000, [])];
  assert.strictEqual(positionsFor(samples, at(6_000)).t, 6_000);
  assert.strictEqual(positionsFor(samples, at(5_000)).t, 2_000);
  assert.strictEqual(positionsFor(samples, at(0)).t, 2_000, "2 s later is close enough");
  assert.strictEqual(positionsFor([pos(60_000, [])], at(0)), null);
});

test("frames: an SVG per key event with a scale bar, labels and the event line", () => {
  const { frames, unplaced } = buildFrames(stalkingTimeline());
  assert.deepStrictEqual(frames.map((frame) => frame.file),
    ["01-arrive-living_flight_1125.svg", "02-target-self.svg", "03-arrive-concord-police.svg", "04-destroyed-self.svg"]);
  assert.deepStrictEqual(unplaced, []);
  const lock = frames[1].svg;
  assert.match(lock, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(lock, /<\/svg>\n$/);
  assert.match(lock, /first lock on self/);
  assert.match(lock, /Dominations Roamer 2 -&gt; self \(locked\)/, "the event line, escaped");
  assert.match(lock, /stroke-width="2.6"/, "the lock this frame is about is drawn heavy");
  assert.match(lock, />\d[\d,]* (m|km)<\/text>/, "a scale bar label");
  assert.match(lock, /Top-down: x right, z up/);
  assert.ok(!/NaN|undefined/.test(lock));
  assert.strictEqual(frames[0].halfMeters >= 5_000, true);
  assert.match(frames[3].svg, /destroyed, and the stop condition/);
  assert.match(frames[3].svg, /stop condition met: DESTROYED self/);
  assert.strictEqual(frames[3].stop, true);
});

test("frames: balls beyond the frame point from its edge; a frame with no sample is listed, not drawn", () => {
  const far = [
    pos(0, [SELF, ball(2, 1_000, 0), ball(9, 0, 900_000, { ext: null, who: "npc", group: "flight:living_flight_9" })]),
    { seq: 2, t: 0, atMs: at(0), kind: "ARRIVE", groupKey: "flight:living_flight_1125", members: [{ itemID: 2 }] },
    { seq: 3, t: 90_000, atMs: at(90_000), kind: "DESTROYED", itemID: 2, label: "x", wreckID: 3 },
  ];
  const { frames, unplaced } = buildFrames(far);
  assert.strictEqual(frames.length, 2, "the DESTROYED falls back on the last sample before it");
  assert.match(frames[0].svg, /rotate\(-90\)/, "an arrow pointing up at the ball 900 km north");
  assert.match(frames[0].svg, /900 km/);
  const none = buildFrames([{ seq: 1, t: 0, atMs: at(0), kind: "DESTROYED", itemID: 2, label: "x" }]);
  assert.strictEqual(none.frames.length, 0);
  assert.strictEqual(none.unplaced.length, 1);
  assert.deepStrictEqual(unplaced, []);
});

test("a fight away from self is drawn around the fight, each side its own colour", () => {
  const wing = (id, label, x) => ({ id, kind: "ship", label, who: "npc", type: "Rokh", mode: "ORBIT", x, y: 0, z: 90_000 });
  const timeline = [
    pos(0, [SELF, wing(2, "OTSC Raider", 1_000), wing(3, "UEMD Defender", -1_000),
      { id: 4, kind: "wreck", label: "Gallente Battleship Wreck", x: -1_000, y: 0, z: 90_000 }]),
    { seq: 2, t: 0, atMs: at(0), kind: "DESTROYED", itemID: 5, label: "UEMD Defender", self: false, wreckID: 4 },
  ];
  const [frame] = buildFrames(timeline).frames;
  assert.match(frame.svg, /centred on the event \(90 km from self\)/);
  assert.ok(frame.halfMeters < 20_000, "the frame fits the fight, not the 90 km to self");
  const fills = [...frame.svg.matchAll(/<path d="M[^"]+Z" fill="(#[0-9a-f]{6})"/g)].map((match) => match[1]);
  assert.ok(new Set(fills).size >= 2, "OTSC and UEMD differ");
});

test("writeFrames writes the SVGs and the report section links them and shows the stop", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-frames-"));
  try {
    const summary = writeFrames(dir, stalkingTimeline());
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, "frames")).sort(), summary.frames.map((frame) => frame.file.slice(7)).sort());
    assert.ok(!("svg" in summary.frames[0]));
    const section = renderFramesSection(summary);
    assert.match(section, /^## Tactical frames/);
    assert.match(section, /\| 2 \| t\+00:00:06 \| first lock on self \| `TARGET +Dominations Roamer 2 -> self \(locked\)` \| \[02-target-self\.svg\]\(frames\/02-target-self\.svg\) \|/);
    assert.match(section, /!\[Stop frame: destroyed\]\(frames\/04-destroyed-self\.svg\)/);
    assert.match(renderFramesSection(writeFrames(dir, [{ kind: "START" }])), /recorded no positions/);
    assert.match(renderFramesSection(null), /wrote no timeline/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scale bars are 1, 2 or 5 times a power of ten", () => {
  assert.deepStrictEqual([niceLength(7_400), niceLength(2_100), niceLength(1_000), niceLength(180_000)],
    [5_000, 2_000, 1_000, 100_000]);
});
