(function () {
  function createGitUiConflicts({ active, esc, arg, currentMode, diffLayoutMode }) {
    function renderSideEditor(view) {
      const editor = view.sideEditor || {};
      if (editor.loading) return `<div class="git-ui-editor"><div class="git-ui-loading"><span></span><strong>Loading file editor</strong></div></div>`;
      const layout = diffLayoutMode();
      const note = editor.error
        ? `<div class="git-ui-side-edit-note error">${esc(editor.error)}</div>`
        : `<div class="git-ui-side-edit-note">${esc(editNoteForLayout(layout))}</div>`;
      const renderHunk = layout === "unified" ? renderEditableHunkUnified : renderEditableHunk;
      const hunks = (editor.hunks || []).map(renderHunk).join("") || `<div class="git-ui-muted">No editable hunks for this file.</div>`;
      return `${note}<div class="git-ui-hunk-editor-list">${hunks}</div>`;
    }

    function editNoteForLayout(layout) {
      return layout === "unified"
        ? "Edit the hunk text below. Save merges hunk edits into the file and recalculates the diff."
        : "Edit current hunk text on the right. Previous hunk stays read-only. Save merges hunk edits into file and recalculates diff.";
    }

    function renderEditableHunk(hunk) {
      const oldText = hunk.oldText || "";
      const currentText = hunk.text || "";
      const readonly = hunk.newStart ? "" : " readonly";
      const meta = hunk.newStart ? `current lines ${hunk.newStart}-${hunk.newEnd}` : "no current lines";
      const conflictControls = renderEditableHunkConflictControls(hunk);
      return `<div class="git-ui-hunk-editor"><div class="git-ui-hunk-head"><span>${esc(hunk.header || "hunk")}</span><span class="git-ui-muted">${esc(meta)}</span></div>${conflictControls}<div class="git-ui-hunk-editor-grid"><section><div class="git-ui-editor-head"><strong>Previous</strong><span class="git-ui-muted">read-only</span></div><div class="git-ui-hunk-edit-mount git-ui-hunk-old-mount" data-hunk-index="${hunk.index}" data-editor-side="old" data-readonly="true"></div><textarea class="git-ui-hunk-old git-ui-hunk-old-hidden git-ui-hunk-edit-hidden" data-hunk-index="${hunk.index}" spellcheck="false" readonly>${esc(oldText)}</textarea></section><section><div class="git-ui-editor-head"><strong>Current</strong><span class="git-ui-muted">editable hunk</span></div><div class="git-ui-hunk-edit-mount git-ui-hunk-current-mount" data-hunk-index="${hunk.index}" data-editor-side="current" data-readonly="${hunk.newStart ? "false" : "true"}"></div><textarea class="git-ui-hunk-edit git-ui-hunk-current-hidden git-ui-hunk-edit-hidden" data-hunk-index="${hunk.index}" spellcheck="false"${readonly}>${esc(currentText)}</textarea></section></div></div>`;
    }

    function renderEditableHunkUnified(hunk) {
      const currentText = hunk.text || "";
      const readonly = hunk.newStart ? "" : " readonly";
      const meta = hunk.newStart ? `current lines ${hunk.newStart}-${hunk.newEnd}` : "no current lines";
      const conflictControls = renderEditableHunkConflictControls(hunk);
      return `<div class="git-ui-hunk-editor git-ui-hunk-editor-unified"><div class="git-ui-hunk-head"><span>${esc(hunk.header || "hunk")}</span><span class="git-ui-muted">${esc(meta)}</span></div>${conflictControls}<div class="git-ui-hunk-editor-grid git-ui-hunk-editor-grid-unified"><section><div class="git-ui-editor-head"><strong>Current</strong><span class="git-ui-muted">editable hunk</span></div><div class="git-ui-hunk-edit-mount git-ui-hunk-current-mount" data-hunk-index="${hunk.index}" data-editor-side="current" data-readonly="${hunk.newStart ? "false" : "true"}"></div><textarea class="git-ui-hunk-edit git-ui-hunk-current-hidden git-ui-hunk-edit-hidden" data-hunk-index="${hunk.index}" spellcheck="false"${readonly}>${esc(currentText)}</textarea></section></div></div>`;
    }

    function renderEditableHunkConflictControls(hunk) {
      const blocks = conflictBlocksInText(hunk.text || "");
      if (!blocks.length) return "";
      const buttons = blocks.map((block, index) => {
        const parentDisabled = block.base == null ? " disabled" : "";
        const parentTitle = block.base == null ? "Parent/base side is unavailable for this conflict block" : "Use parent/base side for this conflict block";
        return `<div class="git-ui-conflict-block-actions"><span class="git-ui-muted">Conflict block ${index + 1}</span><button class="git-ui-btn" title="Use HEAD/current side for this conflict block" onclick="HerdrGitUi.resolveEditorConflictBlock(${hunk.index},${index},'ours')">Use HEAD</button><button class="git-ui-btn" title="${esc(parentTitle)}" onclick="HerdrGitUi.resolveEditorConflictBlock(${hunk.index},${index},'base')"${parentDisabled}>Use parent</button><button class="git-ui-btn" title="Use remote/incoming side for this conflict block" onclick="HerdrGitUi.resolveEditorConflictBlock(${hunk.index},${index},'theirs')">Use remote</button></div>`;
      }).join("");
      return `<div class="git-ui-editor-conflicts"><div class="git-ui-side-edit-note">Resolve individual conflict marker blocks in the editable hunk.</div>${buttons}</div>`;
    }

    function conflictBlocksInText(text) {
      const lines = String(text || "").split("\n");
      const blocks = [];
      let start = -1;
      let separator = -1;
      let end = -1;
      let baseStart = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] || "";
        if (line.startsWith("<<<<<<<")) {
          start = i;
          separator = -1;
          end = -1;
          baseStart = -1;
          continue;
        }
        if (start < 0) continue;
        if (line.startsWith("|||||||")) {
          baseStart = i;
          continue;
        }
        if (line.startsWith("=======")) {
          separator = i;
          continue;
        }
        if (!line.startsWith(">>>>>>>")) continue;
        end = i;
        if (separator > start) {
          const oursEnd = baseStart > start ? baseStart : separator;
          blocks.push({
            start,
            end,
            ours: lines.slice(start + 1, oursEnd),
            base: baseStart > start ? lines.slice(baseStart + 1, separator) : null,
            theirs: lines.slice(separator + 1, end),
          });
        }
        start = -1;
        separator = -1;
        end = -1;
        baseStart = -1;
      }
      return blocks;
    }

    function resolveConflictBlockText(text, blockIndex, mode) {
      const lines = String(text || "").split("\n");
      const block = conflictBlocksInText(text)[blockIndex];
      if (!block) return text;
      const replacement = mode === "theirs" ? block.theirs : mode === "base" ? block.base : block.ours;
      if (!replacement) return text;
      lines.splice(block.start, block.end - block.start + 1, ...replacement);
      return lines.join("\n");
    }

    function buildEditableHunks(file) {
      return ((file && file.chunks) || []).map((chunk, index) => {
        const oldLines = [];
        const newLines = [];
        const newNumbers = [];
        const oldLineTypes = [];
        const newLineTypes = [];
        for (const line of chunk.lines || []) {
          if (line.line_type !== "add") {
            oldLines.push(line.content || "");
            oldLineTypes.push(line.line_type === "delete" ? "del" : "context");
          }
          if (line.line_type !== "delete") {
            newLines.push(line.content || "");
            newLineTypes.push(line.line_type === "add" ? "add" : "context");
            if (line.new_line_number) newNumbers.push(line.new_line_number);
          }
        }
        return {
          index,
          header: chunk.header,
          oldText: oldLines.join("\n"),
          text: newLines.join("\n"),
          oldLineTypes,
          newLineTypes,
          newStart: newNumbers.length ? Math.min.apply(null, newNumbers) : 0,
          newEnd: newNumbers.length ? Math.max.apply(null, newNumbers) : 0,
        };
      });
    }

    function sideEditorOriginalLineClasses(hunk, side) {
      const types = side === "old" ? (hunk.oldLineTypes || []) : (hunk.newLineTypes || []);
      const classForType = { del: "git-ui-side-line-del", add: "git-ui-side-line-add" };
      const result = [];
      let i = 0;
      while (i < types.length) {
        const className = classForType[types[i]] || "";
        if (!className) { i++; continue; }
        let j = i;
        while (j < types.length && classForType[types[j]] === className) j++;
        result.push({ fromLine: i + 1, toLine: j, className });
        i = j;
      }
      return result;
    }

    function changedLineClasses(baseText, currentText) {
      if (String(baseText || "") === String(currentText || "")) return [];
      const baseLines = String(baseText || "").split("\n");
      const currentLines = String(currentText || "").split("\n");
      const changed = changedCurrentLineIndexes(baseLines, currentLines);
      return lineIndexesToRanges(changed, "git-ui-side-line-edit");
    }

    function changedCurrentLineIndexes(baseLines, currentLines) {
      const maxCells = 40000;
      if (baseLines.length * currentLines.length > maxCells) return changedCurrentLineIndexesByBounds(baseLines, currentLines);
      const rows = baseLines.length + 1;
      const cols = currentLines.length + 1;
      const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
      for (let i = baseLines.length - 1; i >= 0; i--) {
        for (let j = currentLines.length - 1; j >= 0; j--) {
          dp[i][j] = baseLines[i] === currentLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const matched = new Set();
      let i = 0;
      let j = 0;
      while (i < baseLines.length && j < currentLines.length) {
        if (baseLines[i] === currentLines[j]) {
          matched.add(j);
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          i++;
        } else {
          j++;
        }
      }
      const changed = [];
      for (let line = 0; line < currentLines.length; line++) {
        if (!matched.has(line)) changed.push(line);
      }
      return changed.length ? changed : changedCurrentLineIndexesByBounds(baseLines, currentLines);
    }

    function changedCurrentLineIndexesByBounds(baseLines, currentLines) {
      let start = 0;
      while (start < baseLines.length && start < currentLines.length && baseLines[start] === currentLines[start]) start++;
      let baseEnd = baseLines.length - 1;
      let currentEnd = currentLines.length - 1;
      while (baseEnd >= start && currentEnd >= start && baseLines[baseEnd] === currentLines[currentEnd]) {
        baseEnd--;
        currentEnd--;
      }
      const changed = [];
      if (currentEnd < start && currentLines.length) return [Math.min(start, currentLines.length - 1)];
      for (let line = start; line <= currentEnd; line++) changed.push(line);
      return changed;
    }

    function lineIndexesToRanges(indexes, className) {
      const result = [];
      let i = 0;
      while (i < indexes.length) {
        const start = indexes[i];
        let end = start;
        i++;
        while (i < indexes.length && indexes[i] === end + 1) {
          end = indexes[i];
          i++;
        }
        result.push({ fromLine: start + 1, toLine: end + 1, className });
      }
      return result;
    }

    function isConflictPath(path) {
      const files = (((active() || {}).status || {}).conflicted || []);
      return files.includes(path);
    }

    function renderConflictResolutionButtons(file, className = "git-ui-conflict-file-actions", markLabel = "Mark resolved (stage)") {
      return `<span class="${className}"><button class="git-ui-btn" title="Use HEAD/current side" onclick="HerdrGitUi.resolve('${arg(file)}','ours')">Use HEAD</button><button class="git-ui-btn" title="Use parent/base version" onclick="HerdrGitUi.resolve('${arg(file)}','base')">Use parent</button><button class="git-ui-btn" title="Use remote/incoming side" onclick="HerdrGitUi.resolve('${arg(file)}','theirs')">Use remote</button><button class="git-ui-btn" title="Stage this manually edited file as resolved" onclick="HerdrGitUi.resolve('${arg(file)}','mark')">${esc(markLabel)}</button></span>`;
    }

    function renderDiffConflictResolutionButtons(file) {
      if (currentMode() !== "changes" || !isConflictPath(file.path)) return "";
      return renderConflictResolutionButtons(file.path, "git-ui-conflict-file-actions git-ui-conflict-diff-actions", "Mark resolved");
    }

    return {
      renderSideEditor,
      editNoteForLayout,
      renderEditableHunk,
      renderEditableHunkUnified,
      renderEditableHunkConflictControls,
      conflictBlocksInText,
      resolveConflictBlockText,
      buildEditableHunks,
      isConflictPath,
      renderConflictResolutionButtons,
      renderDiffConflictResolutionButtons,
      sideEditorOriginalLineClasses,
      changedLineClasses,
      changedCurrentLineIndexes,
      changedCurrentLineIndexesByBounds,
      lineIndexesToRanges,
    };
  }

  globalThis.HerdrGitUiConflictsModule = { create: createGitUiConflicts };
})();
