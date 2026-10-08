// Test harness that lets us load content.js (or extracted methods) in a
// jsdom-based DOM, plus a stub for chrome.* APIs. The agent code itself does
// not depend on Chrome-specific features at parse time, only at runtime, so
// the stubs are sufficient for exercising the logic.

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = (() => {
  try {
    return require('jsdom');
  } catch (e) {
    throw new Error('jsdom is required for the test harness. Install with `npm install --save-dev jsdom` from the 信息填写 directory.');
  }
})();

function buildChromeStub() {
  const localStore = new Map();
  return {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : [...localStore.keys()]);
          for (const key of list) {
            if (localStore.has(key)) out[key] = localStore.get(key);
          }
          if (typeof cb === 'function') cb(out);
          return Promise.resolve(out);
        },
        set: (obj, cb) => {
          for (const [k, v] of Object.entries(obj || {})) localStore.set(k, v);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        remove: (keys, cb) => {
          const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : []);
          for (const key of list) localStore.delete(key);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      }
    },
    runtime: {
      getURL: (rel) => `chrome-extension://fake/${rel}`,
      onMessage: { addListener: () => {} }
    }
  };
}

function loadInDom({ dom, scripts }) {
  const window = dom.window;
  for (const script of scripts) {
    const code = fs.readFileSync(script, 'utf8');
    if (path.basename(script).includes('content.js')) {
      // content.js uses chrome.* APIs and DOM APIs. Evaluate it in window context.
      const wrapped = `(() => { ${code} \n; if (typeof module === 'undefined') {}; })();`;
      window.eval(wrapped);
    } else {
      window.eval(code);
    }
  }
  return window;
}

function buildDom({ html = '<!DOCTYPE html><html><body></body></html>' } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
  dom.window.chrome = buildChromeStub();
  // jsdom does not implement CustomEvent in some older versions; patch defensively.
  if (typeof dom.window.CustomEvent !== 'function') {
    dom.window.CustomEvent = class CustomEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
    };
  }
  return dom;
}

function createHarness(options = {}) {
  const dom = buildDom(options);
  const window = dom.window;
  return { dom, window };
}

module.exports = { createHarness, loadInDom, buildChromeStub };
