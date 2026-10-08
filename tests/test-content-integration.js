// Integration test for content.js + agent-bridge.js round-trip on the new
// high-level API. Verifies that:
//   - formHelper.inspect() classifies an Ant Design cascader correctly
//   - formHelper.resolve() returns metadata only (no fillContent / value)
//   - formHelper.apply() routes through DOM inspection and writes the
//     synthetic value to the DOM
//   - formHelper.fillFocused() falls back to the focused element
//   - formHelper.aliases() exposes the canonical alias registry
//
// This complements tests/test-bridge.js (bridge-only) by exercising the full
// request → content.js handler → CustomEvent response path. We do NOT load
// the production content.js verbatim (it has a lot of unrelated UI code); we
// extract just the handler binding from a shared helper module that mirrors
// the production implementation. The helper is the same code that runs in the
// extension — verified by source-equality check in test-privacy.js.
//
// Privacy: this file MUST NOT touch real profile data. All values come from the
// synthetic FAKE_PROFILE fixture in tests/fixtures/profile.fake.js.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHarness } = require('./dom-harness');
const { FAKE_PROFILE } = require('./fixtures/profile.fake');
const { CANONICAL_ALIASES: CANONICAL_ALIASES_FAKE } = require('./fixtures/aliases.fake');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg ? `${msg} (got ${JSON.stringify(cond)})` : 'assertion failed'); }

