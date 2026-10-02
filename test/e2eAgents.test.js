"use strict";

// MCP setup for Claude Code and Codex (core/agents.js and `gridcheck agents`):
// detection, the entry each agent reads, and that a setup only adds. Every
// test runs against a scratch home and tree, never this machine's config.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const agents = require("../core/agents");

const CLI = path.join(__dirname, "..", "bin", "gridcheck.js");
const WINDOWS = process.platform === "win32";

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// <dir>/home, <dir>/bin (on PATH), <dir>/tree with a vendored mcp.js.
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-agents-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  const tree = path.join(dir, "My Tree");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  write(path.join(tree, "server", "src", "server.js"), "// a tree\n");
  write(path.join(tree, "tools", "gridcheck", "bin", "mcp.js"), "// the vendored MCP server\n");
  const io = { env: { PATH: bin, PATHEXT: ".EXE;.CMD" }, platform: process.platform, home };
  const tool = (name) => write(path.join(bin, WINDOWS ? `${name}.cmd` : name), "");
  return { dir, home, bin, tree, io, tool, mcp: path.join(tree, "tools", "gridcheck", "bin", "mcp.js").split(path.sep).join("/") };
}

const SAMPLE_CODEX = [
  "model = \"gpt-5\"",
  "",
  "[mcp_servers.node_repl]",
  "args = []",
  "command = 'C:\\Users\\me\\node_repl.exe'",
  "",
  "[mcp_servers.node_repl.env]",
  "SOME_VAR = \"1\"",
  "",
  "[mcp_servers.serena]",
  "command = 'C:\\Users\\me\\serena.exe'",
  "args = [",
  "    \"start-mcp-server\",",
  "    \"--context=codex\",",
  "]",
  "",
  "[projects.'f:\\lu\\dev']",
  "trust_level = \"trusted\"",
  "",
].join("\n");

test("an agent is found by its command on PATH or its config folder, and CODEX_HOME moves Codex's", (t) => {
  const s = setup(t);
  let found = agents.detectAgents(s.io);
  assert.deepStrictEqual([found.claude.installed, found.codex.installed], [false, false]);
  s.tool("claude");
  fs.mkdirSync(path.join(s.home, ".codex"));
  found = agents.detectAgents(s.io);
  assert.strictEqual(found.claude.installed, true);
  assert.match(found.claude.evidence[0], /^claude on PATH/);
  assert.deepStrictEqual(found.codex.evidence, ["~/.codex"]);
  const elsewhere = path.join(s.dir, "codex-home");
  fs.mkdirSync(elsewhere);
  found = agents.detectAgents({ ...s.io, env: { ...s.io.env, CODEX_HOME: elsewhere } });
  assert.match(found.codex.evidence[0], /^CODEX_HOME/);
  assert.strictEqual(agents.planCodex(s.tree, { ...s.io, env: { CODEX_HOME: elsewhere } }).file, path.join(elsewhere, "config.toml"));
});

test("Claude Code: the tree's .mcp.json gets a gridcheck server by relative path, beside the servers it has", (t) => {
  const s = setup(t);
  const fresh = agents.planClaude(s.tree, s.io);
  assert.strictEqual(fresh.change, "add");
  assert.strictEqual(fresh.serverName, "gridcheck");
  assert.deepStrictEqual(JSON.parse(fresh.after), { mcpServers: { gridcheck: { type: "stdio", command: "node", args: ["tools/gridcheck/bin/mcp.js"] } } });

  write(path.join(s.tree, ".mcp.json"), "{\r\n  \"mcpServers\": { \"other\": { \"command\": \"x\" } },\r\n  \"extra\": 1\r\n}\r\n");
  const merged = agents.planClaude(s.tree, s.io);
  assert.deepStrictEqual(Object.keys(JSON.parse(merged.after).mcpServers), ["other", "gridcheck"]);
  assert.strictEqual(JSON.parse(merged.after).extra, 1);
  assert.ok(!/[^\r]\n/.test(merged.after), "the file's CRLF endings are kept");

  fs.writeFileSync(path.join(s.tree, ".mcp.json"), merged.after);
  assert.strictEqual(agents.planClaude(s.tree, s.io).change, "none");

  write(path.join(s.tree, ".mcp.json"), JSON.stringify({ mcpServers: { gridcheck: { command: "node", args: ["../elsewhere/tools/gridcheck/bin/mcp.js"] } } }));
  const taken = agents.planClaude(s.tree, s.io);
  assert.strictEqual(taken.serverName, "gridcheck-tool", "another tree's gridcheck is left alone");
  assert.ok(JSON.parse(taken.after).mcpServers.gridcheck.args[0].startsWith("../elsewhere"));

  write(path.join(s.tree, ".mcp.json"), "{ nope");
  assert.throws(() => agents.planClaude(s.tree, s.io), (error) => error instanceof agents.AgentsError && /is not JSON/.test(error.message));
  write(path.join(s.tree, ".mcp.json"), "[]");
  assert.throws(() => agents.planClaude(s.tree, s.io), /mcpServers object/);
});

