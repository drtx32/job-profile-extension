// DOM inspection for the agent API.
//
// inspectTarget() decides how the agent should interact with a given DOM element
// based on the element's actual characteristics — tagName, input type, role,
// class hooks for common UI kits (Ant Design / Element Plus) — and NOT on the
// profile field name. The agent then calls apply() which routes to the right
// strategy based on this inspection.

'use strict';

// Each inspect entry has:
//   strategy: 'text' | 'date' | 'month' | 'number' | 'tel' | 'email' | 'file'
//           | 'select' | 'cascader' | 'unknown'
//   widget: 'native' | 'ant' | 'element' | 'unknown'
//   confidence: 0..1
//   evidence: short string describing what triggered the classification

function classifyByClassList(classList) {
  const classes = (classList && typeof classList.length === 'number')
    ? [...classList].join(' ').toLowerCase()
    : String(classList || '').toLowerCase();
  if (!classes) return null;
  if (/ant[-_ ]?cascader/.test(classes) || /ant[-_ ]?select.*tree/.test(classes)) {
    return { strategy: 'cascader', widget: 'ant', confidence: 0.95, evidence: 'class:ant-cascader' };
  }
  if (/ant[-_ ]?select(?!.*tree)/.test(classes) || /ant[-_ ]?autocomplete/.test(classes)) {
    return { strategy: 'select', widget: 'ant', confidence: 0.9, evidence: 'class:ant-select' };
  }
  if (/el[-_ ]?cascader/.test(classes)) {
    return { strategy: 'cascader', widget: 'element', confidence: 0.95, evidence: 'class:el-cascader' };
  }
  if (/el[-_ ]?select/.test(classes)) {
    return { strategy: 'select', widget: 'element', confidence: 0.9, evidence: 'class:el-select' };
  }
  if (/[-_ ]?cascader[-_ ]?/.test(classes) || /cascader/.test(classes)) {
    return { strategy: 'cascader', widget: 'unknown', confidence: 0.7, evidence: 'class:*cascader*' };
  }
  if (/[-_ ]?select[-_ ]?/.test(classes) || /dropdown$|!class:.*dropdown.*/.test(classes) || /dropdown/.test(classes)) {
    return { strategy: 'select', widget: 'unknown', confidence: 0.6, evidence: 'class:*dropdown*' };
  }
  return null;
}

function classifyByRole(element) {
  const role = String(element?.getAttribute?.('role') || '').toLowerCase();
  if (!role) return null;
  if (role === 'combobox' || role === 'listbox') {
    // Combobox is ambiguous between select-like and search-box. Look for child options.
    const hasTree = element.querySelector('[role="treeitem"], [class*="cascader"]');
    return {
      strategy: hasTree ? 'cascader' : 'select',
      widget: 'unknown',
      confidence: hasTree ? 0.75 : 0.7,
      evidence: `role:${role}${hasTree ? '+tree' : ''}`
    };
  }
  if (role === 'textbox' || role === 'searchbox') {
    return { strategy: 'text', widget: 'native', confidence: 0.6, evidence: `role:${role}` };
  }
  return null;
}

function classifyByTag(element) {
  const tag = String(element?.tagName || '').toLowerCase();
  if (tag === 'select') return { strategy: 'select', widget: 'native', confidence: 0.95, evidence: 'tag:select' };
  if (tag === 'textarea') return { strategy: 'text', widget: 'native', confidence: 0.95, evidence: 'tag:textarea' };
  if (tag === 'input') {
    const type = String(element.type || 'text').toLowerCase();
    if (type === 'file') return { strategy: 'file', widget: 'native', confidence: 1, evidence: 'input[type=file]' };
    if (type === 'date' || type === 'datetime-local') return { strategy: 'date', widget: 'native', confidence: 0.95, evidence: `input[type=${type}]` };
    if (type === 'month') return { strategy: 'month', widget: 'native', confidence: 0.95, evidence: 'input[type=month]' };
    if (type === 'time') return { strategy: 'text', widget: 'native', confidence: 0.6, evidence: 'input[type=time]' };
    if (type === 'email') return { strategy: 'email', widget: 'native', confidence: 0.95, evidence: 'input[type=email]' };
    if (type === 'tel') return { strategy: 'tel', widget: 'native', confidence: 0.95, evidence: 'input[type=tel]' };
    if (type === 'number') return { strategy: 'number', widget: 'native', confidence: 0.95, evidence: 'input[type=number]' };
    if (type === 'password') return { strategy: 'text', widget: 'native', confidence: 0.7, evidence: 'input[type=password]' };
    if (['text', 'search', 'url'].includes(type) || !type) return { strategy: 'text', widget: 'native', confidence: 0.85, evidence: `input[type=${type || 'text'}]` };
  }
  if (tag === 'div' || tag === 'span') {
    // Often a custom widget wrapper; check inner content.
    return classifyByClassList(element.classList) || classifyByRole(element) || { strategy: 'unknown', widget: 'unknown', confidence: 0, evidence: 'tag:div/span' };
  }
  return null;
}

function inspectTarget(element) {
  if (!element || (typeof Element !== 'undefined' && !(element instanceof Element)) && typeof Node !== 'undefined' && !(element instanceof Node)) {
    return { ok: false, error: 'element_required', strategy: 'unknown', widget: 'unknown', confidence: 0, evidence: 'no_element' };
  }
  // Order: class (most specific to UI kit) → role (semantic) → tag (fallback).
  const byClass = classifyByClassList(element.classList);
  if (byClass && byClass.confidence >= 0.8 && byClass.strategy !== 'unknown') return { ok: true, ...byClass };
  const byRole = classifyByRole(element);
  if (byRole && byRole.confidence >= 0.7 && byRole.strategy !== 'unknown') return { ok: true, ...byRole };
  const byTag = classifyByTag(element);
  if (byTag && byTag.strategy !== 'unknown') return { ok: true, ...byTag };
  return { ok: false, error: 'unrecognized_control', strategy: null, widget: 'unknown', confidence: 0, evidence: 'no_match' };
}

// isChoiceElement describes an interactive dropdown option. Used by waitForAgentChoice.
function isChoiceElement(element) {
  if (!element) return false;
  const role = String(element.getAttribute?.('role') || '').toLowerCase();
  if (role === 'option' || role === 'menuitem' || role === 'treeitem') return true;
  const classes = [...(element.classList || [])].join(' ').toLowerCase();
  return /select-item-option|select-item|cascader-menu-item|cascader-node|el-select-dropdown__item|ant-select-item/.test(classes);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { inspectTarget, isChoiceElement, classifyByClassList, classifyByRole, classifyByTag };
}