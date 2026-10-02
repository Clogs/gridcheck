"use strict";

// A tree runs a vendored copy of this repo: one folder, tools/gridcheck/, plus
// the shim at server/src/_secondary/agentBridge/server.js that the stock
// secondary-service loader finds. `gridcheck vendor update` writes both from a
// commit of a Gridcheck checkout, and VENDOR.json records that commit and a
// sha256 for every file. `gridcheck vendor check` fails when the copy differs, so a
// fix made in a tree is made in the repo instead.
//
// Files come from git objects, not the checkout's working files, so each keeps
// the line endings it was committed with and uncommitted work is never
// vendored. test/ and the repo's dotfiles stay behind: the tests and the
// compatibility script run from the repo (npm test, npm run compat), and a
// .gitattributes inside the copy would change how the tree's own git reads it.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VENDOR_DIR = path.join("tools", "gridcheck");
const SHIM_PATH = path.join("server", "src", "_secondary", "agentBridge", "server.js");
const SHIM_SOURCE = "bridge/shim.js";
const MANIFEST_NAME = "VENDOR.json";
const PACKAGE_NAME = "gridcheck";
// The checkout this file sits in, when it is one.
const OWN_CHECKOUT = path.resolve(__dirname, "..");
// The tree this copy is vendored into, as core/plugins.js reads it. Repeated
// here because this file must load when the rest of the copy doesn't.
const OWN_TREE = String(process.env.GRIDCHECK_TREE || "").trim()
  ? path.resolve(process.env.GRIDCHECK_TREE.trim())
  : path.resolve(__dirname, "..", "..", "..");
const USAGE = "usage: gridcheck vendor update [--from <checkout|tag>] [--tree <path>] [--force] [--dry-run] | vendor check [--tree <path>]";
// How many files of each kind a dry run lists.
const DRY_RUN_FILES = 40;

class VendorError extends Error {}

// The compatibility report is the repo's evidence, with the machine's paths in it.
const REPO_ONLY = new Set([MANIFEST_NAME, "compat-report.md"]);

