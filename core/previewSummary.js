"use strict";

// What a preview's dry-run output says will change, as data the GUI's preview
// dialog draws as cards: which files are new, which existing files change, and
// the lines an agent setup or a patch adds. The output comes from the tree's
// own copy, so this reads its text; a line it doesn't recognise is left to the
// raw output, which the dialog always keeps under "Technical details".

const fs = require("node:fs");
const path = require("node:path");
const vendor = require("./vendor");

const slashed = (file) => String(file).split(path.sep).join("/");
const VENDOR_DIR = slashed(vendor.VENDOR_DIR);
const SHIM_PATH = slashed(vendor.SHIM_PATH);
const outputLines = (output) => String(output || "").split(/\r?\n/);

// A file the output names: shown relative to the tree when it's inside it.
function place(root, file, exists) {
  const full = path.resolve(root, file);
  const relative = path.relative(root, full);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  return { path: inside ? slashed(relative) : slashed(full), outside: !inside, exists: exists(full) };
}

const AGENT_LINE = /^(.+?): would (add|replace) server (\S+) (?:to|in) (.+?)(?:; its old entry ran (.+), which is gone)?( \(not found on this machine\))?$/;
const POINTER_LINE = /^(.+?): would add (a pointer to .+) in (.+)$/;
const SAME_LINE = /^(.+?): (?:already runs this tree's server as (\S+) \((.+)\)|already has (.+) in (.+))$/;
const NEXT_LINE = /^next, (.+?): (.+)$/;
const DIFF_LINE = /^ {2}([+-]) (.*)$/;

function agentSummary(root, output, exists) {
  const changes = [];
  const next = [];
  let current = null;
  for (const line of outputLines(output)) {
    let match = POINTER_LINE.exec(line);
    if (match) {
      current = { kind: "file", ...place(root, match[3], exists), agent: match[1], change: "add", entry: match[2], added: [], removed: [] };
      changes.push(current);
    } else if ((match = AGENT_LINE.exec(line))) {
      current = { kind: "file", ...place(root, match[4], exists), agent: match[1], change: match[2], entry: match[3],
        gone: match[5] || null, notFound: Boolean(match[6]), added: [], removed: [] };
      changes.push(current);
    } else if ((match = SAME_LINE.exec(line))) {
      current = null;
      changes.push({ kind: "file", ...place(root, match[3] || match[5], exists), agent: match[1], change: "none",
        entry: match[2] || match[4], added: [], removed: [] });
    } else if ((match = DIFF_LINE.exec(line)) && current) {
      (match[1] === "+" ? current.added : current.removed).push(match[2]);
    } else if ((match = NEXT_LINE.exec(line))) {
      next.push({ who: match[1], text: match[2] });
    }
  }
  return { changes, next, notes: [] };
}

const VENDOR_HEAD = /^would vendor (\S+) (\S+) (.+?) from (.+)$/;
const VENDOR_COUNTS = /^ {2}(.+): (\d+) files, (\d+) added, (\d+) changed, (\d+) removed, (\d+) the same; shim (?:unchanged|would be (\w+))$/;
const LISTED = /^ {4}([+~-]) (.+)$/;
const MORE = /^ {4}\.\.\. and (\d+) more$/;
const LISTS = { "+": "added", "~": "changed", "-": "removed" };

function vendorSummary(root, output, exists) {
  const changes = [];
  const notes = [];
  let source = null;
  let folder = null;
  let last = null;
  for (const line of outputLines(output)) {
    let match = VENDOR_HEAD.exec(line);
    if (match) {
      source = { name: match[1], version: match[2], at: match[3], from: match[4] };
    } else if ((match = VENDOR_COUNTS.exec(line))) {
      const [added, changed, removed, same] = match.slice(3, 7).map(Number);
      folder = { kind: "folder", ...place(root, VENDOR_DIR, exists), files: Number(match[2]),
        counts: { added, changed, removed, same }, added: [], changed: [], removed: [], more: { added: 0, changed: 0, removed: 0 } };
      changes.push(folder);
      const shim = { kind: "file", ...place(root, SHIM_PATH, exists), role: "shim" };
      shim.change = match[7] === "installed" ? "add" : match[7] === "replaced" ? "replace" : "none";
      changes.push(shim);
    } else if ((match = LISTED.exec(line)) && folder) {
      last = LISTS[match[1]];
      folder[last].push(match[2]);
    } else if ((match = MORE.exec(line)) && folder && last) {
      folder.more[last] = Number(match[1]);
    } else if (/uncommitted changes; they wouldn't be vendored|^ {2}would (move|rename) /.test(line)) {
      notes.push(line.trim());
    }
  }
  return { changes, next: [], notes, source };
}

const PATCH_HEAD = /^would (apply|revert) (\S+) in (.+)$/;
const HUNK = /^ {2}(.+):(\d+) (inserts|removes) (\d+) lines (before|after) "(.*)" \((CRLF|LF|CR)\)$/;
const HUNK_LINE = /^ {4}([+-]) ?(.*)$/;

function patchSummary(root, output, exists, srcDir) {
  const changes = [];
  const notes = [];
  const byFile = new Map();
  let hunk = null;
  for (const line of outputLines(output)) {
    let match = PATCH_HEAD.exec(line);
    if (match) {
      for (const file of match[3].split(", ")) {
        const entry = { kind: "file", ...place(root, path.join(srcDir, file), exists), change: "replace", hunks: [] };
        byFile.set(file, entry);
        changes.push(entry);
      }
    } else if ((match = HUNK.exec(line))) {
      const entry = byFile.get(match[1]);
      hunk = entry ? { line: Number(match[2]), removes: match[3] === "removes", where: match[5], near: match[6], eol: match[7], lines: [] } : null;
      if (hunk) entry.hunks.push(hunk);
    } else if ((match = HUNK_LINE.exec(line)) && hunk) {
      hunk.lines.push(match[2]);
    } else if ((match = /^note: (.+)$/.exec(line))) {
      notes.push(match[1]);
    }
  }
  return { changes, next: [], notes };
}

function initSummary(root, output, exists) {
  const changes = [];
  const lines = outputLines(output);
  const head = lines.map((line) => /^would write (.+), mode (\S+)$/.exec(line)).find(Boolean);
  if (head) {
    const start = lines.findIndex((line) => line.startsWith("nothing was written (--dry-run). The file would be:"));
    const body = start >= 0 ? lines.slice(start + 1).filter((line, i, all) => i < all.length - 1 || line !== "") : [];
    const entry = { kind: "file", ...place(root, head[1], exists), mode: head[2], added: body };
    entry.change = entry.exists ? "replace" : "add";
    changes.push(entry);
  }
  return { changes, next: [], notes: lines.filter((line) => line.startsWith("note: ")).map((line) => line.slice(6)) };
}

// The patch command checks its own targets and reports what would stop it
// on lines of its own.
function outputBlockers(output) {
  return outputLines(output).map((line) => /^refused when run: (.+)$/.exec(line)).filter(Boolean).map((match) => match[1]);
}

/**
 * @param {string} action  a GUI action: agents, vendor, patch-apply, patch-revert, init or setup
 * @param {string} root    the tree
 * @param {{output: string}[]} steps  the dry runs, in order
 * @param {{srcDir?: string, exists?: Function}} [options]  srcDir: the server's src folder, for patch targets
 */
function summarizePreview(action, root, steps, { srcDir = path.join(root, "server", "src"), exists = fs.existsSync } = {}) {
  const output = steps.map((step) => step.output || "").join("\n");
  const empty = { changes: [], next: [], notes: [] };
  const summary = action === "agents" ? agentSummary(root, output, exists)
    : action === "vendor" ? vendorSummary(root, output, exists)
      : action === "patch-apply" || action === "patch-revert" ? patchSummary(root, output, exists, srcDir)
        : action === "init" ? initSummary(root, output, exists)
          : empty;
  return { ...summary, refusedWhenRun: outputBlockers(output) };
}

module.exports = { summarizePreview };
