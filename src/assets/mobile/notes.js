// Mobile Notes screen. The server-wide scratchpad from the desktop rail
// (notes.json sidecar behind /api/notes) rendered as a drawer screen:
// newest-first list, create, edit through the shared headerless editor,
// confirm-free delete, danger-confirmed clear. Saves debounce per note
// (600ms) like the desktop; the notes_changed broadcast adopts remote
// snapshots while the screen is visible, and a periodic resync (15s,
// visible-tab only) covers missed frames. Editing state is local: the
// shared editor mounts into a stable container that survives re-renders,
// and un-flushed edits keep the local note pinned like the desktop rail.
(function () {
  const SAVE_DEBOUNCE_MS = 600;
  const RESYNC_INTERVAL_MS = 15000;
  const FALLBACK_LANGUAGES = [{ value: "txt", label: "Text", ext: "txt" }];

  function createMobileNotes(deps) {
    const { api, confirm, escapeHtml, inputAttrs, render } = deps;
    const local = {
      notes: [],
      languages: null,
      loaded: false,
      loading: false,
      error: "",
      editingId: null,
      saveTimer: null,
      saving: false,
      syncing: false,
      syncFailed: false,
      syncTimer: null,
      editorApi: null,
      editorHost: null,
    };

    function languages() {
      return Array.isArray(local.languages) && local.languages.length
        ? local.languages
        : FALLBACK_LANGUAGES;
    }

    function languageExt(value) {
      const entry = languages().find((item) => item && item.value === value);
      return (entry && entry.ext) || "txt";
    }

    function noteById(id) {
      return (local.notes || []).find((note) => note && note.id === id) || null;
    }

    function screenVisible() {
      return typeof document !== "undefined"
        && typeof document.getElementById === "function"
        && !!document.getElementById("mobileNotesScreen");
    }

    function editingDirty() {
      return !!(local.saveTimer || local.saving);
    }

    function adoptPayload(data) {
      const payload = data || {};
      if (Array.isArray(payload.notes)) local.notes = payload.notes;
      if (Array.isArray(payload.languages) && payload.languages.length)
        local.languages = payload.languages;
    }

    // Same merge contract as the desktop rail: while a note is open and
    // still present remotely the local copy wins (LWW lands on the next
    // flush); if it vanished remotely and nothing is dirty, close the
    // editor instead of editing a ghost.
    function adoptIncoming(incoming) {
      const id = local.editingId;
      if (id) {
        const openNote = noteById(id);
        if (openNote) {
          const stillThere = incoming.some((note) => note && note.id === id);
          if (!stillThere && !editingDirty()) {
            local.editingId = null;
            local.editorApi = null;
            local.notes = incoming;
            return true;
          }
          local.notes = [openNote].concat(
            incoming.filter((note) => note && note.id !== id),
          );
          return false;
        }
      }
      local.notes = incoming;
      return true;
    }

    async function load() {
      local.loading = true;
      local.error = "";
      try {
        adoptPayload(await api("/api/notes"));
        local.loaded = true;
      } catch (error) {
        local.error = (error && error.message) || String(error);
      } finally {
        local.loading = false;
      }
      render();
    }

    async function sync(force) {
      if (local.syncing) return;
      if (!force) {
        if (local.loading) return;
        if (typeof document !== "undefined" && document.hidden) return;
        if (!screenVisible()) return;
      }
      local.syncing = true;
      try {
        const data = await api("/api/notes");
        const incoming = Array.isArray((data || {}).notes) ? data.notes : [];
        if (Array.isArray((data || {}).languages) && data.languages.length)
          local.languages = data.languages;
        if (adoptIncoming(incoming)) render();
        local.syncFailed = false;
      } catch (error) {
        local.syncFailed = true;
      } finally {
        local.syncing = false;
      }
    }

    function startResyncTimer() {
      if (local.syncTimer || typeof setInterval !== "function") return;
      local.syncTimer = setInterval(() => sync(false), RESYNC_INTERVAL_MS);
    }

    function stopResyncTimer() {
      if (local.syncTimer && typeof clearInterval === "function")
        clearInterval(local.syncTimer);
      local.syncTimer = null;
    }

    function flushSave() {
      const id = local.editingId;
      const note = id ? noteById(id) : null;
      const editor = local.editorApi;
      if (!note || !editor || local.saving) return Promise.resolve();
      return saveContent(id, editor.getValue());
    }

    async function saveContent(id, content) {
      local.saving = true;
      try {
        adoptPayload(
          await api("/api/notes/" + encodeURIComponent(id), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content }),
          }),
        );
        local.error = "";
        local.saveTimer = null;
      } catch (error) {
        local.error = (error && error.message) || String(error);
        if (!local.saveTimer) local.saveTimer = "failed";
      } finally {
        local.saving = false;
      }
      syncSaveBadge();
    }

    async function saveTitle(id, title) {
      const note = noteById(id);
      if (!note || note.title === title) return;
      note.title = title;
      try {
        adoptPayload(
          await api("/api/notes/" + encodeURIComponent(id), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title }),
          }),
        );
        local.error = "";
      } catch (error) {
        local.error = (error && error.message) || String(error);
      }
      syncSaveBadge();
    }

    async function saveLanguage(id, language) {
      const note = noteById(id);
      if (!note || note.language === language) return;
      note.language = language;
      // The editor remounts so CodeMirror re-highlights with the new language.
      local.editorApi = null;
      render();
      remountEditor();
      try {
        adoptPayload(
          await api("/api/notes/" + encodeURIComponent(id), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ language }),
          }),
        );
        local.error = "";
      } catch (error) {
        local.error = (error && error.message) || String(error);
      }
      syncSaveBadge();
    }

    function scheduleSave() {
      if (local.saveTimer && local.saveTimer !== "failed") clearTimeout(local.saveTimer);
      local.saveTimer = setTimeout(() => {
        local.saveTimer = null;
        flushSave();
      }, SAVE_DEBOUNCE_MS);
      syncSaveBadge();
    }

    async function createNote() {
      try {
        const data = await api("/api/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "", content: "", language: "txt" }),
        });
        adoptPayload(data);
        local.editingId = (data && data.created_note_id) || null;
        local.editorApi = null;
        render();
        focusTitle();
      } catch (error) {
        local.error = (error && error.message) || String(error);
        render();
      }
    }

    async function deleteNote(id) {
      if (!id) return;
      if (local.saveTimer && local.saveTimer !== "failed") clearTimeout(local.saveTimer);
      local.saveTimer = null;
      try {
        adoptPayload(
          await api("/api/notes/" + encodeURIComponent(id), { method: "DELETE" }),
        );
        if (local.editingId === id) {
          local.editingId = null;
          local.editorApi = null;
        }
        render();
      } catch (error) {
        local.error = (error && error.message) || String(error);
        render();
      }
    }

    async function clearAll() {
      const ok = await confirm("Delete every note on this server? This cannot be undone.");
      if (!ok) return;
      if (local.saveTimer && local.saveTimer !== "failed") clearTimeout(local.saveTimer);
      local.saveTimer = null;
      try {
        adoptPayload(await api("/api/notes/clear", { method: "POST" }));
        local.editingId = null;
        local.editorApi = null;
        render();
      } catch (error) {
        local.error = (error && error.message) || String(error);
        render();
      }
    }

    function openNote(id) {
      local.editingId = id;
      local.editorApi = null;
      render();
      focusTitle();
    }

    function backToList() {
      const pending = local.saveTimer && local.saveTimer !== "failed";
      if (pending) {
        clearTimeout(local.saveTimer);
        local.saveTimer = null;
        flushSave();
      }
      local.editingId = null;
      local.editorApi = null;
      render();
    }

    function focusTitle() {
      setTimeout(() => {
        const input = document.getElementById("mobileNoteTitle");
        if (input && input.focus) input.focus({ preventScroll: true });
      }, 50);
    }

    function syncSaveBadge() {
      const badge = document.getElementById("mobileNoteSaveState");
      if (!badge) return;
      if (local.saving) {
        badge.textContent = "Saving…";
      } else if (local.saveTimer === "failed") {
        badge.textContent = "Save failed";
      } else if (local.saveTimer) {
        badge.textContent = "Unsaved";
      } else {
        badge.textContent = "Saved";
      }
    }

    function titleValue() {
      const note = local.editingId ? noteById(local.editingId) : null;
      return note ? String(note.title || "") : "";
    }

    function titleChange(event) {
      const id = local.editingId;
      if (id) saveTitle(id, event.target.value);
    }

    function languageChange(event) {
      const id = local.editingId;
      if (id) saveLanguage(id, event.target.value);
    }

    function rowHtml(note) {
      const id = escapeHtml(note.id);
      const title = escapeHtml(note.display_title || "Untitled");
      const language = escapeHtml(note.language || "txt");
      const updated = Number(note.updated_at || 0);
      const when = updated ? new Date(updated * 1000).toLocaleString() : "";
      // A button cannot nest inside a button: the parser hoists the Delete
      // out and both end up siblings anyway, so build them that way from
      // the start (same wrapper shape as the workspace rows).
      return `<div class="mobile-note-row-wrap"><button class="mobile-row mobile-note-row" onclick="HerdrMobileNotes.openNote('${id}')"><strong>${title}</strong><span class="mobile-note-meta"><span class="mobile-chip">${language}</span>${when ? " " + escapeHtml(when) : ""}</span></button><button class="mobile-btn mobile-note-delete" onclick="HerdrMobileNotes.deleteNote(event, '${id}')">Delete</button></div>`;
    }

    function renderScreen() {
      const notes = local.notes || [];
      const editing = local.editingId ? noteById(local.editingId) : null;
      if (editing) {
        return renderEditor(editing, notes.length);
      }
      const listBody = local.loading && !local.loaded
        ? '<div class="mobile-loading">Loading…</div>'
        : local.error
          ? `<div class="mobile-error">${escapeHtml(local.error)}</div>`
          : notes.length
            ? notes.map(rowHtml).join("")
            : '<div class="mobile-loading">No notes yet. Create one to get started.</div>';
      const syncLabel = local.syncFailed
        ? "Sync failed"
        : local.syncing ? "Syncing…" : "Sync";
      return `<section class="mobile-section mobile-notes" id="mobileNotesScreen" tabindex="0"><div class="mobile-files-head"><div><h2>Notes</h2><p class="mobile-help">${notes.length} note${notes.length === 1 ? "" : "s"} · shared with every client</p></div><div class="mobile-actions"><button class="mobile-btn" id="mobileNotesSync" onclick="HerdrMobileNotes.syncNow()"${local.syncing ? " disabled" : ""}>${syncLabel}</button><button class="mobile-btn primary" onclick="HerdrMobileNotes.createNote()">+ Note</button>${notes.length ? '<button class="mobile-btn danger" onclick="HerdrMobileNotes.clearAll()">Clear all</button>' : ""}</div></div>${local.error ? `<div class="mobile-error">${escapeHtml(local.error)}</div>` : ""}${listBody}</section>`;
    }

    function renderEditor(note, noteCount) {
      const options = languages()
        .map(
          (entry) =>
            `<option value="${escapeHtml(entry.value)}"${note.language === entry.value ? " selected" : ""}>${escapeHtml(entry.label)}</option>`,
        )
        .join("");
      const badge = local.saving
        ? "Saving…"
        : local.saveTimer === "failed" ? "Save failed" : local.saveTimer ? "Unsaved" : "Saved";
      return `<section class="mobile-section mobile-notes" id="mobileNotesScreen" tabindex="0"><div class="mobile-files-head"><div><h2>Notes</h2><p class="mobile-help">Editing · ${escapeHtml(note.display_title || "Untitled")}</p></div><div class="mobile-actions"><button class="mobile-btn" onclick="HerdrMobileNotes.backToList()">Back</button><button class="mobile-btn" id="mobileNoteSaveState" disabled>${badge}</button></div></div><div class="mobile-note-edit-head"><input id="mobileNoteTitle" class="mobile-note-title" placeholder="Note title"${inputAttrs("done")} value="${escapeHtml(titleValue())}" oninput="HerdrMobileNotes.titleInput(event)" onchange="HerdrMobileNotes.titleChange(event)" /><select id="mobileNoteLanguage" class="mobile-note-language" aria-label="Syntax language" onchange="HerdrMobileNotes.languageChange(event)">${options}</select></div>${local.error ? `<div class="mobile-error">${escapeHtml(local.error)}</div>` : ""}<div class="mobile-note-editor" id="mobileNoteEditor"></div></section>`;
    }

    function titleInput() {
      // The badge flips to Unsaved only for content edits; title changes
      // PUT immediately, so nothing schedules here.
    }

    function remountEditor() {
      const host = document.getElementById("mobileNoteEditor");
      if (!host) return;
      const note = local.editingId ? noteById(local.editingId) : null;
      if (!note) return;
      const Editor = globalThis.HerdrEditor;
      if (!Editor || !Editor.create) {
        host.innerHTML = '<div class="mobile-loading">Editor unavailable.</div>';
        return;
      }
      host.innerHTML = "";
      const api = Editor.create({
        parent: host,
        path: "note." + languageExt(note.language || "txt"),
        content: String(note.content || ""),
        readonly: false,
        hideHeader: true,
        onChange(value) {
          note.content = value;
          scheduleSave();
        },
      });
      local.editorApi = api;
      if (local.saving) {
        const badge = document.getElementById("mobileNoteSaveState");
        if (badge) badge.textContent = "Saving…";
      }
    }

    function afterRender() {
      if (!local.editingId) return;
      if (local.editorApi && document.getElementById("mobileNoteEditor"))
        return;
      remountEditor();
    }

    function applyRemote(message) {
      if (!screenVisible()) return;
      const payload = Array.isArray(message) ? { notes: message } : message || {};
      const incoming = Array.isArray(payload.notes) ? payload.notes : [];
      if (Array.isArray(payload.languages) && payload.languages.length)
        local.languages = payload.languages;
      if (adoptIncoming(incoming)) render();
      else syncSaveBadge();
    }

    function enter() {
      if (!local.loaded && !local.loading) load();
      startResyncTimer();
    }

    function leave() {
      stopResyncTimer();
      if (local.saveTimer && local.saveTimer !== "failed") {
        clearTimeout(local.saveTimer);
        local.saveTimer = null;
        flushSave();
      }
    }

    function syncNow() {
      return sync(true);
    }

    return {
      load,
      enter,
      leave,
      renderScreen,
      afterRender,
      applyRemote,
      createNote,
      openNote,
      backToList,
      deleteNote: (eventOrId, maybeId) => {
        // Row markup passes (event, id); direct calls pass (id).
        const id = maybeId != null ? maybeId : eventOrId;
        const event = maybeId != null ? eventOrId : null;
        if (event && event.stopPropagation) event.stopPropagation();
        return deleteNote(id);
      },
      clearAll,
      syncNow,
      titleChange,
      titleInput,
      languageChange,
      state: local,
    };
  }

  globalThis.HerdrMobileNotesModule = { create: createMobileNotes };
})();
