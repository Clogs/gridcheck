"use strict";

// What a plugin can bring to a world, and how a scenario follows a pilot it doesn't hold:
// recipes in its worlds folder, steps marked for recipes, a stop hook, several logins in a
// recipe, and a watch with pilot.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createToolRegistry } = require("../core/plugins");
const { listRecipes, loadRecipe } = require("../core/recipes");
const { validateScenario } = require("../core/scenario");

function pluginWith(t, recipe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-plugin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "worlds"));
  if (recipe) fs.writeFileSync(path.join(dir, "worlds", "two-pilots.recipe.json"), JSON.stringify(recipe));
  const step = (extra) => ({ keys: () => [], parse: () => ({}), describe: () => "a step", run: async () => ({ ok: true, text: "" }), ...extra });
  const plugin = { name: "sample", apiVersion: 1, tool: {
    steps: { build: step({ recipe: true }), look: step() },
    onStop: async () => {},
  } };
  return createToolRegistry({ active: [{ name: "sample", plugin, dir }], skipped: [] });
}

test("a plugin's worlds folder holds recipes, and a recipe may take a step marked for recipes", (t) => {
  const registry = pluginWith(t, { steps: ["fresh", { login: { user: "a" } }, "build", { login: { user: "b" } }, "build"] });
  const recipe = loadRecipe("two-pilots", { registry });
  assert.deepStrictEqual(recipe.steps.filter((step) => step.type === "login").map((step) => step.user), ["a", "b"]);
  assert.ok(listRecipes({ registry }).some((row) => row.name === "two-pilots"));
});

test("a step that isn't marked for recipes is refused in one", (t) => {
  const registry = pluginWith(t, { steps: ["fresh", "login", "look"] });
  assert.throws(() => loadRecipe("two-pilots", { registry }), /look is not a recipe step/);
});

test("a scenario still logs in first; only a recipe logs in several pilots", (t) => {
  const registry = pluginWith(t);
  const raw = { name: "x", world: "fresh", setup: ["undock", { login: { user: "a" } }], until: { timeout: 1 }, expect: ["GRID"] };
  assert.throws(() => validateScenario(raw, { registry }), /login is the first step/);
  assert.ok(validateScenario(raw, { registry, forRecipe: true }));
});

test("a plugin's stop hook is registered under its name", (t) => {
  const registry = pluginWith(t);
  assert.deepStrictEqual(registry.stopHooks.map((hook) => hook.plugin), ["sample"]);
  assert.strictEqual(typeof registry.stopHooks[0].run, "function");
});

test("a watch that follows a pilot has no client view", (t) => {
  const registry = pluginWith(t);
  const base = { name: "x", world: "fresh", setup: ["login"], until: { timeout: 1 }, expect: ["GRID"] };
  assert.strictEqual(validateScenario({ ...base, watch: { pilot: "a" } }, { registry }).watch.client, "off");
  assert.throws(() => validateScenario({ ...base, watch: { pilot: "a", client: "all" } }, { registry }), /a followed pilot has no client view/);
  assert.throws(() => validateScenario({ ...base, watch: { pilot: "" } }, { registry }), /the account whose pilot to follow/);
});
