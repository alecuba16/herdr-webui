import { cursorCharLeft, cursorCharRight, cursorDocEnd, cursorDocStart, cursorGroupLeft, cursorGroupRight, cursorLineDown, cursorLineUp, cursorPageDown, cursorPageUp, defaultKeymap, deleteLine, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { MergeView } from "@codemirror/merge";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Decoration, drawSelection, dropCursor, EditorView, GutterMarker, gutter, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, rectangularSelection, ViewPlugin, WidgetType } from "@codemirror/view";

const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--panel)",
    color: "var(--fg)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    backgroundColor: "var(--panel)",
    borderRight: "1px solid var(--border)",
    color: "var(--muted)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent), transparent 92%)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent), transparent 88%)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent), transparent 65%)",
  },
  "&.cm-focused": { outline: "none" },
});

function languageForPath(path) {
  const name = String(path || "").split("/").pop().toLowerCase();
  if (["makefile", "gnumakefile", "bsdmakefile"].includes(name)) return null;
  const ext = name.split(".").pop();
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return javascript({ jsx: ext === "jsx" });
  if (["ts", "tsx"].includes(ext)) return javascript({ typescript: true, jsx: ext === "tsx" });
  if (ext === "rs") return rust();
  if (["py", "pyw"].includes(ext)) return python();
  if (ext === "go") return go();
  if (ext === "json") return json();
  if (["html", "htm"].includes(ext)) return html();
  if (ext === "css") return css();
  if (["md", "markdown"].includes(ext)) return markdown();
  if (["yaml", "yml"].includes(ext)) return yaml();
  if (ext === "xml") return xml();
  if (ext === "java") return java();
  if (["sql", "psql"].includes(ext)) return sql();
  return null;
}

const editorShortcutCommands = {
  lineDown: cursorLineDown,
  lineUp: cursorLineUp,
  charLeft: cursorCharLeft,
  charRight: cursorCharRight,
  wordLeft: cursorGroupLeft,
  wordRight: cursorGroupRight,
  pageDown: cursorPageDown,
  pageUp: cursorPageUp,
  docStart: cursorDocStart,
  docEnd: cursorDocEnd,
  deleteLine,
  indentMore,
  indentLess,
};

function editorShortcutOptions() {
  try {
    const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function shortcutToCodeMirrorKey(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "off") return "";
  const parts = text.replace(/-/g, "+").split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return "";
  const mods = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === "control") return "Ctrl";
    if (lower === "cmd" || lower === "command" || lower === "meta") return "Meta";
    if (lower === "option") return "Alt";
    if (["ctrl", "alt", "shift"].includes(lower)) return lower[0].toUpperCase() + lower.slice(1);
    return "";
  }).filter(Boolean);
  const cleanKey = key.length === 1 ? key.toLowerCase() : key;
  return mods.concat(cleanKey).join("-");
}

function editorShortcutKeymap(opts) {
  const shortcuts = editorShortcutOptions().editorShortcuts || {}, seen = new Set(), bindings = [];
  if (shortcuts.save) {
    const key = shortcutToCodeMirrorKey(shortcuts.save);
    if (key) {
      seen.add(key);
      bindings.push({ key, run(view) { if (!opts.onSave) return false; opts.onSave(view); return true; } });
    }
  }
  for (const [name, command] of Object.entries(editorShortcutCommands)) {
    const key = shortcutToCodeMirrorKey(shortcuts[name]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    bindings.push({ key, run: command });
  }
  return bindings;
}

class TextMarker extends GutterMarker {
  constructor(text, className) {
    super();
    this.text = text;
    this.className = className || "";
  }
  eq(other) { return other.text === this.text && other.className === this.className; }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    return span;
  }
}

class HunkActionWidget extends WidgetType {
  constructor(hunk, actions) {
    super();
    this.hunk = hunk;
    this.actions = actions || [];
  }
  eq(other) { return other.hunk.id === this.hunk.id && other.actions.join(",") === this.actions.join(","); }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-herdr-hunk-actions";
    const label = document.createElement("span");
    label.textContent = this.hunk.header || this.hunk.id || "hunk";
    wrap.appendChild(label);
    for (const action of this.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.hunkId = this.hunk.id || "";
      button.textContent = action;
      wrap.appendChild(button);
    }
    return wrap;
  }
  ignoreEvent() { return false; }
}

