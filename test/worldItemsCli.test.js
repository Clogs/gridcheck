"use strict";

// `gridcheck world items` and its MCP tool as the CLI sees them.

const test = require("node:test");
const assert = require("node:assert");

const mcp = require("../bin/mcp");
const { buildCatalog } = require("../core/commandDocs");
const { CORE_COMMANDS, cmdWorldItems } = require("../bin/gridcheck");

test("the MCP tool becomes `world items` flags, written --flag=value", () => {
  assert.deepStrictEqual(mcp.cliArgs("world_items", { location: 60004588, flag: 4, type: "Tristan", limit: 20, json: true }),
    ["world", "items", "--location=60004588", "--flag=4", "--type=Tristan", "--limit=20", "--json"]);
  assert.deepStrictEqual(mcp.cliArgs("world_items", { item: 1001, flag: 0 }), ["world", "items", "--item=1001", "--flag=0"]);
  const names = mcp.TOOLS.map((tool) => tool.name);
  assert.strictEqual(names[names.indexOf("loadout") + 1], "world_items", "listed right after loadout");
});

test("the command is documented in the worlds group, and names its tool", () => {
  const command = buildCatalog({ core: CORE_COMMANDS }).commands.find((entry) => entry.name === "world items");
  assert.deepStrictEqual([command.group, command.mcp, Boolean(command.writes)], ["worlds", "world_items", false]);
  assert.ok(["--location <id>", "--item <id>", "--owner <id>", "--flag <id>", "--type <typeID|name>", "--limit N"]
    .every((flag) => command.flags.some((row) => row.flag === flag)));
});

test("a query with no place is refused with the usage, and reads nothing", async () => {
  await assert.rejects(cmdWorldItems({ owner: "5" }), /give --location <id> or --item <id>[\s\S]*usage: world items --location/);
  await assert.rejects(cmdWorldItems({ location: "x" }), /location: a positive whole number/);
});
