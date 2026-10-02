"use strict";

// Optional stock edits (patches/*.js), applied and reverted as anchored
// insertions. Nothing here copies EveJS code: a hunk names lines that must
// already be in the file, once, and the lines to insert beside them.
//
//   module.exports = {
//     id: "xmpp-port", version: 1, title: "...",
//     hunks: [{
//       file: "edge/chat/chatEdgeRuntime.js",   // relative to server/src
//       anchor: ["const address = Object.freeze({"],  // consecutive lines, compared trimmed
//       insert: "before",                      // or "after"
//       at: 0,                                 // which anchor line (default: first for
//                                              // before, last for after)
//       lines: ["  if (...) {", "  }"],        // inserted as written
//     }],
//     detect({ read }) {},                     // equivalent code without the marker
//   };
//
// Every hunk is written as a marker line (`// gridcheck:patch <id> v<n>`)
// followed by its lines, each ending as the anchor line ends, so a file's mixed
// line endings stay as they were. Revert removes exactly those lines and then
// re-applies the patch to what's left: if that doesn't give the file back byte
// for byte, the file changed since and revert refuses.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PATCHES_DIR = path.join(__dirname, "..", "patches");
const PATCH_MARKER = "gridcheck:patch";
// Copies from before the rename to Gridcheck wrote this. Status reads it and
// revert removes it, so a tree patched then reverts byte for byte.
const LEGACY_MARKERS = Object.freeze(["evejs-e2e:patch"]);

class PatchError extends Error {}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function loadPatches(dir = PATCHES_DIR, load = require) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".js")).sort().map((name) => {
    try {
      return normalizePatch(load(path.join(dir, name)));
    } catch (error) {
      return { id: name.replace(/\.js$/, ""), title: `failed to load: ${errorText(error)}`, files: [], hunks: [],
        detect: null, broken: true };
    }
  });
}

function normalizePatch(patch) {
  const hunks = Array.isArray(patch.hunks) ? patch.hunks : [];
  const files = Array.isArray(patch.files) && patch.files.length ? patch.files : [...new Set(hunks.map((hunk) => hunk.file))];
  return { ...patch, hunks, files };
}

function markerText(patch) {
  return `${patch.markerPrefix || PATCH_MARKER} ${String(patch.id).replace(/[^a-z0-9-]/gi, "")} v${Number(patch.version) || 1}`;
}

function markerPattern(patch) {
  return new RegExp(`(?:${[PATCH_MARKER, ...LEGACY_MARKERS].join("|")}) ${String(patch.id).replace(/[^a-z0-9-]/gi, "")} v(\\d+)`, "g");
}

// The marker prefix a file's applied copy of this patch was written with.
function markerPrefixIn(patch, text) {
  const id = String(patch.id).replace(/[^a-z0-9-]/gi, "");
  return [PATCH_MARKER, ...LEGACY_MARKERS].find((prefix) => String(text || "").includes(`${prefix} ${id} v`)) || PATCH_MARKER;
}

// -> [{ text, eol }]. The last line's eol is "" when the file doesn't end in one.
function splitLines(text) {
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r)?/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === "") break;
    lines.push({ text: match[1], eol: match[2] || "" });
  }
  return lines;
}

function joinLines(lines) {
  return lines.map((line) => line.text + line.eol).join("");
}

function leadingSpace(text) {
  return /^\s*/.exec(text)[0];
}

function findAnchor(lines, anchor) {
  const wanted = anchor.map((line) => String(line).trim());
  const found = [];
  for (let index = 0; index + wanted.length <= lines.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (lines[index + offset].text.trim() !== wanted[offset]) {
        same = false;
        break;
      }
    }
    if (same) found.push(index);
  }
  return found;
}

function hunkBlock(patch, hunk, reference) {
  const indent = leadingSpace(hunk.lines.length ? hunk.lines[0] : reference.text);
  return [`${indent}// ${markerText(patch)}`, ...hunk.lines];
}

function anchorText(hunk) {
  return hunk.anchor.length === 1 ? `"${hunk.anchor[0]}"` : `"${hunk.anchor[0]}" (+${hunk.anchor.length - 1} lines)`;
}

