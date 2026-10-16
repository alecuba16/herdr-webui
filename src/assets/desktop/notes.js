// Shared notes sidebar view. Hosts the server-wide scratchpad in the right
// sidebar column as the fourth rail view (Files/Git/Search/Notes). Entries
// live on the server (notes.json sidecar), so every connected client sees
// the same list: mutations PUT per note after a debounce and the server
// broadcasts a full notes_changed snapshot that applyRemote adopts. The
// server owns the list contract (newest-first order, resolved display
// titles, the language table, created note ids); this file only renders
// it. CodeMirror highlights a note through the shared editor's
// path->language mapping ("note." + extension), so the parse cost is paid
// only while a note is open for editing.
(function () {
  const SAVE_DEBOUNCE_MS = 600;
  // List resync cadence while the panel is hosted. The notes_changed
  // broadcast covers live changes, but a missed WS frame or a reconnect
  // gap can leave the list stale; the interval is the floor.
  const RESYNC_INTERVAL_MS = 15000;
  // Boot fallback until the first payload arrives: every server response
  // and broadcast carries the authoritative table.
  const FALLBACK_LANGUAGES = [{ value: "txt", label: "Text", ext: "txt" }];

  let panelState = null;

  function freshState() {
    return {
      notes: [],
      languages: null,
      loaded: false,
      loading: false,
      error: "",
      editingId: null,
      saveTimer: null,
      saving: false,
      syncTimer: null,
      syncing: false,
      syncFailed: false,
    };
  }

  function ensureState() {
    if (!panelState) panelState = freshState();
    return panelState;
  }

  function languages(state) {
    const list = (state || ensureState()).languages;
    return Array.isArray(list) && list.length ? list : FALLBACK_LANGUAGES;
  }

  function languageEntry(value, state) {
    const list = languages(state);
    return list.find((entry) => entry && entry.value === value) || list[0] || FALLBACK_LANGUAGES[0];
  }

  function languageExt(value) {
    const entry = languageEntry(value);
    return (entry && entry.ext) || "txt";
  }

  // Every server payload (GET, mutation response, broadcast) has the same
  // shape: adopt notes and the language table in one place.
  function adoptPayload(data) {
    const state = ensureState();
    if (data && Array.isArray(data.notes)) state.notes = data.notes;
    if (data && Array.isArray(data.languages) && data.languages.length)
      state.languages = data.languages;
  }

  // Un-flushed local work: a pending debounce, a failed flush (the
  // "failed" sentinel), or a PUT still in flight.
  function editingDirty(state) {
    return !!(state.saveTimer || state.saving);
  }

  // Merge an incoming snapshot into state. While a note is open for
  // editing and still present remotely, the local copy wins (LWW lands
  // on the next flush) and no repaint happens: repainting would replace
  // innerHTML, remount CodeMirror, and throw away the cursor and
  // un-flushed text. If the edited note vanished remotely and nothing is
  // dirty here, the edit view closes instead of editing a ghost.
  // Returns true when the caller should repaint.
  function adoptIncoming(incoming) {
    const state = ensureState();
    const id = state.editingId;
    if (id) {
      const local = noteById(id);
      if (local) {
        const stillThere = incoming.some((note) => note && note.id === id);
        if (!stillThere && !editingDirty(state)) {
          state.editingId = null;
          state.notes = incoming;
          return true;
        }
        // Keep the edited note pinned to the front: it is the most
        // recent write this client knows about, matching the newest-
        // first order the server owns.
        state.notes = [local].concat(incoming.filter((note) => note && note.id !== id));
        return false;
      }
    }
    state.notes = incoming;
    return true;
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
      adoptPayload(await api("/api/notes"));
      state.loaded = true;
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
    }
  }

  function setSyncState(kind) {
    const button = document.getElementById("notesSync");
    if (!button) return;
    const syncing = kind === "syncing";
    button.className = syncing
      ? "mini notes-sync spinning"
      : kind === "failed" ? "mini notes-sync failed" : "mini notes-sync";
    button.title = syncing
      ? "Syncing notes..."
      : kind === "failed" ? "Sync failed. Click to retry." : "Sync notes";
    button.disabled = syncing;
  }

  // Periodic list resync. Skips while the tab is hidden, the column is
  // collapsed, or a sync is in flight; a manual click forces past those
  // guards. While a note is open the merge rules still apply: clean +
  // deleted remotely closes the editor, dirty keeps local pinned.
  async function syncNotes(force) {
    const state = ensureState();
    if (!isOpen() || state.syncing) return;
    if (!force) {
      if (state.loading) return;
      if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed && window.HerdrRightSidebar.collapsed()) return;
      if (typeof document !== "undefined" && document.hidden) return;
    }
    state.syncing = true;
    setSyncState("syncing");
    try {
      const data = await api("/api/notes");
      const payload = data || {};
      const incoming = Array.isArray(payload.notes) ? payload.notes : [];
      if (Array.isArray(payload.languages) && payload.languages.length)
        state.languages = payload.languages;
      if (adoptIncoming(incoming)) renderPanel();
      state.syncFailed = false;
      setSyncState("idle");
    } catch (error) {
      state.syncFailed = true;
      setSyncState("failed");
    } finally {
      state.syncing = false;
    }
  }

  function startResyncTimer() {
    const state = ensureState();
    if (state.syncTimer || typeof setInterval !== "function") return;
    // Return the promise so a tick in flight is observable (and tests can
    // await it); setInterval itself ignores the return value.
    state.syncTimer = setInterval(() => syncNotes(false), RESYNC_INTERVAL_MS);
  }

  function stopResyncTimer() {
    const state = ensureState();
    if (state.syncTimer && typeof clearInterval === "function") clearInterval(state.syncTimer);
    state.syncTimer = null;
  }

  let visibilityWired = false;
  function wireVisibilitySync() {
    if (visibilityWired) return;
    if (typeof document === "undefined" || !document.addEventListener) return;
    visibilityWired = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      // Catch up right away after the tab returns instead of waiting for
      // the next interval tick.
      syncNotes(true);
    });
  }

  async function createNote() {
    const state = ensureState();
    try {
      const data = await api("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "", content: "", language: "txt" }),
      });
      adoptPayload(data);
      state.editingId = (data && data.created_note_id) || null;
      renderPanel();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    }
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
      adoptPayload(data);
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
      adoptPayload(data);
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
      adoptPayload(data);
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
      adoptPayload(data);
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
      adoptPayload(data);
      state.editingId = null;
      renderPanel();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    }
  }

  function renderPanel() {
    const panel = document.getElementById("notesPanel");
    if (!panel) return;
    const state = ensureState();
    const notes = state.notes || [];
    const editing = state.editingId ? noteById(state.editingId) : null;
    // The server delivers newest-first; render in arrival order.
    const rows = notes
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
      ? `<div class="notes-editor-head"><button class="mini notes-back" id="notesBack" title="Back to list" aria-label="Back to notes list"><span aria-hidden="true">‹</span></button><input id="notesTitleInput" class="notes-title-input" placeholder="Note title"${typeof inputAttrs === "function" ? inputAttrs("done") : " autocomplete=\"off\" spellcheck=\"false\""} aria-label="Note title" /><select id="notesLanguage" class="notes-language" aria-label="Syntax language">${languages(state).map((entry) => `<option value="${escapeHtml(entry.value)}"${editing.language === entry.value ? " selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}</select><button class="mini notes-save-state" id="notesSaveState" disabled>${state.saving ? "Saving..." : "Saved"}</button></div>`
      : `<div class="notes-panel-head"><strong>Notes</strong><span class="notes-count">${notes.length}</span><button class="mini" id="notesNew" title="New note" aria-label="New note">+ New</button>${notes.length ? '<button class="mini notes-clear" id="notesClear" title="Clear all notes" aria-label="Clear all notes">Clear all</button>' : ""}<button class="mini notes-sync" id="notesSync" title="Sync notes" aria-label="Sync notes now"><span aria-hidden="true"></span></button></div>`;
    const body = editing
      ? '<div class="notes-editor" id="notesEditor"></div>'
      : listHtml;
    panel.innerHTML = `${head}${body}`;

    const back = panel.querySelector("#notesBack");
    if (back) back.onclick = async () => {
      if (state.saveTimer) {
        clearTimeout(state.saveTimer);
        state.saveTimer = null;
        // Capture before the editor unmounts and PUT directly, like close:
        // flushSave refuses while a save is in flight, which would drop
        // this debounce window's keystrokes. A parallel PUT is harmless
        // (same note, last write wins on the server).
        const id = state.editingId;
        const note = id ? noteById(id) : null;
        const editor = panelNode()._herdrEditorApi;
        if (note && editor) await saveContent(id, editor.getValue());
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
    const syncButton = panel.querySelector("#notesSync");
    if (syncButton) syncButton.onclick = () => syncNotes(true);
    setSyncState(state.syncing ? "syncing" : state.syncFailed ? "failed" : "idle");
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
    const title = escapeHtml(note.display_title || "Untitled");
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
      hideHeader: true,
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
  function applyRemote(message) {
    if (!isOpen()) return;
    const state = ensureState();
    // The broadcast has the same shape as GET; accept a bare notes array too.
    const payload = Array.isArray(message) ? { notes: message } : message || {};
    const incoming = Array.isArray(payload.notes) ? payload.notes : [];
    if (Array.isArray(payload.languages) && payload.languages.length)
      state.languages = payload.languages;
    if (adoptIncoming(incoming)) renderPanel();
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
    startResyncTimer();
    wireVisibilitySync();
    if (typeof render === "function") render();
  }

  function close() {
    const state = ensureState();
    stopResyncTimer();
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
    editingId: () => ensureState().editingId,
    syncNow: () => syncNotes(true),
  };
})();
