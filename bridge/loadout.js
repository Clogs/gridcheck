"use strict";

// POST /loadout: give a character a new ship, fitted and filled, by item name,
// and board it, docked or in space. Every name is resolved and every skill
// checked before anything is made, so a refusal changes nothing. The ship is
// built from the stock helpers the /ship-style dev commands use
// (services/ship/devCommandShipRuntime and the modules it reads), the same
// way stock stages a preset hull: made in a station hangar, the modules fitted
// from there, then boarded. With `into` it isn't boarded: it is moved, fitted,
// to a station hangar or a corporation office division. The format is
// core/loadout.js.

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
    ["getRequiredSkillRequirements", "listFittedItems", "isChargeCompatibleWithModule", "getModuleChargeCapacity",
      "selectAutoFitFlagForType", "validateFitForShip", "buildShipResourceState"]],
  skills: ["services/skills/skillState", ["getCachedCharacterSkillMap"]],
  character: ["services/character/characterState", ["activateShipForSession", "syncInventoryItemForSession", "getCharacterRecord"]],
  location: ["services/structure/structureLocation", ["getDockedLocationID", "isDockedSession"]],
});

// What only `into` reads: where a ship can be left, the move, and who is told.
// A tree without these refuses `into` and still builds and boards a loadout.
// Every export is in stock EveJS 0.12.9 and the LU fork; the probe checks this
// table too, and reports it apart from LOADOUT_EXPORTS.
const LOADOUT_INTO_EXPORTS = Object.freeze({
  intoItemStore: ["services/inventory/itemStore", ["transferItemToOwnerLocation"]],
  stations: ["space/worldData", ["getStationByID"]],
  structures: ["services/structure/structureState", ["getStructureByID"]],
  corporations: ["services/corporation/corporationRuntimeState", ["ensureRuntimeInitialized"]],
  officeObservers: ["services/inventory/corporationOfficeInventoryObservers", ["fanCorporationOfficeInventoryChanges"]],
  sessions: ["services/chat/sessionRegistry", ["findSessionByCharacterID"]],
});

// Hangar divisions of a corporation office: flagCorpSAG1 through flagCorpSAG7.
const FIRST_DIVISION_FLAG = 115;
const LAST_DIVISION_FLAG = 121;

// Inventory categories a loadout list may name.
const CATEGORY = Object.freeze({ ship: 6, module: 7, charge: 8, drone: 18, subsystem: 32 });
const LIST_CATEGORIES = Object.freeze({
  modules: [CATEGORY.module, CATEGORY.subsystem],
  drones: [CATEGORY.drone],
  charges: [CATEGORY.charge],
  cargo: null,
});

const toInt = (value) => Math.trunc(Number(value) || 0);

