"use strict";

// The page `e2e gui` serves (core/gui.js): the header, the tabs, Install,
// Patches and the preview dialog. The Runs tab is gui/runs.js, over the replay
// model in gui/replay.js. It builds every element with textContent, never
// HTML, so nothing a run or a tree contains can run here. Every change goes
// through the preview dialog: the server runs the CLI command with --dry-run,
// the dialog shows its output, and Run asks the server to run that same
// command by the preview's ID.

(() => {
  const $ = (id) => document.getElementById(id);

  // The token arrives in the fragment once, then lives in this tab only.
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token") || sessionStorage.getItem("e2eGuiToken") || "";
  if (params.get("token")) sessionStorage.setItem("e2eGuiToken", token);

  const state = {
    context: null,
    trees: [],
    treeID: params.get("tree") || null,
    tab: params.get("tab") || "runs",
    tree: null,
    summaries: new Map(),
    preview: null,
    blobs: [],
    frameSeek: null,
  };

  // ---------- helpers ----------

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = String(value);
      else if (key === "className") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function message(text, ok = false) {
    $("message").textContent = text || "";
    $("message").className = ok ? "ok" : "";
  }

  async function api(route, { method = "GET", body } = {}) {
    const response = await fetch(route, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  }

  async function blobURL(route) {
    const response = await fetch(route, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    state.blobs.push(url);
    return url;
  }

  function freeBlobs() {
    for (const url of state.blobs) URL.revokeObjectURL(url);
    state.blobs = [];
  }

  const q = (value) => encodeURIComponent(value);
  const short = (commit) => (commit ? String(commit).slice(0, 8) : "?");

  function badge(cls, text, dot = false) {
    return h("span", { className: `badge ${cls}` }, dot ? h("i", { className: "dot" }) : null, text);
  }

  function saveHash() {
    const parts = [`tab=${q(state.tab)}`];
    if (state.treeID) parts.push(`tree=${q(state.treeID)}`);
    if (state.tab === "runs" && runs) parts.push(...runs.hashParts());
    history.replaceState(null, "", `#${parts.join("&")}`);
  }

  function setCount(name, n, warn = false) {
    const node = $(`${name}-n`);
    if (!node) return;
    node.hidden = n === null || n === undefined;
    node.textContent = String(n ?? "");
    node.className = `n${warn ? " warn" : ""}`;
  }

  // ---------- a small Markdown reader for report.md ----------

  const FRAME_LINK = /^frames\/([A-Za-z0-9][A-Za-z0-9._-]*\.svg)$/;

  function inline(text, frames) {
    const out = [];
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(!?\[[^\]]*\]\([^)\s]+\))/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index));
      const piece = match[0];
      if (match[1]) out.push(h("code", { text: piece.slice(1, -1) }));
      else if (match[2]) out.push(h("strong", { text: piece.slice(2, -2) }));
      else {
        const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(piece);
        const frame = FRAME_LINK.exec(link[3]);
        if (frame && link[1]) {
          const img = h("img", { alt: link[2] });
          frames.url(frame[1]).then((url) => { img.src = url; }).catch(() => {});
          img.addEventListener("click", () => frames.open(img.src, frame[1]));
          out.push(img);
        } else if (frame) {
          out.push(h("a", { text: link[2], title: link[3], onclick: () => frames.url(frame[1]).then((url) => frames.open(url, frame[1])) }));
        } else {
          out.push(h("span", { title: link[3], text: link[2] }));
        }
      }
      last = match.index + piece.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function tableCells(line) {
    const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let cell = "";
    let inCode = false;
    for (const char of body) {
      if (char === "`") inCode = !inCode;
      if (char === "|" && !inCode) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += char;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  // frameURL(file) -> Promise<url>; openFrame(url, file) shows it.
  function renderMarkdown(text, into, frameURL, openFrame) {
    const frames = { url: frameURL, open: openFrame };
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    let paragraph = [];
    const flush = () => {
      if (paragraph.length) into.append(h("p", {}, inline(paragraph.join(" "), frames)));
      paragraph = [];
    };
    while (index < lines.length) {
      const line = lines[index];
      if (/^```/.test(line)) {
        flush();
        const code = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
        into.append(h("pre", { text: code.join("\n") }));
        index += 1;
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        into.append(h(`h${heading[1].length}`, {}, inline(heading[2], frames)));
        index += 1;
        continue;
      }
      if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|[\s|:-]+\|\s*$/.test(lines[index + 1])) {
        flush();
        const head = tableCells(line);
        const table = h("table", {}, h("thead", {}, h("tr", {}, head.map((cell) => h("th", {}, inline(cell, frames))))));
        const tbody = h("tbody");
        index += 2;
        while (index < lines.length && /^\s*\|/.test(lines[index])) {
          tbody.append(h("tr", {}, tableCells(lines[index]).map((cell) => h("td", {}, inline(cell, frames)))));
          index += 1;
        }
        table.append(tbody);
        into.append(table);
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        flush();
        const list = h("ul");
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
          list.append(h("li", {}, inline(lines[index].replace(/^\s*[-*]\s+/, ""), frames)));
          index += 1;
        }
        into.append(list);
        continue;
      }
      if (!line.trim()) flush();
      else paragraph.push(line.trim());
      index += 1;
    }
    flush();
  }

  function showFrame(src, file, atMs, seekFn) {
    if (!src) return;
    $("frame-image").src = src;
    $("frame-image").alt = file;
    $("frame-title").textContent = file;
    state.frameSeek = Number.isFinite(atMs) && seekFn ? () => seekFn(atMs) : null;
    $("frame-seek").hidden = !state.frameSeek;
    $("frame-view").showModal();
  }

  // ---------- the Runs tab ----------

  let runs = null;
  const shell = {
    api, blobURL, freeBlobs, h, message, token, params, saveHash, setCount, renderMarkdown, showFrame,
    treeID: () => state.treeID,
    refreshContext: () => renderContext(),
  };

  // ---------- trees, header and tabs ----------

  async function loadContext() {
    const body = await api("/gui/api/context");
    state.context = body.context;
    const c = state.context;
    const node = $("context");
    node.textContent = `${c.version || "?"} · ${short(c.commit)}`;
    node.title = c.mode === "vendored"
      ? `vendored copy ${c.version || "?"} at ${c.commit || "?"}, managing ${c.tree}`
      : `checkout ${c.root}, ${c.version || "?"} at ${c.commit || "?"}${c.dirty ? " (uncommitted changes aren't vendored)" : ""}`;
  }

  async function loadTrees() {
    const body = await api("/gui/api/trees");
    state.trees = body.trees || [];
    if (!state.trees.some((tree) => tree.id === state.treeID)) {
      state.treeID = (state.trees.find((tree) => tree.copy) || state.trees[0] || {}).id || null;
    }
    const select = $("tree");
    select.textContent = "";
    for (const tree of state.trees) select.append(h("option", { value: tree.id, text: `${tree.name} — ${tree.root}` }));
    if (state.treeID) select.value = state.treeID;
    renderTreeBadges();
    renderTreeCards();
    renderContext();
  }

  function currentTree() {
    return state.trees.find((tree) => tree.id === state.treeID) || null;
  }

  function renderTreeBadges() {
    const box = $("tree-badges");
    box.textContent = "";
    const tree = currentTree();
    if (!tree) return;
    box.append(tree.copy ? badge("ok", `e2e ${tree.copy.version || "?"} · ${short(tree.copy.commit)}`, true) : badge("warn", tree.isTree ? "not installed" : "not a tree"));
    if (tree.mode) box.append(badge("mute", tree.mode));
    if (tree.up) box.append(badge("warn", "server up", true));
  }

  async function loadSummary(id = state.treeID, { fresh = false } = {}) {
    if (!id) return null;
    if (!fresh && state.summaries.has(id)) return state.summaries.get(id);
    const body = await api(`/gui/api/tree?tree=${q(id)}`);
    state.summaries.set(id, body.tree);
    if (id === state.treeID) renderContext();
    return body.tree;
  }

  function renderContext() {
    const bar = $("ctxbar");
    bar.textContent = "";
    const tree = currentTree();
    if (!tree) {
      bar.append(h("span", { className: "cx muted", text: "No tree yet: add one on the Install tab." }));
      return;
    }
    const summary = state.summaries.get(tree.id);
    const cx = (label, ...value) => bar.append(h("span", { className: "cx" }, h("span", { className: "lbl", text: label }), ...value));
    const run = state.tab === "runs" && runs ? runs.context() : {};
    if (state.tab === "runs") cx("World", run.world || "-");
    cx("Server", h("i", { className: `dot ${tree.up ? "ok" : ""}` }), tree.up ? "up" : "down");
    cx("Mode", tree.mode || "no config");
    cx("Copy", tree.copy ? h("i", { className: `dot ${summary && summary.copy && !summary.copy.ok ? "warn" : "ok"}` }) : h("i", { className: "dot warn" }),
      tree.copy ? `${tree.copy.version || "?"}${summary && summary.copy && !summary.copy.ok ? " · edited" : ""}` : "not installed");
    if (summary && summary.plugins) {
      cx("Plugins", summary.plugins.active.length ? summary.plugins.active.join(", ") : "none active");
    }
    if (state.tab === "runs" && run.client) cx("Client view", run.client);
    const where = state.tab === "runs" && run.runsDir ? run.runsDir : tree.root;
    bar.append(h("span", { className: "cx path", text: where, title: where }));
  }

  function selectTree(id) {
    if (id === state.treeID) return;
    state.treeID = id;
    $("tree").value = id;
    if (runs) runs.treeChanged();
    setCount("patches", null);
    renderTreeBadges();
    renderTreeCards();
    renderContext();
    saveHash();
    showTab(state.tab);
    loadSummary().catch(() => {});
    countPatches();
  }

  function showTab(tab) {
    state.tab = ["runs", "install", "patches"].includes(tab) ? tab : "runs";
    for (const button of document.querySelectorAll("#tabs [data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
    }
    for (const section of document.querySelectorAll("section.tab")) section.hidden = section.id !== `tab-${state.tab}`;
    if (runs) {
      if (state.tab === "runs") runs.show();
      else runs.hide();
    }
    saveHash();
    renderContext();
    if (!state.treeID) {
      if (state.tab === "install") renderInstall(null);
      if (state.tab === "runs") {
        $("runs-empty").hidden = false;
        $("runs-empty").textContent = "Add a tree on the Install tab.";
      }
      return;
    }
    const load = state.tab === "runs" ? () => runs.load() : state.tab === "install" ? loadInstall : loadPatches;
    load().catch((error) => message(error.message));
  }

  // ---------- Install ----------

  function renderTreeCards() {
    const list = $("trees");
    list.textContent = "";
    $("trees-count").textContent = state.trees.length ? String(state.trees.length) : "";
    if (!state.trees.length) {
      list.append(h("li", { className: "none", text: state.context && state.context.mode === "checkout"
        ? "No trees yet. Add one by its path below: an unpacked EveJS zip, or a fork's checkout." : "No tree." }));
    }
    for (const tree of state.trees) {
      const item = h("li", { className: tree.id === state.treeID ? "sel" : "", onclick: () => { state.tab = "install"; selectTree(tree.id); } },
        h("div", { className: "top" },
          h("b", { text: tree.name }),
          tree.copy ? badge("ok", `${tree.copy.version || "?"} · ${short(tree.copy.commit)}`) : badge("warn", tree.isTree ? "not installed" : "not a tree"),
          tree.mode ? badge("mute", tree.mode) : null,
          tree.up ? badge("warn", "server up") : null,
          tree.source === "added" ? h("button", { type: "button", className: "btn sm ghost forget", text: "Forget", title: "Take it off this list",
            onclick: (event) => { event.stopPropagation(); forgetTree(tree.id); } }) : null),
        h("div", { className: "path", text: tree.root }),
        h("div", { className: "src", text: tree.source === "nearby" ? "found beside this checkout" : tree.source }));
      list.append(item);
    }
  }

  async function addTree(event) {
    event.preventDefault();
    const input = $("add-path");
    try {
      const body = await api("/gui/api/trees", { method: "POST", body: { path: input.value } });
      input.value = "";
      await loadTrees();
      state.tab = "install";
      selectTree(body.tree.id);
      message(`added ${body.tree.root}`, true);
    } catch (error) {
      message(error.message);
    }
  }

  async function forgetTree(id) {
    try {
      await api("/gui/api/trees/forget", { method: "POST", body: { tree: id } });
      if (state.treeID === id) state.treeID = null;
      await loadTrees();
      showTab(state.tab);
    } catch (error) {
      message(error.message);
    }
  }

  async function loadInstall() {
    state.tree = await loadSummary(state.treeID, { fresh: true });
    renderInstall(state.tree);
    message("");
  }

  function checkItem(ok, text, extra) {
    return h("li", { className: ok === null ? "info" : ok ? "ok" : "bad" }, h("span", {}, text, extra ? h("span", { className: "muted", text: extra }) : null));
  }

  function setBadge(id, node) {
    const box = $(id);
    box.textContent = "";
    if (node) box.append(node);
  }

  function renderInstall(tree) {
    $("install-empty").hidden = Boolean(tree);
    $("install-detail").hidden = !tree;
    if (!tree) return;
    const vendoredGui = state.context.mode === "vendored";
    $("install-title").textContent = tree.name;
    $("install-root").textContent = `${tree.root}${tree.git === false ? "  (not a git checkout, so uncommitted changes can't be checked)" : ""}`;

    const copy = tree.copy || {};
    let status;
    if (!copy.present) status = "Not installed. Install copies this checkout's committed files into tools/evejs-e2e/ and adds the shim.";
    else if (!copy.vendored) status = "tools/evejs-e2e/ exists but has no VENDOR.json, so it wasn't vendored. Installing replaces it (--force).";
    else {
      status = `${copy.version} at ${short(copy.commit)}. ${copy.ok ? "It matches its VENDOR.json." : `It differs from its VENDOR.json in ${copy.problemCount} place(s):`}`;
      if (!vendoredGui) status += copy.upToDate ? " Same commit as this checkout." : ` This checkout is at ${short(state.context.commit)}.`;
    }
    setBadge("copy-badge", !copy.present ? badge("warn", "not installed") : !copy.vendored ? badge("warn", "not vendored")
      : !copy.ok ? badge("bad", "edited", true) : copy.upToDate || vendoredGui ? badge("ok", "matches", true) : badge("info", "update available"));
    $("copy-status").textContent = status;
    const problems = $("copy-problems");
    problems.textContent = "";
    for (const row of copy.problems || []) problems.append(h("li", {}, h("code", { text: row.file }), ` ${row.problem}`));
    const needsForce = copy.present && (!copy.vendored || !copy.ok);
    $("copy-force-label").hidden = !needsForce;
    $("copy-force").checked = needsForce && !copy.vendored;
    $("copy-from-row").hidden = !vendoredGui;
    $("copy-preview").textContent = copy.present ? "Preview update" : "Preview install";
    $("copy-preview").disabled = !vendoredGui && copy.upToDate && copy.ok;
    $("copy-preview").title = $("copy-preview").disabled ? "Already this checkout's commit" : "";
    $("shim-status").textContent = { missing: "missing", edited: "edited since it was vendored", matches: "matches", present: "present" }[tree.shim] || tree.shim;

    const config = tree.config || {};
    setBadge("config-badge", !copy.present ? null : config.exists ? badge(config.problems && config.problems.length ? "warn" : "ok", config.mode) : badge("warn", "missing"));
    $("config-status").textContent = !copy.present ? "Install the copy first."
      : config.exists ? `${config.file}, mode ${config.mode}. Runs go to ${config.runsDir}.`
        : `No ${config.file || "e2e.config.json"} yet. Managed mode lets e2e start the server, restore worlds and build recipes; ` +
          "attach mode uses a server you start.";
    const configProblems = $("config-problems");
    configProblems.textContent = "";
    for (const problem of config.problems || []) configProblems.append(h("li", { text: problem }));
    $("config-mode").value = config.exists ? config.mode : "managed";
    $("config-preview").disabled = !copy.present;
    $("config-preview").textContent = config.exists ? "Preview rewrite" : "Preview config";

    const prereqs = $("prereqs");
    prereqs.textContent = "";
    for (const row of tree.prerequisites || []) prereqs.append(checkItem(row.ok, row.name, row.ok ? null : row.fix));
    $("server-status").textContent = tree.serverUp ? `${tree.serverUp}. Changes wait until it stops.` : "The tree's server is down.";

    const plugins = $("plugins");
    plugins.textContent = "";
    for (const name of tree.plugins.active) plugins.append(checkItem(true, `plugin ${name}`, "active"));
    for (const row of tree.plugins.skipped) plugins.append(checkItem(null, `plugin ${row.name}`, `skipped: ${row.reason}`));
    $("doctor-run").disabled = !copy.present;

    const next = $("next-steps");
    next.textContent = "";
    const cli = "node tools/evejs-e2e/bin/e2e.js";
    if (!copy.present) next.append(h("p", { text: "Install the copy, then write the config." }));
    else if (!config.exists) next.append(h("p", { text: "Write the config." }));
    else if ((tree.prerequisites || []).some((row) => !row.ok)) next.append(h("p", { text: "Finish what the tree needs (above), then run e2e doctor." }));
    else {
      next.append(h("p", { text: "Apply the patches you want on the Patches tab, then from the tree's folder:" }),
        h("pre", { text: config.mode === "managed"
          ? `${cli} world build starter\n${cli} run loadout-npc-fight\n${cli} help`
          : `(start the server with EVEJS_AGENT_BRIDGE=1 set)\n${cli} login\n${cli} run smoke-undock\n${cli} help` }),
        h("p", { className: "muted", text: "Each run shows up on the Runs tab." }));
    }
  }

  async function runDoctor() {
    const out = $("doctor-output");
    out.hidden = false;
    out.textContent = "running e2e doctor...";
    $("doctor-run").disabled = true;
    try {
      const body = await api(`/gui/api/doctor?tree=${q(state.treeID)}`);
      const doctor = body.doctor;
      $("doctor-command").textContent = `${doctor.command}  (in ${doctor.cwd})`;
      out.textContent = doctor.json ? formatDoctor(doctor.json) : doctor.output;
      if (doctor.json && doctor.json.plugins) {
        const plugins = $("plugins");
        plugins.textContent = "";
        for (const name of doctor.json.plugins.active) plugins.append(checkItem(true, `plugin ${name}`, "active (the tree's copy says)"));
        for (const row of doctor.json.plugins.skipped) plugins.append(checkItem(null, `plugin ${row.name}`, `skipped: ${row.reason}`));
      }
    } catch (error) {
      out.textContent = error.message;
    } finally {
      $("doctor-run").disabled = false;
    }
  }

  // The same lines `e2e doctor` prints, from its --json report.
  function formatDoctor(report) {
    const lines = [];
    const tool = report.tool || {};
    lines.push(`evejs-e2e  ${tool.version || "?"}${tool.commit ? ` at ${short(tool.commit)}` : ""}${tool.vendored ? " (vendored)" : " (checkout)"}`);
    const config = report.tree && report.tree.config;
    lines.push(`tree       ${report.tree ? report.tree.root : "?"}; ${config && config.exists ? `e2e.config.json, mode ${config.mode}` : "no e2e.config.json"}`);
    for (const problem of (config && config.problems) || []) lines.push(`           config problem: ${problem}`);
    lines.push(`checked    ${report.source || "?"}`);
    const gateway = report.gateway || {};
    if (!gateway.known) lines.push(`gateway    unknown: ${gateway.error}`);
    else if (!gateway.missing.length) lines.push(`gateway    all ${gateway.calls.length} calls the CLI makes are allowed`);
    else {
      lines.push(`gateway    ${gateway.missing.length} of ${gateway.calls.length} calls the CLI makes are refused:`);
      for (const call of gateway.missing) lines.push(`             ${call.service}.${call.method} (${call.usedBy})`);
    }
    const destiny = report.destiny || {};
    lines.push(destiny.ok ? `destiny    the decoder reads this tree's ball layout (${destiny.balls} probe balls); client view on`
      : `destiny    client view OFF: ${destiny.error}`);
    lines.push(`patches    ${(report.patches || []).map((patch) => `${patch.id} ${patch.state}${patch.version ? ` v${patch.version}` : ""}`).join(", ") || "none known"}`);
    const listeners = Object.entries(report.listeners || {});
    lines.push(listeners.length ? `listeners  move: ${listeners.filter(([, row]) => row.movable).map(([name]) => name).join(", ") || "none"}` +
      `${listeners.some(([, row]) => !row.movable) ? `; stay on stock ports: ${listeners.filter(([, row]) => !row.movable).map(([name]) => name).join(", ")}` : ""}`
      : "listeners  not probed yet (e2e init)");
    if (report.loadout) lines.push(report.loadout.ok ? "loadout    the stock ship helpers are there" : `loadout    OFF: ${report.loadout.missing.join("; ")}`);
    return lines.join("\n");
  }

  // ---------- Patches ----------

  // Patches not applied and not already there, for the tab's count.
  async function countPatches() {
    const tree = currentTree();
    if (!tree || !tree.copy) return;
    const id = tree.id;
    try {
      const body = await api(`/gui/api/patches?tree=${q(id)}`);
      if (id !== state.treeID || !Array.isArray(body.patches.json)) return;
      const open = body.patches.json.filter((row) => row.state === "absent" || row.state === "partial").length;
      setCount("patches", open || null, open > 0);
    } catch (_error) {
      // The count is a hint; the tab says what went wrong.
    }
  }

  async function loadPatches() {
    const tbody = $("patches").querySelector("tbody");
    const tree = currentTree();
    if (!tree || !tree.copy) {
      tbody.textContent = "";
      $("patches-empty").hidden = false;
      $("patches-empty").textContent = "Install the copy into this tree first (Install tab).";
      return;
    }
    $("patches-empty").hidden = false;
    $("patches-empty").textContent = "reading the tree's patch status...";
    const body = await api(`/gui/api/patches?tree=${q(state.treeID)}`);
    const patches = body.patches;
    $("patches-empty").hidden = true;
    $("patches-command").textContent = `${patches.command}  (in ${patches.cwd})`;
    tbody.textContent = "";
    if (!Array.isArray(patches.json)) {
      $("patches-empty").hidden = false;
      $("patches-empty").textContent = patches.output || "patch status printed nothing";
      return;
    }
    const open = patches.json.filter((row) => row.state === "absent" || row.state === "partial").length;
    setCount("patches", open || null, open > 0);
    for (const row of patches.json) {
      const cls = row.state === "applied" || row.state === "detected" ? "ok" : row.state === "absent" ? "mute" : "bad";
      const why = row.state === "detected" ? "equivalent code is already there, so this tree doesn't need it"
        : row.state === "absent" && row.applies ? "applies cleanly"
          : row.problems ? row.problems.join("; ") : row.missing ? `${row.missing.join(", ")} not in this tree` : row.error || "";
      const actions = h("td", { className: "act" });
      if (row.state === "absent") actions.append(h("button", { type: "button", className: "btn sm primary", text: "Preview apply", onclick: () => preview({ action: "patch-apply", id: row.id }) }));
      if (row.state === "applied") actions.append(h("button", { type: "button", className: "btn sm", text: "Preview revert", onclick: () => preview({ action: "patch-revert", id: row.id }) }));
      tbody.append(h("tr", {},
        h("td", {}, h("code", { text: row.id })),
        h("td", {}, badge(cls, `${row.state}${row.version ? ` v${row.version}` : ""}`, cls === "ok")),
        h("td", {}, row.title, why ? h("div", { className: "why", text: why }) : null),
        actions));
    }
  }

  // ---------- preview and run ----------

  const ACTION_TITLES = { vendor: "Install or update the copy", init: "Write e2e.config.json", "patch-apply": "Apply a patch", "patch-revert": "Revert a patch" };

  async function preview(request) {
    const dialog = $("preview");
    $("preview-title").textContent = `${ACTION_TITLES[request.action] || request.action}${request.id ? `: ${request.id}` : ""}`;
    $("preview-refused").textContent = "";
    $("preview-steps").textContent = "";
    $("preview-note").textContent = "Running the command with --dry-run...";
    $("preview-run").disabled = true;
    $("preview-run").hidden = false;
    state.preview = null;
    if (!dialog.open) dialog.showModal();
    try {
      const body = await api("/gui/api/preview", { method: "POST", body: { tree: state.treeID, ...request } });
      const p = body.preview;
      for (const reason of p.refused) $("preview-refused").append(h("li", { text: reason }));
      for (const step of p.steps) {
        $("preview-steps").append(h("div", { className: "step-block" },
          h("div", { className: "command", text: step.command }),
          h("div", { className: `exit${step.exitCode === 0 ? "" : " bad"}`, text: `in ${step.cwd}. Its dry run (${step.dryRun}) ${step.exitCode === 0 ? "printed" : `exited ${step.exitCode}:`}` }),
          h("pre", { text: step.output.trim() || "(no output)" })));
      }
      $("preview-note").textContent = p.note;
      state.preview = p.ok ? p.previewID : null;
      $("preview-run").disabled = !p.ok;
    } catch (error) {
      $("preview-note").textContent = error.message;
    }
  }

  async function runPreview() {
    if (!state.preview) return;
    const id = state.preview;
    state.preview = null;
    $("preview-run").disabled = true;
    $("preview-note").textContent = "Running...";
    try {
      const body = await api("/gui/api/run", { method: "POST", body: { previewID: id } });
      const result = body.result;
      $("preview-steps").textContent = "";
      $("preview-refused").textContent = "";
      for (const reason of result.refused) $("preview-refused").append(h("li", { text: reason }));
      for (const step of result.steps) {
        $("preview-steps").append(h("div", { className: "step-block" },
          h("div", { className: "command", text: step.command }),
          h("div", { className: `exit${step.exitCode === 0 ? "" : " bad"}`, text: `exit ${step.exitCode}, ${Math.round(step.ms / 100) / 10} s` }),
          h("pre", { text: step.output.trim() || "(no output)" })));
      }
      $("preview-note").textContent = result.ok ? "Done." : "It didn't finish; the output above says why.";
      $("preview-run").hidden = true;
      message(result.ok ? "done" : "the command failed", result.ok);
    } catch (error) {
      $("preview-note").textContent = error.message;
    }
    state.summaries.clear();
    await loadTrees().catch(() => {});
    showTab(state.tab);
    loadSummary().catch(() => {});
    countPatches();
  }

  // ---------- start ----------

  function wire() {
    for (const button of document.querySelectorAll("#tabs [data-tab]")) button.addEventListener("click", () => showTab(button.dataset.tab));
    $("tree").addEventListener("change", () => selectTree($("tree").value));
    $("install-refresh").addEventListener("click", () => loadInstall().catch((error) => message(error.message)));
    $("patches-refresh").addEventListener("click", () => loadPatches().catch((error) => message(error.message)));
    $("add-tree").addEventListener("submit", addTree);
    $("doctor-run").addEventListener("click", runDoctor);
    $("copy-preview").addEventListener("click", () => preview({ action: "vendor", force: $("copy-force").checked, from: $("copy-from").value }));
    $("config-preview").addEventListener("click", () => preview({ action: "init", mode: $("config-mode").value }));
    $("preview-run").addEventListener("click", runPreview);
    $("preview-close").addEventListener("click", () => $("preview").close());
    $("frame-close").addEventListener("click", () => $("frame-view").close());
    $("frame-seek").addEventListener("click", () => {
      if (state.frameSeek) state.frameSeek();
      $("frame-view").close();
    });
  }

  async function start() {
    wire();
    runs = window.E2ERuns.create(shell);
    if (!token) {
      message("no token: open the URL e2e gui prints");
      return;
    }
    try {
      await loadContext();
      await loadTrees();
    } catch (error) {
      message(error.message);
      return;
    }
    showTab(state.tab);
    loadSummary().catch(() => {});
    countPatches();
    setInterval(() => {
      if (!document.hidden && !$("preview").open) loadTrees().catch(() => {});
    }, 30_000);
  }

  start();
})();
