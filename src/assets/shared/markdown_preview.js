(function () {
  "use strict";

  const MERMAID_FENCE = /(^|\n)```mermaid\b/g;
  let mermaidPromise = null;
  let mermaidInitialized = false;

  function isMarkdownPath(path) {
    const ext = String(path || "").split(".").pop().toLowerCase();
    return ext === "md" || ext === "markdown";
  }

  function containsMermaid(markdown) {
    return MERMAID_FENCE.test(String(markdown || ""));
  }

  function ensureMarked() {
    if (window.HerdrMarked && window.HerdrMarked.parse) return Promise.resolve(window.HerdrMarked);
    return loadScript("/assets/vendor/marked.js").then(() => {
      if (!window.HerdrMarked || !window.HerdrMarked.parse) throw Error("marked failed to load");
      return window.HerdrMarked;
    });
  }

  function ensureDOMPurify() {
    if (window.HerdrDOMPurify && window.HerdrDOMPurify.sanitize) return Promise.resolve(window.HerdrDOMPurify);
    return loadScript("/assets/vendor/dompurify.js").then(() => {
      if (!window.HerdrDOMPurify || !window.HerdrDOMPurify.sanitize) throw Error("dompurify failed to load");
      return window.HerdrDOMPurify;
    });
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
    });
    return mermaidPromise;
  }

  function mermaidTheme() {
    try {
      const stored = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      const theme = stored.theme || "system";
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const dark = theme === "dark" || (theme === "system" && prefersDark);
      return dark ? "dark" : "default";
    } catch (_) {
      return "default";
    }
  }

  function initMermaid(mermaid) {
    if (mermaidInitialized) return;
    mermaidInitialized = true;
    try {
      mermaid.initialize({ startOnLoad: false, theme: mermaidTheme(), securityLevel: "strict" });
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

  function transformMermaidFences(html) {
    // marked emits ```mermaid blocks as <pre><code class="language-mermaid">...</code></pre>.
    // Convert them to <div class="herdr-mermaid"> so mermaid.run can render them.
    return html.replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      (_match, code) => `<div class="herdr-mermaid">${decodeHtmlEntities(code)}</div>`,
    );
  }

  function decodeHtmlEntities(value) {
    const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
    return String(value || "").replace(/&(amp|lt|gt|quot|#39);/g, (m) => map[m] || m);
  }

  function sanitizeConfig() {
    return {
      // Allow mermaid divs to survive sanitization so mermaid.run can target them.
      ADD_TAGS: ["div"],
      ADD_ATTR: ["class", "data-herdr-rendered"],
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
    };
  }

  function renderInto(container, markdown) {
    if (!container) return Promise.resolve();
    const source = String(markdown == null ? "" : markdown);
    container.innerHTML = '<div class="herdr-markdown-loading">Rendering markdown…</div>';
    return Promise.all([ensureMarked(), ensureDOMPurify()]).then(([marked, purify]) => {
      let html = marked.parse(source);
      html = transformMermaidFences(html);
      const clean = purify.sanitize(html, sanitizeConfig());
      container.innerHTML = `<div class="herdr-markdown-body">${clean}</div>`;
      if (containsMermaid(source)) renderMermaid(container).catch(() => {});
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

  window.HerdrMarkdownPreview = {
    isMarkdownPath,
    containsMermaid,
    renderInto,
    renderMermaid,
    transformMermaidFences,
    sanitizeConfig,
  };
})();