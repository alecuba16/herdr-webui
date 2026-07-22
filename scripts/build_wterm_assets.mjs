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

await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  globalName: "HerdrWtermBundle",
  outfile: bundlePath,
  minify: true,
  legalComments: "none",
});

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
