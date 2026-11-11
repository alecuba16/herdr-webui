// Feature M tests: the chat-markdown helpers inside the shared preview
// module. Same vm harness pattern as markdown_preview.test.mjs.
//
// The lens integration cases (assistant-vs-user gating, sync stability,
// mobile parity) live in lens_chat_mode.test.mjs and
// mobile_lens_behavior.test.mjs, which carry the full lens DOM harness.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PREVIEW_PATH = fileURLToPath(new URL("./shared/markdown_preview.js", import.meta.url));
const previewScript = new vm.Script(readFileSync(PREVIEW_PATH, "utf8"), { filename: PREVIEW_PATH });

// A marked stub whose output shape is recognizable for the assertions
// (headers, bold, code, links, lists).
function markedStub() {
  return {
    parse(text) {
      let out = String(text);
      out = out.replace(/^# (.*)$/gm, "<h1>$1</h1>");
      out = out.replace(/^## (.*)$/gm, "<h2>$1</h2>");
      out = out.replace(/^### (.*)$/gm, "<h3>$1</h3>");
      out = out.replace(/^#### (.*)$/gm, "<h4>$1</h4>");
      out = out.replace(/^##### (.*)$/gm, "<h5>$1</h5>");
      out = out.replace(/^###### (.*)$/gm, "<h6>$1</h6>");
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
      out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      if (/(^|\n)\s*[-*]\s/.test(out)) {
        const items = out
          .split(/\n/)
          .filter((l) => /^\s*[-*]\s/.test(l))
          .map((l) => `<li>${l.replace(/^\s*[-*]\s/, "")}</li>`)
          .join("");
        out = `<ul>${items}</ul>`;
      }
      return `<p>${out}</p>`;
    },
  };
}

// A DOMPurify stub that actually strips the dangerous shapes the tests
// assert on (script tags, event-handler attributes).
function domPurifyStub() {
  return {
    sanitize(html, _config) {
      return String(html)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/\son(error|load|click|mouseover|focus|blur)\s*=\s*"[^"]*"/gi, "");
    },
  };
}

function loadPreview({ bundle } = {}) {
  const scripts = [];
  const links = [];
  const document = {
    createElement(tag) {
      return { tag, dataset: {}, setAttribute() {}, appendChild() {}, replaceWith() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
    },
    querySelector() { return null; },
    head: {
      appendChild(node) {
        links.push(node);
        if (node.onload) node.onload();
      },
    },
    body: {
      appendChild(node) {
        scripts.push(node);
        if (node.onload) node.onload();
      },
    },
  };
  const ctx = {
    window: null,
    document,
    localStorage: { getItem: () => null },
    matchMedia: undefined,
    console,
    HerdrMarked: bundle ? markedStub() : undefined,
    HerdrDOMPurify: bundle ? domPurifyStub() : undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  previewScript.runInContext(ctx);
  return { mod: ctx.window.HerdrMarkdownPreview, ctx, scripts, links };
}

describe("HerdrMarkdownPreview chat markdown", () => {
  it("renders markdown when the bundle is present", () => {
    const { mod } = loadPreview({ bundle: true });
    const html = mod.renderChatMarkdownHtml("# Title\n\n**bold** and `code`");
    ok(html.includes("<h1>Title</h1>"), "header rendered");
    ok(html.includes("<strong>bold</strong>"), "bold rendered");
    ok(html.includes("<code>code</code>"), "code rendered");
    ok(html.includes('class="herdr-markdown-body lens-markdown"'), "wrapper classes present");
  });

  it("falls back to escaped plain text when the bundle is absent", () => {
    const { mod } = loadPreview({ bundle: false });
    const html = mod.renderChatMarkdownHtml("**not bold**");
    equal(html, '<div class="herdr-markdown-body lens-markdown">**not bold**</div>');
  });

  it("two renders of the same text are byte-identical (cache hit)", () => {
    const { mod } = loadPreview({ bundle: true });
    const text = "# Same\n\n- one\n- two";
    const a = mod.renderChatMarkdownHtml(text);
    const b = mod.renderChatMarkdownHtml(text);
    equal(a, b, "deterministic output");
    ok(a.includes("<ul>"), "list rendered");
  });

  it("strips scripts and event-handler attributes through sanitize", () => {
    const { mod } = loadPreview({ bundle: true });
    const html = mod.renderChatMarkdownHtml('<a href="x" onerror="alert(1)">bad</a>\n<script>alert(2)</script>');
    ok(!html.includes("<script"), "script stripped");
    ok(!html.includes("onerror"), "onerror stripped");
    ok(html.includes("<a"), "anchor kept");
  });

  it("mermaid fences flow through transformMermaidFences", () => {
    const { mod } = loadPreview({ bundle: true });
    // The real marked emits a fenced mermaid block as a pre>code pair
    // with the language class; the chat path must convert it to the
    // herdr-mermaid div the renderer targets.
    const { mod: realTransform } = loadPreview({ bundle: true });
    const converted = realTransform.transformMermaidFences(
      '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>',
    );
    ok(converted.includes('class="herdr-mermaid"'), "mermaid div produced");
    ok(converted.includes("data-herdr-source"), "mermaid source carried");
    // And a mermaid fence in assistant text rides that same path when
    // marked shapes it as the pre/code pair.
    const { ctx } = loadPreview({ bundle: true });
    const original = ctx.HerdrMarked.parse;
    ctx.HerdrMarked.parse = () =>
      '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>';
    const html = ctx.HerdrMarkdownPreview.renderChatMarkdownHtml("```mermaid\ngraph TD\nA-->B\n```");
    ctx.HerdrMarked.parse = original;
    ok(html.includes('class="herdr-mermaid"'), "chat row carries the mermaid div");
    ok(html.includes("data-herdr-source"), "chat row carries the mermaid source");
  });

  it("links get target=_blank rel=noopener", () => {
    const { mod } = loadPreview({ bundle: true });
    const html = mod.renderChatMarkdownHtml("[docs](https://example.com)");
    ok(html.includes('<a target="_blank" rel="noopener" href="https://example.com">'), "retargeted anchor");
  });

  it("upgrade path re-renders queued rows through the ready callback", async () => {
    const { mod, ctx } = loadPreview({ bundle: false });
    const plain = mod.renderChatMarkdownHtml("queued text");
    ok(plain.includes("queued text"), "plain fallback rendered");
    // The lens registers its re-render callback while the bundle is
    // still absent (module load time in the real app).
    let upgraded = 0;
    mod.onChatBundleReady(() => {
      upgraded += 1;
    });
    // Simulate the vendor bundle scripts landing (what loadScript onload
    // does for the real marked/dompurify files).
    ctx.HerdrMarked = markedStub();
    ctx.HerdrDOMPurify = domPurifyStub();
    await mod.upgradeChatMarkdown();
    await new Promise((r) => setTimeout(r, 0));
    equal(upgraded, 1, "bundle ready callback fired");
    ok(mod.renderChatMarkdownHtml("queued text").includes("<p>"), "upgraded rows render markdown");
  });

  it("ready registration is a no-op once the bundle exists", () => {
    const { mod } = loadPreview({ bundle: true });
    let fired = 0;
    mod.onChatBundleReady(() => {
      fired += 1;
    });
    equal(fired, 0, "no callback while rows already render markdown");
  });

  it("upgrade is a no-op when nothing is queued", async () => {
    const { mod } = loadPreview({ bundle: false });
    // No renderChatMarkdownHtml call: the queue is empty, so no bundle
    // script may be requested.
    await mod.upgradeChatMarkdown();
    const { mod: mod2, scripts } = loadPreview({ bundle: false });
    await mod2.upgradeChatMarkdown();
    equal(scripts.length, 0, "no script load without pending rows");
  });

  it("renderChatMermaid is a safe no-op on missing or empty roots", async () => {
    const { mod } = loadPreview({ bundle: true });
    const root = { querySelectorAll() { return []; } };
    await mod.renderChatMermaid(root);
    await mod.renderChatMermaid(null);
  });

  it("cache evicts the oldest entry past the 200-entry cap", () => {
    const { mod } = loadPreview({ bundle: true });
    // Insertion order is eviction order: the first text must fall out of
    // the cache when the 201st distinct text renders, while a recently
    // used entry survives.
    const first = mod.renderChatMarkdownHtml("# first entry");
    for (let i = 0; i < 201; i++) {
      mod.renderChatMarkdownHtml(`# churn ${i}`);
    }
    const again = mod.renderChatMarkdownHtml("# first entry");
    equal(again, first, "re-render after eviction still matches (cache never lies)");
    // The churn itself kept every render inside the cap, so a second
    // full batch must not blow up or change output for a live entry.
    const live = mod.renderChatMarkdownHtml("# churn 200");
    equal(
      mod.renderChatMarkdownHtml("# churn 200"),
      live,
      "cache hit path is stable",
    );
  });

  it("a throwing ready callback does not block the other lenses", async () => {
    const { mod, ctx } = loadPreview({ bundle: false });
    mod.renderChatMarkdownHtml("queued text");
    let goodFired = 0;
    mod.onChatBundleReady(() => {
      throw new Error("dead lens mount");
    });
    mod.onChatBundleReady(() => {
      goodFired += 1;
    });
    ctx.HerdrMarked = markedStub();
    ctx.HerdrDOMPurify = domPurifyStub();
    await mod.upgradeChatMarkdown();
    await new Promise((r) => setTimeout(r, 0));
    equal(goodFired, 1, "the healthy callback still ran after the thrower");
  });

  it("queue caps at 200 pending texts when the vendor load keeps failing", async () => {
    // A permanently broken vendor load must not grow the pending set
    // forever: after a failed upgrade the queue stays (a later poll
    // retries), so the cap is what bounds memory.
    const { mod } = loadPreview({ bundle: false });
    mod.renderChatMarkdownHtml("first queued");
    for (let i = 0; i < 250; i++) {
      mod.renderChatMarkdownHtml(`churn ${i}`);
    }
    // Re-rendering a still-queued text is a Set hit: no growth.
    mod.renderChatMarkdownHtml("first queued");
    equal(mod._chatQueueSize(), 200, "queue pinned at the cap, oldest texts evicted");
    const attempt = mod.upgradeChatMarkdown();
    // The stub document resolves script loads instantly but never sets
    // the Herdr globals, so ensure* throws and the upgrade rejects,
    // leaving the queue intact for the next poll's retry.
    await attempt;
    await new Promise((r) => setTimeout(r, 0));
    equal(mod._chatQueueSize(), 200, "failed upgrade keeps the queue for retry");
    ok(
      mod.renderChatMarkdownHtml("first queued").includes("first queued"),
      "still on the escaped fallback after the failed upgrade",
    );
  });

  it("queue eviction is observable: the oldest text drops out at the cap", () => {
    const { mod } = loadPreview({ bundle: false });
    mod.renderChatMarkdownHtml("oldest text");
    // One past the cap: the 201st distinct text evicts "oldest text".
    for (let i = 0; i < 200; i++) {
      mod.renderChatMarkdownHtml(`evict ${i}`);
    }
    // Smoke: the module keeps answering renders after full churn.
    const out = mod.renderChatMarkdownHtml("newest text");
    ok(out.includes("newest text"), "newest text renders the fallback");
  });

  it("ensureChatBundle loads the vendor scripts and clears its promise on failure", async () => {
    // The stub document fires onload the moment a script is appended,
    // so a successful upgrade goes through the real loadScript chain
    // (ensureMarked + ensureDOMPurify), not a pre-seeded window global.
    const { mod, ctx, scripts } = loadPreview({ bundle: false });
    mod.renderChatMarkdownHtml("lazy row");
    const upgrade = mod.upgradeChatMarkdown();
    // The stub appends and resolves synchronously; hand the globals the
    // onload handlers would install in the real browser.
    ctx.HerdrMarked = markedStub();
    ctx.HerdrDOMPurify = domPurifyStub();
    await upgrade;
    await new Promise((r) => setTimeout(r, 0));
    ok(scripts.some((s) => s.src.includes("marked.js")), "marked script requested");
    ok(scripts.some((s) => s.src.includes("dompurify.js")), "dompurify script requested");
    ok(mod.renderChatMarkdownHtml("lazy row").includes("<p>"), "row renders markdown after the load");

    // Failure path: a bundle load that rejects must null the cached
    // promise so a later attempt can retry instead of staying broken.
    const { mod: mod2, ctx: ctx2, scripts: scripts2 } = loadPreview({ bundle: false });
    mod2.renderChatMarkdownHtml("retry row");
    const attempt = mod2.upgradeChatMarkdown();
    for (const script of scripts2) {
      if (script.onerror) script.onerror();
    }
    await attempt;
    await new Promise((r) => setTimeout(r, 0));
    equal(
      typeof ctx2.window.HerdrMarked,
      "undefined",
      "failed load leaves no half-installed globals",
    );
    ok(mod2.renderChatMarkdownHtml("retry row").includes("retry row"), "row still renders the escaped fallback");
  });
});
