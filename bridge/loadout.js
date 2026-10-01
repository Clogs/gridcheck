"use strict";

// POST /loadout: give a character a new ship, fitted and filled, by item name,
// and board it, docked or in space. Every name is resolved and every skill
// checked before anything is made, so a refusal changes nothing. The ship is
// built from the stock helpers the /ship-style dev commands use
// (services/ship/devCommandShipRuntime and the modules it reads), the same
// way stock stages a preset hull: made in a station hangar, the modules fitted
// from there, then boarded. The format is core/loadout.js.

const { normalizeLoadout } = require("../core/loadout");
const { slotOf } = require("../core/actions");

// Each module the loadout reads, by path under server/src, and what it needs
// from it. Every export is in stock EveJS 0.12.9 and the LU fork. The probe
// (core/capabilities.js) checks the same table.
const LOADOUT_EXPORTS = Object.freeze({
  shipRuntime: ["services/ship/devCommandShipRuntime",
    ["fitGrantedItemTypeToShip", "moveGrantedItemTypeToShipCargo", "moveGrantedItemTypeToShipDroneBay", "boardPreparedShipInSpace"]],
  itemStore: ["services/inventory/itemStore",
    ["ITEM_FLAGS", "grantItemToCharacterLocation", "grantItemsToCharacterStationHangar", "moveItemTypeFromCharacterLocation"]],
  itemTypes: ["services/inventory/itemTypeRegistry", ["resolveItemByName", "resolveItemByTypeID"]],
  shipTypes: ["services/chat/shipTypeRegistry", ["resolveShipByName"]],
  fitting: ["services/fitting/liveFittingState",
    ["getRequiredSkillRequirements", "listFittedItems", "isChargeCompatibleWithModule", "getModuleChargeCapacity"]],
  skills: ["services/skills/skillState", ["getCachedCharacterSkillMap"]],
  character: ["services/character/characterState", ["activateShipForSession", "syncInventoryItemForSession", "getCharacterRecord"]],
  location: ["services/structure/structureLocation", ["getDockedLocationID", "isDockedSession"]],
});

// Inventory categories a loadout list may name.
const CATEGORY = Object.freeze({ ship: 6, module: 7, charge: 8, drone: 18, subsystem: 32 });
const LIST_CATEGORIES = Object.freeze({
  modules: [CATEGORY.module, CATEGORY.subsystem],
  drones: [CATEGORY.drone],
  charges: [CATEGORY.charge],
  cargo: null,
});

const toInt = (value) => Math.trunc(Number(value) || 0);

// load(relativePath) -> the module; the bridge passes serverRequire.
function loadLoadoutModules(load) {
  const modules = {};
  const missing = [];
  for (const [key, [relativePath, names]] of Object.entries(LOADOUT_EXPORTS)) {
    let loaded = null;
    try {
      loaded = load(relativePath);
    } catch (error) {
      missing.push(`${relativePath} failed to load: ${error.message}`);
      continue;
    }
    const absent = names.filter((name) => loaded[name] === undefined);
    if (absent.length) missing.push(`${relativePath} has no ${absent.join(", ")}`);
    modules[key] = loaded;
  }
  return { modules, missing };
}

function failure(statusCode, error, extra = {}) {
  return { statusCode, body: { ok: false, error, ...extra } };
}

