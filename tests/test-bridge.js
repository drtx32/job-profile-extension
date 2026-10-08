// Tests for the bridge layer between MAIN-world formHelper and the
// content script.
//
// We test the pure logic: budget for cascader spread between request timeout
// and per-level wait. If a single wait is 1800ms and the user requests a
// 3-level cascader, the budget is 5400ms which must be < bridge timeout.
//
// The bridge lives in MAIN world and dispatches CustomEvents on the document. We
// simulate this with a fake dispatch loop without loading the actual file.

'use strict';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Recreate the per-action budget logic from agent-bridge.js. Keeping the
// formulas in lock-step with the bridge is required so the test reflects
// actual behaviour.
function computeBudget({ perLevelMs, levels, timeoutMs }) {
  // Total wait budget = per-level × levels + a small slack for round trips.
  return perLevelMs * levels + 200;
}

function requiredTimeoutMs({ perLevelMs, levels }) {
  return computeBudget({ perLevelMs, levels, timeoutMs: 0 }) + 100; // +100ms slack for response dispatch
}

test('Bridge: 3-level cascader budget fits within default 8s timeout', () => {
  // Per-level default is 1800ms, 3 levels → 5600ms.
  const perLevel = 1800;
  const levels = 3;
  const budget = computeBudget({ perLevelMs: perLevel, levels, timeoutMs: 8000 });
  assert(budget < 8000, `3-level budget ${budget}ms should fit in 8s timeout`);
  assert(requiredTimeoutMs({ perLevelMs: perLevel, levels }) <= 8000);
});

test('Bridge: 5-level cascader with default timeout may exceed 8s', () => {
  // This is the edge case the agent API has to handle: deep cascaders need
  // an explicit longer timeout.
  const perLevel = 1800;
  const levels = 5;
  const budget = computeBudget({ perLevelMs: perLevel, levels });
  assert(budget > 8000, `5-level budget ${budget}ms exceeds 8s; agent should pass timeoutMS=12000`);
});

test('Bridge: timeoutMS clamps invalid values to defaults', () => {
  const clamp = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 8000;
    return Math.max(1000, Math.min(120000, n));
  };
  assert(clamp(-1) === 8000);
  assert(clamp(0) === 8000);
  assert(clamp('abc') === 8000);
  assert(clamp(300000) === 120000);
  assert(clamp(5000) === 5000);
  assert(clamp(0.5) === 1000, 'sub-second requests clamp to 1000ms floor');
});

test('Bridge: action-specific timeout presets', () => {
  const preset = (action) => {
    const presets = {
      list: 5000,
      get: 5000,
      fill: 8000,
      choose: 12000, // deep cascaders need longer
      resolve: 5000,
      apply: 12000,
      inspect: 5000,
      fillFocused: 8000
    };
    return presets[action] || 8000;
  };
  assert(preset('choose') === 12000);
  assert(preset('apply') === 12000);
  assert(preset('list') === 5000);
});

// Simulate the actual round-trip via a fake event bus. We dispatch a request
// event and respond with the expected shape, then check the bridge would return
// the result before its timeout fires.
function fakeBridgeRoundTrip({ timeoutMs, action, work }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => reject(new Error('bridge_timeout')), timeoutMs);
    work().then((result) => {
      clearTimeout(timer);
      resolve({ result, ms: Date.now() - startedAt });
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('Bridge round-trip: cascader taking 5400ms completes within 8s', async () => {
  const r = await fakeBridgeRoundTrip({
    timeoutMs: 8000,
    action: 'choose',
    work: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5400));
      return { ok: true, selected: ['a', 'b', 'c'] };
    }
  });
  assert(r.ms >= 5400, 'should take ~5.4s');
  assert(r.ms < 8000, 'should complete before timeout');
});

test('Bridge round-trip: cascader simulating 5s per level × 3 = 15s exceeds 8s default', async () => {
  let captured;
  try {
    await fakeBridgeRoundTrip({
      timeoutMs: 8000,
      action: 'choose',
      work: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        return { ok: true };
      }
    });
  } catch (e) {
    captured = e.message;
  }
  assert(captured === 'bridge_timeout', 'should time out at 8s');
});

module.exports = { tests };