test("Codex: config.toml gains a table at its end, and every byte before it is kept", (t) => {
  const s = setup(t);
  const file = write(path.join(s.home, ".codex", "config.toml"), SAMPLE_CODEX);
  const plan = agents.planCodex(s.tree, s.io);
  assert.strictEqual(plan.change, "add");
  assert.strictEqual(plan.serverName, "gridcheck");
  assert.ok(plan.after.startsWith(SAMPLE_CODEX), "the file is only appended to");
  assert.strictEqual(plan.after.slice(SAMPLE_CODEX.length),
    `\n[mcp_servers.gridcheck]\ncommand = "node"\nargs = [${JSON.stringify(s.mcp)}]\ntool_timeout_sec = 600\n`);
  fs.writeFileSync(file, plan.after);
  assert.strictEqual(agents.planCodex(s.tree, s.io).change, "none", "set up once");

  // No file yet, and a file with no final newline.
  fs.rmSync(file);
  assert.strictEqual(agents.planCodex(s.tree, s.io).after, `[mcp_servers.gridcheck]\ncommand = "node"\nargs = [${JSON.stringify(s.mcp)}]\ntool_timeout_sec = 600\n`);
  write(file, "model = \"x\"\r\n[a]\r\nb = 1");
  assert.strictEqual(agents.planCodex(s.tree, s.io).after, `model = "x"\r\n[a]\r\nb = 1\r\n\r\n[mcp_servers.gridcheck]\r\ncommand = "node"\r\n` +
    `args = [${JSON.stringify(s.mcp)}]\r\ntool_timeout_sec = 600\r\n`);
});

test("Codex: another live tree keeps gridcheck and this one gets its own name; a gridcheck whose script is gone is replaced in place", (t) => {
  const s = setup(t);
  const other = write(path.join(s.dir, "other", "tools", "gridcheck", "bin", "mcp.js"), "").split(path.sep).join("/");
  const file = write(path.join(s.home, ".codex", "config.toml"),
    `${SAMPLE_CODEX}[mcp_servers.gridcheck]\ncommand = "node"\nargs = ['${other}']\n\n[mcp_servers.gridcheck-my-tree]\ncommand = "x"\n`);
  const named = agents.planCodex(s.tree, s.io);
  assert.strictEqual(named.change, "add");
  assert.strictEqual(named.serverName, "gridcheck-my-tree-2", "the tree's folder name, then a number past the ones taken");

  const gone = path.join(s.dir, "deleted", "tools", "gridcheck", "bin", "mcp.js").split(path.sep).join("/");
  const before = `${SAMPLE_CODEX}[mcp_servers.gridcheck]\ncommand = "node"\nargs = ["${gone}"]\nstartup_timeout_sec = 9\n\n` +
    "[mcp_servers.gridcheck.env]\nKEEP = \"1\"\n\n[tail]\nx = 1\n";
  fs.writeFileSync(file, before);
  const replaced = agents.planCodex(s.tree, s.io);
  assert.strictEqual(replaced.change, "replace");
  assert.strictEqual(replaced.gone, gone);
  assert.deepStrictEqual(replaced.replaced, ["[mcp_servers.gridcheck]", "command = \"node\"", `args = ["${gone}"]`, "startup_timeout_sec = 9"]);
  assert.strictEqual(replaced.after, before.replace(`args = ["${gone}"]\nstartup_timeout_sec = 9\n`,
    `args = [${JSON.stringify(s.mcp)}]\ntool_timeout_sec = 600\n`), "only the gridcheck table changes; its env table and the rest stay");
});

