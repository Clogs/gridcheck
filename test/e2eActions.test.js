"use strict";

// Player actions for `e2e act` and scenario steps (core/actions.js):
// picking a target and modules, and the gateway calls each action makes, with
// the gateway faked. The live path is in docs/E2E-GRID-TESTING.md "Player actions".

const test = require("node:test");
const assert = require("node:assert");

const {
  actionFromArgs,
  parseTargetSpec,
  pickModules,
  pickTarget,
  runAction,
  shipItems,
} = require("../core/actions");

// Grid rows as /grid?ext=1 answers: the lu plugin's join at ext.lu and its group key.
const lu = (flightID, family) => ({ groupKey: `flight:${flightID}`, ext: { lu: { flightID, family } } });
const ROWS = [
  { itemID: 1, kind: "ship", isSelf: true, name: "Rifter", typeName: "Rifter", distanceMeters: 0, characterID: 9 },
  { itemID: 60004603, kind: "station", name: "Yrmori V - Bureau", typeName: "Trade Post", distanceMeters: 12_000 },
  { itemID: 77, kind: "ship", isNpc: true, name: "Minmatar Patrol 1917", typeName: "Rifter", distanceMeters: 1_800,
    ...lu("living_flight_0630", "police") },
  { itemID: 78, kind: "ship", isNpc: true, name: "Minmatar Patrol 1916", typeName: "Slasher", distanceMeters: 3_000,
    ...lu("living_flight_0630", "police") },
  { itemID: 90, kind: "ship", isNpc: true, name: "Guristas Scout", typeName: "Worm", distanceMeters: 900,
    ...lu("living_flight_1100", "pirate") },
  { itemID: 5, kind: "ship", name: "Other Pilot", typeName: "Merlin", distanceMeters: 50_000, characterID: 7 },
];

test("a target is the nearest ball that passes every term, never self", () => {
  assert.strictEqual(pickTarget(ROWS, "nearest npc").itemID, 90);
  assert.strictEqual(pickTarget(ROWS, "npc family=police").itemID, 77);
  assert.strictEqual(pickTarget(ROWS, "type~slasher").itemID, 78);
  assert.strictEqual(pickTarget(ROWS, "name~\"Patrol 1916\"").itemID, 78);
  assert.strictEqual(pickTarget(ROWS, "kind=station").itemID, 60004603);
  assert.strictEqual(pickTarget(ROWS, "player").itemID, 5);
  assert.strictEqual(pickTarget(ROWS, "78").itemID, 78);
  assert.strictEqual(pickTarget(ROWS, "flight=living_flight_0630").itemID, 77);
  assert.throws(() => pickTarget(ROWS, "npc within=500m"), /no ball on grid matches "npc within=500m"; nearest: /);
  assert.throws(() => pickTarget(ROWS, "1"), /no ball on grid matches/, "self is never a target");
});

