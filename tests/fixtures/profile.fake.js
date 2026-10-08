// Fake profile fixture for tests.
// IMPORTANT: All values here are synthetic and contain no real PII.
// They are designed to exercise the agent API across all interaction types
// (text, date, select, cascader, custom widgets) without leaking personal data.

'use strict';

// Map of canonical key → display label. The fixture deliberately uses generic
// placeholders so that any leaked fixture string remains obviously fake.
const FAKE_PROFILE = {
  meta: {
    source: 'fake-fixture',
    generatedFor: 'agent-api-tests',
    notes: 'Synthetic; no real PII. Do not reuse outside tests.'
  },
  orderedData: [
    { title: '基本信息', buttonText: '姓名', fillContent: '测试用户A', shortcut: 'xm' },
    { title: '基本信息', buttonText: '手机号', fillContent: '13800000000', shortcut: 'sjh' },
    { title: '基本信息', buttonText: '常用邮箱', fillContent: 'demo@example.com', shortcut: 'cyyx' },
    { title: '基本信息', buttonText: '身份证号码', fillContent: '110000200001010000', shortcut: 'sfzh' },
    { title: '基本信息', buttonText: '性别', fillContent: '男', shortcut: 'xb' },
    { title: '基本信息', buttonText: '出生日期', fillContent: '2000-01-01', shortcut: 'csrq' },
    { title: '基本信息', buttonText: '户籍所在地', fillContent: '某省/某市/某区', shortcut: 'hkszd' },
    { title: '基本信息', buttonText: '现居住地', fillContent: '某省/某市/某区', shortcut: 'xjzd' },
    { title: '基本信息', buttonText: '微信号', fillContent: 'fake_wechat_id', shortcut: 'wxh' },

    { title: '教育经历1', buttonText: '学校名称', fillContent: '示例大学', shortcut: 'jyxl1xxmc' },
    { title: '教育经历1', buttonText: '专业', fillContent: '示例专业', shortcut: 'jyxl1zy' },
    { title: '教育经历1', buttonText: '入学时间', fillContent: '2018-09', shortcut: 'jyxl1rxsj' },
    { title: '教育经历1', buttonText: '毕业时间', fillContent: '2022-06', shortcut: 'jyxl1bysj' },
    { title: '教育经历1', buttonText: 'GPA', fillContent: '3.8', shortcut: 'jyxl1gpa' },

    { title: '教育经历2', buttonText: '学校名称', fillContent: '示例研究生院', shortcut: 'jyxl2xxmc' },
    { title: '教育经历2', buttonText: '专业', fillContent: '示例研究生专业', shortcut: 'jyxl2zy' },
    { title: '教育经历2', buttonText: '入学时间', fillContent: '2022-09', shortcut: 'jyxl2rxsj' },
    { title: '教育经历2', buttonText: '毕业时间', fillContent: '2025-06', shortcut: 'jyxl2bysj' },

    { title: '实习经历1', buttonText: '工作单位', fillContent: '示例实习单位一', shortcut: 'sxjl1gzdw' },
    { title: '实习经历1', buttonText: '开始时间', fillContent: '2024-01', shortcut: 'sxjl1kssj' },
    { title: '实习经历1', buttonText: '结束时间', fillContent: '2024-06', shortcut: 'sxjl1jssj' },

    { title: '实习经历2', buttonText: '工作单位', fillContent: '示例实习单位二', shortcut: 'sxjl2gzdw' },
    { title: '实习经历2', buttonText: '开始时间', fillContent: '2024-07', shortcut: 'sxjl2kssj' },
    { title: '实习经历2', buttonText: '结束时间', fillContent: '2024-12', shortcut: 'sxjl2jssj' },

    { title: '实习经历3', buttonText: '工作单位', fillContent: '示例实习单位三', shortcut: 'sxjl3gzdw' },
    { title: '实习经历3', buttonText: '开始时间', fillContent: '2025-01', shortcut: 'sxjl3kssj' },
    { title: '实习经历3', buttonText: '结束时间', fillContent: '2025-05', shortcut: 'sxjl3jssj' },

    { title: '工作意向', buttonText: '期望工作城市', fillContent: '示例城市', shortcut: 'gzyxqwgzcs' },
    { title: '工作意向', buttonText: '期望月薪', fillContent: '10000', shortcut: 'gzyxqwyx' },
    { title: '工作意向', buttonText: '到岗时间', fillContent: '2026-07-01', shortcut: 'gzyxdgsj' },

    { title: '自我评价', buttonText: '自我评价', fillContent: '示例自我评价文本，用于验证 textarea 填写。', shortcut: 'zwpj' }
  ]
};

// Sanity check: ensure the fixture does not contain obvious real-person indicators.
function assertFixturePrivacy(rows) {
  const banned = ['private-person-marker', 'private-email-marker', 'private-employer-marker'];
  for (const row of rows) {
    for (const key of banned) {
      if (String(row.fillContent || '').includes(key)) {
        throw new Error(`fixture contains banned substring: ${key}`);
      }
    }
  }
}
assertFixturePrivacy(FAKE_PROFILE.orderedData);

module.exports = { FAKE_PROFILE };
