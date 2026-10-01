"use strict";

// Plugins: plugins/<name>/plugin.js beside the core, and nothing else is
// scanned. A plugin exports
//
//   { name, apiVersion, applies(tree), server(ctx), tool }
//
// applies(tree) decides whether the plugin's mod is in this tree. One that
// doesn't apply logs one line and loads nothing more, on either side: the
// bridge doesn't run its server half (bridge/plugins.js) and the CLI, the
// scenarios and the MCP server don't offer its tool half. This file loads
// plugins for both sides and merges the tool halves into one registry.
//
// A tool half is plain data and functions, every key optional:
//
//   kinds        { KIND: fields }           event kinds and their field schemas (conditions.js)
//   self         { KIND: (event) => bool }  what a bare `self` means for a kind
//   extFields    fields                     the plugin's data on core events, at ext.<name>
//   format       { KIND: (event, help) => [body, tail] }   timeline lines
//   tag(ext)     -> text                    the tail of a core event's line
//   owner(ext)   -> text                    who a group of balls belongs to
//   ids(event)   -> [id]                    IDs a log line may name, so the watch keeps it
//   costText(costs) -> text                 the plugin's share of a watch's END line
//   steps        { name: step }             scenario steps (scenario.js)
//   commands     { name: command }          CLI subcommands (bin/e2e.js)
//   handles      { command: { flags, run } } core commands the plugin takes over for some flags
//   mcpTools     [tool]                     MCP tools, named e2e_<plugin>_<name> (bin/mcp.js)
//   primer       text                       appended to the MCP instructions
//   colours      [{ match, colour, label }] frames and viewer, matched on the ball's plugin data
//   upFlags      { key: flag }              `e2e up` options, also scenario `up` keys and e2e_up arguments
//   upNote(values) -> text                  printed after `e2e up` with any of them set
//   listeners    { name: { offset, env, label } }   ports in the tree's block
//   logTags      [tag]                      server log tags the watch keeps by default
//   world        { onSave(ctx), onRestore(ctx) }    saved-world hooks (worlds.js)
//   targetFields { term: field }            `e2e act` target terms read from the plugin's data
//
// Each consumer documents the shape it reads.

const fs = require("node:fs");
const path = require("node:path");

const API_VERSION = 1;
const DEFAULT_PLUGINS_DIR = path.join(__dirname, "..", "plugins");
// tools/evejs-e2e/core -> the tree the copy is vendored into.
const DEFAULT_TREE_ROOT = path.resolve(__dirname, "..", "..", "..");

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

// A module path under server/src, as a file, a .js file or a folder; null when
// the tree has none. Plugins decide whether they apply with it.
function resolveUnder(serverRoot) {
  const srcRoot = path.join(serverRoot, "src");
  return (relativePath) => {
    const base = path.join(srcRoot, relativePath);
    for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
}

function treeAt(treeRoot, serverRoot = path.join(treeRoot, "server")) {
  return { treeRoot, serverRoot, resolve: resolveUnder(serverRoot) };
}

function appliesResult(answer) {
  if (answer === true) return { ok: true };
  if (answer && typeof answer === "object" && answer.ok === true) return { ok: true };
  const reason = answer && typeof answer === "object" && answer.reason ? String(answer.reason) : "applies() said no";
  return { ok: false, reason };
}

// -> { active: [{ name, plugin, dir }], skipped: [{ name, reason }] }
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
    if (!/^[a-z][a-z0-9]*$/.test(name)) {
      skip(name, "a plugin name is lower-case letters and digits, starting with a letter");
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
    active.push({ name, plugin, dir: path.dirname(file) });
  }
  return { active, skipped };
}

