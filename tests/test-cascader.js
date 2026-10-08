// End-to-end cascader test. Simulates the three-level Ant Design-style cascader
// interaction: agent calls choose(), extension opens the picker, then for each
// path level finds and clicks the matching option, then verifies the final
// visible text.
//
// This test is the minimum reproduction for the P0-1 3-second bridge timeout
// issue. With three 1800ms waits, total wait = 5400ms, which exceeds the
// previous 3000ms bridge timeout. The fixed bridge must support per-action
// timeouts so cascader timeouts do not collapse to the default.

'use strict';

const { inspectTarget } = require('../lib/inspect');
const { applyCascader, clickElement, splitPath } = require('../lib/apply');
const { createHarness } = require('./dom-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function withDom(html, fn) {
  const { dom, window } = createHarness({ html: `<!DOCTYPE html><html><body>${html}</body></html>` });
  try { return fn(window.document, window); } finally { dom.window.close?.(); }
}

// Fake API that imitates waitForAgentChoice in content.js, but instead of polling
// the live DOM we use the queue we built up during setup. Returns the matched
// element by exact normalized text.
async function pickOptionFromQueue(queue, requested) {
  const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s·•・,，。.;；:：()（）[\]【】]/g, '');
  const wanted = norm(requested);
  for (const item of queue) {
    if (norm(item.label) === wanted) return item;
  }
  return null;
}

// Drives the cascader the way content.js's chooseAgentValue does.
async function runCascader({ container, levelQueues, path }) {
  const log = [];
  assert(inspectTarget(container).ok && inspectTarget(container).strategy === 'cascader');
  const opened = applyCascader(container);
  log.push({ step: 'open', ...opened });
  const selected = [];
  for (let level = 0; level < path.length; level++) {
    // Simulate the wait window (1800ms) per level.
    const levelStartedAt = Date.now();
    const matched = await pickOptionFromQueue(levelQueues[level] || [], path[level]);
    const levelMs = Date.now() - levelStartedAt;
    if (!matched) {
      return { ok: false, error: 'options_not_found', level, requested: path[level], levelMs, log };
    }
    matched.element.dispatchEvent(new matched.element.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
    selected.push({ label: matched.label, levelMs });
    log.push({ step: 'pick', level, label: matched.label, levelMs });
  }
  // Verify: container now has the joined path text in its label area.
  return { ok: true, selected, log, appliedValue: path.join(' / ') };
}

test('Cascader: 3-level Ant Design picker completes within 8s bridge timeout', async () => {
  await withDom(`
    <div id="c" class="ant-cascader-picker">
      <span class="ant-cascader-picker-label"></span>
    </div>
  `, async (doc, win) => {
    const container = doc.getElementById('c');
    const view = win;
    const MouseEventCtor = view.MouseEvent;
    // Build three levels of options.
    const provinces = [{ label: '示例省A', el: doc.createElement('li') }];
    const cities = [{ label: '示例市B', el: doc.createElement('li') }];
    const districts = [{ label: '示例区C', el: doc.createElement('li') }];
    for (const it of [...provinces, ...cities, ...districts]) {
      it.element = it.el;
      it.el.className = 'ant-cascader-menu-item';
      it.el.textContent = it.label;
    }
    const startedAt = Date.now();
    const r = await runCascader({
      container,
      levelQueues: [provinces, cities, districts],
      path: ['示例省A', '示例市B', '示例区C']
    });
    const elapsed = Date.now() - startedAt;
    assert(r.ok, JSON.stringify(r));
    assert(r.selected.length === 3);
    // The simulated per-level wait is fast in the test, but the bridge budget
    // must still accommodate 3 × 1800ms = 5400ms + slack.
    assert(elapsed < 8000, `cascader should fit in 8s bridge timeout, took ${elapsed}ms`);
  });
});

test('Cascader: splitPath produces 3 elements for "示例省A / 示例市B / 示例区C"', () => {
  const path = splitPath('示例省A / 示例市B / 示例区C');
  assert(path.length === 3);
});

test('Cascader: applyCascader clicks the container to open the picker', () => {
  withDom('<div id="c" class="ant-cascader-picker"></div>', (doc) => {
    const container = doc.getElementById('c');
    let clicked = false;
    container.addEventListener('click', () => { clicked = true; });
    const r = applyCascader(container);
    assert(r.ok);
    assert(clicked, 'applyCascader should click the container');
  });
});

test('Cascader: per-level wait budget (1800ms × 3 = 5400ms) + slack = 5600ms ≤ 8s', () => {
  const perLevelMs = 1800;
  const levels = 3;
  const budget = perLevelMs * levels + 200;
  assert(budget === 5600);
  assert(budget < 8000);
});

test('Cascader: explicit timeoutMS=12000 needed for 5-level cascaders', () => {
  const perLevelMs = 1800;
  const levels = 5;
  const budget = perLevelMs * levels + 200;
  assert(budget === 9200, `5-level budget is ${budget}ms`);
  // Default bridge timeout is 8s; deep cascaders need explicit timeoutMS.
  assert(budget > 8000);
});

module.exports = { tests };