// The insertions one file's hunks make, against `text`.
// -> { ok: true, after, inserts: [{ line, eol, block, hunk }] } | { ok: false, problems }
function planFile(patch, hunks, text) {
  const lines = splitLines(text);
  const problems = [];
  const inserts = [];
  for (const hunk of hunks) {
    const found = findAnchor(lines, hunk.anchor);
    if (found.length !== 1) {
      problems.push(`${hunk.file}: anchor ${anchorText(hunk)} ${found.length ? `occurs ${found.length} times` : "is missing"}`);
      continue;
    }
    const before = hunk.insert === "before";
    const at = Number.isInteger(hunk.at) ? hunk.at : before ? 0 : hunk.anchor.length - 1;
    const referenceIndex = found[0] + at;
    const reference = lines[referenceIndex];
    let eol = reference.eol;
    if (!eol && before) {
      for (let index = referenceIndex - 1; index >= 0 && !eol; index -= 1) eol = lines[index].eol;
    }
    if (!eol) {
      problems.push(`${hunk.file}: anchor ${anchorText(hunk)} is on a line with no line ending to copy`);
      continue;
    }
    inserts.push({ line: before ? referenceIndex : referenceIndex + 1, eol, block: hunkBlock(patch, hunk, reference), hunk });
  }
  if (problems.length) return { ok: false, problems };
  const positions = new Set();
  for (const insert of inserts) {
    if (positions.has(insert.line)) return { ok: false, problems: [`${hunks[0].file}: two hunks insert at line ${insert.line + 1}`] };
    positions.add(insert.line);
  }
  const out = lines.slice();
  for (const insert of [...inserts].sort((a, b) => b.line - a.line)) {
    out.splice(insert.line, 0, ...insert.block.map((blockLine) => ({ text: blockLine, eol: insert.eol })));
  }
  return { ok: true, after: joinLines(out), inserts };
}

function hunksByFile(patch) {
  const byFile = new Map();
  for (const hunk of patch.hunks) {
    if (!byFile.has(hunk.file)) byFile.set(hunk.file, []);
    byFile.get(hunk.file).push(hunk);
  }
  return byFile;
}

function createReader(serverRoot) {
  const srcRoot = path.join(serverRoot, "src");
  const cache = new Map();
  const read = (relativePath) => {
    if (!cache.has(relativePath)) {
      let text = null;
      try {
        const bytes = fs.readFileSync(path.join(srcRoot, ...relativePath.split("/")));
        text = bytes.toString("utf8");
        // A file that isn't UTF-8 wouldn't come back byte for byte.
        if (!Buffer.from(text, "utf8").equals(bytes)) text = { notUtf8: true };
      } catch (_error) {
        text = null;
      }
      cache.set(relativePath, text);
    }
    const value = cache.get(relativePath);
    return typeof value === "string" ? value : null;
  };
  read.isBinary = (relativePath) => {
    read(relativePath);
    const value = cache.get(relativePath);
    return Boolean(value && typeof value === "object");
  };
  read.absolute = (relativePath) => path.join(srcRoot, ...relativePath.split("/"));
  return read;
}

function countMarkers(patch, text) {
  const versions = [];
  for (const found of String(text || "").matchAll(markerPattern(patch))) versions.push(Number(found[1]));
  return versions;
}

// One patch's state against a tree's files.
// -> { id, title, headline?, gain?, without?, commands?, files, hunks, state, version?, ... }
//   headline, gain and without are for people: what the patch gets you, and what
//   you get without it. hunks is the number of insertions.
//   applied    its markers are in place (version: the one applied)
//   partial    some of its markers are, not all
//   detected   equivalent code without the marker (as in the LU fork)
//   absent     not there; `applies` says whether apply would work, `problems` why not
//   no-target  a file it changes isn't in the tree
//   unknown    no check for equivalent code, or the check failed
function patchState(patch, read) {
  const files = Array.isArray(patch.files) ? patch.files : [];
  const row = { id: patch.id, title: patch.title || "" };
  for (const key of ["headline", "gain", "without"]) if (typeof patch[key] === "string" && patch[key]) row[key] = patch[key];
  if (Array.isArray(patch.commands) && patch.commands.length) row.commands = patch.commands;
  Object.assign(row, { files, hunks: patch.hunks.length, state: "absent" });
  if (patch.broken) return { ...row, state: "unknown" };
  const missing = files.filter((file) => read(file) === null && !(read.isBinary && read.isBinary(file)));
  if (missing.length) return { ...row, state: "no-target", missing };
  const markers = files.flatMap((file) => countMarkers(patch, read(file)));
  if (markers.length) {
    const applied = { ...row, version: markers[0] };
    if (!patch.hunks.length) return { ...applied, state: "applied" };
    if (markers.length !== patch.hunks.length || markers.some((version) => version !== markers[0])) {
      return { ...applied, state: "partial", problems: [`${markers.length} of ${patch.hunks.length} markers in place`] };
    }
    return { ...applied, state: "applied" };
  }
  const plan = patch.hunks.length ? planApply(patch, read) : null;
  const applies = plan ? { applies: plan.ok, ...(plan.ok ? {} : { problems: plan.problems }) } : {};
  if (typeof patch.detect !== "function") return { ...row, state: patch.hunks.length ? "absent" : "unknown", ...applies };
  try {
    return patch.detect({ read }) ? { ...row, state: "detected" } : { ...row, state: "absent", ...applies };
  } catch (error) {
    return { ...row, state: "unknown", error: errorText(error) };
  }
}

