import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const {
  resolveTerminalCore,
  resolveTerminalCoreChoice,
} = require("./shared/core.js");

describe("terminal core default (issue: inline images placeholder on wterm)", () => {
  it("defaults to ghostty and keeps wterm as the only alternative", () => {
    assert.equal(resolveTerminalCore(""), "ghostty");
    assert.equal(resolveTerminalCore(undefined), "ghostty");
    assert.equal(resolveTerminalCore(null), "ghostty");
    assert.equal(resolveTerminalCore("wterm"), "wterm");
    assert.equal(resolveTerminalCore("ghostty"), "ghostty");
    assert.equal(resolveTerminalCore("bogus"), "ghostty");
  });

  it("migrates stored wterm blobs to ghostty once, then preserves choices", () => {
    // Pre-migration blob: wterm was the default, so "wterm" here is a
    // default artifact, not an explicit choice.
    assert.equal(resolveTerminalCoreChoice("wterm", false), "ghostty");
    // Missing or invalid values also land on the new default.
    assert.equal(resolveTerminalCoreChoice(undefined, false), "ghostty");
    assert.equal(resolveTerminalCoreChoice("bogus", false), "ghostty");
    assert.equal(resolveTerminalCoreChoice("ghostty", false), "ghostty");

    // Post-migration: every explicit value is preserved verbatim.
    assert.equal(resolveTerminalCoreChoice("wterm", true), "wterm");
    assert.equal(resolveTerminalCoreChoice("ghostty", true), "ghostty");
    assert.equal(resolveTerminalCoreChoice("bogus", true), "ghostty");
  });

  it("desktop defaultOptions and normalizeOptions apply the migration", () => {
    const source = readFileSync(new URL("./desktop/app_js/core.js", import.meta.url), "utf8");
    // defaultOptions uses the shared resolver (default = ghostty).
    assert.match(source, /terminalCore: HerdrAppHelpers\.resolveTerminalCore\(""\)/);
    // normalizeOptions runs the one-time migration and stamps the flag.
    assert.match(source, /resolveTerminalCoreChoice\(/);
    assert.match(source, /terminalCoreGhosttyMigrated = true/);
    // The select lists Ghostty first (new default) with wterm as alternative.
    assert.ok(
      source.indexOf('value="ghostty"') < source.indexOf('value="wterm"'),
      "Ghostty option must come first in the settings select",
    );
  });

  it("desktop bundle migrates a legacy wterm blob on boot and honors explicit re-choice", () => {
    const desktopAppSource = [
      "./desktop/app_js/core.js",
      "./desktop/app_js/workspace_shell.js",
      "./desktop/app_js/panel_switcher.js",
      "./desktop/app_js/render.js",
      "./desktop/app_js/terminal.js",
      "./desktop/app_js/worktrees.js",
      "./desktop/app_js/shortcuts.js",
      "./desktop/app_js/workspace_create.js",
      "./desktop/app_js/bindings.js",
    ]
      .map((p) => readFileSync(new URL(p, import.meta.url), "utf8"))
      .join("\n");
    const bundle =
      readFileSync(new URL("./shared/options.js", import.meta.url), "utf8") + "\n" +
      readFileSync(new URL("./shared/core.js", import.meta.url), "utf8") + "\n" +
      readFileSync(new URL("./shared/actions.js", import.meta.url), "utf8") + "\n" +
      readFileSync(new URL("./shared/terminal_fit.js", import.meta.url), "utf8") + "\n" +
      readFileSync(new URL("./desktop/search.js", import.meta.url), "utf8") + "\n" +
      desktopAppSource;

    function element(id = "") {
      return {
        id,
        classList: {
          add() {},
          remove() {},
          contains() { return false; },
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
        setAttribute(name, value) { this[name] = value; },
        closest() { return this; },
        insertAdjacentHTML() {},
        insertBefore() {},
        appendChild() {},
        replaceWith() {},
        remove() {},
        focus() { this.focused = true; },
        select() { this.selected = true; },
        addEventListener() {},
        getBoundingClientRect() { return { bottom: 100, height: 100, left: 0, top: 0, width: 100 }; },
        querySelector() { return element(); },
        querySelectorAll() { return []; },
      };
    }

    // Shared DOM element map so settings handlers and assertions resolve the
    // same stub elements; the store is shared across reboots.
    const elements = new Map();
    const getElement = (id) => {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    };
    const store = new Map([
      ["herdr-web-options", JSON.stringify({ terminalCore: "wterm" })],
    ]);

    function bootDesktop() {
      const ctx = {
        console,
        TextEncoder,
        URLSearchParams,
        clearTimeout() {},
        setInterval() {},
        setTimeout() { return 1; },
        requestAnimationFrame(fn) { if (typeof fn === "function") fn(); return 1; },
        cancelAnimationFrame() {},
        document: {
          body: getElement("body"),
          documentElement: element("html"),
          title: "",
          createElement: () => element(),
          execCommand: () => true,
          querySelector: () => element(),
          querySelectorAll: () => [],
          getElementById: getElement,
          addEventListener() {},
        },
        localStorage: {
          getItem: (key) => store.get(key) || null,
          setItem: (key, value) => store.set(key, String(value)),
          removeItem: (key) => store.delete(key),
        },
        history: { pushState() {}, replaceState() {} },
        location: { pathname: "/", href: "" },
        navigator: { clipboard: {} },
        window: null,
        globalThis: null,
        WebSocket: class {},
        fetch: async () => ({ status: 200, json: async () => ({}) }),
        addEventListener() {},
        prompt: () => null,
        confirm: () => true,
        alert: () => {},
        showBlocking() {},
        hideBlocking() {},
      };
      ctx.terminal = getElement("terminal");
      ctx.window = ctx;
      ctx.globalThis = ctx;
      vm.createContext(ctx);
      vm.runInContext(bundle, ctx);
      return ctx;
    }

    // Boot normalized the legacy wterm blob to the Ghostty default and the
    // settings select reflects it (applyOptions reads the normalized
    // in-memory options, so the select value is the observable proxy).
    const ctx = bootDesktop();
    ctx.applyOptions();
    assert.equal(
      getElement("optTerminalCore").value,
      "ghostty",
      "legacy default-artifact wterm must migrate to ghostty on boot",
    );

    // The raw blob is only rewritten on the next saveOptions; simulate an
    // explicit wterm re-choice through the settings change handler.
    getElement("optTerminalCore").value = "wterm";
    getElement("optTerminalCore").onchange();
    const saved = JSON.parse(store.get("herdr-web-options"));
    assert.equal(saved.terminalCore, "wterm", "explicit wterm choice is persisted");
    assert.equal(saved.terminalCoreGhosttyMigrated, true, "migration flag is stamped");

    // Re-booting with the flag stamped keeps the explicit wterm choice.
    const rebootCtx = bootDesktop();
    rebootCtx.applyOptions();
    assert.equal(
      getElement("optTerminalCore").value,
      "wterm",
      "explicit wterm re-choice survives reboot",
    );
  });

  it("mobile settings and terminal read the migrated value", () => {
    const settingsSource = readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8");
    assert.match(settingsSource, /resolveTerminalCoreChoice\(/);
    assert.match(settingsSource, /parsed\.terminalCoreGhosttyMigrated = true/);
    const terminalSource = readFileSync(new URL("./mobile/terminal.js", import.meta.url), "utf8");
    assert.match(terminalSource, /resolveTerminalCoreChoice\(/);

    // Mobile bundle executes these modules together; run the real chain in a
    // VM to verify the end-to-end read path against a legacy wterm blob.
    const store = new Map([["herdr-web-options", JSON.stringify({ terminalCore: "wterm" })]]);
    const ctx = {
      console,
      JSON,
      Object,
      Error,
      Map,
      Math,
      globalThis: null,
      window: null,
      addEventListener() {},
      setTimeout(fn) { if (typeof fn === "function") fn(); return 0; },
      clearTimeout() {},
      localStorage: {
        getItem: (key) => store.get(key) || null,
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
      },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(new URL("./shared/core.js", import.meta.url), "utf8"), ctx);
    vm.runInContext(readFileSync(new URL("./shared/options.js", import.meta.url), "utf8"), ctx);
    vm.runInContext(readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8"), ctx);

    const mobileSettings = vm.runInContext(
      "HerdrMobileSettings.create({ api: () => Promise.resolve({}), applyTheme: () => {}, escapeHtml: (v) => String(v), localStorage: { getItem: () => null, setItem: () => {} }, state: {} })",
      ctx,
    );
    // Settings dropdown reflects the migrated default for a legacy wterm blob.
    assert.equal(mobileSettings.terminalCoreValue(), "ghostty");

    // After an explicit re-choice of wterm (which stamps the migration flag),
    // reads keep the explicit choice.
    mobileSettings.setTerminalCore("wterm");
    assert.equal(mobileSettings.terminalCoreValue(), "wterm");
    const stored = JSON.parse(store.get("herdr-web-options"));
    assert.equal(stored.terminalCore, "wterm");
    assert.equal(stored.terminalCoreGhosttyMigrated, true);
  });

  it("temp terminal reads the migrated core and falls back to ghostty", () => {
    const source = readFileSync(new URL("./shared/temp_terminal.js", import.meta.url), "utf8");
    assert.match(source, /resolveTerminalCoreChoice\(/);
    assert.match(source, /return "ghostty";/);
  });
});