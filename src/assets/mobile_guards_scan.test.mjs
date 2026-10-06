import { describe, it } from "node:test";
import { ok, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static source-scan test: every text-like <input>/<textarea> tag in the
// mobile templates must be built through the guarded inputAttrs() helper.
// The live CDP sweep proves the shipped bundle; this catches unguarded
// template tags at test time, before anything is built or served.
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
];

const files = [
  "actions.js", "app.js", "attention.js", "backend.js", "composer.js", "core.js",
  "events.js", "file_browser.js", "git.js", "panels.js", "screens.js", "search.js",
  "sessions.js", "settings.js", "terminal.js", "theme.js", "workmeta.js", "worktrees.js",
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

describe("static mobile keyboard-guard scan", () => {
  for (const name of files) {
    it(`${name}: every text-like input tag carries inputAttrs guards`, () => {
      const source = readFileSync(new URL(`./mobile/${name}`, import.meta.url), "utf8");
      const tags = scanTagOpens(source);
      // Known-positive files must yield tags; that is the scanner's own
      // health check. Files without template inputs (search renders results,
      // terminal delegates to wterm's runtime textarea) may yield zero.
      const knownPositive = ["app.js", "composer.js", "git.js", "file_browser.js", "settings.js", "sessions.js", "worktrees.js", "screens.js"];
      if (knownPositive.includes(name)) {
        ok(tags.length > 0, `${name}: scanner found no input/textarea tags, scanner or markup moved`);
      }
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
        unguarded.push(`${t.tag} at line ${lineOf(source, t.start)}: ${open.slice(0, 90)}`);
      }
      equal(unguarded.length, 0, `${name}: unguarded input tags:\n${unguarded.join("\n")}`);
    });
  }

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