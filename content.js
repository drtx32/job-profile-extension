// 表单资料助手 — Content script (ISOLATED world)
//
// Refactor notes (ELI-401):
//   P0-1: cascader timeouts — waitForAgentChoice no longer limits to 1800ms by
//         default. The bridge side passes a per-action timeout; the content
//         side uses ACTION_TIMEOUTS[index] as a safety ceiling so a 3-level
//         cascader (1800ms × 3 + slack = 5600ms) does not collapse to the
//         default 3000ms bridge budget.
//   P0-2: high-level API (resolve / apply / fillFocused / inspect / aliases)
//         drives DOM inspection rather than guessing by field name; returns
//         metadata only by default.
//   P1-2: inspectTarget() in lib/inspect.js is the single source of truth for
//         DOM classification. inferAgentFieldType() is now a fallback for
//         ambiguous cases and is no longer the primary path.
//   P1-3: aliases are resolved through lib/aliases.js. resolve() returns
//         shortcut / group / canonical / confidence — values stay inside the
//         extension and never reach the page via list/resolve.

(function () {
  'use strict';

  // Load helpers that work in both the extension context and Node tests.
  // The lib/*.js files are CommonJS; we read their source at install time and
  // inline the same logic here. To keep this file self-contained, we duplicate
  // the inspect / apply / alias logic and re-implement any DOM-only branch.
  // The duplication is intentional: content.js must run without any require()
  // call. Tests against lib/* guard the behavior of those modules; this file
  // is a parallel implementation kept in lock-step via the same names.

  const ROOT_NS = '__formHelperImpl';

  // ---- Pure-logic shims (mirror of lib/*.js, kept self-contained) ----
  function buildReverseMap(aliases) {
    const map = Object.create(null);
    for (const [canonical, labels] of Object.entries(aliases || {})) {
      for (const label of labels || []) {
        const normalized = String(label || '').toLowerCase().trim();
        if (!normalized) continue;
        if (!map[normalized]) map[normalized] = canonical;
      }
    }
    return map;
  }

  const DEFAULT_CANONICAL_ALIASES = {
    'identity.name': ['姓名', 'xm', 'name', 'full_name'],
    'identity.phone': ['手机号', '手机', 'sjh', 'phone', 'mobile'],
    'identity.email': ['常用邮箱', '邮箱', 'cyyx', 'email'],
    'identity.id_number': ['身份证号码', '身份证', 'sfzh', 'id_card'],
    'identity.gender': ['性别', 'xb', 'gender'],
    'identity.birth_date': ['出生日期', '生日', 'csrq', 'birth_date', 'birthday'],
    'location.hukou': ['户籍所在地', '户籍', 'hkszd', 'hukou'],
    'location.current': ['现居住地', '居住地', 'xjzd', 'current_address'],
    'location.work_city': ['期望工作城市', '工作城市', 'qwgzcs', 'work_city'],
    'education.school': ['学校名称', '毕业院校', '院校名称', '就读学校', '院校', 'xxmc', 'school', 'school_name'],
    'education.major': ['专业', '所学专业', '专业名称', 'zy', 'major'],
    'education.degree': ['最高学历', '学历', '学位', 'zgxl', 'xl', 'xw', 'degree'],
    'education.start': ['入学时间', '就读开始时间', 'rxsj'],
    'education.end': ['毕业时间', '就读结束时间', 'bysj'],
    'education.gpa': ['GPA', 'gpa', '绩点'],
    'experience.employer': ['工作单位', '单位名称', 'gzdw', 'employer', 'company'],
    'experience.start': ['开始时间', '起始时间', 'kssj'],
    'experience.end': ['结束时间', '终止时间', 'jssj'],
    'intent.salary': ['期望月薪', '薪资', 'qwyx', 'salary'],
    'intent.onboard': ['到岗时间', '入职时间', 'dgsj'],
    'generic.textarea': ['自我评价', '个人简介', '自我介绍', 'zwpj']
  };

  const REVERSE_ALIASES = buildReverseMap(DEFAULT_CANONICAL_ALIASES);

  function resolveCanonical(raw) {
    if (!raw) return null;
    const normalized = String(raw).toLowerCase().trim();
    return REVERSE_ALIASES[normalized] || null;
  }

  // ---- Per-action timeout budget. Mirrors ACTION_TIMEOUTS in agent-bridge.js ----
  const ACTION_TIMEOUTS = {
    list: 5000,
    find: 5000,
    get: 5000,
    fill: 8000,
    choose: 12000,
    resolve: 5000,
    apply: 12000,
    fillFocused: 8000,
    inspect: 5000,
    aliases: 5000
  };

  // Cascader time budgets. With 3 levels and 1800ms per level, total = 5.4s
  // plus 200ms slack = 5.6s. Bridge default for choose/apply is 12s so this
  // comfortably fits.
  const DEFAULT_LEVEL_WAIT_MS = 1800;
  const CASCADER_LEVELS_DEFAULT = 3;

  function clampTimeout(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1000, Math.min(120000, n));
  }

  // ---- DOM inspection (mirrors lib/inspect.js) ----
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
    if (/el[-_ ]?cascader/.test(classes)) return { strategy: 'cascader', widget: 'element', confidence: 0.95, evidence: 'class:el-cascader' };
    if (/el[-_ ]?select/.test(classes)) return { strategy: 'select', widget: 'element', confidence: 0.9, evidence: 'class:el-select' };
    if (/[-_ ]?cascader[-_ ]?/.test(classes) || /cascader/.test(classes)) return { strategy: 'cascader', widget: 'unknown', confidence: 0.7, evidence: 'class:*cascader*' };
    if (/dropdown/.test(classes)) return { strategy: 'select', widget: 'unknown', confidence: 0.6, evidence: 'class:*dropdown*' };
    return null;
  }

  function classifyByRole(element) {
    const role = String(element?.getAttribute?.('role') || '').toLowerCase();
    if (!role) return null;
    if (role === 'combobox' || role === 'listbox') {
      const hasTree = element.querySelector('[role="treeitem"], [class*="cascader"]');
      return { strategy: hasTree ? 'cascader' : 'select', widget: 'unknown', confidence: hasTree ? 0.75 : 0.7, evidence: `role:${role}${hasTree ? '+tree' : ''}` };
    }
    if (role === 'textbox' || role === 'searchbox') return { strategy: 'text', widget: 'native', confidence: 0.6, evidence: `role:${role}` };
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
      if (['text', 'search', 'url'].includes(type) || !type) return { strategy: 'text', widget: 'native', confidence: 0.85, evidence: `input[type=${type || 'text'}]` };
    }
    return null;
  }

  function inspectTarget(element) {
    if (!element) return { ok: false, error: 'element_required', strategy: null, widget: 'unknown', confidence: 0, evidence: 'no_element' };
    const byClass = classifyByClassList(element.classList);
    if (byClass && byClass.confidence >= 0.8 && byClass.strategy !== 'unknown') return { ok: true, ...byClass };
    const byRole = classifyByRole(element);
    if (byRole && byRole.confidence >= 0.7 && byRole.strategy !== 'unknown') return { ok: true, ...byRole };
    const byTag = classifyByTag(element);
    if (byTag && byTag.strategy !== 'unknown') return { ok: true, ...byTag };
    return { ok: false, error: 'unrecognized_control', strategy: null, widget: 'unknown', confidence: 0, evidence: 'no_match' };
  }

  // ---- DOM mutation primitives (mirror lib/apply.js) ----
  function setNativeFieldValue(element, value) {
    if (!element) return false;
    const tagName = String(element.tagName || '').toLowerCase();
    const view = element.ownerDocument && element.ownerDocument.defaultView;
    const inputProto = view ? view.HTMLInputElement && view.HTMLInputElement.prototype : null;
    const textareaProto = view ? view.HTMLTextAreaElement && view.HTMLTextAreaElement.prototype : null;
    const selectProto = view ? view.HTMLSelectElement && view.HTMLSelectElement.prototype : null;
    const prototype = tagName === 'textarea' ? textareaProto : (tagName === 'select' ? selectProto : inputProto);
    if (!prototype) return false;
    try {
      const ownDescriptor = Object.getOwnPropertyDescriptor(element, 'value');
      if (ownDescriptor && ownDescriptor.configurable) delete element.value;
      const previous = element.value;
      const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(element, String(value ?? ''));
      else element.value = String(value ?? '');
      if (element._valueTracker && typeof element._valueTracker.setValue === 'function') {
        element._valueTracker.setValue(previous);
      }
      const EventCtor = view && view.Event ? view.Event : null;
      if (EventCtor) {
        element.dispatchEvent(new EventCtor('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new EventCtor('change', { bubbles: true, composed: true }));
      }
      return true;
    } catch (e) { return false; }
  }

  function clickElement(element) {
    if (!element) return false;
    const view = element.ownerDocument && element.ownerDocument.defaultView;
    const MouseEventCtor = view && view.MouseEvent ? view.MouseEvent : null;
    try {
      if (MouseEventCtor) {
        element.dispatchEvent(new MouseEventCtor('mousedown', { bubbles: true, cancelable: true, view }));
        element.dispatchEvent(new MouseEventCtor('mouseup', { bubbles: true, cancelable: true, view }));
        element.dispatchEvent(new MouseEventCtor('click', { bubbles: true, cancelable: true, view }));
      } else {
        element.click?.();
      }
      return true;
    } catch (e) {
      try { element.click?.(); return true; } catch (e2) { return false; }
    }
  }

  function normalizeAgentChoice(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s·•・,，。.;；:：()（）[\]【】]/g, '');
  }

  function getAgentChoiceAliases(value) {
    const normalized = normalizeAgentChoice(value);
    const groups = [
      ['中共党员', '中国共产党党员', '党员'],
      ['中共预备党员', '中国共产党预备党员', '预备党员'],
      ['共青团员', '中国共产主义青年团团员', '团员'],
      ['群众', '普通群众']
    ].map((group) => group.map((item) => normalizeAgentChoice(item)));
    const matched = groups.find((group) => group.includes(normalized));
    return new Set(matched || [normalized]);
  }

  // ---- Sidebar / Excel persistence (unchanged from v1.4.2) ----
  class SmartFormFiller {
    constructor() {
      this.sidebar = null;
      this.excelData = [];
      this.sidebarVisible = true;
      this.lastClickedInput = null;
      this.lastSelectedFillContent = null;
      this.lastSelectedFillLabel = '';
      this.isExpandingKeyword = false;
      this.currentFile = null;
      this.fileLastModified = null;
      this.fileContentHash = null;
      this.refreshCheckInterval = null;
      this.tempFile = null;
      this.autoLoadData = true;
      this.toggleSidebarHandler = null;
      this.clickHandler = null;
      this.keywordKeydownHandler = null;
      this.clipboardShortcutHandler = null;
      this.textImportHandler = null;
      this.agentBridgeHandler = null;
      this.fileUploadHandler = null;
      this.refreshButtonHandler = null;
      this.activeGroup = 'all';
      this.recentFields = [];
      this.searchQuery = '';
      this.dragState = null;
      this.fieldScale = 1;
      this.isFreshInstall = false;
      this.init();
    }

    init() {
      this.createSidebar();
      this.bindEvents();
      this.loadUiPreferences();
      this.bindAgentBridge();
      this.sidebarVisible = false;
      this.hideSidebar();
      this.createToggleButton();
      this.addDebugInfo();
      this.checkIfFreshInstall();
      try { chrome.storage.local.remove(['offer_yuan_templates_v1']); } catch (e) {}
      if (this.autoLoadData) {
        setTimeout(() => this.loadDataFromExtensionStorage(), 500);
      }
    }

    async getStoredData() {
      try {
        if (chrome?.storage?.local) {
          const result = await new Promise((resolve) => {
            try { chrome.storage.local.get(['offer_yuan_excel_data'], (res) => resolve(res || {})); } catch (e) { resolve({}); }
          });
          if (result && result.offer_yuan_excel_data) return result.offer_yuan_excel_data;
        }
      } catch (e) {}
      return null;
    }

    async setStoredData(data) {
      try {
        if (chrome?.storage?.local) {
          await new Promise((resolve) => {
            try { chrome.storage.local.set({ offer_yuan_excel_data: data }, () => resolve()); } catch (e) { resolve(); }
          });
        }
      } catch (e) {}
    }

    showStatus(message) {
      const status = this.sidebar?.querySelector('#single-data-status');
      if (status) status.textContent = message;
    }

    // Legacy helper — kept for the old fill/get path; the new resolve/apply
    // path uses inspectTarget() instead.
    inferAgentFieldType(fieldName, value) {
      const name = String(fieldName || '');
      if (/日期|时间|生日/.test(name)) return 'date';
      if (/户籍|籍贯|生源地|出生地|所在地|省市|地区|地址/.test(name)) return 'cascader';
      if (/性别|证件类型|政治面貌|民族|婚姻|学历|学位|是否|语言水平|信息来源/.test(name)) return 'select';
      if (/照片|证件照|生活照|附件|简历文件|上传/.test(name)) return 'file';
      if (/手机|电话/.test(name)) return 'tel';
      if (/邮箱|email/i.test(name)) return 'email';
      if (/身高|体重|薪资|分数|人数|数量/.test(name)) return 'number';
      return String(value || '').length > 80 ? 'textarea' : 'text';
    }

    getAgentFieldPath(value) {
      const rawValue = String(value ?? '').trim();
      if (!rawValue) return [];
      const parts = rawValue.split(/\s*(?:\/|\\|>|＞|→|—|–|,|，|;|；)\s*/).filter(Boolean);
      return parts.length > 1 ? parts : [rawValue];
    }

    normalizeProfileValue(fieldName, value) {
      const name = String(fieldName || '').trim();
      if (!/日期|时间|生日/.test(name)) return String(value ?? '').trim();
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      const text = String(value ?? '').trim();
      if (/^\d+(?:\.\d+)?$/.test(text)) {
        const serial = Number(text);
        if (serial > 0 && serial < 100000) {
          const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
          if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
        }
      }
      return text;
    }

    getAgentFieldContext(item) {
      const group = String(item?.title || '').trim();
      const relation = (this.excelData?.orderedData || []).find((candidate) =>
        String(candidate.title || '').trim() === group && String(candidate.buttonText || '').trim() === '关系'
      );
      return String(relation?.fillContent || '').trim();
    }

    // ---- Hierarchical field discovery ----
    buildAgentFieldMetadata(item, occurrence, includeValues = false) {
      const fieldName = String(item.buttonText || '').trim();
      const fieldValue = this.normalizeProfileValue(fieldName, item.fillContent);
      const metadata = {
        field_name: fieldName,
        shortcut: String(item.shortcut || '').trim() || undefined,
        field_type: this.inferAgentFieldType(fieldName, fieldValue),
        has_value: fieldValue !== '',
        occurrence,
        canonical: resolveCanonical(fieldName) || resolveCanonical(item.shortcut) || undefined
      };
      if (includeValues) metadata.field_value = fieldValue;
      return metadata;
    }

    getAgentFieldList(request = {}) {
      // Backward compatibility: list('父亲 姓名') remains a semantic flat search.
      if (typeof request === 'string' && request.trim()) {
        return this.searchAgentFields(request);
      }
      const options = request && typeof request === 'object' ? request : {};
      const hasExplicitLevel = Object.prototype.hasOwnProperty.call(options, 'level');
      const level = hasExplicitLevel ? options.level : 1;
      const includeValues = options.include_values === true;
      const orderedData = this.excelData?.orderedData || [];

      if (level === null || String(level).toLowerCase() === 'none' || String(level).toLowerCase() === 'all') {
        return {
          ok: true,
          level: null,
          fields: this.searchAgentFields('', { includeValues })
        };
      }

      if (Number(level) === 2) {
        const groupName = String(options.group_name || '').trim();
        if (!groupName) return { ok: false, error: 'group_name_required', level: 2 };
        const groupItems = orderedData.filter((item) => String(item.title || '').trim() === groupName);
        if (!groupItems.length) return { ok: false, error: 'group_not_found', level: 2, group_name: groupName };
        const occurrences = new Map();
        const fields = groupItems.map((item) => {
          const name = String(item.buttonText || '').trim();
          const occurrence = (occurrences.get(name) || 0) + 1;
          occurrences.set(name, occurrence);
          return this.buildAgentFieldMetadata(item, occurrence, includeValues);
        });
        return { ok: true, level: 2, group_name: groupName, fields };
      }

      if (Number(level) !== 1) return { ok: false, error: 'invalid_level', supported_levels: [1, 2, null] };
      const groups = [];
      const groupMap = new Map();
      for (const item of orderedData) {
        const groupName = String(item.title || '').trim();
        const fieldName = String(item.buttonText || '').trim();
        if (!groupName || !fieldName) continue;
        let group = groupMap.get(groupName);
        if (!group) {
          group = { group_name: groupName, group_fields: [], field_count: 0 };
          const context = this.getAgentFieldContext(item);
          if (context) group.group_context = context;
          groupMap.set(groupName, group);
          groups.push(group);
        }
        if (!group.group_fields.includes(fieldName)) group.group_fields.push(fieldName);
        group.field_count += 1;
      }
      return { ok: true, level: 1, groups };
    }

    searchAgentFields(query = '', options = {}) {
      const occurrences = new Map();
      const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const includeValues = options.includeValues === true;
      return (this.excelData?.orderedData || []).reduce((fields, item) => {
        const name = String(item.buttonText || '').trim();
        if (!name) return fields;
        const occurrence = (occurrences.get(name) || 0) + 1;
        occurrences.set(name, occurrence);
        const group = String(item.title || '').trim();
        const shortcut = String(item.shortcut || '').trim();
        const context = this.getAgentFieldContext(item);
        const haystack = `${group} ${name} ${shortcut} ${context}`.toLowerCase();
        if (tokens.length && !tokens.every((token) => haystack.includes(token))) return fields;
        const metadata = this.buildAgentFieldMetadata(item, occurrence, includeValues);
        fields.push({ group_name: group, group_context: context || undefined, ...metadata });
        return fields;
      }, []);
    }

    getAgentField(fieldName, options) {
      options = options || {};
      const requestedName = String(fieldName || '').trim();
      if (!requestedName) return { ok: false, error: 'field_name_required' };
      const allItems = this.excelData?.orderedData || [];
      const shortcutMatches = allItems.filter((item) => String(item.shortcut || '').trim() === requestedName);
      const allMatches = shortcutMatches.length ? shortcutMatches : allItems.filter((item) =>
        String(item.buttonText || '').trim() === requestedName
      );
      const requestedGroup = String(options.group || '').trim();
      const matches = requestedGroup
        ? allMatches.filter((item) => String(item.title || '').trim() === requestedGroup)
        : allMatches;
      if (!matches.length) return { ok: false, error: 'field_not_found', field: requestedName };

      const occurrence = Number(options.occurrence || 0);
      if (Number.isInteger(occurrence) && occurrence > 0) {
        const selected = matches[occurrence - 1];
        if (!selected) {
          return { ok: false, error: 'occurrence_not_found', field: requestedName, group: requestedGroup || undefined, matchCount: matches.length };
        }
        const actualName = String(selected.buttonText || '').trim();
        const value = this.normalizeProfileValue(actualName, selected.fillContent);
        const type = this.inferAgentFieldType(actualName, value);
        return {
          ok: true,
          field: actualName,
          shortcut: String(selected.shortcut || '').trim() || undefined,
          group: String(selected.title || '').trim(),
          occurrence,
          type,
          canonical: resolveCanonical(actualName) || resolveCanonical(selected.shortcut) || undefined,
          value,
          path: type === 'cascader' ? this.getAgentFieldPath(value) : undefined
        };
      }

      const distinctValues = [...new Set(matches.map((item) =>
        this.normalizeProfileValue(String(item.buttonText || '').trim(), item.fillContent)
      ))];
      if (distinctValues.length > 1) {
        return {
          ok: false,
          error: 'ambiguous_field',
          field: requestedName,
          matchCount: matches.length,
          groups: matches.map((item) => String(item.title || '').trim())
        };
      }

      const value = distinctValues[0] || '';
      const actualName = String(matches[0].buttonText || '').trim();
      const type = this.inferAgentFieldType(actualName, value);
      return {
        ok: true,
        field: actualName,
        shortcut: String(matches[0].shortcut || '').trim() || undefined,
        group: String(matches[0].title || '').trim(),
        type,
        canonical: resolveCanonical(actualName) || resolveCanonical(matches[0].shortcut) || undefined,
        value,
        path: type === 'cascader' ? this.getAgentFieldPath(value) : undefined
      };
    }

    // ---- New: resolve() — metadata-only lookup ----
    resolveAgentField(query, options) {
      options = options || {};
      const raw = String(query || '').trim();
      if (!raw) return { ok: false, error: 'query_required' };
      const items = this.excelData?.orderedData || [];
      if (!items.length) return { ok: false, error: 'profile_empty', hint: 'Import the profile first via clipboard or sidebar upload.' };

      // Match priority:
      //   1. exact shortcut
      //   2. exact buttonText (with group filter if provided)
      //   3. canonical alias
      const matches = [];
      const seen = new Set();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const shortcut = String(item.shortcut || '').trim();
        const buttonText = String(item.buttonText || '').trim();
        const group = String(item.title || '').trim();
        const canonical = resolveCanonical(buttonText) || resolveCanonical(shortcut);

        let confidence = 0;
        let matchedOn = null;
        if (shortcut && shortcut.toLowerCase() === raw.toLowerCase()) { confidence = 1; matchedOn = 'shortcut'; }
        else if (buttonText && buttonText === raw) { confidence = 0.95; matchedOn = 'buttonText'; }
        else if (canonical && canonical === raw) { confidence = 0.85; matchedOn = 'canonical'; }
        else if (canonical && resolveCanonical(raw) && resolveCanonical(raw) === canonical) { confidence = 0.8; matchedOn = 'canonical-alias'; }
        if (!confidence) continue;

        if (options.group && group !== options.group) continue;
        const occurrence = (matches.filter((m) => m.buttonText === buttonText).length) + 1;
        const key = `${buttonText}\u0000${group}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          shortcut: shortcut || undefined,
          group: group || undefined,
          canonical: canonical || undefined,
          buttonText,
          occurrence,
          confidence,
          matchedOn,
          // No `value` here — privacy-preserving by default.
          recommendedInteraction: this.recommendInteraction(item, canonical)
        });
      }

      if (!matches.length) return { ok: false, error: 'no_match', query: raw };
      // Sort by confidence desc, then by occurrence asc for stable order.
      matches.sort((a, b) => (b.confidence - a.confidence) || (a.occurrence - b.occurrence));
      if (options.occurrence && Number.isInteger(options.occurrence)) {
        const one = matches.find((m) => m.occurrence === options.occurrence);
        if (!one) return { ok: false, error: 'occurrence_not_found', matchCount: matches.length };
        return { ok: true, query: raw, match: one };
      }
      return { ok: true, query: raw, matches };
    }

    recommendInteraction(item, canonical) {
      // Soft hint, not authoritative — apply() inspects the actual DOM and
      // chooses the strategy based on that. The hint is only used by agents
      // that want to plan without inspecting the page first.
      if (canonical === 'identity.name' || canonical === 'identity.id_number' || canonical === 'identity.gender' || canonical === 'experience.employer' || canonical === 'education.school' || canonical === 'education.major' || canonical === 'education.degree') {
        return 'auto';
      }
      if (canonical === 'identity.birth_date' || canonical === 'education.start' || canonical === 'education.end' || canonical === 'experience.start' || canonical === 'experience.end' || canonical === 'intent.onboard') {
        return 'date';
      }
      if (canonical === 'location.hukou' || canonical === 'location.current' || canonical === 'location.work_city') {
        return 'cascader';
      }
      if (canonical === 'generic.textarea') return 'textarea';
      return 'auto';
    }

    // ---- New: inspect() — pure DOM classification ----
    inspectAgentTarget(selector, targetOccurrence) {
      if (!selector) {
        // Inspect the focused element if available; otherwise return error.
        const active = document.activeElement;
        if (active && active !== document.body) {
          const r = inspectTarget(active);
          if (!r.ok) return { ...r, error: r.error, target: { tag: active.tagName?.toLowerCase(), role: active.getAttribute?.('role'), classNames: [...(active.classList || [])] } };
          return { ok: true, ...r, target: { tag: active.tagName?.toLowerCase(), role: active.getAttribute?.('role'), classNames: [...(active.classList || [])] } };
        }
        return { ok: false, error: 'selector_or_focus_required' };
      }
      const resolved = this.resolveAgentTarget(selector, targetOccurrence);
      if (!resolved.ok) return resolved;
      const target = resolved.target;
      const r = inspectTarget(target);
      if (!r.ok) return { ...r, target: { tag: target.tagName?.toLowerCase(), classNames: [...(target.classList || [])] } };
      return { ok: true, ...r, target: { tag: target.tagName?.toLowerCase(), role: target.getAttribute?.('role'), classNames: [...(target.classList || [])] } };
    }

    // ---- New: apply() — auto-pick strategy from DOM ----
    async applyAgentField(options) {
      options = options || {};
      const redacted = options.redacted === true;
      const explicitValue = Object.prototype.hasOwnProperty.call(options, 'value');
      const requested = String(options.field || options.shortcut || '').trim();
      if (!requested) return { ok: false, error: 'field_required' };

      // 1. Resolve to metadata (no value leakage).
      const resolved = this.resolveAgentField(requested, { group: options.group, occurrence: options.occurrence });
      if (!resolved.ok) return resolved;

      const targetMatch = (resolved.matches && resolved.matches[0]) || resolved.match;
      // 2. If no explicit value, fetch the actual value from local profile store.
      // This never leaves the extension: the value is read here and injected
      // into the DOM directly, never returned to the agent unless redacted=false.
      let value;
      if (explicitValue) {
        value = options.value;
      } else {
        const fetched = this.getAgentField(requested, { group: options.group, occurrence: options.occurrence });
        if (!fetched.ok) return fetched;
        value = fetched.value;
      }

      // 3. Resolve the target DOM element.
      let target;
      if (options.selector) {
        const t = this.resolveAgentTarget(options.selector, options.targetOccurrence);
        if (!t.ok) return t;
        target = t.target;
      } else {
        const active = document.activeElement;
        const activeIsPageField = active && !this.sidebar?.contains(active) && ['input', 'textarea', 'select'].includes(active.tagName?.toLowerCase());
        target = activeIsPageField ? active : this.lastClickedInput;
        if (!target) return { ok: false, error: 'target_required', hint: 'Focus the target field or pass a CSS selector.' };
      }
      const inspect = inspectTarget(target);
      if (!inspect.ok) return { ok: false, ...inspect, field: targetMatch.buttonText };

      // 4. Route to the right strategy based on actual DOM.
      const strategy = inspect.strategy;
      const tagName = String(target.tagName || '').toLowerCase();
      let result;

      if (strategy === 'text' || strategy === 'tel' || strategy === 'email' || strategy === 'number' || strategy === 'date' || strategy === 'month') {
        let next = String(value ?? '');
        if (strategy === 'month') {
          const m = next.match(/^(\d{4})\D*(\d{1,2})/);
          if (m) next = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
          else next = next.slice(0, 7);
        } else if (strategy === 'date') {
          const m = next.match(/^(\d{4})\D*(\d{1,2})\D*(\d{1,2})/);
          if (m) next = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
        }
        const ok = setNativeFieldValue(target, next);
        result = { ok, strategy, appliedValue: ok ? String(target.value ?? '') : null };
        if (ok && (strategy === 'date' || strategy === 'month')) target.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
      } else if (strategy === 'select' && inspect.widget === 'native') {
        const norm = (n) => String(n ?? '').normalize('NFKC').toLowerCase().replace(/[\s·•・,，。.;；:：()（）[\]【】]/g, '');
        const wanted = norm(String(value ?? ''));
        const options_ = [...target.options || []];
        const exact = options_.find((o) => norm(o.textContent) === wanted || norm(o.value) === wanted);
        const contains = options_.find((o) => { const t = norm(o.textContent); return t && (t.includes(wanted) || wanted.includes(t)); });
        const matched = exact || contains;
        if (!matched) result = { ok: false, strategy, error: 'no_exact_match', candidates: options_.map((o) => o.textContent.trim()).slice(0, 50) };
        else {
          const ok = setNativeFieldValue(target, matched.value);
          result = { ok, strategy, appliedValue: ok ? matched.textContent.trim() : null };
        }
      } else if (strategy === 'select' || strategy === 'cascader') {
        // For custom widgets we hand off to chooseAgentValue so the dropdown
        // / cascader gets opened and the options get matched against the
        // stored value.
        const chosen = await this.chooseAgentValue({
          selector: options.selector || cssPathFor(target),
          field: targetMatch.buttonText,
          value: this.getAgentFieldPath(value).length > 1 ? this.getAgentFieldPath(value) : value,
          targetOccurrence: options.targetOccurrence
        });
        result = { ...chosen, strategy };
      } else if (strategy === 'file') {
        result = { ok: false, strategy, error: 'file_upload_planned', plannedValue: String(value ?? '') };
      } else {
        result = { ok: false, error: 'unsupported_strategy', strategy };
      }

      const out = {
        ok: !!result.ok,
        field: targetMatch.buttonText,
        group: targetMatch.group,
        shortcut: targetMatch.shortcut,
        canonical: targetMatch.canonical,
        occurrence: targetMatch.occurrence,
        strategy,
        widget: inspect.widget,
        confidence: inspect.confidence,
        evidence: inspect.evidence,
        verified: !!result.ok && String(target?.value ?? result.appliedValue ?? '') !== ''
      };
      if (!redacted) out.appliedValue = result.appliedValue;
      if (result.error) out.error = result.error;
      if (result.selected) out.selected = result.selected;
      if (result.candidates) out.candidates = result.candidates;
      return out;
    }

    // ---- New: fillFocused() — apply to currently focused element ----
    async fillFocusedAgentField(fieldOrShortcut, options) {
      options = options || {};
      return this.applyAgentField({
        ...options,
        field: fieldOrShortcut,
        // No selector → uses focused element.
      });
    }

    // ---- Cascader / custom widget choice picker ----
    resolveAgentTarget(selector, targetOccurrence) {
      if (!selector) return { ok: false, error: 'selector_required' };
      let matches;
      try { matches = [...document.querySelectorAll(String(selector))]; } catch (error) { return { ok: false, error: 'invalid_selector' }; }
      const occ = Number(targetOccurrence || 0);
      if (Number.isInteger(occ) && occ > 0) {
        const target = matches[occ - 1];
        if (!target) return { ok: false, error: 'target_occurrence_not_found', matchCount: matches.length };
        if (this.sidebar?.contains(target)) return { ok: false, error: 'target_not_fillable' };
        return { ok: true, target };
      }
      if (matches.length !== 1) return { ok: false, error: matches.length ? 'ambiguous_target' : 'target_not_found', matchCount: matches.length };
      if (this.sidebar?.contains(matches[0])) return { ok: false, error: 'target_not_fillable' };
      return { ok: true, target: matches[0] };
    }

    isAgentChoiceVisible(element) {
      if (!element || this.sidebar?.contains(element)) return false;
      if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    collectAgentChoices() {
      const selectors = [
        '[role="option"]', '[role="menuitem"]', '[role="treeitem"]',
        '.ant-select-item-option', '.ant-cascader-menu-item',
        '.el-select-dropdown__item', '.el-cascader-node',
        '[class*="select-option"]', '[class*="dropdown-item"]',
        '[class*="cascader-menu-item"]'
      ].join(',');
      const seen = new Set();
      return [...document.querySelectorAll(selectors)].reduce((items, element) => {
        if (!this.isAgentChoiceVisible(element)) return items;
        const label = String(element.innerText || element.textContent || '').trim();
        if (!label || label.length > 120) return items;
        const value = String(element.getAttribute?.('data-value') ?? element.getAttribute?.('value') ?? '');
        const key = `${label}\u0000${value}`;
        if (seen.has(key)) return items;
        seen.add(key);
        items.push({ label, value, element });
        return items;
      }, []);
    }

    matchAgentChoice(requested, choices) {
      const wanted = normalizeAgentChoice(requested);
      const aliases = getAgentChoiceAliases(requested);
      const exact = choices.filter((item) =>
        normalizeAgentChoice(item.label) === wanted || normalizeAgentChoice(item.value) === wanted
      );
      if (exact.length === 1) return { ok: true, choice: exact[0], match: 'exact' };
      const aliasMatches = choices.filter((item) => aliases.has(normalizeAgentChoice(item.label)));
      if (aliasMatches.length === 1) return { ok: true, choice: aliasMatches[0], match: 'alias' };
      const contains = choices.filter((item) => {
        const label = normalizeAgentChoice(item.label);
        return label && (label.includes(wanted) || wanted.includes(label));
      });
      if (contains.length === 1) return { ok: true, choice: contains[0], match: 'unique_contains' };
      return {
        ok: false,
        error: exact.length || aliasMatches.length || contains.length ? 'ambiguous_choice' : 'no_exact_match',
        requested: String(requested ?? ''),
        candidates: choices.map((item) => item.label).slice(0, 100)
      };
    }

    // ---- Cascader wait loop. Budget = bridge timeout − slack. ----
    // The bridge passes an action-specific timeout (12s for choose/apply by
    // default). We derive a per-level wait that lets N levels complete before
    // the bridge times out. For a 3-level cascader at 12s bridge: perLevel ≈
    // (12000 - 200) / 3 ≈ 3900ms. For 5 levels: ~2300ms. We never go below
    // DEFAULT_LEVEL_WAIT_MS so a single visible option is still expected.
    computeLevelWaitMs(levelCount, actionTimeoutMs) {
      const safeCount = Math.max(1, Number(levelCount) || 1);
      const safeTimeout = Math.max(2000, Number(actionTimeoutMs) || ACTION_TIMEOUTS.choose);
      const perLevel = Math.floor((safeTimeout - 200) / safeCount);
      return Math.max(DEFAULT_LEVEL_WAIT_MS, Math.min(8000, perLevel));
    }

    async waitForAgentChoice(requested, timeoutMs) {
      const budget = clampTimeout(timeoutMs, DEFAULT_LEVEL_WAIT_MS);
      const startedAt = Date.now();
      let lastResult = { ok: false, error: 'options_not_found', requested: String(requested ?? ''), candidates: [] };
      do {
        const choices = this.collectAgentChoices();
        if (choices.length) {
          lastResult = this.matchAgentChoice(requested, choices);
          if (lastResult.ok) return lastResult;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() - startedAt < budget);
      return lastResult;
    }

    async chooseAgentValue(options) {
      options = options || {};
      const selector = String(options.selector || '');
      const resolved = this.resolveAgentTarget(selector, options.targetOccurrence);
      if (!resolved.ok) return resolved;

      let sourceField;
      let requested = options.value;
      if (requested === undefined) {
        sourceField = this.getAgentField(options.field);
        if (!sourceField.ok) return sourceField;
        requested = sourceField.path?.length > 1 ? sourceField.path : sourceField.value;
      }
      const path = Array.isArray(requested)
        ? requested.map((item) => String(item ?? '').trim()).filter(Boolean)
        : [String(requested ?? '').trim()].filter(Boolean);
      if (!path.length) return { ok: false, error: 'value_required', field: options.field || undefined };

      const target = resolved.target;
      if (target.tagName?.toLowerCase() === 'select') {
        if (path.length !== 1) return { ok: false, error: 'single_level_required', requested: path };
        const choices = [...target.options].map((option) => ({ label: option.textContent.trim(), value: option.value, element: option }));
        const matched = this.matchAgentChoice(path[0], choices);
        if (!matched.ok) return matched;
        const ok = setNativeFieldValue(target, matched.choice.value);
        return {
          ok,
          error: ok ? undefined : 'choose_failed',
          field: options.field || sourceField?.field,
          requested: path[0],
          selected: matched.choice.label,
          match: matched.match,
          verified: ok && String(target.value) === String(matched.choice.value)
        };
      }

      const selected = [];
      const matches = [];
      // Compute per-level wait budget. The bridge passes an action-specific
      // timeout through payload; we read it from options.timeoutMS, falling
      // back to the choose preset.
      const actionBudget = Number(options.timeoutMS) || ACTION_TIMEOUTS.choose;
      const perLevelWait = this.computeLevelWaitMs(path.length, actionBudget);
      clickElement(target);
      for (const level of path) {
        const matched = await this.waitForAgentChoice(level, perLevelWait);
        if (!matched.ok) return { ...matched, selected, perLevelWaitMs: perLevelWait };
        matched.choice.element.scrollIntoView?.({ block: 'nearest' });
        clickElement(matched.choice.element);
        selected.push(matched.choice.label);
        matches.push(matched.match);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const targetText = String(target.innerText || target.textContent || target.value || '').trim();
      const finalWanted = normalizeAgentChoice(path[path.length - 1]);
      return {
        ok: true,
        field: options.field || sourceField?.field,
        requested: path.length === 1 ? path[0] : path,
        selected,
        matches,
        perLevelWaitMs: perLevelWait,
        verified: selected.length === path.length && (
          ['exact', 'alias', 'unique_contains'].includes(matches[matches.length - 1]) ||
          normalizeAgentChoice(selected[selected.length - 1]) === finalWanted ||
          normalizeAgentChoice(targetText).includes(finalWanted)
        )
      };
    }

    // ---- Legacy fill (preserved) ----
    normalizeAgentDate(value) {
      const text = this.normalizeProfileValue('日期', value);
      const match = text.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
      if (!match) return text;
      return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    }

    fillAgentField(fieldOrOptions, legacySelector) {
      const options = fieldOrOptions && typeof fieldOrOptions === 'object'
        ? fieldOrOptions
        : { field: fieldOrOptions, selector: legacySelector };
      const hasExplicitValue = Object.prototype.hasOwnProperty.call(options, 'value');
      const requestedName = String(options.field || '').trim();
      const field = hasExplicitValue
        ? {
            ok: true,
            field: requestedName || 'explicit_value',
            group: options.group,
            occurrence: options.occurrence,
            value: String(options.value ?? ''),
            type: String(options.type || this.inferAgentFieldType(requestedName, options.value))
          }
        : this.getAgentField(requestedName, options);
      if (!field.ok) return field;
      if (['select', 'cascader', 'file'].includes(field.type)) {
        return { ...field, ok: false, error: 'interaction_required' };
      }

      let target;
      const selector = options.selector;
      if (selector) {
        const resolved = this.resolveAgentTarget(selector, options.targetOccurrence);
        if (!resolved.ok) return { ...resolved, field: field.field };
        target = resolved.target;
      } else {
        const activeElement = document.activeElement;
        const activeIsPageField = activeElement && !this.sidebar?.contains(activeElement)
          && ['input', 'textarea'].includes(activeElement.tagName?.toLowerCase());
        target = activeIsPageField ? activeElement : this.lastClickedInput;
      }

      const tagName = target?.tagName?.toLowerCase();
      if (!['input', 'textarea'].includes(tagName) || this.sidebar?.contains(target)) {
        return { ok: false, error: 'target_not_fillable', field: field.field };
      }
      if (target.disabled || target.type === 'file' || ['hidden', 'submit', 'button', 'reset'].includes(target.type)) {
        return { ok: false, error: 'target_not_fillable', field: field.field };
      }
      if (target.readOnly && field.type !== 'date') {
        return { ok: false, error: 'target_read_only', field: field.field };
      }

      const targetType = String(target.type || '').toLowerCase();
      if (hasExplicitValue && !options.type && ['date', 'month', 'datetime-local', 'time'].includes(targetType)) {
        field.type = 'date';
      }
      let value = field.type === 'date' ? this.normalizeAgentDate(field.value) : field.value;
      if (field.type === 'date' && targetType === 'month') value = String(value).slice(0, 7);
      this.lastClickedInput = target;
      this.lastSelectedFillContent = value;
      this.lastSelectedFillLabel = field.field;
      const filled = setNativeFieldValue(target, value);
      if (filled && field.type === 'date') {
        target.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
        target.blur?.();
      }
      return {
        ok: filled,
        error: filled ? undefined : 'fill_failed',
        field: field.field,
        group: field.group,
        occurrence: field.occurrence,
        type: field.type,
        appliedValue: filled ? String(target.value ?? '') : undefined,
        verified: filled && String(target.value ?? '') === String(value)
      };
    }

    // ---- Bridge routing ----
    bindAgentBridge() {
      document.removeEventListener('form-helper-request-v1', this.agentBridgeHandler, false);
      document.addEventListener('form-helper-request-v1', this.agentBridgeHandler = async (event) => {
        const detail = event?.detail || {};
        const requestId = String(detail.requestId || '');
        if (!requestId) return;
        const action = detail.action;
        const payload = detail.payload || {};
        const options = payload.options || {};
        let result;
        try {
          if (action === 'list') {
            const listRequest = payload.options?.legacy_query
              ? payload.options.legacy_query
              : (payload.options || payload.query || {});
            result = this.getAgentFieldList(listRequest);
          }
          else if (action === 'find') result = { ok: true, level: 'search', fields: this.searchAgentFields(payload.query || '') };
          else if (action === 'get') result = this.getAgentField(options.field, options);
          else if (action === 'fill') result = this.fillAgentField(options, options.selector);
          else if (action === 'choose') result = await this.chooseAgentValue(options);
          else if (action === 'resolve') result = this.resolveAgentField(payload.query, options);
          else if (action === 'apply') result = await this.applyAgentField(payload.options || payload);
          else if (action === 'fillFocused') result = await this.fillFocusedAgentField(payload.field, options);
          else if (action === 'inspect') result = this.inspectAgentTarget(payload.selector || options.selector, options.targetOccurrence);
          else if (action === 'aliases') result = { ok: true, aliases: JSON.parse(JSON.stringify(DEFAULT_CANONICAL_ALIASES)) };
          else result = { ok: false, error: 'unsupported_action', action };
        } catch (err) {
          result = { ok: false, error: 'handler_threw', message: String(err && err.message || err) };
        }
        document.dispatchEvent(new CustomEvent('form-helper-response-v1', {
          detail: { requestId, result }
        }));
      }, false);
    }

    // ---- Sidebar / persistence methods (preserved verbatim from v1.4.2) ----
    async removeStoredData() {
      try { if (chrome?.storage?.local) { try { chrome.storage.local.remove('offer_yuan_excel_data', () => {}); } catch (e) {} } } catch (e) {}
    }

    createSidebar() {
      let existingSidebar = document.getElementById('smart-form-sidebar');
      if (existingSidebar) {
        this.sidebar = existingSidebar;
        const isCurrentUi = existingSidebar.querySelector('.panel-brand') && existingSidebar.querySelector('#close-sidebar-btn');
        if (!isCurrentUi) { existingSidebar.remove(); this.createNewSidebar(); }
        return;
      }
      this.createNewSidebar();
    }

    createNewSidebar() {
      this.sidebar = document.createElement('div');
      this.sidebar.id = 'smart-form-sidebar';
      this.sidebar.className = 'smart-form-sidebar';
      this.sidebar.setAttribute('role', 'complementary');
      this.sidebar.setAttribute('aria-label', '表单资料助手');
      this.sidebar.innerHTML = `
      <div class="sidebar-header" id="sidebar-drag-handle">
        <div class="panel-brand">
          <div class="panel-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 3.75h7.5L19 8.25v12H7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14.5 3.75v4.5H19M10 12h6M10 15.5h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          </div>
          <div>
            <div class="panel-title">表单资料助手</div>
            <div class="panel-subtitle"><span class="status-dot"></span>本地资料 · 当前页面</div>
          </div>
        </div>
        <div class="panel-actions">
          <a id="project-github-link" class="panel-icon-button" href="https://github.com/drtx32/job-profile-extension" target="_blank" rel="noopener noreferrer" aria-label="打开 GitHub 项目主页" title="GitHub 项目主页"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.1.68-3.76-1.31-3.76-1.31-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 .1.76 2.03 3.33 1.55.1-.73.4-1.23.72-1.51-2.47-.28-5.07-1.24-5.07-5.52 0-1.22.44-2.21 1.16-2.99-.12-.28-.5-1.42.11-2.95 0 0 .95-.3 3.08 1.14a10.7 10.7 0 0 1 5.6 0c2.14-1.44 3.08-1.14 3.08-1.14.62 1.53.23 2.67.12 2.95.72.78 1.15 1.77 1.15 2.99 0 4.29-2.61 5.23-5.1 5.51.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></svg></a>
          <button id="shortcut-help-btn" class="panel-icon-button" type="button" aria-label="打开快捷键中心" title="快捷键中心 (Ctrl + /)"><svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.8 9.2a2.4 2.4 0 114.1 1.7c-1.2 1.1-1.9 1.4-1.9 2.6M12 16.8h.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
          <button id="dock-sidebar-btn" class="panel-icon-button" type="button" aria-label="固定到右侧" title="固定到右侧"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M8 4h8l-1 5 3 3H6l3-3-1-5zM12 12v8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg></button>
          <button id="close-sidebar-btn" class="panel-icon-button" type="button" aria-label="关闭资料面板" title="关闭"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        </div>
      </div>

      <div class="sidebar-content">
        <section class="source-card" aria-label="资料中心">
          <div class="source-summary"><div><strong id="source-name">尚未导入资料</strong><small id="source-meta">请选择 Excel 或从剪贴板导入</small></div><button class="source-icon-button" id="refresh-button" type="button" aria-label="重新读取资料" title="重新读取资料"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M19 8a7 7 0 10.3 7M19 4v4h-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
          <div class="source-actions">
            <div class="file-upload-area"><input type="file" id="excel-file" accept=".xlsx,.xls" aria-label="更换唯一的个人信息 Excel 文件"/><label for="excel-file" class="secondary-action">更换 Excel</label></div>
            <button id="clipboard-import-btn" class="secondary-action" type="button">剪贴板导入</button>
          </div>
          <div id="single-data-status" class="action-status" role="status" aria-live="polite"></div>
        </section>

        <div class="field-search-wrap">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          <input id="field-search" type="search" autocomplete="off" placeholder="搜索字段、快捷词或分组" aria-label="搜索字段、快捷词或分组"/>
        </div>
        <div class="field-tabs" id="field-tabs" role="tablist" aria-label="资料分组"></div>
        <div class="buttons-section">
          <div class="buttons-container" id="buttons-container">
            <div class="no-data-tip">导入资料后，字段会按分组显示在这里</div>
          </div>
        </div>
      </div>

      <div class="shortcut-dialog" id="shortcut-dialog" hidden role="dialog" aria-modal="true" aria-labelledby="shortcut-dialog-title">
        <div class="shortcut-backdrop" data-close-shortcuts></div><div class="shortcut-card"><div class="shortcut-header"><strong id="shortcut-dialog-title">快捷键与字段</strong><button class="panel-icon-button" type="button" data-close-shortcuts aria-label="关闭快捷键中心"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div><div class="shortcut-commands"><div><kbd>Ctrl /</kbd><span>打开快捷键中心</span></div><div><kbd>Alt Shift V</kbd><span>剪贴板导入</span></div><div><kbd>Alt Shift F</kbd><span>重填上次内容</span></div><div><kbd>空格 / 回车</kbd><span>展开字段快捷词</span></div></div><div class="shortcut-list" id="shortcut-list"></div></div>
      </div>
      <div class="manual-import-dialog" id="manual-import" hidden role="dialog" aria-modal="true" aria-labelledby="manual-import-title">
        <div class="dialog-backdrop" data-close-manual-import></div>
        <div class="manual-import-card"><div class="dialog-header"><div><strong id="manual-import-title">手动粘贴资料</strong><small>剪贴板内容无法自动识别，请检查后重新导入</small></div><button class="panel-icon-button" type="button" data-close-manual-import aria-label="关闭手动导入"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div><textarea id="text-import-data" rows="8" aria-label="粘贴个人信息 JSON、表格或文本" placeholder="在此按 Ctrl + V，支持 JSON、CSV、TSV、Markdown 或表格文本"></textarea><div class="dialog-actions"><button class="dialog-secondary" type="button" data-close-manual-import>取消</button><button class="dialog-primary" id="import-text-data" type="button">导入并覆盖</button></div></div>
      </div>
      <div class="toast-region" id="toast-region" aria-live="assertive" aria-atomic="true"></div>

    `;
      document.body.appendChild(this.sidebar);
    }

    createToggleButton() {
      let existingButton = document.getElementById('toggle-sidebar-btn');
      if (existingButton) {
        this.toggleButton = existingButton;
        this.updateToggleButtonState();
        return;
      }
      this.toggleButton = document.createElement('button');
      this.toggleButton.className = 'toggle-sidebar-btn';
      this.toggleButton.id = 'toggle-sidebar-btn';
      this.toggleButton.type = 'button';
      this.toggleButton.title = '打开表单资料助手';
      this.toggleButton.setAttribute('aria-label', '打开表单资料助手');
      this.toggleButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 3.75h7.5L19 8.25v12H7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14.5 3.75v4.5H19M10 12h6M10 15.5h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span class="toggle-label">资料</span>';
      document.body.appendChild(this.toggleButton);
      this.updateToggleButtonState();
      this.toggleButton.removeEventListener('click', this.toggleSidebarHandler);
      this.toggleButton.addEventListener('click', this.toggleSidebarHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSidebar();
      });
    }

    bindEvents() {
      const fileInput = this.sidebar.querySelector('#excel-file');
      if (fileInput) {
        fileInput.removeEventListener('change', this.fileUploadHandler);
        fileInput.addEventListener('change', this.fileUploadHandler = (e) => this.handleFileUpload(e));
      }
      const importButton = this.sidebar.querySelector('#import-text-data');
      if (importButton) {
        importButton.removeEventListener('click', this.textImportHandler);
        importButton.addEventListener('click', this.textImportHandler = async () => {
          const textarea = this.sidebar.querySelector('#text-import-data');
          importButton.disabled = true;
          try {
            const imported = await this.processTextImport({ text: textarea?.value || '' });
            if (imported) {
              if (textarea) textarea.value = '';
              this.toggleManualImport(false);
              await this.clearClipboardAfterImport();
            }
          } finally { importButton.disabled = false; }
        });
      }
      const clipboardButton = this.sidebar.querySelector('#clipboard-import-btn');
      if (clipboardButton) clipboardButton.addEventListener('click', () => this.importFromClipboard());
      const refreshButton = this.sidebar.querySelector('#refresh-button');
      if (refreshButton) {
        refreshButton.removeEventListener('click', this.refreshButtonHandler);
        refreshButton.addEventListener('click', this.refreshButtonHandler = (e) => this.handleRefreshClick(e));
      }
      const closeButton = this.sidebar.querySelector('#close-sidebar-btn');
      if (closeButton) closeButton.addEventListener('click', () => this.hideSidebar());
      this.sidebar.querySelector('#shortcut-help-btn')?.addEventListener('click', () => this.toggleShortcutDialog(true));
      this.sidebar.querySelectorAll('[data-close-shortcuts]').forEach((element) => element.addEventListener('click', () => this.toggleShortcutDialog(false)));
      this.sidebar.querySelectorAll('[data-close-manual-import]').forEach((element) => element.addEventListener('click', () => this.toggleManualImport(false)));
      this.sidebar.querySelector('#dock-sidebar-btn')?.addEventListener('click', () => this.dockSidebar());
      this.sidebar.querySelector('#field-search')?.addEventListener('input', (event) => { this.searchQuery = event.target.value.trim(); this.renderButtons(); });
      this.sidebar.querySelector('#field-tabs')?.addEventListener('click', (event) => { const tab = event.target.closest('[data-group]'); if (!tab) return; this.activeGroup = tab.dataset.group; this.searchQuery = ''; const search = this.sidebar.querySelector('#field-search'); if (search) search.value = ''; this.saveUiPreferences(); this.renderButtons(); });
      this.initializePanelDrag();
      const clickHandler = (e) => {
        const target = e.target;
        let isInputElement = false;
        let inputElement = null;
        if (['input', 'textarea', 'select'].includes(target.tagName.toLowerCase())) { isInputElement = true; inputElement = target; }
        if (!isInputElement) {
          let parent = target.parentElement;
          let depth = 0;
          while (parent && depth < 5) {
            if (['input', 'textarea', 'select'].includes(parent.tagName.toLowerCase())) { isInputElement = true; inputElement = parent; break; }
            parent = parent.parentElement;
            depth++;
          }
        }
        if (!isInputElement) {
          const inputWithData = target.closest('[data-input], [role="textbox"], [contenteditable="true"]');
          if (inputWithData) { isInputElement = true; inputElement = inputWithData; }
        }
        if (!isInputElement) {
          const inputContainer = target.closest('.phoenix-input, .input-container, .form-input');
          if (inputContainer) {
            const actualInput = inputContainer.querySelector('input, textarea, select');
            if (actualInput) { isInputElement = true; inputElement = actualInput; }
          }
        }
        if (isInputElement && inputElement) this.lastClickedInput = inputElement;
      };
      document.removeEventListener('click', this.clickHandler, true);
      document.addEventListener('click', this.clickHandler = clickHandler, true);

      document.removeEventListener('keydown', this.keywordKeydownHandler, true);
      document.addEventListener('keydown', this.keywordKeydownHandler = (event) => {
        if (![' ', 'Spacebar', 'Enter'].includes(event.key)) return;
        const expanded = this.expandKeywordInField(event.target);
        if (expanded) { event.preventDefault(); event.stopPropagation(); }
      }, true);

      document.removeEventListener('keydown', this.clipboardShortcutHandler, true);
      document.addEventListener('keydown', this.clipboardShortcutHandler = async (event) => {
        if (event.altKey && !event.ctrlKey && ['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'].includes(event.code)) {
          event.preventDefault(); event.stopPropagation(); this.adjustFieldScale(['Equal', 'NumpadAdd'].includes(event.code) ? 0.1 : -0.1); return;
        }
        if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'Slash') {
          if (event.isComposing) return;
          event.preventDefault(); event.stopPropagation(); this.toggleShortcutDialog(); return;
        }
        if (event.key === 'Escape' && !this.sidebar?.querySelector('#shortcut-dialog')?.hidden) { this.toggleShortcutDialog(false); return; }
        if (event.key === 'Escape' && !this.sidebar?.querySelector('#manual-import')?.hidden) { this.toggleManualImport(false); return; }
        if (!(event.altKey && event.shiftKey && event.code === 'KeyV')) return;
        event.preventDefault();
        event.stopPropagation();
        await this.importFromClipboard();
      }, true);
    }

    initializePanelDrag() {
      const handle = this.sidebar?.querySelector('#sidebar-drag-handle');
      if (!handle || handle.dataset.dragReady) return;
      handle.dataset.dragReady = 'true';
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('a, button, input, select, textarea, [role="button"]')) return;
        const rect = this.sidebar.getBoundingClientRect();
        this.dragState = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        this.sidebar.classList.add('is-floating', 'is-dragging');
        this.sidebar.style.setProperty('left', `${rect.left}px`, 'important'); this.sidebar.style.setProperty('top', `${rect.top}px`, 'important'); this.sidebar.style.setProperty('right', 'auto', 'important');
        handle.setPointerCapture?.(event.pointerId); event.preventDefault();
      });
      handle.addEventListener('pointermove', (event) => {
        if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
        const width = this.sidebar.offsetWidth; const height = this.sidebar.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - this.dragState.offsetX));
        const top = Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - this.dragState.offsetY));
        this.sidebar.style.setProperty('left', `${left}px`, 'important'); this.sidebar.style.setProperty('top', `${top}px`, 'important');
      });
      const finish = (event) => { if (!this.dragState || event.pointerId !== this.dragState.pointerId) return; this.dragState = null; this.sidebar.classList.remove('is-dragging'); this.saveUiPreferences(); };
      handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
    }

    dockSidebar() { this.sidebar?.classList.remove('is-floating', 'is-dragging'); if (this.sidebar) { this.sidebar.style.removeProperty('left'); this.sidebar.style.removeProperty('top'); this.sidebar.style.removeProperty('right'); this.sidebar.style.removeProperty('width'); this.sidebar.style.removeProperty('height'); } this.saveUiPreferences(); }

    async loadUiPreferences() {
      if (!chrome?.storage?.local) return;
      const result = await new Promise((resolve) => { try { chrome.storage.local.get(['form_profile_ui_v1'], (value) => resolve(value || {})); } catch (error) { resolve({}); } });
      const prefs = result.form_profile_ui_v1 || {};
      if (Array.isArray(prefs.recentFields)) this.recentFields = prefs.recentFields.slice(0, 20);
      if (typeof prefs.activeGroup === 'string') this.activeGroup = prefs.activeGroup;
      if (Number.isFinite(Number(prefs.fieldScale))) this.fieldScale = Math.max(0.8, Math.min(1.5, Number(prefs.fieldScale)));
      this.sidebar?.style.setProperty('--field-scale', String(this.fieldScale));
      if (prefs.panel && window.innerWidth > 480 && this.sidebar) {
        const left = Math.max(8, Math.min(window.innerWidth - 328, Number(prefs.panel.left) || 8));
        const top = Math.max(8, Math.min(window.innerHeight - 368, Number(prefs.panel.top) || 8));
        this.sidebar.classList.add('is-floating');
        this.sidebar.style.setProperty('left', `${left}px`, 'important'); this.sidebar.style.setProperty('top', `${top}px`, 'important'); this.sidebar.style.setProperty('right', 'auto', 'important');
        if (prefs.panel.width) this.sidebar.style.setProperty('width', `${Math.min(Number(prefs.panel.width), window.innerWidth - 16)}px`, 'important');
        if (prefs.panel.height) this.sidebar.style.setProperty('height', `${Math.min(Number(prefs.panel.height), window.innerHeight - 16)}px`, 'important');
      }
      this.renderButtons();
    }

    saveUiPreferences() {
      if (!chrome?.storage?.local) return;
      const floating = this.sidebar?.classList.contains('is-floating'); const rect = floating ? this.sidebar.getBoundingClientRect() : null;
      const prefs = { activeGroup: this.activeGroup, recentFields: this.recentFields.slice(0, 20), fieldScale: this.fieldScale, panel: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null };
      try { chrome.storage.local.set({ form_profile_ui_v1: prefs }, () => {}); } catch (error) {}
    }

    toggleShortcutDialog(force) {
      const dialog = this.sidebar?.querySelector('#shortcut-dialog'); if (!dialog) return;
      const shouldOpen = typeof force === 'boolean' ? force : dialog.hidden;
      dialog.hidden = !shouldOpen;
      if (shouldOpen) { this.renderShortcutList(); dialog.querySelector('[data-close-shortcuts]')?.focus(); }
    }

    toggleManualImport(force) {
      const dialog = this.sidebar?.querySelector('#manual-import'); if (!dialog) return;
      const shouldOpen = typeof force === 'boolean' ? force : dialog.hidden; dialog.hidden = !shouldOpen;
      if (shouldOpen) setTimeout(() => { const textarea = dialog.querySelector('#text-import-data'); textarea?.focus(); textarea?.select(); }, 0);
    }

    adjustFieldScale(delta) {
      this.fieldScale = Math.max(0.8, Math.min(1.5, Math.round((this.fieldScale + delta) * 10) / 10));
      this.sidebar?.style.setProperty('--field-scale', String(this.fieldScale)); this.saveUiPreferences();
      this.showToast({ title: `字段大小 ${Math.round(this.fieldScale * 100)}%`, message: '仅调整字段按钮和分组标题。', type: 'info', duration: 1800 });
    }

    renderShortcutList() {
      const list = this.sidebar?.querySelector('#shortcut-list'); if (!list) return;
      const items = (this.excelData?.orderedData || []).filter((item) => String(item.shortcut || '').trim());
      list.innerHTML = items.length ? items.map((item) => `<button type="button" data-shortcut-group="${this.escapeHtml(item.title)}"><kbd>${this.escapeHtml(item.shortcut)}</kbd><span>${this.escapeHtml(item.buttonText)}</span><small>${this.escapeHtml(item.title)}</small></button>`).join('') : '<div class="no-shortcuts">当前资料没有设置字段快捷词</div>';
      list.querySelectorAll('[data-shortcut-group]').forEach((button) => button.addEventListener('click', () => { this.activeGroup = button.dataset.shortcutGroup; this.toggleShortcutDialog(false); this.renderButtons(); }));
    }

    escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }

    async importFromClipboard() {
      try {
        let text = ''; let html = '';
        if (navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
            if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
          }
        } else if (navigator.clipboard?.readText) {
          text = await navigator.clipboard.readText();
        } else {
          throw new Error('当前浏览器不支持直接读取剪贴板');
        }
        if (await this.processTextImport({ text, html })) { await this.clearClipboardAfterImport(); return true; }
      } catch (error) {
        console.warn('剪贴板读取失败，切换为手动粘贴:', error);
        this.showStatus('浏览器未允许直接读取，请手动粘贴');
      }
      if (!this.sidebarVisible) this.toggleSidebar();
      this.toggleManualImport(true);
      const textarea = this.sidebar?.querySelector('#text-import-data');
      if (textarea) { textarea.focus(); textarea.select(); }
      return false;
    }

    async clearClipboardAfterImport() {
      const count = this.excelData?.orderedData?.length || 0;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard write is unavailable');
        await navigator.clipboard.writeText('');
        this.showStatus(`已导入 ${count} 条信息；旧数据已覆盖，剪贴板已清空`);
        return true;
      } catch (error) {
        console.warn('自动清空剪贴板失败:', error);
        this.showStatus(`已导入 ${count} 条信息；旧数据已覆盖，但浏览器未允许自动清空剪贴板`);
        return false;
      }
    }

    isHeaderRow(row) {
      const cells = (row || []).map((cell) => String(cell ?? '').trim().toLowerCase());
      const headerWords = ['标题', '栏目', '分组', 'title', 'group', '按钮文本', '字段', 'buttontext', 'button text', 'key', '填写内容', '内容', '值', 'fillcontent', 'fill content', 'value', '快捷键', 'shortcut', 'alias'];
      return cells.length >= 2 && cells.filter((cell) => headerWords.includes(cell)).length >= 2;
    }

    normalizeImportedRows(rows) {
      const sourceRows = Array.isArray(rows) ? rows : [];
      const orderedData = [];
      const groupedData = {};
      let startIndex = 0;
      const cleanArrayRow = (row) => {
        const cleaned = [...row];
        while (cleaned.length && String(cleaned[0] ?? '').trim() === '') cleaned.shift();
        while (cleaned.length && String(cleaned[cleaned.length - 1] ?? '').trim() === '') cleaned.pop();
        return cleaned;
      };
      const headerCells = Array.isArray(sourceRows[0]) ? cleanArrayRow(sourceRows[0]) : [];
      const hasHeader = this.isHeaderRow(headerCells);
      const normalizedHeaders = headerCells.map((cell) => String(cell ?? '').trim().toLowerCase());
      const findHeaderIndex = (names, fallback) => {
        const index = normalizedHeaders.findIndex((cell) => names.includes(cell));
        return index >= 0 ? index : fallback;
      };
      const titleIndex = findHeaderIndex(['标题', '栏目', '分组', 'title', 'group'], 0);
      const fieldIndex = findHeaderIndex(['按钮文本', '字段', 'buttontext', 'button text', 'key'], 1);
      const valueIndex = findHeaderIndex(['填写内容', '内容', '值', 'fillcontent', 'fill content', 'value'], 2);
      const shortcutIndex = findHeaderIndex(['快捷键', 'shortcut', 'alias'], 3);
      const hasPandasIndexColumn = hasHeader && sourceRows.slice(1).some((row) =>
        Array.isArray(row) && cleanArrayRow(row).length > headerCells.length
      );
      if (hasHeader) startIndex = 1;

      for (let i = startIndex; i < sourceRows.length; i++) {
        const row = sourceRows[i];
        let title; let buttonText; let fillContent; let shortcut;
        if (Array.isArray(row)) {
          const cells = cleanArrayRow(row);
          if (hasPandasIndexColumn && cells.length >= 3) cells.shift();
          if (cells.length && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell ?? '').trim()))) continue;
          if (hasHeader && cells.length >= 3) {
            title = cells[titleIndex]; buttonText = cells[fieldIndex];
            fillContent = cells[valueIndex]; shortcut = cells[shortcutIndex];
          } else if (cells.length >= 3) [title, buttonText, fillContent, shortcut] = cells;
          else if (cells.length === 2) { title = '剪贴板导入'; [buttonText, fillContent] = cells; }
        } else if (row && typeof row === 'object') {
          title = row.title ?? row['标题'] ?? row.group ?? row['分组'] ?? '剪贴板导入';
          buttonText = row.buttonText ?? row['按钮文本'] ?? row.key ?? row['字段'] ?? row.name ?? row['名称'];
          fillContent = row.fillContent ?? row['填写内容'] ?? row.value ?? row['值'] ?? row.content ?? row['内容'] ?? '';
          shortcut = row.shortcut ?? row['快捷键'] ?? row.alias ?? '';
        }
        title = String(title ?? '').trim();
        buttonText = String(buttonText ?? '').trim();
        fillContent = this.normalizeProfileValue(buttonText, fillContent);
        shortcut = String(shortcut ?? '').trim();
        if (!title || !buttonText) continue;
        orderedData.push({ title, buttonText, fillContent, shortcut, order: orderedData.length });
        if (!groupedData[title]) groupedData[title] = {};
        groupedData[title][buttonText] = fillContent;
      }
      return { orderedData, groupedData };
    }

    rowsFromJson(value) {
      if (Array.isArray(value)) return value;
      if (!value || typeof value !== 'object') return [];
      if (Array.isArray(value.orderedData)) return value.orderedData;
      if (Array.isArray(value.data)) return value.data;
      const rows = [];
      for (const [key, nestedValue] of Object.entries(value)) {
        if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
          for (const [buttonText, fillContent] of Object.entries(nestedValue)) rows.push([key, buttonText, fillContent]);
        } else { rows.push(['剪贴板导入', key, nestedValue]); }
      }
      return rows;
    }

    rowsFromHtml(html) {
      if (!html || typeof DOMParser === 'undefined') return [];
      const documentNode = new DOMParser().parseFromString(html, 'text/html');
      const table = documentNode.querySelector('table');
      if (!table) return [];
      return [...table.querySelectorAll('tr')].map((row) =>
        [...row.querySelectorAll('th, td')].map((cell) => cell.textContent.trim())
      ).filter((row) => row.length >= 2);
    }

    rowsFromPlainText(text) {
      const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
      if (!normalized) return [];
      if (typeof XLSX !== 'undefined') {
        try {
          const workbook = XLSX.read(normalized, { type: 'string', raw: false });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
          if (rows.some((row) => Array.isArray(row) && row.length >= 2)) return rows;
        } catch (error) { console.warn('标准表格文本解析失败，尝试宽松解析:', error); }
      }
      return normalized.split('\n').map((line) => {
        let cleaned = line.trim();
        if (!cleaned || /^\|?\s*:?-{3,}/.test(cleaned)) return [];
        if (cleaned.startsWith('|') && cleaned.endsWith('|')) cleaned = cleaned.slice(1, -1);
        const delimiter = cleaned.includes('|') ? /\s*\|\s*/ : cleaned.includes('\t') ? /\t+/ : /\s{2,}/;
        return cleaned.split(delimiter).map((cell) => cell.trim());
      }).filter((row) => row.length >= 2);
    }

    async processTextImport({ text = '', html = '' } = {}) {
      try {
        let rows = this.rowsFromHtml(html);
        const trimmedText = String(text || '').trim();
        if (!rows.length && trimmedText && ['{', '['].includes(trimmedText[0])) {
          try { rows = this.rowsFromJson(JSON.parse(trimmedText)); }
          catch (error) { console.warn('JSON 解析失败，继续按表格文本识别:', error); }
        }
        if (!rows.length) rows = this.rowsFromPlainText(trimmedText);

        const { orderedData, groupedData } = this.normalizeImportedRows(rows);
        if (!orderedData.length) throw new Error('没有识别到有效数据；请至少提供"字段、内容"两列');
        const dataToSave = { orderedData, groupedData, lastUpdated: Date.now(), fileName: '剪贴板导入', sourceType: 'clipboard' };
        await this.setStoredData(dataToSave);
        this.excelData = dataToSave;
        this.lastSelectedFillContent = null;
        this.lastSelectedFillLabel = '';
        this.renderButtons();
        this.hideRefreshPrompt();
        this.showStatus(`已从剪贴板导入 ${orderedData.length} 条信息；旧数据已覆盖`);
        this.showSuccessMessage(`剪贴板导入成功，共 ${orderedData.length} 条信息！`);
        return true;
      } catch (error) {
        console.error('剪贴板内容解析失败:', error);
        this.showStatus(error.message || '剪贴板内容解析失败');
        this.showErrorMessage(error.message || '剪贴板内容解析失败');
        return false;
      }
    }

    expandKeywordInField(target) {
      if (this.isExpandingKeyword || !target || this.sidebar?.contains(target)) return false;
      const tagName = target.tagName?.toLowerCase();
      if (!['input', 'textarea'].includes(tagName) || target.disabled || target.readOnly) return false;
      if (target.type && ['file', 'hidden', 'password', 'submit', 'button', 'reset'].includes(target.type)) return false;

      const keyword = String(target.value || '').trim();
      if (!keyword) return false;
      const allItems = this.excelData?.orderedData || [];
      const shortcutMatches = allItems.filter((item) => String(item.shortcut || '').trim() === keyword);
      const matches = shortcutMatches.length ? shortcutMatches : allItems.filter((item) =>
        String(item.buttonText || '').trim() === keyword
      );
      const distinctValues = [...new Set(matches.map((item) =>
        this.normalizeProfileValue(String(item.buttonText || '').trim(), item.fillContent)
      ))];
      if (distinctValues.length !== 1 || matches.length === 0) return false;

      this.isExpandingKeyword = true;
      this.lastClickedInput = target;
      this.lastSelectedFillContent = distinctValues[0];
      this.lastSelectedFillLabel = String(matches[0].buttonText || keyword).trim();
      try {
        const result = this.fillAgentField({
          field: this.lastSelectedFillLabel,
          value: distinctValues[0],
          type: this.inferAgentFieldType(this.lastSelectedFillLabel, distinctValues[0])
        });
        return Boolean(result?.ok);
      } finally { this.isExpandingKeyword = false; }
    }

    updateToggleButtonState() {
      if (!this.toggleButton) return;
      this.toggleButton.classList.toggle('is-open', Boolean(this.sidebarVisible));
      this.toggleButton.title = this.sidebarVisible ? '关闭表单资料助手' : '打开表单资料助手';
      this.toggleButton.setAttribute('aria-label', this.toggleButton.title);
      this.toggleButton.setAttribute('aria-expanded', String(Boolean(this.sidebarVisible)));
    }
    toggleSidebar() { if (this.sidebarVisible) this.hideSidebar(); else this.showSidebar(); }
    hideSidebar() {
      this.sidebar?.classList.remove('is-open');
      this.sidebarVisible = false;
      this.updateToggleButtonState();
    }
    showSidebar() {
      this.sidebar?.classList.add('is-open');
      this.sidebarVisible = true;
      this.updateToggleButtonState();
    }

    handleFileUpload(event) {
      const file = event.target.files[0];
      if (!file) return;
      this.processExcelFile(file);
      event.target.value = '';
    }

    async processExcelFile(file) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          if (typeof XLSX === 'undefined') { console.error('❌ XLSX库未定义'); this.showErrorMessage('Excel解析库未加载'); return; }
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' });
          if (jsonData.length < 2) return;
          const { orderedData, groupedData } = this.normalizeImportedRows(jsonData);
          let infoCount = 0;
          Object.values(groupedData).forEach((fields) => {
            if (fields && typeof fields === 'object') infoCount += Object.keys(fields).length;
          });
          if (infoCount === 0) return;
          const dataToSave = { orderedData, groupedData, lastUpdated: Date.now(), fileName: file.name, fileSize: file.size, fileModified: file.lastModified };
          try {
            await this.setStoredData(dataToSave);
            this.excelData = dataToSave;
            this.lastSelectedFillContent = null;
            this.lastSelectedFillLabel = '';
            this.renderButtons();
            this.showStatus(`已加载 ${file.name}`);
          } catch (storageError) {
            this.excelData = dataToSave;
            this.renderButtons();
            this.showStatus(`数据暂未保存：${storageError.message || '扩展本地存储不可用'}`);
          }
          this.showSuccessMessage(`上传成功，已解析${infoCount}条信息！`);
        } catch (error) {
          console.error('❌ Excel解析错误:', error);
          this.showErrorMessage('文件解析失败，请检查格式！');
        }
      };
      reader.onerror = () => { console.error('❌ 文件读取失败'); this.showErrorMessage('文件读取失败！'); };
      reader.readAsArrayBuffer(file);
    }

    async loadDataFromExtensionStorage() {
      const storedData = await this.getStoredData();
      if (storedData) {
        try {
          const parsed = typeof storedData === 'string' ? JSON.parse(storedData) : storedData;
          if (parsed && typeof parsed === 'object') {
            if (parsed.orderedData && Array.isArray(parsed.orderedData)) {
              this.excelData = parsed;
              const buttonsContainer = document.getElementById('buttons-container');
              if (buttonsContainer) this.renderButtons();
              else {
                setTimeout(() => {
                  const retryContainer = document.getElementById('buttons-container');
                  if (retryContainer) this.renderButtons();
                }, 200);
              }
            } else if (parsed.groupedData) { this.convertOldDataToNewFormat(parsed.groupedData); }
          }
        } catch (e) { console.error('❌ 解析扩展存储数据失败:', e); this.removeStoredData(); }
      }
    }

    renderButtons() {
      if (!this.sidebar) return;
      const buttonsContainer = this.sidebar.querySelector('#buttons-container');
      if (!buttonsContainer) return;
      if (!this.excelData || typeof this.excelData !== 'object') {
        buttonsContainer.innerHTML = '<div class="no-data-tip">请先上传Excel文件</div>';
        return;
      }
      const orderedData = this.excelData.orderedData || [];
      if (orderedData.length === 0) {
        buttonsContainer.innerHTML = '<div class="no-data-tip">请先上传Excel文件</div>';
        return;
      }
      this.updateSourceSummary();
      buttonsContainer.innerHTML = '';
      const groupedOrderedData = {};
      const groupOrder = [];
      orderedData.forEach((item) => {
        if (!groupedOrderedData[item.title]) { groupedOrderedData[item.title] = []; groupOrder.push(item.title); }
        groupedOrderedData[item.title].push(item);
      });
      this.renderTabs(groupOrder);
      const query = this.searchQuery.toLowerCase();
      const visibleGroups = query ? groupOrder : this.activeGroup === 'all' ? groupOrder : this.activeGroup === 'recent' ? [] : groupOrder.filter((title) => title === this.activeGroup);
      if (this.activeGroup === 'recent' && !query) {
        const recentItems = this.recentFields.map((key) => orderedData.find((item) => this.fieldKey(item) === key)).filter(Boolean);
        if (!recentItems.length) { buttonsContainer.innerHTML = '<div class="no-data-tip">使用过的字段会出现在这里</div>'; return; }
        this.renderFieldGroup(buttonsContainer, '最近使用', recentItems, false);
        return;
      }
      let matchedCount = 0;
      visibleGroups.forEach((title) => {
        const items = groupedOrderedData[title].filter((item) => !query || [item.buttonText, item.shortcut, item.title].some((value) => String(value || '').toLowerCase().includes(query)));
        if (!items.length) return;
        matchedCount += items.length;
        this.renderFieldGroup(buttonsContainer, title, items, Boolean(query));
      });
      if (query && !matchedCount) buttonsContainer.innerHTML = '<div class="no-data-tip">没有找到匹配字段，请尝试字段名、快捷词或分组名</div>';
    }

    renderTabs(groupOrder) {
      const tabs = this.sidebar?.querySelector('#field-tabs'); if (!tabs) return;
      const validGroups = new Set(['all', 'recent', ...groupOrder]);
      if (!validGroups.has(this.activeGroup)) this.activeGroup = 'all';
      const entries = [['all', '全部'], ['recent', '最近'], ...groupOrder.map((group) => [group, group])];
      tabs.innerHTML = entries.map(([key, label]) => `<button type="button" role="tab" data-group="${this.escapeHtml(key)}" aria-selected="${key === this.activeGroup}" class="field-tab${key === this.activeGroup ? ' is-active' : ''}">${this.escapeHtml(label)}</button>`).join('');
      const activeTab = tabs.querySelector('.is-active');
      if (activeTab) {
        const tabsRect = tabs.getBoundingClientRect();
        const activeRect = activeTab.getBoundingClientRect();
        if (activeRect.left < tabsRect.left) tabs.scrollLeft -= tabsRect.left - activeRect.left;
        else if (activeRect.right > tabsRect.right) tabs.scrollLeft += activeRect.right - tabsRect.right;
      }
    }

    renderFieldGroup(container, title, items, isSearchResult) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'button-group';
        const titleDiv = document.createElement('div');
        titleDiv.className = 'group-title';
        titleDiv.innerHTML = `<span>${this.escapeHtml(title)}</span><span class="group-count">${items.length}</span>`;
        if (isSearchResult) { titleDiv.classList.add('is-link'); titleDiv.title = `切换到${title}`; titleDiv.addEventListener('click', () => { this.activeGroup = title; this.searchQuery = ''; const search = this.sidebar.querySelector('#field-search'); if (search) search.value = ''; this.renderButtons(); }); }
        groupDiv.appendChild(titleDiv);
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'group-buttons';
        items.forEach((item) => {
          const normalizedFillContent = this.normalizeProfileValue(item.buttonText, item.fillContent);
          const button = document.createElement('button');
          button.className = 'fill-button';
          button.textContent = item.buttonText;
          button.title = `填写内容: ${normalizedFillContent}`;
          button.addEventListener('mousedown', (e) => e.preventDefault());
          button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.lastSelectedFillContent = normalizedFillContent;
            this.lastSelectedFillLabel = item.buttonText;
            this.rememberRecentField(item);
            const result = this.fillAgentField({ field: item.buttonText, value: normalizedFillContent, type: this.inferAgentFieldType(item.buttonText, normalizedFillContent) });
            if (result?.ok) this.showStatus(`已填写「${item.buttonText}」`);
            else this.showToast({ title: `未能填写「${item.buttonText}」`, message: '请先点击网页中的目标控件，再选择这个字段。', type: 'error' });
          });
          buttonsDiv.appendChild(button);
        });
        groupDiv.appendChild(buttonsDiv);
        container.appendChild(groupDiv);
    }

    fieldKey(item) { return `${String(item.title || '')}\u0000${String(item.buttonText || '')}\u0000${String(item.shortcut || '')}`; }
    rememberRecentField(item) { const key = this.fieldKey(item); this.recentFields = [key, ...this.recentFields.filter((entry) => entry !== key)].slice(0, 20); this.saveUiPreferences(); }

    updateSourceSummary() {
      const name = this.sidebar?.querySelector('#source-name'); const meta = this.sidebar?.querySelector('#source-meta');
      const count = this.excelData?.orderedData?.length || 0;
      if (name) name.textContent = count ? (this.excelData.fileName || '本地资料') : '尚未导入资料';
      if (meta) meta.textContent = count ? `${count} 个字段 · ${new Set(this.excelData.orderedData.map((item) => item.title)).size} 个分组` : '请选择 Excel 或从剪贴板导入';
    }

    showToast({ title, message = '', type = 'error', duration = 4800 } = {}) {
      const region = this.sidebar?.querySelector('#toast-region'); if (!region) return;
      region.querySelectorAll('.form-profile-toast').forEach((toast) => toast.remove());
      const toast = document.createElement('div');
      toast.className = `form-profile-toast is-${type}`; toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
      toast.innerHTML = `<span class="toast-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 8v5M12 16.5h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.2 4.9L3.4 17a2 2 0 001.8 3h13.6a2 2 0 001.8-3L13.8 4.9a2 2 0 00-3.6 0z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></span><span class="toast-copy"><strong>${this.escapeHtml(title || '操作未完成')}</strong>${message ? `<small>${this.escapeHtml(message)}</small>` : ''}</span><button type="button" class="toast-close" aria-label="关闭提示"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
      const dismiss = () => { toast.classList.add('is-leaving'); setTimeout(() => toast.remove(), 180); };
      toast.querySelector('.toast-close')?.addEventListener('click', dismiss); region.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('is-visible'));
      if (duration > 0) setTimeout(() => { if (toast.isConnected) dismiss(); }, duration);
    }

    repeatSelectedValue() {
      if (this.lastSelectedFillContent == null) { this.showStatus('先点击一项信息，再选择目标输入框并按快捷键'); return; }
      const activeElement = document.activeElement;
      if (activeElement && !this.sidebar?.contains(activeElement) && ['input', 'textarea', 'select'].includes(activeElement.tagName?.toLowerCase())) {
        this.lastClickedInput = activeElement;
      }
      const result = this.fillAgentField({
        field: this.lastSelectedFillLabel || '重复填写',
        value: this.lastSelectedFillContent,
        type: this.inferAgentFieldType(this.lastSelectedFillLabel, this.lastSelectedFillContent)
      });
      if (!result?.ok) this.showStatus('当前目标控件无法填写，请重新点击目标控件');
    }

    fillFormContent(content) {
      const activeElement = document.activeElement;
      const activeIsPageField = activeElement && !this.sidebar?.contains(activeElement) && ['input', 'textarea', 'select'].includes(activeElement.tagName?.toLowerCase());
      let targetElement = activeIsPageField ? activeElement : this.lastClickedInput;
      if (targetElement && (!targetElement.isConnected || this.sidebar?.contains(targetElement) || targetElement.getBoundingClientRect().width === 0 || targetElement.getBoundingClientRect().height === 0)) targetElement = null;
      if (!targetElement || !['input', 'textarea', 'select'].includes(targetElement.tagName?.toLowerCase())) {
        this.showStatus('先点击页面中的目标输入框，再选择信息或按快捷键');
        return;
      }
      if (targetElement.disabled || targetElement.readOnly || targetElement.type === 'file' || ['hidden', 'submit', 'button', 'reset'].includes(targetElement.type)) {
        this.showStatus('当前字段不可填写，请选择普通文本输入框');
        return;
      }
      const tagName = targetElement.tagName.toLowerCase();
      let nextValue = content;
      if (tagName === 'select') {
        const normalizedContent = String(content).toLowerCase();
        const matchingOption = Array.from(targetElement.options).find((option) =>
          String(option.text).toLowerCase().includes(normalizedContent) || String(option.value).toLowerCase().includes(normalizedContent)
        );
        if (!matchingOption) return;
        nextValue = matchingOption.value;
      }
      if (setNativeFieldValue(targetElement, nextValue)) this.showStatus(`已填写「${this.lastSelectedFillLabel || '所选信息'}」`);
    }

    checkFileChanged(newFile) { if (!this.currentFile) return false; if (this.currentFile.name !== newFile.name) return true; if (this.fileLastModified && this.fileLastModified !== newFile.lastModified) return true; return false; }
    calculateHash(data) { let hash = 0; for (let i = 0; i < data.length; i++) { const char = data[i]; hash = ((hash << 5) - hash) + char; hash = hash & hash; } return hash.toString(); }
    showRefreshPrompt(message = null) { const refreshSection = this.sidebar.querySelector('#refresh-section'); if (refreshSection) { const hasData = this.excelData && this.excelData.orderedData && this.excelData.orderedData.length > 0; const hasTempFile = this.tempFile; const needsLoadData = message && message.includes('加载数据'); if (hasData || hasTempFile || needsLoadData) { refreshSection.style.opacity = '0'; refreshSection.style.transform = 'translateY(-10px)'; refreshSection.style.transition = 'all 0.2s ease-out'; refreshSection.style.display = 'block'; refreshSection.offsetHeight; refreshSection.style.opacity = '1'; refreshSection.style.transform = 'translateY(0)'; const refreshText = refreshSection.querySelector('.refresh-text'); if (refreshText) { if (message) refreshText.textContent = message; else refreshText.textContent = this.tempFile ? '文件已选择，点击刷新' : '点击刷新数据'; } } else { refreshSection.style.display = 'none'; } } }
    hideRefreshPrompt() { const refreshSection = this.sidebar.querySelector('#refresh-section'); if (refreshSection) { refreshSection.style.transition = 'all 0.2s ease-out'; refreshSection.style.opacity = '0'; refreshSection.style.transform = 'translateY(-10px)'; setTimeout(() => { refreshSection.style.display = 'none'; refreshSection.style.opacity = '1'; refreshSection.style.transform = 'translateY(0)'; refreshSection.style.transition = ''; }, 200); } }
    async handleRefreshClick(event) { event.preventDefault(); event.stopPropagation(); if (this.tempFile) { if (typeof XLSX === 'undefined') { this.showErrorMessage('XLSX库加载失败，请刷新页面重试'); return; } this.processExcelFile(this.tempFile); this.tempFile = null; this.hideRefreshPrompt(); this.showSuccessMessage('数据刷新成功！'); return; } const storedData = await this.getStoredData(); if (storedData) { try { const parsed = typeof storedData === 'string' ? JSON.parse(storedData) : storedData; if (parsed.orderedData && Array.isArray(parsed.orderedData)) { this.excelData = parsed; this.renderButtons(); this.hideRefreshPrompt(); this.showSuccessMessage('数据刷新成功！'); } else if (parsed.groupedData) { this.convertOldDataToNewFormat(parsed.groupedData); this.hideRefreshPrompt(); this.showSuccessMessage('数据刷新成功！'); } else { this.showErrorMessage('数据格式不正确！'); } } catch (e) { this.showErrorMessage('数据刷新失败！'); } } else { this.showErrorMessage('没有找到存储的数据！'); } }
    showSuccessMessage(message) { console.log('✅', message); }
    showErrorMessage(message) { console.error('❌', message); }
    convertOldDataToNewFormat(groupedData) { const orderedData = []; let order = 0; Object.entries(groupedData).forEach(([title, fields]) => { Object.entries(fields).forEach(([buttonText, fillContent]) => { orderedData.push({ title, buttonText, fillContent, order: order++ }); }); }); this.excelData = { orderedData, groupedData }; this.setStoredData(this.excelData); this.renderButtons(); this.showRefreshPrompt('内容已更新'); }
    checkIfFreshInstall() { this.isFreshInstall = false; }

    addDebugInfo() {
      // Debug helpers preserved from v1.4.2. Kept intentionally narrow to
      // avoid PII leaks through console.
      window.debugOfferYuan = {
        showData: () => this.excelData,
        showStorage: () => chrome.storage.local.get(['offer_yuan_excel_data'], (r) => console.log('💾 本地存储数据:', r)),
        clearStorage: () => chrome.storage.local.remove(['offer_yuan_excel_data'], () => { this.excelData = []; this.renderButtons(); }),
        refreshButtons: () => this.renderButtons(),
        reloadData: () => this.loadDataFromExtensionStorage(),
        forceUpdateData: () => { this.excelData = []; chrome.storage.local.remove(['offer_yuan_excel_data'], () => this.renderButtons()); },
        testFill: (content) => this.fillFormContent(content),
        showTargetInput: () => { console.log('🎯 当前目标输入框:', this.lastClickedInput); console.log('🎯 当前焦点元素:', document.activeElement); },
        manualRefresh: () => this.handleRefreshClick({ preventDefault: () => {}, stopPropagation: () => {} }),
        edgeDebug: () => { console.log('🔍 Edge浏览器调试信息:'); console.log('🌐 User Agent:', navigator.userAgent); console.log('🌐 是否Edge:', navigator.userAgent.includes('Edg')); console.log('🌐 扩展存储可用:', !!chrome?.storage?.local); console.log('🌐 XLSX库:', typeof XLSX); console.log('🌐 FileReader:', typeof FileReader); console.log('🌐 当前数据:', this.excelData); console.log('🌐 临时文件:', this.tempFile); },
        forceReupload: () => { this.excelData = []; chrome.storage.local.remove(['offer_yuan_excel_data'], () => this.renderButtons()); },
        showStatus: () => { console.log('📊 当前状态:'); console.log('- 内存数据条数:', this.excelData?.orderedData?.length || 0); console.log('- 侧边栏存在:', !!this.sidebar); console.log('- 按钮容器存在:', !!this.sidebar?.querySelector('#buttons-container')); },
        resetPlugin: () => { this.excelData = []; chrome.storage.local.clear(() => {}); const fileInput = this.sidebar?.querySelector('#excel-file'); if (fileInput) fileInput.value = ''; this.renderButtons(); },
        setAutoLoad: (enabled) => { this.autoLoadData = enabled; }
      };
      console.log('🔧 调试方法已添加，使用 window.debugOfferYuan 访问');
    }

  }

  function cssPathFor(element) {
    if (!element) return '';
    if (element.id) return `#${element.id}`;
    return `[data-agent-target="1"]`;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'repeatSelectedValue') { window.smartFormFiller?.repeatSelectedValue(); return; }
    if (message.action === 'showSidebar') {
      if (window.smartFormFiller) {
        window.smartFormFiller.showSidebar();
        if (!document.getElementById('toggle-sidebar-btn')) window.smartFormFiller.createToggleButton();
        else window.smartFormFiller.updateToggleButtonState();
      } else {
        initPlugin();
        setTimeout(() => {
          if (window.smartFormFiller) {
            window.smartFormFiller.showSidebar();
            if (!document.getElementById('toggle-sidebar-btn')) window.smartFormFiller.createToggleButton();
          }
        }, 200);
      }
    }
  });

  function initPlugin() {
    if (window.smartFormFiller) return;
    if (document.body) {
      try { window.smartFormFiller = new SmartFormFiller(); }
      catch (error) { console.error('❌ 插件初始化失败:', error); setTimeout(initPlugin, 100); }
    } else { setTimeout(initPlugin, 100); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPlugin);
  } else { initPlugin(); }
})();
