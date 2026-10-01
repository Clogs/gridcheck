"use strict";

// Player actions for `e2e act` and for scenario steps: fly, lock, switch
// modules on and off, load ammo and launch drones, each through a call the web
// gateway already allows (server/src/_secondary/express/webCallPolicies.js).
// The server owns every rule (range, capacitor, lock time, slots); this only
// picks what to act on and reports what the server answered. The calls come
// in as `io`, so the actions can be tested without a server. Guide:
// docs/E2E-GRID-TESTING.md "Player actions".

const { tokenize } = require("./conditions");
const { formatDistance } = require("./format");

// Step name -> what it takes. `target` is a ball on grid, `modules` a module
// selection on the player's own ship.
const ACTIONS = Object.freeze({
  approach: { target: "required" },
  orbit: { target: "required", range: 5000 },
  keepAtRange: { target: "required", range: 10000 },
  warpTo: { target: "required", range: 0 },
  stop: {},
  lock: { target: "required", timeout: 30 },
  unlock: { target: "required" },
  activate: { modules: "weapons", target: "optional", once: false },
  deactivate: { modules: "weapons" },
  loadAmmo: { modules: "weapons", charge: "required" },
  launchDrones: { drones: "all", count: null },
  engageDrones: { target: "required" },
});
const ACTION_TYPES = Object.freeze(Object.keys(ACTIONS));

const ACTION_USAGE = [
  "e2e act approach <target>",
  "e2e act orbit <target> [--range 5000]",
  "e2e act keepAtRange <target> [--range 10000]",
  "e2e act warpTo <target> [--range 0]",
  "e2e act stop",
  "e2e act lock <target> [--timeout 30]",
  "e2e act unlock <target>",
  "e2e act activate [<modules>] [--target <target>] [--once]",
  "e2e act deactivate [<modules>]",
  "e2e act loadAmmo [<modules>] --charge <charge>",
  "e2e act launchDrones [<drones>] [--count N]",
  "e2e act engageDrones <target>",
].join("\n  ");

// Inventory flags (inventoryConst): the slot ranges, the drone bay and cargo.
const SLOT_FLAGS = Object.freeze({ low: [11, 18], mid: [19, 26], high: [27, 34], rig: [92, 99] });
const DRONE_BAY_FLAG = 87;
const CARGO_FLAG = 5;
const LIST_FLAGS = Object.freeze([
  ...Array.from({ length: 24 }, (_, i) => 11 + i),
  CARGO_FLAG,
  DRONE_BAY_FLAG,
]);
const WEAPON_GROUP = /Weapon|Launcher|Vorton Projector|Disintegrator/i;
const NOT_A_WEAPON = /Smart ?Bomb/i;

function slotOf(flagID) {
  for (const [slot, [first, last]] of Object.entries(SLOT_FLAGS)) {
    if (flagID >= first && flagID <= last) return slot;
  }
  if (flagID === DRONE_BAY_FLAG) return "drone";
  if (flagID === CARGO_FLAG) return "cargo";
  return null;
}

function isWeapon(item) {
  return item.slot === "high" && WEAPON_GROUP.test(item.groupName || "") && !NOT_A_WEAPON.test(item.groupName || "");
}

const UNITS = { "": 1, m: 1, km: 1000 };
function parseMeters(text) {
  const match = /^(\d+(?:\.\d+)?)(m|km)?$/i.exec(String(text));
  return match ? Number(match[1]) * UNITS[(match[2] || "").toLowerCase()] : null;
}

function regex(text, where) {
  try {
    return new RegExp(text, "i");
  } catch (error) {
    throw new Error(`${where}: ${error.message}`);
  }
}

// ---------- targets ----------

