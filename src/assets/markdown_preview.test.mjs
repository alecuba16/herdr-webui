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
    equal(mod.containsMermaid("# title\n\n```mermaid\ngraph TD\nA-->B\n```\n"), true);
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
});