"use strict";

// `gridcheck gui`: a loopback web page for installing the tool into EveJS trees,
// applying its patches and replaying runs. Three tabs:
//
//   Runs     a tree's runs grouped by scenario, with the replay, verdict,
//            expectations, frames and report.md of one; a workbench view or a
//            trace view with a lane per ball (gui/runs.js, gui/replay.js)
//   Install  known trees or a typed path; for each, the vendored copy and its
//            drift check, the shim, gridcheck.config.json, the agents on this machine
//            (Claude Code, Codex) and whether each runs the tree's MCP server,
//            what the tree still needs, the plugins and `gridcheck doctor`. Installs,
//            updates, writes config and sets the agents up (core/agents.js).
//   Patches  each optional stock edit's state, a preview, apply and revert
//
// Every write is a CLI command. The page asks for a preview, which runs that
// command with --dry-run and shows its output; only then can it run the
// command itself, by the preview's ID, so what runs is what was shown. Writes
// are refused while the tree's server is up or a file they'd change has
// uncommitted changes. Reads that need the tree's own code (doctor, patch
// status) run its CLI too, so this process never loads a tree's modules.
//
// Run from a Gridcheck checkout it manages any tree and vendors from that
// checkout. Run from a vendored copy it manages that copy's tree only.
//
// The page carries no data and needs no token; every /gui/api and /viewer data
// route needs the bearer token, which reaches the page in the URL's fragment
// (`gridcheck gui` prints it), as the viewer's does. Guide: docs/GUI.md.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const vendor = require("./vendor");
const treeConfig = require("./treeConfig");
const agents = require("./agents");
const { prerequisites, serverUpInfo, serverUpReason } = require("./treeState");
const { createToolRegistry, loadPlugins, treeAt } = require("./plugins");
const { createAgentBridgeHttp } = require("../bridge/http");
const { createAgentBridgeViewer, resolveRunDir } = require("../bridge/viewer");

const OWN_ROOT = path.resolve(__dirname, "..");
const PAGE_DIR = path.join(OWN_ROOT, "gui");
const VIEWER_DIR = path.join(OWN_ROOT, "bridge", "viewer");
const CLI_IN_TREE = ["tools", "gridcheck", "bin", "gridcheck.js"];
const VENDOR_TARGETS = ["tools/gridcheck", "server/src/_secondary/agentBridge/server.js"];
const PREVIEW_TTL_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 90_000;
const WRITE_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_TREES = 50;
const FRAME_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.svg$/;
const PATCH_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USAGE = "usage: gridcheck gui [--port N] [--tree <path>]... [--open]";

const PAGES = Object.freeze({
  "/": [PAGE_DIR, "index.html", "text/html; charset=utf-8"],
  "/gui": [PAGE_DIR, "index.html", "text/html; charset=utf-8"],
  "/gui/gui.js": [PAGE_DIR, "gui.js", "text/javascript; charset=utf-8"],
  "/gui/replay.js": [PAGE_DIR, "replay.js", "text/javascript; charset=utf-8"],
  // The run's tick figures, as the report computes them (core/perf.js).
  "/gui/perf.js": [__dirname, "perf.js", "text/javascript; charset=utf-8"],
  "/gui/runs.js": [PAGE_DIR, "runs.js", "text/javascript; charset=utf-8"],
  "/gui/commands.js": [PAGE_DIR, "commands.js", "text/javascript; charset=utf-8"],
  "/gui/gui.css": [PAGE_DIR, "gui.css", "text/css; charset=utf-8"],
  "/viewer": [VIEWER_DIR, "index.html", "text/html; charset=utf-8"],
  "/viewer/viewer.js": [VIEWER_DIR, "viewer.js", "text/javascript; charset=utf-8"],
  "/viewer/viewer.css": [VIEWER_DIR, "viewer.css", "text/css; charset=utf-8"],
});

class GuiError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const slashed = (file) => String(file).split(path.sep).join("/");
const exists = (file) => {
  try {
    return fs.existsSync(file);
  } catch (_error) {
    return false;
  }
};

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

