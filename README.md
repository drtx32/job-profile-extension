# 表单资料助手

一个面向 Chrome/Edge 的本地资料表填写扩展，由 [drtx32](https://github.com/drtx32) 维护。

- 项目主页：<https://github.com/drtx32/job-profile-extension>
- 当前版本：`1.2.4`
- 配套 Agent Skill：[`job-profile`](skills/job-profile/SKILL.md)

## 功能

- 从单个 Excel 文件或剪贴板导入字段资料。
- 数据仅保存在扩展的 `chrome.storage.local`，不会写入网站 Local Storage。
- 使用水平分组 Tabs、全局搜索和最近使用快速定位字段。
- 在文本框输入唯一快捷词后按空格或回车自动展开资料值。
- 通过 `formHelper.list()` 和 `formHelper.get()` 向浏览器 Agent 提供只读字段接口。
- 支持日期、下拉、多级级联和文件字段的自动化协作流程。

## 安装

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本仓库根目录。

## 使用

1. 点击网页右侧的“资料”按钮打开面板。
2. 选择 Excel，或按 `Alt + Shift + V` 从剪贴板导入。
3. 先点击网页中的目标控件，再点击资料字段；普通文本框也可输入字段快捷词后按空格或回车。
4. 用搜索框或 `全部 / 最近 / 分组` Tabs 查找字段。

剪贴板内容无法自动读取或识别时，插件会打开独立的手动粘贴对话框，不改变主面板高度。

## 快捷键

- `Ctrl + /`：打开快捷键与字段中心。
- `Alt + Shift + V`：从剪贴板导入资料。
- `Alt + Shift + F`：将上次选择的值重新填入当前控件。
- `Alt +` / `Alt -`：调整字段按钮和分组标题大小。
- 空格或回车：在普通文本框中展开已经输入的字段快捷词。

## Agent 接口

```javascript
await formHelper.list()
await formHelper.list({ level: 2, group_name: '基本信息' })
await formHelper.list('父亲 姓名')
await formHelper.get('fqxm')
```

公开接口只保留 `list()` 和 `get()`。普通文本字段优先使用快捷词加空格/回车；日期、下拉和级联控件先用 `get()` 取得单个字段值，再由当前浏览器自动化工具操作。

## Skill

仓库内的 `skills/job-profile/` 可以安装到 Agent 的 Skills 目录。其 `scripts/export.py` 可将工作簿首个工作表复制到剪贴板：

```powershell
python skills/job-profile/scripts/export.py "D:\path\profile.xlsx"
```

脚本只输出复制行数，不打印字段内容。

## 测试

```powershell
node tests/run.js
```

测试数据全部为合成数据，真实 Excel、CSV、会话文件和环境文件默认被 `.gitignore` 排除。
