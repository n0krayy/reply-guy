/**
 * Reply Guy — test runner
 * Run: npm test   (or: node tests/run.mjs)
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['rules', 'rules.test.mjs'],
  ['length', 'length.test.mjs'],
  ['manifest', 'manifest.test.mjs'],
  ['imports', 'imports.test.mjs'],
  ['scrape', 'scrape.test.mjs'],
  ['pipeline', 'pipeline.test.mjs'],
  ['ui', 'ui.test.mjs'],
  ['layout', 'layout.test.mjs'],
];

let failed = 0;

for (const [name, file] of SUITES) {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  SUITE: ${name}`);
  console.log('='.repeat(64));
  const res = spawnSync(process.execPath, [join(__dirname, file)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log(`\n${'='.repeat(64)}`);
if (failed) {
  console.log(`  ${failed}/${SUITES.length} suite(s) FAILED`);
  process.exit(1);
}
console.log(`  all ${SUITES.length} suites passed`);