function samePath(a, b) {
  const norm = (value) => path.resolve(value);
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function treeID(root) {
  const key = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function isTree(root) {
  return exists(path.join(root, "server", "src"));
}

function git(cwd, args, { trim = true } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return trim ? String(result.stdout).trim() : String(result.stdout);
}

// -> { git: false } | { git: true, dirty: [path] } for the given tree-relative paths.
function gitDirty(root, relativePaths) {
  if (git(root, ["rev-parse", "--show-toplevel"]) === null) return { git: false };
  // Porcelain lines start with two status columns, so the output isn't trimmed.
  const out = git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...relativePaths.map((file) => path.join(root, file))],
    { trim: false });
  if (out === null) return { git: true, dirty: [], error: "git status failed" };
  return { git: true, dirty: out.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean) };
}

// What this copy is: a checkout (manages any tree) or a vendored copy (its tree only).
function ownContext(env = process.env) {
  const manifest = readJSON(path.join(OWN_ROOT, vendor.MANIFEST_NAME));
  const pkg = readJSON(path.join(OWN_ROOT, "package.json")) || {};
  if (manifest) {
    const tree = String(env.GRIDCHECK_TREE || "").trim() ? path.resolve(env.GRIDCHECK_TREE.trim()) : path.resolve(OWN_ROOT, "..", "..");
    return { mode: "vendored", version: manifest.version || pkg.version || null, commit: manifest.commit || null, checkout: null, tree };
  }
  const top = git(OWN_ROOT, ["rev-parse", "--show-toplevel"]);
  const checkout = top && samePath(top, OWN_ROOT) ? OWN_ROOT : null;
  return {
    mode: "checkout",
    version: pkg.version || null,
    commit: checkout ? git(checkout, ["rev-parse", "HEAD"]) : null,
    checkout,
    dirty: checkout ? git(checkout, ["status", "--porcelain", "--untracked-files=no"]) !== "" : false,
    tree: null,
  };
}

// ---------- trees ----------

