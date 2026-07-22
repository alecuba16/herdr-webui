import { describe, it } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
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
      head: { appendChild: (node) => links.push(node) },
      body: { appendChild: (node) => scripts.push(node) },
      createElement: (tag) => ({ tag }),
    },
    localStorage: { getItem: (key) => storage.get(key) || null },
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
    equal(links[0].href, "/assets/desktop/app.css");
    equal(links[1].href, "/assets/desktop/git-ui.css");
    equal(links[2].href, "/assets/desktop/file-browser.css");
    equal(links[3].href, "/assets/desktop/shortcuts.css");
    equal(links[4].href, "/assets/desktop/search.css");
    equal(links[5].href, "/assets/shared/colors.css");
    equal(links[6].href, "/assets/vendor/wterm.css");
    equal(links[7].href, "/assets/shared/file-icons.css");
    equal(links[8].href, "/assets/shared/content-search.css");
    deepEqual(scriptSrcs(scripts), [
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
      "/assets/desktop/search.js",
      "/assets/desktop/directory-picker.js",
      "/assets/desktop/app.js",
    ]);
  });

  it("loads mobile bundle for narrow screens", async () => {
    const { ctx, links, scripts, flushScripts } = context({ mobile: true });
    vm.runInContext(source, ctx);
    await flushScripts();
    equal(ctx.document.documentElement.dataset.herdrLayout, "mobile");
    equal(links[0].href, "/assets/mobile/app.css");
    equal(links[1].href, "/assets/shared/colors.css");
    equal(links[2].href, "/assets/vendor/wterm.css");
    equal(links[3].href, "/assets/shared/file-icons.css");
    equal(links[4].href, "/assets/shared/content-search.css");
    deepEqual(scriptSrcs(scripts), [
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
      "/assets/mobile/core.js",
      "/assets/mobile/attention.js",
      "/assets/mobile/terminal.js",
      "/assets/mobile/worktrees.js",
      "/assets/mobile/file-browser.js",
      "/assets/mobile/settings.js",
      "/assets/mobile/app.js",
    ]);
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
});
