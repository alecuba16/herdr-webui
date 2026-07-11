import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
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
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Decoration, drawSelection, dropCursor, EditorView, GutterMarker, gutter, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, rectangularSelection, ViewPlugin, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--editor-bg, var(--panel2))",
    color: "var(--fg)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg, var(--panel2))",
    borderRight: "1px solid var(--border)",
    color: "var(--muted)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent), transparent 92%)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent), transparent 88%)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent), transparent 65%)",
  },
  ".cm-herdr-search-line": {
    backgroundColor: "var(--herdr-search-match-bg, color-mix(in srgb, var(--accent), transparent 88%))",
  },
  ".cm-herdr-search-hit": {
    backgroundColor: "var(--herdr-search-hit-bg, color-mix(in srgb, var(--accent), transparent 70%))",
    borderRadius: "3px",
    color: "var(--herdr-search-hit-fg, var(--fg))",
  },
  "&.cm-focused": { outline: "none" },
});

const readableHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--editor-syntax-keyword)" },
  { tag: [tags.atom, tags.bool, tags.null, tags.literal], color: "var(--editor-syntax-constant)" },
  { tag: [tags.number, tags.integer, tags.float, tags.unit], color: "var(--editor-syntax-number)" },
  { tag: [tags.string, tags.character, tags.attributeValue, tags.docString], color: "var(--editor-syntax-string)" },
  { tag: [tags.escape, tags.regexp, tags.url, tags.link], color: "var(--editor-syntax-regexp)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--editor-syntax-comment)", fontStyle: "italic" },
  { tag: [tags.variableName, tags.name, tags.namespace, tags.self], color: "var(--editor-syntax-variable)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: "var(--editor-syntax-function)" },
  { tag: [tags.className, tags.typeName, tags.definition(tags.typeName)], color: "var(--editor-syntax-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--editor-syntax-property)" },
  { tag: [tags.tagName, tags.macroName], color: "var(--editor-syntax-tag)" },
  { tag: [tags.operator, tags.operatorKeyword, tags.compareOperator, tags.logicOperator, tags.arithmeticOperator, tags.definitionOperator, tags.typeOperator], color: "var(--editor-syntax-operator)" },
  { tag: [tags.meta, tags.annotation, tags.modifier, tags.processingInstruction], color: "var(--editor-syntax-meta)" },
  { tag: tags.heading, color: "var(--editor-syntax-keyword)", fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--editor-syntax-invalid)", textDecoration: "underline wavy var(--editor-syntax-invalid)" },
]);

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

function languageNameForPath(path) {
  const name = String(path || "").split("/").pop().toLowerCase();
  if (["makefile", "gnumakefile", "bsdmakefile"].includes(name)) return "makefile";
  const ext = name.split(".").pop();
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (ext === "rs") return "rust";
  if (["py", "pyw"].includes(ext)) return "python";
  if (ext === "go") return "go";
  if (ext === "json") return "json";
  if (["html", "htm"].includes(ext)) return "html";
  if (ext === "css") return "css";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (ext === "xml") return "xml";
  if (ext === "java") return "java";
  if (["sql", "psql"].includes(ext)) return "sql";
  return ext || "text";
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

function searchHighlightExtensions(opts) {
  const highlight = opts.searchHighlight || null;
  const lineNo = Math.max(1, Number(highlight && highlight.line) || 0);
  if (!lineNo) return [];
  return [ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildSearchHighlightDecorations(view, highlight, lineNo); }
    update(update) {
      if (update.docChanged || update.viewportChanged) this.decorations = buildSearchHighlightDecorations(update.view, highlight, lineNo);
    }
  }, { decorations: (plugin) => plugin.decorations })];
}

function buildSearchHighlightDecorations(view, highlight, lineNo) {
  const decorations = [];
  try {
    const line = view.state.doc.line(Math.min(lineNo, view.state.doc.lines));
    decorations.push(Decoration.line({ class: "cm-herdr-search-line" }).range(line.from));
    const start = Number(highlight && highlight.from);
    const end = Number(highlight && highlight.to);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const from = Math.min(line.to, line.from + Math.max(0, start));
      const to = Math.min(line.to, line.from + Math.max(0, end));
      if (to > from) decorations.push(Decoration.mark({ class: "cm-herdr-search-hit" }).range(from, to));
    }
  } catch (_) {}
  return Decoration.set(decorations, true);
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

function create(options) {
  const opts = options || {};
  const extensions = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    bracketMatching(),
    indentOnInput(),
    syntaxHighlighting(readableHighlightStyle, { fallback: true }),
    foldGutter(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
    theme,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "data-language": languageNameForPath(opts.path) }),
    EditorView.editable.of(opts.readonly === false),
    EditorState.readOnly.of(opts.readonly !== false),
  ];
  if (opts.lineNumbers !== false) extensions.unshift(lineNumbers());
  extensions.push(highlightActiveLine());
  const language = languageForPath(opts.path);
  if (language) extensions.push(language);
  if (opts.onChange) {
    extensions.push(EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString());
    }));
  }
  extensions.push(...gitOverlayExtensions(opts));
  extensions.push(...searchHighlightExtensions(opts));
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: String(opts.content || ""), extensions }),
  });
  scrollToSearchHighlight(view, opts.searchHighlight);
  return {
    view,
    getValue() { return view.state.doc.toString(); },
    setValue(value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(value == null ? "" : value) } });
    },
    destroy() { view.destroy(); },
  };
}

function scrollToSearchHighlight(view, highlight) {
  const lineNo = Math.max(1, Number(highlight && highlight.line) || 0);
  if (!lineNo) return;
  const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback) => setTimeout(callback, 0);
  schedule(() => {
    try {
      const line = view.state.doc.line(Math.min(lineNo, view.state.doc.lines));
      const from = Math.min(line.to, line.from + Math.max(0, Number(highlight.from) || 0));
      view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    } catch (_) {}
  });
}

export { create, languageForPath, languageNameForPath };
