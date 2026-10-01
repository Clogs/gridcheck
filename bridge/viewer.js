"use strict";

// The human viewer: a small page that draws the tactical view from a run's
// timeline.jsonl (`e2e watch` or `e2e run`), live while the run writes it or
// as a replay afterwards, with the client-fidelity DIVERGE events marked.
//
//   GET /viewer               the page             no token: it carries no data
//   GET /viewer/viewer.js     its script
//   GET /viewer/viewer.css    its styles
//   GET /viewer/runs          the runs in _local/e2e/runs/, newest first   token
//   GET /viewer/timeline?run=<id>&from=<byte>   the next part of a timeline token
//   GET /viewer/config        the plugins' colours                          token
//
// The page reads the token from its URL fragment (`e2e view` prints the URL),
// so it never reaches a server log. Run IDs are checked against the runs
// directory, so a request can't read any other file. The page knows the core's
// event kinds; lines of a plugin's kinds come with the plugin's own text
// (`summaries`), so the page needs no plugin code. Guide:
// docs/E2E-GRID-TESTING.md "Viewer".

const fs = require("node:fs");
const path = require("node:path");

const { formatTimelineEvent } = require("../core/timeline");
const { emptyRegistry } = require("../core/plugins");

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RUNS = 200;
const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const PAGE_FILES = Object.freeze({
  "/viewer": ["index.html", "text/html; charset=utf-8"],
  "/viewer/viewer.js": ["viewer.js", "text/javascript; charset=utf-8"],
  "/viewer/viewer.css": ["viewer.css", "text/css; charset=utf-8"],
});

const KIND_IN_LINE = /"kind":"([A-Z_]+)"/;
// A timeline line's text without its "t+00:00:00  KIND" head.
const LINE_HEAD = /^t[+-]\d\d:\d\d:\d\d {2}\S+\s+/;

// registry: the plugins' (core/plugins.js), for their colours and the text of
// their event kinds.
function createAgentBridgeViewer({ runsDir, pageDir = path.join(__dirname, "viewer"), now = Date.now,
  maxChunkBytes = MAX_CHUNK_BYTES, registry = emptyRegistry() } = {}) {
  if (!runsDir) throw new TypeError("createAgentBridgeViewer needs runsDir");
  const root = path.resolve(runsDir);

  // [lineIndex, text] for each line of a plugin's kind in `text`.
  function summaries(text) {
    const out = [];
    text.split("\n").forEach((line, index) => {
      const kind = KIND_IN_LINE.exec(line);
      if (!kind || !registry.formatters[kind[1]]) return;
      try {
        out.push([index, formatTimelineEvent(JSON.parse(line), registry).replace(LINE_HEAD, "").replace(/\s{2,}/g, "  ")]);
      } catch (_error) {
        // A line cut off by a watch still writing.
      }
    });
    return out;
  }

  function config() {
    return {
      statusCode: 200,
      body: {
        ok: true,
        colours: registry.colours.map(({ plugin, match, colour, label }) => ({ plugin, match, colour, label })),
        plugins: registry.plugins.map((plugin) => plugin.name),
      },
    };
  }

  function handlePublic(method, route) {
    const file = method === "GET" ? PAGE_FILES[route] : null;
    if (!file) return null;
    try {
      return { statusCode: 200, raw: { contentType: file[1], body: fs.readFileSync(path.join(pageDir, file[0])) } };
    } catch (error) {
      return { statusCode: 500, raw: { contentType: "text/plain; charset=utf-8", body: `viewer file missing: ${error.message}` } };
    }
  }

  function runDir(runID) {
    const id = String(runID || "");
    if (!RUN_ID.test(id)) return null;
    const dir = path.resolve(root, id);
    return path.dirname(dir) === root ? dir : null;
  }

  function readResult(dir) {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
      return {
        name: result.name || null,
        passed: result.passed === true,
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        missing: Number(result.missing) || 0,
        expectations: Array.isArray(result.expectations) ? result.expectations.length : 0,
      };
    } catch (_error) {
      return null;
    }
  }

  function listRuns() {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name));
    } catch (_error) {
      return { statusCode: 200, body: { ok: true, runs: [] } };
    }
    const runs = [];
    for (const entry of entries) {
      try {
        const stat = fs.statSync(path.join(root, entry.name, "timeline.jsonl"));
        runs.push({ runID: entry.name, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      } catch (_error) {
        // An economy run or an empty directory: nothing to draw.
      }
    }
    runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const kept = runs.slice(0, MAX_RUNS);
    for (const run of kept) run.result = readResult(path.join(root, run.runID));
    return { statusCode: 200, body: { ok: true, nowMs: now(), runs: kept, more: runs.length - kept.length } };
  }

  // Whole lines from byte `from` on, at most maxChunkBytes; `next` is where the
  // following call starts. A line still being written stays for the next call.
  function timeline(query) {
    const dir = runDir(query && query.run);
    if (!dir) return { statusCode: 400, body: { ok: false, error: "run must be a run ID from /viewer/runs" } };
    const file = path.join(dir, "timeline.jsonl");
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_error) {
      return { statusCode: 404, body: { ok: false, error: `run ${query.run} has no timeline.jsonl` } };
    }
    const from = Math.max(0, Math.trunc(Number(query.from) || 0));
    const size = stat.size;
    let text = "";
    let next = Math.min(from, size);
    if (from < size) {
      const length = Math.min(size - from, maxChunkBytes);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buffer, 0, length, from);
      } finally {
        fs.closeSync(fd);
      }
      const lastNewline = buffer.lastIndexOf(0x0a);
      const used = lastNewline >= 0 ? lastNewline + 1 : (length === maxChunkBytes ? length : 0);
      text = buffer.subarray(0, used).toString("utf8");
      next = from + used;
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        run: String(query.run),
        from,
        next,
        size,
        text,
        summaries: summaries(text),
        mtimeMs: Math.round(stat.mtimeMs),
        nowMs: now(),
        result: readResult(dir),
      },
    };
  }

  function handle(method, route, query) {
    if (method === "GET" && route === "/viewer/runs") return listRuns();
    if (method === "GET" && route === "/viewer/timeline") return timeline(query || {});
    if (method === "GET" && route === "/viewer/config") return config();
    return { statusCode: 404, body: { ok: false, error: `no such route: ${method} ${route}` } };
  }

  return { handle, handlePublic };
}

module.exports = { MAX_CHUNK_BYTES, createAgentBridgeViewer };