function patchStates(serverRoot, { patches = loadPatches() } = {}) {
  const read = createReader(serverRoot);
  return patches.map((patch) => patchState(normalizePatch(patch), read));
}

// -> { ok, files: [{ file, before, after, inserts }], problems }
function planApply(patch, read) {
  const files = [];
  const problems = [];
  for (const [file, hunks] of hunksByFile(patch)) {
    if (read.isBinary && read.isBinary(file)) {
      problems.push(`${file}: not UTF-8, so it couldn't be written back byte for byte`);
      continue;
    }
    const before = read(file);
    if (before === null) {
      problems.push(`${file}: not in this tree`);
      continue;
    }
    if (countMarkers(patch, before).length) {
      problems.push(`${file}: already has this patch's marker`);
      continue;
    }
    const plan = planFile(patch, hunks, before);
    if (!plan.ok) problems.push(...plan.problems);
    else files.push({ file, before, after: plan.after, inserts: plan.inserts });
  }
  return { ok: problems.length === 0, files, problems };
}

// Remove each hunk's marker and lines, then check that applying the patch
// to the result gives the current file back exactly.
function planRevert(patch, read) {
  const files = [];
  const problems = [];
  for (const [file, hunks] of hunksByFile(patch)) {
    const current = read(file);
    if (current === null) {
      problems.push(`${file}: not in this tree`);
      continue;
    }
    const versions = countMarkers(patch, current);
    if (!versions.length) {
      problems.push(`${file}: this patch's marker isn't there`);
      continue;
    }
    const wanted = Number(patch.version) || 1;
    if (versions.some((version) => version !== wanted)) {
      problems.push(`${file}: applied at v${versions[0]}, and this copy has v${wanted}; revert with the copy that applied it`);
      continue;
    }
    const lines = splitLines(current);
    const remove = new Set();
    let unmatched = 0;
    // Remove and re-apply with the marker this file was patched with.
    const applied = { ...patch, markerPrefix: markerPrefixIn(patch, current) };
    const marker = `// ${markerText(applied)}`;
    for (const hunk of hunks) {
      const block = [marker, ...hunk.lines.map((line) => line.trimEnd())];
      let found = -1;
      for (let index = 0; index + block.length <= lines.length && found < 0; index += 1) {
        if (remove.has(index) || lines[index].text.trim() !== marker) continue;
        let same = true;
        for (let offset = 1; offset < block.length; offset += 1) {
          if (lines[index + offset].text.trimEnd() !== block[offset]) {
            same = false;
            break;
          }
        }
        if (same) found = index;
      }
      if (found < 0) {
        unmatched += 1;
        continue;
      }
      for (let offset = 0; offset < block.length; offset += 1) remove.add(found + offset);
    }
    if (unmatched) {
      problems.push(`${file}: ${unmatched} of ${hunks.length} inserted blocks were edited or moved; revert it by hand`);
      continue;
    }
    const after = joinLines(lines.filter((_line, index) => !remove.has(index)));
    const again = planFile(applied, hunks, after);
    if (!again.ok || again.after !== current) {
      problems.push(`${file}: changed since the patch was applied, so revert can't give the file back exactly; revert it by hand`);
      continue;
    }
    files.push({ file, before: current, after, inserts: again.inserts });
  }
  return { ok: problems.length === 0, files, problems };
}