function gitOverlayExtensions(opts) {
  const extensions = [];
  const blame = Array.isArray(opts.blame) ? opts.blame : [];
  const hunks = Array.isArray(opts.hunks) ? opts.hunks : [];
  if (blame.length) {
    extensions.push(gutter({
      class: "cm-herdr-blame-gutter",
      lineMarker(_view, line) {
        const info = blame[line.number - 1];
        if (!info) return null;
        const text = typeof info === "string" ? info : (info.text || info.summary || info.hash || "");
        return text ? new TextMarker(text, "cm-herdr-blame") : null;
      },
      initialSpacer: () => new TextMarker("0000000", "cm-herdr-blame"),
    }));
  }
  if (hunks.length) {
    extensions.push(ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = buildHunkDecorations(view, hunks, opts.hunkActions || []); }
      update(update) {
        if (update.docChanged || update.viewportChanged) this.decorations = buildHunkDecorations(update.view, hunks, opts.hunkActions || []);
      }
    }, {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event) {
          const button = event.target && event.target.closest && event.target.closest(".cm-herdr-hunk-actions button[data-action]");
          if (!button || !opts.onAction) return false;
          event.preventDefault();
          opts.onAction(button.dataset.action, { hunkId: button.dataset.hunkId });
          return true;
        },
      },
    }));
  }
  return extensions;
}

function buildHunkDecorations(view, hunks, actions) {
  const decorations = [];
  for (const hunk of hunks) {
    const fromLine = Math.max(1, Number(hunk.fromLine || hunk.line || hunk.newStart || 1));
    const toLine = Math.max(fromLine, Number(hunk.toLine || hunk.newEnd || fromLine));
    const type = hunk.type || hunk.kind || "changed";
    try {
      const start = view.state.doc.line(fromLine);
      decorations.push(Decoration.widget({ widget: new HunkActionWidget(hunk, actions), block: true }).range(start.from));
      for (let lineNo = fromLine; lineNo <= Math.min(toLine, view.state.doc.lines); lineNo++) {
        const line = view.state.doc.line(lineNo);
        decorations.push(Decoration.line({ class: `cm-herdr-hunk cm-herdr-hunk-${type}` }).range(line.from));
      }
    } catch (_) {}
  }
  return Decoration.set(decorations, true);
}

function editorExtensions(opts) {
  const extensions = [
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    bracketMatching(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...editorShortcutKeymap(opts), ...defaultKeymap, ...historyKeymap]),
    theme,
    EditorView.lineWrapping,
    EditorView.editable.of(opts.readonly === false),
    EditorState.readOnly.of(opts.readonly !== false),
  ];
  if (opts.readonly === false) extensions.push(highlightActiveLine());
  const language = languageForPath(opts.path);
  if (language) extensions.push(language);
  if (opts.onChange) {
    extensions.push(EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString());
    }));
  }
  extensions.push(...gitOverlayExtensions(opts));
  return extensions;
}

function create(options) {
  const opts = options || {};
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: String(opts.content || ""), extensions: editorExtensions(opts) }),
  });
  return {
    view,
    getValue() { return view.state.doc.toString(); },
    setValue(value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(value == null ? "" : value) } });
    },
    destroy() { view.destroy(); },
  };
}

function createMerge(options) {
  const opts = options || {};
  const readonlyCurrent = opts.readonly !== false;
  const merge = new MergeView({
    parent: opts.parent,
    a: {
      doc: String(opts.previous || ""),
      extensions: editorExtensions(Object.assign({}, opts, { readonly: true, onChange: null })),
    },
    b: {
      doc: String(opts.content || ""),
      extensions: editorExtensions(Object.assign({}, opts, { readonly: readonlyCurrent, onChange: opts.onChange })),
    },
    orientation: "a-b",
    highlightChanges: true,
    gutter: true,
  });
  return {
    view: merge.b,
    getValue() { return merge.b.state.doc.toString(); },
    setValue(value) {
      merge.b.dispatch({ changes: { from: 0, to: merge.b.state.doc.length, insert: String(value == null ? "" : value) } });
    },
    destroy() { merge.destroy(); },
  };
}

export { create, createMerge, languageForPath };