// Known trees: the vendored copy's own; or, from a checkout, the trees given
// with --tree, the ones added on the page before (remembered in stateFile) and
// the checkout's sibling folders that are EveJS trees.
function createTreeList({ context, stateFile = null, extra = [] }) {
  const remembered = () => {
    const state = stateFile ? readJSON(stateFile) : null;
    return Array.isArray(state && state.trees) ? state.trees.filter((entry) => typeof entry === "string") : [];
  };

  function siblings() {
    if (!context.checkout) return [];
    const parent = path.dirname(context.checkout);
    try {
      return fs.readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => path.join(parent, entry.name))
        .filter((dir) => !samePath(dir, context.checkout) && isTree(dir));
    } catch (_error) {
      return [];
    }
  }

  function roots() {
    if (context.mode === "vendored") return [context.tree];
    const out = [];
    for (const [source, list] of [["given", extra], ["added", remembered()], ["nearby", siblings()]]) {
      for (const root of list) {
        const resolved = path.resolve(root);
        if (!out.some((entry) => samePath(entry.root, resolved))) out.push({ root: resolved, source });
      }
    }
    return out.slice(0, MAX_TREES).map((entry) => entry.root);
  }

  function sourceOf(root) {
    if (context.mode === "vendored") return "this copy's tree";
    if (extra.some((entry) => samePath(entry, root))) return "given";
    if (remembered().some((entry) => samePath(entry, root))) return "added";
    return "nearby";
  }

  function find(id) {
    const root = roots().find((candidate) => treeID(candidate) === String(id || ""));
    if (!root) throw new GuiError("no such tree; pick one from the list", 404);
    return root;
  }

  function add(text) {
    if (context.mode === "vendored") throw new GuiError("this GUI runs from a vendored copy and manages its own tree only");
    const raw = String(text || "").trim();
    if (!raw) throw new GuiError("type the path of an EveJS tree");
    const root = path.resolve(raw);
    if (!exists(root)) throw new GuiError(`${slashed(root)} doesn't exist`);
    if (!isTree(root)) throw new GuiError(`${slashed(root)} is not an EveJS tree: it has no server/src`);
    if (context.checkout && samePath(root, context.checkout)) throw new GuiError("that's this Gridcheck checkout, not an EveJS tree");
    if (!stateFile) return root;
    const list = remembered();
    if (!list.some((entry) => samePath(entry, root))) list.push(root);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ trees: list.slice(-MAX_TREES) }, null, 2)}\n`);
    return root;
  }

  function forget(id) {
    const root = find(id);
    if (!stateFile) return root;
    const list = remembered().filter((entry) => !samePath(entry, root));
    fs.writeFileSync(stateFile, `${JSON.stringify({ trees: list }, null, 2)}\n`);
    return root;
  }

  return { roots, find, add, forget, sourceOf };
}

// The tree's server, if it's up: a live bridge handshake, or a live `gridcheck up` run.

// A finished run's verdict never changes, so the tree list, polled every 30 s,
// reads each result.json once.
const verdicts = new Map();
const MAX_VERDICTS = 20_000;

// Scenario runs (the ones with a result.json) in a runs directory. Watch-only
// runs and runs still going have none and aren't counted.
function runCounts(runsDir) {
  const counts = { total: 0, passed: 0, failed: 0 };
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (_error) {
    return counts;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    let passed = verdicts.get(dir);
    if (passed === undefined) {
      const result = readJSON(path.join(dir, "result.json"));
      if (!result) continue;
      passed = result.passed === true;
      if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
      verdicts.set(dir, passed);
    }
    counts.total += 1;
    if (passed) counts.passed += 1;
    else counts.failed += 1;
  }
  return counts;
}

// One line per tree for the list; summarizeTree has the rest.
function listEntry(root, trees) {
  const manifest = readJSON(path.join(root, vendor.VENDOR_DIR, vendor.MANIFEST_NAME));
  const config = isTree(root) ? treeConfig.loadTreeConfig(root) : null;
  return {
    id: treeID(root),
    root: slashed(root),
    name: path.basename(root),
    source: trees.sourceOf(root),
    isTree: isTree(root),
    evejs: config ? evejsVersion(root, config) : null,
    copy: manifest ? { version: manifest.version || null, commit: manifest.commit || null } : null,
    mode: config && config.exists ? config.mode : null,
    up: config ? Boolean(serverUpReason(root, config)) : false,
    runs: config ? runCounts(config.runsDir) : { total: 0, passed: 0, failed: 0 },
  };
}

// EveJS keeps its version in server/package.json; the root one is a fork's fallback.
function evejsVersion(root, config) {
  for (const dir of [config.serverDir, root]) {
    const pkg = readJSON(path.join(dir, "package.json"));
    if (pkg && typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  }
  return null;
}

function summarizeTree(root, { context, trees }) {
  const entry = listEntry(root, trees);
  if (!entry.isTree) return { ...entry, problem: `${slashed(root)} has no server/src any more` };
  const config = treeConfig.loadTreeConfig(root);
  let check;
  try {
    check = vendor.checkVendored({ tree: root });
  } catch (error) {
    check = { ok: false, manifest: null, problems: [{ file: vendor.MANIFEST_NAME, problem: error.message }] };
  }
  const present = exists(path.join(root, vendor.VENDOR_DIR));
  const shimProblem = check.problems.find((row) => row.problem.startsWith("shim"));
  const dirty = gitDirty(root, [...VENDOR_TARGETS, treeConfig.CONFIG_NAME]);
  const loaded = loadPlugins({ tree: treeAt(root, config.serverDir) });
  return {
    ...entry,
    git: dirty.git,
    dirty: dirty.git ? dirty.dirty : null,
    copy: {
      present,
      vendored: Boolean(check.manifest),
      version: check.manifest ? check.manifest.version : null,
      commit: check.manifest ? check.manifest.commit : null,
      ok: check.ok,
      problems: present && check.manifest ? check.problems.slice(0, 50) : [],
      problemCount: present && check.manifest ? check.problems.length : 0,
      upToDate: Boolean(check.manifest && context.commit && check.manifest.commit === context.commit),
    },
    shim: !exists(path.join(root, vendor.SHIM_PATH)) ? "missing" : shimProblem ? "edited" : check.manifest ? "matches" : "present",
    config: {
      exists: config.exists,
      file: slashed(path.relative(root, config.file)),
      mode: config.mode,
      problems: config.problems,
      runsDir: slashed(path.relative(root, config.runsDir)),
      worldsDir: slashed(path.relative(root, config.worldsDir)),
    },
    prerequisites: prerequisites(root, config),
    serverUp: serverUpReason(root, config),
    serverPid: (serverUpInfo(root, config) || {}).pid || null,
    // What this checkout's plugins make of the tree; doctor asks the tree's own copy.
    plugins: { active: loaded.active.map((row) => row.name), skipped: loaded.skipped },
    // The agents on this machine, and whether each already runs this tree's MCP server.
    agents: agentRows(root),
  };
}

function agentRows(root) {
  try {
    return agents.agentStatus(root);
  } catch (error) {
    return agents.AGENT_IDS.map((id) => ({ id, name: agents.AGENT_NAMES[id], installed: false, evidence: [], problem: error.message }));
  }
}

// ---------- running the CLI ----------

function quote(arg) {
  const text = slashed(arg);
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

// The command as a person would type it: node, then the script relative to cwd when it's inside.
function displayCommand(step) {
  const [script, ...args] = step.args;
  const relative = path.relative(step.cwd, script);
  const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : script;
  return `node ${[shown, ...args].map(quote).join(" ")}`;
}

function runNode(step, { timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let truncated = false;
    const child = spawn(process.execPath, step.args, {
      cwd: step.cwd,
      env: { ...process.env, ...step.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (chunk) => {
      if (output.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      output += `\n(stopped after ${Math.round(timeoutMs / 1000)} s)`;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: `could not start node: ${error.message}`, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code === null ? -1 : code, output: truncated ? `${output}\n(output cut off)` : output, ms: Date.now() - started });
    });
  });
}

function treeCli(root) {
  return path.join(root, ...CLI_IN_TREE);
}

function treeStep(root, args) {
  return { cwd: root, args: [treeCli(root), ...args], env: { GRIDCHECK_TREE: root } };
}

function requireCopy(root) {
  if (!exists(treeCli(root))) throw new GuiError("the tree has no vendored copy yet; install it first (Install tab)");
}

// action -> { steps: [{ cwd, args, env }], dirtyTargets: [tree-relative paths] }.
// Each step's preview is the same command with --dry-run.
function planAction(action, root, params, context) {
  if (action === "vendor") {
    const force = params.force === true;
    let checkout = context.checkout;
    let cli = path.join(OWN_ROOT, "bin", "gridcheck.js");
    if (context.mode === "vendored") {
      checkout = String(params.from || "").trim() ? path.resolve(String(params.from).trim()) : null;
      if (!checkout) throw new GuiError("this GUI runs from a vendored copy: type the Gridcheck checkout to update from");
      cli = path.join(checkout, "bin", "gridcheck.js");
      if (!exists(cli)) throw new GuiError(`${slashed(checkout)} is not a Gridcheck checkout (no bin/gridcheck.js)`);
    } else if (!checkout) {
      throw new GuiError(`${slashed(OWN_ROOT)} is not a git checkout, so it can't vendor itself; run gridcheck gui from a Gridcheck checkout`);
    }
    return {
      steps: [{ cwd: checkout, args: [cli, "vendor", "update", "--from", checkout, "--tree", root, ...(force ? ["--force"] : [])],
        env: { GRIDCHECK_TREE: root } }],
      dirtyTargets: VENDOR_TARGETS,
    };
  }
  if (action === "setup") {
    // From a checkout, the checkout's setup installs it first; from a vendored copy, the copy sets up its own tree.
    if (context.mode !== "vendored" && !context.checkout) {
      throw new GuiError(`${slashed(OWN_ROOT)} is not a git checkout, so it can't install itself; run gridcheck gui from a Gridcheck checkout`);
    }
    const args = [path.join(OWN_ROOT, "bin", "gridcheck.js"), "setup", "--tree", slashed(root)];
    if (params.mode !== undefined && params.mode !== null && params.mode !== "") {
      if (!treeConfig.MODES.includes(String(params.mode))) throw new GuiError(`mode is ${treeConfig.MODES.join(", ")}`);
      args.push("--mode", String(params.mode));
    }
    if (Array.isArray(params.agents)) {
      const chosen = [...new Set(params.agents.map(String))];
      const unknown = chosen.filter((id) => !agents.AGENT_IDS.includes(id));
      if (unknown.length) throw new GuiError(`no agent ${unknown.join(", ")}`);
      args.push("--agents", chosen.length ? chosen.join(",") : "none");
    }
    return {
      steps: [{ cwd: context.checkout || root, args, env: { GRIDCHECK_TREE: root } }],
      dirtyTargets: [...VENDOR_TARGETS, treeConfig.CONFIG_NAME],
      // A first setup builds a world and boots a server twice.
      timeoutMs: 20 * 60_000,
    };
  }
  if (action === "init") {
    requireCopy(root);
    const mode = String(params.mode || treeConfig.DEFAULT_MODE);
    if (!treeConfig.MODES.includes(mode)) throw new GuiError(`mode is ${treeConfig.MODES.join(", ")}`);
    const force = exists(path.join(root, treeConfig.CONFIG_NAME));
    return { steps: [treeStep(root, ["init", "--mode", mode, ...(force ? ["--force"] : [])])], dirtyTargets: [treeConfig.CONFIG_NAME] };
  }
  if (action === "patch-apply" || action === "patch-revert") {
    requireCopy(root);
    const id = String(params.id || "");
    if (!PATCH_ID.test(id)) throw new GuiError("a patch id is lower-case letters, digits and dashes");
    // The patch command checks its own targets for uncommitted changes and reports them in the dry run.
    return { steps: [treeStep(root, ["patch", action === "patch-apply" ? "apply" : "revert", id])], dirtyTargets: [] };
  }
  if (action === "agents") {
    requireCopy(root);
    const chosen = Array.isArray(params.agents) ? [...new Set(params.agents.map(String))] : [];
    if (!chosen.length) throw new GuiError("pick an agent to set up");
    const unknown = chosen.filter((id) => !agents.AGENT_IDS.includes(id));
    if (unknown.length) throw new GuiError(`no agent ${unknown.join(", ")}; the agents are ${agents.AGENT_IDS.join(" and ")}`);
    // An agent's config doesn't touch the server, so this may run while it's up.
    return { steps: [treeStep(root, ["agents", "setup", ...chosen])],
      dirtyTargets: [...(chosen.includes("claude") ? [".mcp.json"] : []), ...(chosen.includes("cli") ? ["AGENTS.md", "CLAUDE.md"] : [])],
      serverMayRun: true };
  }
  throw new GuiError(`unknown action ${action}`);
}

