(function () {
  "use strict";

  const MERMAID_FENCE = /(^|\n) {0,3}(?:```|~~~)\s*mermaid\b/i;
  let markedPromise = null;
  let domPurifyPromise = null;
  let mermaidPromise = null;
  let mermaidInitialized = false;
  let markdownStylesPromise = null;

  function isMarkdownPath(path) {
    const ext = String(path || "").split(".").pop().toLowerCase();
    return ext === "md" || ext === "markdown";
  }

  function containsMermaid(markdown) {
    return MERMAID_FENCE.test(String(markdown || ""));
  }

  function ensureMarked() {
    if (window.HerdrMarked && window.HerdrMarked.parse) return Promise.resolve(window.HerdrMarked);
    if (markedPromise) return markedPromise;
    markedPromise = loadScript("/assets/vendor/marked.js").then(() => {
      if (!window.HerdrMarked || !window.HerdrMarked.parse) throw Error("marked failed to load");
      return window.HerdrMarked;
    }).catch((error) => {
      markedPromise = null;
      throw error;
    });
    return markedPromise;
  }

  function ensureDOMPurify() {
    if (window.HerdrDOMPurify && window.HerdrDOMPurify.sanitize) return Promise.resolve(window.HerdrDOMPurify);
    if (domPurifyPromise) return domPurifyPromise;
    domPurifyPromise = loadScript("/assets/vendor/dompurify.js").then(() => {
      if (!window.HerdrDOMPurify || !window.HerdrDOMPurify.sanitize) throw Error("dompurify failed to load");
      return window.HerdrDOMPurify;
    }).catch((error) => {
      domPurifyPromise = null;
      throw error;
    });
    return domPurifyPromise;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(Error("Failed to load " + src));
      document.body.appendChild(script);
    });
  }

  function ensureMermaid() {
    if (window.HerdrMermaid && window.HerdrMermaid.run) return Promise.resolve(window.HerdrMermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = loadScript("/assets/vendor/mermaid.js").then(() => {
      if (!window.HerdrMermaid || !window.HerdrMermaid.run) throw Error("mermaid failed to load");
      return window.HerdrMermaid;
    }).catch((error) => {
      mermaidPromise = null;
      throw error;
    });
    return mermaidPromise;
  }

  function ensureMarkdownStyles() {
    if (document.querySelector && document.querySelector('link[data-herdr-markdown-preview]')) {
      return Promise.resolve();
    }
    if (markdownStylesPromise) return markdownStylesPromise;
    markdownStylesPromise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/assets/shared/markdown-preview.css";
      link.dataset.herdrMarkdownPreview = "true";
      link.onload = resolve;
      link.onerror = () => reject(Error("Failed to load markdown preview styles"));
      document.head.appendChild(link);
    }).catch((error) => {
      markdownStylesPromise = null;
      throw error;
    });
    return markdownStylesPromise;
  }

  function mermaidTheme() {
    try {
      const theme = String(localStorage.getItem("herdr-web-theme") || "auto").trim();
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const dark = theme === "dark" || (theme === "auto" && prefersDark);
      return dark ? "dark" : "default";
    } catch (_) {
      return "default";
    }
  }

  function initMermaid(mermaid) {
    const options = { startOnLoad: false, theme: mermaidTheme(), securityLevel: "strict" };
    try {
      if (mermaidInitialized) {
        if (mermaid.initialize) mermaid.initialize(options);
        return;
      }
      mermaid.initialize(options);
      mermaidInitialized = true;
    } catch (_) {}
  }

  function renderMermaid(container) {
    const nodes = container.querySelectorAll(".herdr-mermaid:not([data-herdr-rendered])");
    if (!nodes.length) return Promise.resolve();
    return ensureMermaid().then((mermaid) => {
      initMermaid(mermaid);
      const run = mermaid.run.bind(mermaid);
      const list = Array.prototype.slice.call(nodes);
      list.forEach((node) => node.setAttribute("data-herdr-rendered", "pending"));
      return Promise.resolve(run({ nodes: list })).catch((error) => {
        list.forEach((node) => {
          if (!node.querySelector("svg")) {
            node.setAttribute("data-herdr-rendered", "error");
            const pre = document.createElement("pre");
            pre.className = "herdr-mermaid-error";
            pre.textContent = (error && error.message) || "Mermaid render failed";
            node.replaceWith(pre);
          }
        });
      });
    });
  }

  function refreshTheme() {
    if (!mermaidInitialized) return Promise.resolve();
    return ensureMermaid().then((mermaid) => {
      initMermaid(mermaid);
      document.querySelectorAll(".herdr-mermaid[data-herdr-rendered]").forEach((node) => {
        const original = node.dataset.herdrSource || "";
        if (!original) return;
        const wrap = document.createElement("div");
        wrap.className = "herdr-mermaid";
        wrap.textContent = original;
        node.replaceWith(wrap);
      });
      return renderMermaid(document);
    });
  }

  function transformMermaidFences(html) {
    // marked emits ```mermaid blocks as <pre><code class="language-mermaid">...</code></pre>.
    // Convert them to <div class="herdr-mermaid"> so mermaid.run can render them.
    return html.replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      (_match, code) => `<div class="herdr-mermaid" data-herdr-source="${encodeHtmlAttribute(decodeHtmlEntities(code))}">${decodeHtmlEntities(code)}</div>`,
    );
  }

  function encodeHtmlAttribute(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function decodeHtmlEntities(value) {
    const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
    return String(value || "").replace(/&(amp|lt|gt|quot|#39);/g, (m) => map[m] || m);
  }

  function sanitizeConfig() {
    return {
      // Allow mermaid divs to survive sanitization so mermaid.run can target them.
      ADD_TAGS: ["div"],
      ADD_ATTR: ["class", "data-herdr-rendered", "data-herdr-source"],
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
    };
  }

  function renderInto(container, markdown) {
    if (!container) return Promise.resolve();
    const source = String(markdown == null ? "" : markdown);
    container.innerHTML = '<div class="herdr-markdown-loading">Rendering markdown…</div>';
    return Promise.all([
      ensureMarked(),
      ensureDOMPurify(),
      ensureMarkdownStyles().catch(() => {}),
    ]).then(([marked, purify]) => {
      let html = marked.parse(source);
      html = transformMermaidFences(html);
      const clean = purify.sanitize(html, sanitizeConfig());
      // Gifs 404 noisily from the workspace file route, so drop them after
      // the sanitize pass and keep the rest of the doc rendering.
      const gifless = clean.replace(/<img\b[^>]*\bsrc="[^"]*\.gif"[^>]*>/gi, "");
      container.innerHTML = `<div class="herdr-markdown-body">${gifless}</div>`;
      renderMermaid(container).catch(() => {});
    }).catch((error) => {
      container.innerHTML = `<div class="herdr-markdown-error">Markdown preview failed: ${esc((error && error.message) || error)}</div>`;
    });
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- chat-lens markdown (Feature M) ----
  // The chat lens re-serializes every part row on each poll and swaps
  // when outerHTML differs, so the render must be SYNCHRONOUS and
  // deterministic: same text in, byte-identical html out. marked.parse
  // and DOMPurify.sanitize are deterministic for the same input+config;
  // the cache below pins one parse per text so a poll never re-parses
  // and the outerHTML comparison stays stable (no flicker every 2s).
  const CHAT_MARKDOWN_CACHE_MAX = 200;
  let chatHtmlCache = null;
  let chatQueue = new Set();
  let chatBundlePromise = null;
  let chatUpgradeCallbacks = new Set();

  function chatCache() {
    if (!chatHtmlCache) chatHtmlCache = new Map();
    return chatHtmlCache;
  }

  function chatHasBundle() {
    return !!(
      typeof window !== "undefined" &&
      window.HerdrMarked &&
      window.HerdrMarked.parse &&
      window.HerdrDOMPurify &&
      window.HerdrDOMPurify.sanitize
    );
  }

  // Chat links must never navigate the webui away: sanitize has already
  // stripped event handlers, so this string pass only adds safe attrs.
  function retargetLinks(html) {
    return html.replace(/<a\b(?![^>]*\btarget=)/g, '<a target="_blank" rel="noopener"');
  }

  function chatEscaped(text) {
    // Same escaping shape the lens uses for plain rows, so the fallback
    // row and the upgrade target serialize identically after the swap.
    return '<div class="herdr-markdown-body lens-markdown">' + esc(text) + "</div>";
  }

  function chatRenderHtml(text) {
    const cache = chatCache();
    if (cache.has(text)) return cache.get(text);
    const marked = window.HerdrMarked;
    const purify = window.HerdrDOMPurify;
    let html = marked.parse(text);
    html = transformMermaidFences(html);
    const clean = purify.sanitize(html, sanitizeConfig());
    // Gif strip parity with renderInto: a 404ing gif inside a chat row
    // would spam the console every poll.
    const gifless = clean.replace(/<img\b[^>]*\bsrc="[^"]*\.gif"[^>]*>/gi, "");
    const out =
      '<div class="herdr-markdown-body lens-markdown">' + retargetLinks(gifless) + "</div>";
    if (cache.size >= CHAT_MARKDOWN_CACHE_MAX) {
      // Map iteration order is insertion order: drop the oldest entry,
      // a cheap LRU that never runs per poll (cache hit path skips this).
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(text, out);
    return out;
  }

  function renderChatMarkdownHtml(text) {
    const source = String(text == null ? "" : text);
    if (chatHasBundle()) return chatRenderHtml(source);
    // Bundle not loaded yet: queue for upgrade and render the escaped
    // fallback so the first paint is immediate (no blank rows).
    // A permanently failing vendor load would otherwise grow this Set
    // forever (every poll re-adds its pane's texts), so cap it like the
    // render cache. Insertion order is drop order: the newest texts
    // stay queued, the oldest scroll out.
    if (chatQueue.size >= CHAT_MARKDOWN_CACHE_MAX) {
      const oldest = chatQueue.values().next().value;
      chatQueue.delete(oldest);
    }
    chatQueue.add(source);
    return chatEscaped(source);
  }

  function ensureChatBundle() {
    if (chatHasBundle()) return Promise.resolve();
    if (!chatBundlePromise) {
      chatBundlePromise = Promise.all([ensureMarked(), ensureDOMPurify()])
        .then(() => {
          ensureMarkdownStyles().catch(() => {});
        })
        .catch((error) => {
          chatBundlePromise = null;
          throw error;
        });
    }
    return chatBundlePromise;
  }

  function onChatBundleReady(callback) {
    // If the bundle already loaded, rows render markdown at partHtml
    // time and there is nothing to upgrade: never fire (firing here
    // would double-render once upgradeChatMarkdown reaches the same
    // callback set on the next poll).
    if (chatHasBundle()) return;
    chatUpgradeCallbacks.add(callback);
  }

  // Loads the bundles once (only when rows were queued as plain text)
  // and upgrades the calling lens's rendered rows: the caller registers
  // a callback that re-renders, and is invoked once when the bundle
  // lands. Cheap when nothing is pending: no queue, no network.
  function upgradeChatMarkdown() {
    if (!chatQueue.size) return Promise.resolve();
    return ensureChatBundle()
      .then(() => {
        if (!chatHasBundle()) return;
        chatQueue.clear();
        chatUpgradeCallbacks.forEach((callback) => {
          try {
            callback();
          } catch (_) {
            // A dead lens callback must not break the other lenses
            // sharing this module (desktop + mobile mounts).
          }
        });
      })
      .catch(() => {});
  }

  // After a swap the caller must ask mermaid to run over the live DOM:
  // fences became .herdr-mermaid divs inside the sanitized html.
  function renderChatMermaid(root) {
    if (!root || !root.querySelectorAll) return Promise.resolve();
    return renderMermaid(root).catch(() => {});
  }

  window.HerdrMarkdownPreview = {
    isMarkdownPath,
    containsMermaid,
    renderInto,
    renderMermaid,
    transformMermaidFences,
    sanitizeConfig,
    refreshTheme,
    renderChatMarkdownHtml,
    ensureChatBundle,
    upgradeChatMarkdown,
    onChatBundleReady,
    renderChatMermaid,
    // Test probe: the pending-upgrade set is memory-bounded by the cap;
    // the queue itself is internal, so the size is the only observable.
    _chatQueueSize: () => chatQueue.size,
  };
})();
