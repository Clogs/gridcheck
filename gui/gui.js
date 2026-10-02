"use strict";

// The page `gridcheck gui` serves (core/gui.js): the header, the tabs, Install,
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
    // Run a test: tree id -> { scenarios, recipes, runs, patches, error }, the picked
    // scenario per tree, and the run options.
    runData: new Map(),
    runPick: new Map(),
    runOpts: { check: false, keepUp: false, reuse: false },
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
    for (const child of children.flat(Infinity)) {
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

  // An icon from the sprite in index.html.
  function icon(name, cls = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `i${cls ? ` ${cls}` : ""}`);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  // A reference: a path, command, commit, version, variable or tool, each with
  // its own colour and icon. A path's folder part is dimmer than its last part.
  // Only commands and full paths copy when clicked (wire()); a relative path or
  // a version on its own isn't worth pasting anywhere.
  const REF_ICONS = { cmd: "prompt", commit: "commit", ver: "tag", env: "dollar" };
  const fullPath = (value) => /^([A-Za-z]:[\\/]|\/|\\\\)/.test(value);
  function ref(kind, text, { dir = false, copy = null, title = null } = {}) {
    const value = String(text ?? "");
    if (copy === null) copy = kind === "cmd" || (kind === "path" && fullPath(value));
    let name = REF_ICONS[kind] || null;
    let body = [value];
    if (kind === "path") {
      name = dir || value.endsWith("/") ? "folder" : "file";
      const cut = value.replace(/\/$/, "").lastIndexOf("/");
      // One span, so the chip's gap doesn't split the folder from the name.
      if (cut > 0) body = [h("span", {}, h("span", { className: "dir", text: value.slice(0, cut + 1) }), value.slice(cut + 1))];
    }
    return h("span", { className: `ref ${kind}`, title: title || (copy ? `${value} (click to copy)` : value), "data-copy": copy ? value : null },
      name ? icon(name) : null, ...body);
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text).then(() => message(`copied ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`, true),
      () => message("couldn't copy; select the text instead"));
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
  // The Commands tab, gui/commands.js.
  let commands = null;
  const shell = {
    api, blobURL, freeBlobs, h, message, token, params, saveHash, setCount, renderMarkdown, showFrame, icon, ref, copyText,
    treeID: () => state.treeID,
    summary: () => (state.treeID ? state.summaries.get(state.treeID) || null : null),
    refreshContext: () => renderContext(),
  };

  // ---------- trees, header and tabs ----------

  async function loadContext() {
    const body = await api("/gui/api/context");
    state.context = body.context;
    const c = state.context;
    const node = $("context");
    // An unpacked zip has no commit; show just the version then.
    node.textContent = [c.version, c.commit ? short(c.commit) : null].filter(Boolean).join(" · ");
    const at = c.commit ? ` at ${c.commit}` : "";
    node.title = c.mode === "vendored"
      ? `vendored copy ${c.version || "?"}${at}, managing ${c.tree}`
      : c.checkout ? `checkout ${c.root}, ${c.version || "?"}${at}${c.dirty ? " (uncommitted changes aren't vendored)" : ""}`
        : `${c.root}, ${c.version || "?"} (not a git checkout)`;
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
  // the tree, its EveJS version (server/package.json), whether gridcheck is
  // installed, and its scenario runs.

  const pill = (cls, text, title) => h("span", { className: `tpill ${cls}`, text, title });

  // The commonest EveJS version gets the first colour, the next the second...
  function versionClasses() {
    const counts = new Map();
    for (const tree of state.trees) if (tree.evejs) counts.set(tree.evejs, (counts.get(tree.evejs) || 0) + 1);
    const order = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([version]) => version);
    return (version) => (version ? `mono v${Math.min(order.indexOf(version), 4)}` : "mute");
  }

  function evejsPill(tree, vclass) {
    return pill(vclass(tree.evejs), tree.evejs ? `EveJS ${tree.evejs}` : "EveJS ?",
      tree.evejs ? "From the Eve.js instance's server/package.json" : "No version in the Eve.js instance's package.json");
  }

  function e2ePill(tree) {
    if (tree.copy) return pill("ok", "installed", `gridcheck ${tree.copy.version || "?"}${tree.copy.commit ? ` at ${short(tree.copy.commit)}` : ""}`);
    return tree.isTree ? pill("warn", "not installed") : pill("mute", "not an Eve.js instance");
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
      button.append(h("span", { className: "muted", text: "no Eve.js instance" }));
    }
    button.append(h("span", { className: "caret", text: "▾" }));
    button.title = tree ? tree.root : "";
    button.disabled = !state.trees.length;

    list.textContent = "";
    list.append(h("div", { className: "tpick-head", "aria-hidden": "true" },
      h("span", { text: "Eve.js instance" }), h("span", { text: "EveJS" }), h("span", { text: "Gridcheck" }), h("span", { text: "Scenario runs" })));
    for (const row of state.trees) {
      list.append(h("div", {
        className: "topt", role: "option", tabindex: "-1", id: `topt-${row.id}`, "data-id": row.id,
        "aria-selected": String(row.id === state.treeID), title: row.root,
        onclick: () => pickTree(row.id),
      },
      h("span", { className: "nm" }, h("b", { text: row.name }), row.up ? pill("warn", "up", "The Eve.js instance's server is up") : null,
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
    box.append(h("button", { type: "button", className: `badge ${tree.copy ? "ok" : "warn"}`, title: "Open the Install tab for this Eve.js instance",
      onclick: () => showTab("install") },
      tree.copy ? h("i", { className: "dot" }) : null,
      tree.copy ? "gridcheck installed" : tree.isTree ? "not installed" : "not an Eve.js instance"));
    if (tree.mode) box.append(badge("mute", tree.mode));
    if (tree.up) box.append(badge("warn", "server up", true));
  }

  async function loadSummary(id = state.treeID, { fresh = false } = {}) {
    if (!id) return null;
    if (!fresh && state.summaries.has(id)) return state.summaries.get(id);
    const body = await api(`/gui/api/tree?tree=${q(id)}`);
    state.summaries.set(id, body.tree);
    if (id === state.treeID) {
      renderContext();
      updateInstallCount(body.tree);
    }
    return body.tree;
  }

  // The context bar: the server's block, then the tree's facts. A fact with
  // more to say opens a card on hover or focus.
  function renderContext() {
    const bar = $("ctxbar");
    bar.textContent = "";
    const tree = currentTree();
    if (!tree) {
      bar.append(h("span", { className: "cx muted", text: "No Eve.js instance yet: add one on the Install tab." }));
      return;
    }
    const summary = state.summaries.get(tree.id);
    const run = state.tab === "runs" && runs ? runs.context() : {};
    const mode = tree.mode || null;
    bar.append(serverBlock(tree, summary, mode));
    const facts = h("div", { className: "cx-facts" });
    const fact = (cls, iconName, key, value, tip = null) => facts.append(h("span", { className: `fact ${cls}${tip ? " has-tip" : ""}`,
      tabindex: tip ? "0" : null }, icon(iconName, "sm ic"), h("span", { className: "k", text: key }), value, tip ? h("div", { className: "tip" }, tip) : null));
    const v = (text, mono = false) => h("span", { className: `v${mono ? " mono" : ""}`, text });
    if (state.tab === "runs") fact("world", "globe", "World", v(run.world || "-"));
    fact("mode", "cycle", "Mode", v(mode ? (MODES[mode] || { name: mode }).name : "no config"),
      h("div", {}, h("p", { text: mode && MODES[mode] ? MODES[mode].text : "No gridcheck.config.json yet. Choose a mode on the Install tab." }),
        mode && MODES[mode] ? riskNote(MODES[mode].risk) : null, riskNote(PLAYER_RISK, "all")));
    if (tree.evejs) fact("evejs", "logo", "EveJS", v(tree.evejs, true));
    fact(...copyFact(tree, summary));
    if (summary && summary.plugins) {
      const { active, skipped } = summary.plugins;
      fact("plug", "puzzle", "Plugins", v(active.length ? active.join(", ") : "none"), skipped.length || active.length
        ? h("div", {}, h("h4", { text: active.length ? `${active.length} active` : "None active" }),
          skipped.map((row) => h("p", {}, h("b", { text: row.name }), ` skipped: ${row.reason}`))) : null);
    }
    if (state.tab === "runs" && run.client) fact("client", "eye", "Client view", v(run.client));
    const where = state.tab === "runs" && run.runsDir ? run.runsDir : tree.root;
    facts.append(h("span", { className: "fact where", title: `${where} (click to copy)`, "data-copy": where },
      icon("folder", "sm ic"), h("span", { className: "v", text: where }), icon("copy", "sm cp")));
    bar.append(facts);
  }

  // What the server is doing, and what a run does about it in this mode.
  function serverBlock(tree, summary, mode) {
    const pid = summary && summary.serverPid ? `pid ${summary.serverPid}` : null;
    let cls = "";
    let title = "Server is down";
    let text;
    if (tree.up) {
      cls = "up";
      title = "Server is up";
      text = [pid, mode === "managed" ? "a run needs it stopped first (gridcheck down)" : mode ? "runs use it as it is" : null].filter(Boolean).join(" · ") || "running";
    } else if (!tree.copy) {
      cls = "none";
      text = "Install gridcheck to run tests on this Eve.js instance.";
    } else if (mode === "attach") {
      text = "Attach mode: start it yourself, with npm start or StartServer.bat.";
    } else if (mode === "managed") {
      text = "Managed mode starts it for each run.";
    } else if (mode === "auto") {
      text = "Auto mode starts one when a run needs it.";
    } else {
      text = "Choose a server mode on the Install tab.";
    }
    return h("div", { className: `srv ${cls}` }, h("span", { className: "orb" }, icon("power")), h("div", {}, h("b", { text: title }), h("small", { text })));
  }

  // [class, icon, key, value, tip] for the copy's fact: installed, edited, or an update waiting.
  function copyFact(tree, summary) {
    const v = (text) => h("span", { className: "v mono", text });
    if (!tree.copy) {
      return ["copy bad", "pkg", "Copy", h("span", { className: "v", text: "not installed" }),
        h("div", {}, h("p", { text: "gridcheck isn't installed in this Eve.js instance." }), h("button", { type: "button", className: "btn sm", text: "Open Install",
          onclick: () => showTab("install") }))];
    }
    const copy = summary && summary.copy;
    const checkout = state.context && state.context.mode === "checkout";
    const edited = copy && !copy.ok;
    const update = copy && checkout && copy.vendored && !copy.upToDate;
    const cls = edited ? "copy bad" : update ? "copy warn" : "copy";
    const rows = [["Installed", [ref("ver", tree.copy.version || "?", { copy: false }), copy && copy.commit ? ref("commit", short(copy.commit), { copy: false }) : null]]];
    if (checkout) rows.push([state.context.checkout ? "This checkout" : "This folder", [ref("ver", state.context.version || "?", { copy: false }),
      state.context.commit ? ref("commit", short(state.context.commit), { copy: false }) : null]]);
    if (copy) rows.push(["Files", h("span", { className: edited ? "badc" : "okc", text: edited ? `${copy.problemCount} differ from VENDOR.json` : "match VENDOR.json" })]);
    const tip = h("div", {},
      h("h4", {}, icon(edited ? "alert" : update ? "up" : "check", "sm"), edited ? "Its files were edited" : update ? "An update is available" : "Up to date"),
      h("dl", {}, rows.flatMap(([key, value]) => [h("dt", { text: key }), h("dd", {}, value)])),
      update || edited ? h("button", { type: "button", className: "btn sm primary", text: edited ? "Open Install" : "Update…",
        onclick: () => (edited || !checkout ? showTab("install") : preview({ action: "vendor", force: false, from: "" })) }) : null);
    return [cls, "pkg", "Copy", [v(tree.copy.version || "?"), update || edited ? h("span", { className: "fdot" }) : null], tip];
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
    state.tab = ["runs", "install", "patches", "commands"].includes(tab) ? tab : "runs";
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
        $("runs-empty").textContent = "Add an Eve.js instance on the Install tab.";
      }
      return;
    }
    const load = { runs: () => runs.load(), install: loadInstall, patches: loadPatches, commands: () => commands.load() }[state.tab];
    load().catch((error) => message(error.message));
  }

  // ---------- Install ----------

  // Each mode, as the picker shows it: a one-line summary, when to pick it (and when to pick
  // another), what a run does in each case, and its good and bad sides. `text` and `risk` are the
  // short forms the Mode fact's tooltip and the saved mode row use. A step's kind colours it:
  // keep (uses a world as it is), boot (replaces the world), you (the user does it), refuse.
  // Backticks mark code in the prose.
  const MODES = {
    auto: { name: "Auto", icon: "auto", text: "Uses the Eve.js instance's server when it's up, and starts its own when it isn't.",
      risk: "Attaches to any server that's up, a live one included. The test character stays in that world, and GM commands hit everyone in its system. When it boots, it replaces the Eve.js instance's world.",
      summary: "Use a server that's up, or boot one",
      about: "Before each run, gridcheck checks for a running server and takes one of the two paths.",
      useWhen: ["You're not sure. Auto suits most setups.", "You sometimes start the server yourself, and sometimes don't."],
      otherwise: [["Every run must start from the same world", "managed"], ["gridcheck should never start a server", "attach"]],
      lanes: [{ when: "A server is already up", up: true, steps: [["Use it", "its world, as it is", "keep"], ["Run", "the scenario"], ["Leave it up", "it stays running"]] },
        { when: "No server is up", up: false, steps: [["Boot", "the scenario's world", "boot"], ["Run", "the scenario"], ["Stop", "the server"]] }],
      good: ["Works with or without a server running", "`up`, `down` and the world commands work"],
      watch: ["A run on a server that's up starts from that server's world, not the scenario's",
        "Attaches to this instance's server even with people on it. GM commands hit everyone in its system."] },
    managed: { name: "Managed", icon: "cycle", text: "gridcheck starts and stops the server for each test run.",
      risk: "Every boot replaces the Eve.js instance's world: all its accounts, characters and assets. It refuses when a server is already up, so it never works on a live one.",
      summary: "Start fresh every run",
      about: "gridcheck boots the scenario's world for each run and stops the server when the run ends.",
      useWhen: ["Results must be repeatable, as in CI or when comparing runs", "Nobody else starts a server for this Eve.js instance"],
      otherwise: [["You want to keep your own server running", "auto"], ["You're debugging a server you start yourself", "attach"]],
      lanes: [{ when: "Every run", up: false, steps: [["Boot", "the scenario's world", "boot"], ["Run", "the scenario"], ["Stop", "the server"]] },
        { when: "A server is already up", up: true, steps: [["Refuse", "stop it first", "refuse"]] }],
      good: ["Every run starts from the same world", "Refuses when a server is up, so it never touches a live one", "`up`, `down` and the world commands work"],
      watch: ["Replaces the Eve.js instance's world every run: its accounts, characters and assets", "Boots a server for every run, which takes longer"] },
    attach: { name: "Attach", icon: "plug", text: "gridcheck only uses a server you start.",
      risk: "Works on whatever server you start, as it is. The test character stays in that world, and GM commands hit everyone in its system.",
      summary: "Use a server you start",
      about: "gridcheck never starts or stops a server. Start this instance's server as usual, with `npm start` or StartServer.bat, and gridcheck connects to it.",
      useWhen: ["You're debugging the server, with your own logs, flags or breakpoints", "You want to test a world as it is right now"],
      otherwise: [["gridcheck should boot a server when none is up", "auto"], ["Every run must start from the same world", "managed"]],
      lanes: [{ when: "You start the server", up: true, steps: [["You start it", "npm start or StartServer.bat", "you"], ["Run", "the scenario"], ["Leave it up", "it's yours"]] },
        { when: "No server is up", up: false, steps: [["Can't run", "start a server first", "refuse"]] }],
      good: ["Never starts, stops or replaces anything", "Nothing to set: any server this instance starts can be attached to",
        "Never attaches to a server from an instance without gridcheck"],
      watch: ["Runs start from the server's world, not the scenario's", "Attaches to this instance's server even with people on it. GM commands hit everyone in its system.",
        "A server started before the config was written has no bridge: restart it", "`up`, `down` and the world commands refuse"] },
  };
  // True of every mode: login checks no password, and a boot replaces every account.
  const PLAYER_RISK = "Use an Eve.js instance nobody plays on. In every mode, login --user <name> logs in as that account with no password, and booting a world replaces every account and character.";
  const riskNote = (text, cls = "") => h("span", { className: `risk${cls ? ` ${cls}` : ""}` }, icon("bang"), h("span", { text }));
  const SOURCES = { nearby: "Found beside this checkout", given: "Given with --tree", added: "Added on this page" };
  // A row's state badge: done, needed, optional, a problem, information, waiting.
  const STATE_ICONS = { ok: "check", need: "bang", optional: "bang", bad: "x", info: "info", wait: "dash" };
  const CLI = "node tools/gridcheck/bin/gridcheck.js";

  // "a", "a and b", "a, b and c"
  const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  const upper = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  function treeItem(tree, vclass) {
    const dot = !tree.isTree ? "bad" : !tree.copy ? "off" : tree.up ? "warn" : "ok";
    const forget = tree.source === "added" ? h("button", { type: "button", className: "btn sm ghost forget", text: "Forget",
      title: "Take it off this list", onclick: (event) => { event.stopPropagation(); forgetTree(tree.id); } }) : null;
    // Two lines: name, mode and version; path and runs. The group and the dot
    // already say whether gridcheck is installed.
    return h("li", { className: `${tree.id === state.treeID ? "sel" : ""}${tree.copy ? "" : " off"}`,
      title: SOURCES[tree.source] || tree.source, onclick: () => { state.tab = "install"; selectTree(tree.id); } },
      h("div", { className: "top" },
        h("i", { className: `tdot ${dot}`, title: !tree.isTree ? "not an Eve.js instance" : !tree.copy ? "gridcheck isn't installed" : tree.up ? "server up" : "gridcheck installed" }),
        h("b", { text: tree.name }),
        tree.mode ? h("span", { className: "mode", text: tree.mode, title: "gridcheck.config.json mode" }) : null,
        tree.up ? pill("warn", "up", "The Eve.js instance's server is up") : null,
        evejsPill(tree, vclass)),
      h("div", { className: "sub" },
        h("span", { className: "path", text: tree.root, title: tree.root }),
        runsMini(tree),
        forget));
  }

  // "13 [bar] 10 · 3": total, pass bar, passed in green, failed in red.
  function runsMini(tree) {
    const runs = tree.runs || { total: 0, passed: 0, failed: 0 };
    if (!runs.total) return h("span", { className: "runs-mini norun", text: "no runs" });
    const bar = h("span", { className: "passbar" }, h("i"));
    bar.firstChild.style.width = `${(runs.passed / runs.total) * 100}%`;
    return h("span", { className: "runs-mini", title: `${runs.total} scenario runs: ${runs.passed} passed, ${runs.failed} failed` },
      h("b", { text: String(runs.total) }), bar,
      h("span", { className: "ok", text: String(runs.passed) }),
      h("span", { className: `bad${runs.failed ? "" : " zero"}`, text: String(runs.failed) }));
  }

  function renderTreeCards() {
    const vclass = versionClasses();
    const box = $("trees");
    box.textContent = "";
    $("trees-count").textContent = state.trees.length ? String(state.trees.length) : "";
    $("trees-filter").parentElement.hidden = state.trees.length < 6;
    $("add-tree").classList.toggle("call", !state.trees.length);
    if (!state.trees.length) {
      box.append(h("p", { className: "none", text: state.context && state.context.mode === "checkout"
        ? "No Eve.js instances yet. Gridcheck needs at least one Eve.js instance before it can do anything: add one below, by browsing to it or pasting its path."
        : "No Eve.js instance." }));
      return;
    }
    const needle = state.treeFilter.trim().toLowerCase();
    const shown = state.trees.filter((tree) => !needle || `${tree.name}\n${tree.root}`.toLowerCase().includes(needle));
    for (const [label, cls, trees] of [["Set up", "ok", shown.filter((tree) => tree.copy)], ["Not set up", "warn", shown.filter((tree) => !tree.copy)]]) {
      if (!trees.length) continue;
      box.append(h("div", { className: "group-label" }, label, pill(cls, String(trees.length))),
        h("ul", { className: "cards" }, trees.map((tree) => treeItem(tree, vclass))));
    }
    if (!shown.length) box.append(h("p", { className: "none", text: `No Eve.js instance matches "${state.treeFilter.trim()}".` }));
  }

  // -> true once the tree is added and chosen.
  async function addTreeAt(root) {
    try {
      const body = await api("/gui/api/trees", { method: "POST", body: { path: root } });
      $("add-path").value = "";
      await loadTrees();
      state.tab = "install";
      // loadTrees chooses a tree when none was, which may be this one; selectTree
      // skips the tree already chosen.
      if (state.treeID === body.tree.id) state.treeID = null;
      selectTree(body.tree.id);
      message(`added ${body.tree.root}`, true);
      return true;
    } catch (error) {
      message(error.message);
      return false;
    }
  }

  function addTree(event) {
    event.preventDefault();
    addTreeAt($("add-path").value);
  }

  // ---------- the folder browser ----------
  //
  // The page can't read a real path from a file picker, so the server lists
  // folders (/gui/api/browse) and this dialog walks them.

  const browser = { path: null, parent: null, tree: false };

  function openBrowse() {
    $("browse-note").textContent = "";
    $("browse-note").className = "note";
    if (!$("browse").open) $("browse").showModal();
    browseTo($("add-path").value.trim() || browser.path || "");
  }

  async function browseTo(where) {
    const list = $("browse-list");
    try {
      const body = await api(`/gui/api/browse?path=${q(where)}`);
      renderBrowse(body.browse);
    } catch (error) {
      $("browse-note").className = "note badc";
      $("browse-note").textContent = error.message;
      if (browser.path === null) list.textContent = "";
    }
  }

  function renderBrowse(view) {
    Object.assign(browser, { path: view.path, parent: view.parent, tree: view.tree });
    $("browse-path").value = view.path;
    $("browse-up").disabled = !view.parent;
    const drives = $("browse-drives");
    drives.textContent = "";
    drives.hidden = !view.drives.length;
    for (const drive of view.drives) {
      drives.append(h("button", { type: "button", className: "btn sm", text: drive.replace(/\/$/, ""), onclick: () => browseTo(drive) }));
    }
    const list = $("browse-list");
    list.textContent = "";
    for (const dir of view.dirs) {
      list.append(h("li", { className: dir.tree ? "tree" : "", tabindex: "0", title: dir.path,
        onclick: () => browseTo(dir.path),
        onkeydown: (event) => { if (event.key === "Enter") browseTo(dir.path); } },
      icon("folder"), h("span", { className: "nm", text: dir.name }),
      dir.tree ? pill("ok", "Eve.js instance") : null,
      dir.tree ? h("button", { type: "button", className: "btn sm primary", text: "Add",
        onclick: (event) => { event.stopPropagation(); addFromBrowse(dir.path); } }) : null));
    }
    if (!view.dirs.length) list.append(h("li", { className: "none", text: "No folders in here." }));
    if (view.truncated) list.append(h("li", { className: "none", text: `Showing the first ${view.dirs.length} folders. Type a path above to go further.` }));
    list.scrollTop = 0;
    const note = $("browse-note");
    $("browse-add").disabled = !view.tree;
    if (view.tree) {
      note.className = "note okc";
      note.textContent = "This folder is an Eve.js instance.";
    } else {
      note.className = "note";
      note.textContent = view.dirs.some((dir) => dir.tree)
        ? "Not an Eve.js instance itself, but a folder below is: open it, or click its Add."
        : "Not an Eve.js instance: it has no server/src. Keep looking.";
    }
  }

  async function addFromBrowse(root) {
    if (await addTreeAt(root)) $("browse").close();
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
    state.runData.delete(state.treeID);
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

  const VENDOR_FILE = "tools/gridcheck/VENDOR.json";
  const SHIM_FILE = "server/src/_secondary/agentBridge/server.js";

  // Facts as a two-column table: [icon, key, value nodes].
  const ftable = (rows) => h("div", { className: "ftable" }, rows.filter(Boolean).flatMap(([iconName, key, value]) => [
    h("div", { className: "k" }, icon(iconName, "sm"), key), h("div", { className: "v" }, value)]));
  const okText = (text) => h("span", { className: "okc" }, icon("check", "sm"), text);
  const badText = (text) => h("span", { className: "badc" }, text);

  function copyRow(tree) {
    const copy = tree.copy || {};
    const vendoredGui = state.context.mode === "vendored";
    const from = vendoredGui ? h("input", { type: "text", placeholder: "Path to a Gridcheck checkout", autocomplete: "off", spellcheck: "false" }) : null;
    const vendorRun = (force) => () => preview({ action: "vendor", force, from: from ? from.value : "" });
    const update = copy.vendored && copy.ok && !vendoredGui && !copy.upToDate;
    const version = (v, commit) => [ref("ver", v || "?"), commit ? ref("commit", short(commit)) : null];
    // Run from an unpacked folder, not a git checkout: it installs its files as they are on disk.
    const folder = !vendoredGui && !state.context.checkout;
    const here = folder ? "This folder" : "This checkout";
    const shimText = { missing: "missing", edited: "edited since it was installed", matches: "matches", present: "present" }[tree.shim] || tree.shim;
    const detail = () => [
      update || (!vendoredGui && copy.vendored && !copy.ok) ? h("div", { className: "vdiff" },
        h("div", { className: "side" }, h("span", { className: "lbl", text: "Installed in this Eve.js instance" }), h("span", { className: "row" }, version(copy.version, copy.commit))),
        icon("arrow"),
        h("div", { className: "side" }, h("span", { className: "lbl", text: here }),
          h("span", { className: "row" }, version(state.context.version, state.context.commit))),
        h("span", { className: "why", text: folder ? "Update copies this folder's files over the Eve.js instance's copy."
          : state.context.dirty ? "Uncommitted changes in the checkout aren't installed." : "Update copies the checkout's committed files over the Eve.js instance's copy." }))
        : null,
      ftable([
        copy.vendored && !update ? ["tag", "Installed", version(copy.version, copy.commit)] : null,
        !vendoredGui && !update && copy.vendored ? ["commit", here, version(state.context.version, state.context.commit)] : null,
        copy.vendored ? ["file", "Files", [copy.ok ? okText("match") : badText(`${copy.problemCount} differ from`), ref("path", VENDOR_FILE)]] : null,
        ["plug", "Bridge shim", [tree.shim === "matches" ? okText(shimText) : tree.shim === "present" ? shimText : badText(shimText), ref("path", SHIM_FILE)]],
        copy.present ? ["folder", "Installed at", ref("path", `${tree.root}/tools/gridcheck/`)] : null,
      ]),
      copy.problems && copy.problems.length ? h("ul", { className: "problems" }, copy.problems.map((row) => h("li", {}, ref("path", row.file), ` ${row.problem}`))) : null,
      from ? h("div", { className: "row" }, h("span", { className: "lbl", text: "Update from the Gridcheck checkout" }), from,
        h("button", { type: "button", className: "btn sm primary", text: "Update\u2026", onclick: vendorRun(!copy.ok) })) : null,
    ];
    if (!copy.present) {
      return { key: "copy", icon: "pkg", state: "need", blocks: true, title: "gridcheck is not installed",
        desc: [folder ? "Install copies this folder's files into " : "Install copies this checkout's committed files into ", ref("path", "tools/gridcheck/"),
          " and adds a small shim to the server."],
        action: { text: "Install\u2026", primary: true, run: vendorRun(false) }, detail };
    }
    if (!copy.vendored) {
      return { key: "copy", icon: "pkg", state: "bad", blocks: true, title: "tools/gridcheck wasn't installed by gridcheck", open: true,
        desc: ["It has no ", ref("path", "VENDOR.json"), ", so gridcheck can't tell what's in it. Installing replaces it."],
        action: { text: "Replace\u2026", primary: true, run: vendorRun(true) }, detail };
    }
    if (!copy.ok) {
      return { key: "copy", icon: "pkg", state: "bad", title: "gridcheck is installed, but its files were edited", open: true,
        desc: `${copy.problemCount} ${copy.problemCount === 1 ? "file differs" : "files differ"} from what was installed.`,
        action: vendoredGui ? { text: "Update\u2026", open: true } : { text: "Replace edited files\u2026", run: vendorRun(true) }, detail };
    }
    return { key: "copy", icon: "pkg", state: "ok", title: "gridcheck is installed", pill: update ? ["accent", "Update available"] : null, update,
      desc: update ? ["Version ", ...version(copy.version, copy.commit), `. ${here} is at `,
        state.context.commit ? ref("commit", short(state.context.commit)) : ref("ver", state.context.version || "?"), "."]
        : ["Version ", ...version(copy.version, copy.commit), ", unchanged since it was installed."],
      action: update ? { text: "Update\u2026", primary: true, run: vendorRun(false) } : vendoredGui ? { text: "Update\u2026", open: true } : null, detail };
  }

  function modePicker(tree, verb) {
    const config = tree.config || {};
    let chosen = config.exists && MODES[config.mode] ? config.mode : "auto";
    const write = h("button", { type: "button", className: "btn sm primary", text: verb, onclick: () => preview({ action: "init", mode: chosen }) });
    const hint = h("span", { className: "mode-hint" });
    const choose = (id) => { chosen = id; sync(); };
    const tabs = Object.entries(MODES).map(([id, mode]) => h("button", { type: "button", className: id, role: "tab", onclick: () => choose(id) },
      icon(mode.icon), mode.name,
      id === "auto" ? h("span", { className: "tag", text: "Default" }) : null,
      config.exists && id === config.mode ? h("span", { className: "cur", title: `${config.file || "gridcheck.config.json"} has this mode` }, icon("check"), "Current") : null));
    const panel = h("div", { className: "mode-panel", role: "tabpanel" });
    const sync = () => {
      Object.keys(MODES).forEach((id, index) => tabs[index].setAttribute("aria-selected", String(id === chosen)));
      panel.replaceChildren(...modePanel(MODES[chosen], choose));
      write.disabled = config.exists && !(config.problems || []).length && chosen === config.mode;
      write.title = write.disabled ? "Already this mode" : `Writes ${config.file || "gridcheck.config.json"}`;
      hint.replaceChildren(...(write.disabled ? ["Already saved in ", ref("path", config.file || "gridcheck.config.json")]
        : ["Saves ", h("code", { text: `"mode": "${chosen}"` }), " to ", ref("path", config.file || "gridcheck.config.json")]));
    };
    sync();
    return [h("div", { className: "mode-seg", role: "tablist", "aria-label": "Server mode" }, tabs), panel,
      playerWarning(), h("div", { className: "row" }, write, hint)];
  }

  // PLAYER_RISK as a banner, just above the button that writes the config.
  function playerWarning() {
    return h("div", { className: "player-warn", role: "alert" },
      h("span", { className: "pw-ic" }, icon("alert")),
      h("div", {},
        h("b", { text: "Never use gridcheck on an Eve.js instance you play on" }),
        h("p", { text: "Use a separate copy for testing. In every mode:" }),
        h("ul", {},
          h("li", {}, prose("`login --user <name>` logs in as any account, with no password.")),
          h("li", {}, "Booting a world replaces every account, character and asset in the instance."),
          h("li", {}, "Once the config is written, every server this instance starts opens the agent bridge, which runs GM commands."))));
  }


  // Prose with `code` in backticks; an EVEJS_ variable gets its env chip.
  const prose = (text) => String(text).split(/`([^`]+)`/).map((part, index) => (index % 2 === 0 ? part
    : part.startsWith("EVEJS_") ? ref("env", part) : h("code", { text: part })));

  // One mode's panel: summary and when to use it beside what a run does, then its good and bad sides.
  function modePanel(mode, choose) {
    const lane = ({ when, up, steps }) => h("div", { className: "run-lane" },
      h("div", { className: "run-lane-l" }, h("i", { className: `dot${up ? " up" : ""}` }), when),
      h("div", { className: "run-track" }, steps.flatMap(([title, sub, kind], index) => [
        index ? h("span", { className: "link" }, icon("arrow")) : null,
        h("div", { className: `run-step${kind ? ` ${kind}` : ""}` }, h("b", { text: title }), h("span", {}, prose(sub)))])));
    const list = (cls, iconName, title, items) => h("div", { className: `pc ${cls}` }, h("h5", { text: title }),
      h("ul", {}, items.map((item) => h("li", {}, icon(iconName), h("span", {}, prose(item))))));
    return [
      h("div", { className: "mode-top" },
        h("div", {},
          h("p", { className: "mode-sum", text: mode.summary }),
          h("p", { className: "mode-about" }, prose(mode.about)),
          h("h5", { text: "Use it when" }),
          h("ul", { className: "when" }, mode.useWhen.map((item) => h("li", {}, prose(item)))),
          h("h5", { text: "Pick another mode if" }),
          h("ul", { className: "when" }, mode.otherwise.map(([item, id]) => h("li", {}, item, " ",
            h("button", { type: "button", className: `to ${id}`, onclick: () => choose(id) }, icon("arrow"), MODES[id].name))))),
        h("div", {}, h("h5", { text: "What a run does" }), mode.lanes.map(lane))),
      h("div", { className: "mode-pc" }, list("good", "check", "Good", mode.good), list("bad", "alert", "Watch out", mode.watch)),
    ];
  }

  function modeRow(tree) {
    const config = tree.config || {};
    if (!tree.copy || !tree.copy.present) return { key: "mode", icon: "cycle", state: "wait", title: "Server mode", desc: "Install gridcheck first." };
    if (!config.exists) {
      return { key: "mode", icon: "cycle", state: "need", blocks: true, title: "Choose a server mode", open: true,
        desc: "gridcheck needs to know whether to start the Eve.js instance's server itself.", detail: () => modePicker(tree, "Write config\u2026") };
    }
    if ((config.problems || []).length) {
      return { key: "mode", icon: "cycle", state: "bad", blocks: true, title: `${config.file} has problems`, open: true, desc: config.problems[0],
        detail: () => [h("ul", { className: "problems" }, config.problems.map((problem) => h("li", { text: problem }))), ...modePicker(tree, "Rewrite config\u2026")] };
    }
    const mode = MODES[config.mode] || { name: config.mode, text: "" };
    return { key: "mode", icon: "cycle", state: "ok", title: `Server mode: ${mode.name}`, desc: mode.text,
      action: { text: "Change", open: true },
      detail: () => [h("div", { className: "saved" }, "Saved in", ref("path", config.file), "Runs go to", ref("path", config.runsDir, { dir: true })),
        ...modePicker(tree, "Rewrite config\u2026")] };
  }

  // An agent's logo tile: its mark on its own colour.
  const AGENT_LOGOS = { claude: ["claude", "\u2733"], codex: ["codex", ">_"] };
  function agentLogo(row) {
    if (row.id === "cli") return h("span", { className: "alogo cli", "aria-hidden": "true" }, icon("term"));
    const [cls, text] = AGENT_LOGOS[row.id] || ["other", String(row.name || "?").charAt(0)];
    return h("span", { className: `alogo ${cls}`, text, "aria-hidden": "true" });
  }

  function agentsRow(tree) {
    if (!tree.copy || !tree.copy.present) return { key: "agents", icon: "robot", state: "wait", title: "Configure MCP server for your Agents", desc: "Install gridcheck first." };
    const rows = tree.agents || [];
    const names = (list) => listed(list.map((row) => row.name));
    const connected = rows.filter((row) => row.registered);
    const waiting = rows.filter((row) => row.installed && !row.registered && !row.problem);
    const broken = rows.filter((row) => row.problem);
    const detail = () => [
      h("p", {}, "Claude Code reads this Eve.js instance's ", ref("path", ".mcp.json"), ". Codex reads one ", ref("path", "config.toml"),
        " for every folder, so its entry names this Eve.js instance's copy by path. Connecting only adds an entry; your other servers are left alone."),
      ...rows.map((row) => {
        const pointer = row.id === "cli";
        const what = row.problem ? [h("span", { className: "badc", text: row.problem })]
          : pointer ? [row.registered ? "Your agents call the CLI directly, through the pointer to the CLI guide in"
            : "If you don't want MCP servers on your agents, then your agents can call the CLI directly by adding a pointer to your agent docs:",
            ref("path", row.file)]
          : row.registered ? ["Runs this Eve.js instance's server as", ref("cmd", row.serverName), "from", ref("path", row.file)]
            : [row.installed ? "Found on this machine. Adds" : "Not found on this machine. Adds", ref("cmd", row.serverName), "to", ref("path", row.file)];
        const end = row.problem ? h("span", { className: "no", text: "Problem" })
          : row.registered ? h("span", { className: "yes" }, icon("check", "sm"), pointer ? "Added" : "Connected")
            : h("button", { type: "button", className: `btn sm${row.installed ? " primary" : ""}`,
              text: pointer ? "Add pointer\u2026" : row.installed ? `Connect ${row.name}\u2026` : "Set up anyway\u2026",
              onclick: () => preview({ action: "agents", agents: [row.id] }) });
        return h("div", { className: "agent-card", title: row.evidence && row.evidence.length ? `found: ${row.evidence.join(", ")}` : "" },
          agentLogo(row), h("div", {}, h("b", { text: row.name }), h("div", { className: "s" }, what)), end);
      }),
    ];
    if (broken.length) {
      return { key: "agents", icon: "robot", state: "bad", title: "Configure MCP server for your Agents", pill: ["bad", "Problem"], open: true,
        desc: `${names(broken)}: ${broken[0].problem}`, detail };
    }
    if (waiting.length) {
      return { key: "agents", icon: "robot", state: "optional", title: "Configure MCP server for your Agents", pill: ["accent", "Optional"], open: true,
        desc: `${connected.length ? `${names(connected)} ${connected.length === 1 ? "is" : "are"} connected. ` : ""}` +
          `${names(waiting)} ${waiting.length === 1 ? "is" : "are"} installed but not connected.`, detail };
    }
    if (connected.length) {
      return { key: "agents", icon: "robot", state: "ok", title: "MCP server configured for your Agents", desc: `${names(connected)} can run tests on this Eve.js instance.`, detail };
    }
    return { key: "agents", icon: "robot", state: "info", title: "No AI agents found", pill: ["info", "Optional"],
      desc: "Claude Code and Codex aren't on this machine. You can still set one up, or run tests from the terminal.", detail };
  }

  function prereqRow(tree) {
    const rows = tree.prerequisites || [];
    const missing = rows.filter((row) => !row.ok);
    const detail = () => [
      h("div", { className: "deps" }, rows.map((row) => h("div", { className: `dep${row.ok ? "" : " bad"}` },
        h("span", { className: "ck" }, icon(row.ok ? "check" : "x")),
        h("div", { className: "w" }, row.path ? ref("path", row.path, { dir: true }) : h("b", { text: row.name }),
          h("small", { text: row.ok ? upper(row.name) : `Missing. Fix: ${row.fix}` }))))),
      h("p", { text: "These are the Eve.js instance's own setup, so this page doesn't run them." })];
    if (missing.length) {
      return { key: "prereqs", icon: "db", state: "need", blocks: true, title: "Dependencies and reference data", pill: ["warn", "Missing"], open: true,
        desc: `Missing: ${listed(missing.map((row) => row.name))}.`, detail };
    }
    return { key: "prereqs", icon: "db", state: "ok", title: "Dependencies and reference data",
      desc: rows.length === 1 ? `${upper(rows[0].name)} is present.` : `All ${rows.length} are present.`, detail };
  }

  function pluginsRow(tree) {
    const doctor = state.doctor && state.doctor.treeID === tree.id ? state.doctor : null;
    const plugins = doctor && doctor.plugins ? doctor.plugins : tree.plugins || { active: [], skipped: [] };
    const installed = Boolean(tree.copy && tree.copy.present);
    const action = { text: doctor && doctor.running ? "Checking\u2026" : "Run health check", icon: "shield", open: true, run: runDoctor,
      disabled: !installed || Boolean(doctor && doctor.running), title: installed ? "Runs gridcheck doctor in the Eve.js instance" : "Install gridcheck first" };
    const detail = () => [
      h("ul", { className: "checks" },
        plugins.active.map((name) => checkItem(true, name, doctor && doctor.plugins ? "active (the Eve.js instance's copy says)" : "active")),
        plugins.skipped.map((row) => checkItem(null, row.name, `skipped: ${row.reason}`)),
        !plugins.active.length && !plugins.skipped.length ? checkItem(null, "No plugins apply to this Eve.js instance.") : null),
      doctor && doctor.command ? h("div", {}, ref("cmd", doctor.command)) : null,
      doctor ? h("pre", { text: doctor.text })
        : h("p", {}, "The health check (", ref("cmd", "gridcheck doctor"), ") asks the Eve.js instance's own copy what works: the gateway calls it makes, the client view, patches and listeners."),
    ];
    if (plugins.active.length) {
      return { key: "plugins", icon: "puzzle", state: "ok", title: "Plugins",
        desc: [...plugins.active.map((name) => h("span", { className: "pchip" }, icon("puzzle", "sm"), name)), plugins.active.length === 1 ? " is active." : " are active."],
        action, detail };
    }
    return { key: "plugins", icon: "puzzle", state: "info", title: "No plugins active",
      desc: plugins.skipped.length ? `${plugins.skipped.length} skipped; open for why.` : "Stock EveJS needs none.", action, detail };
  }

  function serverRow(tree) {
    const mode = tree.config && tree.config.exists ? tree.config.mode : null;
    if (tree.serverUp) {
      return { key: "server", icon: "power", state: "info", title: "The game server is running",
        desc: `${upper(tree.serverUp)}. Changes other than connecting agents wait until it stops.` };
    }
    if (mode === "attach") {
      return { key: "server", icon: "power", state: "info", title: "The game server is not running", pill: ["info", "Start it yourself"],
        desc: ["Attach mode only uses a server you start. Start it with ", ref("cmd", "npm start"), " in the server folder, or StartServer.bat."] };
    }
    return { key: "server", icon: "power", state: "info", title: "The game server is not running", pill: mode ? ["info", "No action needed"] : null,
      desc: mode === "managed" ? "Managed mode starts it for each test run." : mode === "auto" ? "Auto mode starts its own when none is up." : "The Eve.js instance's server is down." };
  }

  function checkRow(tree, row) {
    const key = `${tree.id}:${row.key}`;
    const body = row.detail ? h("details", { className: `crow ${row.state}` }) : h("div", { className: `crow ${row.state}` });
    const button = row.action ? h("button", { type: "button", className: `btn sm${row.action.primary ? " primary" : ""}`,
      disabled: row.action.disabled, title: row.action.title, onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (row.action.open && row.detail) body.open = true;
        if (row.action.run) row.action.run();
      } }, row.action.icon ? icon(row.action.icon) : null, row.action.text) : h("span");
    const head = h(row.detail ? "summary" : "div", { className: row.detail ? null : "sum" },
      h("span", { className: "tile" }, icon(row.icon || "info"), h("span", { className: "st" }, icon(STATE_ICONS[row.state] || "info"))),
      h("div", {}, h("div", { className: "t" }, row.title, row.pill ? h("span", { className: `pill ${row.pill[0]}`, text: row.pill[1] }) : null),
        h("div", { className: "d" }, row.desc)),
      button,
      row.detail ? icon("chev", "chev") : h("span"));
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
    const optional = rows.filter((row) => row.state === "optional");
    const updates = rows.filter((row) => row.update);
    let cls;
    let mark;
    let title;
    let text;
    let button = null;
    let choices = null;
    // gridcheck setup does every step but the tree's own dependencies and reference data.
    const setupButton = () => h("button", { type: "button", className: "btn primary", text: "Do full setup for me\u2026",
      title: "Runs gridcheck setup: install, config, the agents found, patches, the starter world and a smoke test. You see every command first.",
      onclick: () => preview({ action: "setup" }) });
    // Someone who chose Install over full setup is working through the checklist; don't offer setup again.
    // Full setup writes the config right after installing, so a copy with no config was installed on its own.
    const byHand = installedByHand(tree.id) || Boolean(tree.copy && tree.copy.present && tree.config && !tree.config.exists);
    const setupHelps = blocking.some((row) => row.key !== "prereqs") && !tree.serverUp && state.context.mode !== "vendored" && !byHand;
    if (tree.problem) {
      [cls, mark, title, text] = ["bad", icon("x"), "This folder can't be tested", tree.problem];
    } else if (!tree.copy || !tree.copy.present) {
      [cls, mark, title, text] = ["new", "+", "Gridcheck not installed yet",
        "Pick how far to go. Either way you see every command before it runs."];
      const choice = (primary, name, what, onclick) => h("button", { type: "button", className: `choice${primary ? " primary" : ""}`, onclick },
        h("span", { className: "choice-h" }, h("b", { text: name })),
        h("span", { className: "choice-what", text: what }));
      choices = h("div", { className: "choices" },
        choice(true, "Do full setup for me\u2026",
          "Gets the Eve.js instance all the way to a passing smoke test: installs gridcheck, writes gridcheck.config.json, sets up the agents found, "
          + "applies the patches and builds the starter world. Takes a few minutes; it boots the server twice.",
          () => preview({ action: "setup" })),
        choice(false, "Install\u2026",
          "Copies gridcheck into tools/gridcheck and adds the bridge shim, nothing else. "
          + "Then do the rest yourself, one row at a time, from the checklist below.",
          () => preview({ action: "vendor", force: false, from: "" })));
    } else if (blocking.length) {
      [cls, mark, title, text] = ["warn", icon("bang"), `${blocking.length} ${blocking.length === 1 ? "thing" : "things"} to do before you can run tests`,
        `${listed(blocking.map((row) => row.title))}.`];
      if (setupHelps) button = setupButton();
    } else {
      [cls, mark, title] = ["ok", icon("check"), "Ready to run tests"];
      const extras = [optional.length ? `${optional.length} optional ${optional.length === 1 ? "item" : "items"}` : null,
        updates.length ? `${updates.length} update` : null].filter(Boolean);
      text = extras.length ? `Everything required is in place. ${listed(extras)} below.` : "Everything is in place.";
      button = h("button", { type: "button", className: "btn primary", text: "Run a test \u2193",
        onclick: () => $("setup-run").scrollIntoView({ behavior: "smooth", block: "start" }) });
    }
    const counted = rows.filter((row) => row.state !== "info");
    hero.className = `hero ${cls}`;
    hero.append(h("div", { className: "big" }, mark), h("div", {}, h("h2", { text: title }), h("p", { text }),
      counted.length ? h("div", { className: "prog", "aria-hidden": "true" }, counted.map((row) => h("i", { className: row.state }))) : null), ...[button, choices].filter(Boolean));
  }

  function copyButton(text) {
    const button = h("button", { type: "button", className: "btn sm" }, icon("copy"), "Copy");
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        button.lastChild.textContent = "Copied";
        setTimeout(() => { button.lastChild.textContent = "Copy"; }, 1500);
      }).catch(() => message("couldn't copy; select the command instead"));
    });
    return button;
  }

  // ---------- Run a test ----------
  //
  // Two steps: get the world the picked scenario starts from (or log in, in
  // attach mode), then run it. The scenarios, recipes and their state come
  // from the tree's own copy (`run --json`, `world recipes --json`); a copy
  // without them gets the two fixed commands this card used to show.

  async function loadRunData(tree) {
    const id = tree.id;
    state.runData.set(id, { loading: true });
    const [list, runList, patches] = await Promise.all([
      api(`/gui/api/scenarios?tree=${q(id)}`).catch((error) => ({ error: error.message })),
      api(`/gui/api/runs?tree=${q(id)}`).catch(() => ({ runs: [] })),
      api(`/gui/api/patches?tree=${q(id)}`).catch(() => null),
    ]);
    state.runData.set(id, { loading: false, error: list.error || null, scenarios: list.scenarios ?? null, recipes: list.recipes ?? null,
      runs: runList.runs || [], patches: patches && Array.isArray(patches.patches.json) ? patches.patches.json : null });
    if (state.tree && state.tree.id === id && state.tab === "install") renderRunCard(state.tree, setupRows(state.tree));
  }

  const seconds = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  };

  // The newest run of a scenario: { verdict: p|f|d, ms }.
  function lastRun(data, name) {
    const run = (data.runs || []).find((row) => row.result && row.result.name === name);
    if (!run) return null;
    const result = run.result;
    return { verdict: result.exitCode === 2 ? "d" : result.passed ? "p" : "f", run: run.runID,
      ms: result.startedAtMs && result.stoppedAtMs ? result.stoppedAtMs - result.startedAtMs : null };
  }

  function pickScenario(tree, list) {
    const usable = list.filter((row) => !row.problem);
    const wanted = state.runPick.get(tree.id);
    const preferred = tree.config.mode === "attach" ? "smoke-undock" : "loadout-npc-fight";
    return list.find((row) => row.name === wanted) || usable.find((row) => row.name === preferred) || usable[0] || list[0] || null;
  }

  // One line of what a recipe step does: [icon, text, small].
  function recipeStep(step) {
    if (step === "fresh") return ["globe", "A fresh world, seeded from the reference data", null];
    if (step === "login") return ["user", "Logs in the gridcheck character", null];
    if (step === "undock" || step === "dock") return ["ship", step === "undock" ? "Undocks" : "Docks", null];
    if (!step || typeof step !== "object") return ["list", String(step), null];
    const note = step.note ? String(step.note) : null;
    if (step.slash) return ["prompt", `Runs ${step.slash}`, note];
    if (step.teleport) return ["pin", `Moves to ${step.teleport}`, note];
    if (step.wait) return ["clock", `Waits ${step.wait} s`, note];
    if (step.loadout) {
      const loadout = step.loadout;
      const parts = [...(loadout.modules || []), ...(loadout.drones || []).map((row) => `${row} (drones)`),
        ...(loadout.cargo || []).map((row) => `${row} (cargo)`)];
      return ["ship", `A fitted ${loadout.ship || "ship"}`, parts.join(", ") || note];
    }
    const key = Object.keys(step)[0] || "step";
    return ["list", key, note];
  }

  function stepCard(cls, num, last, card) {
    return h("div", { className: `step ${cls}` }, h("div", { className: "srail" }, h("span", { className: "num", text: String(num) }), last ? null : h("span", { className: "line" })), card);
  }

  // A command with labels under its parts: [[text, label, class], ...].
  function annotatedTerm(parts, command) {
    return h("div", { className: "term tall" }, h("span", { className: "ps", text: ">" }),
      h("span", { className: "tline" }, parts.map(([text, label, cls]) => h("span", { className: `tok${cls ? ` ${cls}` : ""}` },
        h("span", { className: { t2: "sub", t3: "arg" }[cls] || "bin", text }), h("em", { text: label })))), copyButton(command));
  }

  function plainTerm(parts, command) {
    return h("div", { className: "term" }, h("span", { className: "ps", text: ">" }),
      h("span", { className: "tline" }, parts.map(([text, cls], index) => [index ? " " : "", h("span", { className: cls, text })])), copyButton(command));
  }

  function worldStep(tree, data, scenario) {
    const mode = tree.config.mode;
    const scard = (iconName, heading, sub, stateNode, ...body) => h("div", { className: "scard" },
      h("div", { className: "scard-h" }, h("span", { className: "ic" }, icon(iconName)), h("div", {}, h("h4", { text: heading }), h("p", {}, sub)), stateNode), ...body);
    if (mode === "attach") {
      const command = `${CLI} login`;
      return scard("user", "Log in to the server you started", "Logs the gridcheck character in, and starts the client view.",
        h("span", { className: `sstate ${tree.up ? "ok" : ""}` }, h("i"), tree.up ? "Server is up" : "Start the server first"),
        annotatedTerm([[CLI, "the gridcheck command in this Eve.js instance"], ["login", "log in", "t2"]], command),
        h("div", { className: "what" }, h("div", { className: "meta" }, h("div", { className: "m" }, icon("plug", "sm"),
          h("span", {}, "Attach mode runs on the live server as it is, so the scenario's world isn't applied. Start the server with ",
            ref("cmd", "npm start"), " or StartServer.bat.")))));
    }
    if (!scenario.recipe) {
      const fresh = scenario.world === "fresh";
      return scard("globe", fresh ? "No world to build" : `Uses the saved world ${scenario.world}`,
        fresh ? `${scenario.name} starts from a fresh world, seeded from the reference data at boot.`
          : ["Saved with ", ref("cmd", "gridcheck world save"), "; ", ref("cmd", "gridcheck world list"), " shows what's saved."],
        h("span", { className: "sstate mute" }, h("i"), "Nothing to do"));
    }
    const recipe = (data.recipes || []).find((row) => row.name === scenario.recipe);
    const command = `${CLI} world build ${scenario.recipe}`;
    const stateNode = !recipe ? h("span", { className: "sstate bad" }, h("i"), "No such recipe")
      : recipe.state === "built" ? h("span", { className: "sstate ok", title: recipe.savedAt ? `saved ${recipe.savedAt}` : "" }, h("i"), "Built, current")
        : recipe.state === "broken" ? h("span", { className: "sstate bad", title: recipe.why || "" }, h("i"), "Recipe is broken")
          : h("span", { className: "sstate", title: recipe.why || "" }, h("i"), recipe.why && /hasn't been built/.test(recipe.why) ? "Not built yet" : "Out of date");
    const steps = recipe ? (recipe.steps || []).map(recipeStep) : [];
    const worldsDir = tree.config.worldsDir || "_local/gridcheck/worlds";
    return scard("globe", `Build the ${scenario.recipe} world`, recipe ? recipe.description : `The scenario names a recipe, ${scenario.recipe}, that this Eve.js instance doesn't have.`,
      stateNode,
      annotatedTerm([[CLI, "the gridcheck command in this Eve.js instance"], ["world build", "build a world", "t2"], [scenario.recipe, `from the ${scenario.recipe} recipe`, "t3"]], command),
      h("div", { className: "what" },
        h("div", {}, h("h5", { className: "lbl", text: "What it does" }),
          h("ul", { className: "gets" }, steps.map(([iconName, text, small]) => h("li", {}, h("span", { className: "g" }, icon(iconName)),
            h("div", {}, text, small ? h("small", { text: small }) : null))))),
        h("div", { className: "meta" }, h("h5", { className: "lbl", text: "Good to know" }),
          h("div", { className: "m" }, icon("refresh", "sm"), h("span", {}, "Optional: a run that names the recipe builds it when it's missing or out of date.")),
          h("div", { className: "m" }, icon("folder", "sm"), h("span", {}, "Saved to ", ref("path", `${worldsDir}/${scenario.recipe}/`))),
          h("div", { className: "m" }, icon("power", "sm"), h("span", {}, "Needs the server down. ",
            h("span", { className: tree.up ? "warnc" : "okc", text: tree.up ? "It's up: gridcheck down first." : "It is." }))),
          mode === "managed" || mode === "auto" ? null : h("div", { className: "m" }, icon("alert", "sm"), h("span", { text: "Needs auto or managed mode." })))));
  }

  function runStep(tree, data, scenario, list) {
    const opts = state.runOpts;
    const attach = tree.config.mode === "attach";
    const flags = [opts.check ? "--check" : null, !attach && opts.keepUp && !opts.reuse ? "--keep-up" : null,
      !attach && opts.reuse && scenario.recipe ? "--reuse" : null].filter(Boolean);
    const command = `${CLI} run ${scenario.name}${flags.length ? ` ${flags.join(" ")}` : ""}`;
    const sec = (iconName, label, content, count = null) => h("div", { className: "sec" },
      h("div", { className: "sl" }, icon(iconName, "sm"), h("span", { className: "lbl", text: label }), count === null ? null : h("span", { className: "cnt", text: String(count) })), content);
    // Group the picker: the tree's own, the core's, then each plugin's.
    const groups = new Map();
    for (const row of list) {
      const group = row.plugin ? `${row.plugin} plugin` : /^tools\/(gridcheck|e2e)-scenarios\//.test(row.file) ? "This Eve.js instance" : "Core";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    const picker = h("div", { className: "picker" }, [...groups].map(([group, rows]) => h("div", { className: "prow" },
      h("span", { className: "grp", text: group, title: group }),
      rows.map((row) => {
        const last = lastRun(data, row.name);
        const verdict = row.problem ? "broken" : last ? last.verdict : "n";
        const title = row.problem ? `doesn't load: ${row.problem}` : last ? `last run ${{ p: "passed", f: "failed", d: "did not complete" }[last.verdict]}` : "no runs yet";
        return h("button", { type: "button", className: `sc ${verdict}`, "aria-pressed": String(row.name === scenario.name), title,
          onclick: () => { state.runPick.set(tree.id, row.name); renderRunCard(tree, setupRows(tree)); } }, h("i"), row.name);
      }))));
    const last = lastRun(data, scenario.name);
    const opt = (key, flag, text, disabled = false) => h("label", { className: `opt${disabled ? " off" : ""}`, title: disabled ? "Not in attach mode" : null },
      h("input", { type: "checkbox", checked: opts[key] && !disabled, disabled, onchange: (event) => {
        opts[key] = event.target.checked;
        if (key === "keepUp" && opts.keepUp) opts.reuse = false;
        if (key === "reuse" && opts.reuse) opts.keepUp = false;
        renderRunCard(tree, setupRows(tree));
      } }), h("code", { text: flag }), h("span", { text }));
    return h("div", { className: "scard" },
      h("div", { className: "scard-h" }, h("span", { className: "ic" }, icon("target")),
        h("div", {}, h("h4", { text: "Run a scenario" }), h("p", { text: attach ? "Runs the scenario on the server you started, and checks what happened."
          : "Boots the server, plays the scenario, stops the server, and checks what happened." }))),
      sec("list", "Scenario", picker),
      sec("term", "Command", plainTerm([[CLI, "bin"], ["run", "sub"], [scenario.name, "arg"], ...flags.map((flag) => [flag, "flag"])], command)),
      scenario.problem ? sec("alert", "Problem", h("div", { className: "sproblem", text: scenario.problem })) : null,
      sec("target", "What it does", h("p", { className: "desc", text: scenario.description || "(no description)" })),
      scenario.expect.length ? sec("flag", "It checks", h("ul", { className: "xs-list" }, scenario.expect.map((row) => h("li", { className: row.absent ? "absent" : "",
        title: row.text }, icon(row.absent ? "x" : "flag"), row.note || row.text))), scenario.expect.length) : null,
      sec("clock", "Details", h("div", { className: "tiles" },
        h("div", { className: "tl" }, h("span", { className: "lbl", text: "Starts from" }), h("span", { className: "v" },
          attach ? "the live server, as it is" : ref("ver", scenario.world || "?", { copy: false }), !attach && scenario.recipe ? h("span", { className: "linkback" }, icon("up", "xs"), "step 1") : null)),
        h("div", { className: "tl" }, h("span", { className: "lbl", text: "Stops" }), h("span", { className: "v",
          text: scenario.timeout ? `at its stop condition, or ${scenario.timeout} s after setup` : "at its stop condition" })),
        h("div", { className: "tl" }, h("span", { className: "lbl", text: "Last run" }), h("span", { className: "v" },
          last ? [h("span", { className: { p: "okc", f: "badc", d: "warnc" }[last.verdict], text: { p: "passed", f: "failed", d: "did not complete" }[last.verdict] }),
            last.ms ? ` in ${seconds(last.ms)}` : ""] : "no runs yet")),
        h("div", { className: "tl" }, h("span", { className: "lbl", text: "Scenario file" }), h("span", { className: "v" }, ref("path", scenario.file))))),
      sec("sliders", "Options", h("div", { className: "optlist" },
        opt("check", "--check", "Only load and check the scenario. Boots nothing."),
        opt("keepUp", "--keep-up", "Leave the server running afterwards.", attach),
        opt("reuse", "--reuse", scenario.recipe ? "Reset the server a --reuse run left up, instead of booting." : "Needs a scenario that names a recipe.",
          attach || !scenario.recipe))),
      sec("runs", "Result", h("div", { className: "result" },
        badge("ok", "passed", true), h("span", { className: "muted", text: "or" }), badge("bad", "failed", true),
        h("span", { className: "muted", text: "printed with the path to" }), ref("path", `${tree.config.runsDir || "_local/gridcheck/runs"}/<run>/report.md`, { copy: false }),
        h("span", { className: "spacer" }),
        h("button", { type: "button", className: "btn sm", onclick: () => showTab("runs") }, icon("runs"), "Open the Runs tab"))));
  }

  function patchesNote(data) {
    if (!data.patches || !data.patches.length) return null;
    const on = data.patches.filter((row) => row.state === "applied" || row.state === "detected").length;
    return h("div", { className: "before" }, icon("patch"),
      h("span", {}, h("b", { text: "Optional, before step 2: " }), "the Patches tab's edits add what stock EveJS doesn't report, such as NPC decisions and ",
        "whether a slash command worked. ", h("b", { text: `${on} of ${data.patches.length}` }), " are on in this Eve.js instance."),
      h("button", { type: "button", className: "btn sm", onclick: () => showTab("patches") }, "Patches", icon("arrow")));
  }

  // The fixed commands, for a copy without `run --json`.
  function legacyCommands(tree, pane) {
    const steps = tree.config.mode === "attach"
      ? [["Log in to the server you started", `${CLI} login`], ["Run a scenario", `${CLI} run smoke-undock`]]
      : [["Build a test world", `${CLI} world build starter`], ["Run a scenario", `${CLI} run loadout-npc-fight`]];
    steps.forEach(([why, command], index) => pane.append(h("div", { className: "lcmd" },
      h("span", { className: "n", text: String(index + 1) }), h("code", { text: command }), h("span", { className: "why", text: why }), copyButton(command))));
    pane.append(h("p", { className: "muted" }, "Run these from ", ref("path", tree.root, { dir: true }), ". This Eve.js instance's copy can't list its scenarios; ",
      "update it to pick one here. For every command, see the Commands tab."));
  }

  function agentPane(tree, data, pane) {
    const connected = (tree.agents || []).filter((row) => row.registered);
    if (!connected.length) {
      pane.append(h("p", { text: "No agent is connected to this Eve.js instance yet. Connect one in the checklist above, or use the terminal." }));
      return;
    }
    const scenario = data && Array.isArray(data.scenarios) ? pickScenario(tree, data.scenarios) : null;
    const name = scenario ? scenario.name : "loadout-npc-fight";
    pane.append(h("div", { className: "agent-row" }, connected.map(agentLogo),
      h("span", {}, h("b", { text: listed(connected.map((row) => row.name)) }), ` ${connected.length === 1 ? "is" : "are"} connected to this Eve.js instance, with the gridcheck tools. It starts with `,
        ref("tool", "status"), ".")));
    const prompts = [
      [`Run ${name} and tell me which expectations failed.`, "Runs a scenario this Eve.js instance already has."],
      ["Write a scenario that checks the feature I'm working on, then run it.", "Drafts a scenario, checks it and runs it."],
      ["Undock, spawn two hostile NPCs with /npc 2 and watch the grid for 60 s.", "Drives the ship step by step, without a scenario."],
    ];
    pane.append(h("div", { className: "prompts" }, prompts.map(([text, note]) => h("div", { className: "prompt" }, icon("msg"),
      h("div", {}, h("span", { text }), h("small", { text: note })), copyButton(text)))));
    const tools = h("div", { className: "tools" }, h("span", { className: "muted", text: "reading the tools..." }));
    pane.append(h("div", {}, h("h5", { className: "lbl", text: "Tools it has" }), tools));
    commands.catalog(tree.id).then((catalog) => {
      tools.textContent = "";
      for (const tool of catalog.mcpTools || []) tools.append(h("span", { title: tool.description }, ref("tool", tool.name, { copy: false, title: tool.description })));
    }).catch((error) => { tools.textContent = error.message; });
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
    const data = state.runData.get(tree.id);
    if (!data) loadRunData(tree).catch((error) => message(error.message));
    const tabs = h("div", { className: "rtabs", role: "tablist" },
      [["terminal", "Terminal", "term"], ["agent", "Ask your agent", "robot"]].map(([id, label, iconName]) => h("button", { type: "button", role: "tab",
        "aria-selected": String(state.runTab === id), onclick: () => { state.runTab = id; renderRunCard(tree, rows); } }, icon(iconName, "sm"), label)));
    const pane = h("div", { className: "pbody" });
    card.append(tabs, pane);
    if (state.runTab === "agent") {
      agentPane(tree, data, pane);
      return;
    }
    if (!data || data.loading) {
      pane.append(h("p", { className: "muted", text: "Reading the Eve.js instance's scenarios and worlds..." }));
      return;
    }
    if (!Array.isArray(data.scenarios) || !data.scenarios.length) {
      if (data.error) pane.append(h("p", { className: "badc", text: data.error }));
      legacyCommands(tree, pane);
      return;
    }
    const scenario = pickScenario(tree, data.scenarios);
    const attach = tree.config.mode === "attach";
    pane.append(h("div", { className: "intro" }, attach ? "Log in to the server you started, then run a scenario on it." : "Get the world the scenario starts from, then run it.",
      " Run both from", ref("path", tree.root, { dir: true })));
    pane.append(stepCard("s1", 1, false, worldStep(tree, data, scenario)));
    pane.append(stepCard("s2", 2, true, runStep(tree, data, scenario, data.scenarios)));
    const note = patchesNote(data);
    if (note) pane.append(note);
  }

  function renderInstall(tree) {
    $("install-empty").hidden = Boolean(tree);
    $("install-detail").hidden = !tree;
    if (!tree) {
      $("onboard-title").textContent = state.trees.length ? "Pick an Eve.js instance on the left, or add another" : "Add an Eve.js instance to get started";
      return;
    }
    $("install-title").textContent = tree.name;
    const root = $("install-root");
    root.textContent = "";
    root.append(...[ref("path", tree.root, { dir: true }), tree.evejs ? ref("ver", `EveJS ${tree.evejs}`, { copy: false }) : null,
      tree.git === false ? h("span", { text: "not a git checkout, so uncommitted changes can't be checked" }) : null].filter(Boolean));
    const rows = tree.problem ? [] : setupRows(tree);
    renderHero(tree, rows);
    // The tree's own dependencies come first, on their own: a precheck, not a setup step.
    const pre = rows.filter((row) => row.key === "prereqs");
    const steps = rows.filter((row) => row.key !== "prereqs");
    const preBox = $("setup-pre");
    preBox.textContent = "";
    for (const row of pre) preBox.append(checkRow(tree, row));
    preBox.parentElement.hidden = !pre.length;
    const list = $("setup-rows");
    list.textContent = "";
    for (const row of steps) list.append(checkRow(tree, row));
    list.parentElement.hidden = !steps.length;
    const counted = steps.filter((row) => row.state !== "info");
    $("setup-progress").textContent = counted.length ? `${counted.filter((row) => row.state === "ok").length} of ${counted.length} done` : "";
    renderRunCard(tree, rows);
  }

  // The Install tab's count: what keeps the tree from running tests.
  function updateInstallCount(tree) {
    if (!tree || tree.problem || !state.context) return setCount("install", null);
    const blocking = setupRows(tree).filter((row) => row.blocks).length;
    setCount("install", blocking || null, true);
  }

  async function runDoctor() {
    const id = state.treeID;
    const rerender = () => {
      if (state.tree && state.tree.id === id && state.tab === "install") renderInstall(state.tree);
    };
    state.doctor = { treeID: id, running: true, command: "", text: "running gridcheck doctor...", plugins: null };
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

  // The same lines `gridcheck doctor` prints, from its --json report.
  function formatDoctor(report) {
    const lines = [];
    const tool = report.tool || {};
    lines.push(`Gridcheck  ${tool.version || "?"}${tool.commit ? ` at ${short(tool.commit)}` : ""}${tool.vendored ? " (vendored)" : " (checkout)"}`);
    const config = report.tree && report.tree.config;
    lines.push(`instance   ${report.tree ? report.tree.root : "?"}; ${config && config.exists ? `gridcheck.config.json, mode ${config.mode}` : "no gridcheck.config.json"}`);
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
    lines.push(destiny.ok ? `destiny    the decoder reads this Eve.js instance's ball layout (${destiny.balls} probe balls); client view on`
      : `destiny    client view OFF: ${destiny.error}`);
    lines.push(`patches    ${(report.patches || []).map((patch) => `${patch.id} ${patch.state}${patch.version ? ` v${patch.version}` : ""}`).join(", ") || "none known"}`);
    const listeners = Object.entries(report.listeners || {});
    lines.push(listeners.length ? `listeners  move: ${listeners.filter(([, row]) => row.movable).map(([name]) => name).join(", ") || "none"}` +
      `${listeners.some(([, row]) => !row.movable) ? `; stay on stock ports: ${listeners.filter(([, row]) => !row.movable).map(([name]) => name).join(", ")}` : ""}`
      : "listeners  not probed yet (gridcheck init)");
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
      $("patches-empty").textContent = "Install the copy into this Eve.js instance first (Install tab).";
      return;
    }
    $("patches-empty").hidden = false;
    $("patches-empty").textContent = "reading the Eve.js instance's patch status...";
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
      const why = row.state === "detected" ? "equivalent code is already there, so this Eve.js instance doesn't need it"
        : row.state === "absent" && row.applies ? "applies cleanly"
          : row.problems ? row.problems.join("; ") : row.missing ? `${row.missing.join(", ")} not in this Eve.js instance` : row.error || "";
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

  // A command's output, one coloured span per line, by what the line is. The
  // CLI's lines are plain text, so this reads their shape: step headers, the
  // commands, files added, changed and removed, notes, and failures.
  const OUTPUT_KINDS = [
    [/^\[\d+\/\d+\] /, "o-step"],
    [/^\s*\$ /, "o-cmd"],
    [/^\s+\+ /, "o-add"],
    [/^\s+~ /, "o-change"],
    [/^\s+- (?!-)/, "o-remove"],
    [/^\s+\.\.\. and \d+ more/, "o-dim"],
    [/^\s*skipped: /, "o-dim"],
    [/(^|\s)(error|failed|refused|can't start|stopped at|exited [1-9]|missing)\b|^gridcheck: /i, "o-bad"],
    [/^(would )?(vendor(ed)?|install(ed)?|wrote|would write|applied|would apply) /i, "o-head"],
    [/nothing was written|^dry run:|^setup .*\(dry run/i, "o-ok"],
    [/^\s+(the tool isn't installed yet|builds |boots |about \d+)/, "o-note"],
  ];

  function outputPre(output) {
    const text = String(output || "").trim();
    if (!text) return h("pre", { className: "out", text: "(no output)" });
    return h("pre", { className: "out" }, text.split(/\r?\n/).map((line) => {
      const kind = OUTPUT_KINDS.find(([pattern]) => pattern.test(line));
      return h("span", { className: kind ? kind[1] : null, text: `${line}\n` });
    }));
  }

  // ---------- the preview dialog ----------
  // Every change is previewed first (core/gui.js preview). The dialog leads with
  // what will happen, read from the dry run (core/previewSummary.js): the files,
  // whether each is new or already there, and the checks it passed. The commands
  // and their raw output stay under "Technical details".

  const AGENT_LABELS = { claude: "Claude Code", codex: "Codex", cli: "other agents" };
  const AGENT_WHO = { "CLI only": "other agents" };
  const andList = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
  const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const baseName = (file) => String(file).replace(/\/$/, "").split("/").pop();
  const capital = (text) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : text);
  const summaryOf = (p) => (p && p.summary) || { changes: [], next: [], notes: [] };
  const folderTotal = (row) => row.counts.added + row.counts.changed + row.counts.removed;
  const writes = (p) => summaryOf(p).changes.filter((row) => (row.kind === "folder" ? folderTotal(row) > 0 : row.change !== "none"));
  // The dry run understood, and it would write nothing.
  const nothingToDo = (p) => summaryOf(p).changes.length > 0 && !writes(p).length;
  // Files written: a folder counts each file in it.
  const fileCount = (p) => writes(p).reduce((sum, row) => sum + (row.kind === "folder" ? folderTotal(row) : 1), 0);

  // The title, icon, the sentence under the title, and the Run button's words.
  function previewWords(request, p) {
    const changes = summaryOf(p).changes;
    switch (request.action) {
      case "agents": {
        const names = andList((request.agents || []).map((id) => AGENT_LABELS[id] || id)) || "agents";
        const files = [...new Set(writes(p).map((row) => baseName(row.path)))];
        const replacing = writes(p).length > 0 && writes(p).every((row) => row.change === "replace");
        return { icon: "robot", title: `Connect ${names}`,
          lede: `${capital(names)} will be able to start, test and inspect this Eve.js instance's server with Gridcheck's tools.`,
          run: files.length === 1 ? `${replacing ? "Update" : "Add to"} ${files[0]}` : `Write ${plural(files.length, "file")}`,
          done: `${capital(names)} ${(request.agents || []).length === 1 && request.agents[0] !== "cli" ? "is" : "are"} connected` };
      }
      case "vendor": {
        const folder = changes.find((row) => row.kind === "folder");
        const tree = currentTree();
        const fresh = folder ? !folder.exists : !(tree && tree.copy);
        return fresh
          ? { icon: "install", title: "Install Gridcheck into this Eve.js instance", run: "Install", done: "Gridcheck is installed",
            lede: "Copies Gridcheck into tools/gridcheck/ and adds the small bridge file the server loads at startup." }
          : { icon: "install", title: "Update Gridcheck in this Eve.js instance", run: "Update copy", done: "Gridcheck is updated",
            lede: "Replaces this Eve.js instance's copy of Gridcheck in tools/gridcheck/ with the version below." };
      }
      case "patch-apply":
        return { icon: "patch", title: `Apply the ${request.id} patch`, run: "Apply patch", done: `Applied the ${request.id} patch`,
          lede: "Inserts the lines below into the server's code. Reverting the patch takes them out again." };
      case "patch-revert":
        return { icon: "patch", title: `Revert the ${request.id} patch`, run: "Revert patch", done: `Reverted the ${request.id} patch`,
          lede: "Takes the patch's lines out of the server's code, so the files are back as they were." };
      case "init": {
        const replacing = changes.length ? changes[0].exists : false;
        return { icon: "sliders", title: replacing ? "Replace the config" : "Write the config", run: replacing ? "Replace config" : "Write config",
          done: "Config written", lede: "gridcheck.config.json tells Gridcheck where this Eve.js instance's server is and how to start and reach it." };
      }
      case "setup":
        return { icon: "wrench", title: "Full setup", run: "Run setup", done: "Setup finished",
          lede: "Runs each setup step this Eve.js instance still needs, in order, and stops at the first one that fails. " +
            "A first setup builds a world and boots the server twice, so it can take several minutes." };
      default:
        return { icon: "info", title: request.action, run: "Run", done: "Done", lede: "" };
    }
  }

  function codeList(files) {
    const parts = [];
    files.forEach((file, index) => {
      if (index) parts.push(index === files.length - 1 ? " and " : ", ");
      parts.push(h("code", { text: file }));
    });
    return parts;
  }

  function section(title, count, ...body) {
    return h("div", { className: "pv-sec" },
      h("div", { className: "pv-sec-h" }, title, count ? h("span", { className: "pv-count", text: count }) : null), ...body);
  }

  function statusLine(kind, mark, strong, rest) {
    return h("div", { className: `pv-status ${kind}` },
      h("span", { className: "pv-dot" }, typeof mark === "string" ? icon(mark) : String(mark)),
      h("div", {}, h("b", { text: strong }), rest ? h("span", { className: "muted", text: ` ${rest}` }) : null));
  }

  function diffRows(row) {
    const rows = [...(row.removed || []).map((text) => ({ kind: "del", text })), ...(row.added || []).map((text) => ({ kind: "add", text }))];
    for (const hunk of row.hunks || []) {
      rows.push({ kind: "at", text: `line ${hunk.line}, ${hunk.where} "${hunk.near}" (${hunk.eol} line endings)` });
      rows.push(...hunk.lines.map((text) => ({ kind: hunk.removes ? "del" : "add", text })));
    }
    return rows;
  }

  function fileDescription(row, action) {
    if (row.role === "shim") {
      return row.change === "none" ? "The bridge file the server loads at startup. Already this version's, so it stays as it is."
        : row.change === "add" ? "The bridge file the server loads at startup." : "The bridge file the server loads at startup, replaced with this version's.";
    }
    if (row.agent) {
      const agent = AGENT_WHO[row.agent] || row.agent;
      if (row.change === "none") return `${capital(agent)}: already set up here, as ${row.entry}. Nothing to change.`;
      const missing = row.notFound ? ` ${row.agent} wasn't found on this machine; this works once it's installed.` : "";
      if (row.agent === "CLI only") return `Adds ${row.entry}, for agents other than Claude Code and Codex.${missing}`;
      if (row.change === "replace") {
        return [`Replaces ${row.agent}'s old `, h("code", { text: row.entry }), " entry",
          row.gone ? `, which ran ${row.gone}, a file that's gone.` : ".", missing];
      }
      return ["Adds a server named ", h("code", { text: row.entry }), ` for ${row.agent}.`, missing];
    }
    if (action === "init") return `Gridcheck's settings for this Eve.js instance, in ${row.mode} mode.${row.exists ? " Replaces the file that's there." : ""}`;
    if (row.hunks) {
      const lines = row.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
      const removes = row.hunks.some((hunk) => hunk.removes);
      return `${plural(lines, "line")} ${removes ? "taken out" : "inserted"} in ${plural(row.hunks.length, "place")}.`;
    }
    return null;
  }

  // A file the change writes: new, or already there and changed.
  function fileCard(row, action) {
    const pill = row.change === "none" ? ["k-same", "No change"] : row.exists ? ["k-change", "Changes existing file"] : ["k-add", "New file"];
    const cut = row.path.lastIndexOf("/");
    const dir = cut > 0 ? row.path.slice(0, cut + 1) : "";
    const rows = diffRows(row);
    const counted = rows.filter((line) => line.kind !== "at").length;
    const adds = rows.every((line) => line.kind !== "del");
    const label = action === "init" && !row.exists ? "Show the file"
      : adds ? `Show the ${plural(counted, "line")} it adds` : row.hunks ? `Show the ${plural(counted, "line")} it takes out` : "Show the change";
    return h("div", { className: `pv-file${row.change === "none" ? " same" : ""}` },
      h("div", { className: "pv-file-top" },
        h("span", { className: "pv-ficon" }, icon("file")),
        h("div", { className: "pv-grow" },
          h("div", { className: "pv-fline", title: row.path },
            h("span", { className: "pv-fname", text: baseName(row.path) }),
            dir ? h("span", { className: "pv-fdir", text: dir }) : h("span", { className: "pv-fdir", text: "in the Eve.js instance's folder" }),
            row.outside ? h("span", { className: "pv-out", text: "outside this Eve.js instance" }) : null),
          h("div", { className: "pv-fdesc" }, fileDescription(row, action))),
        h("span", { className: `pv-pill ${pill[0]}`, text: pill[1] })),
      counted ? h("details", { className: "pv-lines" }, h("summary", { text: label }),
        h("div", { className: "pv-diff" }, rows.map((line) => h("div", { className: `d-${line.kind}`, text: line.text || " " })))) : null);
  }

  // tools/gridcheck/: which files are new and which ones already there change.
  function folderCard(row) {
    const { counts } = row;
    const group = (key, label, hint) => {
      if (!counts[key]) return null;
      return h("details", { className: `pv-group ${key}`, open: key !== "added" || counts.added <= 8 ? true : null },
        h("summary", {}, h("b", { text: label }), h("span", { className: "pv-n", text: String(counts[key]) }), h("span", { className: "pv-hint", text: hint })),
        h("ul", { className: "pv-flist" }, row[key].map((file) => h("li", { text: file })),
          row.more[key] ? h("li", { className: "more", text: `... and ${row.more[key]} more` }) : null));
    };
    const bar = h("div", { className: "pv-bar" });
    for (const key of ["added", "changed", "removed"]) {
      if (!counts[key]) continue;
      const part = h("i", { className: key });
      part.style.flexGrow = String(counts[key]);
      bar.append(part);
    }
    return h("div", { className: "pv-file" },
      h("div", { className: "pv-file-top" },
        h("span", { className: "pv-ficon" }, icon("folder")),
        h("div", { className: "pv-grow" },
          h("div", { className: "pv-fline" }, h("span", { className: "pv-fname", text: `${row.path}/` })),
          h("div", { className: "pv-fdesc", text: row.exists
            ? `Gridcheck's own files. ${plural(counts.same, "file")} ${counts.same === 1 ? "stays" : "stay"} as ${counts.same === 1 ? "it is" : "they are"}.`
            : `Gridcheck's own files, ${plural(counts.added, "file")}. The folder isn't there yet.` })),
        h("span", { className: `pv-pill ${row.exists ? "k-change" : "k-add"}`, text: row.exists ? "Existing folder" : "New folder" })),
      folderTotal(row) ? bar : null,
      h("div", { className: "pv-groups" },
        group("added", "New files", "nothing is there now, so nothing is overwritten"),
        group("changed", "Existing files that change", "overwritten with this version"),
        group("removed", "Files removed", "deleted: they're no longer part of Gridcheck")));
  }

  // Says first whether the update only adds files or changes ones already there.
  function vendorCallout(p) {
    const changes = summaryOf(p).changes;
    const folder = changes.find((row) => row.kind === "folder");
    const shim = changes.find((row) => row.role === "shim");
    if (!folder) return null;
    const existing = folder.counts.changed + folder.counts.removed + (shim && shim.exists && shim.change !== "none" ? 1 : 0);
    const added = folder.counts.added + (shim && !shim.exists ? 1 : 0);
    if (!existing && !added) return h("div", { className: "pv-callout k-same" }, icon("check"), h("span", { text: "The copy already matches this version. Nothing would change." }));
    if (!existing) {
      return h("div", { className: "pv-callout k-add" }, icon("check"),
        h("span", {}, h("b", { text: `Only adds ${plural(added, "new file")}.` }), " Nothing that's already there is changed."));
    }
    return h("div", { className: "pv-callout k-change" }, icon("alert"),
      h("span", {}, h("b", { text: `Changes ${plural(existing, "existing file")}` }), added ? ` and adds ${plural(added, "new file")}.` : ".",
        " Edits made by hand to those files would be lost."));
  }

  function checkRow(check) {
    const rows = {
      "server-stopped": ["ok", "check", ["The server is stopped."]],
      "server-up-ok": ["na", "dash", ["The server is running. That's fine: this doesn't touch the server."]],
      clean: ["ok", "check", ["No uncommitted edits in ", ...codeList(check.files || []), ", so nothing of yours gets overwritten."]],
      "not-git": ["warn", "alert", ["This Eve.js instance isn't a git checkout, so uncommitted edits couldn't be checked."]],
    };
    const [kind, mark, text] = rows[check.kind] || ["na", "dash", [check.kind]];
    return h("li", { className: kind }, h("span", { className: "pv-mark" }, icon(mark)), h("div", {}, text));
  }

  const DOWN_COMMAND = "node tools/gridcheck/bin/gridcheck.js down";

  // What stops a change, how to fix it, and a way to do that where there is one.
  function blockerCard(blocker, index) {
    let title;
    let body;
    let extra = null;
    if (blocker.kind === "server-up") {
      title = "The server is running";
      body = ["Changing these files under a running server can leave it half-updated. ",
        blocker.byGridcheck ? "Gridcheck started it, so " : `Stop it the way you started it (pid ${blocker.pid}), or `,
        ref("cmd", DOWN_COMMAND), blocker.byGridcheck ? " stops it." : " in this Eve.js instance's folder.", " Then preview again."];
    } else if (blocker.kind === "dirty") {
      const files = blocker.files || [];
      title = files.length === 1 ? "A file it changes has uncommitted edits" : `${files.length} files it changes have uncommitted edits`;
      body = ["Commit or discard them first, so this change doesn't get mixed up with your own work."];
      extra = h("ul", { className: "pv-dirty" }, files.slice(0, 10).map((file) => h("li", {}, ref("path", file))),
        files.length > 10 ? h("li", { className: "muted", text: `... and ${files.length - 10} more` }) : null);
    } else if (blocker.kind === "no-dry-run") {
      title = "This copy is too old to preview this";
      body = [blocker.text];
      extra = h("div", { className: "pv-acts" }, h("button", { type: "button", className: "btn sm", text: "Open the Install tab",
        onclick: () => { $("preview").close(); showTab("install"); } }));
    } else if (blocker.kind === "failed") {
      title = "The preview didn't finish";
      body = [ref("cmd", blocker.command), ` stopped with exit code ${blocker.exitCode}. Its output, under Technical details, says why.`];
    } else {
      title = "It would be refused";
      body = [blocker.text];
    }
    return h("div", { className: "pv-blocker" }, h("span", { className: "pv-n", text: String(index + 1) }),
      h("div", { className: "pv-grow" }, h("h5", { text: title }), h("p", {}, body), extra));
  }

  // The steps an agent needs once its config is written, from the CLI's "next," lines.
  function nextSteps(summary, root) {
    const folder = () => ref("path", root || "this Eve.js instance's folder", { dir: true });
    return summary.next.map(({ who, text }) => {
      if (who === "Claude Code") return ["Open Claude Code in ", folder(), ". It asks once whether to use the project's MCP server: approve it."];
      if (who === "Codex") return ["Start a new Codex session. The server is in every Codex session, and names this Eve.js instance by its path."];
      if (who === "any other agent") return ["Start the agent in ", folder(), ". It reads the pointer and follows the CLI guide."];
      return [`${who}: ${text}`];
    });
  }

  function nextList(items) {
    return h("ol", { className: "pv-next" }, items.map((item) => h("li", {}, h("div", {}, item))));
  }

  function techDetails(steps, { open = false, ran = false } = {}) {
    return h("details", { className: "pv-tech", open: open || null },
      h("summary", {}, "Technical details", h("span", { className: "dim", text: ran ? ": the commands and their output" : ": the command, where it runs, and its dry run's output" })),
      steps.map((step) => h("div", { className: "step-block" },
        h("div", { className: "command", text: step.command }),
        h("div", { className: `exit${step.exitCode === 0 ? "" : " bad"}`, text: ran
          ? `exit ${step.exitCode}, ${Math.round((step.ms || 0) / 100) / 10} s`
          : `in ${step.cwd}. Its dry run (${step.dryRun}) ${step.exitCode === 0 ? "printed" : `exited ${step.exitCode}:`}` }),
        outputPre(step.output))));
  }

  function previewHead(words, root, { kind = "", source = null } = {}) {
    $("preview-title").textContent = words.title;
    $("preview-glyph").className = `pv-glyph ${kind}`;
    $("preview-glyph").replaceChildren(icon(words.icon));
    const tree = currentTree();
    const where = root || (tree ? tree.root : "");
    $("preview-where").replaceChildren(
      where ? h("span", { className: `pv-tree${tree && tree.up ? " live" : ""}`, title: tree && tree.up ? "its server is running" : null, text: where }) : "",
      source ? h("span", { className: "pv-source" }, `${source.name} ${source.version} ${source.at}`, h("span", { className: "dim", text: ` from ${source.from}` })) : "");
  }

  function previewFooter({ run = null, enabled = false, again = false, close = "Cancel", done = false } = {}) {
    $("preview-run").hidden = !run;
    $("preview-run").textContent = run || "Run";
    $("preview-run").disabled = !enabled;
    $("preview-again").hidden = !again;
    $("preview-close").textContent = close;
    $("preview-close").className = `btn${done ? " primary" : " ghost"}`;
  }

  function previewBody(request, p, words) {
    const summary = summaryOf(p);
    const nothing = nothingToDo(p);
    // With nothing to write, what would block the write doesn't matter.
    const blockers = nothing ? [] : p.blockers || [];
    const parts = [];
    if (words.lede) parts.push(h("p", { className: "pv-lede", text: words.lede }));
    if (nothing) {
      parts.push(statusLine("info", "info", "Nothing to change.", "It's already set up this way."));
    } else if (blockers.length) {
      parts.push(statusLine("bad", blockers.length, blockers.length === 1 ? "Can't run yet: one thing to fix first." : `Can't run yet: ${blockers.length} things to fix first.`,
        "Nothing was changed."));
      parts.push(h("div", { className: "pv-sec" }, blockers.map(blockerCard)));
    } else if (!p.ok) {
      parts.push(statusLine("bad", "x", "Can't run.", (p.refused || []).join("; ")));
    } else {
      parts.push(statusLine("ok", "check", "Preview passed.", "Nothing has been written yet."));
    }
    if (summary.changes.length) {
      const count = fileCount(p);
      const cards = summary.changes.map((row) => (row.kind === "folder" ? folderCard(row) : fileCard(row, request.action)));
      const changes = section(nothing ? "Already in place" : blockers.length ? "What it would change" : "What changes", count ? plural(count, "file") : null,
        request.action === "vendor" ? vendorCallout(p) : null, cards);
      if (blockers.length) changes.classList.add("pv-dim");
      parts.push(changes);
    }
    const notes = summary.notes.filter((text) => !/isn't a git checkout/.test(text));
    if (notes.length) parts.push(section("Also", null, h("ul", { className: "pv-notes" }, notes.map((text) => h("li", { text })))));
    if ((p.checks || []).length) parts.push(section("Checked before showing this", null, h("ul", { className: "pv-checks" }, p.checks.map(checkRow))));
    if (p.ok && summary.next.length) parts.push(section("After this", null, nextList(nextSteps(summary, p.root))));
    parts.push(techDetails(p.steps || [], { open: !summary.changes.length || blockers.some((row) => row.kind === "failed") }));
    return parts;
  }

  function footNote(request, p) {
    if (request.action === "setup") return "Stops at the first step that fails. The preview stays valid for 10 minutes.";
    const count = fileCount(p);
    return `${count ? `Writes ${plural(count, "file")}. ` : ""}The preview stays valid for 10 minutes.`;
  }

  // The finished change in a sentence, from what the preview said it would do.
  function doneHeadline(request, p) {
    const changed = writes(p);
    if (request.action === "agents" && changed.length) {
      return changed.length === 1
        ? `${changed[0].change === "replace" ? "Replaced the" : "Added"} ${changed[0].entry}${changed[0].change === "replace" ? " entry in" : " to"} ${baseName(changed[0].path)}`
        : `Wrote ${andList(changed.map((row) => baseName(row.path)))}`;
    }
    const folder = summaryOf(p).changes.find((row) => row.kind === "folder");
    if (request.action === "vendor" && folder) {
      return folder.exists
        ? `Updated tools/gridcheck/: ${folder.counts.changed} changed, ${folder.counts.added} new, ${folder.counts.removed} removed`
        : `Copied Gridcheck into tools/gridcheck/ (${plural(folder.counts.added, "file")})`;
    }
    return successText(request)[0];
  }

  function doneNext(request, p, result) {
    const output = result.steps.map((step) => step.output || "").join("\n");
    if (request.action === "agents") return nextSteps(summaryOf(p), p.root);
    const commit = /^\s+commit (.+)$/m.exec(output);
    if (request.action === "vendor" && commit) return [[`Commit ${commit[1]}, so git tracks the copy.`]];
    const next = /^next: (.+)$/m.exec(output);
    if (request.action === "init" && next) return [[capital(next[1])]];
    return [];
  }

  function undoHint(request, p) {
    const changed = writes(p);
    if (request.action === "agents" && changed.length === 1 && changed[0].change === "add" && changed[0].agent !== "CLI only") {
      return `To undo, remove the ${changed[0].entry} entry from ${baseName(changed[0].path)}.`;
    }
    if (request.action === "patch-apply") return "To undo, use Preview revert on the Patches tab.";
    return "";
  }

  // Trees installed with Install rather than full setup, remembered in this browser.
  const HAND_KEY = "gridcheckInstalledByHand";
  function installedByHand(id) {
    try {
      return JSON.parse(localStorage.getItem(HAND_KEY) || "[]").includes(id);
    } catch (_error) {
      return false;
    }
  }
  function markInstalledByHand(id) {
    try {
      const ids = JSON.parse(localStorage.getItem(HAND_KEY) || "[]");
      if (!ids.includes(id)) localStorage.setItem(HAND_KEY, JSON.stringify([...ids, id].slice(-50)));
    } catch (_error) {
      // Private mode or storage off: the button just stays.
    }
  }

  // What a finished action did, in a sentence or two; the log only shows when it fails.
  function successText(request) {
    const tree = state.trees.find((row) => row.id === state.treeID);
    const where = tree ? tree.root : "the Eve.js instance";
    switch (request.action) {
      case "vendor": return [`Gridcheck was copied into ${where}/tools/gridcheck/,`, "and the bridge shim the server loads was installed."];
      case "setup": return ["Full setup finished.", `Every step ran or was already done in ${where}.`];
      case "init": return [`Wrote ${where}/gridcheck.config.json.`];
      case "agents": return ["Set up the agents you picked for this Eve.js instance."];
      case "patch-apply": return [`Applied the ${request.id} patch.`];
      case "patch-revert": return [`Reverted the ${request.id} patch.`, "The files are back as they were."];
      default: return ["Done."];
    }
  }

  async function preview(request) {
    state.previewRequest = request;
    state.previewData = null;
    state.preview = null;
    const dialog = $("preview");
    const pending = previewWords(request, null);
    previewHead(pending, null);
    $("preview-steps").replaceChildren(h("p", { className: "pv-lede muted", text: "Checking what this would do, without changing anything..." }));
    $("preview-note").textContent = "";
    previewFooter({ run: pending.run });
    if (!dialog.open) dialog.showModal();
    try {
      const body = await api("/gui/api/preview", { method: "POST", body: { tree: state.treeID, ...request } });
      const p = body.preview;
      state.previewData = p;
      const words = previewWords(request, p);
      const nothing = nothingToDo(p);
      const blocked = !nothing && ((p.blockers || []).length > 0 || !p.ok);
      previewHead(words, p.root, { kind: blocked ? "bad" : "", source: summaryOf(p).source });
      $("preview-steps").replaceChildren(...previewBody(request, p, words));
      state.preview = p.ok && !nothing ? p.previewID : null;
      if (blocked) previewFooter({ again: true, close: "Close" });
      else if (nothing) previewFooter({ close: "Close", done: true });
      else previewFooter({ run: words.run, enabled: true });
      $("preview-note").textContent = blocked ? "Nothing was changed." : nothing ? "" : footNote(request, p);
    } catch (error) {
      $("preview-note").textContent = error.message;
      previewFooter({ again: true, close: "Close" });
    }
  }

  async function runPreview() {
    if (!state.preview) return;
    const id = state.preview;
    state.preview = null;
    const request = state.previewRequest || {};
    const p = state.previewData || { root: "", summary: { changes: [], next: [], notes: [] } };
    const words = previewWords(request, p);
    $("preview-run").disabled = true;
    $("preview-run").textContent = "Running...";
    $("preview-note").textContent = request.action === "setup" ? "Running. A first setup can take several minutes." : "Running...";
    try {
      const body = await api("/gui/api/run", { method: "POST", body: { previewID: id } });
      const result = body.result;
      const seconds = Math.round(result.steps.reduce((sum, step) => sum + (step.ms || 0), 0) / 100) / 10;
      if (result.ok) {
        if (request.action === "vendor" && state.treeID) markInstalledByHand(state.treeID);
        previewHead({ ...words, icon: "check", title: words.done }, p.root, { kind: "ok" });
        const next = doneNext(request, p, result);
        const tryIt = request.action === "agents" && (request.agents || []).some((agent) => agent !== "cli");
        $("preview-steps").replaceChildren(
          h("div", { className: "success" },
            h("span", { className: "success-mark" }, icon("check")),
            h("div", {}, h("h3", { text: doneHeadline(request, p) }), h("p", { text: `Took ${seconds} s.` }))),
          next.length ? h("div", { className: "pv-handoff" },
            h("div", { className: "pv-sec-h", text: next.length === 1 ? "One more step" : "Next" }), nextList(next),
            tryIt ? h("p", { className: "pv-try" }, "Then ask it something like ",
              h("q", { text: "Run the loadout-npc-fight scenario and tell me what happened." })) : null) : null,
          techDetails(result.steps, { ran: true }));
        previewFooter({ close: "Done", done: true });
        $("preview-note").textContent = undoHint(request, p);
      } else {
        previewHead({ ...words, icon: "bang" }, p.root, { kind: "bad" });
        $("preview-steps").replaceChildren(
          statusLine("bad", "x", result.refused.length ? "It was refused when it came to run." : "It didn't finish.",
            result.refused.length ? "Nothing was changed." : "The output below says why."),
          result.refused.length ? h("div", { className: "pv-sec" }, result.refused.map((text, index) => blockerCard({ kind: "other", text }, index))) : null,
          techDetails(result.steps, { open: true, ran: true }));
        previewFooter({ again: true, close: "Close" });
        $("preview-note").textContent = "";
      }
      message(result.ok ? "done" : "the command failed", result.ok);
    } catch (error) {
      $("preview-note").textContent = error.message;
      previewFooter({ again: true, close: "Close" });
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
    // A click on a reference copies it, and doesn't open the row it sits in.
    document.addEventListener("click", (event) => {
      const node = event.target.closest && event.target.closest("[data-copy]");
      if (!node) return;
      event.preventDefault();
      event.stopPropagation();
      copyText(node.dataset.copy);
    }, true);
    wirePicker();
    $("install-refresh").addEventListener("click", () => loadInstall().catch((error) => message(error.message)));
    $("patches-refresh").addEventListener("click", () => loadPatches().catch((error) => message(error.message)));
    $("add-tree").addEventListener("submit", addTree);
    $("add-browse").addEventListener("click", openBrowse);
    $("onboard-browse").addEventListener("click", openBrowse);
    $("browse-go").addEventListener("submit", (event) => {
      event.preventDefault();
      browseTo($("browse-path").value);
    });
    $("browse-up").addEventListener("click", () => { if (browser.parent) browseTo(browser.parent); });
    $("browse-add").addEventListener("click", () => { if (browser.tree) addFromBrowse(browser.path); });
    $("browse-close").addEventListener("click", () => $("browse").close());
    $("trees-filter").addEventListener("input", () => {
      state.treeFilter = $("trees-filter").value;
      renderTreeCards();
    });
    $("preview-run").addEventListener("click", runPreview);
    $("preview-close").addEventListener("click", () => $("preview").close());
    $("preview-again").addEventListener("click", () => { if (state.previewRequest) preview(state.previewRequest); });
    $("frame-close").addEventListener("click", () => $("frame-view").close());
    $("frame-seek").addEventListener("click", () => {
      if (state.frameSeek) state.frameSeek();
      $("frame-view").close();
    });
  }

  async function start() {
    wire();
    runs = window.E2ERuns.create(shell);
    commands = window.E2ECommands.create(shell);
    if (!token) {
      message("no token: open the URL gridcheck gui prints");
      return;
    }
    try {
      await loadContext();
      await loadTrees();
    } catch (error) {
      message(error.message);
      return;
    }
    // With no tree, every other tab is empty; Install is where you add one.
    if (!state.trees.length) state.tab = "install";
    showTab(state.tab);
    loadSummary().catch(() => {});
    countPatches();
    setInterval(() => {
      if (!document.hidden && !$("preview").open && $("tree-list").hidden) loadTrees().catch(() => {});
    }, 30_000);
  }

  start();
})();
