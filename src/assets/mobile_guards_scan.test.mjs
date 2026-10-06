import { describe, it } from "node:test";
import { ok, equal } from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

// Static source-scan test: every text-like <input>/<textarea> tag in the
// mobile templates must be built through the guarded inputAttrs() helper.
// The live CDP sweep proves the shipped bundle; this catches unguarded
// template tags at test time, before anything is built or served.
//
// The same scan applies to the desktop layout and the shared modules:
// landscape phones are wider than the 760px breakpoint, so they load the
// desktop layout, and shared modules render in both layouts.
//
// Scan rules (kept deliberately simple):
// - Files: every src/assets/mobile/*.js module plus app.js.
// - A "tag open" is `<input` or `<textarea` inside a template string. The
//   files have no HTML files; all markup is inline in JS.
// - An input tag is guarded when its open tag carries the inputAttrs
//   interpolation `${inputAttrs(...)}` (optionally via deps.inputAttrs),
//   or it is explicitly allowlisted below (password/login inputs keep
//   autocomplete for password managers; checkboxes/radios/ranges/hidden
//   inputs never open a text keyboard).
//
// Arrow functions appear inside mobile templates, so a plain balanced-brace
// extraction is unsafe. Instead we collect each tag-open substring and check
// for the guard interpolation; tag opens end at the first `>` that is not
// inside quotes.

const GUARD_PATTERNS = [
  /inputAttrs\(/,
  /deps\.inputAttrs/,
];

// (file, reason) pairs that are intentionally unguarded.
const ALLOWLIST = [
  // login.html is not in this scan (kept for password managers), but keep the
  // rule here in case the login form ever moves into a mobile module.
  // Checkboxes and radios do not open text keyboards:
  // (none expected: all mobile checkboxes appear inside settings.js guarded
  // templates; add here only with a reason.)
  // Desktop server-settings username keeps autocomplete="username" so
  // password managers can fill it; the companion password input is type=
  // "password", which the type exclusion already covers.
  ["core.js", 'id="optServerUser"'],
  // login.html username/password are for password managers; it is not in
  // htmlFiles, but if it ever joins the scan keep the pair allowlisted.
  ["login.html", 'name="username"'],
];

// Files scanned for tag opens: the ENTIRE src/assets tree, discovered at run
// time so a new input added to any file (including files nobody remembers
// to list) fails automatically. Grouped by directory kind only so the
// per-file test names stay readable. Mobile modules take inputAttrs via
// deps; desktop core.js destructures it from HerdrAppHelpers; shared modules
// read globalThis.HerdrAppHelpers lazily. All spellings match the guard
// patterns below.
function listJs(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(new URL(dir, import.meta.url))) {
    const full = `${dir}/${entry}`;
    if (statSync(new URL(full, import.meta.url)).isDirectory()) {
      out.push(...listJs(full, `${prefix}${entry}/`));
    } else if (/\.js$/.test(entry) && !/\.test\.mjs$/.test(entry)) {
      out.push({ dir, name: `${prefix}${entry}` });
    }
  }
  return out;
}

// .mjs test files are excluded above; also skip the vendor bundle (it is
// pinned separately below) and non-source helpers.
function assetJsFiles(dir) {
  return listJs(dir)
    .filter((f) => f.name !== "wterm.bundle.js")
    .map((f) => ({ path: `./mobile/${f.name.split("/").pop()}`, name: f.name.split("/").pop() }));
}

const files = assetJsFiles("./mobile");
const desktopFiles = listJs("./desktop/app_js").map((f) => ({ path: `./desktop/app_js/${f.name}`, name: f.name.split("/").pop() }));
const desktopLazyFiles = listJs("./desktop")
  .filter((f) => !f.name.startsWith("app_js/"))
  .map((f) => ({ path: `./desktop/${f.name}`, name: f.name.split("/").pop() }));
const sharedFiles = listJs("./shared").map((f) => ({ path: `./shared/${f.name}`, name: f.name }));
// Root scripts rendered by app.html itself. Neither currently contains an
// input template, but scanning them keeps the "entire tree" claim true and
// catches inputs added there later. Vendor bundles are third-party pinned
// artifacts and stay out; login.html stays out on purpose (see ALLOWLIST).
const rootFiles = ["app_boot.js", "login.js"].map((n) => ({ path: `./${n}`, name: n }));

