// Shared notes sidebar view. Hosts the server-wide scratchpad in the right
// sidebar column as the fourth rail view (Files/Git/Search/Notes). Entries
// live on the server (notes.json sidecar), so every connected client sees
// the same list: mutations PUT per note after a debounce and the server
// broadcasts a full notes_changed snapshot that applyRemote adopts.
// CodeMirror highlights a note through the shared editor's path->language
// mapping ("note." + extension), so the parse cost is paid only while a
// note is open for editing.
(function () {
  const SAVE_DEBOUNCE_MS = 600;
  const LANGUAGES = [
    ["txt", "Text"],
    ["markdown", "Markdown"],
    ["javascript", "JavaScript"],
    ["typescript", "TypeScript"],
    ["rust", "Rust"],
    ["python", "Python"],
    ["go", "Go"],
    ["json", "JSON"],
    ["yaml", "YAML"],
    ["css", "CSS"],
    ["html", "HTML"],
    ["xml", "XML"],
    ["java", "Java"],
    ["sql", "SQL"],
  ];

  let panelState = null;

  function freshState() {
    return {
      notes: [],
      loaded: false,
      loading: false,
      error: "",
      editingId: null,
      saveTimer: null,
      saving: false,
    };
  }

  function ensureState() {
    if (!panelState) panelState = freshState();
    return panelState;
  }

  function languageExt(language) {
    // Extension must match codemirror_entry's languageForPath table (rs, py,
    // md, js, ts...); the other allowlist names already are extensions.
    const map = {
      markdown: "md",
      javascript: "js",
      typescript: "ts",
      rust: "rs",
      python: "py",
    };
    return map[language] || language;
  }

  function panelNode() {
    let panel = document.getElementById("notesPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "notesPanel";
      panel.className = "notes-panel";
    }
    return panel;
  }

  function isOpen() {
    const panel = document.getElementById("notesPanel");
    return !!(panel && panel.parentNode);
  }

  function noteById(id) {
    const state = ensureState();
    return (state.notes || []).find((note) => note && note.id === id) || null;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function fetchNotes() {
    const state = ensureState();
    state.loading = true;
    state.error = "";
    try {
      const data = await api("/api/notes");
      state.notes = Array.isArray(data && data.notes) ? data.notes : [];
      state.loaded = true;
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
    }
  }

  async function createNote() {
    const state = ensureState();
    try {
      const data = await api("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "", content: "", language: "txt" }),
      });
      if (Array.isArray(data && data.notes)) state.notes = data.notes;
      state.editingId = latestNote(data && data.notes) ? latestNote(data.notes).id : null;
      renderPanel();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    }
  }

  function latestNote(notes) {
    const list = (notes || []).filter((note) => note && note.id);
    if (!list.length) return null;
    return list.reduce((a, b) => (Number(b.updated_at || 0) >= Number(a.updated_at || 0) ? b : a));
  }

  function scheduleSave() {
    const state = ensureState();
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  async function saveContent(id, content) {
    const state = ensureState();
    state.saving = true;
    setSaveState("saving");
    try {
      const data = await api(`/api/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (Array.isArray(data && data.notes)) state.notes = data.notes;
      state.error = "";
      state.saveTimer = null;
      setSaveState("saved");
      showEditorError("");
    } catch (error) {
      state.error = error.message || String(error);
      setSaveState("failed");
      showEditorError(state.error);
      // Keep the edit dirty so back/close retry the flush instead of
      // dropping the change after a failed PUT (deleted remotely, 500, ...).
      if (!state.saveTimer) state.saveTimer = "failed";
    } finally {
      state.saving = false;
    }
  }

  function showEditorError(message) {
    const panel = document.getElementById("notesPanel");
    if (!panel) return;
    let node = panel.querySelector(".notes-editor-error");
    if (!message) {
      if (node) node.remove();
      return;
    }
    if (!node) {
      node = document.createElement("div");
      node.className = "notes-editor-error";
      panel.appendChild(node);
    }
    node.textContent = message;
  }

  async function flushSave() {
    const state = ensureState();
    const id = state.editingId;
    const note = id ? noteById(id) : null;
    const editor = panelNode()._herdrEditorApi;
    if (!note || !editor || state.saving) return;
    return saveContent(id, editor.getValue());
  }

  async function saveTitle(id, title) {
    const state = ensureState();
    const note = noteById(id);
    if (!note) return;
    if (note.title === title) return;
    note.title = title;
    try {
      const data = await api(`/api/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (Array.isArray(data && data.notes)) state.notes = data.notes;
      state.error = "";
      setSaveState("saved");
      showEditorError("");
    } catch (error) {
      state.error = error.message || String(error);
      setSaveState("failed");
      showEditorError(state.error);
    }
  }

  async function saveLanguage(id, language) {
    const state = ensureState();
    const note = noteById(id);
    if (!note || note.language === language) return;
    note.language = language;
    // Remount the editor so CodeMirror re-highlights with the new language.
    renderPanel();
    try {
      const data = await api(`/api/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language }),
      });
      if (Array.isArray(data && data.notes)) state.notes = data.notes;
      state.error = "";
      setSaveState("saved");
      showEditorError("");
    } catch (error) {
      state.error = error.message || String(error);
      setSaveState("failed");
      showEditorError(state.error);
    }
  }

  async function deleteNote(id) {
    const state = ensureState();
    if (!id) return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    try {
      const data = await api(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (Array.isArray(data && data.notes)) state.notes = data.notes;
      if (state.editingId === id) state.editingId = null;
      renderPanel();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    }
  }

  async function clearAllNotes() {
    const state = ensureState();
    const ok = typeof askQuestion === "function"
      ? await askQuestion({
          title: "Clear all notes",
          message: "Delete every note on this server? This cannot be undone.",
          confirmText: "Clear all",
          danger: true,
        })
      : window.confirm("Delete every note on this server?");
    if (!ok) return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    try {
      const data = await api("/api/notes/clear", { method: "POST" });
      if (Array.isArray(data && data.notes)) state.notes = data.notes;
      state.editingId = null;
      renderPanel();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    }
  }

  function titleFor(note) {
    const text = String(note && note.title ? note.title : "").trim();
    if (text) return text;
    const firstLine = String(note && note.content ? note.content : "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ? firstLine.slice(0, 80) : "Untitled note";
  }

  function renderPanel() {
    const panel = document.getElementById("notesPanel");
    if (!panel) return;
    const state = ensureState();
    const notes = state.notes || [];
    const editing = state.editingId ? noteById(state.editingId) : null;
    const rows = notes
      .slice()
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
      .map((note) => noteRowHtml(note, editing && note.id === editing.id))
      .join("");
    const listHtml = state.loading && !state.loaded
      ? '<div class="notes-empty">Loading notes...</div>'
      : state.error
        ? `<div class="notes-error">${escapeHtml(state.error)}</div>`
        : notes.length
          ? `<ul class="notes-list" role="list">${rows}</ul>`
          : '<div class="notes-empty">No notes yet. Create one to get started.</div>';
    const head = editing
      ? `<div class="notes-editor-head"><button class="mini notes-back" id="notesBack" title="Back to list" aria-label="Back to notes list"><span aria-hidden="true">‹</span></button><input id="notesTitleInput" class="notes-title-input" placeholder="Note title"${typeof inputAttrs === "function" ? inputAttrs("done") : " autocomplete=\"off\" spellcheck=\"false\""} aria-label="Note title" /><select id="notesLanguage" class="notes-language" aria-label="Syntax language">${LANGUAGES.map(([value, label]) => `<option value="${value}"${editing.language === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select><button class="mini notes-save-state" id="notesSaveState" disabled>${state.saving ? "Saving..." : "Saved"}</button></div>`
      : `<div class="notes-panel-head"><strong>Notes</strong><span class="notes-count">${notes.length}</span><button class="mini" id="notesNew" title="New note" aria-label="New note">+ New</button>${notes.length ? '<button class="mini notes-clear" id="notesClear" title="Clear all notes" aria-label="Clear all notes">Clear all</button>' : ""}</div>`;
    const body = editing
      ? '<div class="notes-editor" id="notesEditor"></div>'
      : listHtml;
    panel.innerHTML = `${head}${body}`;

    const back = panel.querySelector("#notesBack");
    if (back) back.onclick = async () => {
      if (state.saveTimer) {
        clearTimeout(state.saveTimer);
        state.saveTimer = null;
        await flushSave();
      }
      state.editingId = null;
      renderPanel();
    };
    const titleInput = panel.querySelector("#notesTitleInput");
    if (titleInput) {
      titleInput.value = String(editing ? editing.title || "" : "");
      if (!titleInput.__herdrWired) {
        titleInput.__herdrWired = true;
        titleInput.addEventListener("change", () => {
          if (editing) saveTitle(editing.id, titleInput.value);
        });
      }
    }
    const language = panel.querySelector("#notesLanguage");
    if (language) language.onchange = () => {
      if (editing) saveLanguage(editing.id, language.value);
    };
    const newButton = panel.querySelector("#notesNew");
    if (newButton) newButton.onclick = () => createNote();
    const clearButton = panel.querySelector("#notesClear");
    if (clearButton) clearButton.onclick = () => clearAllNotes();
    panel.querySelectorAll("[data-notes-open]").forEach((row) => {
      row.onclick = () => {
        state.editingId = row.getAttribute("data-notes-open");
        renderPanel();
      };
    });
    panel.querySelectorAll("[data-notes-delete]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        deleteNote(button.getAttribute("data-notes-delete"));
      };
    });
    if (editing) mountEditor(panel, editing);
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
  }

  function noteRowHtml(note, active) {
    const id = escapeHtml(note.id);
    const title = escapeHtml(titleFor(note));
    const language = escapeHtml(note.language || "txt");
    const updated = Number(note.updated_at || 0);
    const when = updated ? new Date(updated * 1000).toLocaleString() : "";
    return `<li class="notes-row${active ? " active" : ""}" data-notes-open="${id}" role="button" tabindex="0" aria-label="Open note ${title}"><div class="notes-row-main"><span class="notes-row-title">${title}</span><span class="notes-row-lang">${language}</span></div><div class="notes-row-meta"><span class="notes-row-updated">${when}</span><button class="mini notes-row-delete" data-notes-delete="${id}" title="Delete note" aria-label="Delete note ${title}"><span aria-hidden="true">✕</span></button></div></li>`;
  }

  function mountEditor(panel, note) {
    const container = panel.querySelector("#notesEditor");
    if (!container || container._herdrEditorMounted) return;
    container._herdrEditorMounted = true;
    if (!window.HerdrEditor || !window.HerdrEditor.create) {
      container.innerHTML = `<div class="notes-empty">Editor unavailable.</div>`;
      return;
    }
    const state = ensureState();
    window.HerdrEditor.create({
      parent: container,
      path: `note.${languageExt(note.language || "txt")}`,
      content: String(note.content || ""),
      readonly: false,
      onChange(value) {
        note.content = value;
        setSaveState("pending");
        scheduleSave();
      },
    });
    panel._herdrEditorApi = container._herdrEditorApi;
    if (state.saving) setSaveState("saving");
    else if (state.saveTimer === "failed") {
      // A previous flush failed (deleted remotely, 500, ...): keep the
      // failure visible and the edit dirty instead of showing Saved.
      setSaveState("failed");
      showEditorError(state.error);
    } else setSaveState("saved");
  }

  function setSaveState(kind) {
    const button = document.getElementById("notesSaveState");
    if (!button) return;
    if (kind === "pending") {
      button.textContent = "Unsaved";
      button.disabled = false;
    } else if (kind === "saving") {
      button.textContent = "Saving...";
      button.disabled = true;
    } else if (kind === "failed") {
      button.textContent = "Save failed";
      button.disabled = true;
    } else {
      button.textContent = "Saved";
      button.disabled = true;
    }
  }

  // Server (or another client) changed the notes. Adopt the snapshot only
  // while the panel is hosted: a closed panel keeps nothing to repaint and
  // picks the fresh list up on the next open's GET. While a note is open for
  // editing the local copy of that note wins (LWW lands on the next flush)
  // and the editor is left untouched: repainting would replace innerHTML,
  // remount CodeMirror, and throw away both the cursor and un-flushed text.
  function applyRemote(notes) {
    if (!isOpen()) return;
    const state = ensureState();
    const incoming = Array.isArray(notes) ? notes : [];
    const id = state.editingId;
    if (id) {
      const local = noteById(id);
      if (local) {
        state.notes = incoming
          .filter((note) => note && note.id !== id)
          .concat([local]);
        return;
      }
    }
    state.notes = incoming;
    renderPanel();
  }

  async function open(workspaceId, options) {
    const openOptions = options || {};
    if (typeof rememberWorkspaceShellMode === "function") rememberWorkspaceShellMode("notes", workspaceId);
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    if (window.HerdrFileBrowser) window.HerdrFileBrowser.hide();
    if (window.HerdrSearchPanel) window.HerdrSearchPanel.close();
    if (!openOptions.forceOpen && window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) {
      window.HerdrRightSidebar.setCollapsed(false);
    }
    const panel = panelNode();
    if (window.HerdrRightSidebar) {
      const ensurePanel = () => panel;
      await window.HerdrRightSidebar.openView("notes", workspaceId, ensurePanel);
    }
    renderPanel();
    const state = ensureState();
    if (!state.loaded) await fetchNotes();
    renderPanel();
    if (typeof render === "function") render();
  }

  function close() {
    const state = ensureState();
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      // The pending edit must not die with the panel: capture the text
      // before the editor unmounts and let the PUT fly on its own.
      const id = state.editingId;
      const note = id ? noteById(id) : null;
      const editor = panelNode()._herdrEditorApi;
      if (note && editor) saveContent(id, editor.getValue());
    }
    const panel = document.getElementById("notesPanel");
    if (panel) {
      panel._herdrEditorApi = null;
      panel.remove();
    }
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
  }

  window.HerdrNotesPanel = {
    open,
    close,
    isOpen,
    render: renderPanel,
    applyRemote,
    createNote,
    deleteNote,
    clearAll: clearAllNotes,
    flush: flushSave,
  };
})();