test("Codex: an inline mcp_servers isn't edited, and the reply carries the entry to add by hand", (t) => {
  const s = setup(t);
  write(path.join(s.home, ".codex", "config.toml"), "mcp_servers.x.command = \"y\"\n[a]\n");
  assert.throws(() => agents.planCodex(s.tree, s.io), /defines mcp_servers inline.*\n\[mcp_servers\.gridcheck\]/s);
  write(path.join(s.home, ".codex", "config.toml"), "[mcp_servers]\nx = { command = \"y\" }\n");
  assert.throws(() => agents.planCodex(s.tree, s.io), /inline/);
});

test("table headers read as key paths, quoted keys included", () => {
  assert.deepStrictEqual(agents.headerKeys("[mcp_servers.node_repl.env]"), ["mcp_servers", "node_repl", "env"]);
  assert.deepStrictEqual(agents.headerKeys("[projects.'f:\\lu\\dev']  # trusted"), ["projects", "f:\\lu\\dev"]);
  assert.deepStrictEqual(agents.headerKeys(" [ plugins . \"a@b\" ]"), ["plugins", "a@b"]);
  for (const line of ["[[array]]", "key = [1]", "[a b]", "[]"]) assert.strictEqual(agents.headerKeys(line), null, line);
});

test("setup writes for the agents found, plans both before writing either, and a dry run writes nothing", (t) => {
  const s = setup(t);
  assert.deepStrictEqual(agents.setupAgents(s.tree, null, { io: s.io }), [], "none found, none chosen");
  s.tool("claude");
  s.tool("codex");
  const dry = agents.setupAgents(s.tree, null, { dryRun: true, io: s.io });
  assert.deepStrictEqual(dry.map((row) => [row.id, row.plan.change, row.wrote]), [["claude", "add", false], ["codex", "add", false]]);
  assert.ok(!fs.existsSync(path.join(s.tree, ".mcp.json")));
  assert.ok(!fs.existsSync(path.join(s.home, ".codex")));

  write(path.join(s.tree, ".mcp.json"), "{ broken");
  assert.throws(() => agents.setupAgents(s.tree, null, { io: s.io }), /is not JSON/);
  assert.ok(!fs.existsSync(path.join(s.home, ".codex", "config.toml")), "Codex wasn't written either");
  fs.rmSync(path.join(s.tree, ".mcp.json"));

  const wrote = agents.setupAgents(s.tree, null, { io: s.io });
  assert.deepStrictEqual(wrote.map((row) => row.wrote), [true, true]);
  assert.match(fs.readFileSync(path.join(s.home, ".codex", "config.toml"), "utf8"), /^\[mcp_servers\.gridcheck\]/);
  assert.deepStrictEqual(agents.setupAgents(s.tree, ["codex"], { io: s.io }).map((row) => row.plan.change), ["none"]);
  assert.throws(() => agents.setupAgents(s.tree, ["cursor"], { io: s.io }), /no agent cursor/);
  const rows = agents.agentStatus(s.tree, s.io);
  assert.deepStrictEqual(rows.map((row) => [row.id, row.installed, row.registered, row.serverName]),
    [["claude", true, true, "gridcheck"], ["codex", true, true, "gridcheck"], ["cli", false, false, "a pointer to tools/gridcheck/docs/CLI.md"]]);
});