// "nearest npc", "name~Scout family=pirate within=50km", "980050000108",
// "$mark" (a ball or flight an earlier step bound). Throws on a term it can't read.
function parseTargetSpec(text) {
  const source = String(text === undefined || text === null ? "" : text).trim();
  if (!source) throw new Error("a target is a ball ID, $name or filters such as \"nearest npc\"");
  const tests = [];
  const bindings = [];
  for (const token of tokenize(source)) {
    if (/^\d+$/.test(token)) {
      const id = Number(token);
      tests.push({ what: token, test: (row) => row.itemID === id });
      continue;
    }
    if (/^\$[A-Za-z_]\w*$/.test(token)) {
      const name = token.slice(1);
      bindings.push(name);
      tests.push({ what: token, binding: name });
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "nearest") continue;
    if (lower === "npc") { tests.push({ what: token, test: (row) => row.isNpc === true }); continue; }
    if (lower === "player") { tests.push({ what: token, test: (row) => !row.isNpc && Boolean(row.characterID) }); continue; }
    const match = /^([A-Za-z]+)(=|~)(.+)$/.exec(token);
    if (!match) throw new Error(`target: can't read "${token}"; use npc, player, name~, type~, kind=, family=, flight=, within=`);
    const [, field, op, value] = match;
    if (value.startsWith("$")) {
      if (field !== "flight" || op !== "=") throw new Error(`target: "${token}": only flight=$name takes a binding`);
      const name = value.slice(1);
      bindings.push(name);
      tests.push({ what: token, binding: name, flightOnly: true });
      continue;
    }
    switch (field) {
      case "name": case "type": {
        const key = field === "name" ? "name" : "typeName";
        if (op === "~") {
          const pattern = regex(value, `target ${token}`);
          tests.push({ what: token, test: (row) => pattern.test(String(row[key] || "")) });
        } else {
          tests.push({ what: token, test: (row) => String(row[key] || "").toLowerCase() === value.toLowerCase() });
        }
        break;
      }
      case "kind": case "family":
        if (op !== "=") throw new Error(`target: "${token}": ${field} takes =`);
        tests.push({ what: token, test: (row) => String(row[field] || "").toLowerCase() === value.toLowerCase() });
        break;
      case "flight":
        if (op !== "=") throw new Error(`target: "${token}": flight takes =`);
        tests.push({ what: token, test: (row) => String(row.flightID || "") === value });
        break;
      case "within": {
        const meters = op === "=" ? parseMeters(value) : null;
        if (meters === null) throw new Error(`target: "${token}": within=<distance>, e.g. within=50km`);
        tests.push({ what: token, test: (row) => row.distanceMeters !== null && row.distanceMeters <= meters });
        break;
      }
      default:
        throw new Error(`target: unknown field "${field}"; use name, type, kind, family, flight or within`);
    }
  }
  return { text: source, tests, bindings };
}

// The nearest grid row (never self) that passes every test. A binding matches
// a ball's own ID or its LU flight, so a fleet trigger's `as` works as a target.
function pickTarget(rows, spec, bindings = {}) {
  const parsed = typeof spec === "string" ? parseTargetSpec(spec) : spec;
  const passes = (row) => parsed.tests.every((term) => {
    if (!term.binding) return term.test(row);
    const ids = (bindings[term.binding] || []).map(String);
    if (!ids.length) throw new Error(`$${term.binding} is not bound yet`);
    return ids.includes(String(row.flightID || "")) || (!term.flightOnly && ids.includes(String(row.itemID)));
  });
  const candidates = rows.filter((row) => row && !row.isSelf && passes(row));
  candidates.sort((a, b) => (a.distanceMeters === null ? Infinity : a.distanceMeters) -
    (b.distanceMeters === null ? Infinity : b.distanceMeters));
  if (!candidates.length) {
    const near = rows.filter((row) => row && !row.isSelf).slice(0, 4)
      .map((row) => `${row.name || row.typeName || row.itemID} (${row.itemID}, ${formatDistance(row.distanceMeters)})`);
    throw new Error(`no ball on grid matches "${parsed.text}"${near.length ? `; nearest: ${near.join(", ")}` : "; the grid is empty"}`);
  }
  return candidates[0];
}

function describeBall(row) {
  return `${row.name || row.typeName || "#"}${row.typeName && row.typeName !== row.name ? ` (${row.typeName})` : ""} ` +
    `#${row.itemID} at ${formatDistance(row.distanceMeters)}`;
}

// ---------- modules ----------

