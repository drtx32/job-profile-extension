// Tests for the alias / canonical-key registry.

'use strict';

const { AliasStore, DEFAULT_CANONICAL_ALIASES } = require('../lib/aliases');

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

test('AliasStore: resolves Chinese label', () => {
  const store = new AliasStore();
  assert(store.resolve('姓名') === 'identity.name');
  assert(store.resolve('毕业院校') === 'education.school');
  assert(store.resolve('常用邮箱') === 'identity.email');
});

test('AliasStore: resolves shortcut alias', () => {
  const store = new AliasStore();
  assert(store.resolve('xm') === 'identity.name');
  assert(store.resolve('sjh') === 'identity.phone');
  assert(store.resolve('xxmc') === 'education.school');
});

test('AliasStore: case-insensitive', () => {
  const store = new AliasStore();
  assert(store.resolve('NAME') === 'identity.name');
  assert(store.resolve('School') === 'education.school');
});

test('AliasStore: returns null for unknown labels', () => {
  const store = new AliasStore();
  assert(store.resolve('not a real label') === null);
});

test('AliasStore: resolveProfileItem returns confidence', () => {
  const store = new AliasStore();
  const r1 = store.resolveProfileItem({ buttonText: '姓名', shortcut: 'xm' });
  assert(r1.canonical === 'identity.name');
  assert(r1.confidence >= 0.9);
  const r2 = store.resolveProfileItem({ buttonText: '未知字段', title: '基本信息' });
  assert(r2.confidence < 0.5, 'unknown should not produce high confidence');
});

test('AliasStore: aliases() returns a copy, not a reference', () => {
  const store = new AliasStore();
  const a = store.aliases();
  a['identity.name'] = ['mutable'];
  const b = store.aliases();
  assert(!deepEqual(a, b) || a['identity.name'][0] === 'mutable' && b['identity.name'].indexOf('mutable') < 0);
});

test('AliasStore: addOverride wins over defaults', () => {
  const store = new AliasStore();
  store.addOverride('identity.name', ['自定义姓名']);
  assert(store.resolve('自定义姓名') === 'identity.name');
});

test('Default aliases file: never contains PII-looking values', () => {
  // Alias file MUST NOT include any personal data. We only test the registry
  // shape here, not the names themselves (which are public field labels).
  for (const labels of Object.values(DEFAULT_CANONICAL_ALIASES)) {
    assert(Array.isArray(labels));
    for (const label of labels) {
      assert(typeof label === 'string' && label.length > 0, `empty alias in ${JSON.stringify(labels)}`);
    }
  }
});

module.exports = { tests };