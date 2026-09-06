import { describe, it } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./shared/file_content_search.js", import.meta.url), "utf8");
const lineContextSource = readFileSync(new URL("./shared/line_context.js", import.meta.url), "utf8");

function loadRenderer(withLineContext = true) {
  const ctx = { window: null, globalThis: null, console, Map, Set, Promise, Object, Array, String, Number, JSON, Math, RegExp, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  if (withLineContext) vm.runInContext(lineContextSource, ctx);
  vm.runInContext(source, ctx);
  return ctx.window.HerdrContentSearch;
}

function backendFile() {
  // Mirrors the Rust ContentSearchFile response shape.
  return {
    path: "src/app.rs",
    name: "app.rs",
    match_count: 2,
    truncated: false,
    matches: [
      { id: "src/app.rs:1:2:abc", line: 2, start_line: 1, end_line: 3, match_start: 0, match_end: 6, before: ["one"], text: "needle two", after: ["three"] },
      { id: "src/app.rs:3:4:abc", line: 4, start_line: 3, end_line: 5, match_start: 7, match_end: 13, before: ["three"], text: "four needle", after: ["five"] },
    ],
    chunks: [
      {
        start: 1,
        end: 5,
        match_ids: ["src/app.rs:1:2:abc", "src/app.rs:3:4:abc"],
        rows: [
          { line: 1, matched: false, match_id: null, highlight_html: "one" },
          { line: 2, matched: true, match_id: "src/app.rs:1:2:abc", highlight_html: '<mark class="herdr-content-search-hit">needle</mark> two' },
          { line: 3, matched: false, match_id: null, highlight_html: "three" },
          { line: 4, matched: true, match_id: "src/app.rs:3:4:abc", highlight_html: 'four <mark class="herdr-content-search-hit">needle</mark>' },
          { line: 5, matched: false, match_id: null, highlight_html: "five" },
        ],
      },
    ],
  };
}

describe("HerdrContentSearch backend chunks", () => {
  it("renders prebuilt backend chunks without rebuilding highlight HTML", () => {
    const mod = loadRenderer();
    const file = backendFile();
    const html = mod.render({
      query: "needle",
      files: [file],
      expanded: { "src/app.rs": true },
      done: true,
      total_files: 1,
      total_matches: 2,
    }, { callback: "TestContent", hideInput: true });

    match(html, /herdr-content-search-chunk/);
    match(html, /<mark class="herdr-content-search-hit">needle<\/mark>/);
    // Highlight markup is consumed verbatim: no client-side re-escaping that
    // would double-escape the mark tag.
    ok(!html.includes("&lt;mark"), "backend markup must not be re-escaped");
    equal((html.match(/herdr-content-search-line matched/g) || []).length, 2);
    equal((html.match(/herdr-content-search-line muted/g) || []).length, 3);
    // Line numbers render for every row.
    ok(html.includes("<span>1</span>"));
    ok(html.includes("<span>5</span>"));
  });

  it("wires double-click open handlers from backend match ids", () => {
    const mod = loadRenderer();
    const html = mod.render({
      query: "needle",
      files: [backendFile()],
      expanded: { "src/app.rs": true },
      done: true,
    }, { callback: "TestContent", hideInput: true });

    ok(html.includes(`ondblclick="TestContent.openMatch('src%2Fapp.rs','src%2Fapp.rs%3A1%3A2%3Aabc')"`), "matched rows open via backend match ids");
    ok(!html.includes("ondblclick=\"TestContent.openMatch('src%2Fapp.rs','')\""), "muted rows never open");
  });

  it("wires expand arrows to the first backend match id", () => {
    const mod = loadRenderer();
    const html = mod.render({
      query: "needle",
      files: [backendFile()],
      expanded: { "src/app.rs": true },
      done: true,
    }, { callback: "TestContent", hideInput: true });

    // chunk.start === 1 means no "show more above" arrow, only below.
    ok(!html.includes(`expandSnippet('src%2Fapp.rs','src%2Fapp.rs%3A1%3A2%3Aabc','up')`));
    ok(html.includes(`TestContent.expandSnippet('src%2Fapp.rs','src%2Fapp.rs%3A1%3A2%3Aabc','down')`));
    ok(html.includes(",'down')\">↓</button>"));
  });

  it("reuses normalized chunks across renders instead of reprocessing", () => {
    const mod = loadRenderer();
    const file = backendFile();
    const state = { query: "needle", files: [file], expanded: { "src/app.rs": true }, done: true };
    const opts = { callback: "TestContent", hideInput: true };
    const first = mod.render(state, opts);
    const chunksBefore = file._renderChunks;
    ok(Array.isArray(chunksBefore), "first render caches normalized chunks");
    const second = mod.render(state, opts);
    equal(file._renderChunks, chunksBefore, "second render reuses the same chunk objects");
    equal(first, second, "output is stable");
  });

  it("falls back to client-side merging for older backends without chunks", () => {
    const mod = loadRenderer();
    const file = backendFile();
    delete file.chunks;
    const html = mod.render({
      query: "needle",
      files: [file],
      expanded: { "src/app.rs": true },
      done: true,
    }, { callback: "TestContent", hideInput: true });

    match(html, /herdr-content-search-chunk/);
    match(html, /<mark class="herdr-content-search-hit">needle<\/mark>/);
    // Same merged window as the backend shape: lines 1-5 in one chunk.
    equal((html.match(/herdr-content-search-chunk/g) || []).length, 1);
    equal((html.match(/herdr-content-search-line matched/g) || []).length, 2);
    equal((html.match(/herdr-content-search-line muted/g) || []).length, 3);
    ok(!file._renderChunks, "fallback path does not fabricate backend chunk cache");
  });

  it("merges client-side with HerdrLineContext when chunks are absent", () => {
    const mod = loadRenderer(true);
    const file = {
      path: "src/x.js",
      match_count: 2,
      matches: [
        { id: "m1", line: 2, before: ["a"], text: "needle", after: ["b"] },
        { id: "m2", line: 3, before: [], text: "needle", after: [] },
      ],
    };
    const html = mod.render({ query: "needle", files: [file], expanded: { "src/x.js": true }, done: true }, { callback: "TestContent", hideInput: true });
    // Overlapping windows merge into one chunk containing both matched lines.
    equal((html.match(/herdr-content-search-chunk/g) || []).length, 1);
    equal((html.match(/herdr-content-search-line matched/g) || []).length, 2);
  });

  it("skips non-positive lines in backend chunks", () => {
    const mod = loadRenderer();
    const file = {
      path: "src/y.js",
      match_count: 1,
      chunks: [{
        start: 0,
        end: 2,
        match_ids: ["m1"],
        rows: [
          { line: 0, matched: false, match_id: null, highlight_html: "ghost" },
          { line: 1, matched: true, match_id: "m1", highlight_html: "hit" },
          { line: 2, matched: false, match_id: null, highlight_html: "tail" },
        ],
      }],
      matches: [{ id: "m1", line: 1 }],
    };
    const html = mod.render({ query: "needle", files: [file], expanded: { "src/y.js": true }, done: true }, { callback: "TestContent", hideInput: true });
    ok(!html.includes("ghost"), "line 0 is filtered out");
    ok(html.includes("hit"));
    ok(html.includes("tail"));
  });
});