// "weapons" (the default), "high", "mid", "low", "all", an itemID,
// "name~AutoCannon", "group~Launcher"; several terms must all hold.
function parseModuleSpec(text) {
  const source = String(text || "weapons").trim();
  const tests = [];
  for (const token of tokenize(source)) {
    const lower = token.toLowerCase();
    if (/^\d+$/.test(token)) {
      const id = Number(token);
      tests.push((item) => Number(item.itemID) === id);
    } else if (lower === "weapons") {
      tests.push(isWeapon);
    } else if (["high", "mid", "low"].includes(lower)) {
      tests.push((item) => item.slot === lower);
    } else if (lower === "all") {
      tests.push((item) => ["high", "mid", "low"].includes(item.slot));
    } else {
      const match = /^(name|group)~(.+)$/i.exec(token);
      if (!match) throw new Error(`modules: can't read "${token}"; use weapons, high, mid, low, all, an itemID, name~ or group~`);
      const pattern = regex(match[2], `modules ${token}`);
      const key = match[1].toLowerCase() === "name" ? "name" : "groupName";
      tests.push((item) => pattern.test(String(item[key] || "")));
    }
  }
  return { text: source, tests };
}

function pickModules(items, spec) {
  const parsed = typeof spec === "string" || spec === undefined ? parseModuleSpec(spec) : spec;
  const fitted = items.filter((item) => ["high", "mid", "low"].includes(item.slot));
  const chosen = fitted.filter((item) => parsed.tests.every((test) => test(item)));
  if (!chosen.length) {
    const list = fitted.map((item) => `${item.slot} ${item.name || item.typeID} (${item.itemID})`).join(", ");
    throw new Error(`no fitted module matches "${parsed.text}"${list ? `; fitted: ${list}` : "; nothing is fitted"}`);
  }
  return chosen.sort((a, b) => a.flagID - b.flagID);
}

// Hold items by name or group, e.g. "EMP S", "name~EMP", "group~Hybrid Charge".
function pickHoldItems(items, slot, spec) {
  const source = String(spec || "").trim();
  const inHold = items.filter((item) => item.slot === slot && item.quantity > 0);
  let test = () => true;
  if (source && source !== "all") {
    const match = /^(name|group)~(.+)$/i.exec(source);
    if (match) {
      const pattern = regex(match[2], source);
      const key = match[1].toLowerCase() === "name" ? "name" : "groupName";
      test = (item) => pattern.test(String(item[key] || ""));
    } else if (/^\d+$/.test(source)) {
      test = (item) => Number(item.itemID) === Number(source) || Number(item.typeID) === Number(source);
    } else {
      test = (item) => String(item.name || "").toLowerCase() === source.toLowerCase();
    }
  }
  const chosen = inHold.filter(test).sort((a, b) => b.quantity - a.quantity);
  if (!chosen.length) {
    const where = slot === "drone" ? "drone bay" : "cargo hold";
    const list = inHold.map((item) => `${item.quantity}x ${item.name || item.typeID}`).join(", ");
    throw new Error(`nothing in the ${where} matches "${source || "all"}"${list ? `; it holds ${list}` : "; it is empty"}`);
  }
  return chosen;
}

// A ListByFlags reply -> plain rows with slot and type names.
function shipItems(result, typeInfo = () => null) {
  const rows = result && Array.isArray(result.items) ? result.items : Array.isArray(result) ? result : [];
  const items = [];
  for (const raw of rows) {
    const fields = raw && raw.fields ? raw.fields : raw;
    const itemID = Number(fields && fields.itemID);
    // Loaded charges come back as (shipID, flagID, typeID) tuples, not items.
    if (!Number.isFinite(itemID) || itemID <= 0) continue;
    const typeID = Number(fields.typeID) || null;
    const info = typeID ? typeInfo(typeID) || {} : {};
    const quantity = Number(fields.stacksize !== undefined ? fields.stacksize : fields.quantity);
    items.push({
      itemID,
      typeID,
      flagID: Number(fields.flagID),
      slot: slotOf(Number(fields.flagID)),
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      groupID: Number(fields.groupID) || null,
      categoryID: Number(fields.categoryID) || null,
      name: info.name || null,
      groupName: info.groupName || null,
    });
  }
  return items;
}

function moduleText(item) {
  return `${item.name || `type ${item.typeID}`} (${item.slot} ${item.itemID})`;
}

