"use strict";

// The coding agents on this machine that can run the tool's MCP server, and
// their config for it. Claude Code reads the tree's .mcp.json, so its entry
// names the copy relative to the tree. Codex reads one config.toml for every
// folder, so its entry names this tree's copy by absolute path. `gridcheck agents`
// reports, `gridcheck agents setup` writes, and the GUI's Install tab runs that
// command (core/gui.js).
//
// A setup only adds. It never edits another server's entry or reformats the
// Codex file. The one entry it replaces is a Codex `gridcheck` whose mcp.js no
// longer exists. Guide: docs/GUIDE.md "Setting up agents".

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// cli is any other agent: it gets a pointer to docs/CLI.md in the tree's
// AGENTS.md (or CLAUDE.md), not an MCP server, and is never set up unasked.
const AGENT_IDS = Object.freeze(["claude", "codex", "cli"]);
const AGENT_NAMES = Object.freeze({ claude: "Claude Code", codex: "Codex", cli: "Other agents (CLI)" });
const CLI_GUIDE = "tools/gridcheck/docs/CLI.md";
const CLI_MARKER = "gridcheck:cli";
const CLI_POINTER = Object.freeze([
  `<!-- ${CLI_MARKER} -->`,
  "**In-game checks:** to verify or debug anything a player would see on grid (ships, NPCs, combat, slash",
  `commands) without the EVE client, follow \`${CLI_GUIDE}\`.`,
  `<!-- /${CLI_MARKER} -->`,
]);
const agentList = () => `${AGENT_IDS.slice(0, -1).join(", ")} and ${AGENT_IDS.at(-1)}`;
const MCP_IN_TREE = Object.freeze(["tools", "gridcheck", "bin", "mcp.js"]);
const SERVER_NAME = "gridcheck";
const CLAUDE_FALLBACK_NAME = "gridcheck-tool";
// Before the rename the copy was tools/evejs-e2e. An entry that runs the old
// copy's mcp.js is this tree's, and setup replaces it.
const LEGACY_MCP_IN_TREE = "tools/evejs-e2e/bin/mcp.js";
// A scenario run blocks its tool call for minutes; Codex's default cuts it off.
const CODEX_TOOL_TIMEOUT_SEC = 600;

class AgentsError extends Error {}

const slashed = (file) => String(file).split(path.sep).join("/");

function systemIO() {
  return {
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    exists: (file) => {
      try {
        return fs.existsSync(file);
      } catch (_error) {
        return false;
      }
    },
    readFile: (file) => fs.readFileSync(file, "utf8"),
  };
}

const ioFrom = (given = {}) => ({ ...systemIO(), ...given });

function samePath(a, b, platform) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function onPath(name, io) {
  const windows = io.platform === "win32";
  const dirs = String(io.env.PATH || io.env.Path || "").split(windows ? ";" : ":").filter(Boolean);
  // Windows paths ignore case; lower-case reads as the file is usually named.
  const extensions = windows ? String(io.env.PATHEXT || ".EXE;.CMD;.BAT").toLowerCase().split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const file = path.join(dir, `${name}${extension}`);
      if (io.exists(file)) return file;
    }
  }
  return null;
}

function codexHome(io) {
  const configured = String(io.env.CODEX_HOME || "").trim();
  return configured ? path.resolve(configured) : path.join(io.home, ".codex");
}

function mcpPath(treeRoot) {
  return path.join(treeRoot, ...MCP_IN_TREE);
}

// -> { claude: { installed, evidence: [text] }, codex: { ... } }
function detectAgents(given) {
  const io = ioFrom(given);
  const claudeBin = onPath("claude", io);
  const claude = [
    claudeBin && `claude on PATH (${slashed(claudeBin)})`,
    io.exists(path.join(io.home, ".claude")) && "~/.claude",
    io.exists(path.join(io.home, ".claude.json")) && "~/.claude.json",
  ].filter(Boolean);
  const codexBin = onPath("codex", io);
  const home = codexHome(io);
  const codex = [
    codexBin && `codex on PATH (${slashed(codexBin)})`,
    io.exists(home) && (String(io.env.CODEX_HOME || "").trim() ? `CODEX_HOME (${slashed(home)})` : "~/.codex"),
  ].filter(Boolean);
  return { claude: { installed: claude.length > 0, evidence: claude }, codex: { installed: codex.length > 0, evidence: codex },
    cli: { installed: false, evidence: [] } };
}

