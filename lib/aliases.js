// Field alias / canonical mapping for the agent API.
//
// The agent often sees many synonyms for the same logical field across
// recruitment sites ("毕业院校" / "院校名称" / "就读学校" / "school" all
// refer to the school name). This module maps them to a stable canonical key
// without ever exposing the actual stored value.

'use strict';

const DEFAULT_CANONICAL_ALIASES = {
  // identity
  'identity.name': ['姓名', 'xm', 'name', 'full_name'],
  'identity.phone': ['手机号', '手机', 'sjh', 'phone', 'mobile'],
  'identity.email': ['常用邮箱', '邮箱', 'cyyx', 'email'],
  'identity.id_number': ['身份证号码', '身份证', 'sfzh', 'id_card'],
  'identity.gender': ['性别', 'xb', 'gender'],
  'identity.birth_date': ['出生日期', '生日', 'csrq', 'birth_date', 'birthday'],

  // location
  'location.hukou': ['户籍所在地', '户籍', 'hkszd', 'hukou'],
  'location.current': ['现居住地', '居住地', 'xjzd', 'current_address'],
  'location.work_city': ['期望工作城市', '工作城市', 'qwgzcs', 'work_city'],

  // education
  'education.school': [
    '学校名称', '毕业院校', '院校名称', '就读学校', '院校', 'xxmc', 'school', 'school_name'
  ],
  'education.major': ['专业', '所学专业', '专业名称', 'zy', 'major'],
  'education.degree': ['最高学历', '学历', '学位', 'zgxl', 'xl', 'xw', 'degree'],
  'education.start': ['入学时间', '就读开始时间', 'rxsj'],
  'education.end': ['毕业时间', '就读结束时间', 'bysj'],
  'education.gpa': ['GPA', 'gpa', '绩点'],

  // experience
  'experience.employer': ['工作单位', '单位名称', 'gzdw', 'employer', 'company'],
  'experience.start': ['开始时间', '起始时间', 'kssj'],
  'experience.end': ['结束时间', '终止时间', 'jssj'],

  // intent
  'intent.salary': ['期望月薪', '薪资', 'qwyx', 'salary'],
  'intent.onboard': ['到岗时间', '入职时间', 'dgsj'],

  // generic
  'generic.textarea': ['自我评价', '个人简介', '自我介绍', 'zwpj']
};

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

// A registry that supports merging overrides onto defaults. Overrides are
// applied last so they win. The registry returns both forward and reverse maps
// for fast resolution.
class AliasStore {
  constructor(initial = {}) {
    this._aliases = {};
    Object.assign(this._aliases, DEFAULT_CANONICAL_ALIASES);
    Object.assign(this._aliases, initial);
    this._reverse = buildReverseMap(this._aliases);
  }

  resolve(raw) {
    if (!raw) return null;
    const normalized = String(raw).toLowerCase().trim();
    return this._reverse[normalized] || null;
  }

  // resolveCanonical takes a profile item (label + shortcut + group context) and
  // returns the canonical key with confidence. If the label matches but the
  // shortcut does not, we still return the canonical key with lower confidence.
  resolveProfileItem(item) {
    if (!item) return { canonical: null, confidence: 0 };
    const label = String(item.buttonText || '').toLowerCase().trim();
    const shortcut = String(item.shortcut || '').toLowerCase().trim();
    const group = String(item.title || '').toLowerCase().trim();
    const directLabel = label ? this._reverse[label] : null;
    const directShortcut = shortcut ? this._reverse[shortcut] : null;
    if (directLabel && directShortcut) {
      return { canonical: directLabel, confidence: directLabel === directShortcut ? 1 : 0.9 };
    }
    if (directLabel) return { canonical: directLabel, confidence: 0.95 };
    if (directShortcut) return { canonical: directShortcut, confidence: 0.85 };
    // Heuristic fallback based on group context — never returns PII, only the
    // canonical key derived from the section name.
    if (/教育|education|学历|院校|学校/i.test(group + label)) return { canonical: 'education.school', confidence: 0.4 };
    if (/实习|工作|experience/i.test(group + label)) return { canonical: 'experience.employer', confidence: 0.4 };
    return { canonical: null, confidence: 0 };
  }

  // aliases() returns the canonical map for the agent. Returns a copy so the
  // agent cannot mutate the registry.
  aliases() {
    return JSON.parse(JSON.stringify(this._aliases));
  }

  addOverride(canonical, labels) {
    if (!canonical || !Array.isArray(labels)) return this;
    const merged = new Set([...(this._aliases[canonical] || []), ...labels]);
    this._aliases[canonical] = [...merged];
    this._reverse = buildReverseMap(this._aliases);
    return this;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AliasStore, DEFAULT_CANONICAL_ALIASES, buildReverseMap };
}