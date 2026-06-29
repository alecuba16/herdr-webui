(function () {
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
    if (window.HerdrCodeMirror && window.HerdrCodeMirror.create) {
      const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Editor")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
      parent.innerHTML = `<div class="herdr-editor cm">${head}<div class="herdr-editor-mount"></div></div>`;
      const mount = parent.querySelector(".herdr-editor-mount");
      const editor = window.HerdrCodeMirror.create(Object.assign({}, opts, { parent: mount }));
      return {
        getValue() { return editor.getValue(); },
        setValue(value) { editor.setValue(value); },
        destroy() { editor.destroy(); parent.innerHTML = ""; },
      };
    }
    const readonly = opts.readonly !== false;
    parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
    const textarea = parent.querySelector("textarea");
    if (textarea && opts.onChange) textarea.addEventListener("input", () => opts.onChange(textarea.value));
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

  function previewHtml(opts) {
    const content = String(opts.content || "");
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Preview")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor readonly">${head}<pre class="herdr-editor-code"><code>${highlight(content, opts.path)}</code></pre></div>`;
  }

  function editHtml(opts) {
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Editor")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor">${head}<textarea spellcheck="false">${esc(opts.content || "")}</textarea></div>`;
  }

  window.HerdrEditor = { create, highlight, languageFor };
})();
