"use strict";

// e2e setup --tree <path>: everything a tree needs before its first run, done
// as the commands a person would type, each printed before it runs: install
// the copy, write the config, connect the agents, apply the patches, build the
// starter world, and run smoke-undock. A step already done is skipped, so
// setup can run again after a fix. It stops at the first step that fails. The
// GUI's "Set up everything" previews and runs this command.
// Guide: docs/TREES.md "Setting a tree up".

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const vendor = require("./vendor");
const treeConfig = require("./treeConfig");
const agents = require("./agents");
const { enclosingTree } = require("./launcher");
const { prerequisites, serverUpReason } = require("./treeState");

const OWN_ROOT = path.resolve(__dirname, "..");
const OWN_CLI = path.join(OWN_ROOT, "bin", "e2e.js");
const SKIPPABLE = Object.freeze(["agents", "patches", "world", "smoke"]);
const STARTER = "starter";
const SMOKE = "smoke-undock";
const USAGE = "usage: e2e setup --tree <path> [--mode auto|attach|managed] [--agents claude,codex,cli|none] " +
  "[--skip agents,patches,world,smoke] [--force] [--dry-run]";

class SetupError extends Error {}

const slashed = (file) => String(file).split(path.sep).join("/");
const quote = (arg) => (/^[A-Za-z0-9_./:=,@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "\\\"")}"`);

function samePath(a, b) {
  const norm = (value) => path.resolve(value);
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

const list = (value) => String(value).split(",").map((part) => part.trim()).filter(Boolean);

// -> { tree, mode, agents: null | "none" | [id], skip: Set, force, dryRun }
// defaultTree: the tree when none is named (a vendored copy's own).
function parseSetupArgs(argv, { cwd = process.cwd(), defaultTree = null } = {}) {
  const options = { tree: null, mode: null, agents: null, skip: new Set(), force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [flag, inline] = token.startsWith("--") && token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, null];
    const value = () => {
      if (inline !== null) return inline;
      if (index + 1 >= argv.length) throw new SetupError(`${flag} needs a value\n${USAGE}`);
      index += 1;
      return argv[index];
    };
    if (flag === "--tree") options.tree = value();
    else if (flag === "--mode") options.mode = value();
    else if (flag === "--agents") options.agents = value();
    else if (flag === "--skip") for (const step of list(value())) options.skip.add(step);
    else if (flag === "--force") options.force = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help" || flag === "help") throw new SetupError(USAGE);
    else if (!flag.startsWith("--") && options.tree === null) options.tree = flag;
    else throw new SetupError(`setup doesn't take ${token}\n${USAGE}`);
  }
  if (options.mode !== null && !treeConfig.MODES.includes(options.mode)) {
    throw new SetupError(`--mode is ${treeConfig.MODES.join(", ")}`);
  }
  if (options.agents !== null && options.agents !== "none") {
    const ids = list(options.agents);
    const unknown = ids.filter((id) => !agents.AGENT_IDS.includes(id));
    if (unknown.length || !ids.length) throw new SetupError(`--agents is none, or a list of ${agents.AGENT_IDS.join(", ")}`);
    options.agents = ids;
  }
  const unknownSkips = [...options.skip].filter((step) => !SKIPPABLE.includes(step));
  if (unknownSkips.length) throw new SetupError(`--skip takes ${SKIPPABLE.join(", ")}; not ${unknownSkips.join(", ")}`);
  if (options.tree === null && defaultTree) options.tree = defaultTree;
  if (options.tree === null) {
    const found = enclosingTree(cwd, fs.existsSync);
    if (!found) throw new SetupError(`setup needs the tree: --tree <path>, or run it from inside the tree\n${USAGE}`);
    options.tree = found.root;
  }
  options.tree = path.resolve(cwd, options.tree);
  return options;
}

// What this copy is: a checkout, which installs itself into any tree, or a
// tree's own copy, which sets up that tree only and can't reinstall itself.
function ownContext() {
  if (fs.existsSync(path.join(OWN_ROOT, vendor.MANIFEST_NAME))) return { vendored: true, tree: path.resolve(OWN_ROOT, "..", ".."), head: null };
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: OWN_ROOT, encoding: "utf8", windowsHide: true });
  return { vendored: false, tree: null, head: result.status === 0 ? result.stdout.trim() : null };
}

function defaultIO() {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    // Streams the command's output; -> exit code.
    run: (args, { cwd, env }) => new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code === null ? 1 : code));
    }),
    // -> { code, stdout }
    read: (args, { cwd, env }) => {
      const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 24 });
      return { code: result.status === null ? 1 : result.status, stdout: result.stdout || "" };
    },
  };
}

