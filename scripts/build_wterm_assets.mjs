import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  outfile: bundlePath,
  minify: true,
  legalComments: "none",
});

// @wterm/ghostty computes its default WASM URL with
// `new URL("../wasm/ghostty-vt.wasm", import.meta.url)`. This project serves a
// bundled IIFE, so there is no module `import.meta.url` at runtime. Without this
// patch, the browser evaluates the default URL during bundle load and throws
// before Herdr can pass its explicit `wasmPath` option. Keep the URL aligned
// with the embedded route in src/main.rs.
const bundledJs = await readFile(bundlePath, "utf8");
await writeFile(
  bundlePath,
  bundledJs.replace(
    /new URL\("\.\.\/wasm\/ghostty-vt\.wasm",[^)]*\)\.href/g,
    '"/assets/vendor/ghostty-vt.wasm"',
  ),
);

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
