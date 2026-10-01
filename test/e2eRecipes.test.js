"use strict";

// World recipes (core/recipes.js): reading one, refusing what a recipe can't
// do, the fingerprint a built world keeps and when it's stale, and a scenario
// that names a recipe. Building one boots a server; that's the compatibility
// lane's job (test/compat.js).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const recipes = require("../core/recipes");
const worlds = require("../core/worlds");
const { validateScenario } = require("../core/scenario");
const { createToolRegistry } = require("../core/plugins");

const registry = createToolRegistry({ active: [], skipped: [] });
const SYSTEMS = { amamake: 30002537, siseide: 30002539, rens: 30002510 };
const resolveSystemID = (text) => {
  const id = SYSTEMS[String(text).toLowerCase()];
  if (!id) throw new Error(`no solar system named ${text}`);
  return id;
};

function withDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-recipes-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRecipe(dir, name, raw) {
  const file = path.join(dir, `${name}.recipe.json`);
  fs.writeFileSync(file, typeof raw === "string" ? raw : `${JSON.stringify(raw, null, 2)}\n`);
  return file;
}

test("the starter recipe loads and reads as the steps that build it", () => {
  const recipe = recipes.loadRecipe("starter", { resolveSystemID, registry });
  assert.strictEqual(recipe.name, "starter");
  assert.match(recipe.sha256, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(recipes.describeRecipe(recipe, registry), [
    "fresh",
    "login",
    "slash /allskills",
    "loadout Tristan: 7 module(s), 5 drone(s), Antimatter Charge S loaded, 1 cargo stack(s)",
    "slash /tr me 60004603",
  ]);
  assert.deepStrictEqual(recipes.listRecipes().map((row) => row.name), ["starter"]);
});

test("a recipe's teleport resolves its system when the recipe is read", () => withDir((dir) => {
  writeRecipe(dir, "lowsec", { steps: ["fresh", "undock", { teleport: "Amamake" }, { wait: 5 }, "dock"] });
  const recipe = recipes.loadRecipe("lowsec", { dir, resolveSystemID, registry });
  assert.strictEqual(recipe.steps.find((step) => step.type === "teleport").systemID, 30002537);
  assert.deepStrictEqual(recipes.describeRecipe(recipe, registry), ["fresh", "undock", "teleport Amamake", "wait 5s", "dock"],
    "the implicit login isn't listed");
}));

test("a recipe starts fresh, takes only recipe steps, and names the step that is wrong", () => withDir((dir) => {
  const load = (name) => () => recipes.loadRecipe(name, { dir, resolveSystemID, registry });
  writeRecipe(dir, "no-fresh", { steps: ["login"] });
  assert.throws(load("no-fresh"), /steps\[0\]: "fresh"/);
  writeRecipe(dir, "watching", { steps: ["fresh", "undock", { lock: "nearest npc" }, { waitFor: "GRID" }] });
  assert.throws(load("watching"), /steps\[2\]: lock is not a recipe step[\s\S]*steps\[3\]: waitFor is not a recipe step/);
  writeRecipe(dir, "bad-steps", { description: 3, steps: ["fresh", { teleport: "Nowhere" }, { loadout: { ship: "Tristan", rigs: [] } }], extra: 1 });
  let error;
  try {
    load("bad-steps")();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof recipes.RecipeError);
  assert.match(error.message, /extra: unknown key/);
  assert.match(error.message, /description: a string/);
  assert.match(error.message, /steps\[1\]: no solar system named Nowhere/, "indexes count the fresh step");
  assert.match(error.message, /steps\[2\]\.loadout: rigs: unknown key/);
  writeRecipe(dir, "broken", "{ not json");
  assert.throws(load("broken"), /not valid JSON/);
  assert.throws(load("missing"), /no such recipe \(recipes: bad-steps, broken, no-fresh, watching\)/);
}));

test("a built world is stale when its recipe, the tree's commit, its patches or the tool change", () => {
  const recipe = { sha256: "a".repeat(64) };
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-recipe-tree-"));
  try {
    const fingerprint = recipes.recipeFingerprint({ recipe, treeRoot: tree, tool: { commit: "1d9b4ac1" },
      patches: [{ id: "xmpp-port", state: "applied" }, { id: "last-decision", state: "absent" }] });
    assert.deepStrictEqual(fingerprint, { recipe: "a".repeat(64), tree: null, tool: "1d9b4ac1",
      patches: "last-decision=absent,xmpp-port=applied" }, "a tree that isn't a git checkout has no commit; its patches stand in");
    assert.strictEqual(recipes.recipeStale({ recipe: fingerprint }, fingerprint), null);
    assert.strictEqual(recipes.recipeStale(null, fingerprint), "it hasn't been built");
    assert.match(recipes.recipeStale({ note: "by hand" }, fingerprint), /saved by hand/);
    assert.strictEqual(recipes.recipeStale({ recipe: { ...fingerprint, recipe: "b" } }, fingerprint), "the recipe changed");
    assert.strictEqual(recipes.recipeStale({ recipe: { ...fingerprint, tree: "abc" } }, fingerprint), "the tree's commit changed");
    assert.strictEqual(recipes.recipeStale({ recipe: { ...fingerprint, tool: "old" } }, fingerprint), "the vendored tool changed");
    assert.strictEqual(recipes.recipeStale({ recipe: { ...fingerprint, patches: "" } }, fingerprint), "the tree's patches changed");
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a saved world keeps the fingerprint of the recipe that built it", () => withDir((root) => {
  const store = path.join(root, "_local", "gameStore");
  fs.mkdirSync(store, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(store, "gamestore.sqlite"));
  db.exec("CREATE TABLE t (x)");
  db.close();
  fs.writeFileSync(path.join(store, "manifest.json"), "{}\n");
  const fingerprint = { recipe: "c".repeat(64), tree: null, tool: null, patches: "" };
  worlds.saveWorld(root, "starter", { recipe: fingerprint, note: "built from recipe starter" });
  assert.deepStrictEqual(worlds.savedWorldInfo(root, "starter").recipe, fingerprint);
  assert.strictEqual(worlds.savedWorldInfo(root, "other"), null);
  worlds.saveWorld(root, "by-hand", {});
  assert.deepStrictEqual(worlds.listWorlds(root).map((row) => [row.name, row.recipe]), [["by-hand", false], ["starter", true]]);
}));

test("a scenario names a world or a recipe, and a recipe's world is the recipe's name", () => {
  const base = { name: "t", setup: ["undock"], until: { timeout: 5 }, expect: ["GRID"] };
  const context = { registry, recipeExists: (name) => name === "starter" };
  const scenario = validateScenario({ ...base, recipe: "starter" }, context);
  assert.strictEqual(scenario.world, "starter");
  assert.strictEqual(scenario.recipe, "starter");
  assert.strictEqual(validateScenario({ ...base, world: "fresh" }, context).recipe, null);
  assert.throws(() => validateScenario({ ...base, recipe: "starter", world: "fresh" }, context), /recipe: a scenario starts from a world or a recipe, not both/);
  assert.throws(() => validateScenario({ ...base, recipe: "nope" }, context), /recipe: no world recipe "nope"/);
  assert.throws(() => validateScenario(base, context), /world: the saved world to start from .* or a "recipe" instead/);
});
