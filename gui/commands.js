"use strict";

// The Commands tab: every command the tree's copy of gridcheck has, grouped, with its
// usage, what it does and its tags; open one for its flags and examples. The
// list is the copy's own `gridcheck help --json` (core/commandDocs.js), read through
// GET /gui/api/commands. Built with textContent, like the rest of the page.

(() => {
  const GROUP_ICONS = { setup: "wrench", worlds: "globe", server: "power", ship: "ship", watch: "eye", scenarios: "target", tool: "box" };
  const FILTERS = [["all", "All"], ["now", "Works now"], ["mcp", "Agents have it"], ["writes", "Changes the Eve.js instance"]];

  function create(shell) {
    const { h, icon, api } = shell;
    const $ = (id) => document.getElementById(id);
    const cache = new Map();
    const state = { filter: "", show: "all", data: null };

    // treeID -> a promise of the catalog, so the Install tab's agent pane and
    // this tab read it once.
    function catalog(treeID) {
      if (!cache.has(treeID)) {
        cache.set(treeID, api(`/gui/api/commands?tree=${encodeURIComponent(treeID)}`).then((body) => body.commands).catch((error) => {
          cache.delete(treeID);
          throw error;
        }));
      }
      return cache.get(treeID);
    }

    async function load({ fresh = false } = {}) {
      const id = shell.treeID();
      if (!id) return;
      if (fresh) cache.delete(id);
      if (!state.data || state.data.treeID !== id) {
        $("cm-groups").textContent = "";
        $("cm-empty").hidden = false;
        $("cm-empty").textContent = "reading the Eve.js instance's commands...";
      }
      const data = await catalog(id);
      if (id !== shell.treeID()) return;
      state.data = { ...data, treeID: id };
      shell.setCount("commands", data.commands.length);
      render();
    }

    const groupClass = (group) => (group.plugin ? "g-plugin" : `g-${group.id}`);
    const groupIcon = (group) => (group.plugin ? "puzzle" : GROUP_ICONS[group.id] || "list");

    // A usage line with the command in amber, flags in pink, <arguments> in teal
    // and the brackets dim.
    function syntax(line, name) {
      const out = [];
      const rest = line.startsWith(name) ? line.slice(name.length) : line;
      if (rest !== line) out.push(h("span", { className: "s", text: name }));
      const tokens = rest.match(/--[\w-]+|<[^>]+>|[[\]|]|[^\s[\]|<]+|\s+/g) || [];
      for (const token of tokens) {
        if (/^\s+$/.test(token)) out.push(token);
        else if (token.startsWith("--")) out.push(h("span", { className: "f", text: token }));
        else if (token.startsWith("<")) out.push(h("span", { className: "a", text: token }));
        else if (/^[[\]|]$/.test(token)) out.push(h("span", { className: "o", text: token }));
        else out.push(token);
      }
      return out;
    }

    function tagsOf(command) {
      return [
        command.needs === "up" ? h("span", { className: "tg up", text: "server up" }) : null,
        command.needs === "down" ? h("span", { className: "tg down", text: "server down" }) : null,
        command.managed ? h("span", { className: "tg mode", text: "auto · managed" }) : null,
        command.writes ? h("span", { className: "tg write", text: "writes files" }) : null,
        command.mcp ? h("span", { className: "tg mcp", text: "MCP", title: `agents have ${command.mcp}` }) : null,
      ];
    }

    // Whether a command can run in the tree as it is now.
    function worksNow(command) {
      const summary = shell.summary();
      if (!summary) return true;
      const up = Boolean(summary.serverUp);
      const mode = summary.config && summary.config.exists ? summary.config.mode : null;
      if (command.needs === "up" && !up) return false;
      if (command.needs === "down" && up) return false;
      if (command.managed && mode === "attach") return false;
      return true;
    }

    function matches(command) {
      if (state.show === "now" && !worksNow(command)) return false;
      if (state.show === "mcp" && !command.mcp) return false;
      if (state.show === "writes" && !command.writes) return false;
      const needle = state.filter.trim().toLowerCase();
      if (!needle) return true;
      const text = [command.name, command.summary, ...command.usage, ...command.flags.map((flag) => `${flag.flag} ${flag.text}`)].join("\n").toLowerCase();
      return text.includes(needle);
    }

    // `act <approach|orbit|...>`: a choice of four or more, shown as chips.
    function choices(command) {
      for (const line of command.usage) {
        const found = /<([a-zA-Z]+(?:\|[a-zA-Z]+){3,})>/.exec(line);
        if (found) return found[1].split("|");
      }
      return null;
    }

    function item(command, prefix) {
      const full = `${prefix} ${command.name}`;
      const copy = h("button", { type: "button", className: "cm-copy", title: `Copy ${full}`, "aria-label": `Copy ${full}`, "data-copy": full }, icon("copy", "sm"));
      const summary = h("summary", {},
        h("span", { className: "cm-name" }, icon("chev", "xs"), command.name),
        h("div", { className: "cm-desc" }, command.summary ? command.summary : h("span", { className: "undoc", text: "No description yet." }),
          h("small", { className: "syn" }, syntax(command.usage[0] || command.name, command.name.split(" ")[0]))),
        h("span", { className: "cm-tags" }, tagsOf(command)),
        copy);
      const node = h("details", { className: "cm-item", id: `cm-${command.name.replace(/[^a-z0-9]+/gi, "-")}` }, summary);
      node.addEventListener("toggle", () => {
        if (!node.open || node.querySelector(".cm-detail")) return;
        const options = choices(command);
        node.append(h("div", { className: "cm-detail" },
          command.usage.map((line) => h("div", { className: "cm-syn" }, h("span", { className: "tline syn" }, syntax(line, command.name.split(" ")[0])))),
          options ? h("div", {}, h("span", { className: "lbl", text: "Choices" })) : null,
          options ? h("div", { className: "cm-acts" }, options.map((name) => h("span", { text: name }))) : null,
          command.flags.length ? h("table", { className: "cm-flags" },
            h("thead", {}, h("tr", {}, h("th", { text: "Flag" }), h("th", { text: "Default" }), h("th", { text: "What it does" }))),
            h("tbody", {}, command.flags.map((flag) => h("tr", {}, h("td", { text: flag.flag }), h("td", { className: "def", text: flag.default || "-" }),
              h("td", { text: flag.text }))))) : null,
          command.examples.length ? h("div", { className: "cm-ex" }, command.examples.map((example) => h("div", {},
            h("code", { text: example.command }), example.note ? h("span", { text: example.note }) : null))) : null,
          command.note ? h("div", { className: "cm-note" }, icon("alert", "sm"), h("span", { text: command.note })) : null,
          command.mcp ? h("p", { className: "muted" }, "Agents do the same with ", shell.ref("tool", command.mcp), ".") : null));
      });
      return node;
    }

    function render() {
      const data = state.data;
      if (!data) return;
      const summary = shell.summary();
      $("cm-source").textContent = data.source === "tree" ? `${data.command}` : "this page's own gridcheck";
      const lede = $("cm-lede");
      lede.textContent = "";
      lede.append("Everything gridcheck can do in this Eve.js instance. Run each from ", summary ? shell.ref("path", summary.root, { dir: true }) : "the Eve.js instance's folder",
        " as ", shell.ref("cmd", `${data.prefix} <command>`, { copy: false }), ". Open a row for its flags and examples.");
      $("cm-note").hidden = !data.note;
      $("cm-note").textContent = data.note || "";

      const filters = $("cm-filters");
      filters.textContent = "";
      for (const [id, label] of FILTERS) {
        filters.append(h("button", { type: "button", className: "fchip", "aria-pressed": String(state.show === id),
          title: id === "now" ? "With the server as it is now, and the Eve.js instance's mode" : null,
          onclick: () => { state.show = id; render(); } }, label));
      }

      const shown = data.commands.filter(matches);
      const nav = $("cm-nav");
      nav.textContent = "";
      const groups = $("cm-groups");
      groups.textContent = "";
      let plugins = false;
      for (const group of data.groups) {
        const rows = shown.filter((command) => command.group === group.id);
        const total = data.commands.filter((command) => command.group === group.id).length;
        if (group.plugin && !plugins) {
          nav.append(h("hr"));
          plugins = true;
        }
        const anchor = `cmg-${group.id.replace(/[^a-z0-9]+/gi, "-")}`;
        nav.append(h("button", { type: "button", className: groupClass(group), disabled: !rows.length,
          onclick: (event) => {
            for (const button of nav.querySelectorAll("button")) button.classList.toggle("on", button === event.currentTarget);
            $(anchor).scrollIntoView({ behavior: "smooth", block: "start" });
          } }, h("span", { className: `gic ${groupClass(group)}` }, icon(groupIcon(group))), group.title,
          h("span", { className: "ct", text: rows.length === total ? String(total) : `${rows.length}/${total}` })));
        if (!rows.length) continue;
        groups.append(h("div", { className: "cm-group", id: anchor },
          h("div", { className: "cm-gh" }, h("span", { className: `gic ${groupClass(group)}` }, icon(groupIcon(group))),
            h("div", {}, h("h2", { text: group.title }), h("p", { text: group.text })),
            h("span", { className: "ct", text: `${rows.length} ${rows.length === 1 ? "command" : "commands"}` })),
          h("div", { className: "cm-list" }, rows.map((command) => item(command, data.prefix)))));
      }
      $("cm-empty").hidden = shown.length > 0;
      $("cm-empty").textContent = shown.length ? "" : "No command matches.";
    }

    $("cm-filter").addEventListener("input", () => {
      state.filter = $("cm-filter").value;
      render();
    });
    $("cm-refresh").addEventListener("click", () => load({ fresh: true }).catch((error) => shell.message(error.message)));
    $("cm-prefix").addEventListener("click", () => {
      if (state.data) shell.copyText(state.data.prefix);
    });

    return { load, catalog };
  }

  window.E2ECommands = { create };
})();
