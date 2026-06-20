import { describe, it } from "node:test";
import { equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function context({ mobile = false, preference = null } = {}) {
  const links = [];
  const scripts = [];
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
    matchMedia: () => ({ matches: mobile }),
  };
  return { ctx: vm.createContext(ctx), links, scripts };
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
    equal(links[0].href, "/assets/app.css");
    equal(scripts[0].src, "/assets/app.js");
  });

  it("loads mobile bundle for narrow screens", () => {
    const { ctx, links, scripts } = context({ mobile: true });
    vm.runInContext(source, ctx);
    equal(ctx.document.documentElement.dataset.herdrLayout, "mobile");
    equal(links[0].href, "/assets/mobile.css");
    equal(scripts[0].src, "/assets/mobile-core.js");
    equal(scripts[1].src, "/assets/mobile-terminal.js");
    equal(scripts[2].src, "/assets/mobile-worktrees.js");
    equal(scripts[3].src, "/assets/mobile-settings.js");
    equal(scripts[4].src, "/assets/mobile.js");
  });

  it("honors explicit desktop override", () => {
    const { ctx, links, scripts } = context({
      mobile: true,
      preference: "desktop",
    });
    vm.runInContext(source, ctx);
    equal(ctx.document.documentElement.dataset.herdrLayout, "desktop");
    equal(links[0].href, "/assets/app.css");
    equal(scripts[0].src, "/assets/app.js");
  });
});
