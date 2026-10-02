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
    treeFilter: "",
    // "<tree id>:<row key>" -> open, for checklist rows someone opened or closed by hand.
    openRows: new Map(),
    // The last health check: { treeID, running, command, text, plugins }.
    doctor: null,
    runTab: "terminal",
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
    // Most-tested trees first.
    const total = (tree) => (tree.runs ? tree.runs.total : 0);
    state.trees = (body.trees || []).slice().sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
    if (!state.trees.some((tree) => tree.id === state.treeID)) {
      state.treeID = (state.trees.find((tree) => tree.copy) || state.trees[0] || {}).id || null;
    }
    renderPicker();
    renderTreeBadges();
    renderTreeCards();
    renderContext();
  }

  // ---------- the tree picker ----------
  //
  // A listbox, not a <select>, so each row can carry coloured pills in columns:
  // the tree, its EveJS version (server/package.json), whether e2e is
  // installed, and its scenario runs.

  const pill = (cls, text, title) => h("span", { className: `pill ${cls}`, text, title });

  // The commonest EveJS version gets the first colour, the next the second...
  function versionClasses() {
    const counts = new Map();
    for (const tree of state.trees) if (tree.evejs) counts.set(tree.evejs, (counts.get(tree.evejs) || 0) + 1);
    const order = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([version]) => version);
    return (version) => (version ? `mono v${Math.min(order.indexOf(version), 4)}` : "mute");
  }

  function evejsPill(tree, vclass) {
    return pill(vclass(tree.evejs), tree.evejs ? `EveJS ${tree.evejs}` : "EveJS ?",
      tree.evejs ? "From the tree's server/package.json" : "No version in the tree's package.json");
  }

  function e2ePill(tree) {
    if (tree.copy) return pill("ok", "installed", `e2e ${tree.copy.version || "?"} at ${short(tree.copy.commit)}`);
    return tree.isTree ? pill("warn", "not installed") : pill("mute", "not a tree");
  }

  function runsCell(tree) {
    const runs = tree.runs || { total: 0, passed: 0, failed: 0 };
    if (!runs.total) return h("span", { className: "runs-cell" }, pill("mute", "no runs"));
    const bar = h("span", { className: "passbar", title: `${Math.round((runs.passed / runs.total) * 100)}% passed` }, h("i"));
    bar.firstChild.style.width = `${(runs.passed / runs.total) * 100}%`;
    return h("span", { className: "runs-cell" },
      h("b", { className: "num", text: String(runs.total), title: `${runs.total} scenario run${runs.total === 1 ? "" : "s"}` }),
      bar,
      pill(`ok${runs.passed ? "" : " zero"}`, `${runs.passed} pass`),
      pill(`bad${runs.failed ? "" : " zero"}`, `${runs.failed} fail`));
  }

  function renderPicker() {
    const button = $("tree");
    const list = $("tree-list");
    const vclass = versionClasses();
    const tree = currentTree();
    button.textContent = "";
    if (tree) {
      button.append(h("b", { className: "nm", text: tree.name }), evejsPill(tree, vclass), runsCell(tree));
    } else {
      button.append(h("span", { className: "muted", text: "no tree" }));
    }
    button.append(h("span", { className: "caret", text: "▾" }));
    button.title = tree ? tree.root : "";
    button.disabled = !state.trees.length;

    list.textContent = "";
    list.append(h("div", { className: "tpick-head", "aria-hidden": "true" },
      h("span", { text: "Tree" }), h("span", { text: "EveJS" }), h("span", { text: "e2e" }), h("span", { text: "Scenario runs" })));
    for (const row of state.trees) {
      list.append(h("div", {
        className: "topt", role: "option", tabindex: "-1", id: `topt-${row.id}`, "data-id": row.id,
        "aria-selected": String(row.id === state.treeID), title: row.root,
        onclick: () => pickTree(row.id),
      },
      h("span", { className: "nm" }, h("b", { text: row.name }), row.up ? pill("warn", "up", "The tree's server is up") : null,
        h("span", { className: "path", text: row.root })),
      h("span", {}, evejsPill(row, vclass)),
      h("span", {}, e2ePill(row)),
      runsCell(row)));
    }
  }

  const options = () => [...$("tree-list").querySelectorAll(".topt")];

  function openPicker() {
    if (!state.trees.length) return;
    $("tree-list").hidden = false;
    $("tree").setAttribute("aria-expanded", "true");
    const all = options();
    (all.find((node) => node.dataset.id === state.treeID) || all[0]).focus();
  }

  function closePicker(focusButton = true) {
    if ($("tree-list").hidden) return;
    $("tree-list").hidden = true;
    $("tree").setAttribute("aria-expanded", "false");
    if (focusButton) $("tree").focus();
  }

  function pickTree(id) {
    closePicker();
    selectTree(id);
  }

  function pickerKeys(event) {
    const all = options();
    const at = all.indexOf(document.activeElement);
    const go = (index) => {
      event.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, index))].focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(all.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
    } else if ((event.key === "Enter" || event.key === " ") && at >= 0) {
      event.preventDefault();
      pickTree(all[at].dataset.id);
    } else if (event.key === "Tab") closePicker(false);
  }

  function wirePicker() {
    $("tree").addEventListener("click", () => ($("tree-list").hidden ? openPicker() : closePicker()));
    $("tree").addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openPicker();
      }
    });
    $("tree-list").addEventListener("keydown", pickerKeys);
    document.addEventListener("mousedown", (event) => {
      if (!$("tpick").contains(event.target)) closePicker(false);
    });
  }

  function currentTree() {
    return state.trees.find((tree) => tree.id === state.treeID) || null;
  }

  function renderTreeBadges() {
    const box = $("tree-badges");
    box.textContent = "";
    const tree = currentTree();
    if (!tree) return;
    box.append(h("button", { type: "button", className: `badge ${tree.copy ? "ok" : "warn"}`, title: "Open the Install tab for this tree",
      onclick: () => showTab("install") },
      tree.copy ? h("i", { className: "dot" }) : null,
      tree.copy ? "e2e installed" : tree.isTree ? "not installed" : "not a tree"));
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
    if (tree.evejs) cx("EveJS", tree.evejs);
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
    renderPicker();
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

  const MODES = {
    auto: { name: "Auto", text: "Uses the tree's server when it's up, and starts its own when it isn't." },
    managed: { name: "Managed", text: "e2e starts and stops the server for each test run." },
    attach: { name: "Attach", text: "e2e only uses a server you start, with EVEJS_AGENT_BRIDGE=1 set." },
  };
  const SOURCES = { nearby: "Found beside this checkout", given: "Given with --tree", added: "Added on this page" };
  const MARKS = { ok: "\u2713", need: "!", optional: "!", bad: "\u2717", info: "i", wait: "\u2013" };
  const CLI = "node tools/evejs-e2e/bin/e2e.js";

  // "a", "a and b", "a, b and c"
  const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  const upper = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  function treeItem(tree) {
    const dot = !tree.isTree ? "bad" : !tree.copy ? "off" : tree.up ? "warn" : "ok";
    const facts = [tree.copy ? `e2e ${tree.copy.version || "?"}` : null, tree.mode].filter(Boolean).join(" \u00b7 ");
    const forget = tree.source === "added" ? h("button", { type: "button", className: "btn sm ghost forget", text: "Forget",
      title: "Take it off this list", onclick: (event) => { event.stopPropagation(); forgetTree(tree.id); } }) : null;
    return h("li", { className: `${tree.id === state.treeID ? "sel" : ""}${tree.copy ? "" : " off"}`,
      title: SOURCES[tree.source] || tree.source, onclick: () => { state.tab = "install"; selectTree(tree.id); } },
      h("div", { className: "top" },
        h("i", { className: `tdot ${dot}`, title: !tree.isTree ? "not an EveJS tree" : !tree.copy ? "e2e isn't installed" : tree.up ? "server up" : "e2e installed" }),
        h("b", { text: tree.name }),
        tree.evejs ? h("span", { className: "ver", text: `EveJS ${tree.evejs}`, title: "From the tree's server/package.json" }) : null),
      h("div", { className: "path", text: tree.root }),
      facts || tree.up || forget ? h("div", { className: "facts" }, facts, tree.up ? badge("warn", "server up") : null, forget) : null);
  }

  function renderTreeCards() {
    const box = $("trees");
    box.textContent = "";
    $("trees-count").textContent = state.trees.length ? String(state.trees.length) : "";
    $("trees-filter").parentElement.hidden = state.trees.length < 6;
    if (!state.trees.length) {
      box.append(h("p", { className: "none", text: state.context && state.context.mode === "checkout"
        ? "No trees yet. Add one by its path below: an unpacked EveJS zip, or a fork's checkout." : "No tree." }));
      return;
    }
    const needle = state.treeFilter.trim().toLowerCase();
    const shown = state.trees.filter((tree) => !needle || `${tree.name}\n${tree.root}`.toLowerCase().includes(needle));
    for (const [label, trees] of [["Set up", shown.filter((tree) => tree.copy)], ["Not set up", shown.filter((tree) => !tree.copy)]]) {
      if (!trees.length) continue;
      box.append(h("div", { className: "group-label" }, label, h("span", { className: "count", text: `\u00b7 ${trees.length}` })),
        h("ul", { className: "cards" }, trees.map(treeItem)));
    }
    if (!shown.length) box.append(h("p", { className: "none", text: `No tree matches "${state.treeFilter.trim()}".` }));
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

  const kv = (pairs) => h("dl", { className: "kv" }, pairs.filter(Boolean).flatMap(([key, value]) => [h("dt", { text: key }), h("dd", {}, value)]));

  // The checklist, one row per thing the tree needs. Each row:
  //   { key, state: ok|need|optional|bad|info|wait, blocks, title, pill: [class, text], desc,
  //     action: { text, primary, disabled, title, open, run }, open, detail: () => nodes }
  // A row that blocks keeps the tree from running tests.
  function setupRows(tree) {
    return [copyRow(tree), modeRow(tree), agentsRow(tree), prereqRow(tree), pluginsRow(tree), serverRow(tree)];
  }

  function copyRow(tree) {
    const copy = tree.copy || {};
    const vendoredGui = state.context.mode === "vendored";
    const from = vendoredGui ? h("input", { type: "text", placeholder: "F:/evejs-e2e", autocomplete: "off", spellcheck: "false" }) : null;
    const vendorRun = (force) => () => preview({ action: "vendor", force, from: from ? from.value : "" });
    const detail = () => [
      kv([
        copy.vendored ? ["Installed", `${copy.version || "?"} at ${short(copy.commit)}`] : null,
        !vendoredGui ? ["This checkout", `${state.context.version || "?"} at ${short(state.context.commit)}${state.context.dirty ? " (uncommitted changes aren't installed)" : ""}`] : null,
        copy.vendored ? ["Files", copy.ok ? "match VENDOR.json" : `${copy.problemCount} differ from VENDOR.json`] : null,
        ["Bridge shim", h("span", {}, h("code", { text: "server/src/_secondary/agentBridge/server.js" }),
          ` ${{ missing: "missing", edited: "edited since it was installed", matches: "matches", present: "present" }[tree.shim] || tree.shim}`)],
      ]),
      copy.problems && copy.problems.length ? h("ul", { className: "problems" }, copy.problems.map((row) => h("li", {}, h("code", { text: row.file }), ` ${row.problem}`))) : null,
      from ? h("div", { className: "row" }, h("span", { className: "lbl", text: "Update from the evejs-e2e checkout" }), from,
        h("button", { type: "button", className: "btn sm primary", text: "Update\u2026", onclick: vendorRun(!copy.ok) })) : null,
    ];
    if (!copy.present) {
      return { key: "copy", state: "need", blocks: true, title: "e2e is not installed",
        desc: "Install copies this checkout's committed files into tools/evejs-e2e/ and adds a small shim to the server.",
        action: { text: "Install\u2026", primary: true, run: vendorRun(false) }, detail };
    }
    if (!copy.vendored) {
      return { key: "copy", state: "bad", blocks: true, title: "tools/evejs-e2e wasn't installed by e2e", open: true,
        desc: "It has no VENDOR.json, so e2e can't tell what's in it. Installing replaces it.",
        action: { text: "Replace\u2026", primary: true, run: vendorRun(true) }, detail };
    }
    if (!copy.ok) {
      return { key: "copy", state: "bad", title: "e2e is installed, but its files were edited", open: true,
        desc: `${copy.problemCount} ${copy.problemCount === 1 ? "file differs" : "files differ"} from what was installed.`,
        action: vendoredGui ? { text: "Update\u2026", open: true } : { text: "Replace edited files\u2026", run: vendorRun(true) }, detail };
    }
    const update = !vendoredGui && !copy.upToDate;
    return { key: "copy", state: "ok", title: "e2e is installed", pill: update ? ["accent", "Update available"] : null,
      desc: update ? `Version ${copy.version} (${short(copy.commit)}). This checkout is at ${short(state.context.commit)}.`
        : `Version ${copy.version} (${short(copy.commit)}), unchanged since it was installed.`,
      action: update ? { text: "Update\u2026", run: vendorRun(false) } : vendoredGui ? { text: "Update\u2026", open: true } : null, detail };
  }

  function modePicker(tree, verb) {
    const config = tree.config || {};
    let chosen = config.exists && MODES[config.mode] ? config.mode : "auto";
    const write = h("button", { type: "button", className: "btn sm primary", text: verb, onclick: () => preview({ action: "init", mode: chosen }) });
    const buttons = Object.entries(MODES).map(([id, mode]) => h("button", { type: "button", "aria-pressed": String(id === chosen),
      onclick: () => { chosen = id; sync(); } }, h("b", { text: config.exists && id === config.mode ? `${mode.name} (current)` : mode.name }), mode.text));
    const sync = () => {
      Object.keys(MODES).forEach((id, index) => buttons[index].setAttribute("aria-pressed", String(id === chosen)));
      write.disabled = config.exists && !(config.problems || []).length && chosen === config.mode;
      write.title = write.disabled ? "Already this mode" : `Writes ${config.file || "e2e.config.json"}`;
    };
    sync();
    return [h("div", { className: "modes" }, buttons), h("div", { className: "row" }, write)];
  }

  function modeRow(tree) {
    const config = tree.config || {};
    if (!tree.copy || !tree.copy.present) return { key: "mode", state: "wait", title: "Server mode", desc: "Install e2e first." };
    if (!config.exists) {
      return { key: "mode", state: "need", blocks: true, title: "Choose a server mode", open: true,
        desc: "e2e needs to know whether to start the tree's server itself.", detail: () => modePicker(tree, "Write config\u2026") };
    }
    if ((config.problems || []).length) {
      return { key: "mode", state: "bad", blocks: true, title: `${config.file} has problems`, open: true, desc: config.problems[0],
        detail: () => [h("ul", { className: "problems" }, config.problems.map((problem) => h("li", { text: problem }))), ...modePicker(tree, "Rewrite config\u2026")] };
    }
    const mode = MODES[config.mode] || { name: config.mode, text: "" };
    return { key: "mode", state: "ok", title: `Server mode: ${mode.name}`, desc: mode.text,
      action: { text: "Change", open: true },
      detail: () => [h("p", {}, `Saved in ${config.file}. Runs go to `, h("code", { text: config.runsDir }), "."), ...modePicker(tree, "Rewrite config\u2026")] };
  }

  function agentsRow(tree) {
    if (!tree.copy || !tree.copy.present) return { key: "agents", state: "wait", title: "AI agents", desc: "Install e2e first." };
    const rows = tree.agents || [];
    const names = (list) => listed(list.map((row) => row.name));
    const connected = rows.filter((row) => row.registered);
    const waiting = rows.filter((row) => row.installed && !row.registered && !row.problem);
    const broken = rows.filter((row) => row.problem);
    const detail = () => [
      h("p", { text: "Claude Code reads this tree's .mcp.json. Codex reads one config.toml for every folder, so its entry names this " +
        "tree's copy by path. Connecting only adds an entry; your other servers are left alone." }),
      ...rows.map((row) => {
        const cls = row.problem ? "bad" : row.registered ? "ok" : row.installed ? "optional" : "wait";
        const what = row.problem ? row.problem : row.registered ? `Runs this tree's server as ${row.serverName}, from ${row.file}`
          : `${row.installed ? "Found on this machine. " : "Not found on this machine. "}Adds ${row.serverName} to ${row.file}`;
        const end = row.problem ? h("span", { className: "no", text: "Problem" })
          : row.registered ? h("span", { className: "yes", text: "Connected" })
            : h("button", { type: "button", className: `btn sm${row.installed ? " primary" : ""}`, text: row.installed ? `Connect ${row.name}\u2026` : "Set up anyway\u2026",
              onclick: () => preview({ action: "agents", agents: [row.id] }) });
        return h("div", { className: `agent-card ${cls}`, title: row.evidence && row.evidence.length ? `found: ${row.evidence.join(", ")}` : "" },
          h("span", { className: "mark", text: MARKS[cls] }),
          h("div", {}, h("b", { text: row.name }), h("div", { className: "s", text: what })),
          end);
      }),
    ];
    if (broken.length) {
      return { key: "agents", state: "bad", title: "AI agents", pill: ["bad", "Problem"], open: true,
        desc: `${names(broken)}: ${broken[0].problem}`, detail };
    }
    if (waiting.length) {
      return { key: "agents", state: "optional", title: "AI agents", pill: ["accent", "Optional"], open: true,
        desc: `${connected.length ? `${names(connected)} ${connected.length === 1 ? "is" : "are"} connected. ` : ""}` +
          `${names(waiting)} ${waiting.length === 1 ? "is" : "are"} installed but not connected.`, detail };
    }
    if (connected.length) {
      return { key: "agents", state: "ok", title: "AI agents connected", desc: `${names(connected)} can run tests on this tree.`, detail };
    }
    return { key: "agents", state: "info", title: "No AI agents found", pill: ["info", "Optional"],
      desc: "Claude Code and Codex aren't on this machine. You can still set one up, or run tests from the terminal.", detail };
  }

  function prereqRow(tree) {
    const rows = tree.prerequisites || [];
    const missing = rows.filter((row) => !row.ok);
    const detail = () => [h("ul", { className: "checks" }, rows.map((row) => checkItem(row.ok, row.name, row.ok ? null : `fix: ${row.fix}`))),
      h("p", { text: "These are the tree's own setup, so this page doesn't run them." })];
    if (missing.length) {
      return { key: "prereqs", state: "need", blocks: true, title: "Dependencies and reference data", pill: ["warn", "Missing"], open: true,
        desc: `Missing: ${listed(missing.map((row) => row.name))}.`, detail };
    }
    return { key: "prereqs", state: "ok", title: "Dependencies and reference data",
      desc: `${upper(listed(rows.map((row) => row.name)))} ${rows.length === 1 ? "is" : "are"} present.`, detail };
  }

  function pluginsRow(tree) {
    const doctor = state.doctor && state.doctor.treeID === tree.id ? state.doctor : null;
    const plugins = doctor && doctor.plugins ? doctor.plugins : tree.plugins || { active: [], skipped: [] };
    const installed = Boolean(tree.copy && tree.copy.present);
    const action = { text: doctor && doctor.running ? "Checking\u2026" : "Run health check", open: true, run: runDoctor,
      disabled: !installed || Boolean(doctor && doctor.running), title: installed ? "Runs e2e doctor in the tree" : "Install e2e first" };
    const detail = () => [
      h("ul", { className: "checks" },
        plugins.active.map((name) => checkItem(true, name, doctor && doctor.plugins ? "active (the tree's copy says)" : "active")),
        plugins.skipped.map((row) => checkItem(null, row.name, `skipped: ${row.reason}`)),
        !plugins.active.length && !plugins.skipped.length ? checkItem(null, "No plugins apply to this tree.") : null),
      doctor ? h("div", { className: "mono", text: doctor.command }) : null,
      doctor ? h("pre", { text: doctor.text })
        : h("p", { text: "The health check (e2e doctor) asks the tree's own copy what works: the gateway calls it makes, the client view, patches and listeners." }),
    ];
    if (plugins.active.length) {
      return { key: "plugins", state: "ok", title: "Plugins", desc: `${listed(plugins.active)} ${plugins.active.length === 1 ? "is" : "are"} active.`, action, detail };
    }
    return { key: "plugins", state: "info", title: "No plugins active",
      desc: plugins.skipped.length ? `${plugins.skipped.length} skipped; open for why.` : "Stock EveJS needs none.", action, detail };
  }

  function serverRow(tree) {
    const mode = tree.config && tree.config.exists ? tree.config.mode : null;
    if (tree.serverUp) {
      return { key: "server", state: "info", title: "The game server is running",
        desc: `${upper(tree.serverUp)}. Changes other than connecting agents wait until it stops.` };
    }
    if (mode === "attach") {
      return { key: "server", state: "info", title: "The game server is not running", pill: ["info", "Start it yourself"],
        desc: "Attach mode only uses a server you start. Start it with EVEJS_AGENT_BRIDGE=1 set." };
    }
    return { key: "server", state: "info", title: "The game server is not running", pill: mode ? ["info", "No action needed"] : null,
      desc: mode === "managed" ? "Managed mode starts it for each test run." : mode === "auto" ? "Auto mode starts its own when none is up." : "The tree's server is down." };
  }

  function checkRow(tree, row) {
    const key = `${tree.id}:${row.key}`;
    const body = row.detail ? h("details", { className: `crow ${row.state}` }) : h("div", { className: `crow ${row.state}` });
    const button = row.action ? h("button", { type: "button", className: `btn sm${row.action.primary ? " primary" : ""}`, text: row.action.text,
      disabled: row.action.disabled, title: row.action.title, onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (row.action.open && row.detail) body.open = true;
        if (row.action.run) row.action.run();
      } }) : h("span");
    const head = h(row.detail ? "summary" : "div", { className: row.detail ? null : "sum" },
      h("span", { className: "mark", text: MARKS[row.state] }),
      h("div", {}, h("div", { className: "t" }, row.title, row.pill ? h("span", { className: `pill ${row.pill[0]}`, text: row.pill[1] }) : null),
        h("div", { className: "d", text: row.desc })),
      button,
      h("span", { className: "chev", text: row.detail ? "\u203a" : "" }));
    body.append(head);
    if (row.detail) {
      body.open = state.openRows.has(key) ? state.openRows.get(key) : Boolean(row.open);
      body.addEventListener("toggle", () => state.openRows.set(key, body.open));
      body.append(h("div", { className: "cbody" }, row.detail()));
    }
    return body;
  }

  function renderHero(tree, rows) {
    const hero = $("setup-hero");
    hero.textContent = "";
    const blocking = rows.filter((row) => row.blocks);
    const optional = rows.filter((row) => row.state === "optional" || (row.pill && row.pill[1] === "Update available"));
    let cls;
    let mark;
    let title;
    let text;
    let button = null;
    if (tree.problem) {
      [cls, mark, title, text] = ["bad", "\u2717", "This folder can't be tested", tree.problem];
    } else if (!tree.copy || !tree.copy.present) {
      [cls, mark, title, text] = ["new", "+", "Not set up yet", "Install e2e to test this tree. The checklist below shows what else it needs."];
      button = h("button", { type: "button", className: "btn primary", text: "Install e2e\u2026", onclick: () => preview({ action: "vendor", force: false, from: "" }) });
    } else if (blocking.length) {
      [cls, mark, title, text] = ["warn", "!", `${blocking.length} ${blocking.length === 1 ? "thing" : "things"} to do before you can run tests`,
        `${listed(blocking.map((row) => row.title))}.`];
    } else {
      [cls, mark, title] = ["ok", "\u2713", "Ready to run tests"];
      text = optional.length ? `Everything required is in place. ${optional.length} optional ${optional.length === 1 ? "item" : "items"} below.`
        : "Everything is in place.";
      button = h("button", { type: "button", className: "btn primary", text: "Run a test \u2193",
        onclick: () => $("setup-run").scrollIntoView({ behavior: "smooth", block: "start" }) });
    }
    hero.className = `hero ${cls}`;
    hero.append(h("div", { className: "big", text: mark }), h("div", {}, h("h2", { text: title }), h("p", { text })), button);
  }

  function copyButton(text) {
    const button = h("button", { type: "button", className: "btn sm", text: "Copy" });
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy"; }, 1500);
      }).catch(() => message("couldn't copy; select the command instead"));
    });
    return button;
  }

  function renderRunCard(tree, rows) {
    const card = $("setup-run");
    card.textContent = "";
    card.hidden = Boolean(tree.problem);
    const blocked = !tree.copy || !tree.copy.present || rows.some((row) => row.blocks);
    card.classList.toggle("off", blocked);
    card.append(h("div", { className: "panel-head" }, h("h3", { text: "Run a test" })));
    if (blocked) {
      card.append(h("div", { className: "pbody" }, h("p", { text: "Finish the items marked above first. The commands to run a test show here then." })));
      return;
    }
    const tabs = h("div", { className: "rtabs", role: "tablist" },
      [["terminal", "Terminal"], ["agent", "Ask your agent"]].map(([id, label]) => h("button", { type: "button", role: "tab",
        "aria-selected": String(state.runTab === id), text: label, onclick: () => { state.runTab = id; renderRunCard(tree, rows); } })));
    const pane = h("div", { className: "pbody" });
    if (state.runTab === "agent") {
      const connected = (tree.agents || []).filter((row) => row.registered);
      pane.append(h("p", { text: connected.length
        ? `Ask ${listed(connected.map((row) => row.name))} to test a feature. It has the e2e tools, and starts with e2e_status.`
        : "No agent is connected to this tree yet. Connect one in the checklist above, or use the terminal." }));
    } else {
      const steps = tree.config.mode === "attach"
        ? [["Log in to the server you started", `${CLI} login`], ["Run a scenario", `${CLI} run smoke-undock`]]
        : [["Build a test world", `${CLI} world build starter`], ["Run a scenario", `${CLI} run loadout-npc-fight`]];
      steps.forEach(([why, command], index) => pane.append(h("div", { className: "cmd" },
        h("span", { className: "n", text: String(index + 1) }), h("code", { text: command }), h("span", { className: "why", text: why }), copyButton(command))));
      pane.append(h("p", { className: "muted" }, "Run these from ", h("code", { text: tree.root }), ". For every command, run ",
        h("code", { text: `${CLI} help` }), "."));
    }
    pane.append(h("p", { className: "muted", text: "Turn on the patches you want in the Patches tab first. Every run shows up on the Runs tab." }));
    card.append(tabs, pane);
  }

  function renderInstall(tree) {
    $("install-empty").hidden = Boolean(tree);
    $("install-detail").hidden = !tree;
    if (!tree) return;
    $("install-title").textContent = tree.name;
    $("install-root").textContent = [tree.root, tree.evejs ? `EveJS ${tree.evejs}` : null,
      tree.git === false ? "not a git checkout, so uncommitted changes can't be checked" : null].filter(Boolean).join("  \u00b7  ");
    const rows = tree.problem ? [] : setupRows(tree);
    renderHero(tree, rows);
    const list = $("setup-rows");
    list.textContent = "";
    for (const row of rows) list.append(checkRow(tree, row));
    list.parentElement.hidden = !rows.length;
    const counted = rows.filter((row) => row.state !== "info");
    $("setup-progress").textContent = counted.length ? `${counted.filter((row) => row.state === "ok").length} of ${counted.length} done` : "";
    renderRunCard(tree, rows);
  }

  async function runDoctor() {
    const id = state.treeID;
    const rerender = () => {
      if (state.tree && state.tree.id === id && state.tab === "install") renderInstall(state.tree);
    };
    state.doctor = { treeID: id, running: true, command: "", text: "running e2e doctor...", plugins: null };
    rerender();
    try {
      const doctor = (await api(`/gui/api/doctor?tree=${q(id)}`)).doctor;
      state.doctor = { treeID: id, running: false, command: `${doctor.command}  (in ${doctor.cwd})`,
        text: doctor.json ? formatDoctor(doctor.json) : doctor.output, plugins: (doctor.json && doctor.json.plugins) || null };
    } catch (error) {
      state.doctor = { treeID: id, running: false, command: "", text: error.message, plugins: null };
    }
    rerender();
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

  const ACTION_TITLES = { vendor: "Install or update the copy", init: "Write e2e.config.json", agents: "Set up agents",
    "patch-apply": "Apply a patch", "patch-revert": "Revert a patch" };

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
    wirePicker();
    $("install-refresh").addEventListener("click", () => loadInstall().catch((error) => message(error.message)));
    $("patches-refresh").addEventListener("click", () => loadPatches().catch((error) => message(error.message)));
    $("add-tree").addEventListener("submit", addTree);
    $("trees-filter").addEventListener("input", () => {
      state.treeFilter = $("trees-filter").value;
      renderTreeCards();
    });
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
      if (!document.hidden && !$("preview").open && $("tree-list").hidden) loadTrees().catch(() => {});
    }, 30_000);
  }

  start();
})();