// ---------- Claude Code: the tree's .mcp.json ----------

function planClaude(treeRoot, given) {
  const io = ioFrom(given);
  const file = path.join(treeRoot, ".mcp.json");
  const text = io.exists(file) ? io.readFile(file) : null;
  let json = null;
  if (text !== null && text.trim()) {
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new AgentsError(`${slashed(file)} is not JSON (${error.message}); fix or remove it first`);
    }
    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    if (!isObject(json) || (json.mcpServers !== undefined && !isObject(json.mcpServers))) {
      throw new AgentsError(`${slashed(file)} is not an object with an mcpServers object, which is what Claude Code reads; fix it first`);
    }
  }
  const servers = (json && json.mcpServers) || {};
  const ours = (entry) => entry && Array.isArray(entry.args) && entry.args.some((arg) => typeof arg === "string" &&
    /mcp\.js$/i.test(arg) && samePath(path.resolve(treeRoot, arg), mcpPath(treeRoot), io.platform));
  const found = Object.entries(servers).find(([, entry]) => ours(entry));
  if (found) return { agent: "claude", file, change: "none", serverName: found[0] };
  const legacyPath = path.join(treeRoot, ...LEGACY_MCP_IN_TREE.split("/"));
  const legacy = Object.keys(servers).filter((key) => {
    const entry = servers[key];
    return entry && Array.isArray(entry.args) && entry.args.some((arg) => typeof arg === "string" &&
      samePath(path.resolve(treeRoot, arg), legacyPath, io.platform));
  });
  const kept = Object.fromEntries(Object.entries(servers).filter(([key]) => !legacy.includes(key)));
  const serverName = !kept[SERVER_NAME] ? SERVER_NAME : !kept[CLAUDE_FALLBACK_NAME] ? CLAUDE_FALLBACK_NAME : null;
  if (!serverName) {
    throw new AgentsError(`${slashed(file)} already has servers named ${SERVER_NAME} and ${CLAUDE_FALLBACK_NAME} that aren't ` +
      "this tree's; rename one first");
  }
  const entry = { type: "stdio", command: "node", args: [MCP_IN_TREE.join("/")] };
  const eol = text && text.includes("\r\n") ? "\r\n" : "\n";
  const after = `${JSON.stringify({ ...(json || {}), mcpServers: { ...kept, [serverName]: entry } }, null, 2)}\n`.replace(/\n/g, eol);
  const added = JSON.stringify({ [serverName]: entry }, null, 2).split("\n").slice(1, -1);
  if (legacy.length) {
    const replaced = JSON.stringify(Object.fromEntries(legacy.map((key) => [key, servers[key]])), null, 2).split("\n").slice(1, -1);
    return { agent: "claude", file, change: "replace", serverName, before: text, after, added, replaced,
      gone: LEGACY_MCP_IN_TREE };
  }
  return { agent: "claude", file, change: "add", serverName, before: text, after, added };
}

// ---------- Codex: config.toml ----------

// A table header ([a.b."c"], [a.'b']) as its key path; anything else,
// array tables ([[x]]) included, is null.
function headerKeys(line) {
  const match = /^\s*\[(?!\[)(.*)\]\s*(#.*)?$/.exec(line);
  if (!match) return null;
  const keys = [];
  let rest = match[1].trim();
  while (rest) {
    let quoted;
    if (rest[0] === "\"") {
      quoted = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      if (!quoted) return null;
      keys.push(quoted[1].replace(/\\(.)/g, "$1"));
    } else if (rest[0] === "'") {
      quoted = /^'([^']*)'/.exec(rest);
      if (!quoted) return null;
      keys.push(quoted[1]);
    } else {
      quoted = /^[A-Za-z0-9_-]+/.exec(rest);
      if (!quoted) return null;
      keys.push(quoted[0]);
    }
    rest = rest.slice(quoted[0].length).trim();
    if (!rest) break;
    if (rest[0] !== ".") return null;
    rest = rest.slice(1).trim();
  }
  return keys.length ? keys : null;
}

