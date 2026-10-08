// Integration test for agent-bridge.js. Loads the bridge file into jsdom and
// verifies the intentionally small public API and request wiring.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHarness } = require('./dom-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function loadBridge(window) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent-bridge.js'), 'utf8');
  window.eval(code);
}

test('Bridge: defines formHelper with version 2.0.x', () => {
  const { dom, window } = createHarness();
  try {
    loadBridge(window);
    const a = window.formHelper;
    assert(a, 'formHelper should be defined');
    assert(a.version.startsWith('2.0'), `version is ${a.version}`);
  } finally { dom.window.close?.(); }
});

test('Bridge: string field argument survives get normalization', async () => {
  const { dom, window } = createHarness();
  try {
    loadBridge(window);
    const seen = [];
    window.document.addEventListener('form-helper-request-v1', (event) => {
      seen.push({ action: event.detail.action, payload: event.detail.payload });
      window.document.dispatchEvent(new window.CustomEvent('form-helper-response-v1', {
        detail: { requestId: event.detail.requestId, result: { ok: true } }
      }));
    });
    await window.formHelper.get('xm');
    assert(seen[0].payload.options.field === 'xm');
  } finally { dom.window.close?.(); }
});

test('Bridge: public function surface contains only list and get', () => {
  const { dom, window } = createHarness();
  try {
    loadBridge(window);
    const a = window.formHelper;
    const functions = Object.keys(a).filter((key) => typeof a[key] === 'function').sort();
    assert(JSON.stringify(functions) === JSON.stringify(['get', 'list']), `functions are ${functions}`);
    assert(JSON.stringify(a.capabilities) === JSON.stringify(['list', 'get']));
  } finally { dom.window.close?.(); }
});

test('Bridge: list(query) replaces find(query)', async () => {
  const { dom, window } = createHarness();
  try {
    loadBridge(window);
    let seen;
    window.document.addEventListener('form-helper-request-v1', (event) => {
      seen = event.detail;
      window.document.dispatchEvent(new window.CustomEvent('form-helper-response-v1', {
        detail: { requestId: event.detail.requestId, result: { ok: true } }
      }));
    });
    await window.formHelper.list('实习 开始时间');
    assert(seen.action === 'list');
    assert(seen.payload.query === '实习 开始时间');
    assert(seen.payload.options.legacy_query === '实习 开始时间');
  } finally { dom.window.close?.(); }
});

test('Bridge: short-timeout request honors timeoutMS', async () => {
  const { window } = createHarness();
  loadBridge(window);
  // No listener — request will time out.
  const startedAt = Date.now();
  let captured;
  try {
    await window.formHelper.list('', { timeoutMS: 250 });
  } catch (err) {
    captured = err;
  }
  const elapsed = Date.now() - startedAt;
  assert(captured && captured.code === 'bridge_timeout', `got ${captured && captured.code}`);
  assert(elapsed < 1500, `should reject ~250ms, got ${elapsed}ms`);
});

module.exports = { tests };
