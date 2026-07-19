import { describe, it } from "node:test";
import { equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function context({ mobile = false, preference = null } = {}) {
  const links = [];
  const scripts = [];
  let mediaListener = null;
  let reloads = 0;
  let matches = mobile;
  const storage = new Map(preference ? [["herdr-web-layout", preference]] : []);
  const ctx = {
    document: {
      documentElement: { dataset: {} },
      currentScript: { src: "https://127.0.0.1:8787/assets/app-boot.js?v=test-version" },
      head: { appendChild: (node) => links.push(node) },
      body: { appendChild: (node) => scripts.push(node) },
      createElement: (tag) => ({ tag }),
    },
    localStorage: { getItem: (key) => storage.get(key) || null },
    URL,
    window: null,
  };
  ctx.window = {
    location: {
      href: "https://127.0.0.1:8787/",
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

function versioned(paths) {
  return paths.map((path) => `${path}?v=test-version`);
}

describe("app boot", () => {
  const source = readFileSync(
    new URL("./app_boot.js", import.meta.url),
    "utf8",
  );

  it("loads desktop bundle by default on wide screens", () => {
    const { ctx, links, scripts } = context();
    vm.runInContext(source, ctx);
    equal(ctx.document.documentElement.dataset.herdrLayout, "desktop");
    equal(links.map((link) => link.href).join("\n"), versioned([
      "/assets/desktop/app.css",
      "/assets/desktop/git-ui.css",
      "/assets/desktop/file-browser.css",
      "/assets/desktop/shortcuts.css",
      "/assets/desktop/search.css",
      "/assets/shared/colors.css",
      "/assets/shared/file-icons.css",
      "/assets/shared/file-widgets.css",
      "/assets/shared/content-search.css",
    ]).join("\n"));
    equal(scripts.map((script) => script.src).join("\n"), versioned([
      "/assets/shared/core.js",
      "/assets/shared/actions.js",
      "/assets/shared/file-icons.js",
      "/assets/shared/file-tree.js",
      "/assets/shared/line-context.js",
      "/assets/shared/file-content-search.js",
      "/assets/shared/workspace-search.js",
      "/assets/vendor/codemirror.js",
      "/assets/shared/editor.js",
      "/assets/shared/terminal-scroll.js",
      "/assets/shared/terminal-fit.js",
      "/assets/shared/temp-terminal.js",
      "/assets/desktop/search.js",
      "/assets/desktop/directory-picker.js",
      "/assets/desktop/app.js",
    ]).join("\n"));
  });

  it("loads mobile bundle for narrow screens", () => {
    const { ctx, links, scripts } = context({ mobile: true });
    vm.runInContext(source, ctx);
    equal(ctx.document.documentElement.dataset.herdrLayout, "mobile");
    equal(links.map((link) => link.href).join("\n"), versioned([
      "/assets/mobile/app.css",
      "/assets/shared/colors.css",
      "/assets/shared/file-icons.css",
      "/assets/shared/file-widgets.css",
      "/assets/shared/content-search.css",
    ]).join("\n"));
    equal(scripts.map((script) => script.src).join("\n"), versioned([
      "/assets/shared/core.js",
      "/assets/shared/actions.js",
      "/assets/shared/file-icons.js",
      "/assets/shared/file-tree.js",
      "/assets/shared/line-context.js",
      "/assets/shared/file-content-search.js",
      "/assets/shared/workspace-search.js",
      "/assets/vendor/codemirror.js",
      "/assets/shared/editor.js",
      "/assets/shared/terminal-scroll.js",
      "/assets/shared/terminal-fit.js",
      "/assets/shared/temp-terminal.js",
      "/assets/mobile/core.js",
      "/assets/mobile/attention.js",
      "/assets/mobile/terminal.js",
      "/assets/mobile/worktrees.js",
      "/assets/mobile/file-browser.js",
      "/assets/mobile/settings.js",
      "/assets/mobile/app.js",
    ]).join("\n"));
  });

  it("honors explicit desktop override", () => {
    const { ctx, links, scripts } = context({
      mobile: true,
      preference: "desktop",
    });
    vm.runInContext(source, ctx);
    equal(ctx.document.documentElement.dataset.herdrLayout, "desktop");
    equal(links[0].href, "/assets/desktop/app.css?v=test-version");
    equal(scripts[0].src, "/assets/shared/core.js?v=test-version");
  });

  it("reloads to switch layout when auto viewport crosses breakpoint", () => {
    const env = context({ mobile: false });
    vm.runInContext(source, env.ctx);
    equal(env.ctx.document.documentElement.dataset.herdrLayout, "desktop");
    env.setMobile(true);
    env.triggerMediaChange();
    equal(env.reloads(), 1);
  });

  it("does not reload on viewport change with explicit override", () => {
    const env = context({ mobile: false, preference: "desktop" });
    vm.runInContext(source, env.ctx);
    env.setMobile(true);
    env.triggerMediaChange();
    equal(env.reloads(), 0);
  });
});
