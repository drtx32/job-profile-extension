// Tiny test runner. Each test module exports an async function. The runner
// reports per-test pass/fail and exits non-zero on any failure. Designed to
// run in plain Node without dependencies.

'use strict';

const path = require('path');
const fs = require('fs');

const TEST_DIR = path.join(__dirname);

function discoverTests() {
  return fs.readdirSync(TEST_DIR)
    .filter((name) => name.startsWith('test-') && name.endsWith('.js'))
    .filter((name) => name !== 'run.js')
    .sort();
}

async function runOne(name) {
  const mod = require(path.join(TEST_DIR, name));
  const tests = mod.tests || [];
  const results = [];
  for (const t of tests) {
    const startedAt = Date.now();
    try {
      await t.fn();
      results.push({ name: t.name, ok: true, ms: Date.now() - startedAt });
    } catch (e) {
      results.push({ name: t.name, ok: false, ms: Date.now() - startedAt, error: e.stack || e.message });
    }
  }
  return results;
}

async function main() {
  const files = discoverTests();
  const allResults = [];
  for (const file of files) {
    const r = await runOne(file);
    allResults.push({ file, results: r });
  }
  let passed = 0, failed = 0;
  for (const block of allResults) {
    for (const r of block.results) {
      if (r.ok) {
        console.log(`  ✓ ${block.file} :: ${r.name} (${r.ms}ms)`);
        passed++;
      } else {
        console.log(`  ✗ ${block.file} :: ${r.name} (${r.ms}ms)`);
        console.log(`      ${String(r.error || '').split('\n').slice(0, 6).join('\n      ')}`);
        failed++;
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (${files.length} files)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();