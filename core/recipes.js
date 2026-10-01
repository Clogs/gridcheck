"use strict";

// World recipes: a starting world the tool builds instead of a world file it
// ships. worlds/<name>.recipe.json lists the steps from a fresh game store:
//
//   { "description": "...",
//     "steps": ["fresh", "login", { "slash": "/allskills" },
//               { "loadout": { "ship": "Tristan", ... } }, "undock",
//               { "teleport": "Amamake" }, "dock"] }
//
// `e2e world build <recipe>` boots a fresh world, runs the steps and saves the
// world under the recipe's name. The saved world.json keeps a fingerprint of
// what built it; a scenario that names the recipe ("recipe": "starter") gets
// the world rebuilt when the fingerprint no longer matches (recipeStale).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { validateScenario, describeStep } = require("./scenario");
const { defaultRegistry } = require("./plugins");

const RECIPE_DIR = path.join(__dirname, "..", "worlds");
const SUFFIX = ".recipe.json";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The steps a recipe may take after "fresh": what puts a character somewhere
// with something, nothing that watches.
const RECIPE_STEPS = Object.freeze(["login", "undock", "dock", "slash", "teleport", "loadout", "wait"]);
const RECIPE_KEYS = new Set(["description", "steps"]);

class RecipeError extends Error {}

function recipePath(nameOrPath, { dir = RECIPE_DIR } = {}) {
  const text = String(nameOrPath || "");
  if (text.endsWith(".json") || text.includes("/") || text.includes("\\")) return path.resolve(text);
  return path.join(dir, `${text}${SUFFIX}`);
}

function recipeName(file) {
  const base = path.basename(file);
  return base.endsWith(SUFFIX) ? base.slice(0, -SUFFIX.length) : path.basename(base, ".json");
}

function recipeExists(nameOrPath, options = {}) {
  return fs.existsSync(recipePath(nameOrPath, options));
}

// -> { name, file, description, steps, sha256 }, or a RecipeError listing every problem.
function loadRecipe(nameOrPath, { dir = RECIPE_DIR, resolveSystemID = (text) => text, registry = defaultRegistry() } = {}) {
  const file = recipePath(nameOrPath, { dir });
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    const known = listRecipes({ dir }).map((row) => row.name);
    throw new RecipeError(`${file}: ${error.code === "ENOENT" ? `no such recipe${known.length ? ` (recipes: ${known.join(", ")})` : ""}` : error.message}`);
  }
  const name = recipeName(file);
  const problems = [];
  if (!NAME_PATTERN.test(name)) problems.push(`the file name: a recipe's name is the world it saves, so letters, digits, '.', '_' and '-'`);
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new RecipeError(`${file}: not valid JSON: ${error.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RecipeError(`${file}: a recipe is a JSON object`);
  for (const key of Object.keys(raw)) if (!RECIPE_KEYS.has(key)) problems.push(`${key}: unknown key; a recipe has description and steps`);
  if (raw.description !== undefined && typeof raw.description !== "string") problems.push("description: a string");
  const list = Array.isArray(raw.steps) ? raw.steps : null;
  if (!list) problems.push('steps: a list that starts with "fresh"');
  else if (list[0] !== "fresh") problems.push('steps[0]: "fresh"; a recipe builds from a new game store');
  let steps = [];
  if (list && list[0] === "fresh") {
    // The steps read as a scenario's setup does, so a recipe and a scenario
    // take the same step syntax and give the same errors.
    const rest = list.slice(1);
    const foreign = [];
    for (const [index, entry] of rest.entries()) {
      const type = typeof entry === "string" ? entry : entry && typeof entry === "object" ? Object.keys(entry)[0] : null;
      if (type && !RECIPE_STEPS.includes(type)) foreign.push(`steps[${index + 1}]: ${type} is not a recipe step; recipes take ${RECIPE_STEPS.join(", ")}`);
    }
    problems.push(...foreign);
    if (!foreign.length) {
      try {
        steps = validateScenario({ name, world: "fresh", setup: rest, until: { timeout: 1 }, expect: ["GRID"] },
          { source: file, resolveSystemID, registry }).setup;
      } catch (error) {
        for (const line of error.problems || [error.message]) {
          problems.push(line.replace(/^setup\[(\d+)\]/, (_match, index) => `steps[${Number(index) + 1}]`));
        }
      }
    }
  }
  if (problems.length) throw new RecipeError(`${file}:\n  ${problems.join("\n  ")}`);
  return {
    name,
    file,
    description: raw.description || "",
    steps,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function listRecipes({ dir = RECIPE_DIR } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(SUFFIX)).sort();
  } catch (_error) {
    return [];
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return { name: recipeName(file), file, description: String(raw.description || "") };
    } catch (error) {
      return { name: recipeName(file), file, description: `(unreadable: ${error.message})` };
    }
  });
}

// The tree's HEAD, when the tree is a git checkout; the unpacked zip isn't.
function treeCommit(treeRoot) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: treeRoot, encoding: "utf8", windowsHide: true });
  return head.error || head.status !== 0 ? null : head.stdout.trim() || null;
}

// What a built world depends on: the recipe, the tree's code (its commit, and
// the patches, which change it without one), and the tool that built it.
// tool: copyInfo() (core/capabilities.js); patches: patchStates rows.
function recipeFingerprint({ recipe, treeRoot, tool = null, patches = [] }) {
  return {
    recipe: recipe.sha256,
    tree: treeCommit(treeRoot),
    tool: tool && tool.commit ? tool.commit : null,
    patches: patches.map((row) => `${row.id}=${row.state}`).sort().join(","),
  };
}

const FINGERPRINT_PARTS = Object.freeze([
  ["recipe", "the recipe changed"],
  ["tree", "the tree's commit changed"],
  ["tool", "the vendored tool changed"],
  ["patches", "the tree's patches changed"],
]);

// saved: the world's world.json (null when there is no saved world).
// -> null when the saved world is current, else why it has to be built.
function recipeStale(saved, fingerprint) {
  if (!saved) return "it hasn't been built";
  if (!saved.recipe) return "a world of that name was saved by hand, not built from the recipe";
  for (const [key, why] of FINGERPRINT_PARTS) {
    if ((saved.recipe[key] || null) !== (fingerprint[key] || null)) return why;
  }
  return null;
}

function describeRecipe(recipe, registry = defaultRegistry()) {
  return ["fresh", ...recipe.steps.filter((step) => !step.implicit).map((step) => describeStep(step, registry))];
}

module.exports = {
  RECIPE_DIR,
  RECIPE_STEPS,
  RecipeError,
  describeRecipe,
  listRecipes,
  loadRecipe,
  recipeExists,
  recipeFingerprint,
  recipePath,
  recipeStale,
  treeCommit,
};