function errorText(error) {
  return String((error && error.message) || error || "").split(/\r?\n/)[0].replace(/^gateway \/\w+(?:\/\w+)?: /, "");
}

// ---------- the actions ----------

// action: { type, target?, modules?, range?, once?, timeout?, charge?, drones?, count? }
// io: {
//   call(service, method, args, kwargs) -> result      a gateway /call; throws with the server's reason
//   grid() -> { self, entities }                       the player's grid, rows with flightID and family
//   listShip(shipID) -> items                           shipItems() of the ship's slots, cargo and drone bay
//   bindings, sleep(ms), now()
// }
// -> { ok, text, ids }: ids is what `as` binds (the target's itemID, or the drones launched).
async function runAction(action, io) {
  const spec = ACTIONS[action.type];
  if (!spec) throw new Error(`no such action: ${action.type}; actions are ${ACTION_TYPES.join(", ")}`);
  const bindings = io.bindings || {};
  const sleep = io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = io.now || Date.now;
  let grid = null;
  const readGrid = async () => {
    grid = await io.grid();
    if (!grid || !grid.self) throw new Error("the ship is not in space");
    return grid;
  };
  const target = async () => pickTarget((await readGrid()).entities || [], action.target, bindings);
  const range = action.range === undefined || action.range === null ? spec.range : action.range;

  switch (action.type) {
    case "approach":
    case "keepAtRange": {
      const row = await target();
      const meters = action.type === "approach" ? 0 : range;
      await io.call("beyonce", "CmdFollowBall", [row.itemID, meters]);
      return { ok: true, text: `${action.type === "approach" ? "approaching" : `keeping ${formatDistance(meters)} from`} ` +
        `${describeBall(row)}`, ids: [String(row.itemID)] };
    }
    case "orbit": {
      const row = await target();
      await io.call("beyonce", "CmdOrbit", [row.itemID, range]);
      return { ok: true, text: `orbiting ${describeBall(row)} at ${formatDistance(range)}`, ids: [String(row.itemID)] };
    }
    case "warpTo": {
      const row = await target();
      await io.call("beyonce", "CmdWarpToStuff", ["item", row.itemID], range ? { minRange: range } : null);
      return { ok: true, text: `warping to ${describeBall(row)}${range ? ` at ${formatDistance(range)}` : ""}`,
        ids: [String(row.itemID)] };
    }
    case "stop":
      await io.call("beyonce", "CmdStop", []);
      return { ok: true, text: "stopping the ship", ids: [] };
    case "lock": {
      const row = await target();
      await io.call("dogmaIM", "AddTarget", [row.itemID]);
      const timeoutMs = (action.timeout || spec.timeout) * 1000;
      const startedAt = now();
      for (;;) {
        const locked = await lockedTargets(io);
        if (locked.includes(row.itemID)) {
          return { ok: true, text: `locked ${describeBall(row)} in ${((now() - startedAt) / 1000).toFixed(1)}s`,
            ids: [String(row.itemID)] };
        }
        if (now() - startedAt >= timeoutMs) {
          return { ok: false, text: `${describeBall(row)} not locked after ${action.timeout || spec.timeout}s`,
            ids: [String(row.itemID)] };
        }
        await sleep(500);
      }
    }
    case "unlock": {
      const row = await target();
      await io.call("dogmaIM", "RemoveTarget", [row.itemID]);
      return { ok: true, text: `unlocked ${describeBall(row)}`, ids: [String(row.itemID)] };
    }
    case "activate": {
      const self = (await readGrid()).self;
      const modules = pickModules(await io.listShip(self.itemID), action.modules || spec.modules);
      let row = null;
      if (action.target) {
        row = pickTarget(grid.entities || [], action.target, bindings);
      } else {
        // No target named: the first locked one, as the client's own default.
        const locked = await lockedTargets(io);
        row = locked.length ? (grid.entities || []).find((entry) => entry.itemID === locked[0]) || { itemID: locked[0], distanceMeters: null } : null;
      }
      const results = [];
      for (const item of modules) {
        try {
          await io.call("dogmaIM", "Activate", [item.itemID, "", row ? row.itemID : null, action.once ? 0 : -1]);
          results.push({ item, ok: true });
        } catch (error) {
          results.push({ item, ok: false, error: errorText(error) });
        }
      }
      const on = results.filter((entry) => entry.ok);
      const refused = results.filter((entry) => !entry.ok);
      return {
        ok: refused.length === 0,
        text: `${on.length} of ${results.length} module(s) on${row ? ` at ${describeBall(row)}` : ""}` +
          `${action.once ? ", one cycle" : ""}: ${on.map((entry) => moduleText(entry.item)).join(", ") || "none"}` +
          `${refused.length ? `; refused: ${refused.map((entry) => `${moduleText(entry.item)}: ${entry.error}`).join("; ")}` : ""}`,
        ids: row ? [String(row.itemID)] : [],
      };
    }
    case "deactivate": {
      const self = (await readGrid()).self;
      const modules = pickModules(await io.listShip(self.itemID), action.modules || spec.modules);
      const refused = [];
      for (const item of modules) {
        // Propulsion needs its effect named; everything else takes the module's default.
        const effect = /Propulsion/i.test(item.groupName || "")
          ? (/Microwarpdrive/i.test(item.name || "") ? "moduleBonusMicrowarpdrive" : "moduleBonusAfterburner")
          : "";
        try {
          await io.call("dogmaIM", "Deactivate", [item.itemID, effect]);
        } catch (error) {
          // Already off (a single cycle ended, or it never started) is what was asked.
          if (!/not active/i.test(errorText(error))) refused.push(`${moduleText(item)}: ${errorText(error)}`);
        }
      }
      return { ok: refused.length === 0, text: `${modules.length - refused.length} of ${modules.length} module(s) off` +
        `${refused.length ? `; refused: ${refused.join("; ")}` : ""}`, ids: [] };
    }
    case "loadAmmo": {
      const self = (await readGrid()).self;
      const items = await io.listShip(self.itemID);
      const modules = pickModules(items, action.modules || spec.modules);
      pickHoldItems(items, "cargo", action.charge);
      // One module per call: the server fills the first module of a call from
      // the whole stack, so a shared call leaves the rest empty.
      const loaded = [];
      const refused = [];
      for (const item of modules) {
        try {
          const charge = pickHoldItems(await io.listShip(self.itemID), "cargo", action.charge)[0];
          await io.call("dogmaIM", "LoadAmmo", [self.itemID, [item.itemID], [charge.itemID], self.itemID]);
          loaded.push(`${moduleText(item)} from ${charge.quantity}x ${charge.name || charge.typeID}`);
        } catch (error) {
          refused.push(`${moduleText(item)}: ${errorText(error)}`);
        }
      }
      return { ok: refused.length === 0, text: `loading ${loaded.length} of ${modules.length} module(s)` +
        `${loaded.length ? `: ${loaded.join(", ")}` : ""}${refused.length ? `; refused: ${refused.join("; ")}` : ""}`, ids: [] };
    }
    case "launchDrones": {
      const self = (await readGrid()).self;
      const drones = pickHoldItems(await io.listShip(self.itemID), "drone", action.drones || spec.drones);
      let left = action.count ? Number(action.count) : Infinity;
      const pairs = [];
      for (const stack of drones) {
        if (left <= 0) break;
        const quantity = Math.min(stack.quantity, left);
        pairs.push([stack.itemID, quantity]);
        left -= quantity;
      }
      const before = new Set((grid.entities || []).filter((row) => row.kind === "drone").map((row) => row.itemID));
      await io.call("ship", "LaunchDrones", [pairs, null, true]);
      // The handler answers 200 when it refuses; the grid is the authority.
      await sleep(1500);
      const mine = ((await readGrid()).entities || []).filter((row) => row.kind === "drone" &&
        Number(row.ownerID) === Number(grid.characterID) && !before.has(row.itemID));
      const wanted = pairs.reduce((sum, [, quantity]) => sum + quantity, 0);
      return { ok: mine.length > 0, text: `${mine.length} of ${wanted} drone(s) in space` +
        `${mine.length ? `: ${mine.map((row) => row.typeName || row.name).join(", ")}` : "; the launch was refused (bandwidth, drone skills or the bay)"}`,
      ids: mine.map((row) => String(row.itemID)) };
    }
    case "engageDrones": {
      const rows = (await readGrid()).entities || [];
      const row = pickTarget(rows, action.target, bindings);
      const drones = rows.filter((entry) => entry.kind === "drone" && Number(entry.ownerID) === Number(grid.characterID));
      if (!drones.length) return { ok: false, text: "no drones of this ship in space; launchDrones first", ids: [] };
      await io.call("entity", "CmdEngage", [drones.map((entry) => entry.itemID), row.itemID]);
      return { ok: true, text: `${drones.length} drone(s) engaging ${describeBall(row)}`, ids: [String(row.itemID)] };
    }
    default:
      throw new Error(`no such action: ${action.type}`);
  }
}

