// Full-stack acceptance checks for backend-built content-search chunks.
//
// Unit suites cover chunk merging in Rust and rendering in a fake DOM, but
// they cannot catch wiring bugs between the served bundle, the embedded
// assets, and the real file-browser backend. This script boots the served
// bundles in a node vm, proxies fetch to the real server, renders content
// results with the same shared renderer the browser uses, and verifies the
// backend-provided pre-merged chunks and highlight markup end to end.
//
// Driven by scripts/e2e/run-content-search-e2e.sh.
import vm from "node:vm";
import { request as httpsRequest } from "node:https";

const ORIGIN = process.env.E2E_ORIGIN;
const REPO = process.env.E2E_REPO;

if (!ORIGIN || !REPO) {
  console.error("E2E_ORIGIN and E2E_REPO must be set (use scripts/e2e/run-content-search-e2e.sh)");
  process.exit(2);
}

function httpsJson(url, init) {
  return new Promise((resolve, reject) => {
    const options = { rejectUnauthorized: false };
    if (init && init.method) options.method = init.method;
    if (init && init.headers) options.headers = init.headers;
    const req = httpsRequest(url, options, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: async () => JSON.parse(raw) }));
    });
    req.on("error", reject);
    if (init && init.body) req.write(init.body);
    req.end();
  });
}

function loadText(path) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`${ORIGIN}${path}`, { rejectUnauthorized: false }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.end();
  });
}

function element() {
  return {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    value: "",
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    removeChild() {},
    remove() {},
    replaceWith() {},
    insertBefore() {},
    after() {},
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    insertAdjacentHTML() {},
    focus() {},
    blur() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
    textContent: "",
    innerHTML: "",
    scrollTop: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

const localStorage = new Map();
const ctx = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
  Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, RegExp, Error,
  TextEncoder, TextDecoder,
  encodeURIComponent, decodeURIComponent,
  fetch: async (url) => {
    const full = String(url).startsWith("http") ? String(url) : `${ORIGIN}${url}`;
    const res = await httpsJson(full);
    const body = await res.json();
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => body };
  },
  alert() {},
  prompt: () => null,
  confirm: () => true,
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    title: "",
    body: element(),
    documentElement: element(),
    hidden: false,
    visibilityState: "visible",
    createElement: () => element(),
    execCommand: () => true,
    querySelector: () => element(),
    querySelectorAll: () => [],
    getElementById: () => element(),
    addEventListener() {},
  },
  localStorage: {
    getItem: (key) => localStorage.get(key) || null,
    setItem: (key, value) => localStorage.set(key, String(value)),
    removeItem: (key) => localStorage.delete(key),
  },
  history: { pushState() {}, replaceState() {} },
  location: { pathname: "/", href: "" },
  window: null,
  globalThis: null,
  WebSocket: class {},
  addEventListener() {},
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

// Boot exactly the bundle set the server serves for content search.
const SHARED_BUNDLES = [
  "/assets/shared/core.js",
  "/assets/shared/options.js",
  "/assets/shared/file-icons.js",
  "/assets/shared/file-tree.js",
  "/assets/shared/line-context.js",
  "/assets/shared/file-content-search.js",
  "/assets/shared/workspace-search.js",
];
const sources = [];
for (const path of SHARED_BUNDLES) sources.push(await loadText(path));
vm.runInContext(sources.join("\n;\n"), ctx);

const search = ctx.window.HerdrWorkspaceSearch;
const renderer = ctx.window.HerdrContentSearch;
if (!search || !renderer) throw new Error("content search bundles failed to boot from served assets");

const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

// 1. Query the real backend through the shared helper (what the browser calls).
const data = await search.searchContent({ cwd: REPO, query: "e2eneedle", contextLines: 2, matchesPerFile: 10 });
assert(Array.isArray(data.files) && data.files.length > 0, "content search returned files from the real backend");

// 2. The backend must send pre-merged chunks, not just raw matches.
const file = data.files.find((entry) => entry.path === "src/chunks.rs") || data.files[0];
assert(Array.isArray(file.chunks) && file.chunks.length > 0, `backend sends prebuilt chunks for ${file.path}`);
const chunk = file.chunks[0];
assert(chunk.rows.every((row) => typeof row.highlight_html === "string" && row.highlight_html.length > 0), "every backend row carries highlight_html");
assert(chunk.rows.some((row) => row.matched && row.match_id), "matched rows carry match ids");

// 3. Overlapping context windows must arrive already merged (lines 1-6 in one chunk).
assert(chunk.start === 1, `first chunk starts at line 1 (got ${chunk.start})`);
assert(chunk.end === 7, `first chunk merges both matches into lines 1-7 (got end ${chunk.end})`);
assert(chunk.rows.length === 7, `merged chunk has 7 rows (got ${chunk.rows.length})`);
assert(chunk.match_ids.length === 2, "merged chunk references both match ids");
const matchedRows = chunk.rows.filter((row) => row.matched);
assert(matchedRows.length === 2, "two matched rows inside the merged chunk");
assert(matchedRows[0].highlight_html.includes('<mark class="herdr-content-search-hit">e2eneedle</mark>'), "matched row highlight markup wraps the hit");
const mutedRow = chunk.rows.find((row) => !row.matched);
assert(!mutedRow.highlight_html.includes("<mark"), "context rows have no highlight markup");

// 4. Escaping: the HTML fixture line must arrive escaped by the backend.
const escapedRow = chunk.rows.find((row) => row.highlight_html.includes("&lt;b&gt;"));
assert(!!escapedRow, "backend escapes HTML in row markup");

// 5. Render through the shared renderer the browser uses (expanded file).
const html = renderer.render(
  { query: "e2eneedle", files: data.files, expanded: { [file.path]: true }, done: true, total_files: data.total_files, total_matches: data.total_matches },
  { callback: "E2EContent", hideInput: true },
);
assert(html.includes("<mark class=\"herdr-content-search-hit\">e2eneedle</mark>"), "renderer emits backend highlight markup verbatim");
assert(!html.includes("&lt;mark"), "renderer does not double-escape backend markup");
assert(html.includes(`ondblclick="E2EContent.openMatch('${encodeURIComponent(file.path)}','${encodeURIComponent(matchedRows[0].match_id)}')"`), "renderer wires openMatch from backend match ids");
assert(html.includes("E2EContent.expandSnippet("), "renderer wires context expand arrows");
assert((html.match(/herdr-content-search-chunk/g) || []).length === file.chunks.length, "one rendered chunk per backend chunk");
assert(html.includes(`<span>${chunk.rows[0].line}</span>`), "line numbers render from backend rows");

// 6. Re-render must reuse the normalized chunk cache (no per-render merging).
const cacheBefore = file._renderChunks;
const html2 = renderer.render(
  { query: "e2eneedle", files: data.files, expanded: { [file.path]: true }, done: true, total_files: data.total_files, total_matches: data.total_matches },
  { callback: "E2EContent", hideInput: true },
);
assert(file._renderChunks === cacheBefore, "second render reuses cached normalized chunks");
assert(html === html2, "repeat render output is identical");

// 7. The single-file route (expand "Load all matches") also returns chunks.
const single = await httpsJson(`${ORIGIN}/api/file-browser/content-search/file?cwd=${encodeURIComponent(REPO)}&file=${encodeURIComponent(file.path)}&q=e2eneedle&context_lines=2&max_matches_per_file=500`);
const singleBody = await single.json();
assert(Array.isArray(singleBody.file.chunks) && singleBody.file.chunks.length > 0, "single-file route also returns prebuilt chunks");

console.log("CONTENT SEARCH E2E ACCEPTANCE PASSED");