function guards(root, plan) {
  const reasons = [];
  const up = plan.serverMayRun ? null : serverUpReason(root);
  if (up) reasons.push(`${up}; stop it first (gridcheck down, or stop the server you started)`);
  if (plan.dirtyTargets.length) {
    const status = gitDirty(root, plan.dirtyTargets);
    if (status.git && status.dirty.length) {
      reasons.push(`uncommitted changes in ${status.dirty.slice(0, 10).join(", ")}${status.dirty.length > 10 ? ", ..." : ""}; ` +
        "commit or discard them first");
    }
  }
  return reasons;
}

// ---------- the server ----------

function createGui({ context = ownContext(), stateFile = null, extraTrees = [], now = Date.now, run = runNode } = {}) {
  const trees = createTreeList({ context, stateFile, extra: extraTrees });
  const previews = new Map();
  const viewers = new Map();
  let busy = null;

  function viewerFor(root) {
    const config = treeConfig.loadTreeConfig(root);
    const key = `${treeID(root)}|${config.runsDir}`;
    if (!viewers.has(key)) {
      const registry = createToolRegistry(loadPlugins({ tree: treeAt(root, config.serverDir) }));
      viewers.set(key, { runsDir: config.runsDir, viewer: createAgentBridgeViewer({ runsDir: config.runsDir, registry, now }) });
    }
    return viewers.get(key);
  }

  function prune() {
    for (const [id, preview] of previews) if (now() - preview.createdAtMs > PREVIEW_TTL_MS) previews.delete(id);
  }

  // opener: the character the command's JSON starts with; lines before it are notes.
  async function cliRead(root, args, opener) {
    requireCopy(root);
    const step = treeStep(root, args);
    const result = await run(step, { timeoutMs: READ_TIMEOUT_MS });
    const start = result.output.indexOf(opener);
    let json = null;
    try {
      json = start >= 0 ? JSON.parse(result.output.slice(start)) : null;
    } catch (_error) {
      json = null;
    }
    return { command: displayCommand(step), cwd: slashed(step.cwd), exitCode: result.exitCode, output: result.output, json };
  }

  // A copy older than a command's --dry-run would ignore the flag and make the
  // change, so a preview first reads the CLI's own usage for that command.
  const usageCache = new Map();
  async function dryRunProblem(step) {
    const [cli, command] = step.args;
    let stamp = 0;
    try {
      stamp = fs.statSync(cli).mtimeMs;
    } catch (_error) {
      return `${slashed(cli)} is missing`;
    }
    const key = `${cli}|${stamp}`;
    if (!usageCache.has(key)) {
      const result = await run({ ...step, args: [cli, "help"] }, { timeoutMs: READ_TIMEOUT_MS });
      usageCache.set(key, result.output.split(/\r?\n/).map((line) => line.trim()));
    }
    const usage = usageCache.get(key).filter((line) => line.startsWith(`gridcheck ${command} `));
    if (usage.some((line) => line.includes("--dry-run"))) return null;
    return `${displayCommand(step)} has no --dry-run in this copy (${slashed(cli)}), so it can't be previewed; ` +
      "update the copy first (Install tab)";
  }

  async function preview(body) {
    prune();
    const root = trees.find(body.tree);
    const action = String(body.action || "");
    const plan = planAction(action, root, body, context);
    const refused = guards(root, plan);
    let unsafe = false;
    for (const step of plan.steps) {
      const problem = await dryRunProblem(step);
      if (problem) {
        refused.push(problem);
        unsafe = true;
      }
    }
    const shown = [];
    let ok = refused.length === 0;
    for (const step of unsafe ? [] : plan.steps) {
      const dry = { ...step, args: [...step.args, "--dry-run"] };
      const result = await run(dry, { timeoutMs: READ_TIMEOUT_MS });
      if (result.exitCode !== 0) ok = false;
      shown.push({ command: displayCommand(step), cwd: slashed(step.cwd), dryRun: displayCommand(dry), exitCode: result.exitCode,
        output: result.output });
    }
    const previewID = ok ? crypto.randomBytes(12).toString("hex") : null;
    if (previewID) previews.set(previewID, { tree: body.tree, root, action, plan, createdAtMs: now() });
    return { ok, previewID, action, tree: body.tree, refused, steps: shown,
      note: ok ? "nothing was written; Run does the commands above" : "this change would be refused, so it can't run" };
  }

  async function runPreview(body) {
    prune();
    const id = String(body.previewID || "");
    const entry = previews.get(id);
    if (!entry) throw new GuiError("that preview has expired or was used; preview the change again", 409);
    previews.delete(id);
    if (busy) throw new GuiError(`another change is running (${busy}); wait for it`, 409);
    const refused = guards(entry.root, entry.plan);
    if (refused.length) return { ok: false, refused, steps: [] };
    busy = `${entry.action} in ${slashed(entry.root)}`;
    const steps = [];
    try {
      for (const step of entry.plan.steps) {
        const result = await run(step, { timeoutMs: entry.plan.timeoutMs || WRITE_TIMEOUT_MS });
        steps.push({ command: displayCommand(step), cwd: slashed(step.cwd), exitCode: result.exitCode, output: result.output, ms: result.ms });
        if (result.exitCode !== 0) break;
      }
    } finally {
      busy = null;
      viewers.clear();
    }
    return { ok: steps.every((step) => step.exitCode === 0), refused: [], steps };
  }

  function runDetail(root, runID) {
    const { runsDir } = viewerFor(root);
    const dir = resolveRunDir(runsDir, runID);
    if (!dir || !exists(dir)) throw new GuiError(`no run ${runID} in this tree`, 404);
    let report = null;
    try {
      const stat = fs.statSync(path.join(dir, "report.md"));
      report = stat.size <= MAX_REPORT_BYTES ? fs.readFileSync(path.join(dir, "report.md"), "utf8") : `report.md is ${stat.size} bytes, too big to show here`;
    } catch (_error) {
      report = null;
    }
    let frames = [];
    try {
      frames = fs.readdirSync(path.join(dir, "frames")).filter((name) => FRAME_FILE.test(name)).sort();
    } catch (_error) {
      frames = [];
    }
    return { ok: true, run: runID, dir: slashed(dir), report, frames, hasTimeline: exists(path.join(dir, "timeline.jsonl")),
      result: readJSON(path.join(dir, "result.json")) };
  }

  function frame(root, runID, file) {
    const { runsDir } = viewerFor(root);
    const dir = resolveRunDir(runsDir, runID);
    if (!dir || !FRAME_FILE.test(String(file || ""))) throw new GuiError("frame must name a run and an .svg in its frames folder");
    const full = path.join(dir, "frames", String(file));
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_error) {
      throw new GuiError(`no frame ${file}`, 404);
    }
    if (!stat.isFile() || stat.size > MAX_FRAME_BYTES) throw new GuiError(`frame ${file} is not a file this page shows`, 404);
    return { statusCode: 200, raw: { contentType: "image/svg+xml", body: fs.readFileSync(full) } };
  }

  // The Commands tab: the tree's copy's own `help --json`. A copy too old for it,
  // or no copy, gets this copy of gridcheck's list, read for that tree's plugins.
  async function commands(root) {
    let read = null;
    try {
      read = await cliRead(root, ["help", "--json"], "{");
    } catch (_error) {
      read = null;
    }
    if (read && read.json && Array.isArray(read.json.commands)) return { ...read.json, source: "tree", command: read.command };
    const own = await run({ cwd: OWN_ROOT, args: [path.join(OWN_ROOT, "bin", "gridcheck.js"), "help", "--json"], env: { GRIDCHECK_TREE: root } },
      { timeoutMs: READ_TIMEOUT_MS });
    let json = null;
    try {
      json = JSON.parse(own.output.slice(own.output.indexOf("{")));
    } catch (_error) {
      throw new GuiError(`couldn't read the command list: ${own.output.slice(0, 300)}`, 500);
    }
    return { ...json, source: "tool", note: read
      ? "This tree's copy of gridcheck is older than this list, so it shows the commands of the gridcheck running this page. Update the copy for its own."
      : "gridcheck isn't installed in this tree, so this is the list of the gridcheck running this page." };
  }

  // The Run a test card: the tree's scenarios and world recipes, from its copy.
  // A copy without `run --json` gives null, and the card falls back to fixed commands.
  async function scenarioList(root) {
    const [list, recipes] = await Promise.all([cliRead(root, ["run", "--json"], "["), cliRead(root, ["world", "recipes", "--json"], "[")]);
    return { scenarios: Array.isArray(list.json) ? list.json : null, recipes: Array.isArray(recipes.json) ? recipes.json : null };
  }

  const json = (body, statusCode = 200) => ({ statusCode, body: { ok: true, ...body } });

  async function route(method, pathname, query, body) {
    if (method === "GET" && pathname === "/gui/api/context") {
      return json({ context: { ...context, checkout: context.checkout && slashed(context.checkout), tree: context.tree && slashed(context.tree),
        root: slashed(OWN_ROOT) }, busy });
    }
    if (method === "GET" && pathname === "/gui/api/trees") return json({ trees: trees.roots().map((root) => listEntry(root, trees)) });
    if (method === "POST" && pathname === "/gui/api/trees") {
      const root = trees.add(body.path);
      return json({ tree: listEntry(root, trees) });
    }
    if (method === "POST" && pathname === "/gui/api/trees/forget") {
      trees.forget(body.tree);
      return json({});
    }
    if (method === "GET" && pathname === "/gui/api/tree") return json({ tree: summarizeTree(trees.find(query.tree), { context, trees }) });
    if (method === "GET" && pathname === "/gui/api/doctor") return json({ doctor: await cliRead(trees.find(query.tree), ["doctor", "--json"], "{") });
    if (method === "GET" && pathname === "/gui/api/patches") {
      return json({ patches: await cliRead(trees.find(query.tree), ["patch", "status", "--json"], "[") });
    }
    if (method === "GET" && pathname === "/gui/api/commands") return json({ commands: await commands(trees.find(query.tree)) });
    if (method === "GET" && pathname === "/gui/api/scenarios") return json(await scenarioList(trees.find(query.tree)));
    if (method === "POST" && pathname === "/gui/api/preview") return json({ preview: await preview(body) });
    if (method === "POST" && pathname === "/gui/api/run") return json({ result: await runPreview(body) });
    if (method === "GET" && pathname === "/gui/api/runs") return viewerFor(trees.find(query.tree)).viewer.handle("GET", "/viewer/runs", {});
    if (method === "GET" && pathname === "/gui/api/run") return json(runDetail(trees.find(query.tree), query.run));
    if (method === "GET" && pathname === "/gui/api/frame") return frame(trees.find(query.tree), query.run, query.file);
    if (method === "GET" && pathname.startsWith("/viewer/")) return viewerFor(trees.find(query.tree)).viewer.handle(method, pathname, query);
    return { statusCode: 404, body: { ok: false, error: `no such route: ${method} ${pathname}` } };
  }

  async function handle(method, pathname, query = {}, body = {}) {
    try {
      return await route(method, pathname, query || {}, body || {});
    } catch (error) {
      if (error instanceof GuiError || error instanceof vendor.VendorError) {
        return { statusCode: error.statusCode || 400, body: { ok: false, error: error.message } };
      }
      throw error;
    }
  }

  function handlePublic(method, pathname) {
    const page = method === "GET" ? PAGES[pathname] : null;
    if (!page) return null;
    try {
      return { statusCode: 200, raw: { contentType: page[2], body: fs.readFileSync(path.join(page[0], page[1])) } };
    } catch (error) {
      return { statusCode: 500, raw: { contentType: "text/plain; charset=utf-8", body: `page file missing: ${error.message}` } };
    }
  }

  return { handle, handlePublic, trees, context };
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch (_error) {
    // The URL is printed either way.
  }
}

