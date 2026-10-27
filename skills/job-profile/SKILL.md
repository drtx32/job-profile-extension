---
name: job-profile
description: 在用户明确授权后,使用浏览器内已安装的信息填写扩展(formHelper)读取字段资料并填写招聘/投递表单。支持 list/get 发现字段、文本框快捷词展开、以及按字段类型(text/date/select/cascader/file)的控制路由。仅在用户已授权操作该表单时激活。
---

# Job Profile

仅在用户明确授权操作该表单后激活。当前环境提供哪种浏览器自动化能力就用哪种,不要假设具体的驱动或框架。

## 扩展启用与用户确认

- 扩展不会自动注入网页。每个新网页/标签页都提醒用户亲自点击浏览器工具栏中的扩展图标；建议用户先把扩展固定到工具栏,方便操作。
- Agent 需要访问资料时,说明还需用户在扩展面板亲自点击“允许 Agent 在本页读取资料”。**绝不代替用户点击、模拟点击或通过脚本绕过这个授权控件。**等待用户明确表示已启用后,再调用 `formHelper`。
- 授权仅针对当前标签页；不能假定在其他标签页或导航后的新页面仍有效。需要时再次请用户亲自启用。

## 工作流程

1. 提醒用户扩展未固定时可先固定到工具栏；每个网页都由用户亲自点击工具栏扩展图标打开助手。网站默认没有扩展脚本或悬浮按钮。
2. Agent 需要读取字段时，请用户在面板亲自点击“允许 Agent 在本页读取资料”，然后等待用户确认。Agent 不得替用户点击或模拟授权；未确认前不要调用 `formHelper`。
3. 用 `formHelper` 发现表单字段。
4. 按下面的"控制路由"逐个填写。
5. 每个字段填完后验证控件是否真的接收了值。
6. 出错时按错误处理规则回退,绝不猜测。
7. 尽量填完所有能由已授权资料准确匹配的字段;不确定、资料缺失或已有非空值时不要猜或覆盖。

## 1. 加载字段资料

```bash
python scripts/export.py "<workbook.xlsx>"
```

用户打开扩展面板后按 `Alt+Shift+V`,把剪贴板内容导入扩展。资料默认只保存在本次浏览器会话；只有用户勾选“在此设备上记住资料”后才长期保留在扩展本地。Agent 接口默认关闭,启用后只在当前页面响应。

**验证导入行数**:等用户亲自启用当前页面的 Agent 接口后,再调 `formHelper.list({ level: null })`,数返回的 `result.fields.length`,跟 `export.py` 输出的行数对比。

```javascript
const result = await formHelper.list({ level: null });
const importedCount = result.fields.length;
// importedCount 必须等于 export.py 输出的行数
```

**自动导入失败时的兜底**:打开侧边栏的"剪贴板快速导入"对话框,粘贴剪贴板内容,点击"导入并覆盖当前数据"。

## 2. 发现字段

`formHelper` 是字段索引。发现阶段不要回头读 Excel 表格或全量枚举。

公开 API 只暴露两个方法:`list` 和 `get`。不要调用其他任何方法;只要不是 `list` 或 `get`,扩展就没暴露。

```javascript
// 列出所有组
await formHelper.list()

// 列出某个组内的字段(level 2 返回 field_name、shortcut、field_type、has_value、occurrence)
await formHelper.list({ level: 2, group_name: '基本信息' })

// 跨组语义搜索
await formHelper.list('父亲 姓名')

// 全量枚举 —— 仅在按组发现走不通时使用
await formHelper.list({ level: null })

// 取单个字段的值(用于 date/select/cascader,然后由浏览器自动化工具操作控件)
await formHelper.get('fqxm')

// 带消歧义的取值(group + occurrence;若页面控件本身重复,再加 targetOccurrence)
await formHelper.get({ field: 'fqxm', group: '基本信息', occurrence: 1, targetOccurrence: 1 })
```

两个方法都支持第二参数 `{ timeoutMS }`(默认 5000,最大 120000),用于深层级联超过预设时间的情况。

**资料行重复**:用确认过的 `group` 名或基于 1 的 `occurrence` 选定。绝不要从 DOM 顺序推断。

**页面控件重复**(同一个选择器匹配多个输入框):再加基于 1 的 `targetOccurrence`,用来指明值要填到哪个控件。

## 3. 填写字段 —— 控制路由

| 字段类型 | 做法 |
|---|---|
| text、textarea、phone、email、number | 输入 `shortcut`(例如 `fqxm`),然后按 Space 或 Enter。无需 `get()`。仅当 shortcut 不唯一时才回退到 `field_name`。 |
| date、month | `await formHelper.get(shortcut)` 拿到值,然后用浏览器自动化工具操作日期选择器,并肉眼验证。 |
| select、cascader | 同 date:`get(shortcut)` 拿值,然后用浏览器自动化工具驱动下拉。 |
| file | 使用当前环境的文件上传机制,验证上传目标确实是期望的那个文件。 |

**规则**

- 不要用 Tab 触发替换 —— Tab 会把焦点跳到下一个控件。
- 如果一个 `field_name` 对应多个不同的值,关键词展开会拒绝猜测;改用 `group`+`occurrence` 或 `targetOccurrence` 消歧。
- 每填完一个字段,先验证控件确实接收到了值,再继续下一个。

## 4. 重复填入上一次选中的值

侧边栏字段按钮或关键词展开选中一个值后,`Alt+Shift+F` 会把那个值重新填入当前焦点所在的兼容控件。用于"故意重复"(比如同一封邮箱写两次),不要用来切换到另一个不同的字段。

## 5. 侧边栏快捷键

- `Ctrl+/` —— 在侧边栏打开快捷键与字段索引。
- `Alt++` / `Alt+-` —— 调整字段按钮和分组标题的字号。

## 6. 完成、保存与投递

- 填完后检查页面的必填提示和校验错误,优先完成所有有准确资料依据的字段。
- 若没有待补必填项,也没有需要用户确认的真实性声明,且页面提供“暂存/暂时保存”,直接暂存并确认页面显示保存成功;只有普通“保存”时,在同样条件下保存并验证。
- 若有缺失必填项或需要候选人确认信息属实、勾选声明,停止操作并立即列出待办,要求用户核实/补齐后亲自确认并保存。Agent 不得替用户勾选真实性声明。
- 若页面没有“保存/暂存”入口,告知用户尽快补齐剩余必填项并亲自投递。除非用户明确授权本次最终提交且所有资料和声明已由用户确认,Agent 不得点击最终投递/提交。
- 不论保存或暂存,都要回读页面状态确认结果;不要仅凭点击动作声称成功。

## 错误处理

- `field_not_found` —— 回到 level 1 找到正确的组,再重新走 level 2。
- 歧义 —— 用唯一的 `shortcut`,或用 `group`+`occurrence` / `targetOccurrence` 锁定记录。绝不猜测。
- 页面上找不到 `formHelper` —— 提醒用户亲自点击工具栏扩展图标，并在面板亲自启用本页 Agent；不得代点授权。关闭面板/切换页面后需重新确认当前页授权状态。
- 手动导入对话框没打开 —— 检查 `Alt+Shift+V` 是否真的到达了扩展(焦点必须在页面里,不能停留在地址栏)。

## 安全护栏

- 不得替用户确认信息真实性、勾选声明或猜填缺失资料;最终投递/提交必须获得针对本次表单的明确授权。
- 不要覆盖任何已填的非空关键值,也不要仅为查看资料而读取无关字段。
