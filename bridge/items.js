"use strict";

// GET /items: what sits in a place, or one item and what's inside it, read from
// the server's live item store, so changes it hasn't flushed to the game store
// yet are seen. Read-only. The query and the answer are core/worldItems.js's.

const { runQuery } = require("../core/worldItems");

// Each module the reader needs, by path under server/src. Every export is in
// stock EveJS 0.12.9 and the LU fork.
const ITEMS_EXPORTS = Object.freeze({
  itemStore: ["services/inventory/itemStore", ["findItemById", "listContainerItems"]],
  itemTypes: ["services/inventory/itemTypeRegistry", ["resolveItemByTypeID"]],
});

// m: the modules above, loaded. -> (query) -> { statusCode, body }
function createItemsReader(m) {
  const source = {
    item: (id) => m.itemStore.findItemById(id),
    inLocation: (id) => m.itemStore.listContainerItems(null, id),
    contentsCounts: (ids) => new Map(ids.map((id) => [id, m.itemStore.listContainerItems(null, id).length])),
    typeName: (typeID) => {
      const type = m.itemTypes.resolveItemByTypeID(typeID);
      return type && type.name ? String(type.name) : null;
    },
  };
  return function items(query) {
    const reply = runQuery(source, query);
    return reply.ok
      ? { statusCode: 200, body: { ...reply, source: "live" } }
      : { statusCode: 404, body: reply };
  };
}

module.exports = {
  ITEMS_EXPORTS,
  createItemsReader,
};
