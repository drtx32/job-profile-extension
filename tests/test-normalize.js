// Pure-logic tests for value normalization and path splitting.

'use strict';

const { splitPath, routeApply, applyNativeSelect } = require('../lib/apply');

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

test('splitPath: single value with no separator returns single-element', () => {
  assert(JSON.stringify(splitPath('示例城市')) === JSON.stringify(['示例城市']));
});

test('splitPath: slash-separated path', () => {
  const out = splitPath('某省/某市/某区');
  assert(out.length === 3, `expected 3, got ${out.length}`);
  assert(out[0] === '某省');
  assert(out[1] === '某市');
  assert(out[2] === '某区');
});

test('splitPath: mixed separators / , — — >', () => {
  const out = splitPath('某省, 某市 — 某区 > 某街');
  assert(out.length === 4, `expected 4, got ${out.length}`);
  assert(out[3] === '某街');
});

test('splitPath: empty input returns empty array', () => {
  assert(splitPath('').length === 0);
  assert(splitPath(null).length === 0);
});

test('splitPath: works with non-PII synthetic data', () => {
  const out = splitPath('某省/某市/某区');
  for (const seg of out) {
    assert(seg.length > 0);
    assert(!/private-(?:person|email|employer)-marker/i.test(seg), 'must not contain PII');
  }
});

module.exports = { tests };
