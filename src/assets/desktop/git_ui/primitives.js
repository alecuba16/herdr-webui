(function () {
  function createGitUiPrimitives() {
    function gitUiOptions() {
      try {
        return window.HerdrOptions ? window.HerdrOptions.read() : {};
      } catch (_) {
        return {};
      }
    }

    function explorationDefaultDirectory() {
      return String(gitUiOptions().explorationDefaultDirectory || "").trim();
    }

    function largeDiffLineLimit() {
      const value = Number(gitUiOptions().gitUiLargeDiffLineLimit);
      return Number.isFinite(value) ? Math.max(0, value) : 2000;
    }

    function largeChangeFileLimit() {
      const value = Number(gitUiOptions().gitUiLargeChangeFileLimit);
      return Number.isFinite(value) ? Math.max(0, value) : 25;
    }

    function largeSectionFileLimit() {
      const value = Number(gitUiOptions().gitUiLargeSectionFileLimit);
      return Number.isFinite(value) ? Math.max(0, value) : 250;
    }

    function fileListMode() {
      return gitUiOptions().gitUiFileListMode === "flat" ? "flat" : "tree";
    }

    function diffLayoutMode() {
      return gitUiOptions().gitUiDiffLayout === "unified" ? "unified" : "side-by-side";
    }

    function gitLogDefaultBranch() {
      return String(gitUiOptions().gitUiDefaultBranch || "master").trim() || "master";
    }

    function gitRemoteBranchPreload() {
      const value = Number(gitUiOptions().gitUiRemoteBranchPreload);
      return Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 10;
    }

    function normalizeLogScope(scope) {
      return ["all", "base-current", "base"].includes(scope) ? scope : "all";
    }

    function setGitUiOption(key, value) {
      try { window.HerdrOptions.update(function (options) { options[key] = value; }); } catch (_) {}
    }

    function diffLineCount(files) {
      return (files || []).reduce((total, file) => total + (file.chunks || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0), 0);
    }

    function diffFileLineCount(file) {
      return ((file && file.chunks) || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0);
    }

    function loadedLargeDiffPreviewLimit() {
      return 1200;
    }

    function previewDiffFile(file, limit) {
      let remaining = Math.max(0, limit);
      const chunks = [];
      for (const chunk of (file && file.chunks) || []) {
        if (remaining <= 0) break;
        const lines = previewChunkLines(chunk.lines || [], remaining);
        if (!lines.length) break;
        remaining -= lines.length;
        chunks.push(Object.assign({}, chunk, { lines }));
      }
      return Object.assign({}, file, { chunks, preview_large_diff: true });
    }

    function diffFileKey(fileOrPath, kind) {
      const path = typeof fileOrPath === "string" ? fileOrPath : (fileOrPath && fileOrPath.path) || "";
      const diffKind = typeof fileOrPath === "string" ? kind || "" : (fileOrPath && fileOrPath.diff_kind) || "";
      return `${diffKind}:${path}`;
    }

    function previewChunkLines(lines, limit) {
      const out = [];
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        const line = lines[i];
        if (line.line_type !== "delete") {
          out.push(line);
          continue;
        }
        const group = [];
        while (lines[i] && lines[i].line_type === "delete") group.push(lines[i++]);
        while (lines[i] && lines[i].line_type === "add") group.push(lines[i++]);
        i--;
        if (out.length + group.length > limit) break;
        out.push(...group);
      }
      return out;
    }

    function changeSetFileCount(status) {
      const seen = new Set([...(status.conflicted || []), ...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].filter(Boolean));
      return seen.size;
    }

    function hashText(value) {
      let hash = 0;
      const text = String(value || "");
      for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      return Math.abs(hash).toString(16);
    }

    function esc(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function arg(value) {
      return encodeURIComponent(String(value == null ? "" : value)).replace(/'/g, "%27");
    }
    return {
      gitUiOptions,
      explorationDefaultDirectory,
      largeDiffLineLimit,
      largeChangeFileLimit,
      largeSectionFileLimit,
      fileListMode,
      diffLayoutMode,
      gitLogDefaultBranch,
      gitRemoteBranchPreload,
      normalizeLogScope,
      setGitUiOption,
      diffLineCount,
      diffFileLineCount,
      loadedLargeDiffPreviewLimit,
      previewDiffFile,
      diffFileKey,
      previewChunkLines,
      changeSetFileCount,
      hashText,
      esc,
      arg,
    };
  }
  globalThis.HerdrGitUiPrimitivesModule = { create: createGitUiPrimitives };
})();
