"use strict";

// Plugins: plugins/<name>/plugin.js beside the core, and nothing else is
// scanned. A plugin exports { name, apiVersion, applies(tree), server(ctx) }.
// One that doesn't apply to this tree logs one line and loads nothing more,
// so a plugin's mod-specific requires live behind its server() only.
//
// server(ctx) answers the hooks the bridge calls:
//   annotate(entity, { row, nowMs, characterID }) -> { groupKey, ext } | null
//       per grid row; ext lands on row.ext[<plugin>]
//   offGrid.watch({ characterID, startedAtMs }) -> { scan(systemID, context) -> { events, stats } }
//       one scanner per watch, run every offGridEveryMs while in space
//   routes: { "POST /trigger/*": ({ query, body, route, rest }) -> reply }
//   stop()
// The watch times every hook and reports each in END costs.hooks.

const fs = require("node:fs");
const path = require("node:path");

const API_VERSION = 1;
const DEFAULT_PLUGINS_DIR = path.join(__dirname, "..", "plugins");

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function appliesResult(answer) {
  if (answer === true) return { ok: true };
  if (answer && typeof answer === "object" && answer.ok === true) return { ok: true };
  const reason = answer && typeof answer === "object" && answer.reason ? String(answer.reason) : "applies() said no";
  return { ok: false, reason };
}

// -> { active: [{ name, plugin }], skipped: [{ name, reason }] }
function loadPlugins({ pluginsDir = DEFAULT_PLUGINS_DIR, tree, log = null, load = require } = {}) {
  const active = [];
  const skipped = [];
  const skip = (name, reason) => {
    skipped.push({ name, reason });
    if (log) log.info(`[AgentBridge] plugin ${name} skipped: ${reason}`);
  };
  const entries = fs.existsSync(pluginsDir)
    ? fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  for (const dirName of entries) {
    const file = path.join(pluginsDir, dirName, "plugin.js");
    if (!fs.existsSync(file)) continue;
    let plugin;
    try {
      plugin = load(file);
    } catch (error) {
      skip(dirName, `plugin.js failed to load: ${errorText(error)}`);
      continue;
    }
    const name = plugin && plugin.name ? String(plugin.name) : dirName;
    if (!plugin || plugin.apiVersion !== API_VERSION) {
      skip(name, `apiVersion ${plugin ? plugin.apiVersion : "missing"}, this core speaks ${API_VERSION}`);
      continue;
    }
    if (active.some((other) => other.name === name)) {
      skip(name, "another plugin has that name");
      continue;
    }
    let verdict;
    try {
      verdict = appliesResult(typeof plugin.applies === "function" ? plugin.applies(tree) : true);
    } catch (error) {
      verdict = { ok: false, reason: `applies() threw: ${errorText(error)}` };
    }
    if (!verdict.ok) {
      skip(name, verdict.reason);
      continue;
    }
    active.push({ name, plugin });
  }
  return { active, skipped };
}

// Calls each active plugin's server(ctx). A plugin that throws here is moved
// to skipped, so one broken plugin never stops the bridge.
function startPlugins(loaded, ctx, { log = null } = {}) {
  const hooks = [];
  const skipped = [...loaded.skipped];
  for (const { name, plugin } of loaded.active) {
    if (typeof plugin.server !== "function") {
      hooks.push({ name });
      continue;
    }
    try {
      const answer = plugin.server({ ...ctx, plugin: name }) || {};
      hooks.push({
        name,
        annotate: typeof answer.annotate === "function" ? answer.annotate : null,
        offGrid: answer.offGrid && typeof answer.offGrid.watch === "function" ? answer.offGrid : null,
        routes: answer.routes && typeof answer.routes === "object" ? answer.routes : {},
        stop: typeof answer.stop === "function" ? answer.stop : null,
      });
      if (log) log.info(`[AgentBridge] plugin ${name} active`);
    } catch (error) {
      skipped.push({ name, reason: `server() threw: ${errorText(error)}` });
      if (log) log.warn(`[AgentBridge] plugin ${name} skipped: server() threw: ${errorText(error)}`);
    }
  }
  return { hooks, skipped };
}

function stopPlugins(hooks, log = null) {
  for (const hook of hooks) {
    if (!hook.stop) continue;
    try {
      hook.stop();
    } catch (error) {
      if (log) log.warn(`[AgentBridge] plugin ${hook.name} stop() threw: ${errorText(error)}`);
    }
  }
}

module.exports = {
  API_VERSION,
  DEFAULT_PLUGINS_DIR,
  loadPlugins,
  startPlugins,
  stopPlugins,
};
