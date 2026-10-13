(function () {
  function createGitUiDiffSearch({ active, Syntax, diffLayoutMode, rowsFromChunk }) {
    function highlight(code, path) {
      return Syntax().highlight(code, path);
    }

    function highlightDiffText(code, path) {
      const query = diffSearchQuery();
      if (!query) return highlight(code, path);
      const text = String(code == null ? "" : code);
      const lower = text.toLowerCase();
      const needle = query.toLowerCase();
      let index = 0;
      let html = "";
      while (index < text.length) {
        const found = lower.indexOf(needle, index);
        if (found < 0) break;
        if (found > index) html += highlight(text.slice(index, found), path);
        html += `<mark class="git-ui-search-match">${highlight(text.slice(found, found + query.length), path)}</mark>`;
        index = found + query.length;
      }
      return html + highlight(text.slice(index), path);
    }

    function diffSearchQuery() {
      const view = active() || {};
      return String(view.diffSearchQuery || "").trim();
    }

    function canSearchDiff(view) {
      if (!view || view.sideEditor) return false;
      if (["history", "log", "stash", "cleanup", "conflicts"].includes(view.tab)) return false;
      return !!(((view.diff || {}).files || []).length || view.file);
    }

    function countTextMatches(value, query) {
      const needle = String(query || "").trim().toLowerCase();
      if (!needle) return 0;
      const text = String(value == null ? "" : value).toLowerCase();
      let count = 0;
      let index = 0;
      while (index < text.length) {
        const found = text.indexOf(needle, index);
        if (found < 0) break;
        count++;
        index = found + needle.length;
      }
      return count;
    }

    // Server counts matches per file (file.match_count) when the diff was
    // fetched with q=. Fall back to local counting when the payload predates
    // that (no match_count and no rows), so an old cached diff still shows
    // a count instead of a silent zero.
    function diffSearchMatchCount(view, query) {
      const needle = String(query || "").trim();
      if (!needle) return 0;
      const files = (view && view.diff && view.diff.files) || [];
      const counted = files.map((file) => file.match_count);
      const everyFileHasCount = counted.every((value) => typeof value === "number");
      if (everyFileHasCount) return counted.reduce((total, value) => total + value, 0);
      const unified = diffLayoutMode() === "unified";
      return files.reduce((total, file) => {
        return total + ((file.chunks || []).reduce((fileTotal, chunk) => {
          const rows = rowsFromChunk(chunk);
          return fileTotal + rows.reduce((lineTotal, row) => {
            if (unified) return lineTotal + countTextMatches((row.line || {}).content || "", needle);
            return lineTotal
              + countTextMatches((row.old_line || {}).content || "", needle)
              + countTextMatches((row.new_line || {}).content || "", needle);
          }, 0);
        }, 0));
      }, 0);
    }
    return {
      diffSearchQuery,
      highlightDiffText,
      canSearchDiff,
      countTextMatches,
      diffSearchMatchCount,
    };
  }
  globalThis.HerdrGitUiDiffSearchModule = { create: createGitUiDiffSearch };
})();
