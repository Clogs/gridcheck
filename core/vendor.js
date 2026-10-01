"use strict";

// A tree runs a vendored copy of this repo: one folder, tools/evejs-e2e/, plus
// the shim at server/src/_secondary/agentBridge/server.js that the stock
// secondary-service loader finds. `e2e vendor update` writes both from a
// commit of an evejs-e2e checkout, and VENDOR.json records that commit and a
// sha256 for every file. `e2e vendor check` fails when the copy differs, so a
// fix made in a tree is made in the repo instead.
//
// Files come from git objects, not the checkout's working files, so each keeps
// the line endings it was committed with and uncommitted work is never
// vendored. test/ and the repo's dotfiles stay behind: the tests run from the
// repo (npm run test:tree -- <tree>), and a .gitattributes inside the copy
// would change how the tree's own git reads it.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VENDOR_DIR = path.join("tools", "evejs-e2e");
const SHIM_PATH = path.join("server", "src", "_secondary", "agentBridge", "server.js");
const SHIM_SOURCE = "bridge/shim.js";
const MANIFEST_NAME = "VENDOR.json";
const PACKAGE_NAME = "evejs-e2e";
// The checkout this file sits in, when it is one.
const OWN_CHECKOUT = path.resolve(__dirname, "..");

class VendorError extends Error {}

function vendored(relativePath) {
  const first = relativePath.split("/")[0];
  return !first.startsWith(".") && first !== "test" && relativePath !== MANIFEST_NAME;
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

// The root of an evejs-e2e git checkout, or a VendorError saying why dir isn't one.
function checkoutRoot(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new VendorError(`${dir} is not a directory`);
  let top;
  try {
    top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  } catch (_error) {
    throw new VendorError(`${dir} is not a git checkout; pass --from <evejs-e2e checkout>`);
  }
  // A vendored copy sits inside its tree's checkout; that tree's git is not ours.
  if (!samePath(top, dir)) throw new VendorError(`${dir} is not the root of an evejs-e2e checkout (its git root is ${top})`);
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
    throw new VendorError(`${error.message}. This is a vendored copy: run vendor update from an evejs-e2e ` +
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

function treePaths(tree) {
  const treeRoot = path.resolve(String(tree));
  return { treeRoot, target: path.join(treeRoot, VENDOR_DIR), shim: path.join(treeRoot, SHIM_PATH) };
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
function checkVendored({ tree }) {
  const { target, shim } = treePaths(tree);
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

// Replace tree/tools/evejs-e2e with the source commit's files, install the
// shim and write VENDOR.json. Refuses a copy that has drifted, or a folder that
// was never vendored, unless force.
function updateVendored({ tree, from, force = false }) {
  const { treeRoot, target, shim } = treePaths(tree);
  if (!fs.existsSync(path.join(treeRoot, "server", "src"))) throw new VendorError(`${treeRoot} is not an EveJS tree (no server/src)`);
  const source = readSource({ from });
  if (isInside(source.checkout, target) || isInside(target, source.checkout)) {
    throw new VendorError(`the source checkout ${source.checkout} and ${target} overlap`);
  }
  if (fs.existsSync(target) && !force) {
    if (!readManifest(target)) {
      throw new VendorError(`${target} has no ${MANIFEST_NAME}, so it was not vendored; --force replaces it`);
    }
    const drift = checkVendored({ tree: treeRoot });
    if (!drift.ok) {
      throw new VendorError(`${target} differs from its ${MANIFEST_NAME}; --force replaces it:\n` +
        problemLines(drift.problems).join("\n"));
    }
  }

  const before = new Map(walk(target).filter((entry) => entry.isFile && entry.file !== MANIFEST_NAME)
    .map((entry) => [entry.file, sha256(fs.readFileSync(entry.full))]));
  const manifest = buildManifest(source);

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staged = path.join(parent, `.evejs-e2e-${process.pid}.new`);
  const retired = path.join(parent, `.evejs-e2e-${process.pid}.old`);
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

  const shimBytes = source.files.get(SHIM_SOURCE);
  const shimBefore = fs.existsSync(shim) ? fs.readFileSync(shim) : null;
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, shimBytes);

  const counts = { added: 0, changed: 0, removed: 0, same: 0 };
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!before.has(file)) counts.added += 1;
    else if (before.get(file) !== hash) counts.changed += 1;
    else counts.same += 1;
  }
  for (const file of before.keys()) if (!manifest.files[file]) counts.removed += 1;
  return {
    manifest, target, treeRoot, checkout: source.checkout, dirty: source.dirty, counts,
    shim: shimBefore === null ? "installed" : shimBefore.equals(shimBytes) ? "unchanged" : "replaced",
  };
}

module.exports = {
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
