import { describe, it } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./shared/markdown_preview.js", import.meta.url), "utf8");

function loadModule() {
  const window = {};
  const document = {
    createElement() {
      return { setAttribute() {}, appendChild() {}, replaceWith() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
    },
    body: { appendChild() {} },
  };
  const localStorage = { getItem() { return null; }, setItem() {} };
  const ctx = { window, document, localStorage, matchMedia: undefined, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx.window.HerdrMarkdownPreview;
}

function loadRenderModule() {
  const scripts = [];
  const links = [];
  let ctx;
  const document = {
    createElement(tag) {
      return { tag, dataset: {}, setAttribute() {}, replaceWith() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
    },
    querySelector() { return null; },
    head: {
      appendChild(node) {
        links.push(node);
        node.onload();
      },
    },
    body: {
      appendChild(node) {
        scripts.push(node);
        if (node.src.endsWith("/marked.js")) ctx.HerdrMarked = { parse: () => "<p>rendered</p>" };
        if (node.src.endsWith("/dompurify.js")) ctx.HerdrDOMPurify = { sanitize: (html) => html };
        node.onload();
      },
    },
  };
  ctx = { window: null, document, localStorage: { getItem() { return null; } }, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { mod: ctx.window.HerdrMarkdownPreview, scripts, links };
}

describe("HerdrMarkdownPreview", () => {
  it("detects markdown paths", () => {
    const mod = loadModule();
    equal(mod.isMarkdownPath("README.md"), true);
    equal(mod.isMarkdownPath("docs/notes.markdown"), true);
    equal(mod.isMarkdownPath("src/main.rs"), false);
    equal(mod.isMarkdownPath(""), false);
  });

  it("detects mermaid fences", () => {
    const mod = loadModule();
    const source = "# title\n\n```mermaid\ngraph TD\nA-->B\n```\n";
    equal(mod.containsMermaid(source), true);
    equal(mod.containsMermaid(source), true);
    equal(mod.containsMermaid("# title\n\n~~~mermaid\ngraph TD\nA-->B\n~~~\n"), true);
    equal(mod.containsMermaid("# title\n\n```js\nconsole.log(1)\n```\n"), false);
    equal(mod.containsMermaid(""), false);
  });

  it("transforms mermaid code fences into herdr-mermaid divs", () => {
    const mod = loadModule();
    const html = '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>';
    const out = mod.transformMermaidFences(html);
    match(out, /<div class="herdr-mermaid">/);
    match(out, /graph TD/);
    match(out, /A-->B/);
  });

  it("sanitize config forbids inline event handlers and scripts", () => {
    const mod = loadModule();
    const config = mod.sanitizeConfig();
    ok(config.FORBID_TAGS.includes("script"));
    ok(config.FORBID_TAGS.includes("iframe"));
    ok(config.FORBID_ATTR.includes("onerror"));
    ok(config.FORBID_ATTR.includes("onload"));
  });

  it("lazy-loads preview assets once on first render", async () => {
    const { mod, scripts, links } = loadRenderModule();
    const container = { innerHTML: "", querySelectorAll() { return []; } };
    equal(scripts.length, 0);
    equal(links.length, 0);

    await mod.renderInto(container, "# title");
    equal(scripts.length, 2);
    equal(links.length, 1);
    equal(scripts[0].src, "/assets/vendor/marked.js");
    equal(scripts[1].src, "/assets/vendor/dompurify.js");
    equal(links[0].href, "/assets/shared/markdown-preview.css");

    await mod.renderInto(container, "# title");
    equal(scripts.length, 2);
    equal(links.length, 1);
  });
});
