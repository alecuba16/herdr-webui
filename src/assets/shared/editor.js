(function () {
  let codeMirrorPromise = null;
  const FIND_OPTIONS_KEY = "herdr-editor-search-options";

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

  function storedFindOptions() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FIND_OPTIONS_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveFindOptions(options) {
    try { localStorage.setItem(FIND_OPTIONS_KEY, JSON.stringify(options || {})); } catch (_) {}
  }

  function editorFindShortcutEnabled() {
    try {
      const options = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      return !options || options.editorFindShortcutEnabled !== false;
    } catch (_) {
      return true;
    }
  }

  function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildSearchRegex(query, opts) {
    const source = opts.regex ? String(query || "") : escapeRegex(query);
    if (!source) return null;
    try { return new RegExp(source, `g${opts.matchCase ? "" : "i"}`); }
    catch (error) { return { error: error.message || String(error) }; }
  }

  function findRanges(text, query, opts) {
    const regex = buildSearchRegex(query, opts);
    if (!regex) return { ranges: [], error: "" };
    if (regex.error) return { ranges: [], error: `Invalid regex: ${regex.error}` };
    const ranges = [];
    let match;
    while ((match = regex.exec(text)) && ranges.length < 10000) {
      const from = match.index;
      const to = from + match[0].length;
      if (to > from) ranges.push({ from, to });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
    return { ranges, error: "" };
  }

  function findToolbarHtml(opts) {
    if (opts.hideFind) return "";
    const readonly = opts.readonly !== false;
    const stored = storedFindOptions();
    const matchCase = stored.matchCase === true;
    const regex = stored.regex === true;
    return `<div class="herdr-editor-find" data-readonly="${readonly ? "true" : "false"}" hidden>
      <input class="herdr-editor-find-query" placeholder="Find" autocomplete="off" spellcheck="false">
      <input class="herdr-editor-replace-query" placeholder="Replace" autocomplete="off" spellcheck="false" ${readonly ? "disabled" : ""}>
      <button type="button" class="herdr-editor-find-prev" title="Previous match">↑</button>
      <button type="button" class="herdr-editor-find-next" title="Next match">↓</button>
      <button type="button" class="herdr-editor-replace-one" ${readonly ? "disabled" : ""}>Replace</button>
      <button type="button" class="herdr-editor-replace-all" ${readonly ? "disabled" : ""}>All</button>
      <label><input type="checkbox" class="herdr-editor-find-case" ${matchCase ? "checked" : ""}>Aa</label>
      <label><input type="checkbox" class="herdr-editor-find-regex" ${regex ? "checked" : ""}>.*</label>
      <span class="herdr-editor-find-status"></span>
    </div>`;
  }

  function wireFindToolbar(parent, api, opts) {
    const toolbar = parent && parent.querySelector && parent.querySelector(".herdr-editor-find");
    if (!toolbar || !api) return;
    const query = toolbar.querySelector(".herdr-editor-find-query");
    const replacement = toolbar.querySelector(".herdr-editor-replace-query");
    const matchCase = toolbar.querySelector(".herdr-editor-find-case");
    const regex = toolbar.querySelector(".herdr-editor-find-regex");
    const status = toolbar.querySelector(".herdr-editor-find-status");
    const readonly = opts.readonly !== false;
    let current = -1;
    let lastQuery = "";

    function options() {
      return { matchCase: !!(matchCase && matchCase.checked), regex: !!(regex && regex.checked) };
    }
    function persist() { saveFindOptions(options()); }
    function setStatus(text) { if (status) status.textContent = text || ""; }
    function showFind(focus) {
      toolbar.hidden = false;
      if (focus !== false && query) {
        query.focus();
        if (query.select) query.select();
      }
    }
    function hideFind() {
      toolbar.hidden = true;
      if (query) query.value = "";
      current = -1;
      lastQuery = "";
      setStatus("");
    }
    function handleFindShortcut(event) {
      const key = String(event.key || "").toLowerCase();
      if (key !== "f" || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
      if (!editorFindShortcutEnabled()) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      showFind(true);
    }
    if (parent.addEventListener) {
      if (parent._herdrEditorFindShortcutHandler && parent.removeEventListener) {
        parent.removeEventListener("keydown", parent._herdrEditorFindShortcutHandler, true);
      }
      parent._herdrEditorFindShortcutHandler = handleFindShortcut;
      parent.addEventListener("keydown", handleFindShortcut, true);
    }
    function select(range) {
      if (!range) return;
      if (api.selectRange) api.selectRange(range.from, range.to);
    }
    function matches() {
      const value = query ? query.value : "";
      const result = findRanges(api.getValue(), value, options());
      if (result.error) setStatus(result.error);
      return Object.assign({ query: value }, result);
    }
    function choose(direction) {
      const result = matches();
      if (result.error) return null;
      if (!result.query) { setStatus(""); return null; }
      if (!result.ranges.length) { current = -1; setStatus("No matches"); return null; }
      if (result.query !== lastQuery) current = direction < 0 ? 0 : -1;
      lastQuery = result.query;
      current = (current + direction + result.ranges.length) % result.ranges.length;
      const range = result.ranges[current];
      select(range);
      setStatus(`${current + 1}/${result.ranges.length}`);
      return range;
    }
    function replaceCurrent() {
      if (readonly) return;
      const range = current >= 0 ? matches().ranges[current] : choose(1);
      if (!range || !api.replaceRange) return;
      api.replaceRange(range.from, range.to, replacement ? replacement.value : "");
      current = Math.max(-1, current - 1);
      choose(1);
    }
    function replaceAll() {
      if (readonly) return;
      const value = query ? query.value : "";
      const optsNow = options();
      const regexValue = buildSearchRegex(value, optsNow);
      if (!regexValue) return;
      if (regexValue.error) { setStatus(`Invalid regex: ${regexValue.error}`); return; }
      const text = api.getValue();
      const repl = replacement ? replacement.value : "";
      const next = optsNow.regex ? text.replace(regexValue, repl) : text.replace(regexValue, () => repl);
      if (next === text) { setStatus("No matches"); return; }
      api.setValue(next);
      current = -1;
      setStatus("Replaced all");
    }
    if (query) {
      query.addEventListener("input", () => { current = -1; choose(1); });
      query.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); choose(event.shiftKey ? -1 : 1); }
        if (event.key === "Escape") {
          event.preventDefault();
          if (query.value) { query.value = ""; current = -1; setStatus(""); }
          else hideFind();
        }
      });
    }
    if (matchCase) matchCase.addEventListener("change", () => { persist(); current = -1; choose(1); });
    if (regex) regex.addEventListener("change", () => { persist(); current = -1; choose(1); });
    const prev = toolbar.querySelector(".herdr-editor-find-prev");
    const next = toolbar.querySelector(".herdr-editor-find-next");
    const one = toolbar.querySelector(".herdr-editor-replace-one");
    const all = toolbar.querySelector(".herdr-editor-replace-all");
    if (prev) prev.addEventListener("click", () => choose(-1));
    if (next) next.addEventListener("click", () => choose(1));
    if (one) one.addEventListener("click", replaceCurrent);
    if (all) all.addEventListener("click", replaceAll);
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
      const api = {
        getValue() { return editor.getValue(); },
        setValue(value) { editor.setValue(value); },
        selectRange(from, to) { if (editor.selectRange) editor.selectRange(from, to); },
        replaceRange(from, to, value) { if (editor.replaceRange) editor.replaceRange(from, to, value); },
        destroy() { editor.destroy(); parent.innerHTML = ""; },
      };
      wireFindToolbar(parent, api, opts);
      return api;
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
      wireFindToolbar(parent, api, opts);
    });
    const api = {
      getValue() {
        const node = parent.querySelector("textarea");
        return node ? node.value : String(opts.content || "");
      },
      setValue(value) {
        opts.content = String(value == null ? "" : value);
        parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
        wireFindToolbar(parent, api, opts);
      },
      selectRange(from, to) {
        const node = parent.querySelector("textarea") || parent.querySelector(".herdr-editor-code");
        if (node && typeof node.setSelectionRange === "function") {
          node.focus();
          node.setSelectionRange(from, to);
        }
      },
      replaceRange(from, to, value) {
        const current = api.getValue();
        api.setValue(current.slice(0, from) + String(value == null ? "" : value) + current.slice(to));
        if (opts.onChange) opts.onChange(api.getValue());
      },
      destroy() {
        parent.innerHTML = "";
      },
    };
    wireFindToolbar(parent, api, opts);
    return api;
  }

  function codeMirrorShellHtml(opts) {
    const title = opts.path || (opts.readonly === false ? "Editor" : "Preview");
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(title)}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor cm">${head}${findToolbarHtml(opts)}<div class="herdr-editor-mount"><div class="herdr-editor-loading">Loading editor…</div></div></div>`;
  }

  function previewHtml(opts) {
    const content = String(opts.content || "");
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Preview")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    const lineNumbers = opts.lineNumbers !== false;
    const code = lineNumbers ? numberedPreviewHtml(content, opts.path) : `<pre class="herdr-editor-code"><code>${highlight(content, opts.path)}</code></pre>`;
    return `<div class="herdr-editor readonly${lineNumbers ? " with-line-numbers" : ""}">${head}${findToolbarHtml(opts)}${code}</div>`;
  }

  function numberedPreviewHtml(content, path) {
    const lines = String(content || "").split("\n");
    const gutter = lines.map((_, index) => `<span>${index + 1}</span>`).join("");
    const code = lines.map((line) => highlight(line, path)).join("\n");
    return `<div class="herdr-editor-numbered-code"><pre class="herdr-editor-lines" aria-hidden="true">${gutter}</pre><pre class="herdr-editor-code"><code>${code}</code></pre></div>`;
  }

  function editHtml(opts) {
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Editor")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor">${head}${findToolbarHtml(opts)}<textarea spellcheck="false">${esc(opts.content || "")}</textarea></div>`;
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

  window.HerdrEditor = { create, highlight, languageFor, ensureCodeMirror, findRanges, editorFindShortcutEnabled };
})();
