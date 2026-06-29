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

  let codeMirrorPromise = null;

  function loadCodeMirror() {
    if (window.HerdrCodeMirror && window.HerdrCodeMirror.create) return Promise.resolve(true);
    if (codeMirrorPromise) return codeMirrorPromise;
    codeMirrorPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = "/assets/vendor/codemirror.js";
      script.onload = () => resolve(!!(window.HerdrCodeMirror && window.HerdrCodeMirror.create));
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
    return codeMirrorPromise;
  }

  function create(options) {
    const opts = options || {};
    const parent = opts.parent;
    if (!parent) return null;
    let destroyed = false;
    let inner = null;
    let content = String(opts.content || "");

    function createCodeMirror() {
      const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Editor")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
      parent.innerHTML = `<div class="herdr-editor cm">${head}<div class="herdr-editor-mount"></div></div>`;
      const mount = parent.querySelector(".herdr-editor-mount");
      const editor = window.HerdrCodeMirror.create(Object.assign({}, opts, { parent: mount, content }));
      return {
        getValue() { return editor.getValue(); },
        setValue(value) { content = String(value == null ? "" : value); editor.setValue(content); },
        destroy() { editor.destroy(); parent.innerHTML = ""; },
      };
    }

    if (window.HerdrCodeMirror && window.HerdrCodeMirror.create) {
      inner = createCodeMirror();
      return editorHandle();
    }
    const readonly = opts.readonly !== false;
    parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
    const textarea = parent.querySelector("textarea");
    if (textarea && opts.onChange) textarea.addEventListener("input", () => {
      content = textarea.value;
      opts.onChange(textarea.value);
    });
    inner = {
      getValue() {
        const node = parent.querySelector("textarea");
        return node ? node.value : content;
      },
      setValue(value) {
        content = String(value == null ? "" : value);
        opts.content = content;
        parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
      },
      destroy() {
        parent.innerHTML = "";
      },
    };
    loadCodeMirror().then((available) => {
      if (!available || destroyed || !parent.isConnected) return;
      content = inner.getValue();
      inner.destroy();
      inner = createCodeMirror();
    });
    return editorHandle();

    function editorHandle() {
      return {
        getValue() { return inner && inner.getValue ? inner.getValue() : content; },
        setValue(value) {
          content = String(value == null ? "" : value);
          if (inner && inner.setValue) inner.setValue(content);
        },
        destroy() {
          destroyed = true;
          if (inner && inner.destroy) inner.destroy();
          parent.innerHTML = "";
        },
      };
    }
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
