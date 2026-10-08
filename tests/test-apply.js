// Tests for apply strategy and routeApply() — the actual DOM writes.

'use strict';

const { routeApply, applyNativeSelect, setNativeFieldValue } = require('../lib/apply');
const { inspectTarget } = require('../lib/inspect');
const { createHarness } = require('./dom-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function withDom(html, fn) {
  const { dom, window } = createHarness({ html: `<!DOCTYPE html><html><body>${html}</body></html>` });
  try { return fn(window.document); } finally { dom.window.close?.(); }
}

test('routeApply: text input accepts synthetic name', () => {
  withDom('<input id="n" type="text" />', (doc) => {
    const el = doc.getElementById('n');
    const r = routeApply(el, '测试用户A', inspectTarget(el));
    assert(r.ok && r.strategy === 'text');
    assert(el.value === '测试用户A');
  });
});

test('routeApply: date input normalizes to YYYY-MM-DD', () => {
  withDom('<input id="d" type="date" />', (doc) => {
    const el = doc.getElementById('d');
    const r = routeApply(el, '2000-01-01', inspectTarget(el));
    assert(r.ok && r.strategy === 'date');
    assert(el.value === '2000-01-01', `got ${el.value}`);
  });
});

test('routeApply: month input normalizes to YYYY-MM', () => {
  withDom('<input id="m" type="month" />', (doc) => {
    const el = doc.getElementById('m');
    const r = routeApply(el, '2024-07', inspectTarget(el));
    assert(r.ok && r.strategy === 'month');
    assert(el.value === '2024-07');
  });
});

test('routeApply: tel input accepts synthetic phone', () => {
  withDom('<input id="t" type="tel" />', (doc) => {
    const el = doc.getElementById('t');
    const r = routeApply(el, '13800000000', inspectTarget(el));
    assert(r.ok && r.strategy === 'tel');
  });
});

test('routeApply: email accepts synthetic email', () => {
  withDom('<input id="e" type="email" />', (doc) => {
    const el = doc.getElementById('e');
    const r = routeApply(el, 'demo@example.com', inspectTarget(el));
    assert(r.ok && r.strategy === 'email');
  });
});

test('routeApply: native select matches by visible text', () => {
  withDom('<select id="s"><option value="m">男</option><option value="f">女</option></select>', (doc) => {
    const el = doc.getElementById('s');
    const r = routeApply(el, '男', inspectTarget(el));
    assert(r.ok && r.strategy === 'select');
    assert(el.value === 'm');
  });
});

test('routeApply: native select returns no_exact_match for missing option', () => {
  withDom('<select id="s"><option>A</option><option>B</option></select>', (doc) => {
    const el = doc.getElementById('s');
    const r = routeApply(el, '不存在', inspectTarget(el));
    assert(!r.ok && r.error === 'no_exact_match');
    assert(Array.isArray(r.candidates));
  });
});

test('routeApply: file returns plannedValue without touching DOM', () => {
  withDom('<input id="f" type="file" />', (doc) => {
    const el = doc.getElementById('f');
    const r = routeApply(el, '/some/path/fake.pdf', inspectTarget(el));
    assert(r.ok === false && r.strategy === 'file');
    assert(r.error === 'file_upload_planned');
    assert(r.plannedValue === '/some/path/fake.pdf');
    // We deliberately do NOT mutate file inputs.
    assert(el.files.length === 0);
  });
});

test('routeApply: Ant Design cascader emits click + returns cascader strategy', () => {
  withDom('<div id="c" class="ant-cascader-picker"></div>', (doc) => {
    const el = doc.getElementById('c');
    let clicked = false;
    el.addEventListener('click', () => { clicked = true; });
    const r = routeApply(el, '某省/某市/某区', inspectTarget(el));
    assert(r.ok && r.strategy === 'cascader');
    assert(r.action === 'opened_cascader');
    assert(clicked, 'cascader click event should fire');
  });
});

test('routeApply: unknown element returns unrecognized_control', () => {
  withDom('<div id="u"></div>', (doc) => {
    const el = doc.getElementById('u');
    const r = routeApply(el, 'v', inspectTarget(el));
    assert(!r.ok && (r.error === 'unrecognized_control' || r.error === 'inspect_failed'));
  });
});

test('setNativeFieldValue: triggers input + change events', () => {
  withDom('<input id="n" type="text" />', (doc) => {
    const el = doc.getElementById('n');
    let inputFired = false, changeFired = false;
    el.addEventListener('input', () => { inputFired = true; });
    el.addEventListener('change', () => { changeFired = true; });
    assert(setNativeFieldValue(el, '示例文本'));
    assert(inputFired, 'input event should fire');
    assert(changeFired, 'change event should fire');
  });
});

module.exports = { tests };