function parseGuiArgs(argv) {
  const options = { port: 0, trees: [], open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--open") options.open = true;
    else if (token === "--port" || token === "--tree") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new GuiError(`${token} needs a value\n${USAGE}`);
      if (token === "--port") {
        options.port = Math.trunc(Number(value));
        if (!(options.port >= 0 && options.port < 65536)) throw new GuiError(`--port takes a port number\n${USAGE}`);
      } else {
        options.trees.push(path.resolve(value));
      }
      index += 1;
    } else if (token === "--help" || token === "help") {
      throw new GuiError(USAGE);
    } else {
      throw new GuiError(`unknown argument ${token}\n${USAGE}`);
    }
  }
  return options;
}

// bin/gridcheck.js runs this before it loads a tree's config: from a checkout there
// is no tree of its own.
async function main(argv, { stdout = process.stdout, stderr = process.stderr, waitForStop = null } = {}) {
  let options;
  try {
    options = parseGuiArgs(argv);
  } catch (error) {
    stderr.write(`gridcheck: ${error.message}\n`);
    return 1;
  }
  const context = ownContext();
  if (context.mode === "vendored" && options.trees.length) {
    stderr.write("gridcheck: this GUI runs from a vendored copy and manages its own tree only; run gridcheck gui from a Gridcheck checkout for others\n");
    return 1;
  }
  for (const root of options.trees) {
    if (!isTree(root)) {
      stderr.write(`gridcheck: ${slashed(root)} is not an EveJS tree (no server/src)\n`);
      return 1;
    }
  }
  const stateFile = context.checkout ? path.join(context.checkout, "_local", "gui.json") : null;
  const gui = createGui({ context, stateFile, extraTrees: options.trees });
  const server = createAgentBridgeHttp({ routes: gui, port: options.port, handshakePath: null, serviceName: "gridcheck-gui" });
  const port = await server.start();
  const url = `http://127.0.0.1:${port}/gui#token=${server.token}`;
  stdout.write(`${context.mode === "vendored" ? `gridcheck gui for ${slashed(context.tree)}` : `gridcheck gui from ${slashed(OWN_ROOT)}`}. ` +
    `Ctrl-C stops it:\n${url}\n`);
  if (options.open) openBrowser(url);
  await (waitForStop ? waitForStop(server) : new Promise((resolve) => process.once("SIGINT", resolve)));
  await server.stop();
  return 0;
}

module.exports = {
  GuiError,
  USAGE,
  createGui,
  createTreeList,
  displayCommand,
  gitDirty,
  main,
  ownContext,
  parseGuiArgs,
  planAction,
  serverUpReason,
  summarizeTree,
  treeID,
};
