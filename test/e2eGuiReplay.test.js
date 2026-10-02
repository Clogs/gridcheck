"use strict";

// The GUI's replay model (gui/replay.js), which the Runs tab draws from: a
// timeline read in chunks, the trace view's lanes and spans, hit points and
// divergences at a moment, and result.json refs placed on the timeline.

const test = require("node:test");
const assert = require("node:assert");

const R = require("../gui/replay");

const SELF = 100;
const RAT1 = 201;
const RAT2 = 202;
const ball = (id, kind, label, extra = {}) => ({ id, kind, label, x: 0, y: 0, z: 0, ...extra });

// A 20 s fight: self orbits rat 1, kills it, then turns on rat 2; three drones
// follow self's target; the client diverges on self's mode at 10 s.
function timeline() {
  const pos = (t, selfMode, selfTarget, drones, withRat1 = true) => ({
    seq: 1000 + t, kind: "POS", atMs: 1000 + t * 1000, systemID: 1, selfID: SELF, balls: [
      ball(SELF, "ship", "self", { who: "self", type: "Tristan", mode: selfMode, target: selfTarget, x: t * 100 }),
      ...(withRat1 ? [ball(RAT1, "ship", "Blood Raider", { who: "npc", mode: "ORBIT", target: SELF })] : []),
      ball(RAT2, "ship", "Blood Raider", { who: "npc", mode: "ORBIT", target: SELF }),
      ...[301, 302, 303].map((id, i) => ball(id, "drone", "Hobgoblin II", { target: drones[i] })),
      ball(400, "station", "A station"),
    ],
  });
  return [
    { seq: 1, kind: "START", atMs: 1000, clientMode: "fx" },
    pos(0, "STOP", null, [null, null, null]),
    // Written out of order: the model sorts samples by time.
    pos(4, "ORBIT", RAT1, [RAT1, RAT1, null]),
    pos(2, "STOP", null, [RAT1, null, null]),
    { seq: 2, kind: "MODE", atMs: 3000, itemID: SELF, label: "self", from: "STOP", to: "ORBIT", targetID: RAT1, targetLabel: "Blood Raider" },
    { seq: 3, kind: "TARGET", atMs: 3500, sourceID: SELF, sourceLabel: "self", targetID: RAT1, targetLabel: "Blood Raider", locked: true },
    { seq: 4, kind: "FX", atMs: 4000, itemID: String(SELF), label: "self", guid: "effects.ProjectileFired", targetID: String(RAT1), offensive: true },
    { seq: 5, kind: "DAMAGE", atMs: 5000, itemID: RAT1, label: "Blood Raider", layer: "shield", fromPct: 100, toPct: 40 },
    { seq: 6, kind: "DAMAGE", atMs: 6000, itemID: RAT1, label: "Blood Raider", layer: "armor", fromPct: 100, toPct: 0 },
    { seq: 7, kind: "DESTROYED", atMs: 8000, itemID: RAT1, label: "Blood Raider", who: "npc" },
    pos(8, "ORBIT", RAT2, [RAT2, RAT2, RAT2], false),
    { seq: 8, kind: "DIVERGE", atMs: 11000, source: "client", status: "open", reason: "mode", itemID: String(SELF), label: "self", serverMode: "STOP", clientMode: "ORBIT" },
    { kind: "LOG", atMs: 11200, text: "[Combat] near the divergence" },
    { seq: 9, kind: "DIVERGE", atMs: 14000, source: "client", status: "cleared", reason: "mode", itemID: String(SELF), label: "self" },
    { seq: 10, kind: "SIGHTING", atMs: 15000, family: "pirate" },
    pos(20, "ORBIT", RAT2, [RAT2, RAT2, RAT2], false),
    { source: "runner", kind: "STOP", atMs: 21000, reason: "until", condition: "DESTROYED itemID=$mark" },
  ].map((line) => JSON.stringify(line));
}