// -> { git: false } | { git: true, dirty: [relative paths] }
function gitDirty(treeRoot, absoluteFiles) {
  const top = spawnSync("git", ["-C", treeRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  if (top.status !== 0) return { git: false };
  const result = spawnSync("git", ["-C", treeRoot, "status", "--porcelain", "--", ...absoluteFiles],
    { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new PatchError(`git status failed: ${(result.stderr || "").trim()}`);
  return { git: true, dirty: result.stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean) };
}

function writeAll(read, files, field) {
  const written = [];
  try {
    for (const entry of files) {
      fs.writeFileSync(read.absolute(entry.file), Buffer.from(entry[field], "utf8"));
      written.push(entry);
    }
  } catch (error) {
    const back = field === "after" ? "before" : "after";
    for (const entry of written) fs.writeFileSync(read.absolute(entry.file), Buffer.from(entry[back], "utf8"));
    throw new PatchError(`writing ${files[written.length].file} failed (${errorText(error)}); the files written before it were put back`);
  }
}

// The lines a plan inserts (apply) or removes (revert), with a line of context.
function previewLines(plan, { removing = false } = {}) {
  const lines = [];
  for (const entry of plan.files) {
    const context = splitLines(removing ? entry.after : entry.before);
    for (const insert of entry.inserts) {
      const near = insert.line < context.length ? context[insert.line] : context[insert.line - 1];
      lines.push(`  ${entry.file}:${insert.line + 1} ${removing ? "removes" : "inserts"} ${insert.block.length} lines ` +
        `${insert.line < context.length ? "before" : "after"} "${near ? near.text.trim() : ""}"` +
        ` (${insert.eol === "\r\n" ? "CRLF" : insert.eol === "\n" ? "LF" : "CR"})`);
      for (const text of insert.block) lines.push(`    ${removing ? "-" : "+"} ${text}`);
    }
  }
  return lines;
}

function findPatch(patches, id) {
  const patch = patches.find((candidate) => candidate.id === id);
  if (!patch) throw new PatchError(`no patch ${id}; gridcheck patch list shows them (${patches.map((row) => row.id).join(", ")})`);
  if (patch.broken) throw new PatchError(`patch ${id} ${patch.title}`);
  if (!patch.hunks.length) throw new PatchError(`patch ${id} has no hunks to apply`);
  return patch;
}

// Apply or revert one patch. `serverUp` is the CLI's answer to "is this
// tree's server running" (a reason string, or null).
// -> { id, action, files, preview, notes }
function changePatch(action, id, { treeRoot, serverRoot, patches = loadPatches(), serverUp = null, dryRun = false,
  dirtyCheck = gitDirty } = {}) {
  const patch = findPatch(patches, id);
  const read = createReader(serverRoot);
  const notes = [];
  if (action === "apply") {
    const state = patchState(patch, read);
    if (state.state === "applied") throw new PatchError(`${id} is already applied (v${state.version})`);
    if (state.state === "partial") throw new PatchError(`${id} is partly applied (${state.problems.join("; ")}); fix it by hand`);
    if (state.state === "detected") throw new PatchError(`${id}: this tree already has equivalent code, so it doesn't need the patch`);
  }
  const plan = action === "apply" ? planApply(patch, read) : planRevert(patch, read);
  if (!plan.ok) throw new PatchError(`${action} ${id} refused: ${plan.problems.join("; ")}`);
  const preview = previewLines(plan, { removing: action === "revert" });
  // What would stop the real change. A dry run reports them, so a preview
  // says up front that the change would be refused.
  const blockers = [];
  if (serverUp) blockers.push(`${serverUp}. Stop it first (gridcheck down)`);
  if (action === "apply") {
    const status = dirtyCheck(treeRoot, plan.files.map((entry) => read.absolute(entry.file)));
    if (!status.git) notes.push("this tree isn't a git checkout, so uncommitted changes to the targets weren't checked");
    else if (status.dirty.length) blockers.push(`uncommitted changes in ${status.dirty.join(", ")}. Commit or discard them first`);
  }
  const files = plan.files.map((entry) => entry.file);
  if (dryRun) return { id, action, files, preview, notes, blockers, dryRun: true };
  if (blockers.length) throw new PatchError(`${action} ${id} refused: ${blockers[0]}`);
  writeAll(read, plan.files, "after");
  return { id, action, files, preview, notes };
}

module.exports = {
  LEGACY_MARKERS,
  PATCH_MARKER,
  PATCHES_DIR,
  PatchError,
  changePatch,
  createReader,
  gitDirty,
  joinLines,
  loadPatches,
  markerText,
  normalizePatch,
  patchState,
  patchStates,
  planApply,
  planRevert,
  previewLines,
  splitLines,
};