// Where a core event keeps a plugin's data. Until the watch writes ext, the
// data sits at the plugin's own name.
function extOf(event, plugin) {
  if (!event) return undefined;
  if (event.ext && typeof event.ext === "object" && event.ext[plugin] !== undefined) return event.ext[plugin];
  return event[plugin];
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The tool halves of the active plugins, merged. The first plugin to claim a
// name keeps it; later claims are dropped with a warning. Core names are the
// consumers' to protect (conditions.js, scenario.js, e2e.js, mcp.js).
function createToolRegistry(loaded = { active: [], skipped: [] }) {
  const registry = {
    plugins: [],
    skipped: [...(loaded.skipped || [])],
    warnings: [],
    kinds: {},
    selfTests: {},
    extFields: {},
    formatters: {},
    tags: [],
    owners: [],
    costTexts: [],
    steps: {},
    commands: {},
    handlers: {},
    mcpTools: [],
    primers: [],
    colours: [],
    upFlags: [],
    upNotes: [],
    listeners: [],
    logTags: [],
    worldHooks: [],
    targetFields: {},
    scenarioDirs: [],
    booleanFlags: new Set(),
  };
  const warn = (message) => registry.warnings.push(message);
  registry.warn = warn;
  const claim = (table, key, value, owner, what) => {
    if (table[key] !== undefined) {
      warn(`plugin ${owner}: ${what} ${key} is taken by plugin ${table[key].plugin}`);
      return;
    }
    table[key] = { ...value, plugin: owner };
  };

  for (const { name, plugin, dir } of loaded.active || []) {
    let tool;
    try {
      tool = plugin.tool;
    } catch (error) {
      registry.skipped.push({ name, reason: `tool failed to load: ${errorText(error)}` });
      continue;
    }
    registry.plugins.push({ name, dir: dir || null, tool: tool || {} });
    if (dir && fs.existsSync(path.join(dir, "scenarios"))) registry.scenarioDirs.push({ plugin: name, dir: path.join(dir, "scenarios") });
    if (!isObject(tool)) continue;
    for (const [kind, fields] of Object.entries(tool.kinds || {})) {
      if (!/^[A-Z][A-Z_]*$/.test(kind)) {
        warn(`plugin ${name}: event kind ${kind} must be upper case`);
        continue;
      }
      claim(registry.kinds, kind, { fields }, name, "event kind");
    }
    for (const [kind, test] of Object.entries(tool.self || {})) {
      if (typeof test === "function" && registry.kinds[kind] && registry.kinds[kind].plugin === name) registry.selfTests[kind] = test;
    }
    if (isObject(tool.extFields)) registry.extFields[name] = tool.extFields;
    for (const [kind, format] of Object.entries(tool.format || {})) {
      if (typeof format === "function" && registry.kinds[kind] && registry.kinds[kind].plugin === name) {
        registry.formatters[kind] = format;
      }
    }
    if (typeof tool.tag === "function") registry.tags.push({ plugin: name, tag: tool.tag });
    if (typeof tool.owner === "function") registry.owners.push({ plugin: name, owner: tool.owner });
    if (typeof tool.costText === "function") registry.costTexts.push(tool.costText);
    for (const [stepName, step] of Object.entries(tool.steps || {})) {
      if (isObject(step) && typeof step.run === "function") claim(registry.steps, stepName, step, name, "step");
    }
    for (const [commandName, command] of Object.entries(tool.commands || {})) {
      if (!isObject(command) || typeof command.run !== "function") continue;
      claim(registry.commands, commandName, command, name, "command");
      for (const flag of command.booleanFlags || []) registry.booleanFlags.add(flag);
    }
    for (const [commandName, handler] of Object.entries(tool.handles || {})) {
      if (!isObject(handler) || typeof handler.run !== "function" || !Array.isArray(handler.flags)) continue;
      (registry.handlers[commandName] = registry.handlers[commandName] || []).push({ ...handler, plugin: name });
      for (const flag of handler.booleanFlags || []) registry.booleanFlags.add(flag);
    }
    for (const mcpTool of tool.mcpTools || []) {
      if (!isObject(mcpTool) || !/^[a-z][a-z0-9_]*$/.test(String(mcpTool.name || "")) || typeof mcpTool.args !== "function") {
        warn(`plugin ${name}: an MCP tool needs a lower-case name and args(params)`);
        continue;
      }
      registry.mcpTools.push({ ...mcpTool, plugin: name, name: `e2e_${name}_${mcpTool.name}` });
    }
    if (typeof tool.primer === "string" && tool.primer.trim()) registry.primers.push({ plugin: name, text: tool.primer.trim() });
    for (const rule of tool.colours || []) {
      if (isObject(rule) && isObject(rule.match) && /^#[0-9a-f]{6}$/i.test(String(rule.colour || ""))) {
        registry.colours.push({ plugin: name, match: rule.match, colour: rule.colour, label: rule.label || null });
      }
    }
    for (const [key, flag] of Object.entries(tool.upFlags || {})) {
      if (!isObject(flag) || !["bool", "number"].includes(flag.type) || !flag.flag) continue;
      if (registry.upFlags.some((other) => other.key === key || other.flag === flag.flag)) {
        warn(`plugin ${name}: up flag ${key} is taken`);
        continue;
      }
      registry.upFlags.push({ ...flag, key, plugin: name });
      if (flag.type === "bool") registry.booleanFlags.add(flag.flag);
    }
    if (typeof tool.upNote === "function") registry.upNotes.push(tool.upNote);
    for (const [listener, spec] of Object.entries(tool.listeners || {})) {
      if (isObject(spec) && Number.isInteger(spec.offset)) registry.listeners.push({ ...spec, name: listener, plugin: name });
    }
    for (const tag of tool.logTags || []) {
      if (/^\w+$/.test(String(tag)) && !registry.logTags.includes(tag)) registry.logTags.push(String(tag));
    }
    if (isObject(tool.world)) registry.worldHooks.push({ ...tool.world, plugin: name });
    for (const [term, field] of Object.entries(tool.targetFields || {})) {
      if (typeof field === "string") claim(registry.targetFields, term, { field }, name, "target term");
    }
  }
  return registry;
}

function emptyRegistry() {
  return createToolRegistry({ active: [], skipped: [] });
}

let cachedRegistry = null;

// The registry for the tree this copy sits in, loaded once per process.
function defaultRegistry() {
  if (!cachedRegistry) cachedRegistry = createToolRegistry(loadPlugins({ tree: treeAt(DEFAULT_TREE_ROOT) }));
  return cachedRegistry;
}

module.exports = {
  API_VERSION,
  DEFAULT_PLUGINS_DIR,
  DEFAULT_TREE_ROOT,
  createToolRegistry,
  defaultRegistry,
  emptyRegistry,
  extOf,
  loadPlugins,
  resolveUnder,
  treeAt,
};