async function lockedTargets(io) {
  const reply = await io.call("dogmaIM", "GetTargets", []);
  const list = reply && Array.isArray(reply.items) ? reply.items : Array.isArray(reply) ? reply : [];
  return list.map(Number).filter((id) => id > 0);
}

// `e2e act <type> [<what>] [--flags]` -> an action.
function actionFromArgs(type, positionals, flags) {
  const spec = ACTIONS[type];
  if (!spec) throw new Error(`usage:\n  ${ACTION_USAGE}`);
  const what = positionals.join(" ").trim();
  const action = { type };
  if (spec.target === "required") {
    if (!what) throw new Error(`${type} needs a target, e.g. "nearest npc", an itemID or name~Scout`);
    action.target = what;
  }
  if (spec.modules !== undefined) action.modules = what || spec.modules;
  if (spec.drones !== undefined) action.drones = what || spec.drones;
  if (flags.target !== undefined) action.target = String(flags.target);
  if (flags.range !== undefined) {
    const meters = parseMeters(flags.range);
    if (meters === null) throw new Error("--range takes metres, e.g. 5000 or 5km");
    action.range = meters;
  }
  if (flags.timeout !== undefined) action.timeout = Number(flags.timeout);
  if (flags.once) action.once = true;
  if (flags.charge !== undefined) action.charge = String(flags.charge);
  if (flags.count !== undefined) action.count = Number(flags.count);
  checkAction(action);
  return action;
}