function model(chunks = 1) {
  const lines = timeline();
  const m = R.createModel();
  const size = Math.ceil(lines.length / chunks);
  for (let i = 0; i < lines.length; i += size) {
    const text = `${lines.slice(i, i + size).join("\n")}\n`;
    // The plugin's kind comes with the plugin's own text, by line index.
    const index = lines.slice(i, i + size).findIndex((line) => line.includes("SIGHTING"));
    m.ingest(text, index >= 0 ? [[index, "pirate fleet sighted"]] : []);
  }
  return m;
}

test("it reads a timeline in chunks: events apart from samples, samples sorted, counts and times", () => {
  for (const chunks of [1, 3, 7]) {
    const m = model(chunks);
    assert.strictEqual(m.t0, 1000);
    assert.strictEqual(m.tEnd, 21000);
    assert.strictEqual(m.selfID, SELF);
    assert.deepStrictEqual(m.positions.map((pos) => pos.atMs), [1000, 3000, 5000, 9000, 21000]);
    assert.ok(m.events.every((event) => event.kind !== "POS"));
    assert.strictEqual(m.counts.get("DIVERGE"), 2);
    assert.strictEqual(m.counts.has("START"), false);
    assert.strictEqual(m.label(RAT2), "Blood Raider");
    assert.strictEqual(m.label(SELF), "self");
    const sighting = m.events.find((event) => event.kind === "SIGHTING");
    assert.strictEqual(R.summary(sighting), "pirate fleet sighted");
  }
});

test("a ship's lane takes its modes from the samples and MODE events; duplicates are numbered; a kill ends the lane", () => {
  const { lanes, hidden } = model(3).lanes();
  assert.strictEqual(hidden, 0);
  assert.deepStrictEqual(lanes.map((lane) => lane.name), ["self", "Blood Raider #1", "Blood Raider #2", "Hobgoblin II × 3"]);
  const self = lanes[0];
  assert.ok(self.self);
  assert.deepStrictEqual(self.spans.map((span) => [span.text, span.start, span.end]),
    [["STOP", 1000, 3000], ["ORBIT Blood Raider #1", 3000, 9000], ["ORBIT Blood Raider #2", 9000, 21000]]);
  assert.deepStrictEqual(self.marks.map((mark) => mark.kind), ["TARGET", "FX", "DIVERGE", "DIVERGE"]);
  const rat1 = lanes[1];
  assert.strictEqual(rat1.destroyedAt, 8000);
  assert.strictEqual(rat1.end, 8000);
  assert.deepStrictEqual(rat1.marks.map((mark) => mark.kind), ["DAMAGE", "DAMAGE", "DESTROYED"]);
  assert.strictEqual(lanes[2].end, 21000, "a ball in the last sample lasts to the end");
});

test("a swarm of drones is one lane doing what most of them do", () => {
  const swarm = model().lanes().lanes.find((lane) => lane.kind === "drone");
  assert.deepStrictEqual(swarm.ids, [301, 302, 303]);
  assert.deepStrictEqual(swarm.spans.map((span) => [span.text, span.start]),
    [["idle", 1000], ["→ Blood Raider #1", 5000], ["→ Blood Raider #2", 9000]]);
});

test("lanes past the cap are counted, not drawn", () => {
  const capped = model().lanes({ maxLanes: 2 });
  assert.strictEqual(capped.lanes.length, 2);
  assert.strictEqual(capped.hidden, 2);
  assert.strictEqual(capped.lanes[0].name, "self");
});

test("hit points at a moment: the last DAMAGE before it, the first one's start after it, or unknown", () => {
  const m = model();
  assert.deepStrictEqual(m.hpAt(RAT1, 4000), { shield: 100, armor: 100, hull: null });
  assert.deepStrictEqual(m.hpAt(RAT1, 5500), { shield: 40, armor: 100, hull: null });
  assert.deepStrictEqual(m.hpAt(RAT1, 7000), { shield: 40, armor: 0, hull: null });
  assert.deepStrictEqual(m.hpAt(SELF, 7000), { shield: null, armor: null, hull: null });
});

