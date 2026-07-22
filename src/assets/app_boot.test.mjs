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

describe("app boot", () => {
  const source = readFileSync(
    new URL("./app_boot.js", import.meta.url),
    "utf8",
  );

  it("loads desktop bundle by default on wide screens", () => {
    const { ctx, links, scripts } = context();
    vm.runInContext(source, ctx);
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
    equal(scripts[0].src, "/assets/shared/core.js");
    equal(scripts[1].src, "/assets/shared/actions.js");
    equal(scripts[2].src, "/assets/shared/file-icons.js");
    equal(scripts[3].src, "/assets/shared/file-tree.js");
    equal(scripts[4].src, "/assets/shared/line-context.js");
    equal(scripts[5].src, "/assets/shared/file-content-search.js");
    equal(scripts[6].src, "/assets/shared/workspace-search.js");
    equal(scripts[7].src, "/assets/vendor/codemirror.js");
    equal(scripts[8].src, "/assets/vendor/wterm.js");
    equal(scripts[9].src, "/assets/shared/editor.js");
    equal(scripts[10].src, "/assets/shared/terminal-scroll.js");
    equal(scripts[11].src, "/assets/shared/terminal-fit.js");
    equal(scripts[12].src, "/assets/shared/terminal-adapter.js");
    equal(scripts[13].src, "/assets/shared/temp-terminal.js");
    equal(scripts[14].src, "/assets/desktop/search.js");
    equal(scripts[15].src, "/assets/desktop/directory-picker.js");
    equal(scripts[16].src, "/assets/desktop/app.js");
  });

  it("loads mobile bundle for narrow screens", () => {
    const { ctx, links, scripts } = context({ mobile: true });
    vm.runInContext(source, ctx);
    equal(ctx.document.documentElement.dataset.herdrLayout, "mobile");
    equal(links[0].href, "/assets/mobile/app.css");
    equal(links[1].href, "/assets/shared/colors.css");
    equal(links[2].href, "/assets/vendor/wterm.css");
    equal(links[3].href, "/assets/shared/file-icons.css");
    equal(links[4].href, "/assets/shared/content-search.css");
    equal(scripts[0].src, "/assets/shared/core.js");
    equal(scripts[1].src, "/assets/shared/actions.js");
    equal(scripts[2].src, "/assets/shared/file-icons.js");
    equal(scripts[3].src, "/assets/shared/file-tree.js");
    equal(scripts[4].src, "/assets/shared/line-context.js");
    equal(scripts[5].src, "/assets/shared/file-content-search.js");
    equal(scripts[6].src, "/assets/shared/workspace-search.js");
    equal(scripts[7].src, "/assets/vendor/codemirror.js");
    equal(scripts[8].src, "/assets/vendor/wterm.js");
    equal(scripts[9].src, "/assets/shared/editor.js");
    equal(scripts[10].src, "/assets/shared/terminal-scroll.js");
    equal(scripts[11].src, "/assets/shared/terminal-fit.js");
    equal(scripts[12].src, "/assets/shared/terminal-adapter.js");
    equal(scripts[13].src, "/assets/shared/temp-terminal.js");
    equal(scripts[14].src, "/assets/mobile/core.js");
    equal(scripts[15].src, "/assets/mobile/attention.js");
    equal(scripts[16].src, "/assets/mobile/terminal.js");
    equal(scripts[17].src, "/assets/mobile/worktrees.js");
    equal(scripts[18].src, "/assets/mobile/file-browser.js");
    equal(scripts[19].src, "/assets/mobile/settings.js");
    equal(scripts[20].src, "/assets/mobile/app.js");
  });

  it("honors explicit desktop override", () => {
    const { ctx, links, scripts } = context({
      mobile: true,
      preference: "desktop",
    });
    vm.runInContext(source, ctx);
    equal(ctx.document.documentElement.dataset.herdrLayout, "desktop");
    equal(links[0].href, "/assets/desktop/app.css");
    equal(scripts[0].src, "/assets/shared/core.js");
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