// Throws on the first problem; scenarios and the CLI share it.
function checkAction(action) {
  const spec = ACTIONS[action.type];
  if (!spec) throw new Error(`no such action: ${action.type}`);
  if (spec.target === "required" || (spec.target === "optional" && action.target !== undefined)) {
    parseTargetSpec(action.target);
  } else if (action.target !== undefined) {
    throw new Error(`${action.type} takes no target`);
  }
  if (spec.modules !== undefined) parseModuleSpec(action.modules || spec.modules);
  if (action.range !== undefined && !(typeof action.range === "number" && action.range >= 0 && action.range <= 1e9)) {
    throw new Error("range: metres, 0 or more");
  }
  if (action.timeout !== undefined && !(action.timeout > 0 && action.timeout <= 600)) throw new Error("timeout: 1 through 600 seconds");
  if (spec.charge === "required" && !String(action.charge || "").trim()) throw new Error(`${action.type} needs a charge, e.g. "EMP S"`);
  if (action.count !== undefined && action.count !== null && !(Number.isInteger(action.count) && action.count >= 1 && action.count <= 50)) {
    throw new Error("count: 1 through 50");
  }
  return action;
}

function describeAction(action) {
  const parts = [action.type];
  if (action.modules) parts.push(action.modules);
  if (action.drones && action.drones !== "all") parts.push(action.drones);
  if (action.target) parts.push(action.type === "activate" ? `at ${action.target}` : action.target);
  if (action.range !== undefined) parts.push(`range ${formatDistance(action.range)}`);
  if (action.charge) parts.push(`charge ${action.charge}`);
  if (action.count) parts.push(`x${action.count}`);
  if (action.once) parts.push("once");
  return parts.join(" ");
}

module.exports = {
  ACTIONS,
  ACTION_TYPES,
  ACTION_USAGE,
  LIST_FLAGS,
  actionFromArgs,
  checkAction,
  describeAction,
  isWeapon,
  parseModuleSpec,
  parseTargetSpec,
  pickHoldItems,
  pickModules,
  pickTarget,
  runAction,
  shipItems,
  slotOf,
};
