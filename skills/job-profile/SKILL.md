---
name: job-profile
description: 在用户明确授权后,使用浏览器内已安装的信息填写扩展(formHelper)读取字段资料并填写招聘/投递表单。支持 list/get 发现字段、文本框快捷词展开、以及按字段类型(text/date/select/cascader/file)的控制路由。仅在用户已授权操作该表单时激活。
---

# Job Profile

仅在用户明确授权操作该表单后激活。当前环境提供哪种浏览器自动化能力就用哪种,不要假设具体的驱动或框架。

## 工作流程

1. 把字段资料加载进扩展。
2. 用 `formHelper` 发现表单字段。
3. 按下面的"控制路由"逐个填写。
4. 每个字段填完后验证控件是否真的接收了值。
5. 出错时按错误处理规则回退,绝不猜测。

## 1. 加载字段资料

```bash
python scripts/export.py "<workbook.xlsx>"
```

打开投递页面后按 `Alt+Shift+V`,把剪贴板内容导入扩展。资料存在 `chrome.storage.local` 里,不会写入招聘网站的存储。

**验证导入行数**(无需看扩展 UI):直接调 `formHelper.list({ level: null })`,数返回的 `result.fields.length`,跟 `export.py` 输出的行数对比。

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

## 错误处理

- `field_not_found` —— 回到 level 1 找到正确的组,再重新走 level 2。
- 歧义 —— 用唯一的 `shortcut`,或用 `group`+`occurrence` / `targetOccurrence` 锁定记录。绝不猜测。
- 页面上找不到 `formHelper` —— 确认扩展已加载,然后刷新页面。
- 手动导入对话框没打开 —— 检查 `Alt+Shift+V` 是否真的到达了扩展(焦点必须在页面里,不能停留在地址栏)。

## 安全护栏

- 未经用户明确要求,不要提交、保存、勾选声明、点"下一步",也不要覆盖任何已填的非空关键值。
- 不要为了"查看资料集"去读取无关的字段。
