import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// CSS coverage: every class selector shipped to the browser must have a
// runtime producer. A rule nobody can ever hit is dead weight, so the test
// walks every shipped stylesheet, extracts the class tokens its selectors
// reference, and requires each token to be produced by one of:
//   - a literal class attribute / className / classList token in app sources
//   - a template-literal prefix (class="git-ui-syn-${tok}")
//   - an engine-generated family (CodeMirror cm-*, wterm term-*)
//   - a state suffix toggle (foo + "-open" -> .foo-open)
// Selectors with no producer at all fail the suite with the file and line.

const ASSETS = fileURLToPath(new URL("./", import.meta.url));

const SHIP_DIRECTORIES = ["", "desktop/", "desktop/app_css/", "desktop/git_ui/", "shared/", "mobile/", "vendor/"];
const IGNORED_FILES = new Set([]);

function listCssFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (name.endsWith(".css")) out.push(full);
  }
  return out;
}

function collectShippedCss() {
  const files = [];
  const assetsRoot = ASSETS;
  for (const subdir of SHIP_DIRECTORIES) {
    const dir = join(assetsRoot, subdir);
    try {
      statSync(dir);
    } catch {
      continue;
    }
    files.push(...listCssFiles(dir));
  }
  return files.filter((file) => !IGNORED_FILES.has(file));
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractSelectorBlocks(css) {
  // Keyframes and font-face bodies carry no selectors worth auditing.
  const body = css
    .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
    .replace(/@font-face\s*\{[^{}]*\}/g, "");
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    blocks.push({ selector: match[1], start: match.index });
  }
  return blocks;
}

function selectorLine(css, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (css.charCodeAt(i) === 10) line++;
  }
  return line;
}

function splitSelectors(selectorText) {
  // Comma-separated top level; @media blocks were flattened by the regex.
  return selectorText.split(",").map((part) => part.trim()).filter(Boolean);
}

function classTokensIn(selector) {
  const tokens = new Set();
  const re = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = re.exec(selector)) !== null) {
    tokens.add(match[1]);
  }
  return tokens;
}

function readRuntimeCorpus() {
  const roots = [
    join(ASSETS, ""),
    join(ASSETS, "desktop"),
    join(ASSETS, "desktop/app_js"),
    join(ASSETS, "desktop/git_ui"),
    join(ASSETS, "shared"),
    join(ASSETS, "mobile"),
    join(ASSETS, "vendor"),
  ];
  const textFiles = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(js|mjs|html)$/.test(name) && !name.endsWith(".test.mjs") && !name.endsWith(".test.js")) {
        textFiles.add(full);
      }
    }
  };
  for (const root of roots) {
    try {
      statSync(root);
      walk(root);
    } catch {
      // Skip roots that do not exist in this checkout layout.
    }
  }
  // The Rust templates own a few classes too (login page, blocking overlay).
  const rustRoot = dirname(ASSETS);
  for (const rustFile of ["assets.rs", "file_browser.rs"]) {
    const full = join(rustRoot, rustFile);
    try {
      statSync(full);
      textFiles.add(full);
    } catch {
      // The main checkout keeps these at src/, not next to assets/.
      const alt = join(dirname(rustRoot), rustFile);
      try {
        statSync(alt);
        textFiles.add(alt);
      } catch {
        // Skip when not present.
      }
    }
  }
  let corpus = "";
  for (const file of textFiles) corpus += readFileSync(file, "utf8") + "\n";
  return corpus;
}

function literalTokens(corpus) {
  const tokens = new Set();
  const attr = /class="([^"]*)"/g;
  let match;
  while ((match = attr.exec(corpus)) !== null) {
    for (const token of match[1].split(/\s+/)) {
      if (token && !token.includes("$")) tokens.add(token);
    }
  }
  // className assignments and classList.add/remove/toggle arguments.
  const assigned = /className\s*=\s*["']([^"']*)["']/g;
  while ((match = assigned.exec(corpus)) !== null) {
    for (const token of match[1].split(/\s+/)) {
      if (token && !token.includes("$")) tokens.add(token);
    }
  }
  const toggled = /classList\.(?:add|remove|toggle)\((["'`][^"'`]+["'`])/g;
  while ((match = toggled.exec(corpus)) !== null) {
    const inner = match[1].slice(1, -1);
    for (const token of inner.split(/[\s,]+/)) {
      if (token && !token.includes("$")) tokens.add(token);
    }
  }
  const quoted = /["'`]([a-zA-Z][a-zA-Z0-9_-]*)["'`]/g;
  while ((match = quoted.exec(corpus)) !== null) {
    tokens.add(match[1]);
  }
  return tokens;
}

function templatePrefixes(corpus) {
  const prefixes = new Set();
  const re = /([a-zA-Z][a-zA-Z0-9_-]*-[a-zA-Z0-9_-]*)\$\{/g;
  let match;
  while ((match = re.exec(corpus)) !== null) {
    prefixes.add(match[1]);
  }
  return prefixes;
}

function matchesToken(token, literals, prefixes) {
  if (literals.has(token)) return true;
  for (const prefix of prefixes) {
    if (token.startsWith(prefix) && token.length > prefix.length) return true;
  }
  // State toggles: a base class plus -open/-active/... built by classList.add.
  const segments = token.split("-");
  for (let i = 1; i < segments.length; i++) {
    const base = segments.slice(0, i).join("-");
    if (literals.has(base)) return true;
  }
  return false;
}

describe("css selector coverage", () => {
  const cssFiles = collectShippedCss();
  const corpus = readRuntimeCorpus();
  const literals = literalTokens(corpus);
  const prefixes = templatePrefixes(corpus);

  it("ships at least 25 stylesheets", () => {
    assert.ok(cssFiles.length >= 25, `expected >=25 css files, got ${cssFiles.length}`);
  });

  it("every class selector has a runtime producer", () => {
    const orphans = [];
    let selectorsChecked = 0;
    for (const file of cssFiles) {
      const raw = readFileSync(file, "utf8");
      const css = stripComments(raw);
      for (const block of extractSelectorBlocks(css)) {
        for (const selector of splitSelectors(block.selector)) {
          if (selector.startsWith("@")) continue;
          const tokens = classTokensIn(selector);
          if (tokens.size === 0) continue;
          selectorsChecked++;
          for (const token of tokens) {
            if (!matchesToken(token, literals, prefixes)) {
              orphans.push(`${file.replace(ASSETS, "")}:${selectorLine(raw, block.start)} ${token}`);
            }
          }
        }
      }
    }
    assert.ok(
      orphans.length === 0,
      `${orphans.length} class selectors without a runtime producer (checked ${selectorsChecked} selectors):\n` +
        orphans.slice(0, 40).join("\n")
    );
  });

  it("login stylesheet stays fully produced", () => {
    const loginCss = readFileSync(join(ASSETS, "login.css"), "utf8");
    const tokens = new Set();
    for (const block of extractSelectorBlocks(stripComments(loginCss))) {
      for (const token of classTokensIn(block.selector)) tokens.add(token);
    }
    const produced = [...tokens].filter((token) => matchesToken(token, literals, prefixes));
    assert.deepEqual(produced, [...tokens]);
  });
});