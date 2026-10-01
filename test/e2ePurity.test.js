"use strict";

// The core knows no mod. Everything a mod adds reaches the CLI, the scenarios,
// the MCP server and the bridge through its plugin (core/plugins.js,
// bridge/plugins.js), so nothing outside plugins/ may name the Living Universe
// plugin's identifiers, in code or in comments.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CORE_DIRS = ["core", "bridge", "bin", "scenarios"];
const BANNED = [/living[ _-]?universe/i, /pirate/i, /flightID/i, /hunt/i, /luMonitor/i, /EVEJS_LIVING_/i];

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(file));
    else if (/\.(js|json|html|css)$/.test(entry.name)) out.push(file);
  }
  return out;
}

test("core, bridge, bin and the core scenarios name nothing of the lu plugin", () => {
  const hits = [];
  for (const dir of CORE_DIRS) {
    for (const file of filesUnder(path.join(ROOT, dir))) {
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
        for (const pattern of BANNED) {
          if (pattern.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}: ${pattern} in ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
  assert.deepStrictEqual(hits, []);
});

test("the core requires nothing from plugins/ except through the loader", () => {
  const hits = [];
  for (const dir of CORE_DIRS) {
    for (const file of filesUnder(path.join(ROOT, dir)).filter((name) => name.endsWith(".js"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        if (/(^|\/)plugins\//.test(match[1])) hits.push(`${path.relative(ROOT, file)}: require("${match[1]}")`);
      }
    }
  }
  assert.deepStrictEqual(hits, []);
});