// Lines with their own endings, so untouched lines are written back byte for byte.
function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function stringsIn(text) {
  const out = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(["\\])/g, "$1") : match[2]);
  }
  return out;
}

const tomlString = (text) => JSON.stringify(text);

function codexBlock(name, treeRoot) {
  return [
    `[mcp_servers.${name}]`,
    "command = \"node\"",
    `args = [${tomlString(slashed(mcpPath(treeRoot)))}]`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
  ];
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tree";
}

function planCodex(treeRoot, given) {
  const io = ioFrom(given);
  const file = path.join(codexHome(io), "config.toml");
  const text = io.exists(file) ? io.readFile(file) : null;
  const lines = text === null ? [] : splitLines(text);
  const tables = [];
  lines.forEach((line, index) => {
    const keys = headerKeys(line.replace(/\r?\n$/, ""));
    if (!keys) return;
    if (tables.length) tables.at(-1).end = index;
    tables.push({ keys, start: index, end: lines.length });
  });
  const firstHeader = tables.length ? tables[0].start : lines.length;
  if (tables.some((table) => table.keys.length === 1 && table.keys[0] === "mcp_servers") ||
    lines.slice(0, firstHeader).some((line) => /^\s*mcp_servers\s*[.=]/.test(line))) {
    throw new AgentsError(`${slashed(file)} defines mcp_servers inline, which this setup doesn't edit; add the entry by hand:\n` +
      codexBlock(SERVER_NAME, treeRoot).join("\n"));
  }
  const mcpServers = tables.filter((table) => table.keys[0] === "mcp_servers" && table.keys.length >= 2);
  const taken = new Set(mcpServers.map((table) => table.keys[1]));
  const servers = mcpServers.filter((table) => table.keys.length === 2).map((table) => ({
    ...table,
    name: table.keys[1],
    scripts: stringsIn(lines.slice(table.start, table.end).join("")).filter((value) => /mcp\.js$/i.test(value)),
  }));
  const mine = servers.find((server) => server.scripts.some((script) => path.isAbsolute(script) &&
    samePath(script, mcpPath(treeRoot), io.platform)));
  if (mine) return { agent: "codex", file, change: "none", serverName: mine.name };

  const eol = text && text.includes("\r\n") ? "\r\n" : "\n";
  const freeName = (others) => {
    if (!others.has(SERVER_NAME)) return SERVER_NAME;
    const base = `${SERVER_NAME}-${slug(path.basename(treeRoot))}`;
    let name = base;
    for (let n = 2; others.has(name); n += 1) name = `${base}-${n}`;
    return name;
  };
  // Replaced in place: a gridcheck entry whose script is gone, or this tree's entry from before the rename.
  const legacyPath = path.join(treeRoot, ...LEGACY_MCP_IN_TREE.split("/"));
  const named = servers.find((server) => server.name === SERVER_NAME && server.scripts.length &&
    server.scripts.every((script) => path.isAbsolute(script) && !io.exists(script)));
  const legacy = servers.find((server) => server.scripts.some((script) => path.isAbsolute(script) &&
    samePath(script, legacyPath, io.platform)));
  const current = named || legacy;
  if (current) {
    const gone = current.scripts[0];
    const name = current === named ? SERVER_NAME : freeName(new Set([...taken].filter((one) => one !== current.name)));
    // Keep the blank lines that separate it from the next table.
    let end = current.end;
    while (end > current.start + 1 && !lines[end - 1].trim()) end -= 1;
    const block = codexBlock(name, treeRoot);
    const replaced = lines.slice(current.start, end).map((line) => line.replace(/\r?\n$/, ""));
    const lastHadEnding = /\n$/.test(lines[end - 1]);
    const inserted = block.map((line, index) => (index < block.length - 1 || lastHadEnding ? `${line}${eol}` : line));
    const after = [...lines.slice(0, current.start), ...inserted, ...lines.slice(end)].join("");
    return { agent: "codex", file, change: "replace", serverName: name, before: text, after, added: block, replaced, gone };
  }
  const serverName = freeName(taken);
  const block = codexBlock(serverName, treeRoot);
  const before = text || "";
  const after = `${before}${before && !before.endsWith("\n") ? eol : ""}${before.trim() ? eol : ""}${block.join(eol)}${eol}`;
  return { agent: "codex", file, change: "add", serverName, before: text, after, added: block };
}

// ---------- other agents: a pointer in AGENTS.md or CLAUDE.md ----------

// AGENTS.md when the tree has one, else an existing CLAUDE.md, else a new AGENTS.md.
function planCli(treeRoot, given) {
  const io = ioFrom(given);
  const agentsFile = path.join(treeRoot, "AGENTS.md");
  const claudeFile = path.join(treeRoot, "CLAUDE.md");
  const file = !io.exists(agentsFile) && io.exists(claudeFile) ? claudeFile : agentsFile;
  const text = io.exists(file) ? io.readFile(file) : null;
  const serverName = `a pointer to ${CLI_GUIDE}`;
  const eol = (text || "").includes("\r\n") ? "\r\n" : "\n";
  // A pointer from before the rename names the old copy's path: it is replaced in place.
  const legacy = text === null ? null : /<!-- evejs-e2e:cli -->[\s\S]*?<!-- \/evejs-e2e:cli -->/.exec(text);
  if (legacy && !text.includes(CLI_MARKER)) {
    const after = text.slice(0, legacy.index) + CLI_POINTER.join(eol) + text.slice(legacy.index + legacy[0].length);
    return { agent: "cli", file, change: "replace", serverName, before: text, after, added: [...CLI_POINTER],
      replaced: legacy[0].split(/\r?\n/) };
  }
  if (text !== null && text.includes(CLI_MARKER)) return { agent: "cli", file, change: "none", serverName };
  const before = text || "";
  const after = `${before}${before && !before.endsWith("\n") ? eol : ""}${before.trim() ? eol : ""}${CLI_POINTER.join(eol)}${eol}`;
  return { agent: "cli", file, change: "add", serverName, before: text, after, added: [...CLI_POINTER] };
}

function planFor(id, treeRoot, io) {
  if (id === "claude") return planClaude(treeRoot, io);
  if (id === "codex") return planCodex(treeRoot, io);
  if (id === "cli") return planCli(treeRoot, io);
  throw new AgentsError(`no agent ${id}; the agents are ${agentList()}`);
}

// One row per agent: is it installed, and does it already run this tree's server?
function agentStatus(treeRoot, given) {
  const io = ioFrom(given);
  const found = detectAgents(io);
  return AGENT_IDS.map((id) => {
    const row = { id, name: AGENT_NAMES[id], ...found[id], file: null, registered: false, serverName: null, change: null, problem: null };
    try {
      const plan = planFor(id, treeRoot, io);
      Object.assign(row, { file: slashed(plan.file), registered: plan.change === "none", serverName: plan.serverName, change: plan.change });
    } catch (error) {
      if (!(error instanceof AgentsError)) throw error;
      row.problem = error.message;
    }
    return row;
  });
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.gridcheck-${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// ids: the agents to set up; null means every one found on this machine.
// -> [{ id, name, installed, plan, wrote }]
function setupAgents(treeRoot, ids = null, { dryRun = false, io: given } = {}) {
  const io = ioFrom(given);
  const found = detectAgents(io);
  for (const id of ids || []) if (!AGENT_IDS.includes(id)) throw new AgentsError(`no agent ${id}; the agents are ${agentList()}`);
  const chosen = ids && ids.length ? [...new Set(ids)] : AGENT_IDS.filter((id) => found[id].installed);
  // Plan everything before writing anything, so one agent's problem changes nothing.
  const plans = chosen.map((id) => ({ id, name: AGENT_NAMES[id], installed: found[id].installed, plan: planFor(id, treeRoot, io) }));
  return plans.map((row) => {
    const write = !dryRun && row.plan.change !== "none";
    if (write) writeAtomic(row.plan.file, row.plan.after);
    return { ...row, wrote: write };
  });
}

module.exports = {
  AGENT_IDS,
  AGENT_NAMES,
  AgentsError,
  CLI_GUIDE,
  CLI_POINTER,
  CODEX_TOOL_TIMEOUT_SEC,
  SERVER_NAME,
  agentStatus,
  detectAgents,
  headerKeys,
  planClaude,
  planCli,
  planCodex,
  setupAgents,
};
