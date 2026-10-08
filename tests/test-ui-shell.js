'use strict';

const fs = require('fs');
const path = require('path');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const root = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('UI shell: uses the current neutral product name', () => {
  assert(manifest.name === '表单资料助手');
  assert(content.includes('panel-brand'));
  assert(content.includes('表单资料助手'));
});

test('UI shell: old brand and sales copy are absent from runtime files', () => {
  const runtime = `${content}\n${styles}\n${background}\n${JSON.stringify(manifest)}`;
  for (const phrase of ['校招资料猿', '倒卖必究', '信息插件3.0']) {
    assert(!runtime.includes(phrase), `runtime still contains ${phrase}`);
  }
});

test('UI shell: edge launcher is fixed and not draggable', () => {
  assert(styles.includes('top:50%'));
  assert(styles.includes('right:0'));
  assert(!content.includes('initDragAndDrop'));
  assert(!content.includes('.draggable = true'));
});

test('UI shell: panel has an explicit accessible close control', () => {
  assert(content.includes('id="close-sidebar-btn"'));
  assert(content.includes('aria-label="关闭资料面板"'));
});

test('UI shell: background only injects and wakes the canonical UI', () => {
  assert(!background.includes('innerHTML'));
  assert(background.includes("files: ['content.js']"));
  assert(background.includes("action: 'showSidebar'"));
});

test('UI shell: page UI is injected into the top frame only', () => {
  assert(manifest.content_scripts.every((entry) => entry.all_frames === false));
});

test('UI shell: all controls use one Windows Chinese font stack', () => {
  assert(styles.includes('font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif!important'));
  assert(!styles.includes('Inter'));
  assert(!/font-weight:(550|650)/.test(styles));
});

test('UI shell: supports draggable floating and right-docked panel modes', () => {
  assert(content.includes('initializePanelDrag()'));
  assert(content.includes("classList.add('is-floating', 'is-dragging')"));
  assert(content.includes('dockSidebar()'));
  assert(styles.includes('.smart-form-sidebar.is-floating.is-open'));
});

test('UI shell: GitHub link opens natively and is excluded from panel dragging', () => {
  assert(content.includes('id="project-github-link"'));
  assert(content.includes('target="_blank"'));
  assert(content.includes('href="https://github.com/drtx32/job-profile-extension"'));
  assert(content.includes("event.target.closest('a, button, input, select, textarea, [role=\"button\"]')"));
  assert(!content.includes("action: 'openProjectPage'"));
});

test('UI shell: provides searchable horizontal group tabs and recents', () => {
  assert(content.includes('id="field-search"'));
  assert(content.includes('id="field-tabs"'));
  assert(content.includes("[['all', '全部'], ['recent', '最近']"));
  assert(content.includes('rememberRecentField(item)'));
  assert(content.includes('form_profile_ui_v1'));
  assert(styles.includes('overflow-x:auto'));
});

test('UI shell: Ctrl+Slash opens the shortcut center', () => {
  assert(content.includes("event.code === 'Slash'"));
  assert(content.includes('id="shortcut-dialog"'));
  assert(content.includes('renderShortcutList()'));
});

test('UI shell: source actions are combined and Excel imports immediately', () => {
  assert(content.includes('class="source-card"'));
  assert(content.includes('id="clipboard-import-btn"'));
  assert(!content.includes('文件已选择，点击刷新按钮更新数据'));
});

test('UI shell: failed field fills use a prominent dismissible toast', () => {
  assert(content.includes('id="toast-region"'));
  assert(content.includes('showToast({ title:'));
  assert(content.includes('toast-close'));
  assert(styles.includes('.form-profile-toast.is-visible'));
  assert(styles.includes('border-left:4px solid #d92d20'));
});

test('UI shell: failed clipboard import opens a stable modal dialog', () => {
  assert(content.includes('class="manual-import-dialog"'));
  assert(content.includes('toggleManualImport(true)'));
  assert(content.includes('data-close-manual-import'));
  assert(styles.includes('.manual-import-dialog{position:absolute'));
});

test('UI shell: Alt plus and minus resize fields without resizing tabs', () => {
  assert(content.includes("['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract']"));
  assert(content.includes('adjustFieldScale('));
  assert(content.includes('fieldScale: this.fieldScale'));
  assert(styles.includes('--field-scale'));
});

module.exports = { tests };