function vendored(relativePath) {
  const first = relativePath.split("/")[0];
  return !first.startsWith(".") && first !== "test" && !REPO_ONLY.has(relativePath);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function git(cwd, args, { input = undefined, binary = false } = {}) {
  const result = spawnSync("git", args, {
    cwd, input, windowsHide: true, maxBuffer: 1 << 30, encoding: binary ? undefined : "utf8",
  });
  if (result.error) throw new VendorError(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new VendorError(`git ${args.join(" ")} in ${cwd}: ${String(stderr).trim()}`);
  }
  return result.stdout;
}

function samePath(a, b) {
  const norm = (value) => path.resolve(value).toLowerCase();
  return process.platform === "win32" ? norm(a) === norm(b) : path.resolve(a) === path.resolve(b);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// The root of a Gridcheck git checkout, or a VendorError saying why dir isn't one.
function checkoutRoot(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new VendorError(`${dir} is not a directory`);
  let top;
  try {
    top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  } catch (_error) {
    throw new VendorError(`${dir} is not a git checkout; pass --from <Gridcheck checkout>`);
  }
  // A vendored copy sits inside its tree's checkout; that tree's git is not ours.
  if (!samePath(top, dir)) throw new VendorError(`${dir} is not the root of a Gridcheck checkout (its git root is ${top})`);
  return path.resolve(dir);
}

// --from: a checkout directory (its HEAD), or a tag, branch or commit of the
// checkout this file is in. Nothing: this checkout's HEAD.
function resolveSource(from) {
  const text = from === undefined || from === null || from === true ? "" : String(from).trim();
  if (text && fs.existsSync(text)) return { checkout: checkoutRoot(text), ref: "HEAD" };
  let checkout;
  try {
    checkout = checkoutRoot(OWN_CHECKOUT);
  } catch (error) {
    throw new VendorError(`${error.message}. This is a vendored copy: run vendor update from a Gridcheck ` +
      "checkout, or pass --from <checkout>");
  }
  return { checkout, ref: text || "HEAD" };
}

// git cat-file --batch: one request per line, each answer "<sha> blob <size>\n<bytes>\n".
function readBlobs(checkout, shas) {
  const unique = [...new Set(shas)];
  if (!unique.length) return new Map();
  const out = git(checkout, ["cat-file", "--batch"], { input: `${unique.join("\n")}\n`, binary: true });
  const blobs = new Map();
  let at = 0;
  for (const sha of unique) {
    const newline = out.indexOf(0x0a, at);
    const [got, type, size] = out.toString("utf8", at, newline).split(" ");
    if (got !== sha || type !== "blob") throw new VendorError(`git cat-file answered "${got} ${type}" for ${sha}`);
    const start = newline + 1;
    blobs.set(sha, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
}

// -> { checkout, ref, commit, version, files: Map(path -> bytes), dirty }
function readSource({ from } = {}) {
  const { checkout, ref } = resolveSource(from);
  let commit;
  try {
    commit = git(checkout, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch (_error) {
    throw new VendorError(`${checkout} has no commit "${ref}"`);
  }
  const entries = [];
  for (const record of git(checkout, ["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (!vendored(file)) continue;
    if (type !== "blob" || mode === "120000") throw new VendorError(`${file} at ${commit} is a ${mode === "120000" ? "symlink" : type}, not a file`);
    entries.push({ file, sha });
  }
  const blobs = readBlobs(checkout, entries.map((entry) => entry.sha));
  const files = new Map(entries.map((entry) => [entry.file, blobs.get(entry.sha)]));
  let pkg = null;
  try {
    pkg = JSON.parse(String(files.get("package.json") || ""));
  } catch (_error) {
    pkg = null;
  }
  if (!pkg || pkg.name !== PACKAGE_NAME) throw new VendorError(`${checkout} at ${ref} is not ${PACKAGE_NAME} (package.json)`);
  if (!files.has(SHIM_SOURCE)) throw new VendorError(`${checkout} at ${ref} has no ${SHIM_SOURCE}`);
  const dirty = git(checkout, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
  return { checkout, ref, commit, version: String(pkg.version || "0.0.0"), files, dirty };
}

// Every file under dir, as forward-slash paths relative to it.
function walk(dir, base = dir, into = []) {
  if (!fs.existsSync(dir)) return into;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, into);
    else into.push({ file: path.relative(base, full).split(path.sep).join("/"), full, isFile: entry.isFile() });
  }
  return into;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function buildManifest(source) {
  const shim = source.files.get(SHIM_SOURCE);
  return {
    name: PACKAGE_NAME,
    version: source.version,
    commit: source.commit,
    ref: source.ref,
    shim: { path: SHIM_PATH.split(path.sep).join("/"), sha256: sha256(shim) },
    files: sortedObject([...source.files].map(([file, bytes]) => [file, sha256(bytes)])),
  };
}

// Before the rename to Gridcheck a tree's copy was tools/evejs-e2e and its
// config e2e.config.json; vendor update moves both.
const LEGACY_VENDOR_DIR = path.join("tools", "evejs-e2e");
const LEGACY_CONFIG = "e2e.config.json";
const CONFIG_FILE = "gridcheck.config.json";

function treePaths(tree) {
  const treeRoot = path.resolve(String(tree));
  return { treeRoot, target: path.join(treeRoot, VENDOR_DIR), shim: path.join(treeRoot, SHIM_PATH),
    legacy: path.join(treeRoot, LEGACY_VENDOR_DIR) };
}

function readManifest(target) {
  const file = path.join(target, MANIFEST_NAME);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new VendorError(`${file} is not JSON: ${error.message}`);
  }
}

// -> { ok, manifest, problems: [{ file, problem }] }. problem: edited, missing,
// added, not a file, shim edited, shim missing.
// copy: the folder to check, when it isn't the tree's tools/gridcheck (an old copy before it moves).
function checkVendored({ tree, copy = null }) {
  const { target: own, shim } = treePaths(tree);
  const target = copy || own;
  if (!fs.existsSync(target)) return { ok: false, manifest: null, problems: [{ file: VENDOR_DIR, problem: "missing" }] };
  const manifest = readManifest(target);
  if (!manifest || !manifest.files || typeof manifest.files !== "object") {
    return { ok: false, manifest: null, problems: [{ file: MANIFEST_NAME, problem: "missing" }] };
  }
  const problems = [];
  const onDisk = new Map();
  for (const entry of walk(target)) {
    if (entry.file === MANIFEST_NAME) continue;
    if (!entry.isFile) problems.push({ file: entry.file, problem: "not a file" });
    else onDisk.set(entry.file, entry.full);
  }
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!onDisk.has(file)) problems.push({ file, problem: "missing" });
    else if (sha256(fs.readFileSync(onDisk.get(file))) !== expected) problems.push({ file, problem: "edited" });
  }
  for (const file of onDisk.keys()) {
    if (!Object.prototype.hasOwnProperty.call(manifest.files, file)) problems.push({ file, problem: "added" });
  }
  const shimFile = SHIM_PATH.split(path.sep).join("/");
  if (!fs.existsSync(shim)) problems.push({ file: shimFile, problem: "shim missing" });
  else if (!manifest.shim || sha256(fs.readFileSync(shim)) !== manifest.shim.sha256) problems.push({ file: shimFile, problem: "shim edited" });
  problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { ok: problems.length === 0, manifest, problems };
}

function problemLines(problems) {
  return problems.map((row) => `  ${row.problem.padEnd(12)} ${row.file}`);
}

// Replace tree/tools/gridcheck with the source commit's files, install the
// shim and write VENDOR.json. Refuses a copy that has drifted, or a folder that
// was never vendored, unless force.
function updateVendored({ tree, from, force = false, dryRun = false }) {
  const { treeRoot, target, shim, legacy } = treePaths(tree);
  if (!fs.existsSync(path.join(treeRoot, "server", "src"))) throw new VendorError(`${treeRoot} is not an EveJS tree (no server/src)`);
  const source = readSource({ from });
  if (isInside(source.checkout, target) || isInside(target, source.checkout)) {
    throw new VendorError(`the source checkout ${source.checkout} and ${target} overlap`);
  }
  // A copy from before the rename, with nothing at the new place yet, is the copy this update replaces.
  const migrating = !fs.existsSync(target) && fs.existsSync(legacy);
  const current = migrating ? legacy : target;
  if (fs.existsSync(current) && !force) {
    if (!readManifest(current)) {
      throw new VendorError(`${current} has no ${MANIFEST_NAME}, so it was not vendored; --force replaces it`);
    }
    const drift = checkVendored({ tree: treeRoot, copy: current });
    if (!drift.ok) {
      throw new VendorError(`${current} differs from its ${MANIFEST_NAME}; --force replaces it:\n` +
        problemLines(drift.problems).join("\n"));
    }
  }
  const legacyConfig = path.join(treeRoot, LEGACY_CONFIG);
  const moveConfig = fs.existsSync(legacyConfig) && !fs.existsSync(path.join(treeRoot, CONFIG_FILE));
  const migrated = migrating || moveConfig
    ? { copy: migrating ? slashed(LEGACY_VENDOR_DIR) : null, config: moveConfig ? LEGACY_CONFIG : null } : null;

  const before = new Map(walk(current).filter((entry) => entry.isFile && entry.file !== MANIFEST_NAME)
    .map((entry) => [entry.file, sha256(fs.readFileSync(entry.full))]));
  const manifest = buildManifest(source);
  const changes = { added: [], changed: [], removed: [], same: 0 };
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!before.has(file)) changes.added.push(file);
    else if (before.get(file) !== hash) changes.changed.push(file);
    else changes.same += 1;
  }
  for (const file of before.keys()) if (!manifest.files[file]) changes.removed.push(file);
  const counts = { added: changes.added.length, changed: changes.changed.length, removed: changes.removed.length, same: changes.same };
  const shimBytes = source.files.get(SHIM_SOURCE);
  const shimBefore = fs.existsSync(shim) ? fs.readFileSync(shim) : null;
  const shimState = shimBefore === null ? "installed" : shimBefore.equals(shimBytes) ? "unchanged" : "replaced";
  const result = { manifest, target, treeRoot, checkout: source.checkout, dirty: source.dirty, counts, changes, shim: shimState,
    migrated };
  if (dryRun) return { ...result, dryRun: true };

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staged = path.join(parent, `.gridcheck-${process.pid}.new`);
  const retired = path.join(parent, `.gridcheck-${process.pid}.old`);
  fs.rmSync(staged, { recursive: true, force: true });
  try {
    for (const [file, bytes] of source.files) {
      const out = path.join(staged, ...file.split("/"));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
    }
    fs.writeFileSync(path.join(staged, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    if (fs.existsSync(target)) fs.renameSync(target, retired);
    try {
      fs.renameSync(staged, target);
    } catch (error) {
      if (fs.existsSync(retired)) fs.renameSync(retired, target);
      throw error;
    }
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  fs.rmSync(retired, { recursive: true, force: true });

  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, shimBytes);
  if (migrating) fs.rmSync(legacy, { recursive: true, force: true });
  if (moveConfig) fs.renameSync(legacyConfig, path.join(treeRoot, CONFIG_FILE));
  return result;
}

const slashed = (file) => String(file).split(path.sep).join("/");

// `gridcheck vendor <action>` -> the lines to print; a VendorError when it fails.
// What a move from the old names did, or would do.
function migrationLines(migrated, mood) {
  if (!migrated) return [];
  const verb = mood === "would" ? ["would move", "would rename"] : ["moved", "renamed"];
  return [
    ...(migrated.copy ? [`  ${verb[0]} the copy from ${migrated.copy}/ (its name before Gridcheck) to ${slashed(VENDOR_DIR)}/`] : []),
    ...(migrated.config ? [`  ${verb[1]} ${migrated.config} to ${CONFIG_FILE}`] : []),
  ];
}

function runVendor(action, { tree = OWN_TREE, from, force = false, dryRun = false } = {}) {
  const treeRoot = path.resolve(String(tree));
  const target = slashed(path.join(treeRoot, VENDOR_DIR));
  if (action === "update") {
    const result = updateVendored({ tree: treeRoot, from, force, dryRun });
    const { manifest, counts } = result;
    if (dryRun) {
      const listed = (label, files) => {
        const shown = files.slice(0, DRY_RUN_FILES).map((file) => `    ${label} ${file}`);
        return files.length > DRY_RUN_FILES ? [...shown, `    ... and ${files.length - DRY_RUN_FILES} more`] : shown;
      };
      return [
        `would vendor ${manifest.name} ${manifest.version} at ${manifest.commit.slice(0, 8)} (${manifest.ref}) from ${slashed(result.checkout)}`,
        `  ${target}: ${Object.keys(manifest.files).length} files, ${counts.added} added, ${counts.changed} changed, ` +
          `${counts.removed} removed, ${counts.same} the same; shim ${result.shim === "unchanged" ? "unchanged" : `would be ${result.shim}`}`,
        ...listed("+", result.changes.added),
        ...listed("~", result.changes.changed),
        ...listed("-", result.changes.removed),
        ...(result.dirty ? [`  ${slashed(result.checkout)} has uncommitted changes; they wouldn't be vendored`] : []),
        ...migrationLines(result.migrated, "would"),
        "  nothing was written (--dry-run)",
      ];
    }
    return [
      `vendored ${manifest.name} ${manifest.version} at ${manifest.commit.slice(0, 8)} (${manifest.ref}) from ${slashed(result.checkout)}`,
      `  ${target}: ${Object.keys(manifest.files).length} files, ${counts.added} added, ${counts.changed} changed, ` +
        `${counts.removed} removed; shim ${result.shim}`,
      ...(result.dirty ? [`  ${slashed(result.checkout)} has uncommitted changes; they were not vendored`] : []),
      ...migrationLines(result.migrated, "did"),
      `  commit ${slashed(VENDOR_DIR)}/ and ${slashed(SHIM_PATH)} in ${slashed(treeRoot)}` +
        (result.migrated ? ", and the removal of the old names" : ""),
    ];
  }
  if (action === "check") {
    const result = checkVendored({ tree: treeRoot });
    if (!result.ok) {
      throw new VendorError([`${target} differs from ${MANIFEST_NAME}; change the Gridcheck repo and run ` +
        "gridcheck vendor update:", ...problemLines(result.problems)].join("\n"));
    }
    const { manifest } = result;
    return [`${target} matches ${MANIFEST_NAME}: ${manifest.name} ${manifest.version} at ` +
      `${String(manifest.commit).slice(0, 8)}, ${Object.keys(manifest.files).length} files and the shim`];
  }
  throw new VendorError(USAGE);
}

function parseVendorArgs(argv) {
  const options = { action: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force") options.force = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--tree" || token === "--from") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new VendorError(`${token} needs a value`);
      options[token.slice(2)] = value;
      index += 1;
    } else if (!token.startsWith("--") && !options.action) options.action = token;
    else throw new VendorError(`unknown argument ${token}\n${USAGE}`);
  }
  return options;
}

// bin/gridcheck.js runs this before it loads anything else, so a copy whose other
// files no longer load can still say which ones changed.
function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { action, ...options } = parseVendorArgs(argv);
    for (const line of runVendor(action, options)) stdout.write(`${line}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof VendorError)) throw error;
    stderr.write(`gridcheck: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  USAGE,
  main,
  parseVendorArgs,
  runVendor,
  MANIFEST_NAME,
  SHIM_PATH,
  SHIM_SOURCE,
  VENDOR_DIR,
  VendorError,
  buildManifest,
  checkVendored,
  problemLines,
  readSource,
  updateVendored,
  vendored,
};
