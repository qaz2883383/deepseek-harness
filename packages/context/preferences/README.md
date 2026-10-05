---
description: "Per-conversation reply-style preferences for a personal workbench deployment: category selection plus user-editable profile files injected as runtime context."
kind: "package-reference"
---

# @deepseek-ai/dsh-preferences

个人工作台自研包（未上游合入）：按会话选择回复风格类别（work / learning），并把对应的用户可编辑偏好档案作为运行时上下文注入。

## Use this package

挂载后提供两个模型侧工具与一条运行时上下文：

| 能力 | 说明 |
|---|---|
| `reply_style` 工具 | 为当前会话选择类别；选定后档案全文经 `preferences:profile` 上下文（顺序 125，user-role 快照通道）注入后续请求 |
| `update_preference` 工具 | 向档案文件追加一条长期指令（用户说“以后简短点”时模型调用） |
| 档案文件 | `$DSH_HOME/preferences/work.md`、`learning.md`（首次自动生成默认内容，用户可手改） |
| 选择状态 | `$DSH_HOME/preferences/selection.json`（sessionId → 类别） |

配置字段：`dir`（可选，覆盖档案目录，默认 `$DSH_HOME/preferences`）。

## Known Limitations and Deferred Work

- 选择状态按 sessionId 存于本地 JSON，不进会话日志：fork 不继承选择，重放不重建状态（个人部署可接受）。
- 档案文件为同步读写（每次组装读取一次，文件极小）；无并发保护（单用户本地使用）。
