// Tests for inspectTarget() — DOM-driven classification without using field
// names. Each test uses jsdom to build a representative DOM element and
// verifies that the inspector picks the right strategy.

'use strict';

const { inspectTarget, isChoiceElement } = require('../lib/inspect');
const { createHarness } = require('./dom-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function withDom(html, fn) {
  const { dom, window } = createHarness({ html: `<!DOCTYPE html><html><body>${html}</body></html>` });
  try { return fn(window.document); } finally { dom.window.close?.(); }
}

test('inspectTarget: native text input', () => {
  withDom('<input id="name" type="text" />', (doc) => {
    const r = inspectTarget(doc.getElementById('name'));
    assert(r.ok && r.strategy === 'text', `got ${JSON.stringify(r)}`);
    assert(r.confidence >= 0.7);
  });
});

test('inspectTarget: native date input', () => {
  withDom('<input id="d" type="date" />', (doc) => {
    const r = inspectTarget(doc.getElementById('d'));
    assert(r.ok && r.strategy === 'date');
  });
});

test('inspectTarget: native month input', () => {
  withDom('<input id="m" type="month" />', (doc) => {
    const r = inspectTarget(doc.getElementById('m'));
    assert(r.ok && r.strategy === 'month');
  });
});

test('inspectTarget: native select → select', () => {
  withDom('<select id="s"><option>A</option><option>B</option></select>', (doc) => {
    const r = inspectTarget(doc.getElementById('s'));
    assert(r.ok && r.strategy === 'select');
    assert(r.widget === 'native');
  });
});

test('inspectTarget: native tel → tel', () => {
  withDom('<input id="t" type="tel" />', (doc) => {
    const r = inspectTarget(doc.getElementById('t'));
    assert(r.ok && r.strategy === 'tel');
  });
});

test('inspectTarget: native email → email', () => {
  withDom('<input id="e" type="email" />', (doc) => {
    const r = inspectTarget(doc.getElementById('e'));
    assert(r.ok && r.strategy === 'email');
  });
});

test('inspectTarget: native file → file', () => {
  withDom('<input id="f" type="file" />', (doc) => {
    const r = inspectTarget(doc.getElementById('f'));
    assert(r.ok && r.strategy === 'file');
  });
});

test('inspectTarget: Ant Design select wrapper', () => {
  withDom('<div id="a" class="ant-select"><span class="ant-select-selection"></span></div>', (doc) => {
    const r = inspectTarget(doc.getElementById('a'));
    assert(r.ok && r.strategy === 'select');
    assert(r.widget === 'ant');
    assert(r.confidence >= 0.85, `confidence ${r.confidence}`);
  });
});

test('inspectTarget: Ant Design cascader wrapper', () => {
  withDom('<div id="c" class="ant-cascader-picker"><span class="ant-cascader-picker-label"></span></div>', (doc) => {
    const r = inspectTarget(doc.getElementById('c'));
    assert(r.ok && r.strategy === 'cascader');
    assert(r.widget === 'ant');
  });
});

test('inspectTarget: Element Plus select', () => {
  withDom('<div id="el" class="el-select"><input class="el-select__input" /></div>', (doc) => {
    const r = inspectTarget(doc.getElementById('el'));
    assert(r.ok && r.strategy === 'select');
    assert(r.widget === 'element');
  });
});

test('inspectTarget: Element Plus cascader', () => {
  withDom('<div id="elc" class="el-cascader"></div>', (doc) => {
    const r = inspectTarget(doc.getElementById('elc'));
    assert(r.ok && r.strategy === 'cascader');
    assert(r.widget === 'element');
  });
});

test('inspectTarget: role=combobox with no children → select', () => {
  withDom('<div id="cb" role="combobox"></div>', (doc) => {
    const r = inspectTarget(doc.getElementById('cb'));
    assert(r.ok && r.strategy === 'select');
  });
});

test('inspectTarget: role=combobox with tree children → cascader', () => {
  withDom('<div id="cbt" role="combobox"><span role="treeitem">x</span></div>', (doc) => {
    const r = inspectTarget(doc.getElementById('cbt'));
    assert(r.ok && r.strategy === 'cascader');
  });
});

test('inspectTarget: empty wrapper div → unknown', () => {
  withDom('<div id="u"></div>', (doc) => {
    const r = inspectTarget(doc.getElementById('u'));
    assert(!r.ok && r.error === 'unrecognized_control', JSON.stringify(r));
  });
});

test('inspectTarget: null element → element_required', () => {
  const r = inspectTarget(null);
  assert(!r.ok && r.error === 'element_required');
});

test('isChoiceElement: matches role=option', () => {
  withDom('<li role="option">x</li>', (doc) => {
    const el = doc.querySelector('[role="option"]');
    assert(isChoiceElement(el));
  });
});

test('isChoiceElement: matches Ant Design select-item', () => {
  withDom('<li class="ant-select-item-option">x</li>', (doc) => {
    const el = doc.querySelector('.ant-select-item-option');
    assert(isChoiceElement(el));
  });
});

module.exports = { tests };