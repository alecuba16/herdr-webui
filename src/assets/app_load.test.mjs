import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function element(id = "") {
  return {
    id,
    classList: {
      add() {},
      contains() {
        return false;
      },
      toggle() {},
    },
    style: { setProperty() {} },
    dataset: {},
    value: "",
    checked: false,
    focused: false,
    selected: false,
    textContent: "",
    innerHTML: "",
    title: "",
    closest() {
      return this;
    },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild() {},
    replaceWith() {},
    remove() {},
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
    addEventListener() {},
    getBoundingClientRect() {
      return { bottom: 100, height: 100, left: 0, top: 0, width: 100 };
    },
    querySelector() {
      return element();
    },
    querySelectorAll() {
      return [];
    },
  };
}

function context() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const localStorage = new Map();
  const ctx = {
    console,
    TextEncoder,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) {
      return 1;
    },
    document: {
      body: getElement("body"),
      title: "",
      createElement: () => element(),
      execCommand: () => true,
      querySelector: () => element(),
      querySelectorAll: () => [],
      getElementById: getElement,
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => localStorage.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    navigator: { clipboard: {} },
    window: null,
    globalThis: null,
    xterm: { Terminal: class {} },
    WebSocket: class {},
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    addEventListener() {},
    prompt: () => null,
    confirm: () => true,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

describe("app bundle load", () => {
  let source;

  beforeEach(() => {
    source =
      readFileSync(new URL("./app_core.js", import.meta.url), "utf8") +
      "\n" +
      readFileSync(new URL("./app.js", import.meta.url), "utf8");
  });

  it("loads without initialization-order ReferenceError", () => {
    doesNotThrow(() => vm.runInContext(source, context()));
  });

  it("renders new workspace modal with folder autocomplete fields", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.workspaceCreateModalHtml();

    match(html, /id="workspaceCreatePath"/);
    match(html, /list="workspacePathOptions"/);
    match(html, /id="workspaceCreateLabel"/);
    match(html, /id="workspaceCreateSubmit"/);
  });

  it("renders server access settings fields", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.serverSettingsHtml();

    match(html, /id="optServerBind"/);
    match(html, /id="optServerUser"/);
    match(html, /id="optServerPassword"/);
    match(html, /id="optServerLocalBypass"/);
    match(html, /id="optNoSleepAutoCooldown"/);
    match(html, /id="serverSettingsApply"/);
    match(html, /<h3>Network access<\/h3>/);
    match(html, /<h3>Power behavior<\/h3>/);
    match(html, /\.config\/herdr-webui\/webui-settings\.json/);
  });

  it("defines grouped settings sections", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /title: "Appearance"/);
    match(source, /title: "Terminal input"/);
    match(source, /title: "Agents and alerts"/);
    match(source, /title: "Worktrees"/);
    match(source, /title: "Server"/);
  });

  it("defines stuck-working dismissal controls", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optWorkingDismissMinutes"/);
    match(source, /id="optStuckWorkingEnabled"/);
    match(source, /id="optAgentSortMode"/);
    match(source, /id="optParentCloseMode"/);
    match(source, /Dismiss/);
    match(source, /herdr-web-working-dismissals/);
    match(source, /displayStatus = dismissed \? "ignored"/);
  });

  it("defines tab activity setting and badge", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optShowTabActivity"/);
    match(source, /tab-activity/);
    match(source, /tabActivityLabel/);
  });

  it("captures terminal paste before xterm native paste", () => {
    match(source, /addEventListener\(\s*"paste"/);
    match(source, /stopImmediatePropagation\(\)/);
    match(source, /pasteToTerminal\(text\)/);
  });

  it("renders no-sleep control options", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.noSleepControlHtml("noSleepTest");

    match(html, /id="noSleepTest"/);
    match(html, /value="off"/);
    match(html, /value="auto"/);
    match(html, /value="1h"/);
    match(html, /value="2h"/);
    match(html, /value="4h"/);
    match(html, /value="infinite"/);
  });

  it("does not duplicate no-sleep control in static header", () => {
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");

    equal(html.includes("noSleepSelect"), false);
  });

  it("handles rejected audio unlock attempts", () => {
    const ctx = context();
    ctx.AudioContext = class {
      resume() {
        return Promise.reject(new Error("blocked"));
      }
    };
    vm.runInContext(source, ctx);

    doesNotThrow(() => ctx.unlockAudio());
  });

  it("requires credentials for non-local server bind", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(
      ctx.serverSettingsValidationError("0.0.0.0:8787", "", "", false),
      "Username and password are required before binding to 0.0.0.0 or any non-local address.",
    );
    equal(ctx.serverSettingsValidationError("0.0.0.0:8787", "user", "pass", false), "");
    equal(ctx.serverSettingsValidationError("0.0.0.0:8787", "user", "", true), "");
    equal(ctx.serverSettingsValidationError("127.0.0.1:8787", "", "", false), "");
  });

  it("renders extracted worktree and shortcut modals", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(ctx.worktreeCreateModalHtml(), /id="worktreeCreateForm"/);
    match(ctx.worktreeCreateModalHtml(), /id="worktreeCreateSubmit"/);
    match(ctx.worktreeOpenModalHtml(), /id="worktreeDiscoverPath"/);
    match(ctx.worktreeOpenModalHtml(), /id="worktreePathOptions"/);
    match(ctx.worktreeOpenModalHtml(), /id="worktreeBranchOptions"/);
    match(ctx.shortcutsModalHtml(), /id="shortcutsModal"/);
    match(ctx.shortcutsModalHtml(), /id="closeShortcutCurrent"/);
  });

  it("prefills workspace label from final folder segment", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value =
      "/Users/me/projects/herdr-webui/";

    ctx.syncWorkspaceCreateLabel();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "herdr-webui");
  });

  it("keeps manually edited workspace label while folder changes", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/first";
    ctx.syncWorkspaceCreateLabel();
    ctx.document.getElementById("workspaceCreateLabel").value = "custom";
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/second";

    ctx.syncWorkspaceCreateLabel();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "custom");
  });

  it("focuses and selects suggested workspace label", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/project";

    ctx.focusWorkspaceCreateLabel();

    const label = ctx.document.getElementById("workspaceCreateLabel");
    equal(label.value, "project");
    equal(label.focused, true);
    equal(label.selected, true);
  });

  it("uses workspace fallback label for empty folder", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.suggestedWorkspaceLabel(""), "workspace");
  });

  it("returns null for stale path suggestion responses", async () => {
    const ctx = context();
    ctx.fetch = async () => {
      const input = ctx.document.getElementById("workspaceCreatePath");
      input.value = "/tmp/b";
      return {
        ok: true,
        status: 200,
        json: async () => ({ suggestions: [{ path: "/tmp/a" }] }),
      };
    };
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/a";

    const suggestions = await ctx.loadDirectoryPathSuggestions("workspaceCreatePath");

    equal(suggestions, null);
  });

  it("updates datalist for fresh path suggestions", async () => {
    const ctx = context();
    ctx.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ suggestions: [{ label: "project", path: "/tmp/project" }] }),
    });
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp";

    const suggestions = await ctx.loadDirectoryPathSuggestions(
      "workspaceCreatePath",
      (items) => ctx.syncDirectoryPathOptions("workspacePathOptions", items),
    );

    equal(suggestions.length, 1);
    ok(ctx.document.getElementById("workspacePathOptions").innerHTML.includes("/tmp/project"));
  });
});
