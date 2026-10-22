"use strict";

// MODULE and CAPACITOR events in the grid differ, their conditions and text,
// and a watch around an anchor entity (no session), each from fakes.

const test = require("node:test");
const assert = require("node:assert");

const { createGridDiffer, createGridWatch } = require("../bridge/watch");
const { effectStatesOf } = require("../bridge/entities");
const { eventFields } = require("../core/conditions");
const { formatTimelineEvent } = require("../core/timeline");
const { parseCondition } = require("../core/conditions");

const SELF = { kind: "ship", itemID: 1, isSelf: true, typeName: "Rifter", name: "Rifter", mode: "STOP",
  distanceMeters: 0, position: { x: 0, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };

function grid(entities, extra = {}) {
  return {
    inSpace: true, solarSystemID: 30002537, systemName: "Amamake", security: 0.4,
    self: { itemID: 1, typeName: "Rifter", mode: "STOP" }, entities: [SELF, ...entities], ...extra,
  };
}

// An effect state as the tree keeps it, and a miner row carrying its effects the way the watch's annotate leaves them.
const effect = (moduleID, extra = {}) => ({ moduleID, typeID: 483, effectName: "miningLaser", startedAtMs: 1000, durationMs: 1000,
  targetID: 50, stopReason: null, ...extra });

function miner(effects, extra = {}) {
  const entity = { activeModuleEffects: new Map(effects.map((state) => [state.moduleID, state])) };
  return {
    kind: "ship", itemID: 2, name: "Miner", typeName: "Venture", isNpc: true, npcEntityType: "npc", mode: "MINING",
    distanceMeters: 5000, position: { x: 5000, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    moduleStates: effectStatesOf(entity, (id) => ({ 483: "Miner I" }[id] || null)), capacitorPct: 80, ...extra,
  };
}
const rock = { kind: "asteroid", itemID: 50, name: "Veldspar" };

const kinds = (events) => events.map((event) => event.kind);
const moduleEvents = (events) => events.filter((event) => event.kind === "MODULE");

test("a module turning on is one MODULE event, with its name, target and the ship's cap", () => {
  const differ = createGridDiffer();
  differ.step(grid([miner([])]), 1000);
  const events = differ.step(grid([miner([effect(7)], { capacitorPct: 76.4 })]), 3000);
  assert.deepStrictEqual(kinds(events), ["MODULE"]);
  const [on] = events;
  assert.deepStrictEqual([on.itemID, on.label, on.moduleID, on.moduleName, on.effectName, on.on, on.restarted],
    [2, "Miner", 7, "Miner I", "miningLaser", true, false]);
  assert.deepStrictEqual([on.targetID, on.capPct, on.reason], [50, 76.4, null]);
});

test("a weapon cycling under one activation says nothing after its first MODULE on", () => {
  const live = effect(7);
  const differ = createGridDiffer();
  differ.step(grid([miner([])]), 1000);
  assert.strictEqual(moduleEvents(differ.step(grid([miner([live])]), 3000)).length, 1);
  // The tree mutates the same object each cycle.
  live.nextCycleAtMs = 9999;
  assert.deepStrictEqual(differ.step(grid([miner([live])]), 5000), []);
  live.nextCycleAtMs = 19999;
  assert.deepStrictEqual(differ.step(grid([miner([live])]), 7000), []);
});

test("off carries the stop reason read from the effect that left the Map", () => {
  const live = effect(7);
  const differ = createGridDiffer();
  differ.step(grid([miner([live])]), 1000);
  live.stopReason = "ammo";
  const [off] = differ.step(grid([miner([])]), 3000);
  assert.deepStrictEqual([off.kind, off.on, off.restarted, off.reason, off.moduleName, off.targetID],
    ["MODULE", false, false, "ammo", "Miner I", 50]);
});

test("a new activation of the same module, between two samples, is restarted", () => {
  const differ = createGridDiffer();
  differ.step(grid([miner([effect(7, { startedAtMs: 1000, stopReason: "cycle" })])]), 1000);
  const again = differ.step(grid([miner([effect(7, { startedAtMs: 2500 })])]), 3000);
  assert.strictEqual(again.length, 1);
  assert.deepStrictEqual([again[0].on, again[0].restarted, again[0].reason], [true, true, "cycle"]);
  const sameStart = effect(7, { startedAtMs: 2500 });
  const replaced = differ.step(grid([miner([sameStart])]), 5000);
  assert.strictEqual(replaced.length, 1, "a new effect object is a new activation even with the same start time");
  assert.strictEqual(replaced[0].restarted, true);
});

test("the first sample, an arrival and a ship with no effects Map give no MODULE events", () => {
  const live = effect(7);
  const differ = createGridDiffer();
  assert.deepStrictEqual(kinds(differ.step(grid([miner([live])]), 1000)), ["GRID", "PRESENT"], "baseline");
  const arrived = differ.step(grid([miner([live]), { ...miner([effect(8)]), itemID: 3, name: "Late" }]), 3000);
  assert.deepStrictEqual(kinds(arrived), ["ARRIVE"]);
  const unknown = createGridDiffer();
  unknown.step(grid([miner([live])]), 1000);
  assert.deepStrictEqual(unknown.step(grid([miner([], { moduleStates: null })]), 3000), [],
    "no effects Map is not 'everything went off'");
});

test("modules: false leaves out MODULE and CAPACITOR", () => {
  const differ = createGridDiffer({ modules: false });
  differ.step(grid([miner([], { capacitorPct: 90 })]), 1000);
  assert.deepStrictEqual(differ.step(grid([miner([effect(7)], { capacitorPct: 3 })]), 3000), []);
});

function capSteps(values) {
  const differ = createGridDiffer();
  const out = [];
  values.forEach((pct, index) => {
    const events = differ.step(grid([miner([], { capacitorPct: pct })]), 1000 + index * 2000).filter((event) => event.kind === "CAPACITOR");
    out.push(events.map((event) => `${event.state}:${event.fromPct}>${event.toPct}`).join(""));
  });
  return out;
}

test("capacitor: a quarter band down, empty, and full again are each reported once", () => {
  assert.deepStrictEqual(capSteps([100, 90, 70, 60, 40, 20, 4, 3, 30, 100]),
    ["", "", "down:90>70", "", "down:60>40", "down:40>20", "empty:20>4", "", "", "full:30>100"]);
});

test("capacitor: a ship hovering on a band edge reports once, and drifting inside a band is not news", () => {
  assert.deepStrictEqual(capSteps([80, 74, 76, 74, 77, 74, 72]), ["", "down:80>74", "", "", "", "", ""]);
});

test("capacitor: full needs a reported drop first, and a ship first seen low gets its full", () => {
  assert.deepStrictEqual(capSteps([100, 99.95, 100]), ["", "", ""]);
  assert.deepStrictEqual(capSteps([40, 100]), ["", "full:40>100"]);
  assert.deepStrictEqual(capSteps([100, 2, 100]), ["", "empty:100>2", "full:2>100"]);
});

test("capacitor: a ship with no reading never reports", () => {
  assert.deepStrictEqual(capSteps([null, null]), ["", ""]);
});

test("MODULE and CAPACITOR are conditions, with the fields the differ emits", () => {
  const fields = eventFields();
  for (const key of ["itemID", "label", "moduleID", "moduleName", "effectName", "on", "restarted", "targetID", "targetLabel", "reason", "capPct"]) {
    assert.ok(key in fields.MODULE, `MODULE.${key}`);
  }
  for (const key of ["itemID", "label", "state", "fromPct", "toPct"]) assert.ok(key in fields.CAPACITOR, `CAPACITOR.${key}`);
  assert.doesNotThrow(() => parseCondition("MODULE on=false reason=ammo capPct<5"));
  assert.doesNotThrow(() => parseCondition("CAPACITOR state=empty"));
  assert.throws(() => parseCondition("MODULE nope=1"), /nope/);
});

test("MODULE and CAPACITOR print as one line each", () => {
  assert.strictEqual(formatTimelineEvent({ t: 4000, kind: "MODULE", label: "Miner", moduleName: "Miner I", on: true, restarted: false,
    targetLabel: "Veldspar", reason: null, capPct: 64.4 }), "t+00:00:04  MODULE    Miner  Miner I on on Veldspar  cap 64%");
  assert.match(formatTimelineEvent({ t: 0, kind: "MODULE", label: "Miner", moduleName: "Miner I", on: false, reason: "ammo", capPct: null }),
    /Miner  Miner I off \(ammo\)$/);
  assert.match(formatTimelineEvent({ t: 0, kind: "MODULE", label: "Miner", effectName: "miningLaser", on: true, restarted: true }), /miningLaser restarted/);
  assert.strictEqual(formatTimelineEvent({ t: 0, kind: "CAPACITOR", label: "Miner", state: "empty", fromPct: 20, toPct: 4 }),
    "t+00:00:00  CAPACITOR Miner cap empty 20 -> 4");
});

// ---------- a watch around an anchor ----------

function anchorGrid(entities, anchorRow = {}) {
  const anchor = { kind: "ship", itemID: 2, anchor: true, isSelf: false, name: "Miner", typeName: "Venture", mode: "MINING",
    distanceMeters: 0, position: { x: 0, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1, ...anchorRow };
  return { inSpace: true, solarSystemID: 30001389, systemName: "Yulai", security: 0.9, rangeMeters: 7_864_320,
    anchor: { itemID: 2, name: "Miner", typeName: "Venture", mode: "MINING", protection: null }, self: null, entities: [anchor, ...entities] };
}

function sink() {
  const lines = [];
  return { lines, write: (event) => lines.push(event), closed: () => false };
}

test("the differ treats the anchor as the focus: no self, a GRID line with the anchor, no PRESENT for it", () => {
  const differ = createGridDiffer();
  const events = differ.step(anchorGrid([{ ...miner([]), itemID: 3, name: "Other", lockedTargetIDs: [2] }]), 1000);
  assert.deepStrictEqual(kinds(events), ["GRID", "PRESENT", "TARGET"]);
  assert.strictEqual(events[0].self, null);
  assert.strictEqual(events[0].anchor.itemID, 2);
  assert.deepStrictEqual(events[1].members.map((member) => member.itemID), [3], "the anchor is not listed as present");
  assert.strictEqual(events[2].targetLabel, "Miner", "a lock on the anchor is named, not called self");
  assert.match(formatTimelineEvent({ ...events[0], t: 0 }), /Yulai \(0\.9\)  anchor: Miner \(MINING\), 2 ball\(s\)\s+within 7,864 km/);
  assert.strictEqual(differ.selfEntry().itemID, 2, "off-grid scans centre on the anchor");
});

test("a watch with at reads the grid around the entity, never looks up a session, and passes plugins characterID null", async () => {
  let clock = 0;
  const asked = [];
  const hookCalls = [];
  const samples = [anchorGrid([]), anchorGrid([{ ...miner([]), itemID: 3, name: "Other" }])];
  let index = 0;
  const watch = createGridWatch({
    findSession: () => { throw new Error("no session lookup in an anchor watch"); },
    readGrid: () => { throw new Error("no session read in an anchor watch"); },
    readGridAt: (id) => { asked.push(id); return samples[Math.min(index++, samples.length - 1)]; },
    hooks: [{ name: "probe", onGrid: { watch: (ctx) => { hookCalls.push(ctx.characterID); return { step: () => [] }; } } }],
    destinyTee: { off: null, attach: () => { throw new Error("no tee in an anchor watch"); } },
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  const out = sink();
  const result = await watch.run({ characterID: 7, at: 2, forMs: 3000, everyMs: 2000, offGridEveryMs: 2000 }, out);
  assert.strictEqual(result.reason, "time");
  assert.deepStrictEqual(asked, [2, 2, 2]);
  assert.deepStrictEqual(hookCalls, [null]);
  assert.deepStrictEqual(kinds(out.lines), ["START", "GRID", "ARRIVE", "END"]);
  assert.strictEqual(out.lines[0].at, 2);
  assert.strictEqual(out.lines[0].characterID, null);
  assert.strictEqual(out.lines[0].clientMode, "off");
  assert.match(out.lines[0].clientOff, /no client session/);
  assert.match(formatTimelineEvent({ ...out.lines[0], t: 0 }), /around 2, 3s/);
});

test("a watch around an entity that goes away ends with anchor-gone and says why", async () => {
  let clock = 0;
  let index = 0;
  const watch = createGridWatch({
    findSession: () => null,
    readGrid: () => null,
    readGridAt: () => (index++ < 1 ? anchorGrid([]) : null),
    explainAnchor: (id) => `No entity ${id} in the 3 loaded scenes.`,
    now: () => clock,
    perfNow: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  const out = sink();
  const result = await watch.run({ at: 2, forMs: 60_000, everyMs: 2000, offGridEveryMs: 2000 }, out);
  assert.strictEqual(result.reason, "anchor-gone");
  const end = out.lines[out.lines.length - 1];
  assert.deepStrictEqual([end.kind, end.reason, end.detail], ["END", "anchor-gone", "No entity 2 in the 3 loaded scenes."]);
  assert.match(formatTimelineEvent({ ...end, t: 2000 }), /anchor-gone \(No entity 2 in the 3 loaded scenes\.\): 1 samples/);
});

test("the watch's annotate hands the differ live effect states unless modules is false", async () => {
  const entity = { activeModuleEffects: new Map([[7, effect(7)]]), lockedTargets: new Map() };
  const seen = [];
  for (const modules of [true, false]) {
    let clock = 0;
    const watch = createGridWatch({
      findSession: () => ({ characterID: 7 }),
      readGrid: (_session, options) => {
        const row = { kind: "ship", itemID: 2, name: "M" };
        options.annotate(row, entity);
        seen.push(row.moduleStates instanceof Map ? [...row.moduleStates.keys()] : null);
        return grid([row]);
      },
      describeType: () => "Miner I",
      now: () => clock, perfNow: () => clock, wait: async (ms) => { clock += ms; },
    });
    await watch.run({ characterID: 7, forMs: 0, everyMs: 1000, offGridEveryMs: 1000, modules }, sink());
  }
  assert.deepStrictEqual(seen, [[7], null]);
});

test("the lu plugin's hooks run with characterID null, as in a watch around an entity", () => {
  const { createLuAnnotate, createLuJoin } = require("../plugins/lu/server/join");
  const { createLuOffGrid } = require("../plugins/lu/server/offGrid");
  const { createLuOnGrid } = require("../plugins/lu/server/onGrid");
  const controller = { lastDecision: "idle", hunterReports: [{ targetCharacterID: 7, observerID: 3 }] };
  const annotate = createLuAnnotate(createLuJoin({ controllerFor: () => controller }));
  const result = annotate({ itemID: 2, livingUniverseFlightID: "f1" }, { row: { isNpc: true }, nowMs: 1000, characterID: null });
  assert.strictEqual(result.ext.flightID, "f1");
  assert.strictEqual(result.hidden, null, "no sightings are matched to a character that isn't there");
  const scanner = createLuOffGrid({ inspect: null }).watch({ characterID: null, startedAtMs: 0 });
  assert.doesNotThrow(() => scanner.scan(30001389, { nowMs: 1000, egoPosition: null, labelFor: () => null }));
  const stepper = createLuOnGrid().watch({ characterID: null, startedAtMs: 0 });
  assert.deepStrictEqual(stepper.step(new Map(), { atMs: 1000, selfID: 0, labelFor: () => null }), []);
});
