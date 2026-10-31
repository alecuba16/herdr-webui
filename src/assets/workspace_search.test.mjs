import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// One compiled script per product file so coverage attributes each file's
// lines to its real disk path; the script is built once and reused.
const source = readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8");
const workspaceSearchScript = new vm.Script(source, {
  filename: fileURLToPath(new URL("./shared/workspace_search.js", import.meta.url)),
});

function loadWorkspaceSearch(options = {}) {
  const requests = [];
  const context = {
    window: null,
    globalThis: null,
    HerdrFileTree: {
      normalizeSearchKind: (kind) => (kind === "dir" ? "dir" : "file"),
      searchKindQuery: (kind) => `search_kind=${kind}`,
    },
    HerdrAppHelpers: {
      normalizeOrder: (value, allowed) => Array.isArray(value) ? value : allowed,
    },
    HerdrOptions: { read: () => options },
    fetch: async (url, requestOptions) => {
      requests.push({ url, requestOptions });
      return { ok: true, statusText: "OK", json: async () => ({ file: { path: "src/app.rs" } }) };
    },
  };
  context.window = context;
  context.globalThis = context;
  workspaceSearchScript.runInNewContext(context);
  return { search: context.HerdrWorkspaceSearch, requests };
}

test("searchContentFile encodes the file query and clamps expansion limits", async () => {
  const { search, requests } = loadWorkspaceSearch();

  const response = await search.searchContentFile({
    cwd: "/repo",
    file: "src/a b.rs",
    query: "needle x",
    contextLines: 99,
    matchesPerFile: 999,
    matchCase: true,
    regex: true,
  });

  assert.deepEqual(response, { file: { path: "src/app.rs" } });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/api\/file-browser\/content-search\/file\?/);
  assert.match(requests[0].url, /cwd=%2Frepo/);
  assert.match(requests[0].url, /file=src%2Fa%20b\.rs/);
  assert.match(requests[0].url, /q=needle%20x/);
  assert.match(requests[0].url, /context_lines=20/);
  assert.match(requests[0].url, /max_matches_per_file=500/);
  assert.match(requests[0].url, /match_case=true/);
  assert.match(requests[0].url, /regex=true/);
});

test("searchPaths forwards per-query match mode and never sends a walk cursor", async () => {
  const { search, requests } = loadWorkspaceSearch({
    fileContentSearchMatchCase: true,
    fileContentSearchRegex: true,
  });

  // Defaults come from the stored settings.
  await search.searchPaths({ cwd: "/repo", query: "needle" });
  assert.match(requests[0].url, /match_case=true/);
  assert.match(requests[0].url, /regex=true/);
  // Ranked search pages re-walk server-side, so the request carries no
  // visit cursor even if a stale caller still passes one.
  assert.doesNotMatch(requests[0].url, /visit_offset=/);

  // Per-query arguments override the stored settings.
  await search.searchPaths({ cwd: "/repo", query: "[a-z]+", matchCase: false, regex: false, offset: 150 });
  assert.match(requests[1].url, /match_case=false/);
  assert.match(requests[1].url, /regex=false/);
  assert.match(requests[1].url, /offset=150/);
  assert.doesNotMatch(requests[1].url, /visit_offset=/);
});

test("disabled content search does not make a backend request", async () => {
  const { search, requests } = loadWorkspaceSearch({ searchContentEnabled: false });

  const response = await search.searchContentFile({ cwd: "/repo", file: "src/app.rs", query: "needle" });

  assert.equal(response.file, null);
  assert.equal(response.disabled, true);
  assert.equal(requests.length, 0);
});