// The tree's copy as a command line a person would type in the tree.
function shown(tree, args) {
  const cliIndex = args[0];
  const inTree = path.relative(tree, cliIndex);
  const cli = !inTree.startsWith("..") && !path.isAbsolute(inTree) ? slashed(inTree) : slashed(cliIndex);
  return `node ${[cli, ...args.slice(1)].map(quote).join(" ")}`;
}

// -> exit code: 0 ready, 1 a step failed, 2 refused before anything changed.
async function runSetup(options, io = defaultIO(), context = ownContext()) {
  const { tree, dryRun } = options;
  const say = io.out;
  const treeCli = path.join(tree, vendor.VENDOR_DIR, "bin", "e2e.js");
  const env = { EVEJS_E2E_TREE: tree };
  const label = slashed(tree);

  if (context.vendored && !samePath(context.tree, tree)) {
    say(`setup: this copy belongs to ${slashed(context.tree)}. Run setup from a checkout of the tool to set up ${label}.`);
    return 2;
  }
  const blockers = [];
  if (!fs.existsSync(path.join(tree, "server", "package.json"))) {
    say(`setup: ${label} is not an EveJS tree (no server/package.json).`);
    return 2;
  }
  const config = treeConfig.loadTreeConfig(tree);
  const up = serverUpReason(tree, config);
  if (up) blockers.push(`${up}. Stop it first: \`e2e down\` if e2e started it, or close the server you started.`);
  for (const row of prerequisites(tree, config).filter((one) => !one.ok)) blockers.push(`${row.name} missing (${row.path}): ${row.fix}.`);
  if (!context.vendored && !context.head) blockers.push(`${slashed(OWN_ROOT)} is not a git checkout, so it can't install itself; clone the tool and run setup from there.`);

  say(`setup ${label}${dryRun ? " (dry run: nothing is written)" : ""}`);
  if (blockers.length) {
    say("setup can't start:");
    for (const blocker of blockers) say(`  - ${blocker}`);
    say("Fix those, then run setup again.");
    return 2;
  }

  const steps = [];
  const total = 6;
  const step = async (number, title, plan) => {
    say("");
    say(`[${number}/${total}] ${title}`);
    if (plan.skip) {
      say(`  skipped: ${plan.skip}`);
      steps.push({ title, state: "skipped" });
      return true;
    }
    say(`  $ ${shown(tree, plan.args)}`);
    if (plan.onlyShow) {
      say(`  ${plan.onlyShow}`);
      steps.push({ title, state: "shown" });
      return true;
    }
    const code = await io.run(plan.args, { cwd: plan.cwd || tree, env });
    if (code !== 0) {
      say("");
      say(`setup stopped at "${title}": the command above exited ${code}. Its output says why; fix that and run setup again, ` +
        "which skips what is already done.");
      steps.push({ title, state: "failed" });
      return false;
    }
    steps.push({ title, state: "done" });
    return true;
  };
  const dry = (args) => (dryRun ? [...args, "--dry-run"] : args);
  const hasCopy = () => fs.existsSync(treeCli);

  // 1. The copy.
  const check = hasCopy() ? vendor.checkVendored({ tree }) : null;
  const current = check && check.ok && check.manifest && check.manifest.commit === context.head;
  if (!await step(1, "Install the tool into the tree", context.vendored
    ? { skip: "this is the tree's own copy; run setup from a checkout of the tool to update it" }
    : current ? { skip: `already installed at ${context.head.slice(0, 7)}, unchanged` }
      : { args: dry([OWN_CLI, "vendor", "update", "--from", slashed(OWN_ROOT), "--tree", label, ...(options.force ? ["--force"] : [])]),
        cwd: OWN_ROOT })) {
    return 1;
  }
  const later = hasCopy() ? null : "the tool isn't installed yet, so this dry run can't ask it; setup runs this after installing";

  // 2. The config.
  const configFile = path.join(tree, treeConfig.CONFIG_NAME);
  const configOk = fs.existsSync(configFile) && !(config.problems || []).length;
  const mode = options.mode || (configOk ? config.mode : treeConfig.DEFAULT_MODE);
  if (!await step(2, "Write the tree's config", configOk && (!options.mode || options.mode === config.mode)
    ? { skip: `${treeConfig.CONFIG_NAME} is there, in ${config.mode} mode (--mode changes it)` }
    : { args: dry([treeCli, "init", "--mode", mode, ...(fs.existsSync(configFile) ? ["--force"] : [])]), onlyShow: later })) {
    return 1;
  }

  // 3. Agents.
  let agentPlan;
  if (options.skip.has("agents") || options.agents === "none") {
    agentPlan = { skip: "not asked for" };
  } else {
    const status = agents.agentStatus(tree);
    const ids = options.agents || status.filter((row) => row.installed && row.id !== "cli").map((row) => row.id);
    const todo = ids.filter((id) => { const row = status.find((one) => one.id === id); return !row || !row.registered; });
    agentPlan = !ids.length ? { skip: "found neither Claude Code nor Codex here; `--agents cli` points any other agent at the CLI guide" }
      : !todo.length ? { skip: `${ids.map((id) => agents.AGENT_NAMES[id]).join(" and ")} already set up` }
        : { args: dry([treeCli, "agents", "setup", ...todo]), onlyShow: later };
  }
  if (!await step(3, "Connect agents", agentPlan)) return 1;

  // 4. Patches: every one the tree's copy reports absent.
  let patchPlan;
  if (options.skip.has("patches")) {
    patchPlan = { skip: "--skip patches" };
  } else if (!hasCopy()) {
    patchPlan = { args: [treeCli, "patch", "apply", "<each patch the copy reports absent>"], onlyShow: later };
  } else {
    const status = io.read([treeCli, "patch", "status", "--json"], { cwd: tree, env });
    let rows = null;
    try {
      rows = JSON.parse(status.stdout.slice(status.stdout.indexOf("[")));
    } catch (_error) {
      rows = null;
    }
    if (!Array.isArray(rows)) {
      patchPlan = { skip: "the copy's `patch status --json` didn't answer; `e2e patch status` shows why" };
    } else {
      const partial = rows.filter((row) => row.state === "partial");
      const absent = rows.filter((row) => row.state === "absent" && row.applies !== false).map((row) => row.id);
      if (partial.length) {
        say("");
        say(`[4/${total}] Apply the optional patches`);
        say(`setup stopped: ${partial.map((row) => row.id).join(", ")} ${partial.length === 1 ? "is" : "are"} partly applied. ` +
          `\`e2e patch revert ${partial[0].id}\` puts the file back, then run setup again.`);
        return 1;
      }
      patchPlan = absent.length ? { args: dry([treeCli, "patch", "apply", ...absent]) }
        : { skip: "every patch is applied or detected already" };
    }
  }
  if (!await step(4, "Apply the optional patches", patchPlan)) return 1;

  // 5 and 6 need a server the tool may start.
  const attach = mode === "attach";
  let worldPlan;
  if (options.skip.has("world")) worldPlan = { skip: "--skip world" };
  else if (attach) worldPlan = { skip: "attach mode: the tool doesn't start the server, so it can't build worlds" };
  else {
    let built = false;
    if (hasCopy()) {
      const recipes = io.read([treeCli, "world", "recipes", "--json"], { cwd: tree, env });
      try {
        const rows = JSON.parse(recipes.stdout.slice(recipes.stdout.indexOf("[")));
        built = rows.some((row) => row.name === STARTER && row.state === "built");
      } catch (_error) {
        built = false;
      }
    }
    worldPlan = built ? { skip: `${STARTER} is built and current` }
      : { args: [treeCli, "world", "build", STARTER], onlyShow: dryRun ? "builds the world a fight starts from; the first takes about 80 s" : null };
  }
  if (!await step(5, `Build the ${STARTER} world`, worldPlan)) return 1;

  let smokePlan;
  if (options.skip.has("smoke")) smokePlan = { skip: "--skip smoke" };
  else if (attach) smokePlan = { skip: `attach mode: start the server with EVEJS_AGENT_BRIDGE=1 set, then \`e2e run ${SMOKE}\`` };
  else if (dryRun) smokePlan = { args: [treeCli, "run", SMOKE], onlyShow: "boots a fresh world, undocks and reads the grid: about 50 s" };
  else smokePlan = { args: [treeCli, "run", SMOKE] };
  if (!await step(6, "Run the smoke test", smokePlan)) return 1;

  say("");
  if (dryRun) {
    say("dry run: nothing was written. Run the same command without --dry-run to do it.");
    return 0;
  }
  say(`ready: ${label} can run tests.`);
  say(`  e2e --tree ${quote(label)} run loadout-npc-fight     # a fitted ship fights two rats`);
  say(`  e2e gui --tree ${quote(label)} --open                # replay runs in the browser`);
  say("  Agents: docs/CLI.md (shell) or the e2e MCP tools; `e2e primer` prints the scenario format.");
  return 0;
}

async function main(argv, io = defaultIO(), context = ownContext()) {
  let options;
  try {
    options = parseSetupArgs(argv, { defaultTree: context.vendored ? context.tree : null });
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    io.out(`e2e: ${error.message}`);
    return 2;
  }
  return runSetup(options, io, context);
}

module.exports = { SetupError, USAGE, main, parseSetupArgs, runSetup };