// Static HTML files (the search palette input lives in app.html, not a JS
// template; the login form keeps password-manager autocomplete on purpose).
const htmlFiles = [
  "app.html",
];

function scanTagOpens(source) {
  const tags = [];
  const re = /<(input|textarea)\b/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let i = m.index;
    let quote = null;
    while (i < source.length) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      } else if (c === "`") {
        // A template literal boundary inside the tag open is a parse error in
        // real code; bail out to avoid false positives.
        i = -1;
        break;
      }
      i++;
    }
    if (i === -1) continue;
    tags.push({ start: m.index, end: i + 1, tag: m[1] });
  }
  return tags;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function unguardedTags(source, name) {
  const tags = scanTagOpens(source);
  const unguarded = [];
  for (const t of tags) {
    const open = source.slice(t.start, t.end);
    if (GUARD_PATTERNS.some((p) => p.test(open))) continue;
    if (ALLOWLIST.some(([f, r]) => f === name && open.includes(r))) continue;
    // Type-based exclusions: these input types never open a text keyboard.
    if (/\btype\s*=\s*"checkbox"/.test(open)) continue;
    if (/\btype\s*=\s*"radio"/.test(open)) continue;
    if (/\btype\s*=\s*"range"/.test(open)) continue;
    if (/\btype\s*=\s*"hidden"/.test(open)) continue;
    if (/\btype\s*=\s*"password"/.test(open)) continue;
    if (/\btype\s*=\s*"color"/.test(open)) continue;
    unguarded.push(`${t.tag} at line ${lineOf(source, t.start)}: ${open.slice(0, 90)}`);
  }
  return { tags, unguarded, opens: tags.map((t) => ({ tag: t.tag, line: lineOf(source, t.start), open: source.slice(t.start, t.end) })) };
}

