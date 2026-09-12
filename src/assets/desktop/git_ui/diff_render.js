(function () {
  function createGitUiDiffRender({
    state,
    active,
    api,
    render,
    esc,
    arg,
    currentMode,
    canMutateDiff,
    diffLayoutMode,
    highlightDiffText,
  }) {
    function ensureBlame(path) {
      const view = active();
      if (!view || !path || view.blame[path] !== undefined || currentMode() === "readonly-compare") return;
      view.blame[path] = null;
      const ref = currentMode() === "changes" || currentMode() === "current-compare" ? "working" : (view.compareTarget || "HEAD");
      api(`/api/git-ui/blame?cwd=${encodeURIComponent(view.cwd)}&file=${encodeURIComponent(path)}&ref_name=${encodeURIComponent(ref)}`)
        .then((data) => {
          view.blame[path] = parseBlame(data.text || "");
          if (state.visible) render();
        })
        .catch((err) => {
          view.blame[path] = { __error: err.message || String(err) };
          if (state.visible) render();
        });
    }

    function parseBlame(text) {
      const byLine = {};
      let author = "";
      let finalLine = 0;
      for (const line of String(text || "").split("\n")) {
        const header = line.match(/^[0-9a-f]{40}\s+\d+\s+(\d+)/);
        if (header) {
          finalLine = Number(header[1]) || 0;
          author = "";
          continue;
        }
        if (line.startsWith("author ")) {
          author = line.slice(7).trim();
          if (finalLine) byLine[finalLine] = author;
        }
      }
      return byLine;
    }

    function blameName(path, lineNumber) {
      const view = active() || {};
      if (!view.showBlame) return "";
      const blame = view.blame && view.blame[path];
      if (blame && blame.__error) return "blame unavailable";
      const name = blame && lineNumber ? blame[lineNumber] : "";
      if (!name) return "";
      return String(name).split(/\s+/).slice(0, 2).join(" ");
    }

    function renderChunk(file, chunk, index) {
      const path = file.path;
      const scope = (active() || {}).diffScope || "all";
      const hunkButton = file.preview_large_diff
        ? `<span class="git-ui-muted">render full diff for hunk actions</span>`
        : scope === "staged"
        ? `<button class="git-ui-btn" title="Unstage this hunk" onclick="HerdrGitUi.unstageHunk('${arg(path)}',${index})">Unstage hunk</button>`
        : scope === "working"
        ? `<button class="git-ui-btn" title="Stage this hunk" onclick="HerdrGitUi.stageHunk('${arg(path)}',${index})">Stage hunk</button>`
        : `<span class="git-ui-muted">select staged/unstaged file for hunk actions</span>`;
      const actions = canMutateDiff()
        ? `<span class="git-ui-hunk-actions">${hunkButton}</span>`
        : `<span class="git-ui-muted">read only</span>`;
      const rows = markChangeGroups(diffLayoutMode() === "unified" ? unifiedRows(chunk) : sideBySideRows(chunk));
      const contextArrows = contextArrowsForChunk(file.chunks || [], index);
      const body = diffLayoutMode() === "unified"
        ? rows.map((row, rowIndex) => renderUnifiedLine(row, path, index, rows, rowIndex, contextArrows, !!file.preview_large_diff)).join("")
        : rows.map((row, rowIndex) => renderLine(row, path, index, rows, rowIndex, contextArrows, !!file.preview_large_diff)).join("");
      return `<div class="git-ui-hunk ${diffLayoutMode() === "unified" ? "git-ui-hunk-unified" : ""}"><div class="git-ui-hunk-head"><span>${esc(chunk.header)}</span>${actions}</div><div class="git-ui-hunk-viewport">${body}</div><div class="git-ui-hunk-xscroll" aria-hidden="true"><div class="git-ui-hunk-xscroll-inner"></div></div></div>`;
    }

    function contextArrowsForChunk(chunks, index) {
      const chunk = chunks[index] || {};
      const prev = chunks[index - 1] || null;
      const next = chunks[index + 1] || null;
      const before = prev
        ? hiddenGap(prev, chunk)
        : (chunk.old_start || 0) > 1 || (chunk.new_start || 0) > 1;
      const after = next ? hiddenGap(chunk, next) : false;
      return { before, after };
    }

    function hiddenGap(left, right) {
      return ((right.old_start || 0) - hunkEnd(left, "old")) > 1 || ((right.new_start || 0) - hunkEnd(left, "new")) > 1;
    }

    function hunkEnd(chunk, side) {
      const start = side === "old" ? chunk.old_start : chunk.new_start;
      const count = side === "old" ? chunk.old_lines : chunk.new_lines;
      return (start || 0) + Math.max(0, (count || 0) - 1);
    }

    function unifiedRows(chunk) {
      return (chunk.lines || []).map((line) => ({ line }));
    }

    function sideBySideRows(chunk) {
      const lines = chunk.lines || [];
      const rows = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.line_type === "delete") {
          const deletes = [];
          const adds = [];
          while (lines[i] && lines[i].line_type === "delete") deletes.push(lines[i++]);
          while (lines[i] && lines[i].line_type === "add") adds.push(lines[i++]);
          i--;
          const count = Math.max(deletes.length, adds.length);
          for (let j = 0; j < count; j++) rows.push({ oldLine: deletes[j] || null, newLine: adds[j] || null });
        } else if (line.line_type === "add") {
          rows.push({ oldLine: null, newLine: line });
        } else {
          rows.push({ oldLine: line, newLine: line });
        }
      }
      return rows;
    }

    function renderLine(row, path, hunkIndex, rows, rowIndex, contextArrows, previewLargeDiff) {
      const view = active() || {};
      const scope = view.diffScope || "all";
      const oldLine = row.oldLine;
      const newLine = row.newLine;
      const add = newLine && newLine.line_type === "add";
      const del = oldLine && oldLine.line_type === "delete";
      let cls = add && del ? "git-ui-change" : add ? "git-ui-add" : del ? "git-ui-del" : "";
      if (row.groupStart) cls += " git-ui-change-start";
      if (row.groupEnd) cls += " git-ui-change-end";
      const oldNo = oldLine && oldLine.old_line_number ? oldLine.old_line_number : "";
      const newNo = newLine && newLine.new_line_number ? newLine.new_line_number : "";
      const oldAuthor = blameName(path, oldNo);
      const newAuthor = blameName(path, newNo);
      const status = view.status || {};
      const canRestorePath = scope === "staged" || scope === "working" || (scope === "all" && ([...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].includes(path)));
      const blockButton = !previewLargeDiff && currentMode() === "changes" && canRestorePath && (add || del) && isFirstChange(rows, rowIndex)
        ? `<button class="git-ui-line-action" title="Restore this block" onclick="HerdrGitUi.restoreHunk('${arg(path)}',${hunkIndex})">&gt;&gt;</button>`
        : `<span class="git-ui-line-action-spacer"></span>`;
      const contextControls = rowIndex === 0 && contextArrows.before
        ? `<button class="git-ui-context-arrow" title="Expand lines before; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↑</button>`
        : rowIndex === rows.length - 1 && contextArrows.after
          ? `<button class="git-ui-context-arrow" title="Expand lines after; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↓</button>`
          : "";
      const oldCode = oldLine ? renderDiffCode(oldLine, newLine, path, "old") : "";
      const newCode = newLine ? renderDiffCode(oldLine, newLine, path, "new") : "";
      return `<div class="git-ui-diff-row ${cls}"><div class="git-ui-context-cell">${contextControls}</div><div class="git-ui-code git-ui-code-old"><span class="git-ui-code-text">${oldCode}</span></div><div class="git-ui-line-pair"><span class="git-ui-line-old"><em>${esc(oldAuthor)}</em>${oldNo}</span>${blockButton}<span class="git-ui-line-new"><em>${esc(newAuthor)}</em>${newNo}</span></div><div class="git-ui-code git-ui-code-new"><span class="git-ui-code-text">${newCode}</span></div></div>`;
    }

    function renderUnifiedLine(row, path, hunkIndex, rows, rowIndex, contextArrows, previewLargeDiff) {
      const view = active() || {};
      const scope = view.diffScope || "all";
      const line = row.line || {};
      const add = line.line_type === "add";
      const del = line.line_type === "delete";
      let cls = add ? "git-ui-add" : del ? "git-ui-del" : "git-ui-context";
      if (row.groupStart) cls += " git-ui-change-start";
      if (row.groupEnd) cls += " git-ui-change-end";
      const oldNo = line.old_line_number || "";
      const newNo = line.new_line_number || "";
      const author = blameName(path, newNo || oldNo);
      const status = view.status || {};
      const canRestorePath = scope === "staged" || scope === "working" || (scope === "all" && ([...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].includes(path)));
      const blockButton = !previewLargeDiff && currentMode() === "changes" && canRestorePath && (add || del) && isFirstChange(rows, rowIndex)
        ? `<button class="git-ui-line-action" title="Restore this block" onclick="HerdrGitUi.restoreHunk('${arg(path)}',${hunkIndex})">↩</button>`
        : `<span class="git-ui-line-action-spacer"></span>`;
      const contextControls = rowIndex === 0 && contextArrows.before
        ? `<button class="git-ui-context-arrow" title="Expand lines before; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↑</button>`
        : rowIndex === rows.length - 1 && contextArrows.after
          ? `<button class="git-ui-context-arrow" title="Expand lines after; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↓</button>`
          : "";
      const sign = add ? "+" : del ? "-" : " ";
      const code = renderUnifiedDiffCode(line, rows, rowIndex, path);
      return `<div class="git-ui-unified-row ${cls}"><div class="git-ui-context-cell">${contextControls}</div><div class="git-ui-unified-lines"><span>${oldNo}</span><span>${newNo}</span></div><div class="git-ui-unified-action">${blockButton}</div><div class="git-ui-code git-ui-code-unified"><span class="git-ui-unified-author">${esc(author)}</span><span class="git-ui-unified-sign">${sign}</span><span class="git-ui-unified-text"><span class="git-ui-code-text">${code}</span></span></div></div>`;
    }

    function renderUnifiedDiffCode(line, rows, rowIndex, path) {
      if (!line || !["delete", "add"].includes(line.line_type)) return highlightDiffText((line && line.content) || "", path);
      const pair = unifiedChangePair(rows, rowIndex);
      if (!pair) return highlightDiffText(line.content || "", path);
      return renderDiffCode(pair.oldLine, pair.newLine, path, line.line_type === "delete" ? "old" : "new");
    }

    function unifiedChangePair(rows, rowIndex) {
      const line = rows[rowIndex] && rows[rowIndex].line;
      if (!line || !["delete", "add"].includes(line.line_type)) return null;
      let start = rowIndex;
      while (start > 0 && isChangedRow(rows[start - 1])) start--;
      let end = rowIndex;
      while (end + 1 < rows.length && isChangedRow(rows[end + 1])) end++;
      const deletes = [];
      const adds = [];
      for (let i = start; i <= end; i++) {
        const item = rows[i] && rows[i].line;
        if (item && item.line_type === "delete") deletes.push({ line: item, rowIndex: i });
        if (item && item.line_type === "add") adds.push({ line: item, rowIndex: i });
      }
      if (!deletes.length || !adds.length) return null;
      const list = line.line_type === "delete" ? deletes : adds;
      const index = Math.max(0, list.findIndex((item) => item.rowIndex === rowIndex));
      const otherIndex = Math.min(index, (line.line_type === "delete" ? adds : deletes).length - 1);
      return line.line_type === "delete"
        ? { oldLine: line, newLine: adds[otherIndex].line }
        : { oldLine: deletes[otherIndex].line, newLine: line };
    }

    function renderDiffCode(oldLine, newLine, path, side) {
      const line = side === "old" ? oldLine : newLine;
      if (!line) return "";
      if (!oldLine || !newLine || oldLine.line_type !== "delete" || newLine.line_type !== "add") {
        return highlightDiffText(line.content, path);
      }
      const parts = changedMiddle(oldLine.content || "", newLine.content || "");
      const content = side === "old" ? oldLine.content || "" : newLine.content || "";
      const changed = side === "old" ? parts.oldChanged : parts.newChanged;
      if (!changed.length) return highlightDiffText(content, path);
      return `${highlightDiffText(content.slice(0, changed.start), path)}<span class="git-ui-word-change">${highlightDiffText(content.slice(changed.start, changed.end), path)}</span>${highlightDiffText(content.slice(changed.end), path)}`;
    }

    function changedMiddle(oldText, newText) {
      let start = 0;
      while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
      let oldEnd = oldText.length;
      let newEnd = newText.length;
      while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      return { oldChanged: { start, end: oldEnd, length: oldEnd - start }, newChanged: { start, end: newEnd, length: newEnd - start } };
    }

    function markChangeGroups(rows) {
      for (let i = 0; i < rows.length; i++) {
        const changed = isChangedRow(rows[i]);
        if (!changed) continue;
        if (!isChangedRow(rows[i - 1])) rows[i].groupStart = true;
        if (!isChangedRow(rows[i + 1])) rows[i].groupEnd = true;
      }
      return rows;
    }

    function isChangedRow(row) {
      return !!(row && ((row.oldLine && row.oldLine.line_type === "delete") || (row.newLine && row.newLine.line_type === "add") || (row.line && (row.line.line_type === "add" || row.line.line_type === "delete"))));
    }

    function isFirstChange(rows, rowIndex) {
      return !!(rows[rowIndex] && rows[rowIndex].groupStart);
    }

    return {
      ensureBlame,
      parseBlame,
      blameName,
      renderChunk,
      contextArrowsForChunk,
      hiddenGap,
      hunkEnd,
      unifiedRows,
      sideBySideRows,
      renderLine,
      renderUnifiedLine,
      renderUnifiedDiffCode,
      unifiedChangePair,
      renderDiffCode,
      changedMiddle,
      markChangeGroups,
      isChangedRow,
      isFirstChange,
    };
  }

  globalThis.HerdrGitUiDiffRenderModule = { create: createGitUiDiffRender };
})();