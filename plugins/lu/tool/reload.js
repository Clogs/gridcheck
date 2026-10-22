"use strict";

// `gridcheck lu-reload [<module>]`: a client module LU delivers at login (docs/CLIENT-UI-DELIVERY.md
// in the LU tree), reloaded in the running EVE client without a new login. The source is the
// server's own readSource (bridge GET /client-module), so the files come joined in the order a
// login gets them. Each file found in that source is compiled under its own name,
// lu-<module>/<file>.py, so a syntax error, a traceback and a client_events frame all name
// the file and its line, not a line of the joined text. Then the module's previous controller
// is disposed and install(sm, session, is_ready) runs, as the login bootstrap runs it.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Under the bridge's 2 MiB body, with room for the rest of the command.
const MAX_PAYLOAD_BYTES = 1800 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// Every .py file under the tree's server/src: the files a module's readSource can join.
function serverPythonFiles(treeRoot) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".py")) {
        found.push({ file: full, text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(path.join(treeRoot, "server", "src"));
  return found;
}

// The joined source split back into the files it was joined from: each candidate file whose whole
// text appears in it, the longest first where two overlap. What lies between them (more than the
// joining newlines) is a part of its own. -> [{ name, file, text }], in source order; file is
// null for a part no file matched. A name is the file's base name, or its tree-relative path
// when two parts share one.
function splitSource(source, candidates, { treeRoot = "", moduleID = "module" } = {}) {
  const hits = [];
  for (const candidate of candidates) {
    if (!candidate.text || !candidate.text.trim()) continue;
    const start = source.indexOf(candidate.text);
    if (start >= 0) hits.push({ start, end: start + candidate.text.length, file: candidate.file });
  }
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const chosen = [];
  for (const hit of hits) {
    if (!chosen.some((other) => hit.start < other.end && other.start < hit.end)) chosen.push(hit);
  }
  chosen.sort((a, b) => a.start - b.start);
  const parts = [];
  let at = 0;
  let loose = 0;
  const gap = (end) => {
    const text = source.slice(at, end);
    if (text.trim()) parts.push({ name: `${moduleID}-part${++loose}.py`, file: null, text });
  };
  for (const hit of chosen) {
    gap(hit.start);
    parts.push({ name: path.basename(hit.file), file: hit.file, text: source.slice(hit.start, hit.end) });
    at = hit.end;
  }
  gap(source.length);
  const counts = new Map();
  for (const part of parts) counts.set(part.name, (counts.get(part.name) || 0) + 1);
  for (const part of parts) {
    if (part.file && counts.get(part.name) > 1) part.name = path.relative(treeRoot, part.file).split(path.sep).join("/");
  }
  return parts;
}

// Runs in the client through eval, with _gc_lu set by vars. Python 2.7 (the client), and 3 for the tests.
const RELOAD_PY = String.raw`
def _gc_lu_reload(spec):
    import base64, traceback, zlib
    try:
        import __builtin__ as shared
    except ImportError:
        import builtins as shared
    module = str(spec['module'])
    parts = [(str(part['name']), zlib.decompress(base64.b64decode(part['source64']))) for part in spec['parts']]
    compiled = []
    for name, text in parts:
        try:
            compiled.append((name, compile(text, 'lu-%s/%s' % (module, name), 'exec')))
        except SyntaxError as error:
            line = error.text.decode('utf-8', 'replace') if isinstance(error.text, bytes) else error.text
            return {'ok': False, 'stage': 'compile', 'file': name, 'line': error.lineno, 'column': error.offset,
                    'message': str(error.msg), 'text': line.rstrip() if line else None}
    names = [name for name, _code in compiled]
    size = sum(len(text) for _name, text in parts)
    if spec.get('check'):
        return {'ok': True, 'checked': True, 'parts': names, 'bytes': size}
    handle = getattr(shared, '_lu_client_module_' + module, None)
    if handle is None:
        return {'ok': False, 'stage': 'handle', 'message': 'this client has no %s module: the server it logged in to did not deliver one. '
                'Log in again (client_act logoff, then select) or restart with clients.' % module}
    disposed = 'nothing to dispose'
    if getattr(handle, 'controller', None) is not None:
        try:
            handle.controller.dispose()
            disposed = 'disposed'
        except Exception:
            disposed = 'its dispose() raised ' + traceback.format_exc().strip().splitlines()[-1]
        handle.controller = None
    namespace = {'__builtins__': shared, '__name__': 'lu_client_' + module}
    try:
        for _name, code in compiled:
            eval(code, namespace)
    except Exception:
        return {'ok': False, 'stage': 'run', 'traceback': traceback.format_exc(), 'disposed': disposed}
    install = namespace.get('install')
    if not callable(install):
        return {'ok': False, 'stage': 'install', 'message': 'the module defines no install(sm, session, is_ready)', 'disposed': disposed}
    try:
        forced = not handle.usable()
    except Exception:
        forced = True
    try:
        controller = install(getattr(handle, 'sm', None) or sm, getattr(handle, 'session', None) or session,
                             (lambda: True) if forced else handle.usable)
    except Exception:
        return {'ok': False, 'stage': 'install', 'traceback': traceback.format_exc(), 'disposed': disposed}
    handle.controller = controller
    globals()['lu_module'] = namespace
    globals()['lu_controller'] = controller
    return {'ok': True, 'parts': names, 'bytes': size, 'disposed': disposed, 'forced': forced}

_gc_lu_reload(_gc_lu)
`;

// A Python traceback without the reload's own frames, which name only <gridcheck-eval>.
function moduleTraceback(text) {
  return String(text || "").replace(/\s+$/, "").split(/\r?\n/).filter((line) => !/^\s+File "<gridcheck-eval>"/.test(line));
}

// "lu-luCommand/corpWindow.py", line 12 -> corpWindow.py:12 (server/src/.../corpWindow.py:12).
function frameLocations(lines, parts, treeRoot) {
  const out = [];
  for (const line of lines) {
    const match = /File "lu-[^/"]+\/([^"]+)", line (\d+)/.exec(line);
    if (!match) continue;
    const part = parts.find((row) => row.name === match[1]);
    out.push(`${match[1]}:${match[2]}${part && part.file ? ` (${path.relative(treeRoot, part.file).split(path.sep).join("/")}:${match[2]})` : ""}`);
  }
  return out;
}

async function cmdLuReload(positionals, flags, io) {
  if (positionals.length > 1) throw new io.CliError("usage: gridcheck lu-reload [<module>] [--check] [--then \"<python>\"], e.g. lu-reload luCommand");
  const query = positionals[0] ? `?id=${encodeURIComponent(positionals[0])}` : "";
  const served = await io.bridge("GET", `/client-module${query}`);
  const parts = splitSource(served.source, serverPythonFiles(io.treeRoot), { treeRoot: io.treeRoot, moduleID: served.id });
  const spec = {
    module: served.id,
    check: flags.check === true,
    parts: parts.map((part) => ({ name: part.name, source64: zlib.deflateSync(Buffer.from(part.text, "utf8"), { level: 9 }).toString("base64") })),
  };
  const size = Buffer.byteLength(JSON.stringify(spec));
  if (size > MAX_PAYLOAD_BYTES) throw new io.CliError(`${served.id}'s source is ${Math.round(size / 1024)} KiB deflated, over the ${MAX_PAYLOAD_BYTES / 1024} KiB one command carries`);
  const timing = { ...(flags.user ? { user: flags.user } : {}), timeout: flags.timeout === undefined ? 60 : flags.timeout };
  const reply = await io.clientCommand("eval", { code: RELOAD_PY, vars: { _gc_lu: spec } }, timing);
  const result = (reply.value && reply.value.json) || {};
  const files = parts.map((part) => part.name).join(", ");
  const location = (part) => (part && part.file ? ` (${path.relative(io.treeRoot, part.file).split(path.sep).join("/")})` : "");
  if (flags.json) io.print(JSON.stringify({ module: served.id, version: served.version, parts: parts.map((part) => ({ name: part.name,
    file: part.file ? path.relative(io.treeRoot, part.file).split(path.sep).join("/") : null })), result }, null, 2));
  if (!result.ok) {
    if (result.stage === "compile") {
      const part = parts.find((row) => row.name === result.file);
      throw new io.CliError(`${served.id} doesn't compile: SyntaxError at ${result.file}:${result.line}${result.column ? `:${result.column}` : ""}` +
        `${location(part)}: ${result.message}${result.text ? `\n    ${result.text.trim()}` : ""}`);
    }
    const lines = moduleTraceback(result.traceback);
    const where = frameLocations(lines, parts, io.treeRoot);
    throw new io.CliError(`${served.id}: ${result.stage === "run" ? "running the module's files raised" : result.stage === "install" && result.traceback
      ? "install() raised" : "not reloaded"}${result.message ? `: ${result.message}` : ""}` +
      `${where.length ? `\n  at ${where[where.length - 1]}` : ""}${lines.length ? `\n${lines.join("\n")}` : ""}` +
      `${result.disposed && result.disposed !== "nothing to dispose" ? `\n  (the previous controller was ${result.disposed}; the client now has none)` : ""}`);
  }
  if (!flags.json) {
    if (result.checked) {
      io.print(`${served.id} v${served.version} compiles in the client: ${files} (${Math.round(result.bytes / 1024)} KiB). Nothing was installed.`);
    } else {
      io.print(`reloaded ${served.id} v${served.version} from ${files} (${Math.round(result.bytes / 1024)} KiB); previous controller: ${result.disposed}`);
      io.print(result.forced
        ? "  is_ready is forced true: this client installed the module from an earlier server process (or another character), so its own check says no"
        : "  is_ready is the module's own");
      io.print("  in client_eval: lu_module (the module's namespace), lu_controller (what install returned). Tracebacks name lu-" +
        `${served.id}/<file>; client_events { frame: "lu-${served.id}" } lists them. A new login installs the login's copy again.`);
    }
    if (parts.some((part) => !part.file)) io.print(`  no file under server/src matched ${parts.filter((part) => !part.file).map((part) => part.name).join(", ")}: its lines are the joined text's`);
  }
  if (flags.then !== undefined && !result.checked) {
    const then = await io.clientCommand("eval", { code: String(flags.then) }, timing);
    const value = then.value || {};
    io.print(flags.json ? JSON.stringify({ then: value }, null, 2) : `then: ${value.repr}${value.truncated ? " (truncated)" : ""}`);
  }
  return result;
}

module.exports = { RELOAD_PY, cmdLuReload, frameLocations, moduleTraceback, serverPythonFiles, splitSource };
