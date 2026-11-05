import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const rendererPath = fileURLToPath(new URL("./desktop/git_ui/log.js", import.meta.url));
const rendererScript = new vm.Script(readFileSync(rendererPath, "utf8"), { filename: rendererPath });
const styles = readFileSync(new URL("./desktop/git_ui/log.css", import.meta.url), "utf8");
const themeStyles = readFileSync(new URL("./desktop/app_css/base.css", import.meta.url), "utf8");
const shellStyles = readFileSync(new URL("./desktop/git_ui/shell.css", import.meta.url), "utf8");
const hash = "a".repeat(40);
const otherHash = "b".repeat(40);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function bootRenderer(document = { querySelectorAll: () => [] }) {
  const context = vm.createContext({ URL, document });
  context.window = context;
  rendererScript.runInContext(context);
  return context.HerdrGitLog;
}

function cssRule(source, selector) {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `${selector} exists`);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, source.indexOf("}", open));
}

function colorTokens(rule) {
  return Object.fromEntries([...rule.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]]));
}

function rgb(color, tokens) {
  const variable = color.match(/^var\((--[\w-]+)(?:,\s*(#[\da-f]{6}))?\)$/i);
  if (variable) color = tokens[variable[1]] || variable[2];
  assert.match(color || "", /^#[\da-f]{6}$/i, "contrast colors resolve to concrete RGB values");
  return color.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255);
}

function mixRgb(first, second, weight) {
  return first.map((channel, index) => channel * weight + second[index] * (1 - weight));
}

function contrastRatio(first, second) {
  const luminance = (color) => color.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const light of [false, true]) {
  test(`Git Log ${light ? "light" : "dark"} nonmatching text and graph lanes meet exact contrast thresholds`, (t) => {
    const tokens = {
      ...colorTokens(cssRule(themeStyles, "body {")),
      ...colorTokens(cssRule(styles, ".git-ui-log-workbench {")),
      ...colorTokens(cssRule(shellStyles, ".git-ui-panel,")),
      ...(light ? {
        ...colorTokens(cssRule(themeStyles, "body.light {")),
        ...colorTokens(cssRule(styles, "body.light .git-ui-log-workbench {")),
        ...colorTokens(cssRule(shellStyles, "body.light .git-ui-panel,")),
      } : {}),
    };
    const nonmatch = cssRule(styles, ".git-ui-log-row.git-ui-log-nonmatch,");
    assert.match(nonmatch, /color: var\(--muted\)/);
    assert.doesNotMatch(nonmatch, /opacity:/);
    assert.match(styles, /\.git-ui-log-row\.git-ui-log-nonmatch \.git-ui-log-title \{ color: var\(--muted\); \}/);
    const selectedMix = styles.match(/--git-log-selected: color-mix\(in srgb, var\(--fg\) ([\d.]+)%, var\(--panel\)\)/);
    assert.ok(selectedMix);
    const foreground = rgb(tokens["--fg"], tokens);
    const muted = rgb(tokens["--muted"], tokens);
    const panel = rgb(tokens["--panel"], tokens);
    const surfaces = {
      normal: panel,
      hover: rgb(tokens["--panel2"], tokens),
      selected: mixRgb(foreground, panel, Number(selectedMix[1]) / 100),
    };
    const textRatios = Object.entries(surfaces).map(([state, background]) => {
      const ratio = contrastRatio(muted, background);
      assert.ok(ratio >= 4.5, `${state} nonmatching text: ${ratio.toFixed(9)}:1 must reach 4.5:1`);
      assert.ok(contrastRatio(foreground, background) >= 4.5, `${state} normal text reaches 4.5:1`);
      return `${state}=${ratio.toFixed(6)}`;
    });
    const renderer = bootRenderer();
    const lanes = Array.from({ length: 8 }, (_, lane) => renderer.laneColor(lane));
    lanes.push("var(--git-log-current, #ef4444)", "var(--git-log-main, #3b82f6)");
    const laneRatios = lanes.map((color, lane) => {
      const ratios = Object.entries(surfaces).map(([state, background]) => {
        const ratio = contrastRatio(rgb(color, tokens), background);
        assert.ok(ratio >= 3, `${state} lane ${lane}: ${ratio.toFixed(9)}:1 must reach 3:1`);
        return ratio;
      });
      return Math.min(...ratios).toFixed(6);
    });
    assert.equal(tokens["--git-log-current"], light ? "#b91c1c" : "#ef4444");
    assert.equal(tokens["--git-log-main"], light ? "#2150ae" : "#3b82f6");
    const graph = renderer.render(options({ data: { rows: [{ hash, graph: "||||||||", labels: [] }] } }));
    for (const color of lanes.slice(0, 8)) assert.ok(graph.includes(`stroke="${color}"`), `graph uses ${color}`);
    t.diagnostic(`nonmatching text ratios ${textRatios.join(", ")}; minimum lane ratios [0..7,current,main] ${laneRatios.join(", ")}`);
  });
}

function options(overrides = {}) {
  return {
    data: { rows: [{ hash, graph: "* ", author: "Avery", date: "today", exact_date: "2026-11-05T10:00:00Z", title: "Fix selection", labels: ["HEAD -> feature/details"], current: true, lane: 0 }] },
    selected: [],
    esc: escapeHtml,
    arg: (value) => encodeURIComponent(value).replace(/'/g, "%27"),
    ...overrides,
  };
}

function fakeElement(dataset = {}) {
  const classes = new Set();
  const attributes = {};
  return {
    dataset,
    classes,
    attributes,
    hidden: false,
    scrolls: [],
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    setAttribute(name, value) { attributes[name] = value; },
    scrollIntoView(value) { this.scrolls.push(value); },
  };
}

function searchHarness() {
  const rows = [
    fakeElement({ logHash: hash, logFilterDescription: "Fix bug", logFilterAuthor: "Avery", logFilterDate: "today" }),
    fakeElement({ logHash: otherHash, logFilterDescription: "fix docs", logFilterAuthor: "Blair", logFilterDate: "yesterday" }),
    fakeElement({ logHash: "", logFilterDescription: "", logFilterAuthor: "", logFilterDate: "" }),
  ];
  const count = fakeElement();
  const caseButton = fakeElement();
  const navigation = [fakeElement(), fakeElement()];
  const document = {
    querySelectorAll(selector) {
      if (selector === ".git-ui-log-row") return rows;
      if (selector === ".git-ui-log-search-count") return [count];
      if (selector === ".git-ui-log-search-case") return [caseButton];
      if (selector === ".git-ui-log-search-previous, .git-ui-log-search-next") return navigation;
      return [];
    },
  };
  return { renderer: bootRenderer(document), rows, count, caseButton, navigation };
}

test("Git Log workbench separates references, graph, description, date, author and hash", () => {
  const html = bootRenderer().render(options());
  assert.match(html, /^<section class="git-ui-log-workbench" data-git-log-design="zed"[^>]*>/);
  assert.match(html, /git-ui-log-layout.*git-ui-log-browser/);
  const row = html.slice(html.indexOf('data-log-hash="'));
  let previous = -1;
  for (const column of ["refs", "graph", "description", "date", "author", "hash"]) {
    const position = row.indexOf(`class="git-ui-log-cell-${column}`);
    assert.ok(position > previous, `${column} follows the previous column`);
    previous = position;
  }
  assert.match(row, /class="git-ui-log-cell-hash">aaaaaaa<\/span>/);
  assert.match(row, /onkeydown=.*HerdrGitUi\.selectLogCommit/);
  assert.match(row, /HerdrGitUi\.openLogContextMenu/);
});

test("All, Master + Branch, and Branch keep the same workbench styling and controls", () => {
  const renderer = bootRenderer();
  for (const [scope, label] of [["all", "All"], ["base-current", "Master + Branch"], ["base", "Branch"]]) {
    const html = renderer.render(options({ logScope: scope, logAll: scope === "all" }));
    assert.match(html, new RegExp(`data-log-scope="${scope}"`));
    assert.ok(html.includes(`>${label}</button>`), `${label} scope label is visible`);
    for (const column of ["refs", "graph", "description", "date", "author", "hash"]) {
      assert.match(html, new RegExp(`git-ui-log-cell-${column}`), `${label} retains ${column}`);
    }
    assert.match(html, /git-ui-log-searchbar/);
    assert.match(html, /git-ui-log-details/);
  }
});

test("shared Git Log styles keep search feedback, expanded refs, and graph lanes visible", () => {
  assert.match(styles, /\.git-ui-log-row\.git-ui-log-search-current/);
  assert.match(styles, /\.git-ui-log-row\.git-ui-log-nonmatch/);
  assert.match(styles, /\.git-ui-log-ref-overflow\[hidden\] \{ display: none; \}/);
  assert.match(styles, /\.git-ui-log-ref\.current[^\n]*#ef4444/);
  assert.match(styles, /\.git-ui-log-ref\.main[^\n]*#3b82f6/);
  assert.match(styles, /\.git-ui-log-graph svg[^\n]*height: var\(--git-log-row-height\)/);
  assert.match(styles, /\.git-ui-log-searchbar \{ position: sticky; top: 0; z-index: 7; \}/);
});

test("Git Log escapes commit fields while preserving selection controls", () => {
  const html = bootRenderer().render(options({
    selected: [hash],
    data: { rows: [{ hash, graph: "* ", title: "<script>bad()</script>", author: 'Name "quoted"', labels: ["feature/<unsafe>"], date: "<&>", lane: 0 }] },
  }));
  assert.match(html, /git-ui-log-row selected/);
  assert.ok(!html.includes("<script>bad()</script>"));
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /Name &quot;quoted&quot;/);
  assert.match(html, /HerdrGitUi\.cycleLogScope/);
  assert.match(html, /HerdrGitUi\.loadMoreLog/);
  assert.match(html, /HerdrGitUi\.copyScopeValue\(event,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Commit%20id'\)/);
});

test("search input, case and navigation controls have real handlers and labels", () => {
  const html = bootRenderer().render(options());
  assert.match(html, /aria-label="Search commits"/);
  assert.match(html, /HerdrGitLog\.setSearch\(this.value\)/);
  assert.match(html, /aria-label="Match case" aria-pressed="false"/);
  assert.match(html, /HerdrGitLog\.toggleSearchCase\(\)/);
  assert.match(html, /HerdrGitLog\.navigateSearch\(-1\)/);
  assert.match(html, /HerdrGitLog\.navigateSearch\(1\)/);
  assert.match(html, /<details class="git-ui-log-advanced-filters"><summary>Filters<\/summary>/);
});

test("search case toggle and advanced filters preserve graph transition rows", () => {
  const { renderer, rows, count, caseButton, navigation } = searchHarness();
  renderer.setSearch("Fix");
  assert.equal(count.textContent, "0 / 2");
  assert.equal(rows[1].classes.has("git-ui-log-nonmatch"), false);
  renderer.toggleSearchCase();
  assert.equal(caseButton.attributes["aria-pressed"], "true");
  assert.equal(count.textContent, "0 / 1");
  assert.equal(rows[1].classes.has("git-ui-log-nonmatch"), true);
  assert.ok(rows.every((row) => row.hidden === false));
  assert.equal(rows[2].classes.has("git-ui-log-nonmatch"), false);
  renderer.applyFilters({ author: "Nobody" });
  assert.equal(count.textContent, "0 / 0");
  assert.ok(navigation.every((button) => button.disabled));
  renderer.navigateSearch(1);
  assert.equal(rows[0].scrolls.length, 0);
});

test("search next and previous wrap over only matching loaded commits", () => {
  const { renderer, rows, count } = searchHarness();
  renderer.applyFilters({ description: "fix" });
  renderer.navigateSearch(1);
  assert.equal(count.textContent, "1 / 2");
  assert.equal(rows[0].classes.has("git-ui-log-search-current"), true);
  renderer.navigateSearch(1);
  assert.equal(count.textContent, "2 / 2");
  assert.equal(rows[1].scrolls.length, 1);
  renderer.navigateSearch(1);
  assert.equal(count.textContent, "1 / 2");
  renderer.navigateSearch(-1);
  assert.equal(count.textContent, "2 / 2");
  assert.equal(rows[2].scrolls.length, 0);
});

test("active search result survives metadata rerender by commit identity", () => {
  const { renderer } = searchHarness();
  renderer.applyFilters({ description: "fix" });
  renderer.navigateSearch(1);
  const html = renderer.render(options({ filters: { description: "fix" } }));
  assert.match(html, /git-ui-log-row git-ui-log-search-current current/);
  assert.match(html, /aria-live="polite">1 \/ 1<\/output>/);
});

for (const scope of ["all", "base-current", "base"]) {
  for (const [field, value] of [["author", "Avery"], ["date", "today"]]) {
    test(`${scope} ${field}-only search keeps its count and navigation across rerenders`, () => {
      const { renderer, rows, count, navigation } = searchHarness();
      const filters = { [field]: value };
      const data = { rows: rows.map((row) => ({
        hash: row.dataset.logHash,
        graph: row.dataset.logHash ? "* " : "|/ ",
        title: row.dataset.logFilterDescription,
        author: row.dataset.logFilterAuthor,
        date: row.dataset.logFilterDate,
        labels: [],
      })) };
      const assertControls = (html, current) => {
        assert.match(html, new RegExp(`aria-live="polite">${current} / 1<\\/output>`));
        const buttons = html.match(/<button[^>]*class="git-ui-log-search-(?:previous|next)"[^>]*>/g);
        assert.equal(buttons.length, 2);
        assert.ok(buttons.every((button) => !/\bdisabled\b/.test(button)));
      };
      assertControls(renderer.render(options({ data, filters, logScope: scope })), 0);
      renderer.applyFilters(filters);
      assert.equal(count.textContent, "0 / 1");
      assert.ok(navigation.every((button) => !button.disabled));
      renderer.navigateSearch(1);
      assert.equal(count.textContent, "1 / 1");
      for (const nextScope of [scope, "all", "base-current", "base"]) {
        assertControls(renderer.render(options({ data, filters, logScope: nextScope, selected: [hash], preview: { hash, detailsLoading: true } })), 1);
      }
    });
  }

  for (const mobileDetails of [false, true]) {
    test(`${scope} previous search result clears sticky ${mobileDetails ? "details" : "headers"}`, () => {
      const { renderer, rows } = searchHarness();
      let scrollTop = 600;
      const rectangle = (top, bottom, left = 0, right = 600) => ({ top, bottom, left, right });
      const overlay = (rect, hidden = false) => ({ hidden, getBoundingClientRect: () => rect });
      const overlays = [
        overlay(rectangle(104, 134)),
        overlay(rectangle(50, 104)),
        overlay(rectangle(50, 290, mobileDetails ? 0 : 700, mobileDetails ? 600 : 950)),
        overlay(rectangle(50, 500), true),
      ];
      const content = {
        get scrollTop() { return scrollTop; },
        set scrollTop(value) { scrollTop = Math.max(0, value); },
        getBoundingClientRect: () => rectangle(50, 650),
        querySelectorAll: () => overlays,
      };
      for (const [index, row] of rows.slice(0, 2).entries()) {
        const documentTop = 780 + index * 120;
        row.closest = (selector) => selector === ".git-ui-content" ? content : null;
        row.getBoundingClientRect = () => rectangle(50 + documentTop - scrollTop, 80 + documentTop - scrollTop);
        row.scrollIntoView = (value) => {
          row.scrolls.push(value);
          const rect = row.getBoundingClientRect();
          if (rect.top < 50) content.scrollTop += rect.top - 50;
          else if (rect.bottom > 650) content.scrollTop += rect.bottom - 650;
        };
      }
      renderer.render(options({ logScope: scope, filters: { description: "fix" } }));
      renderer.navigateSearch(1);
      renderer.navigateSearch(1);
      assert.ok(rows[1].classes.has("git-ui-log-search-current"));
      content.scrollTop = 1200;
      renderer.navigateSearch(-1);
      assert.ok(rows[0].classes.has("git-ui-log-search-current"));
      assert.equal(rows[0].getBoundingClientRect().top, mobileDetails ? 290 : 134);
      assert.equal(content.scrollTop, mobileDetails ? 540 : 696);
      assert.ok(rows[0].getBoundingClientRect().bottom <= 650);
    });
  }
}

test("SVG graph retains transition curves, hollow nodes and HEAD/main lane painting", () => {
  const renderer = bootRenderer();
  const html = renderer.render(options({ data: { rows: [
    { hash, graph: "* |", labels: ["HEAD -> feature"], current: true },
    { graph: "|/ " },
    { hash: otherHash, graph: "* ", labels: ["main"] },
  ] }, filters: { description: "not present" } }));
  assert.match(html, /git-ui-log-graph-path.*d="M\d+ 0C/);
  assert.match(html, /<circle class="git-ui-log-dot head".*fill="var\(--panel\)" stroke="var\(--git-log-current, #ef4444\)"/);
  assert.match(html, /stroke="var\(--git-log-main, #3b82f6\)"/);
  assert.match(html, /git-ui-log-row graph-only"/);
  assert.ok(!html.includes("graph-only git-ui-log-nonmatch"));
  assert.ok(!html.includes("git-ui-lane"));
});

test("compact references expand and collapse through a real button without selecting the row", () => {
  const renderer = bootRenderer();
  const html = renderer.render(options({ data: { rows: [{ hash, graph: "* ", labels: ["origin/topic", "HEAD -> topic", "tag: release'one"] }] } }));
  assert.match(html, /<button type="button" class="git-ui-log-ref-toggle" aria-expanded="false"/);
  assert.match(html, />\+2<\/button>/);
  assert.match(html, /release%27one/);
  const overflow = { hidden: true };
  const group = fakeElement();
  group.querySelector = () => overflow;
  const button = fakeElement();
  button.closest = () => group;
  let stops = 0;
  renderer.toggleRefs(button, { stopPropagation() { stops++; } });
  assert.equal(overflow.hidden, false);
  assert.equal(button.attributes["aria-expanded"], "true");
  assert.equal(group.classes.has("expanded"), true);
  renderer.toggleRefs(button, { stopPropagation() { stops++; } });
  assert.equal(overflow.hidden, true);
  assert.equal(button.attributes["aria-expanded"], "false");
  assert.equal(stops, 2);
});

test("details show honest empty and two-commit states", () => {
  const renderer = bootRenderer();
  const empty = renderer.renderDetails(options());
  assert.match(empty, /Select a commit/);
  assert.ok(!empty.includes("Unknown author"));
  assert.ok(!empty.includes("git-ui-log-details-stats"));
  const pair = renderer.renderDetails(options({ selected: [hash, otherHash] }));
  assert.match(pair, /2 commits selected/);
  assert.match(pair, /HerdrGitUi\.compareSelectedLog\(\)/);
  assert.match(pair, /HerdrGitUi\.clearLogSelection\(\)/);
});

test("details retain real row fallback while metadata and files load", () => {
  const html = bootRenderer().renderDetails(options({ selected: [hash], preview: { hash, loading: true, detailsLoading: true } }));
  assert.match(html, /Avery/);
  assert.match(html, /Fix selection/);
  assert.match(html, /Loading commit details/);
  assert.match(html, /Loading changed files/);
  assert.match(html, /width="32" height="32"/);
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("additions"));
  assert.ok(!html.includes("href="));
});

test("details render escaped full metadata, whitespace, actual statistics and trusted file tree", () => {
  const html = bootRenderer().renderDetails(options({ selected: [hash],
    preview: { hash, details: { hash, author: '<img src=x onerror="bad()">', email: 'a+"quoted"@example.invalid', date: "2026-11-05T12:00:00Z", message: "Subject <&>\n\nFirst line\nSecond line", parents: [otherHash], web_url: `https://bitbucket.org/team/repo/commits/${hash}` }, diff: { files: [{ path: "first.txt", additions: 4, deletions: 2 }, { path: "second.txt", additions: 3, deletions: 1 }] } },
    commitFilesHtml: '<div data-existing-file-tree="true">first.txt</div>',
  }));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.match(html, /a\+&quot;quoted&quot;@example.invalid/);
  assert.match(html, /Subject &lt;&amp;&gt;\n\nFirst line\nSecond line/);
  assert.match(html, /2 changed files · \+7 additions · -3 deletions/);
  assert.match(html, /data-existing-file-tree="true"/);
  assert.match(html, /href="https:\/\/bitbucket.org\/team\/repo\/commits\/a{40}"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /HerdrGitUi\.compareSelectedLog\(\)">View Commit/);
});

test("details reject stale metadata and unsafe remote URLs without inventing statistics", () => {
  const renderer = bootRenderer();
  for (const web_url of ["javascript:alert(1)", "data:text/html,bad", "https://user:secret@example.invalid/path", "not a URL"]) {
    const html = renderer.renderDetails(options({ selected: [hash], preview: { hash, details: { hash, web_url }, diff: { files: [{ path: "binary.bin", additions: null, deletions: "4" }] } } }));
    assert.ok(!html.includes("href="));
    assert.match(html, /1 changed file/);
    assert.ok(!html.includes("additions"));
    assert.ok(!html.includes("deletions"));
  }
  const stale = renderer.renderDetails(options({ selected: [hash], preview: { hash: otherHash, details: { hash: otherHash, author: "Wrong author", message: "Wrong message" }, diff: { files: [] } }, commitFilesHtml: "Wrong tree" }));
  assert.ok(!stale.includes("Wrong"));
  assert.match(stale, /Avery/);
});

test("metadata and file errors remain visible without replacing real fallback content", () => {
  const html = bootRenderer().renderDetails(options({ selected: [hash], preview: { hash, detailsError: "Metadata <failed>", error: "Files <failed>" } }));
  assert.match(html, /Metadata &lt;failed&gt;/);
  assert.match(html, /Files &lt;failed&gt;/);
  assert.match(html, /Fix selection/);
  assert.match(html, /role="alert"/);
});