// m: the modules above, loaded. -> (session, body) -> { statusCode, body }
function createLoadout(m) {
  const sameName = (query, entry) => String(entry && entry.name || "").toLowerCase() === String(query).toLowerCase();

  // Only an exact name or a type ID counts; a near miss is reported with what
  // the registry would have picked, since a wrong item in a fit has shipped before.
  function resolve(list, query) {
    const lookup = list === "ship" ? m.shipTypes.resolveShipByName(query) : m.itemTypes.resolveItemByName(query);
    const numeric = /^\d+$/.test(String(query).trim());
    if (lookup && lookup.success && lookup.match && (numeric || sameName(query, lookup.match))) {
      const allowed = list === "ship" ? [CATEGORY.ship] : LIST_CATEGORIES[list];
      if (allowed && !allowed.includes(toInt(lookup.match.categoryID))) {
        return { problem: { list, name: query, why: `${lookup.match.name} is not a ${list === "ship" ? "ship" : list.replace(/s$/, "")}` } };
      }
      return { type: lookup.match };
    }
    const suggestions = lookup && lookup.success && lookup.match ? [lookup.match.name]
      : (lookup && Array.isArray(lookup.suggestions) ? lookup.suggestions : []);
    const why = lookup && lookup.errorMsg === "AMBIGUOUS_ITEM_NAME" ? "more than one item has that name" : null;
    return { problem: { list, name: query, why, suggestions: suggestions.slice(0, 5) } };
  }

  function trainedLevel(record) {
    return Math.max(0, toInt(record && (record.effectiveSkillLevel ?? record.trainedSkillLevel ?? record.skillLevel)));
  }

  // Every requirement of every type the pilot flies or uses: the hull, its
  // modules, drones and charges. Cargo is only carried.
  function missingSkills(characterID, types) {
    const skillMap = m.skills.getCachedCharacterSkillMap(characterID);
    const missing = new Map();
    let checked = 0;
    for (const type of types) {
      for (const requirement of m.fitting.getRequiredSkillRequirements(type.typeID)) {
        checked += 1;
        const has = trainedLevel(skillMap.get(requirement.skillTypeID));
        if (has >= requirement.level) continue;
        const known = missing.get(requirement.skillTypeID);
        if (known) {
          known.level = Math.max(known.level, requirement.level);
          if (!known.for.includes(type.name)) known.for.push(type.name);
        } else {
          const skill = m.itemTypes.resolveItemByTypeID(requirement.skillTypeID);
          missing.set(requirement.skillTypeID, {
            skillTypeID: requirement.skillTypeID, name: skill && skill.name ? String(skill.name) : `skill ${requirement.skillTypeID}`,
            level: requirement.level, has, for: [type.name],
          });
        }
      }
    }
    return { checked, missing: [...missing.values()].sort((left, right) => left.name.localeCompare(right.name)) };
  }

  function syncChanges(session, changes) {
    for (const change of Array.isArray(changes) ? changes : []) {
      if (!change || !change.item) continue;
      m.character.syncInventoryItemForSession(session, change.item, change.previousData || change.previousState || {},
        { emitCfgLocation: true });
    }
  }

  // Where the hull is made: the station the pilot is docked in, else its home
  // or clone station, as stock's dev ship commands choose.
  function stagingLocation(session, docked) {
    if (docked) return toInt(m.location.getDockedLocationID(session));
    const record = m.character.getCharacterRecord(session.characterID) || {};
    return toInt(record.homeStationID || record.cloneStationID || session.stationid || session.stationID);
  }

  return function loadout(session, raw) {
    const { loadout: spec, problems } = normalizeLoadout(raw);
    if (!spec) return failure(400, problems.join("; "));
    const characterID = toInt(session.characterID);

    const unknown = [];
    const resolved = { modules: [], drones: [], cargo: [], charges: [] };
    const ship = resolve("ship", spec.ship);
    if (ship.problem) unknown.push(ship.problem);
    for (const list of Object.keys(resolved)) {
      for (const entry of spec[list]) {
        const found = resolve(list, entry.name);
        if (found.problem) unknown.push(found.problem);
        else resolved[list].push({ type: found.type, quantity: entry.quantity });
      }
    }
    if (unknown.length) return failure(409, `${unknown.length} name(s) not found; nothing was changed`, { unknown });

    // A charge has to fit something, or the clip would go nowhere.
    const unloadable = resolved.charges.filter((charge) => !resolved.modules.some((module) =>
      m.fitting.isChargeCompatibleWithModule(module.type.typeID, charge.type.typeID)));
    if (unloadable.length) {
      return failure(409, `${unloadable.map((charge) => charge.type.name).join(", ")} fits none of the modules; nothing was changed`, {
        unknown: unloadable.map((charge) => ({ list: "charges", name: charge.type.name, why: "no module in the loadout takes it" })),
      });
    }

    const flown = [ship.type, ...resolved.modules.map((entry) => entry.type), ...resolved.drones.map((entry) => entry.type),
      ...resolved.charges.map((entry) => entry.type)];
    const skills = missingSkills(characterID, flown);
    if (skills.missing.length) {
      return failure(409, `missing ${skills.missing.length} skill(s); nothing was changed`, { missingSkills: skills.missing });
    }

    const docked = Boolean(m.location.isDockedSession(session)) || toInt(m.location.getDockedLocationID(session)) > 0;
    const systemID = toInt(session._space && session._space.systemID);
    if (!docked && !systemID) return failure(409, "the character is neither docked nor in space; nothing was changed");
    const locationID = stagingLocation(session, docked);
    if (!locationID) return failure(409, "no station to build the ship in (not docked, and no home or clone station)");

    // From here the world changes; a stop names what was done.
    const done = [];
    const sync = docked;
    const { ITEM_FLAGS } = m.itemStore;
    const made = m.itemStore.grantItemToCharacterLocation(characterID, locationID, ITEM_FLAGS.HANGAR, ship.type, 1);
    const shipItem = made && made.success && made.data && Array.isArray(made.data.items) ? made.data.items[0] : null;
    if (!shipItem) return failure(500, `the hull could not be made: ${(made && made.errorMsg) || "no item"}`);
    if (sync) syncChanges(session, made.data.changes);
    done.push(`made ${ship.type.name} ${shipItem.itemID} in ${locationID}`);
    const stopped = (error) => failure(500, error, { done, shipID: shipItem.itemID });

    const grants = [...resolved.modules, ...resolved.drones, ...resolved.cargo]
      .map((entry) => ({ itemType: entry.type, quantity: entry.quantity }));
    if (grants.length) {
      const granted = m.itemStore.grantItemsToCharacterStationHangar(characterID, locationID, grants);
      if (!granted || !granted.success) return stopped(`the items could not be made: ${(granted && granted.errorMsg) || "?"}`);
      if (sync) syncChanges(session, granted.data && granted.data.changes);
    }

    for (const entry of resolved.modules) {
      const fit = m.shipRuntime.fitGrantedItemTypeToShip(session, locationID, shipItem, entry.type, entry.quantity, { syncToSession: sync });
      if (!fit || !fit.success) {
        const fitted = fit && fit.data ? toInt(fit.data.fittedCount) : 0;
        return stopped(`${entry.type.name}: fitted ${fitted} of ${entry.quantity}, then ${(fit && fit.errorMsg) || "FIT_FAILED"}`);
      }
      done.push(`fitted ${entry.type.name} x${entry.quantity}`);
    }
    for (const [list, move] of [["drones", "moveGrantedItemTypeToShipDroneBay"], ["cargo", "moveGrantedItemTypeToShipCargo"]]) {
      for (const entry of resolved[list]) {
        const moved = m.shipRuntime[move](session, locationID, shipItem, entry.type, entry.quantity, { syncToSession: sync });
        if (!moved || !moved.success) return stopped(`${entry.type.name} x${entry.quantity}: ${(moved && moved.errorMsg) || "MOVE_FAILED"}`);
        done.push(`${list === "drones" ? "drone bay" : "cargo"} ${entry.type.name} x${entry.quantity}`);
      }
    }

    // A full clip in every fitted module that takes a listed charge; stock's
    // own preload fills only the first module of a type.
    const fittedModules = m.fitting.listFittedItems(characterID, shipItem.itemID)
      .filter((item) => toInt(item.categoryID) !== CATEGORY.charge)
      .sort((left, right) => toInt(left.flagID) - toInt(right.flagID));
    const loads = [];
    for (const module of fittedModules) {
      const charge = resolved.charges.find((entry) => m.fitting.isChargeCompatibleWithModule(module.typeID, entry.type.typeID));
      if (!charge) continue;
      const quantity = Math.max(1, toInt(m.fitting.getModuleChargeCapacity(module.typeID, charge.type.typeID)));
      loads.push({ module, charge, quantity });
    }
    if (loads.length) {
      const totals = new Map();
      for (const load of loads) {
        const total = totals.get(load.charge.type.typeID) || { itemType: load.charge.type, quantity: 0 };
        total.quantity += load.quantity;
        totals.set(load.charge.type.typeID, total);
      }
      const granted = m.itemStore.grantItemsToCharacterStationHangar(characterID, locationID, [...totals.values()]);
      if (!granted || !granted.success) return stopped(`the charges could not be made: ${(granted && granted.errorMsg) || "?"}`);
      if (sync) syncChanges(session, granted.data && granted.data.changes);
      for (const load of loads) {
        const moved = m.itemStore.moveItemTypeFromCharacterLocation(characterID, locationID, ITEM_FLAGS.HANGAR, shipItem.itemID,
          load.module.flagID, load.charge.type.typeID, load.quantity);
        if (!moved || !moved.success) {
          return stopped(`${load.charge.type.name} into flag ${load.module.flagID}: ${(moved && moved.errorMsg) || "LOAD_FAILED"}`);
        }
        if (sync) syncChanges(session, moved.data && moved.data.changes);
      }
      done.push(`loaded ${loads.length} module(s)`);
    }

    let replacedShipID = null;
    if (docked) {
      const boarded = m.character.activateShipForSession(session, shipItem.itemID, { emitNotifications: true, logSelection: false });
      if (!boarded || boarded.success !== true) return stopped(`made it, but boarding failed: ${(boarded && boarded.errorMsg) || "BOARD_FAILED"}`);
    } else {
      const boarded = m.shipRuntime.boardPreparedShipInSpace(session, shipItem);
      if (!boarded || !boarded.success) return stopped(`made it, but the swap in space failed: ${(boarded && boarded.errorMsg) || "SPACE_SWAP_FAILED"}`);
      const destroyed = boarded.data && boarded.data.destroyResult;
      replacedShipID = destroyed && toInt(destroyed.destroyedShipID) ? toInt(destroyed.destroyedShipID) : null;
    }

    const typeName = (typeID) => {
      const type = m.itemTypes.resolveItemByTypeID(typeID);
      return type && type.name ? String(type.name) : `type ${typeID}`;
    };
    return {
      statusCode: 200,
      body: {
        ok: true,
        ship: { itemID: toInt(shipItem.itemID), typeID: toInt(ship.type.typeID), name: String(ship.type.name) },
        docked,
        locationID: docked ? locationID : null,
        systemID: docked ? null : systemID,
        stagedIn: locationID,
        replacedShipID,
        modules: fittedModules.map((module) => {
          const load = loads.find((entry) => entry.module === module);
          return {
            itemID: toInt(module.itemID), typeID: toInt(module.typeID), name: typeName(module.typeID),
            flagID: toInt(module.flagID), slot: slotOf(toInt(module.flagID)),
            ...(load ? { charge: { typeID: toInt(load.charge.type.typeID), name: String(load.charge.type.name), quantity: load.quantity } } : {}),
          };
        }),
        drones: resolved.drones.map((entry) => ({ typeID: toInt(entry.type.typeID), name: String(entry.type.name), quantity: entry.quantity })),
        cargo: resolved.cargo.map((entry) => ({ typeID: toInt(entry.type.typeID), name: String(entry.type.name), quantity: entry.quantity })),
        skillsChecked: skills.checked,
      },
    };
  };
}

module.exports = {
  CATEGORY,
  LOADOUT_EXPORTS,
  createLoadout,
  loadLoadoutModules,
};
