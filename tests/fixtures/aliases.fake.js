// Canonical alias map for the agent API. Maps display labels (button text /
// shortcut aliases) to a stable canonical key. The agent uses the canonical key
// for resolve() lookups; the value itself never lives in this file.
//
// IMPORTANT: this file MUST NOT contain real personal values. It only contains
// field-name aliases that are commonly used across Chinese recruitment sites.

'use strict';

const CANONICAL_ALIASES = {
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

// Reverse map from label → canonical key for O(1) resolution.
function buildReverseAliasMap(aliases) {
  const map = Object.create(null);
  for (const [canonical, labels] of Object.entries(aliases)) {
    for (const label of labels) {
      const normalized = String(label || '').toLowerCase().trim();
      if (!normalized) continue;
      if (!map[normalized]) map[normalized] = canonical;
    }
  }
  return map;
}

const REVERSE_ALIASES = buildReverseAliasMap(CANONICAL_ALIASES);

function resolveCanonical(labelOrShortcut) {
  if (!labelOrShortcut) return null;
  const normalized = String(labelOrShortcut).toLowerCase().trim();
  return REVERSE_ALIASES[normalized] || null;
}

module.exports = { CANONICAL_ALIASES, REVERSE_ALIASES, resolveCanonical };