describe("static mobile keyboard-guard scan", () => {
  // The tree glob must find files: if it returns zero the discovery broke.
  it("discovers asset files to scan", () => {
    ok(files.length >= 15, `mobile glob found only ${files.length} files`);
    ok(desktopFiles.length >= 5, `desktop app_js glob found only ${desktopFiles.length} files`);
    ok(desktopLazyFiles.length >= 8, `desktop lazy glob found only ${desktopLazyFiles.length} files`);
    ok(sharedFiles.length >= 10, `shared glob found only ${sharedFiles.length} files`);
    ok(rootFiles.length === 2, `root scripts glob found only ${rootFiles.length} files`);
  });

  for (const { path, name } of files) {
    it(`${name}: every text-like input tag carries inputAttrs guards`, () => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const { tags, unguarded } = unguardedTags(source, name);
      // Known-positive files must yield tags; that is the scanner's own
      // health check. Files without template inputs (search renders results,
      // terminal delegates to wterm's runtime textarea) may yield zero.
      const knownPositive = ["app.js", "composer.js", "git.js", "file_browser.js", "settings.js", "sessions.js", "worktrees.js", "screens.js"];
      if (knownPositive.includes(name)) {
        ok(tags.length > 0, `${name}: scanner found no input/textarea tags, scanner or markup moved`);
      }
      equal(unguarded.length, 0, `${name}: unguarded input tags:\n${unguarded.join("\n")}`);
    });
  }

  // Aggregate scanner health: across the whole tree the scan must still see
  // plenty of markup; a regex or loader regression drops this to near zero.
  it("scanner sees the markup (aggregate health)", () => {
    let total = 0;
    for (const { path } of [...files, ...desktopFiles, ...desktopLazyFiles, ...sharedFiles, ...rootFiles]) {
      total += scanTagOpens(readFileSync(new URL(path, import.meta.url), "utf8")).length;
    }
    ok(total >= 60, `scanner found only ${total} input/textarea tags across the asset tree`);
  });

  for (const { path, name } of rootFiles) {
    it(`root ${name}: every text-like input tag carries inputAttrs guards`, () => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const { unguarded } = unguardedTags(source, name);
      equal(unguarded.length, 0, `root ${name}: unguarded input tags:\n${unguarded.join("\n")}`);
    });
  }

  for (const { path, name } of desktopFiles) {
    it(`desktop ${name}: every text-like input tag carries inputAttrs guards`, () => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const { unguarded } = unguardedTags(source, name);
      equal(unguarded.length, 0, `desktop ${name}: unguarded input tags:\n${unguarded.join("\n")}`);
    });
  }

  for (const { path, name } of sharedFiles) {
    it(`shared ${name}: every text-like input tag carries inputAttrs guards`, () => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const { tags, unguarded } = unguardedTags(source, name);
      equal(unguarded.length, 0, `shared ${name}: unguarded input tags:\n${unguarded.join("\n")}`);
    });
  }

  for (const name of htmlFiles) {
    it(`${name}: every text-like input tag carries the guard set`, () => {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
      const { tags, unguarded, opens } = unguardedTags(source, name);
      // Static HTML cannot interpolate inputAttrs(), so require the raw
      // attribute set instead of the helper call.
      const rawGuard = /autocomplete="off"[^>]*autocorrect="off"[^>]*autocapitalize="none"[^>]*spellcheck="false"[^>]*writingsuggestions="false"/;
      const missing = opens.filter((t) => {
        if (/\btype\s*=\s*"(checkbox|radio|range|hidden|password|color)"/.test(t.open)) return false;
        if (ALLOWLIST.some(([f, r]) => f === name && t.open.includes(r))) return false;
        return !rawGuard.test(t.open);
      }).map((t) => `${t.tag} at line ${t.line}: ${t.open.slice(0, 90)}`);
      ok(tags.length > 0, `${name}: scanner found no input/textarea tags, scanner or markup moved`);
      equal(missing.length, 0, `${name}: inputs missing the raw guard attribute set:\n${missing.join("\n")}`);
    });
  }

  for (const { path, name } of desktopLazyFiles) {
    it(`desktop ${name}: every text-like input tag carries inputAttrs guards`, () => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const { tags, unguarded } = unguardedTags(source, name);
      equal(unguarded.length, 0, `desktop ${name}: unguarded input tags:\n${unguarded.join("\n")}`);
    });
  }

  it("desktop core.js wires inputAttrs from HerdrAppHelpers", () => {
    const source = readFileSync(new URL("./desktop/app_js/core.js", import.meta.url), "utf8");
    const destructure = source.split("} = globalThis.HerdrAppHelpers")[0];
    ok(/\binputAttrs,\s*$/.test(destructure) || /\binputAttrs\b/.test(destructure.slice(-200)), "desktop core.js destructure of inputAttrs missing");
  });

  it("app.js passes inputAttrs into every mobile module create", () => {
    const source = readFileSync(new URL("./mobile/app.js", import.meta.url), "utf8");
    ok(/inputAttrs,/.test(source.split("HerdrMobileCore")[1] || ""), "app.js destructure of inputAttrs missing");
    // Every create call window must mention inputAttrs. Extract a window from
    // each `.create({` to the matching `})` by brace counting, which is safe
    // here because create calls are plain object literals.
    const re = /\.create\(\s*\{/g;
    let m;
    const missing = [];
    while ((m = re.exec(source)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      let quote = null;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === "{") {
          depth++;
        } else if (c === "}") {
          depth--;
        }
        i++;
      }
      const window = source.slice(m.index, i);
      const receiver = source.slice(Math.max(0, m.index - 60), m.index).match(/(\w+)\s*=\s*[\w.]+$/);
      // Modules with text inputs need inputAttrs. Modules that render no
      // template text inputs (attention, workmeta, theme, actions, backend,
      // terminal + temp terminal, search results, events) may omit it.
      const noInputModules = /Attention|Workmeta|Theme|Actions|Backend|Terminal|Search|Panels|Events/i;
      if (window.includes("inputAttrs")) continue;
      if (receiver && noInputModules.test(receiver[1])) continue;
      if (/HerdrMobileTerminal|HerdrTempTerminal/.test(window)) continue;
      missing.push(`create call near line ${lineOf(source, m.index)}: ${window.slice(0, 70)}`);
    }
    equal(missing.length, 0, `app.js create calls missing inputAttrs:\n${missing.join("\n")}`);
  });

  it("wterm bundle ships the full textarea guard set", () => {
    const bundle = readFileSync(new URL("./vendor/wterm.bundle.js", import.meta.url), "utf8");
    for (const attr of ['"autocapitalize","none"', '"writingsuggestions","false"', '"autocomplete","off"', '"autocorrect","off"', '"spellcheck","false"']) {
      ok(bundle.includes(`this.textarea.setAttribute(${attr})`), `wterm bundle missing textarea guard ${attr}`);
    }
  });
});