test("a $name target matches a bound ball or a bound group; a plugin's terms match its own data", () => {
  assert.strictEqual(pickTarget(ROWS, "$police", { police: ["living_flight_0630", "owner-1"] }).itemID, 77);
  assert.strictEqual(pickTarget(ROWS, "$mark", { mark: ["78"] }).itemID, 78);
  assert.strictEqual(pickTarget(ROWS, "flight=$police", { police: ["living_flight_0630"] }).itemID, 77);
  assert.throws(() => pickTarget(ROWS, "flight=$mark", { mark: ["78"] }), /no ball on grid matches/, "flight= takes flights only");
  assert.throws(() => pickTarget(ROWS, "$later", {}), /\$later is not bound yet/);
  assert.deepStrictEqual(parseTargetSpec("flight=$police npc").bindings, ["police"]);
  for (const [spec, message] of [["", /a target is/], ["colour=red", /unknown field "colour"/], ["within=far", /within=<distance>/],
    ["name=$x", /only .*flight=\$name take a binding/], ["~x", /can't read "~x"/]]) {
    assert.throws(() => parseTargetSpec(spec), message, spec);
  }
  const { emptyRegistry } = require("../core/plugins");
  assert.throws(() => parseTargetSpec("family=police", emptyRegistry()), /unknown field "family"; use name, type, kind, within/,
    "without the plugin its terms are unknown");
  assert.strictEqual(pickTarget(ROWS, "$x", { x: ["78"] }, emptyRegistry()).itemID, 78);
});

const LISTED = { type: "list", items: [
  { type: "packedrow", fields: { itemID: 11, typeID: 2046, flagID: 11, stacksize: 1, groupID: 60, categoryID: 7 } },
  { type: "packedrow", fields: { itemID: 12, typeID: 439, flagID: 19, stacksize: 1 } },
  { type: "packedrow", fields: { itemID: 13, typeID: 486, flagID: 27, stacksize: 1 } },
  { type: "packedrow", fields: { itemID: 14, typeID: 486, flagID: 28, stacksize: 1 } },
  { type: "packedrow", fields: { itemID: 15, typeID: 3640, flagID: 29, stacksize: 1 } },
  { type: "packedrow", fields: { itemID: 16, typeID: 185, flagID: 5, stacksize: 1000 } },
  { type: "packedrow", fields: { itemID: 17, typeID: 2486, flagID: 87, stacksize: 5 } },
  [1, 27, 185],
] };
const TYPES = new Map([
  [2046, { name: "Damage Control I", groupName: "Damage Control" }],
  [439, { name: "1MN Afterburner I", groupName: "Propulsion Module" }],
  [486, { name: "200mm AutoCannon I", groupName: "Projectile Weapon" }],
  [3640, { name: "Small Energy Neutralizer I", groupName: "Energy Neutralizer" }],
  [185, { name: "EMP S", groupName: "Projectile Ammo" }],
  [2486, { name: "Warrior I", groupName: "Combat Drone" }],
]);
const ITEMS = shipItems(LISTED, (typeID) => TYPES.get(typeID));

test("the ship's listing becomes slots, cargo and drone bay, and modules are picked by role, slot or name", () => {
  assert.deepStrictEqual(ITEMS.map((item) => [item.itemID, item.slot, item.quantity]),
    [[11, "low", 1], [12, "mid", 1], [13, "high", 1], [14, "high", 1], [15, "high", 1], [16, "cargo", 1000], [17, "drone", 5]],
    "a loaded charge's tuple row is not an item");
  assert.deepStrictEqual(pickModules(ITEMS, "weapons").map((item) => item.itemID), [13, 14]);
  assert.deepStrictEqual(pickModules(ITEMS, undefined).map((item) => item.itemID), [13, 14], "weapons is the default");
  assert.deepStrictEqual(pickModules(ITEMS, "high").map((item) => item.itemID), [13, 14, 15]);
  assert.deepStrictEqual(pickModules(ITEMS, "group~Neutralizer").map((item) => item.itemID), [15]);
  assert.deepStrictEqual(pickModules(ITEMS, "mid name~afterburner").map((item) => item.itemID), [12]);
  assert.throws(() => pickModules(ITEMS, "name~Laser"), /no fitted module matches "name~Laser"; fitted: low Damage Control I \(11\)/);
});

function fakeIO({ grid = { characterID: 9, self: { itemID: 1 }, entities: ROWS }, refuse = {}, lockAfter = 2 } = {}) {
  const calls = [];
  let clock = 0;
  let targetsAsked = 0;
  const io = {
    calls,
    bindings: {},
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    grid: async () => grid,
    listShip: async () => ITEMS,
    call: async (service, method, args, kwargs) => {
      calls.push([`${service}.${method}`, args, kwargs === undefined ? null : kwargs]);
      if (refuse[method]) throw new Error(`gateway /call: CALL_REFUSED ${refuse[method](args)}`);
      if (method === "GetTargets") {
        targetsAsked += 1;
        return { type: "list", items: targetsAsked >= lockAfter ? [77] : [] };
      }
      return null;
    },
  };
  return io;
}

test("movement actions are the beyonce calls a client makes, with their ranges", async () => {
  const io = fakeIO();
  await runAction({ type: "approach", target: "flight=living_flight_0630" }, io);
  await runAction({ type: "orbit", target: "77" }, io);
  await runAction({ type: "keepAtRange", target: "77", range: 15_000 }, io);
  await runAction({ type: "warpTo", target: "kind=station", range: 10_000 }, io);
  await runAction({ type: "warpTo", target: "kind=station" }, io);
  const stop = await runAction({ type: "stop" }, io);
  assert.deepStrictEqual(io.calls, [
    ["beyonce.CmdFollowBall", [77, 0], null],
    ["beyonce.CmdOrbit", [77, 5000], null],
    ["beyonce.CmdFollowBall", [77, 15_000], null],
    ["beyonce.CmdWarpToStuff", ["item", 60004603], { minRange: 10_000 }],
    ["beyonce.CmdWarpToStuff", ["item", 60004603], null],
    ["beyonce.CmdStop", [], null],
  ]);
  assert.deepStrictEqual(stop, { ok: true, text: "stopping the ship", ids: [] });
});

test("a lock waits until the server lists the target, and binds it", async () => {
  const io = fakeIO({ lockAfter: 3 });
  const locked = await runAction({ type: "lock", target: "npc family=police" }, io);
  assert.strictEqual(locked.ok, true);
  assert.deepStrictEqual(locked.ids, ["77"]);
  assert.match(locked.text, /^locked Minmatar Patrol 1917 \(Rifter\) #77 at 1,800 m in 1\.0s$/);
  assert.deepStrictEqual(io.calls.map(([name]) => name), ["dogmaIM.AddTarget", "dogmaIM.GetTargets", "dogmaIM.GetTargets", "dogmaIM.GetTargets"]);
  const never = await runAction({ type: "lock", target: "77", timeout: 2 }, fakeIO({ lockAfter: Infinity }));
  assert.strictEqual(never.ok, false);
  assert.match(never.text, /not locked after 2s/);
});

test("activate switches each module on at the target, and reports each refusal in the server's words", async () => {
  const io = fakeIO({ refuse: { Activate: (args) => (args[0] === 14 ? "NoCharges" : null) } });
  io.call = ((call) => async (service, method, args, kwargs) => {
    if (method === "Activate" && args[0] !== 14) return (io.calls.push([`${service}.${method}`, args, null]), 1);
    return call(service, method, args, kwargs);
  })(io.call);
  const named = await runAction({ type: "activate", modules: "weapons", target: "77" }, io);
  assert.deepStrictEqual(io.calls.filter(([name]) => name === "dogmaIM.Activate").map(([, args]) => args),
    [[13, "", 77, -1], [14, "", 77, -1]]);
  assert.strictEqual(named.ok, false);
  assert.match(named.text, /1 of 2 module\(s\) on at Minmatar Patrol 1917.*refused: 200mm AutoCannon I \(high 14\): CALL_REFUSED NoCharges$/);

  const locked = fakeIO({ lockAfter: 1 });
  const once = await runAction({ type: "activate", modules: "high name~Neutralizer", once: true }, locked);
  assert.deepStrictEqual(locked.calls.filter(([name]) => name === "dogmaIM.Activate").map(([, args]) => args), [[15, "", 77, 0]],
    "no target named: the first locked one, as a client does");
  assert.strictEqual(once.ok, true);
});

test("deactivate names propulsion effects and takes an already-off module as done", async () => {
  const io = fakeIO({ refuse: { Deactivate: () => "200mm AutoCannon I is not active." } });
  const off = await runAction({ type: "deactivate", modules: "weapons" }, io);
  assert.strictEqual(off.ok, true);
  const mid = fakeIO();
  await runAction({ type: "deactivate", modules: "mid" }, mid);
  assert.deepStrictEqual(mid.calls.map(([, args]) => args), [[12, "moduleBonusAfterburner"]]);
});

test("loadAmmo loads one module per call from the biggest matching stack", async () => {
  const io = fakeIO();
  const loaded = await runAction({ type: "loadAmmo", modules: "weapons", charge: "EMP S" }, io);
  assert.strictEqual(loaded.ok, true);
  assert.deepStrictEqual(io.calls.map(([name, args]) => [name, args]), [
    ["dogmaIM.LoadAmmo", [1, [13], [16], 1]],
    ["dogmaIM.LoadAmmo", [1, [14], [16], 1]],
  ]);
  await assert.rejects(runAction({ type: "loadAmmo", charge: "Fusion S" }, fakeIO()),
    /nothing in the cargo hold matches "Fusion S"; it holds 1000x EMP S/);
});

test("launchDrones counts what reached space, and engageDrones sends this ship's drones", async () => {
  const grid = { characterID: 9, self: { itemID: 1 }, entities: ROWS };
  const io = fakeIO({ grid });
  io.grid = async () => grid;
  let launched = false;
  io.call = ((call) => async (service, method, args, kwargs) => {
    if (method === "LaunchDrones") {
      launched = true;
      grid.entities = [...ROWS, { itemID: 501, kind: "drone", ownerID: 9, typeName: "Warrior I", distanceMeters: 100 },
        { itemID: 502, kind: "drone", ownerID: 4, typeName: "Hobgoblin I", distanceMeters: 300 }];
    }
    return call(service, method, args, kwargs);
  })(io.call);
  const out = await runAction({ type: "launchDrones", drones: "all", count: 2 }, io);
  assert.ok(launched);
  assert.deepStrictEqual(io.calls[0], ["ship.LaunchDrones", [[[17, 2]], null, true], null]);
  assert.deepStrictEqual(out.ids, ["501"], "only this ship's new drones count");
  assert.strictEqual(out.ok, true);
  await runAction({ type: "engageDrones", target: "77" }, io);
  assert.deepStrictEqual(io.calls[io.calls.length - 1], ["entity.CmdEngage", [[501], 77], null]);

  const empty = fakeIO();
  const none = await runAction({ type: "engageDrones", target: "77" }, empty);
  assert.strictEqual(none.ok, false);
});

test("e2e act arguments become an action, and a bad one is refused before any call", () => {
  assert.deepStrictEqual(actionFromArgs("orbit", ["nearest", "npc"], { range: "5km" }),
    { type: "orbit", target: "nearest npc", range: 5000 });
  assert.deepStrictEqual(actionFromArgs("activate", [], { target: "$m", once: true }),
    { type: "activate", modules: "weapons", target: "$m", once: true });
  assert.deepStrictEqual(actionFromArgs("launchDrones", ["name~Warrior"], { count: "3" }),
    { type: "launchDrones", drones: "name~Warrior", count: 3 });
  assert.throws(() => actionFromArgs("fly", [], {}), /usage:/);
  assert.throws(() => actionFromArgs("lock", [], {}), /lock needs a target/);
  assert.throws(() => actionFromArgs("orbit", ["npc"], { range: "far" }), /--range takes metres/);
  assert.throws(() => actionFromArgs("stop", [], { target: "npc" }), /stop takes no target/);
});