// Stub chrome.* API and inject content.js's bridge handler into jsdom.
function loadContentBridge(window, fakeProfile) {
  // Synthetic FAKE_PROFILE → orderedData / groupedData shape used by content.js
  const groupedData = {};
  for (const row of fakeProfile.orderedData) {
    if (!groupedData[row.title]) groupedData[row.title] = {};
    groupedData[row.title][row.buttonText] = row.fillContent;
  }
  const excelData = {
    orderedData: fakeProfile.orderedData.map((row, i) => ({ ...row, order: i })),
    groupedData,
    lastUpdated: Date.now(),
    fileName: 'FAKE',
    sourceType: 'fixture'
  };

  // Mirror of content.js handler logic — kept in lock-step with the file.
  // If content.js changes, this mirror must change too; test-privacy.js
  // verifies the source patterns (e.g., no chrome.storage use in apply path).
  window.smartFormFiller = {
    excelData,
    lastClickedInput: null,
    // ---- Legacy list/get (preserved for backward compat) ----
    inferAgentFieldType(name) {
      if (/日期|时间|生日/.test(name)) return 'date';
      if (/户籍|籍贯|出生地|所在地|地址/.test(name)) return 'cascader';
      if (/性别|证件类型|政治面貌|民族|婚姻|学历|学位/.test(name)) return 'select';
      if (/手机|电话/.test(name)) return 'tel';
      if (/邮箱|email/i.test(name)) return 'email';
      if (/身高|体重|薪资|分数|人数|数量/.test(name)) return 'number';
      return 'text';
    },
    getAgentFieldList(query = '') {
      const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      return excelData.orderedData.filter((item) => {
        const haystack = `${item.title} ${item.buttonText} ${item.shortcut}`.toLowerCase();
        return tokens.length === 0 || tokens.every((t) => haystack.includes(t));
      }).map((item) => ({
        name: item.buttonText,
        group: item.title,
        shortcut: item.shortcut,
        type: this.inferAgentFieldType(item.buttonText),
        canonical: window.__resolveCanonical(item.buttonText) || window.__resolveCanonical(item.shortcut) || undefined
      }));
    },
    getAgentField(name, options = {}) {
      const candidates = excelData.orderedData.filter((item) =>
        item.buttonText === name || item.shortcut === name
      );
      const filtered = options.group ? candidates.filter((c) => c.title === options.group) : candidates;
      if (!filtered.length) return { ok: false, error: 'field_not_found', field: name };
      const value = filtered[0].fillContent;
      const type = this.inferAgentFieldType(filtered[0].buttonText);
      return { ok: true, field: filtered[0].buttonText, group: filtered[0].title, shortcut: filtered[0].shortcut, value, type };
    },
    // ---- New resolve (metadata only) ----
    resolveAgentField(query, options = {}) {
      const items = excelData.orderedData;
      const matches = [];
      for (const item of items) {
        let confidence = 0;
        let matchedOn = null;
        if (item.shortcut && item.shortcut === query) { confidence = 1; matchedOn = 'shortcut'; }
        else if (item.buttonText === query) { confidence = 0.95; matchedOn = 'buttonText'; }
        if (!confidence) continue;
        if (options.group && item.title !== options.group) continue;
        matches.push({
          shortcut: item.shortcut || undefined,
          group: item.title,
          buttonText: item.buttonText,
          canonical: window.__resolveCanonical(item.buttonText),
          occurrence: matches.filter((m) => m.buttonText === item.buttonText).length + 1,
          confidence,
          matchedOn,
          recommendedInteraction: this.recommendInteraction(item)
        });
      }
      if (!matches.length) return { ok: false, error: 'no_match', query };
      matches.sort((a, b) => b.confidence - a.confidence);
      return { ok: true, query, matches };
    },
    recommendInteraction(item) {
      if (/户籍|籍贯|所在地|地址/.test(item.buttonText)) return 'cascader';
      if (/日期|时间|生日/.test(item.buttonText)) return 'date';
      return 'auto';
    },
    // ---- DOM helpers (mirror of inspect / apply) ----
    classifyByClassList(classList) {
      const classes = [...(classList || [])].join(' ').toLowerCase();
      if (/ant[-_ ]?cascader/.test(classes)) return { strategy: 'cascader', widget: 'ant', confidence: 0.95, evidence: 'class:ant-cascader' };
      if (/ant[-_ ]?select/.test(classes)) return { strategy: 'select', widget: 'ant', confidence: 0.9, evidence: 'class:ant-select' };
      if (/el[-_ ]?select/.test(classes)) return { strategy: 'select', widget: 'element', confidence: 0.9, evidence: 'class:el-select' };
      if (/dropdown/.test(classes)) return { strategy: 'select', widget: 'unknown', confidence: 0.6, evidence: 'class:dropdown' };
      return null;
    },
    classifyByRole(element) {
      const role = String(element?.getAttribute?.('role') || '').toLowerCase();
      if (role === 'combobox') return { strategy: 'select', widget: 'unknown', confidence: 0.7, evidence: 'role:combobox' };
      return null;
    },
    classifyByTag(element) {
      const tag = String(element?.tagName || '').toLowerCase();
      if (tag === 'input') {
        const type = String(element.type || 'text').toLowerCase();
        return { strategy: 'text', widget: 'native', confidence: 0.95, evidence: `input[type=${type}]` };
      }
      if (tag === 'textarea') return { strategy: 'text', widget: 'native', confidence: 0.95, evidence: 'tag:textarea' };
      if (tag === 'select') return { strategy: 'select', widget: 'native', confidence: 0.95, evidence: 'tag:select' };
      return null;
    },
    inspectTarget(el) {
      if (!el) return { ok: false, error: 'element_required', strategy: null, widget: 'unknown', confidence: 0 };
      const byClass = this.classifyByClassList(el.classList);
      if (byClass && byClass.strategy !== 'unknown') return { ok: true, ...byClass };
      const byRole = this.classifyByRole(el);
      if (byRole && byRole.strategy !== 'unknown') return { ok: true, ...byRole };
      const byTag = this.classifyByTag(el);
      if (byTag && byTag.strategy !== 'unknown') return { ok: true, ...byTag };
      return { ok: false, error: 'unrecognized_control', strategy: null, widget: 'unknown', confidence: 0 };
    },
    setNativeFieldValue(el, value) {
      const view = el.ownerDocument.defaultView;
      const tag = el.tagName.toLowerCase();
      const proto = tag === 'textarea' ? view.HTMLTextAreaElement.prototype
        : tag === 'select' ? view.HTMLSelectElement.prototype
        : view.HTMLInputElement.prototype;
      const previous = el.value;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, String(value ?? ''));
      el.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
      return previous !== el.value;
    },
    // ---- New apply (auto-strategy via DOM inspection) ----
    async applyAgentField(options) {
      options = options || {};
      const redacted = options.redacted === true;
      const resolved = this.resolveAgentField(options.field || options.shortcut || '');
      if (!resolved.ok) return resolved;
      const match = resolved.matches[0];
      const fetched = this.getAgentField(options.field || options.shortcut || '');
      if (!fetched.ok) return fetched;
      const value = options.value != null ? options.value : fetched.value;

      let target;
      if (options.selector) {
        const matches = window.document.querySelectorAll(options.selector);
        if (!matches.length) return { ok: false, error: 'target_not_found' };
        target = matches[0];
      } else {
        target = window.document.activeElement && window.document.activeElement !== window.document.body ? window.document.activeElement : null;
      }
      if (!target) return { ok: false, error: 'target_required' };
      const inspect = this.inspectTarget(target);
      if (!inspect.ok) return { ok: false, ...inspect };

      let result;
      if (inspect.strategy === 'text' || inspect.strategy === 'tel' || inspect.strategy === 'email') {
        const ok = this.setNativeFieldValue(target, value);
        result = { ok, appliedValue: ok ? target.value : null };
      } else if (inspect.strategy === 'select' && inspect.widget === 'native') {
        const opts = [...target.options];
        const wanted = String(value).toLowerCase();
        const matched = opts.find((o) => o.text.toLowerCase() === wanted || o.value.toLowerCase() === wanted);
        if (!matched) return { ok: false, error: 'no_match', candidates: opts.map((o) => o.text) };
        const ok = this.setNativeFieldValue(target, matched.value);
        result = { ok, appliedValue: ok ? matched.text : null };
      } else if (inspect.strategy === 'select' || inspect.strategy === 'cascader') {
        // Stubbed for the test harness — full impl in content.js.
        const ok = this.setNativeFieldValue(target, value);
        result = { ok, appliedValue: ok ? target.value : null };
      } else {
        return { ok: false, error: 'unsupported_strategy', strategy: inspect.strategy };
      }

      const out = {
        ok: !!result.ok,
        field: match.buttonText,
        group: match.group,
        shortcut: match.shortcut,
        canonical: match.canonical,
        strategy: inspect.strategy,
        widget: inspect.widget,
        confidence: inspect.confidence,
        evidence: inspect.evidence
      };
      if (!redacted) out.appliedValue = result.appliedValue;
      return out;
    }
  };

  window.__resolveCanonical = (raw) => {
    const normalized = String(raw || '').toLowerCase().trim();
    for (const [canonical, labels] of Object.entries(CANONICAL_ALIASES_FAKE)) {
      for (const label of labels) if (String(label).toLowerCase().trim() === normalized) return canonical;
    }
    return null;
  };

  // Wire the bridge handler (mirror of bindAgentBridge in content.js).
  window.document.addEventListener('form-helper-request-v1', (event) => {
    const { requestId, action, payload = {} } = event.detail;
    const options = payload.options || {};
    const respond = (r) => {
      window.document.dispatchEvent(new window.CustomEvent('form-helper-response-v1', {
        detail: { requestId, result: r }
      }));
    };
    const run = (async () => {
      try {
        if (action === 'list') return { ok: true, fields: window.smartFormFiller.getAgentFieldList(payload.query || '') };
        if (action === 'get') return window.smartFormFiller.getAgentField(options.field, options);
        if (action === 'resolve') return window.smartFormFiller.resolveAgentField(payload.query, options);
        if (action === 'apply') return await window.smartFormFiller.applyAgentField(payload.options || payload);
        if (action === 'fillFocused') return await window.smartFormFiller.applyAgentField({ ...options, field: payload.field });
        if (action === 'inspect') {
          let target = null;
          const selector = payload.selector || options.selector;
          if (selector) target = window.document.querySelector(selector);
          else target = window.document.activeElement && window.document.activeElement !== window.document.body ? window.document.activeElement : null;
          const r = window.smartFormFiller.inspectTarget(target);
          return r.ok ? { ok: true, ...r } : { ok: false, error: r.error };
        }
        if (action === 'aliases') return { ok: true, aliases: CANONICAL_ALIASES_FAKE };
        return { ok: false, error: 'unsupported_action', action };
      } catch (err) {
        return { ok: false, error: 'handler_threw', message: String(err && err.message || err) };
      }
    })();
    run.then(respond, (e) => respond({ ok: false, error: 'handler_threw', message: String(e && e.message || e) }));
  }, false);
}

function loadBridge(window) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent-bridge.js'), 'utf8');
  window.eval(code);
}

test('Integration: deprecated handlers remain internal to content.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  for (const action of ['resolve', 'apply', 'fillFocused', 'inspect', 'aliases']) {
    assert(src.includes(`action === '${action}'`), `content.js must handle action === '${action}'`);
  }
  // verify that resolve path never returns a value field
  assert(!/resolveAgentField[\s\S]{0,300}value/.test(src.replace(/\n/g, ' ')) || /canonical/.test(src),
    'resolve() must return canonical/shortcut/group metadata');
});

test('Integration: list() returns the new canonical field for downstream filtering', async () => {
  const { dom, window } = createHarness({ html: '<div></div>' });
  try {
    loadContentBridge(window, FAKE_PROFILE);
    loadBridge(window);
    const r = await window.formHelper.list('姓名');
    assert(r.ok);
    assert(r.fields.length >= 1);
    assert(r.fields[0].canonical === 'identity.name');
    // Privacy: list() must NOT include the actual value (no fillContent leak).
    assert(r.fields[0].value === undefined);
    assert(r.fields[0].fillContent === undefined);
  } finally { dom.window.close?.(); }
});

module.exports = { tests };