// load(relativePath) -> the module; the bridge passes serverRequire. table is
// { key: [path, [export names]] }, as LOADOUT_EXPORTS.
function loadModuleTable(table, load) {
  const modules = {};
  const missing = [];
  for (const [key, [relativePath, names]] of Object.entries(table)) {
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

const loadLoadoutModules = (load) => loadModuleTable(LOADOUT_EXPORTS, load);
const loadIntoModules = (load) => loadModuleTable(LOADOUT_INTO_EXPORTS, load);

function failure(statusCode, error, extra = {}) {
  return { statusCode, body: { ok: false, error, ...extra } };
}

// m: the modules of both tables, loaded. intoMissing: what LOADOUT_INTO_EXPORTS
// couldn't load, which refuses `into` alone. -> (session, body) -> { statusCode, body }
function createLoadout(m, { intoMissing = [] } = {}) {
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

  // The fit planned on a hull that doesn't exist yet, with the checks stock's
  // own planner makes (a slot, the item fits there, CPU, power and calibration
  // after it), so a fit that can't be built is refused before anything is
  // made. Skills were checked already.
  function planFit(characterID, shipType, modules) {
    const hull = { itemID: -1, typeID: toInt(shipType.typeID), groupID: toInt(shipType.groupID), categoryID: CATEGORY.ship,
      ownerID: characterID, singleton: 1 };
    const planned = [];
    let resources = null;
    for (const entry of modules) {
      for (let index = 0; index < entry.quantity; index += 1) {
        const which = `${entry.type.name}${entry.quantity > 1 ? ` #${index + 1}` : ""}`;
        const flagID = toInt(m.fitting.selectAutoFitFlagForType(hull, planned, toInt(entry.type.typeID)));
        if (!flagID) return { problem: `${which}: no free slot it fits` };
        const item = {
          itemID: -1000 - planned.length, typeID: toInt(entry.type.typeID), groupID: toInt(entry.type.groupID),
          categoryID: toInt(entry.type.categoryID), flagID, locationID: hull.itemID, ownerID: characterID,
          singleton: 1, quantity: 1, stacksize: 1, itemName: String(entry.type.name), moduleState: { online: true },
        };
        const valid = m.fitting.validateFitForShip(characterID, hull, item, flagID, planned);
        if (valid && !valid.success && valid.errorMsg !== "SKILL_REQUIRED") return { problem: `${which}: ${valid.errorMsg}` };
        planned.push(item);
        resources = m.fitting.buildShipResourceState(characterID, hull, { fittedItems: planned });
        const over = [["CPU", "cpuLoad", "cpuOutput"], ["power", "powerLoad", "powerOutput"],
          ["calibration", "upgradeLoad", "upgradeCapacity"]]
          .find(([, load, output]) => Number(resources[load]) > Number(resources[output]) + 1e-6);
        if (over) {
          const [label, load, output] = over;
          return { problem: `${which}: not enough ${label} (${Number(resources[load]).toFixed(1)} of ${Number(resources[output]).toFixed(1)})` };
        }
      }
    }
    return { resources };
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

  // Every office whose itemID (the ID the client opens it by), officeID or
  // folder ID is this one. The three are separate counters, so two offices can
  // share a number.
  function officesNamed(locationID) {
    const table = m.corporations.ensureRuntimeInitialized();
    const found = [];
    for (const runtime of Object.values((table && table.corporations) || {})) {
      for (const office of Object.values((runtime && runtime.offices) || {})) {
        if (office && [office.itemID, office.officeID, office.officeFolderID].some((id) => toInt(id) === locationID)) found.push(office);
      }
    }
    return found;
  }

  // Where `into` leaves the ship, or why it can't be left there. Reads only.
  // A station or structure hangar holds a character's ships, any character's;
  // an office holds its corporation's, in division 1 (flag 115) unless a flag
  // names another. The character needn't be in that corporation or docked there.
  function placementFor(characterID, spec) {
    const locationID = spec.into;
    const hangarFlag = toInt(m.itemStore.ITEM_FLAGS.HANGAR);
    if (m.stations.getStationByID(locationID) || m.structures.getStructureByID(locationID, { refresh: false })) {
      const ownerID = spec.owner || characterID;
      if (!m.character.getCharacterRecord(ownerID)) {
        return { problem: `owner ${ownerID} is not a character; a station hangar holds a character's ships ` +
          "(a corporation's are in its office: pass the office's ID as into)" };
      }
      if (spec.flag && spec.flag !== hangarFlag) return { problem: `flag ${spec.flag}: a ship in a station hangar is at flag ${hangarFlag}` };
      return { placement: { kind: "hangar", locationID, ownerID, flagID: hangarFlag, stationID: locationID,
        description: `character ${ownerID}'s hangar in station ${locationID}` } };
    }
    const offices = officesNamed(locationID);
    if (!offices.length) {
      return { problem: `${locationID} is not a station, a structure or a corporation office (an office is named by the ID the client opens it by)` };
    }
    if (offices.length > 1) return { problem: `${locationID} names more than one corporation office` };
    const office = offices[0];
    const corporationID = toInt(office.corporationID);
    if (office.impounded) return { problem: `corporation ${corporationID}'s office ${locationID} is impounded` };
    if (spec.owner && spec.owner !== corporationID) {
      return { problem: `owner ${spec.owner}: office ${locationID} is corporation ${corporationID}'s, and a ship in it is the corporation's; leave owner out` };
    }
    const flagID = spec.flag || FIRST_DIVISION_FLAG;
    if (flagID < FIRST_DIVISION_FLAG || flagID > LAST_DIVISION_FLAG) {
      return { problem: `flag ${flagID}: an office's hangar divisions are flags ${FIRST_DIVISION_FLAG} through ${LAST_DIVISION_FLAG}, division 1 first` };
    }
    const stationID = toInt(office.stationID);
    return { placement: { kind: "office", locationID, ownerID: corporationID, flagID, stationID, corporationID,
      description: `corporation ${corporationID}'s office ${locationID} in station ${stationID}, hangar division ${flagID - FIRST_DIVISION_FLAG + 1} (flag ${flagID})` } };
  }

  return function loadout(session, raw) {
    const { loadout: spec, problems } = normalizeLoadout(raw);
    if (!spec) return failure(400, problems.join("; "));
    if (spec.into && intoMissing.length) {
      return failure(503, `into isn't available in this tree: ${intoMissing.join("; ")}; nothing was changed`, { intoMissing });
    }
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
    const plan = planFit(characterID, ship.type, resolved.modules);
    if (plan.problem) return failure(409, `the fit can't be built on a ${ship.type.name}; nothing was changed`, { fit: plan.problem });

    let placement = null;
    if (spec.into) {
      const found = placementFor(characterID, spec);
      if (found.problem) return failure(409, `the ship can't be left there: ${found.problem}; nothing was changed`, { into: found.problem });
      placement = found.placement;
    }

    const docked = Boolean(m.location.isDockedSession(session)) || toInt(m.location.getDockedLocationID(session)) > 0;
    const systemID = toInt(session._space && session._space.systemID);
    if (!placement && !docked && !systemID) return failure(409, "the character is neither docked nor in space; nothing was changed");
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
    if (placement) {
      // Built in the character's hangar, where stock's fitting helpers work,
      // then moved whole. reownContents hands the fitted modules, charges,
      // drones and cargo to the new owner with the hull, as stock's own
      // inventory broker does for a hand-off between owners.
      const inPlace = placement.locationID === locationID && placement.ownerID === characterID
        && placement.flagID === toInt(ITEM_FLAGS.HANGAR);
      if (!inPlace) {
        const moved = m.intoItemStore.transferItemToOwnerLocation(shipItem.itemID, placement.ownerID, placement.locationID,
          placement.flagID, null, { reownContents: true });
        if (!moved || !moved.success) {
          return stopped(`made it, but moving it to ${placement.description} failed: ${(moved && moved.errorMsg) || "MOVE_FAILED"}; ` +
            `it is in the character's hangar in ${locationID}`);
        }
        const changes = moved.data && moved.data.changes;
        if (sync) syncChanges(session, changes);
        if (placement.kind === "office") {
          // The corporation's other members with that office open; this session was synced above.
          m.officeObservers.fanCorporationOfficeInventoryChanges(changes, { excludeSessions: sync ? [session] : [] });
        } else if (placement.ownerID !== characterID) {
          const owner = m.sessions.findSessionByCharacterID(placement.ownerID);
          if (owner && toInt(m.location.getDockedLocationID(owner)) === placement.stationID) syncChanges(owner, changes);
        }
        done.push(`moved to ${placement.description}`);
      }
    } else if (docked) {
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
        locationID: !placement && docked ? locationID : null,
        systemID: !placement && !docked ? systemID : null,
        stagedIn: locationID,
        replacedShipID,
        ...(placement ? { placed: {
          kind: placement.kind, locationID: placement.locationID, ownerID: placement.ownerID, flagID: placement.flagID,
          stationID: placement.stationID, description: placement.description,
          ...(placement.corporationID ? { corporationID: placement.corporationID } : {}),
        } } : {}),
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
        ...(plan.resources ? {
          resources: Object.fromEntries([["cpu", "cpuLoad", "cpuOutput"], ["power", "powerLoad", "powerOutput"],
            ["calibration", "upgradeLoad", "upgradeCapacity"]]
            .map(([key, load, output]) => [key, { used: Number(plan.resources[load]) || 0, of: Number(plan.resources[output]) || 0 }])),
        } : {}),
      },
    };
  };
}

module.exports = {
  CATEGORY,
  LOADOUT_EXPORTS,
  LOADOUT_INTO_EXPORTS,
  createLoadout,
  loadIntoModules,
  loadLoadoutModules,
  loadModuleTable,
};