test("divergences open at a moment, and the ones ahead", () => {
  const m = model();
  const before = m.divergenceAt(5000);
  assert.deepStrictEqual(before.open, []);
  assert.deepStrictEqual(before.ahead.map((event) => event.status), ["open", "cleared"]);
  assert.deepStrictEqual(m.divergenceAt(12000).open.map((event) => [event.reason, event.serverMode, event.clientMode]), [["mode", "STOP", "ORBIT"]]);
  assert.deepStrictEqual(m.divergenceAt(15000).open, []);
  const near = m.logNear(11000, 500);
  assert.deepStrictEqual(near.rows.map((event) => event.text), ["[Combat] near the divergence"]);
});

test("result.json refs land on the timeline by seq, else by t from the watch's start", () => {
  const m = model();
  assert.strictEqual(m.timeOf({ seq: 7, t: 999_999, kind: "DESTROYED" }), 8000);
  assert.strictEqual(m.timeOf({ t: 2500 }, 1000), 3500);
  assert.strictEqual(m.timeOf({ t: 2500 }), 3500, "without a watch start it counts from the first event");
  assert.strictEqual(m.timeOf(null), null);
  assert.strictEqual(m.timeOf({ seq: 77 }), null);
});

test("the grid at a moment glides between samples and knows each ball's speed", () => {
  const m = model();
  const frame = m.frameAt(2000);
  assert.strictEqual(frame.pos.atMs, 1000);
  assert.strictEqual(frame.balls.find((b) => b.id === SELF).x, 100);
  assert.strictEqual(Math.round(frame.velocity.get(SELF).speed), 100);
  assert.strictEqual(m.frameAt(0).pos.atMs, 1000, "just before the first sample shows it");
  assert.strictEqual(R.createModel().frameAt(0), null);
});

test("the grid at a moment is worked out once per moment, and again after new samples", () => {
  const m = model();
  const first = m.frameAt(2000);
  assert.strictEqual(m.frameAt(2000), first, "the map and the inspector share one frame");
  m.ingest(`${JSON.stringify({ kind: "POS", atMs: 1500, systemID: 1, selfID: SELF, balls: [ball(SELF, "ship", "self", { x: 999 })] })}\n`, []);
  assert.notStrictEqual(m.frameAt(2000), first);
  assert.strictEqual(m.frameAt(2000).pos.atMs, 1500);
});

test("a live view plays behind the newest data by about one sample gap", () => {
  const sampled = (gaps, systemID = () => 1) => {
    const m = R.createModel();
    let at = 1000;
    const lines = [{ kind: "POS", atMs: at, systemID: systemID(0), selfID: SELF, balls: [] }];
    gaps.forEach((gap, i) => {
      at += gap;
      lines.push({ kind: "POS", atMs: at, systemID: systemID(i + 1), selfID: SELF, balls: [] });
    });
    m.ingest(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, []);
    return m;
  };
  assert.strictEqual(R.createModel().liveDelayMs(), R.LIVE_DELAY.defaultMs, "no samples yet");
  assert.strictEqual(sampled([2000, 2000, 2000]).liveDelayMs(), 2000 + R.LIVE_DELAY.slackMs);
  assert.strictEqual(sampled([10_000, 10_000, 2000, 2000, 2000, 2000, 10_000]).liveDelayMs(), 2000 + R.LIVE_DELAY.slackMs,
    "the median of the last five gaps, so one quiet stretch doesn't push it back");
  assert.strictEqual(sampled([10_000, 10_000, 10_000]).liveDelayMs(), 10_000 + R.LIVE_DELAY.slackMs, "a quiet grid samples every 10 s");
  assert.strictEqual(sampled([500, 500]).liveDelayMs(), R.LIVE_DELAY.minMs);
  assert.strictEqual(sampled([60_000]).liveDelayMs(), R.LIVE_DELAY.maxMs);
  assert.strictEqual(sampled([2000, 9000], (i) => (i < 2 ? 1 : 2)).liveDelayMs(), 2000 + R.LIVE_DELAY.slackMs,
    "a jump to another system isn't a gap between samples");
});

