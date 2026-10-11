'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHarness } = require('./dom-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

function loadUndoHelpers(window) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const start = source.indexOf('  const nativeFieldUndoStacks = new WeakMap();');
  const end = source.indexOf('\n  function clickElement(element)', start);
  if (start < 0 || end < 0) throw new Error('Could not locate the production field setter/undo helpers');
  const helpers = source.slice(start, end) +
    '\nglobalThis.__fieldUndo = { setNativeFieldValue, undoLastNativeFieldFill, isNativeFieldUndoShortcut };';
  const context = vm.createContext({ document: window.document, window });
  vm.runInContext(helpers, context);
  return context.__fieldUndo;
}

function withDom(html, fn) {
  const { dom, window } = createHarness({ html: `<!DOCTYPE html><html><body>${html}</body></html>` });
  try { fn(window); } finally { dom.window.close?.(); }
}

test('extension fill can immediately be undone to the previous value', () => {
  withDom('<input id="name" value="原姓名">', (window) => {
    const undo = loadUndoHelpers(window);
    const input = window.document.getElementById('name');
    assert(undo.setNativeFieldValue(input, '新姓名'));
    assert(input.value === '新姓名');
    assert(undo.undoLastNativeFieldFill(input));
    assert(input.value === '原姓名', `expected previous value, got ${input.value}`);
    assert(!undo.undoLastNativeFieldFill(input), 'an empty history should not consume browser undo');
  });
});

test('manual edits keep normal undo first, then extension fill can be undone', () => {
  withDom('<textarea id="bio">旧内容</textarea>', (window) => {
    const undo = loadUndoHelpers(window);
    const textarea = window.document.getElementById('bio');
    undo.setNativeFieldValue(textarea, '扩展填入内容');

    // Simulate a user edit. Since the current value no longer matches the
    // extension's write, our handler must leave Ctrl/Cmd+Z to the browser.
    textarea.value = '用户继续编辑';
    assert(!undo.undoLastNativeFieldFill(textarea));
    textarea.value = '扩展填入内容'; // browser undo reverted only the user's edit

    assert(undo.undoLastNativeFieldFill(textarea));
    assert(textarea.value === '旧内容');
  });
});

test('successive extension fills undo one value at a time', () => {
  withDom('<input id="phone" value="初始">', (window) => {
    const undo = loadUndoHelpers(window);
    const input = window.document.getElementById('phone');
    undo.setNativeFieldValue(input, '第一次');
    undo.setNativeFieldValue(input, '第二次');
    assert(undo.undoLastNativeFieldFill(input) && input.value === '第一次');
    assert(undo.undoLastNativeFieldFill(input) && input.value === '初始');
  });
});

test('undo shortcut recognizes Ctrl/Cmd+Z but not modified or composing input', () => {
  withDom('<input>', (window) => {
    const undo = loadUndoHelpers(window);
    assert(undo.isNativeFieldUndoShortcut({ key: 'z', ctrlKey: true }));
    assert(undo.isNativeFieldUndoShortcut({ key: 'Z', metaKey: true }));
    assert(!undo.isNativeFieldUndoShortcut({ key: 'z', ctrlKey: true, shiftKey: true }));
    assert(!undo.isNativeFieldUndoShortcut({ key: 'z', ctrlKey: true, altKey: true }));
    assert(!undo.isNativeFieldUndoShortcut({ key: 'z', ctrlKey: true, isComposing: true }));
  });
});

test('undo history is limited to editable text-like controls', () => {
  withDom('<input id="hidden" type="hidden"><input id="file" type="file"><select id="choice"><option>x</option></select>', (window) => {
    const undo = loadUndoHelpers(window);
    for (const id of ['hidden', 'file', 'choice']) {
      const element = window.document.getElementById(id);
      assert(!undo.isNativeFieldUndoShortcut(null));
      assert(!undo.undoLastNativeFieldFill(element));
    }
  });
});

module.exports = { tests };