test("setup cli adds a pointer to AGENTS.md once, or to an existing CLAUDE.md, keeping its line endings", (t) => {
  const s = setup(t);
  write(path.join(s.tree, "CLAUDE.md"), "# Rules\r\nBe kind.");
  const [row] = agents.setupAgents(s.tree, ["cli"], { io: s.io });
  assert.strictEqual(row.wrote, true);
  const text = fs.readFileSync(path.join(s.tree, "CLAUDE.md"), "utf8");
  assert.strictEqual(text, `# Rules\r\nBe kind.\r\n\r\n${agents.CLI_POINTER.join("\r\n")}\r\n`);
  assert.deepStrictEqual(agents.setupAgents(s.tree, ["cli"], { io: s.io }).map((one) => one.plan.change), ["none"]);
  assert.ok(!fs.existsSync(path.join(s.tree, "AGENTS.md")));
  write(path.join(s.tree, "AGENTS.md"), "# Agents\n");
  agents.setupAgents(s.tree, ["cli"], { io: s.io });
  assert.match(fs.readFileSync(path.join(s.tree, "AGENTS.md"), "utf8"), /^# Agents\n\n<!-- gridcheck:cli -->\n\*\*In-game checks:\*\*/);
  assert.deepStrictEqual(agents.setupAgents(s.tree, null, { io: s.io }).map((one) => one.id), [], "never set up unasked");
});

test("gridcheck agents: status, a dry run that shows the lines, and setup", (t) => {
  const s = setup(t);
  s.tool("claude");
  const env = { ...process.env, GRIDCHECK_TREE: s.tree, HOME: s.home, USERPROFILE: s.home };
  // A copied Windows environment spells it Path; a second PATH key would be ambiguous.
  env[Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH"] = s.bin;
  delete env.CODEX_HOME;
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 60_000, windowsHide: true });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const status = cli("agents");
  assert.strictEqual(status.code, 0, status.out);
  assert.match(status.out, /Claude Code +found \(claude on PATH/);
  assert.match(status.out, /Codex +not found on this machine/);
  const dry = cli("agents", "setup", "--dry-run");
  assert.strictEqual(dry.code, 0, dry.out);
  assert.match(dry.out, /Claude Code: would add server gridcheck to \.mcp\.json/);
  assert.match(dry.out, /^ {2}\+ +"args": \[$/m);
  assert.match(dry.out, /nothing was written \(--dry-run\)/);
  assert.doesNotMatch(dry.out, /Codex/, "only the agents found");
  assert.ok(!fs.existsSync(path.join(s.tree, ".mcp.json")));
  const ran = cli("agents", "setup", "claude", "codex");
  assert.strictEqual(ran.code, 0, ran.out);
  assert.match(ran.out, /Codex: added server gridcheck to .*config\.toml \(not found on this machine\)/);
  assert.match(cli("agents", "setup").out, /Claude Code: already runs this tree's server as gridcheck/);
  assert.strictEqual(cli("agents", "setup", "cursor").code, 1);
});

test("an entry from before the rename, running this tree's tools/evejs-e2e, is replaced by the gridcheck one", (t) => {
  const s = setup(t);
  write(path.join(s.tree, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" },
    e2e: { type: "stdio", command: "node", args: ["tools/evejs-e2e/bin/mcp.js"] } } }, null, 2));
  const claude = agents.planClaude(s.tree, s.io);
  assert.strictEqual(claude.change, "replace");
  assert.strictEqual(claude.serverName, "gridcheck");
  assert.deepStrictEqual(Object.keys(JSON.parse(claude.after).mcpServers), ["other", "gridcheck"]);
  assert.ok(claude.replaced.some((line) => line.includes("tools/evejs-e2e/bin/mcp.js")));

  const old = path.join(s.tree, "tools", "evejs-e2e", "bin", "mcp.js").split(path.sep).join("/");
  write(path.join(s.home, ".codex", "config.toml"), `model = "x"\n\n[mcp_servers.e2e]\ncommand = "node"\nargs = ["${old}"]\n\n[other]\nk = 1\n`);
  const codex = agents.planCodex(s.tree, s.io);
  assert.strictEqual(codex.change, "replace");
  assert.strictEqual(codex.serverName, "gridcheck");
  assert.match(codex.after, /^model = "x"\n\n\[mcp_servers\.gridcheck\]\ncommand = "node"\nargs = \[".*tools\/gridcheck\/bin\/mcp\.js"\]\ntool_timeout_sec = 600\n\n\[other\]\nk = 1\n$/);
});

test("setup cli replaces a pointer from before the rename in place", (t) => {
  const s = setup(t);
  write(path.join(s.tree, "AGENTS.md"), "# Agents\n\n<!-- evejs-e2e:cli -->\nold pointer\n<!-- /evejs-e2e:cli -->\n\n## More\n");
  const [row] = agents.setupAgents(s.tree, ["cli"], { io: s.io });
  assert.strictEqual(row.plan.change, "replace");
  assert.strictEqual(fs.readFileSync(path.join(s.tree, "AGENTS.md"), "utf8"),
    `# Agents\n\n${agents.CLI_POINTER.join("\n")}\n\n## More\n`);
});
