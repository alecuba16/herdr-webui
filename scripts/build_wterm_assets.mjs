import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const vendorDir = join(root, "src/assets/vendor");
const entryPath = join(vendorDir, "wterm_entry.mjs");
const bundlePath = join(vendorDir, "wterm.bundle.js");
const cssPath = join(vendorDir, "wterm.css");
const ghosttyWasmPath = join(vendorDir, "ghostty-vt.wasm");

await mkdir(vendorDir, { recursive: true });
await writeFile(
  entryPath,
  `import { WTerm } from "@wterm/dom";\nimport { GhosttyCore } from "@wterm/ghostty";\nglobalThis.HerdrWtermBundle = { WTerm, GhosttyCore };\n`,
);

const result = await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  write: false,
  minify: true,
  legalComments: "none",
});

// .replace() silently no-ops when the pattern is absent, so an upstream wterm
// release with different minified output would drop these patches without any
// build error. Every patch must actually apply; otherwise fail the build and
// leave the previous (patched) bundle on disk untouched.
function applyPatch(source, pattern, replacement, label) {
  const patched = source.replace(pattern, replacement);
  if (patched === source) {
    throw new Error(`wterm vendor patch did not apply: ${label}`);
  }
  return patched;
}

const bundledJs = new TextDecoder().decode(result.outputFiles[0].contents);
let patchedJs = bundledJs;

// @wterm/ghostty computes its default WASM URL with
// `new URL("../wasm/ghostty-vt.wasm", import.meta.url)`. This project serves a
// bundled IIFE, so there is no module `import.meta.url` at runtime. Without this
// patch, the browser evaluates the default URL during bundle load and throws
// before Herdr can pass its explicit `wasmPath` option. Keep the URL aligned
// with the embedded route in src/main.rs.
patchedJs = applyPatch(
  patchedJs,
  /new URL\("\.\.\/wasm\/ghostty-vt\.wasm",[^)]*\)\.href/g,
  '"/assets/vendor/ghostty-vt.wasm"',
  "ghostty-vt WASM URL",
);

// The hidden IME textarea historically carried aria-hidden="true" upstream,
// which is an a11y violation on a focused element. Current @wterm/dom no
// longer sets aria-hidden on it at all, so there is nothing to patch — the
// old replace for it was a silent no-op after the vendor bump. If
// aria-hidden="true" ever returns on the IME textarea, the live CDP audits
// will flag it and a patch can be re-added with an applyPatch assert.

// The hidden textarea must not trigger mobile keyboard autocorrect, grammar
// suggestions, or capitalization. Upstream ships autocapitalize="off" but
// Gboard ignores that on some layers and respects writingsuggestions, and
// the spec value for "no capitalization" is "none". translate="no" keeps the OS
// translate gesture from popping over the terminal and completes the full
// herdr guard set on this input.
patchedJs = applyPatch(
  patchedJs,
  'this.textarea.setAttribute("autocapitalize","off"),',
  'this.textarea.setAttribute("autocapitalize","none");' +
    'this.textarea.setAttribute("writingsuggestions","false");' +
    'this.textarea.setAttribute("translate","no"),',
  "IME textarea keyboard guards",
);
await writeFile(bundlePath, patchedJs);

await copyFile(
  join(root, "node_modules/@wterm/dom/src/terminal.css"),
  cssPath,
);
await copyFile(
  join(root, "node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm"),
  ghosttyWasmPath,
);

console.log(`wrote ${bundlePath}`);
console.log(`wrote ${cssPath}`);
console.log(`wrote ${ghosttyWasmPath}`);