test("a live view plays at least as far behind as data arrives late, so it doesn't catch up and stall", () => {
  const m = R.createModel();
  let at = 1000;
  const batch = (gaps) => `${gaps.map((gap) => JSON.stringify({ kind: "POS", atMs: (at += gap), systemID: 1, selfID: SELF, balls: [] })).join("\n")}\n`;
  m.noteArrival(5000);
  m.ingest(batch([0, 1000, 1000]), []);
  assert.strictEqual(m.liveDelayMs(), R.LIVE_DELAY.minMs, "the first batch says nothing about arrivals");
  m.noteArrival(at + 4200);
  m.ingest(batch([1000, 1000, 1000, 1000]), []);
  assert.strictEqual(m.liveDelayMs(), 4200 + R.LIVE_DELAY.slackMs, "1 s samples arriving in 4 s batches");
  m.noteArrival(at + 3000);
  assert.strictEqual(m.liveDelayMs(), 4200 + R.LIVE_DELAY.slackMs, "the worst of the last few arrivals sets it");
  m.noteArrival(at + 60_000);
  assert.strictEqual(m.liveDelayMs(), R.LIVE_DELAY.maxMs);
  m.ingest(batch([65_000]), []);
  m.noteArrival(at + 2000);
  assert.strictEqual(m.liveDelayMs(), R.LIVE_DELAY.maxMs, "a late batch holds the delay up for a while, so it doesn't bob");
  m.ingest(batch([R.LIVE_DELAY.arrivalWindowMs]), []);
  m.noteArrival(at + 2000);
  assert.strictEqual(m.liveDelayMs(), 2000 + R.LIVE_DELAY.slackMs, "then drops out");
});

test("following live eases toward the live point instead of freezing or skipping", () => {
  assert.strictEqual(R.liveRate(0), 1, "on the live point: real time");
  assert.ok(R.liveRate(-1500) < 1 && R.liveRate(-1500) >= R.LIVE_DELAY.minRate, "ahead of it: slower, never stopped");
  assert.ok(R.liveRate(1500) > 1 && R.liveRate(1500) <= R.LIVE_DELAY.maxRate, "behind it: faster");
  assert.strictEqual(R.liveRate(-60_000), R.LIVE_DELAY.minRate);
  assert.strictEqual(R.liveRate(60_000), R.LIVE_DELAY.maxRate);
});

test("auto zoom moves in steps, up at once and down only with room to spare", () => {
  assert.strictEqual(R.autoHalf(0), 5000);
  assert.strictEqual(R.autoHalf(26_000), 30_000);
  assert.strictEqual(R.autoHalf(31_000, 30_000), 40_000, "up as soon as a ship needs it");
  assert.strictEqual(R.autoHalf(29_000, 40_000), 40_000, "not down for a ship hovering at the edge");
  assert.strictEqual(R.autoHalf(25_000, 40_000), 30_000, "down once the step below has room");
  assert.strictEqual(R.autoHalf(1200, 40_000), 5000, "straight down to what fits");
  assert.strictEqual(R.autoHalf(9e9), R.AUTO_HALVES[R.AUTO_HALVES.length - 1]);
  assert.strictEqual(R.autoHalf(26_000, 12_345), 30_000, "a zoom that isn't a step is ignored");
});

test("text helpers", () => {
  assert.strictEqual(R.offset(3_725_000), "t+01:02:05");
  assert.strictEqual(R.offsetFine(7120), "t+00:00:07.120");
  assert.strictEqual(R.clockShort(65_000), "01:05");
  assert.strictEqual(R.seconds(46_000), "46 s");
  assert.strictEqual(R.seconds(71_000), "1 min 11 s");
  assert.strictEqual(R.kindClass("KILLMAIL"), "k-destroyed");
  assert.strictEqual(R.kindClass("SIGHTING"), "k-log");
  assert.strictEqual(R.niceStep(28_000, 14), 2000);
  assert.strictEqual(R.axisLabel(14_000, 2000), "14s");
});
