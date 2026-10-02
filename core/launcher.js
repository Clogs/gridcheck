"use strict";

// Which copy of the tool runs a command. A tree runs its own vendored copy, so
// the CLI and the bridge inside its server are always one version. Run from a
// checkout, `--tree <path>`, or a working directory inside a tree, hands the
// command to that tree's copy. GRIDCHECK_TREE keeps its older meaning: run
// this checkout's own code against that tree, which the tests and the tool's
// own development rely on. Guide: docs/TREES.md "Running from a checkout".

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { MANIFEST_NAME, VENDOR_DIR } = require("./vendor");

// These manage trees from a checkout themselves, and read --tree as their own flag.
const OWN_TREE_FLAG = new Set(["vendor", "gui", "setup"]);
// These work in a checkout with no tree.
const NO_TREE = new Set(["help", "primer"]);
// After these, a copy older than the checkout is worth a note.
const SKEW_NOTE = new Set(["status", "doctor"]);

const slashed = (file) => String(file).split(path.sep).join("/");

function samePath(a, b) {
  const norm = (value) => path.resolve(value);
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// argv without its --tree flag, and the flag's value. Stops at "--", after
// which every word belongs to the command (a slash line, a scenario path).
function takeTreeFlag(argv) {
  const rest = [];
  let tree = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (token === "--tree") {
      if (index + 1 >= argv.length) return { rest, tree: null, error: "--tree needs a path" };
      tree = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--tree=")) {
      tree = token.slice("--tree=".length);
    } else {
      rest.push(token);
    }
  }
  return { rest, tree, error: null };
}

const copyCli = (tree) => path.join(tree, VENDOR_DIR, "bin", "gridcheck.js");
const looksLikeTree = (dir, exists) => exists(path.join(dir, "server", "package.json")) && exists(path.join(dir, "server", "src"));

// The nearest folder at or above dir that is an EveJS tree, with whether it has a copy.
function enclosingTree(dir, exists) {
  let current = path.resolve(dir);
  for (;;) {
    if (exists(copyCli(current))) return { root: current, copy: true };
    if (looksLikeTree(current, exists)) return { root: current, copy: false };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// What to do with this command line:
//   { kind: "local", argv }                 run it in this process
//   { kind: "handoff", tree, cli, argv }    run the tree's copy with argv
//   { kind: "error", message }
function planLaunch({ argv, ownRoot, env = process.env, cwd = process.cwd(), exists = fs.existsSync }) {
  const { rest, tree, error } = takeTreeFlag(argv);
  const command = rest.find((token) => !token.startsWith("--")) || "help";
  if (OWN_TREE_FLAG.has(command)) {
    // The command first, so bin/gridcheck.js finds it; its own --tree stays.
    const at = argv.findIndex((token, index) => token === command && argv[index - 1] !== "--tree");
    return { kind: "local", argv: [command, ...argv.filter((_token, index) => index !== at)] };
  }
  if (error) return { kind: "error", message: error };
  const vendoredCopy = exists(path.join(ownRoot, MANIFEST_NAME));

  if (vendoredCopy) {
    const own = path.resolve(ownRoot, "..", "..");
    if (tree !== null && !samePath(path.resolve(cwd, tree), own)) {
      return { kind: "error", message: `this copy belongs to ${slashed(own)}. For ${slashed(path.resolve(cwd, tree))}, ` +
        `run that tree's own ${slashed(VENDOR_DIR)}/bin/gridcheck.js, or a checkout with --tree` };
    }
    return { kind: "local", argv: rest };
  }

  // A checkout. GRIDCHECK_TREE: this checkout's code against that tree.
  if (tree === null && String(env.GRIDCHECK_TREE || "").trim()) return { kind: "local", argv: rest };
  let target;
  if (tree !== null) {
    const root = path.resolve(cwd, tree);
    if (!exists(root)) return { kind: "error", message: `no folder ${slashed(root)}` };
    target = { root, copy: exists(copyCli(root)), named: true };
  } else {
    target = enclosingTree(cwd, exists);
  }
  if (!target) {
    if (NO_TREE.has(command)) return { kind: "local", argv: rest };
    return { kind: "error", message: `this is a checkout of the tool, not an EveJS tree, so \`gridcheck ${command}\` needs one: ` +
      "pass --tree <path>, or run it from inside the tree. `gridcheck setup --tree <path>` installs the tool into a tree first." };
  }
  if (!target.copy) {
    if (!target.named && NO_TREE.has(command)) return { kind: "local", argv: rest };
    if (!looksLikeTree(target.root, exists)) {
      return { kind: "error", message: `${slashed(target.root)} is not an EveJS tree (no server/package.json)` };
    }
    if (exists(path.join(target.root, "tools", "evejs-e2e", "bin", "e2e.js"))) {
      return { kind: "error", message: `${slashed(target.root)} has the tool under its old name, tools/evejs-e2e. ` +
        `\`gridcheck vendor update --tree ${slashed(target.root)}\` moves it to tools/gridcheck and renames its config.` };
    }
    return { kind: "error", message: `${slashed(target.root)} has no copy of the tool yet. ` +
      `Install it with \`gridcheck setup --tree ${slashed(target.root)}\` (or just \`gridcheck vendor update --tree ${slashed(target.root)}\`).` };
  }
  return { kind: "handoff", tree: target.root, cli: copyCli(target.root), argv: rest, command };
}

function gitHead(dir) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

// One line when the tree's copy isn't this checkout's HEAD.
function skewNote(plan, ownRoot) {
  if (!SKEW_NOTE.has(plan.command)) return null;
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(plan.tree, VENDOR_DIR, MANIFEST_NAME), "utf8"));
  } catch (_error) {
    return null;
  }
  const head = gitHead(ownRoot);
  if (!head || !manifest.commit || manifest.commit === head) return null;
  return `note: ${slashed(plan.tree)} runs the tool at ${manifest.commit.slice(0, 7)}; this checkout is at ${head.slice(0, 7)}. ` +
    `\`gridcheck vendor update --tree ${slashed(plan.tree)}\` updates it.`;
}

// Runs the plan. Returns the exit code, or null to go on in this process with plan.argv.
function launch(plan, { ownRoot, stderr = process.stderr } = {}) {
  if (plan.kind === "local") return null;
  if (plan.kind === "error") {
    stderr.write(`gridcheck: ${plan.message}\n`);
    return 2;
  }
  const result = spawnSync(process.execPath, [plan.cli, ...plan.argv], { stdio: "inherit", windowsHide: false });
  if (result.error) {
    stderr.write(`gridcheck: couldn't run ${slashed(plan.cli)}: ${result.error.message}\n`);
    return 1;
  }
  const note = skewNote(plan, ownRoot);
  if (note) stderr.write(`${note}\n`);
  return result.status === null ? 1 : result.status;
}

module.exports = { planLaunch, launch, takeTreeFlag, enclosingTree };
