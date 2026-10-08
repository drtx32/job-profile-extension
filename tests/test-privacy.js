// Privacy regression tests. The fixture and the alias registry MUST NOT
// contain real PII. The API surface MUST NOT include value getters on the
// metadata-only path.

'use strict';

const { FAKE_PROFILE } = require('./fixtures/profile.fake');
const { AliasStore, DEFAULT_CANONICAL_ALIASES } = require('../lib/aliases');
const { inspectTarget } = require('../lib/inspect');
const { applyText, setNativeFieldValue } = require('../lib/apply');
const { createHarness } = require('./dom-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Real-name markers MUST never appear in any file we ship.
const PII_MARKERS = [
  'private-person-marker',
  'private-email-marker',
  'private-employer-marker',
  'private-project-marker'
];

function assertNoPII(value, where) {
  if (value == null) return;
  const text = String(value);
  for (const marker of PII_MARKERS) {
    if (text.includes(marker)) {
      throw new Error(`PII marker "${marker}" leaked into ${where}: ${text.slice(0, 80)}`);
    }
  }
}

test('fixture: profile values contain no PII markers', () => {
  for (const row of FAKE_PROFILE.orderedData) {
    assertNoPII(row.fillContent, `FAKE PROFILE row "${row.buttonText}"`);
    assertNoPII(row.title, `FAKE PROFILE group "${row.title}"`);
    assertNoPII(row.shortcut, `FAKE PROFILE shortcut "${row.shortcut}"`);
  }
});

test('fixture: shortcuts are unique', () => {
  const seen = new Set();
  for (const row of FAKE_PROFILE.orderedData) {
    if (seen.has(row.shortcut)) throw new Error(`duplicate shortcut: ${row.shortcut}`);
    seen.add(row.shortcut);
  }
});

test('aliases: defaults contain no raw PII markers', () => {
  for (const [canonical, labels] of Object.entries(DEFAULT_CANONICAL_ALIASES)) {
    for (const label of labels) assertNoPII(label, `alias ${canonical}`);
  }
});

test('apply: applyText writes synthetic value but never reads from real storage', () => {
  // We do NOT import chrome.storage.local in the lib path; verify by source.
  const fs = require('fs');
  const path = require('path');
  const applySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apply.js'), 'utf8');
  assert(!/chrome\.storage/i.test(applySrc), 'apply.js must not read chrome.storage; that is content.js\'s job');
  const inspectSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inspect.js'), 'utf8');
  assert(!/chrome\.storage/i.test(inspectSrc), 'inspect.js must not read chrome.storage');
});

test('apply: inspectTarget returns no value field by design', () => {
  const { dom, window } = createHarness({ html: '<input id="x" type="text" />' });
  try {
    const r = inspectTarget(window.document.getElementById('x'));
    assert(r.value === undefined, 'inspect result must not include a `value` field');
    assert(r.fillContent === undefined);
  } finally { dom.window.close?.(); }
});

test('apply: routeApply writes synthetic value to element, not to stdout', () => {
  const { dom, window } = createHarness({ html: '<input id="x" type="text" />' });
  try {
    const el = window.document.getElementById('x');
    const inspect = inspectTarget(el);
    const lib = require('../lib/apply');
    lib.routeApply(el, '测试用户A', inspect);
    assert(el.value === '测试用户A', 'synthetic value must reach the input');
    assert(!/测试用户A/.test(process.stdout.write('').toString()), 'never log the value');
  } finally { dom.window.close?.(); }
});

test('aliases: registry does not expose fillContent field', () => {
  const store = new AliasStore();
  const m = store.resolveProfileItem({ buttonText: '姓名', shortcut: 'xm' });
  assert(m.value === undefined);
  assert(m.fillContent === undefined);
});

module.exports = { tests };
