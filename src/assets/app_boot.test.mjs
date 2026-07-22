import { describe, it } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SHARED_STYLES = [
  "/assets/shared/colors.css",
  "/assets/vendor/wterm.css",
  "/assets/shared/file-icons.css",
  "/assets/shared/content-search.css",
];
const DESKTOP_STYLES = [
  "/assets/desktop/app.css",
  "/assets/desktop/git-ui.css",
  "/assets/desktop/file-browser.css",
  "/assets/desktop/shortcuts.css",
  "/assets/desktop/search.css",
  ...SHARED_STYLES,
];
const MOBILE_STYLES = ["/assets/mobile/app.css", ...SHARED_STYLES];
const SHARED_SCRIPTS = [
  "/assets/shared/core.js",
  "/assets/shared/actions.js",
  "/assets/shared/file-icons.js",
  "/assets/shared/file-tree.js",
  "/assets/shared/line-context.js",
  "/assets/shared/file-content-search.js",
  "/assets/shared/workspace-search.js",
  "/assets/vendor/codemirror.js",
  "/assets/vendor/wterm.js",
  "/assets/shared/editor.js",
  "/assets/shared/terminal-fit.js",
  "/assets/shared/terminal-adapter.js",
  "/assets/shared/temp-terminal.js",
];
const DESKTOP_SCRIPTS = [
  ...SHARED_SCRIPTS,
  "/assets/desktop/search.js",
  "/assets/desktop/directory-picker.js",
  "/assets/desktop/app.js",
];
const MOBILE_SCRIPTS = [
  ...SHARED_SCRIPTS,
  "/assets/mobile/core.js",
  "/assets/mobile/attention.js",
  "/assets/mobile/terminal.js",
  "/assets/mobile/worktrees.js",
  "/assets/mobile/file-browser.js",
  "/assets/mobile/settings.js",
  "/assets/mobile/app.js",
];

function context({ mobile = false, preference = null, storageThrows = false } = {}) {
  const links = [];
  const scripts = [];
  let mediaListener = null;
  let reloads = 0;
  let matches = mobile;
  const storage = new Map(preference ? [["herdr-web-layout", preference]] : []);
  const ctx = {
    document: {
      documentElement: { dataset: {} },
      head: { appendChild: (node) => links.push(node) },
      body: { appendChild: (node) => scripts.push(node) },
      createElement: (tag) => ({ tag }),
    },
    localStorage: {
      getItem: (key) => {
        if (storageThrows) throw new Error("storage unavailable");
        return storage.get(key) || null;
      },
    },
    window: null,
  };
  ctx.window = {
    location: {
      reload() {
        reloads += 1;
      },
    },
    matchMedia: () => ({
      get matches() {
        return matches;
      },
      addEventListener(_event, listener) {
        mediaListener = listener;
      },
    }),
  };
  return {
    ctx: vm.createContext(ctx),
    links,
    scripts,
    async flushScripts() {
      for (let i = 0; i < 50; i += 1) {
        const script = scripts.find((node) => !node.__loaded);
        if (!script) return;
        script.__loaded = true;
        script.onload && script.onload();
        await Promise.resolve();
      }
      throw new Error("script loader did not settle");
    },
    setMobile(value) {
      matches = value;
    },
    triggerMediaChange() {
      mediaListener && mediaListener();
    },
    reloads() {
      return reloads;
    },
  };
}

function scriptSrcs(scripts) {
  return scripts.map((script) => script.src);
}

function linkHrefs(links) {
  return links.map((link) => link.href);
}

describe("app boot", () => {
  const source = readFileSync(
    new URL("./app_boot.js", import.meta.url),
    "utf8",
  );

  it("loads desktop bundle by default on wide screens", async () => {
    const { ctx, links, scripts, flushScripts } = context();
    vm.runInContext(source, ctx);
    await flushScripts();
    equal(ctx.document.documentElement.dataset.herdrLayout, "desktop");
    deepEqual(linkHrefs(links), DESKTOP_STYLES);
    deepEqual(scriptSrcs(scripts), DESKTOP_SCRIPTS);
  });

  it("loads mobile bundle for narrow screens", async () => {
    const { ctx, links, scripts, flushScripts } = context({ mobile: true });
    vm.runInContext(source, ctx);
    await flushScripts();
    equal(ctx.document.documentElement.dataset.herdrLayout, "mobile");
    deepEqual(linkHrefs(links), MOBILE_STYLES);
    deepEqual(scriptSrcs(scripts), MOBILE_SCRIPTS);
  });

  it("honors explicit desktop override", async () => {
    const { ctx, links, scripts, flushScripts } = context({
      mobile: true,
      preference: "desktop",
    });
    vm.runInContext(source, ctx);
    await flushScripts();
    equal(ctx.document.documentElement.dataset.herdrLayout, "desktop");
    equal(links[0].href, "/assets/desktop/app.css");
    equal(scripts[0].src, "/assets/shared/core.js");
  });

  it("reloads to switch layout when auto viewport crosses breakpoint", async () => {
    const env = context({ mobile: false });
    vm.runInContext(source, env.ctx);
    await env.flushScripts();
    equal(env.ctx.document.documentElement.dataset.herdrLayout, "desktop");
    env.setMobile(true);
    env.triggerMediaChange();
    equal(env.reloads(), 1);
  });

  it("does not reload on viewport change with explicit override", async () => {
    const env = context({ mobile: false, preference: "desktop" });
    vm.runInContext(source, env.ctx);
    await env.flushScripts();
    env.setMobile(true);
    env.triggerMediaChange();
    equal(env.reloads(), 0);
  });

  it("falls back to viewport layout when localStorage is unavailable", async () => {
    const { ctx, scripts, flushScripts } = context({
      mobile: true,
      storageThrows: true,
    });
    vm.runInContext(source, ctx);
    await flushScripts();

    equal(ctx.document.documentElement.dataset.herdrLayout, "mobile");
    deepEqual(scriptSrcs(scripts), MOBILE_SCRIPTS);
  });
});
