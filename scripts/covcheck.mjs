// Coverage helper for per-file test work. Prints statement coverage for
// one source file (argv[2], path suffix like "desktop/app_js/bindings.js")
// from the merged V8 coverage JSON (argv[3], default /tmp/herdr-cov-merged).
//
// Usage:
//   node scripts/covcheck.mjs desktop/app_js/bindings.js
//
// Flow for coverage work: run your focused test file with coverage on,
// merge with the shared full-suite baseline, then call this script to see
// the projected per-file number. The merge step is what makes focused runs
// meaningful: your new tests only add counts, never subtract.
//
//   # each iteration (only your test file):
//   rm -rf /tmp/herdr-cov-mine
//   NODE_V8_COVERAGE=/tmp/herdr-cov-mine node --test src/assets/<your>.test.mjs
//
//   # merged per-file view (pool both run dirs into one temp dir):
//   mkdir -p /tmp/herdr-cov-all
//   cp /tmp/herdr-cov-base/*.json /tmp/herdr-cov-all/
//   cp /tmp/herdr-cov-mine/*.json /tmp/herdr-cov-all/
//   npx --yes c8 report --reporter=json \
//     --temp-directory=/tmp/herdr-cov-all \
//     --include=src/assets/** --exclude=**/*.test.mjs \
//     --report-dir=/tmp/herdr-cov-merged
//   node scripts/covcheck.mjs desktop/app_js/bindings.js
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/covcheck.mjs <file-suffix> [report-dir]");
  process.exit(2);
}
const reportDir = process.argv[3] || "/tmp/herdr-cov-merged";
const data = JSON.parse(readFileSync(reportDir + "/coverage-final.json", "utf8"));

let found = false;
for (const [file, cov] of Object.entries(data)) {
  if (!file.endsWith(target)) continue;
  found = true;
  const total = Object.keys(cov.s).length;
  if (!total) {
    console.log(`${target}: no statements recorded`);
    continue;
  }
  const covered = Object.entries(cov.s).filter(([, count]) => count > 0).length;
  const pct = (100 * covered) / total;
  const missingLines = [
    ...new Set(
      Object.entries(cov.s)
        .filter(([, count]) => count === 0)
        .map(([key]) => cov.statementMap[key].start.line),
    ),
  ].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let prev = null;
  for (const line of missingLines) {
    if (start === null) {
      start = line;
      prev = line;
      continue;
    }
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = line;
    prev = line;
  }
  if (start !== null) ranges.push(start === prev ? String(start) : `${start}-${prev}`);
  console.log(
    `${target}: ${pct.toFixed(2)}% (${covered}/${total})` +
      (pct < 90 ? " MISSING: " + ranges.join(" ") : ""),
  );
}
if (!found) {
  console.error(`${target}: not found in ${reportDir}/coverage-final.json`);
  process.exit(1);
}