import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const vendorDir = join(root, "src/assets/vendor");

await mkdir(vendorDir, { recursive: true });

// marked: small markdown parser, lazy-loaded when a markdown preview opens.
await esbuild.build({
  entryPoints: [join(vendorDir, "marked_entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "HerdrMarkedBundle",
  outfile: join(vendorDir, "marked.bundle.js"),
  minify: true,
  legalComments: "none",
  target: "es2020",
});

// dompurify: sanitizes marked output. Lazy-loaded with marked.
await esbuild.build({
  entryPoints: [join(vendorDir, "dompurify_entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "HerdrDOMPurifyBundle",
  outfile: join(vendorDir, "dompurify.bundle.js"),
  minify: true,
  legalComments: "none",
  target: "es2020",
  // DOMPurify expects a DOM `window`. The browser provides one; provide a
  // minimal shim so the IIFE does not throw during early load.
  define: { window: "globalThis" },
});

// mermaid: large diagram renderer. Lazy-loaded only when a markdown preview
// contains mermaid blocks. Bundled separately so it never blocks boot.
await esbuild.build({
  entryPoints: [join(vendorDir, "mermaid_entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "HerdrMermaidBundle",
  outfile: join(vendorDir, "mermaid.bundle.js"),
  minify: true,
  legalComments: "none",
  target: "es2020",
  // Mermaid references DOM globals; alias to globalThis for bundle load.
  define: { window: "globalThis" },
});

for (const name of ["marked", "dompurify", "mermaid"]) {
  const path = join(vendorDir, `${name}.bundle.js`);
  const stat = await readFile(path).then((buf) => buf.length).catch(() => 0);
  console.log(`wrote ${path} (${stat} bytes)`);
}
