'use strict';

const fs = require('fs');
const path = require('path');
const { createHarness } = require('./dom-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function loadActualContent() {
  const { dom, window } = createHarness();
  window.Audio = function Audio() { return { play: () => Promise.resolve() }; };
  window.eval(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(window.smartFormFiller, 'actual SmartFormFiller should initialize');
  window.smartFormFiller.excelData = {
    orderedData: [
      { title: '基本信息', buttonText: '姓名', fillContent: '示例姓名', shortcut: 'xm' },
      { title: '基本信息', buttonText: '手机号', fillContent: '13800000000', shortcut: 'sjh' },
      { title: '家庭成员1', buttonText: '关系', fillContent: '父亲', shortcut: 'fqgx' },
      { title: '家庭成员1', buttonText: '姓名', fillContent: '示例家长', shortcut: 'fqxm' }
    ]
  };
  return { dom, window };
}

test('Hierarchical list: default level 1 returns groups and compact field names', async () => {
  const { dom, window } = await loadActualContent();
  try {
    const result = window.smartFormFiller.getAgentFieldList();
    assert(result.ok && result.level === 1);
    assert(result.groups.length === 2);
    assert(result.groups[0].group_name === '基本信息');
    assert(result.groups[0].group_fields.join(',') === '姓名,手机号');
    assert(result.groups[1].group_context === '父亲');
  } finally { dom.window.close?.(); }
});

test('Hierarchical list: level 2 requires group_name and hides values by default', async () => {
  const { dom, window } = await loadActualContent();
  try {
    const missing = window.smartFormFiller.getAgentFieldList({ level: 2 });
    assert(!missing.ok && missing.error === 'group_name_required');
    const result = window.smartFormFiller.getAgentFieldList({ level: 2, group_name: '基本信息' });
    assert(result.ok && result.fields.length === 2);
    assert(result.fields[0].field_name === '姓名');
    assert(result.fields[0].shortcut === 'xm');
    assert(result.fields[0].has_value === true);
    assert(result.fields[0].field_value === undefined);
  } finally { dom.window.close?.(); }
});

test('Hierarchical list: explicit level null returns all and can opt into values', async () => {
  const { dom, window } = await loadActualContent();
  try {
    const result = window.smartFormFiller.getAgentFieldList({ level: null, include_values: true });
    assert(result.ok && result.level === null);
    assert(result.fields.length === 4);
    assert(result.fields[0].field_value === '示例姓名');
  } finally { dom.window.close?.(); }
});

test('Hierarchical list: legacy semantic string search still works', async () => {
  const { dom, window } = await loadActualContent();
  try {
    const result = window.smartFormFiller.getAgentFieldList('父亲 姓名');
    assert(Array.isArray(result) && result.length === 1);
    assert(result[0].shortcut === 'fqxm');
  } finally { dom.window.close?.(); }
});

test('Hierarchical list: public bridge preserves level 1, level 2, and null', async () => {
  const { dom, window } = await loadActualContent();
  try {
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'agent-bridge.js'), 'utf8'));
    const level1 = await window.formHelper.list();
    assert(level1.ok && level1.level === 1 && level1.groups.length === 2);
    const level2 = await window.formHelper.list({ level: 2, group_name: '基本信息' });
    assert(level2.ok && level2.level === 2 && level2.fields[0].field_name === '姓名');
    const all = await window.formHelper.list({ level: null });
    assert(all.ok && all.level === null && all.fields.length === 4);
  } finally { dom.window.close?.(); }
});

module.exports = { tests };
