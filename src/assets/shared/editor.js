(function () {
  let codeMirrorPromise = null;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function languageFor(path) {
    if (window.HerdrGitSyntax && window.HerdrGitSyntax.languageFor) return window.HerdrGitSyntax.languageFor(path);
    const ext = String(path || "").split(".").pop().toLowerCase();
    return ext || "text";
  }

  function highlight(content, path) {
    if (window.HerdrGitSyntax && window.HerdrGitSyntax.highlight) return window.HerdrGitSyntax.highlight(content, path);
    return esc(content);
  }

  function create(options) {
    const opts = options || {};
    const parent = opts.parent;
    if (!parent) return null;
    const readonly = opts.readonly !== false;
    if (window.HerdrCodeMirror && window.HerdrCodeMirror.create) {
      parent.innerHTML = codeMirrorShellHtml(opts);
      const mount = parent.querySelector(".herdr-editor-mount");
      if (mount) mount.innerHTML = "";
      const editor = window.HerdrCodeMirror.create(Object.assign({}, opts, { parent: mount }));
      return {
        getValue() { return editor.getValue(); },
        setValue(value) { editor.setValue(value); },
        destroy() { editor.destroy(); parent.innerHTML = ""; },
      };
    }
    parent.innerHTML = codeMirrorShellHtml(opts);
    ensureCodeMirror().then(() => {
      if (!window.HerdrCodeMirror || !window.HerdrCodeMirror.create) return;
      const value = opts.content;
      create(Object.assign({}, opts, { content: value, readonly }));
    }).catch(() => {
      parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
      const textarea = parent.querySelector("textarea");
      if (textarea && opts.onChange) textarea.addEventListener("input", () => opts.onChange(textarea.value));
    });
    return {
      getValue() {
        const node = parent.querySelector("textarea");
        return node ? node.value : String(opts.content || "");
      },
      setValue(value) {
        opts.content = String(value == null ? "" : value);
        parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
      },
      destroy() {
        parent.innerHTML = "";
      },
    };
  }

  function codeMirrorShellHtml(opts) {
    const title = opts.path || (opts.readonly === false ? "Editor" : "Preview");
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(title)}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor cm">${head}<div class="herdr-editor-mount"><div class="herdr-editor-loading">Loading editor…</div></div></div>`;
  }

  function previewHtml(opts) {
    const content = String(opts.content || "");
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Preview")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    const lineNumbers = opts.lineNumbers !== false;
    const code = lineNumbers ? numberedPreviewHtml(content, opts.path) : `<pre class="herdr-editor-code"><code>${highlight(content, opts.path)}</code></pre>`;
    return `<div class="herdr-editor readonly${lineNumbers ? " with-line-numbers" : ""}">${head}${code}</div>`;
  }

  function numberedPreviewHtml(content, path) {
    const lines = String(content || "").split("\n");
    const gutter = lines.map((_, index) => `<span>${index + 1}</span>`).join("");
    const code = lines.map((line) => highlight(line, path)).join("\n");
    return `<div class="herdr-editor-numbered-code"><pre class="herdr-editor-lines" aria-hidden="true">${gutter}</pre><pre class="herdr-editor-code"><code>${code}</code></pre></div>`;
  }

  function editHtml(opts) {
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Editor")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor">${head}<textarea spellcheck="false">${esc(opts.content || "")}</textarea></div>`;
  }

  function ensureCodeMirror() {
    if (window.HerdrCodeMirror && window.HerdrCodeMirror.create)
      return Promise.resolve(window.HerdrCodeMirror);
    if (codeMirrorPromise) return codeMirrorPromise;
    codeMirrorPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = "/assets/vendor/codemirror.js";
      script.onload = () => resolve(window.HerdrCodeMirror || null);
      script.onerror = () => reject(Error("Failed to load CodeMirror"));
      document.body.appendChild(script);
    });
    return codeMirrorPromise;
  }

  window.HerdrEditor = { create, highlight, languageFor, ensureCodeMirror };
})();
