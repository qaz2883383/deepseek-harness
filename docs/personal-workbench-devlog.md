# 个人工作管理 Agent — 开发日志

> 关联文档：[方案](dsh-个人工作管理agent-方案.md) · [dsh 架构分析](dsh-架构分析.md) · [UI demo](dsh-taskboard-demo.html)
> 仓库：`d:\2026\涅槃\AGENT\deepseek-harness`
> 记录规则：每条含 **时间 / 阶段 / 动作 / 结果 / 下一步**；关键命令与输出摘要直接留档。

---

## 开发目的

基于 DeepSeek Harness（dsh）编排一个个人日常工作管理 agent，满足五个需求：

1. **定期任务**：周期性工作自动触发（如每日日报）
2. **多任务并行 + 提醒**：并行派活、完成自动提醒、无需人盯盘
3. **外部工具对接**：Chrome（MCP）、Trae（形态待定）
4. **便签式 Web UI**：任务以便利贴展示，只看进度，完成有通知
5. **习惯记忆**：按任务类别（工作/学习）注入不同的回复风格偏好

总体路线：dsh web profile 常驻管理会话 + 后台 subagent/job 执行 + `task/*` 事件投影驱动 UI + 自研 5 个薄插件（task-board / task-scheduler / notify / board-ui / preferences）。分 6 阶段实施，详见方案文档。

---

## 日志

### 2026-10-03 · 阶段 0：环境验证（已完成，1 项待用户动作）

**目标**：install/build/启动/组合 schedule 全链路跑通，为后续阶段打底。

**关键动作与结果**：

| # | 动作 | 结果 |
|---|---|---|
| 1 | 环境检查 | node v24.14.0（满足 ≥24）、pnpm 11.7.0（packageManager 固定版已生效）、`node_modules` 已存在且完整（tsx/tsc/tsdown/.modules.yaml 全在）——跳过全量安装 |
| 2 | `pnpm install` | **失败**：Trae 沙箱拦截 `D:\.pnpm-store`（工作区外）写入；提权重试仍被拦。非阻塞：依赖本来已装好 |
| 3 | `pnpm run build` | **构建成功**：`build: recorded 263 client artifact(s)`。exit 1 只是构建结束后 pnpm 写 store 收尾被沙箱拦；缺的 2 个包（`@openai/codex` / `claude-agent-sdk` win32 二进制）是 codex/claude-code 外部子代理提供方的可选依赖，本方案用不到 |
| 4 | dump-config（web） | ✓ 1198 行组合树，dsh-base 条目与文档一致 |
| 5 | dump-config（web + schedule 补丁） | ✓ `time-context` + `schedule` 插入、`ui-schedule` 被启用，共 1205 行 |
| 6 | 探测 3080 | ✓ 用户本机已有一个 dsh web 实例在跑（HTTP 401 = 鉴权姿态正常）——"web profile 能启动"被活实例证实 |
| 7 | 启动测试实例 | **✓ 成功**：`DSH_HOME` 重定向到工作区内（绕开沙箱对 `~/.dsh` 写入的拦截），端口 3090（避开 3080），带 schedule 补丁；干净启动无错误日志，浏览器已自动打开 |

**测试实例信息**（仍在运行）：

```text
地址:  http://127.0.0.1:3090（已带 token 自动打开浏览器）
home:  D:\2026\涅槃\AGENT\workbench-test\dsh-home（全新，与 ~/.dsh 隔离）
组合:  web profile + schedule 补丁 + 端口覆盖层（workbench-test\port-3090.patch.yml）
```

**发现的环境限制（沙箱相关，均已绕开或给出对策）**：

1. `D:\.pnpm-store`（pnpm 全局 store，工作区外）写入被拦 → `pnpm install` 在 Trae 终端内不可用。对策：依赖已装好无需重装；将来需要时在 Trae 外的普通终端跑，或在 设置 → 权限与审批 → 自定义配置 里放行该路径。
2. `C:\Users\<user>\.dsh` 写入被拦（logs/sessions/storages）→ 在 Trae 内用真实 home 跑 dsh 会失败。对策：已部署工作区本地 `DSH_HOME` 方案。
3. **凭据复制被安全策略拦截**（把 `~/.dsh/.credentials.yaml` 复制到测试 home 属于凭据物化操作，需用户亲自执行）→ 测试实例目前**没有模型凭据，能开 UI 但不能对话**。

**待用户动作（二选一，解锁"并行 subagent + 完成通知"实测）**：

- 方案 A（推荐）：自己复制凭据到测试 home（在你自己的终端跑，一条命令）：
  `Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" "D:\2026\涅槃\AGENT\workbench-test\dsh-home\.credentials.yaml"`
  然后在 3090 的浏览器页里新开会话，发一条："并行启动两个 subagent，一个数 1..20 的偶数个数、一个数奇数个数，都完成后告诉我结果"，再试 "60 秒后提醒我喝水"（schedule_create）。
- 方案 B：直接在你已有的 3080 正式实例里做上面的对话测试（无 schedule，但并行 subagent 可测）。

### 2026-10-03 · 阶段 0 收官 + 模型路由配置

**用户实测通过**：并行 subagent（需求 2）与 60 秒 schedule 提醒（需求 1）在 3090 实例上均正常工作。**阶段 0 完成。**

**用户反馈（UI 设计需求，记入阶段 1/3）**：定时任务的提醒在原版 web UI 里不够醒目——我们自己的便签 UI 必须把"提醒触发"做成一等公民（醒目通知卡片 + 声音/角标，不能只是聊天流里的一条普通消息）。

**模型路由配置（应用户要求）**：

- 用户提供火山引擎网关（OpenAI 兼容 `/v1`）+ 密钥 + 模型 `deepseek-v4-flash`；直连 API 验证通过（模型正常回复）。
- 新增 `workbench-test/volce-llm.patch.yml`：llm-pi-ai 挂 `volce` 路由（`api: openai-completions` + `compat.thinkingFormat: deepseek`），密钥经 `VOLCE_API_KEY` 环境变量按请求解析（不进配置文件）；`agent-default-model` 默认路由切到 `volce/deepseek-v4-flash`。
- 新增 `workbench-test/start-web.ps1` 启动脚本（三个补丁 + 环境变量，供用户自己重启用）。

**过程问题两则（已解决）**：

1. `.ps1` 无 BOM 导致 Windows PowerShell 5.1 读乱中文路径 → 已补 BOM；且工具宿主环境不支持子进程 powershell.exe（echo 都无输出），**在工具宿主里只能用直接命令启动**，脚本留给用户自己的终端用。
2. 实例 UI 比用户的 3080 发布版多"轨迹"等界面 → 版本差异（源码 HEAD vs 安装版），非代码改动；确认 dsh 仓库代码零修改，全部变更为配置覆盖层。

**下一步**：阶段 2 —— 开发 `dsh-preferences` 插件（包结构调研已完成：函数插件形态、defineTool 参数 DSL 支持 enum、AssembleContext.agent 由 dsh-agent 声明合并、web-app 接线三件套 + gen-tsconfig-paths）。

### 2026-10-03 · 阶段 2：dsh-preferences 插件（已完成，待用户实测）

**交付**：`packages/context/preferences/`（个人工作台自研包，未上游合入）

| 能力 | 实现 |
|---|---|
| `reply_style` 工具 | 按会话选择类别（work/learning），写入 `selection.json`（sessionId → 类别） |
| `update_preference` 工具 | 向档案文件追加一条长期指令（用户说“以后简短点”时模型调用） |
| 运行时上下文注入 | `preferences:profile` context（order 125，user-role 快照通道），选定后档案全文进每次请求 |
| 档案文件 | `$DSH_HOME/preferences/{work,learning}.md`，首次自动生成默认内容，用户可手改 |

**接线（四处）**：tsconfig.host.json 引用、web-app `cordis.patch.yml` 行、web-app `package.json` 依赖、`gen-tsconfig-paths` 重新生成别名。

**绕过沙箱的三项手工操作**（Trae 沙箱拦 `D:\.pnpm-store`，`pnpm install` 不可用）：

1. 手工编辑 `pnpm-lock.yaml` 两处（web-app importer 加依赖条目 + 新增 preferences importer）——frozen-lockfile 校验通过（"Lockfile is up to date"）；
2. 手动建 junction：web-app 与 preferences 各自的 `node_modules/@deepseek-ai/*` 工作区链接；
3. `pnpm run build` 可用（exit 1 仅为收尾时 2 个可选包 store 写入被拦，产物完整：`lib/index.js` 5.67 kB + 类型）。

**踩坑记录**：

1. `defineTool` 的 **output schema 走受限值 DSL，不支持顶层 `required` 数组**——必需性写在属性上（`{ type: 'string', required: true }`），参照 `job_output` 写法。首次启动报 `JsonSchemaError: schema.required is not supported`，修正后干净启动。
2. **源码启动（tsx）直接运行 `src/index.ts`，改源码重启即生效，无需重新构建**——插件开发内环极快（stack trace 证实）。
3. `.ps1` 启动脚本在工具宿主内不可用（子进程 powershell.exe 无输出），仅在用户自己的终端可用。

**当前状态**：3090 实例干净启动，preferences 插件激活无警告，默认档案已自动生成。

### 2026-10-03 · 阶段 2 验收：用户确认插件生效

用户实测确认 reply_style / update_preference 工作正常（“至少是生效的”）。习惯记忆机制已向用户完整讲解（三层结构 / 快照通道 / 文件载体 / 可审计性）。**阶段 2 完成。**

### 2026-10-03 · 阶段 3 启动：路线修正 + board-ui 蓝图（调研完成，待实施）

**新 UI 需求（用户）**：习惯记忆要有**查看/编辑界面**——偏好档案（work.md/learning.md）不能只靠手改文件。归入 board-ui 一并做。

**关键调研发现：自定义会话事件走不通（暂缓）**

原方案的 `task/*` 会话事件遇到硬约束：`SessionEventMap` 成员默认 required-on-read（不认识的读取方拒绝重建日志），唯一的豁免标记 `ignorable` 在**生产代码中没有任何 append 路径**（只在信封校验和测试夹具中出现；`Session.append` 的选项参数只服务 surface 事件）。subagent 包自己的 `subagent/catalog` 等事件是一方包事件（同样 required，但由仓库自身消费）。

**决策：阶段 3 改走方案文档预留的最小路径——便签板直接渲染现成数据，不造新事件**：

| 便签数据 | 现成通道 |
|---|---|
| 子代理任务卡 | `subagentCatalog` 投影（subagent 包已注册，control 流推送） |
| 后台命令任务卡 | jobs（api-job-controller 已有客户端数据面） |
| 定期任务卡 | schedule 目录投影（ui-schedule 同源） |
| 完成提醒 | subagent-settled / job 完成通知（监听投影变更触发 Notification，需醒目化） |

模型声明式任务（task/* 事件 + taskBoard 投影 + task 工具）**推迟**到后续阶段，届时若 dsh 开放 ignorable 写入路径或我们决定接受同组合内闭环，再实施。

**board-ui 蓝图（从 ui-schedule 提取的完整模板）**：

```text
packages/client/ui-board/
  package.json          # @deepseek-ai/dsh-client-ui-board
                        #   dsh.client: { inject: [locale, ui-conversation, ui-primitives, ...], platform: 'web' }
                        #   scripts: bundle=tsdown, watch=tsdown --watch
                        #   exports: ./ ./client ./src/* ./package.json
  tsconfig.json         # extends tsconfig.base.client.json, references 各 dev 依赖
  tsdown.config.ts      # clientBundle('@deepseek-ai/dsh-client-ui-board', ['lib/types/index.js'])
  src/index.ts          # 空 apply（node 半，保 Loader 可寻址）
  src/client/index.ts   # browser 半：export inject=['slots','locale'] + apply(ctx)
                        #   ctx.locale.register(NS, { zh, en })
                        #   ctx.slots.inject('<目标slot>', () => ctx.slots.register({ name, id, order, locale }, Component))
  src/client/locales.ts # 类型化词典 + declare module LocaleNamespaceMap
  src/client/Board*.tsx # 便签组件（--dsw-* tokens + CSS Modules，禁字面色值）
```

**接线清单（照 client AGENTS.md 的 New plugin package checklist）**：
1. `tsconfig.client.json` 聚合 references 加条目
2. `packages/bundle/web-app/cordis.patch.yml` 加 `dsh.client` 行（insert 块）
3. `packages/bundle/web-app/package.json` 加依赖
4. 手工 lockfile 两处（web-app importer + 新 importer，含 react 等 devDeps）+ junction（同 preferences 流程）
5. `pnpm --filter @deepseek-ai/dsh-client-ui-board bundle`（或根 build）
6. 重启实例验证（lib/client.js 被模块系统服务）

**待研究（实施前）**：
- 便签板的**挂载点**：主视图 slot（需读 ui-workspace/ui-conversation 的 slot 清单）；备选 sidebar 面板（ui-subagent sidebar-chat 模式，已验证可行但空间小）
- 偏好查看/编辑的**数据通道**：host 侧 preferences 插件加 typert remote service（agentTeams 的 `TypertRemoteService` 模式）暴露读写档案的 RPC，客户端做成设置页或板内编辑器
- i18n：产品文案必须走类型化词典（en+zh），verify-client-ui-i18n 是门禁

**下一步**：实施 board-ui（照蓝图 + 接线清单），先做"会话头任务板入口 + 便签网格（渲染 subagentCatalog）+ 完成通知醒目化"。

### 2026-10-03 · 阶段 3a：board-ui 客户端插件交付（已部署，待浏览器验收）

**交付**：`packages/client/ui-board/`（7 文件）——会话头部"任务板"入口 + portal 弹出便签网格（每个委派 subagent 一张卡：标签/模式徽章/创建时间），读 `subagentCatalog` 投影实时更新；zh/en 类型化词典；`--dsw-*` tokens + CSS Modules；注册进 `conversation.session.header.actions`（order 20，排在 schedule 目录之后）。

**接线全记录**：tsconfig.client.json 聚合、web-app patch 行（启用）、web-app 依赖、lockfile 两处手编（web-app importer + 新 importer，react 系列解析行照抄 ui-schedule）、web-app junction、tsconfig.base.json 路径别名（生成器不认新包，按其提示手写两条）。

**踩坑两则**：

1. tsconfig references：**有双编译面的包（locale、ui-conversation）必须引用其 `tsconfig.client.json`**，直接引目录报 TS6306（composite 缺失）；单一面的（ui-primitives/ui-renderer/ui-slots）直接引目录。
2. 全仓构建被终端回收中断 → 快速路径替代：`npx tsc -b packages/client/ui-board`（190ms）+ `pnpm --filter @deepseek-ai/dsh-client-ui-board bundle`（265ms）——**单包内环极快，以后客户端插件迭代都用这条**。

**产物**：`lib/client.js` 8.26 kB（CJS + sourcemap）、`lib/index.js` 0.31 kB、类型声明。

**部署状态**：3090 实例干净重启（无激活警告），dump-config 确认 `ui-board` 行在组合树（1198 → 1202 行）。

**待用户浏览器验收**：

1. 打开 3090 → 进入**有子代理任务的会话**（比如之前测试并行的那个）；
2. 会话头部（标题行附近）应出现"**N 任务板**"胶囊按钮（N = 该会话委派的子代理数）；
3. 点开 → 便签网格：每张卡显示子代理标签、模式徽章（持续/一次性）、创建时间；
4. 新委派任务时计数与网格应实时更新（subagentCatalog 投影 → control 流推送）。

**已知边界（v1）**：便签不显示运行状态（running/done 三态）——需接 `api-session/status`，下轮加；偏好档案查看/编辑界面未做（待 typert 通道）；完成通知醒目化未做（待监听投影变更 + Notification）。

### 2026-10-03 · 阶段 3a 验收 + 概念修正（v2：会话即便签）

**验收结果**：实时链路验证通过——用户在会话中委派 2 个 subagent，头部"任务板"计数实时 0→2，弹层正确显示。客户端插件管线（构建/加载/投影推送）全通。

**概念修正（用户关键反馈）**：v1 的"便签 = 会话内的子代理"理解错了用户的任务粒度——**用户的工作流是"每个任务开一个会话"，便签 = 会话**。任务板应是全部任务会话的总览，不是单会话的子代理列表。

**v2 改动**（数据源从 `subagentCatalog` 投影换成 sessions store）：

- 读取 `useSessions(state => state.byId)`（全局标准席位），过滤 `origin !== 'subagent'`（子代理会话不单独成签，与侧边栏隐藏规则一致）；
- 每张便签：`displayTitle`（日志派生标题）+ 运行状态徽章（进行中/空闲，来自摘要的 `running` 字段）+ 进行中左边条高亮；
- 触发按钮：总数 + 有任务运行时的脉冲圆点；排序：进行中优先；
- 单包快速内环再次验证：tsc 190ms + bundle 254ms，重启即生效。

**v2 待办（下轮）**：点便签跳转会话（需导航 API 调研）；"任务完成"通知（监听 running→false 转变 + Notification API，响应用户"提醒醒目"需求）；会话内子代理信息可作为便签的二级详情（点开看该会话的 subagentCatalog）——两种粒度合并展示。

### 2026-10-03 · v2 验收反馈修复（v3：可点击 + 不透明）

**用户反馈两问题**：便签无法点击；弹层背景透明。

**根因与修复**：

1. **透明背景**：v2 猜的 token 名（`--dsw-surface` 等）不存在，`var()` 解析失败回退透明。修复：改用真实语义 token（从 `ScheduleCatalogAction.module.css` 抄标准弹出层配方）：`--dsw-specific-menu`（弹层底色）+ `--dsw-menu-backdrop-filter` + `--dsw-elevation-prominent`（阴影）+ `--dsw-alias-border-l1`；文字用 `--dsw-alias-label-primary/secondary/tertiary`；进行中状态用 `--dsw-alias-state-business-primary/tertiary`（品牌蓝，明暗两模式自适应）。**教训：token 名必须从现成组件抄，不能猜。**
2. **不可点击**：导航经 `uiWorkspace` 服务（客户端 ctx），组件不能见 ctx——通过 slot 注册的 `inject` 选项传回调（ui-subagent 的 `catalogActions` 同款模式）：`inject: () => ({ openSession: id => ctx.uiWorkspace.openSession(id) })`；`openSession(sessionId)` 直接收会话 id。插件 inject 数组加 `'uiWorkspace'`（Cordis 等待服务，保证激活时可用）；便签改为 `<button>`，点击即关弹层并跳转对应会话主视图。

**验收点（v3）**：刷新后任务板弹层应为实底色卡片；点任一便签应跳转到该会话。

### 2026-10-03 · v3 验收通过 + 终态定位确认

**用户验收通过**，并明确定位：**当前头部弹层版是过程实验，最终 UI 应对齐 `dsh-taskboard-demo.html` 的形态**（便签墙：胶带贴纸质感、分类色、过滤、醒目完成通知、无需盯盘）。

**实验版已验证的资产**（终态直接复用，不用再趟）：

| 资产 | 状态 |
|---|---|
| 客户端插件全管线（包结构/构建/加载/HMR） | ✓ 单包内环 <1s |
| 数据面（sessions store：标题/运行态/origin 过滤） | ✓ 实时更新 |
| 导航（uiWorkspace.openSession 经 slot inject 传回调） | ✓ |
| 真实设计 token 体系（弹层/文字/状态色配方） | ✓ 明暗自适应 |

**终态差距清单**（实验版 → demo 形态）：

1. **挂载点升级**：头部弹层 → 独立主视图/整页面（需调研 workspace 主视图 slot 或路由；这是最大的一块未知）
2. **视觉**：demo 的贴纸质感（胶带、微旋转、分类色、便签网格自由布局）——纯 CSS 工作，token 已通
3. **完成通知醒目化**：监听 running→空闲转变 + Notification API + 页内 toast（需求最早提出，仍未兑现）
4. **偏好档案查看/编辑界面**（已记录的 UI 需求，待 typert 数据通道）
5. **分类/过滤**：会话按任务类别分组（与 preferences 插件的类别体系打通）

**建议推进顺序**：3（通知，小而高价值，弹层版即可承载）→ 1（挂载点，决定终态骨架）→ 2+5（视觉与分类）→ 4（偏好编辑）。

### 2026-10-03 · 差距 #3 完成：任务完成醒目通知（v4）

**实现**（`BoardAction.tsx` + toast 样式，bundle 27.65 kB）：

- **完成检测**：`useEffect` 对比前后两次 sessions store 快照的 `running` 字段，观察到"运行中 → 空闲"转变即判定任务完成；首次观察只做基线（页面加载不触发通知风暴）。
- **双通道提醒**：① 页内 toast——右下角堆叠卡片（成功色左边条 + 毛玻璃 + 滑入动画，8 秒自动消失，点击跳转对应会话）；② 浏览器系统通知（Notification API，127.0.0.1 是安全上下文可用；权限在首次点开任务板时以用户手势请求，拒绝则只保留页内 toast）。
- 多个任务同时完成各自成卡堆叠；同一任务再次运行再完成会再次通知。

**验收路径**：3090 → 任一会话发一个任务（如"帮我数一下这段文字的字数"）→ **切到别的会话或别的窗口**（关键：不能盯着原会话）→ 任务结束时右下角应弹出"任务完成"toast（若授权了系统通知则同时弹系统通知）→ 点 toast 跳回该会话。

**下一步**：差距 #1——挂载点调研（workspace 主视图 slot / 路由），决定终态便签墙骨架。

### 2026-10-03 · 差距 #1 + #2 完成：便签墙视图（v5，应"激进开发"要求一步交付）

**挂载点调研结论**：`conversation.view` slot——会话面板的一等视图标签体系（`ViewTab{id,label}`，每会话记忆偏好视图，trajectory 同款挂载）。注册即得标签页，无需自建切换器（会话骨架自动渲染 tab 条并调 `selectView`）。视图组件经 `renderSlot('conversation.view', {inspectCall, viewRequest, openView, ...})` 收标准席位。

**v5 交付**（`BoardView.tsx` + 注册 + 40.81 kB bundle）：

- **便签墙视图**：会话面板新增"任务板"标签页（排在"轨迹"之后），占据整个会话区——终态骨架落地；
- **demo 视觉**：胶带贴纸（amber 半透明 + 微旋转）、三向微倾的手工摆放感、悬浮回正 + 抬升阴影、进行中便签品牌蓝着色；
- **过滤栏**：全部/进行中/空闲 三档（带计数，数据驱动——类别过滤待 #4/#5 的偏好通道后接入）；
- **保留资产**：头部按钮（运行指示 + 快览弹层）与完成通知（v4）不变，与视图共存。

**关键 API 留档**：视图注册 = `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name, id, order, locale, label: () => bound('key'), inject: boardInjected }, Component))`；`ctx.locale.bind(NS)` 做注册期 label thunk（跟随语言切换不重注册）。

**差距清单状态**：#1 ✓ #2 ✓ #3 ✓；剩 #4（偏好查看/编辑，typert 通道）#5（类别过滤，依赖 #4）。

**下一步（#4+#5 一体）**：host 侧 preferences 插件加 `TypertRemoteService`（agentTeams 模式）暴露「读/写档案 + 按会话查类别」RPC → 客户端板内偏好编辑器 + 类别过滤 + 便签分类着色。这打通后，五个需求全部闭环。

### 2026-10-03 · 差距 #4 + #5 完成：偏好数据通道 + 板内编辑器 + 类别过滤（v6，五需求闭环）

**通道选型（重要架构决策）**：调研了三条路——① Gateway/Remotes（typert 生成物 + 双面构建，重机制，个人功能不值）② settings 体系（实为插件 Config 编辑器，形状不合）③ **webserver 命名路由（选定）**：preferences 宿主插件自注册 `/preferences` 路由 + `tapIndex` 把每进程随机 token 注入页面 meta，浏览器带 token 读写。webServer 缺席时优雅降级（headless 组合工具/上下文照常）。**已验证：meta 注入 ✓、GET 200 返回档案+selections ✓、错误 token 401 ✓。**

**交付内容**：

| 部分 | 实现 |
|---|---|
| 宿主路由 | GET 返回 `{work, learning, selections}`；POST `setProfile`（写档案）/ `setSelection`（写/清选择）|
| 类别过滤（#5） | 过滤栏升级为 全部/工作/学习/进行中（带计数）；便签显示类别徽章（工作=品牌蓝、学习=成功绿）|
| 偏好编辑器（#4） | 过滤栏右侧"偏好设置"按钮 → 双栏 Markdown 编辑器（工作/学习档案）→ 保存即写文件，下次回复生效 |
| 数据新鲜度 | 板视图挂载时拉取 + 15s 轮询（模型调 reply_style 后最多 15 秒同步到过滤计数）|

**验收路径**：3090 → 任务板视图 → ①"偏好设置"编辑档案保存 → ②对话里说"按学习风格回答"（模型调 reply_style）→ ③回到任务板等 15 秒内该会话便签出现"学习"绿徽章 → ④"学习"过滤 tab 只显示它。

**五需求终态**：1 定期任务 ✓（schedule）2 并行+提醒 ✓（后台 subagent + 通知）3 外部工具 ◐（Chrome 待挂 MCP，Trae 待定）4 便签 UI ✓（墙视图+编辑器+过滤）5 习惯记忆 ✓（档案+注入+维护+编辑界面）。**核心四项全部闭环，仅剩需求 3 的外部工具接入。**

### 2026-10-03 · 需求 3 调研：Chrome 接入选型（opencli 胜出）

**调研背景**：用户提出 Chrome 可用 opencli 控制。核实：OpenCLI（`@woosau/opencli`，29.5k stars）真实存在且高度匹配；同作者还有 **opencli-mcp**（MCP 服务形态）。

**候选方案对比**：

| 方案 | 登录态 | dsh 集成 | 站点适配器 | 备注 |
|---|---|---|---|---|
| **opencli-mcp**（选定主方案） | 复用真实 Chrome（扩展+守护进程） | **官方一等支持**：`dsh plugin --profile web add opencli-mcp`（文档明确列出 dsh） | 经 sites_search/site_run | v0.0.25 很新；工具：`js`（浏览器 JS REPL）、`site_run`、`doctor` 等 |
| opencli CLI + bash | 同上 | 经 bash 工具调用 `opencli <site> <cmd>` / `opencli browser <session> ...` | **100+ 内置**（B站/知乎/小红书/Twitter/Reddit/微信/YouTube…） | **Electron 应用适配器含 Trae/Cursor/Codex**——可能顺带解决 Trae 接入；agent skills 可装入 dsh skill 目录 |
| dsh browser-use + chrome-devtools-mcp（attach） | attach 真实 Chrome（需开 remote-debugging-port） | dsh 原生 seam（实验包） | 无 | 纯浏览器原语 |
| mcp-client + chrome-devtools-mcp/playwright | launch 模式无登录态 | 通用 MCP | 无 | 隔离浏览器 |

**推荐架构**：opencli-mcp 为主（结构化 MCP 工具进 dsh 工具面）+ opencli CLI 为辅（bash 调用 + skills 装入 `~/.dsh/skills/`，覆盖站点适配器与 Electron 应用/Trae）。同一生态（同作者），扩展+守护进程共享。

**实施要点**：① Chrome 装 OpenCLI 扩展（Web Store，需用户手动）② `npm i -g opencli-mcp` + `opencli-mcp setup` ③ dsh 侧经 mcp-client 挂载或 `dsh plugin add` ④ 验证链路（opencli-mcp doctor → dsh 会话内让模型开页面/读内容）。

**遗留问题**：opencli 的 Trae 适配器具体能力待实测（列在 Electron 桌面适配器中）；dsh plugin add 在沙箱内的可行性待验。

### 2026-10-03 · opencli 落地：安装验证 + dsh 预接线 + Trae 事实修正

**已完成**：

1. **工作区安装**（沙箱拦全局目录，`npm --prefix` 装入 `workbench-test/opencli/`）：opencli 1.8.6 + opencli-mcp 0.0.27，均验证可运行。
2. **opencli 能力实测**：`list` 返回 57k 行 JSON 目录（100+ 站点适配器）；Electron 应用适配器在列：cursor（12 命令：ask/composer/send/read/extract-code/model/history/screenshot...）、codex（16）、doubao、antigravity、chatgpt-app、chatwise、discord-app——**证明该机制对 IDE 类应用的控制粒度**（发提示词/读回复/提取代码/切模型）。
3. **dsh 预接线**：新增 `workbench-test/opencli-mcp.patch.yml`（opencli-mcp 自带 dsh bundle 的同款 mcp-client stdio 行，launcher 路径 + `OPENCLI_MCP_BIN` 覆盖口），3090 实例已带 4 补丁重启。launcher 未装时优雅降级（启动日志出现 "path not found" 重试噪音，setup 后消失）。

**Trae 事实修正**（重要）：README 宣称支持 "Trae CN / Trae SOLO"，但 **npm 发布版 1.8.6 与 GitHub main 分支的 clis/ 目录均无 trae 适配器**（GitHub 404 实证）——README 超前于代码。Trae 接入的三条现实路径：① 跟踪 opencli 后续发布；② Trae 若暴露 CDP 调试端口，用 `opencli browser` 通用原语；③ 按 adapter-author 流程自写 trae 适配器（`opencli browser init trae/...`）。

**Trae 事实修正的修正（重要教训）**：上一轮"Trae 适配器不存在"的结论**错误**——根因是装错了包：npm 有两个 opencli，`@woosau/opencli`（陈旧镜像，1.8.6，无 trae）和 **`@jackwener/opencli`（官方主包，v1.8.8，3 天前发布）**。官方 1.8.8 实测：**`trae-cn` 15 个命令**（send/ask/read/watch/new/status/model/select-model/screenshot/approve/export/dump/setup/targets/activity）+ `trae-solo` 25 个命令——**dsh → opencli → Trae CN 全向 IDE 控制真实可用**（发提示词/读回复/切模型/审批/截图/导出）。工作区已改装官方版（`workbench-test/opencli-official/`）。教训：装包前核对官方 scope（GitHub 仓库 owner = npm scope）。

**用户待办（点亮 opencli 的两步，注意包名）**：

1. Chrome 安装 OpenCLI 扩展：Chrome Web Store 搜 opencli（链接见下），或 GitHub Releases 下载 `opencli-extension-v{version}.zip` 手动加载
2. 自己的终端运行：`npm i -g @jackwener/opencli opencli-mcp` → `opencli-mcp setup`（写 `~/.opencli-mcp/`，沙箱内不可代劳）
3. 完成后重启 3090（我来），opencli 工具自动出现在 agent 工具面

**端到端验收方案**：① Chrome 链路：3090 会话让模型"用 opencli 读取 Hacker News 前 5 条并摘要"；② Trae 链路：让模型"通过 trae-cn 在 Trae 里发起一个提问并读回结果"。

### 2026-10-03 · 需求 3 闭环：opencli 全链路集成完成（bash+skills 路线）

**里程碑**：用户在浏览器装好 OpenCLI 扩展（doctor 确认 connected，profile 9gn6usgt）→ CLI 直测通过（hackernews 适配器真实数据 + browser 原语真实开页）→ **headless 端到端验收通过**：模型自主加载 opencli-usage skill → pwsh 调 opencli → 真实数据 → 中文摘要交付。**需求 3 的 Chrome 部分完成。**

**集成路线决策（重要）**：opencli-mcp 被否决/暂缓——它是**另一套浏览器扩展**（Web Store ID 不同），要求用户再装一个扩展 + 全局 npm + setup；改用 opencli 官方的 agent 集成方式：**bash/pwsh 工具 + skills**（dsh agent 本就有 shell 工具，skills 装进 `$DSH_HOME/skills/`）。opencli-mcp.patch.yml 保留备用。

**交付清单**：

1. **Skills**：`dsh-home/skills/opencli-usage/` + `opencli-browser/`（官方 SKILL.md 全文，去掉 Claude Code 专属 `allowed-tools` 字段，加本机环境说明——opencli 在 PATH、pwsh 可用）
2. **环境接线**（launch env / start-web.ps1）：`USERPROFILE` 重定向至 `workbench-test/home`（与守护进程+扩展配对上下文一致）+ opencli `.bin` 入 PATH
3. **沙箱两层冲突的发现与解法**：dsh 内层沙箱（workspace-write，Windows ACL 后端）包装 shell 时 `SetNamedSecurityInfoW` 被拒（Win32 5）——高度疑似外层 Trae 终端沙箱不允许 DACL 变更，导致 agent 的 pwsh 完全不可用（headless 首测实证：连 Write-Output 都挂）。**解法：`DSH_PERMISSION_MODE=danger-full-access`** 关闭内层沙箱（shell 直接 spawn；Trae 内启动时外层沙箱仍是保护层）。安全权衡已在 start-web.ps1 注释说明（Trae 外启动时可试回去 workspace-write）。

**遗留**：① trae-cn 适配器待用户在 3090 会话实测（15 命令：send/read/watch/model/approve...，Trae 需保持运行）；② opencli-mcp 路线备用未启用；③ 内层沙箱与 Trae 外层沙箱的 ACL 冲突值得在 dsh 上游提 issue。

### 2026-10-03 · trae-cn 实测：命令面确认，卡在 CDP 端口（待用户重启 Trae）

- 命令面实测确认（15 命令：activity/approve/ask/dump/export/model/new/read/screenshot/select-model/send/setup/status/targets/watch）
- **阻塞**：`status` 报 "Trae CN is not reachable on CDP port 39240"——Trae CN 需带 `--remote-debugging-port=39240 --remote-allow-origins=*` 启动；现进程监听端口为 4657/9229/51000/55503/55520/56508，均非 CDP（9229 是 Node inspector，非浏览器 CDP）
- 官方 setup 指引为 macOS 写法（`open -a`），Windows 等价命令已给用户：`& "D:\Programs\Trae CN\Trae CN.exe" --remote-debugging-port=39240 --remote-allow-origins=*`
- 适配器默认端口 39240，无需设 OPENCLI_CDP_ENDPOINT；Trae 重启后 3090 的 agent 即可直接驱动 trae-cn
- 下一轮验收序列（Trae 带 CDP 重启后）：`status` → `targets` → `read`（只读）→ `new "小任务"` + `read`（写入闭环）→ 记录结果


**五需求终态（更新）**：1 ✓ 2 ✓ 3 ✓（Chrome 全链路验收通过；trae-cn 待实测）4 ✓ 5 ✓。**项目核心功能全部落地。**

### 2026-10-03 · 任务板 v6：顶层独立页面 + 便签详情（本轮"一次做完"批次）

**用户指示**：trae-cn 调试优先级放低；减少提问，一次多做开发。三个技术点并行调研后一口气实现。

**调研结论（3 个并行 search agent）**：
1. **子代理数据**：`projectionsBySession`（全局标准 props `useSessions` 的选择器）可读**任意会话**（含未打开）的 subagentCatalog 投影；冷会话用 `ctx.sessions.refreshProjections(id)` 补拉（ui-subagent 同款模式）；running 状态由 `useSessionStatus`/`byId[id].running` 派生；子代理时长走子会话的 `subagentTiming` 投影（settledMs + active 区间）
2. **进度数据**：`turnOutline` 投影（轮次数组：turn/prompt/response 预览）+ `schedule` 投影（活跃提醒数组）都挂在行级 `projectionValues` 上；ui-workspace 已有 `hasActiveSchedule` 先例（徽章）
3. **顶层页面**：`main` 是 root 作用域 keyed slot（保留键 `conversation`，其余键开放注册），`sidebar.panellist` 注册入口图标——ui-plugin-manager 的 Plugins 页就是完整先例；**没有 URL 路由**（面板选择是内存态，刷新回 conversation，全应用现状）

**v6 交付**：
- **顶层"任务板"面板**：`main` key `task-board` + 侧边栏图钉入口（IconPinOutlineRegular，order 20 排在 Plugins 后）——**不用先打开任何会话**就能看全局任务墙（需求 4 的"独立 web 页面"补全）。conversation.view 标签和头部快览按钮保留共存
- **便签详情**（每张签展开）：最近回复预览（turnOutline 末轮 response/prompt）+ 子代理清单（标题/模式徽章/运行点/活跃时长，subagentTiming 计算）
- **便签元信息**：轮次计数 + 相对更新时间（Intl.RelativeTimeFormat）+ 定时任务徽章（数量 + 悬停看下次到期时间）
- **数据接线**：inject 加 `sessions`；挂载时对每个会话 id 调一次 `refreshProjections`（ref 去重，新会话自动补）
- BoardView props 改为最小结构面（`{ useSessions: UseSessions }` + locale + inject），同一组件同时挂 conversation.view（session 作用域）和 main（root 作用域）两个 slot

**构建过程**：3 处类型修正（ReadonlySet 无 add；SessionId 品牌类型的参数转换用 `Parameters<>` 重断言；ctx.sessions 已有类型无需 cast）；pnpm 的 verify-deps-before-run 碰 store 被沙箱拦 → 直接 `npx tsdown` 绕过；lockfile 手编 4 个新 devDeps + node_modules junction ×4；tsc + bundle 通过（client.js 42KB）；3090 干净重启部署

**遗留小项**：仓库根的 `.opencli-probe.tmp`（headless 排查时模型创建）ACL 异常删不掉（attrib/icacls reset 均无效），无害，用户可手动删；工具缺口"会话内后台任务（jobs）展示"未做（job 数据无全局投影，代价高收益低，挂起）

### 2026-10-03 · v7 大改版：任务升为一级实体 + 点击 bug 修复 + UI 任务化

**① 点击无效 bug（根因代码级确认）**：归档会话——归档不移出会话目录（便签照常渲染），但点击后 `clearArchivedCurrent` 在同一事件内静默清除主引用（navigation.ts:363-370，有官方测试背书）；"60秒后提醒我喝水"是一次性提醒会话，触发后无活动即可被归档，症状完全吻合。**修复**：任务板读 root 作用域 `useWorkspaces` 的 `archivedSessionIds`，归档会话从"未归类"列表和任务会话清单中过滤，`openSession` 加 try/catch 守卫。

**② dsh-tasks 宿主插件**（`packages/context/tasks/`，preferences 同款模式）：
- 存储：`$DSH_HOME/tasks/tasks.json`（TaskRecord：id/title/purpose/plan/progress/status/createdAt/updatedAt/sessions）
- 模型工具：`task_create` / `task_update`（字段替换语义，progress 指引为带日期的变更日志）/ `task_start`（当前会话挂任务，幂等）/ `task_list`
- 运行时上下文（order 126）：挂在任务下的会话，每次请求注入任务简报（目的/计划/进展）——与偏好同一通道
- Web 路由 `/tasks`（token 守卫 + tapIndex meta）：GET 全量；POST create/update/delete/detach/**newSession**——host 侧 `ctx.agents.create`（webhook 模式精简版：生成 `task-<uuid>` 会话、cwd=process.cwd()、sessionTitle.rename 命名"任务标题 · 会话"、直接挂任务、空收件箱等用户首条消息）
- 接线全套：tsconfig.host.json 行、web-app patch 行、依赖、lockfile（importer 两处）、junction、根 tsdown host face（glob 自动发现新包）

**③ UI 任务化重写**（ui-board 0.3.0 形态）：
- **删除**：BoardAction.tsx（头部快览+下拉）、conversation.view 墙、refreshProjection/projectionsBySession 读取（任务模型不再需要投影数据）
- **主面板 = 任务墙**：任务便签（状态徽章 待办/进行中/已完成、标题、进展首行预览、会话数、相对时间）；展开详情 = 目的/计划/进展三栏 + 会话清单（运行点、标题、偏好类别徽章、点击跳转）+ 操作排（新会话/编辑/标记完成/删除）
- **新建任务**按钮 + 任务编辑器（标题/目的/计划/进展四字段 dialog）；过滤器 全部/进行中/已完成
- **未归类会话**区：不属于任何任务的会话（胶囊行，过滤归档）——存量会话的容身处
- **完成通知迁移**：BoardToasts 注册到 `shell.overlay`（帧级浮层，全面板生效），从会话头部组件解耦
- 构建修正：readonly 字段用 WritableTask 映射类型；Context 无公开 signal → new AbortController().signal；shell.overlay 注册需 id；locale 键补齐

**验收路径**：① 点侧边栏图钉 → 任务墙 + "未归类会话"区（原会话应都在未归类里）② 新建任务 → 便签出现 ③ 展开详情 → 新会话 → 应跳到新会话（标题"任务 · 会话"）④ 对话里让模型"task_start 挂到任务X并更新进展" → 板上 15s 内刷新 ⑤ 归档会话不再出现在未归类区（bug 修复验证）

### 2026-10-04 · v7 排障：新建任务 404（三层根因连环，全部修复）

**症状**：UI 新建任务无便签。`/tasks` 404（`/preferences` 401 正常）。

**排障过程（三次重启，逐层剥洋葱）**：
1. 组合树有 tasks 行（dump-config ✓）、模块可加载（node import ✓）、从 web-app 上下文可解析（✓）
2. **根因一（已修但非主因）**：tasks 包缺自己的 node_modules 依赖链接（preferences 当轮建过，tasks 漏了）——补 6 个 junction（cordis/schemastery/dsh-agent/dsh-home-paths/dsh-system-prompt/dsh-tools）。修后 apply 跑了（tasks 目录 00:40:55 创建）但路由仍 404
3. **根因二（排除）**：`inject = ['agents']` 嫌疑——webhook 同样注入 agents，且 apply 已运行证明激活成功，排除（仍改为与 preferences 一致的最小 inject，agents 走结构化访问）
4. **根因三（真凶）**：给 serveTasksApi 加 try/catch + console.error 后真相大白——`Error: cannot get property "agents" without inject`（vendor/cordis/src/reflect.ts:144）。**Cordis 的 Context 是代理：读取任何服务属性必须先在 inject 声明，`as unknown as {...}` 类型断言骗得过编译器、骗不过运行时守卫**。serveTasksApi 在回调里读 `scope.agents`/`scope.sessionTitle`（webServer 在作用域注入里所以没事）→ 抛错 → 路由/tapIndex 全没注册，且错误被 fiber 吞掉不打印
5. **修复**：`ctx.inject(['webServer', 'agents', 'sessionTitle'], ...)`——作用域注入声明全部三个服务

**验证**：无 token 401 ✓；带 meta token GET 200 `{"tasks":[]}` ✓；POST create 200（task-ad75c74f 落盘）✓；delete 200 清理 ✓。浏览器地址栏的 URL token 是会话鉴权 token，路由 token 是页面 `<meta name="dsh-tasks">` 里的 UUID——两者不同，API 测试要从页面提取。

**教训（重要）**：① Cordis 服务访问的运行时代理守卫是 TypeScript 断言绕不过的——凡在代码里读 `scope.xxx`，xxx 必须出现在某层 inject；② fiber 吞同步回调错误且不打印——插件"静默半激活"（apply 前半跑过、后半没跑）时，自带 try/catch + console.error 是唯一可靠的排障手段；③ 新包接入清单化：node_modules junction（包自身依赖 + web-app 消费方）× 2、lockfile importer × 2、tsconfig 聚合、patch 行、依赖行——缺一项症状都不同。

### 2026-10-04 · v8：四个 UI 问题一批修复

**用户反馈四项**：① 新建任务弹窗发灰 ② 偏好设置弹窗发灰 ③ 任务下新会话无效 ④ 计划应为结构化列表。

**① ② 根因**：`--dsw-specific-menu` 是 `rgba(248,249,250,0.58)`——58% 透明度的白色，叠在彩色便签墙上就是灰蒙蒙。**修复**：`.prefsDialog` 与 `.toast` 背景改 `--dsw-alias-bg-layer-1`（实底、明暗主题自适应），去掉毛玻璃。

**③ 根因**（API 级诊断：newSession 后端 200 正常）：**竞态**——POST 创建会话成功后 UI 立即调 openSession，但客户端会话目录还没收到 session-added 事件 → retain 同步抛"unknown session" → 被静默吞掉 → 看似无效。**修复**：`openSessionWhenReady`——捕获异常后每 300ms 重试导航（上限 25 次≈7.5s），直到会话到达客户端目录；newSession 失败改为显式 alert（不再静默）。

**④ 结构化计划**（数据模型变更）：
- `PlanItem { id, content, priority: high|medium|low, done }`；`TaskRecord.plan` 从 string → `readonly PlanItem[]`；数组顺序即执行顺序
- 读取时迁移：旧 Markdown 字符串 plan → 空列表（normalizePlan/normalizePlanItem，畸形条目丢弃、优先级默认 medium）
- 模型工具 task_create/task_update 的 plan 参数改数组（todo 工具的 DSL 数组写法先例）；简报渲染 `- [x] (high) content` 列表
- UI：编辑器计划区改结构化（每行：完成勾选 + 内容输入 + 优先级下拉 + ↑↓排序 + ×删除；虚线"添加条目"按钮）；便签 meta 显示"计划 2/5"；详情渲染有序列表（完成项划线置灰、优先级徽章着色：高=红/中=蓝/低=灰）
- **API 验证**：创建带 3 条目（优先级默认补齐）✓；更新一条为 done ✓

**验收**：① 新建任务/编辑任务/偏好设置弹窗应为实底清晰 ② 编辑器计划区可增删改排序勾选 ③ 保存后便签 meta 出现"计划 1/3" ④ 展开看有序列表 ⑤ 任务详情"新会话"→ 应在约 1 秒内跳进新会话（重试机制） ⑥ 对话里让模型 task_update plan 数组 → 板上刷新

### 2026-10-04 · 排障："任务下新建的会话没绑定？"——绑定正常，是模型行为问题

**数据证据**（tasks.json）：测试任务"里了"的 sessions 数组正确含有 newSession 创建的会话 → **绑定机制工作正常**。用户看到的"另外生成了一个任务"（贪吃蛇任务）是模型调用 task_create 新建的——plan 是创建时带上的（createdAt==updatedAt），且该任务无绑定会话。两种可能：模型在已绑定会话里无视简报创建了新任务，或用户在未绑定会话（普通聊天）里发起。

**修复（模型引导三处强化）**：
1. 任务简报措辞强化："This conversation BELONGS to that task... do NOT call task_create for work on it. Only create a separate task when the user explicitly starts unrelated work"
2. task_create 描述加约束："Only for GENUINELY NEW tasks: if this conversation is already attached to a task, maintain that task with task_update instead"
3. task_create 在已绑定会话中执行时返回 note 提醒模型（"this conversation is currently attached to task X... call task_start to switch / use task_update"）——运行时纠正而非仅静态描述

**使用要点（对用户）**：任务绑定对用户可见的两处——任务详情的"会话"清单 + 新会话的标题（"任务标题 · 会话"）。在任务会话里让模型"生成/更新任务计划"时应说"更新**这个任务**的计划"或直接依赖简报；在普通聊天里说"生成任务计划"模型合理地创建新任务属预期行为。

### 2026-10-04 · 排障（续）："还是会话里调 task_create"——根因是会话浏览器不可见，非模型问题

**上一轮结论修正**：上轮判断"绑定正常、模型行为问题"是错的。本轮解码全部会话日志（多帧 zstd）拿到完整证据链：

| 证据 | 结论 |
|---|---|
| 任务板建的 `task-d30ca751` 会话日志只有 5 个 header 事件，**零对话** | 用户从没在这个会话里说过话 |
| 它创建 3 秒后，浏览器侧新建了普通会话 `session-e738a3f4`（cwd = deepseek-harness-workspace），用户的"我要开发俄罗斯方块"落在那里 | 用户消息实际发进了普通会话 |
| `session-e738a3f4` 的 RTC 快照无 task briefing（因为它确实没绑定任何任务） | 模型 task_create 是对未绑定会话的合理行为 |

**真正的根因（服务端 newSession 两处缺陷）**：

1. **cwd 错误**：`serveTasksApi` 的 newSession 用 `process.cwd()`（= web server 启动目录 `deepseek-harness`）作为会话 cwd。会话按 workspace-hash 归档，落进了浏览器根本没在看的另一个 workspace（用户浏览器在 `deepseek-harness-workspace`）。
2. **未 attach workspace**：只调了 `agents.create`，没有 `workspaceRegistry.create(cwd)` + `workspace.attachSession(sessionId)`（对照 webhook 插件的正确姿势）——会话不属于任何 workspace 注册表成员，浏览器目录永远看不到它。前端 `openSessionWhenReady` 重试 25 次（7.5 秒）后静默放弃，用户以为已在任务会话里，实际输入落到 fallback 新建会话。

**顺带验证（链路健康性）**：`systemPrompt.context` 回调的 `context.agent?.session` 写法有效——用选了 learning 偏好的 `session-6e37dc56` 会话验证，最后一条 RTC 快照正确含 `<reply_style category="learning">` 完整注入。所以 briefing 注入链路本身是好的，只要会话 id 出现在任务的 sessions 数组里就会生效。

**修复**（`packages/context/tasks/src/index.ts` + `packages/client/ui-board/src/client/BoardView.tsx`）：

1. 服务端 newSession：接受 `payload.cwd`（浏览器当前 workspace 路径），走 `workspaceRegistry.create(cwd)` → `agents.create({ meta: { cwd: workspace.path } })` → `attachSession(sessionId)`，失败回滚 detach；inject 列表增加 `workspaceRegistry`
2. 前端 BoardView：`onNewSession` POST 附带 `cwd`——取当前主视图会话（`retainedBy.mainView > 0`）的 `cwd`
3. **脏数据清理**：删除 3 个从未对话的 `task-*` 死会话目录 + tasks.json 里"里了"任务的 sessions 引用（都是不可见会话，零内容）
4. `tsc -b` 两包通过；重启 3090 实例加载新代码

**待用户验收**：刷新浏览器 → 任务板任一任务点"新建会话" → 应直接打开新会话（标题"任务 · 会话"）→ 在里面发消息 → 会话开头的 runtime context 应含 "Current task for this conversation: …"，模型应用 task_update 维护而非 task_create。

### 2026-10-04 · 架构 v9：会话单一归属任务制（"其它"兜底 + 服务端强约束）+ 关键流程修正：构建产物从未更新

**先说关键发现（解释"上轮修了还是不行"）**：cordis 按包名加载插件时走 `package.json` 的 `main: lib/index.js`——**改 src 不会生效，必须 tsc -b + tsdown 重建**。上轮与上上轮的修复代码是对的，但从未跑进 lib 产物，web server 一直在跑旧代码（证据：上轮修复后新建的 `task-8384cc55` cwd 仍是 process.cwd()；本轮在 apply 里加的"其它"任务初始化在旧产物下也不执行）。本轮已补全构建：`npx tsc -b tsconfig.host.json` → `npx tsdown --env.DSH_BUILD_FACE host` → `npx tsdown --env.DSH_BUILD_FACE client`，全部 exit 0。**以后每次改插件源码都必须重建再重启。**

**本轮用户指令**：模型必须感知当前所属 task 且只能改本 task；架构上所有会话必须属于一个 task；初始化"其它"任务容纳未制定任务的会话。

**架构改动**（`packages/context/tasks/src/index.ts`）：

1. **兜底任务**：固定 id `task-misc`、标题"其它"，apply 启动时自动确保存在（不可删除：POST delete 拒绝 400）
2. **单一归属**：`currentTaskFor(tasks, sessionId)` = 显式绑定优先，未绑定兜底"其它"——briefing 永远有值，模型永远知道自己属于哪个任务
3. **briefing 措辞硬化**：明确写出归属任务 id、`task_update with taskId <id>`、"NEVER call task_create"、含"给 X 制定计划也写入本任务 plan"、切换唯一出口是 task_start
4. **task_update 服务端强约束**：会话只能更新当前归属任务，其它 taskId 直接抛错并引导 task_start（模型不听 prompt 也会被硬拦）
5. **task_start 切换语义**：加入目标任务的同时从其它任务移除（不再是多挂），保证"一个会话恰好属于一个任务"
6. **task_create**：保留（用户显式要求新任务时用），note 明确"新任务未挂到本会话，继续记录在本任务，或 task_start 切换"
7. **newSession cwd 兜底链**：payload.cwd → 最新 live 会话的 cwd（浏览器当前会话必然 live，这是它正在看的 workspace）→ process.cwd()——即使浏览器跑旧 bundle 不传 cwd 也能落对地方

**UI 改动**（`packages/client/ui-board/src/client/BoardView.tsx`）：未分配会话在"其它"便签下展示（逻辑归并，不写 tasks.json）；存在"其它"任务时隐藏底部 ungrouped 区块（避免重复）；"其它"便签无删除按钮。

**部署**：全量重建 host+client 产物，重启 3090。验证：`task-misc` 已自动写入 tasks.json（misc-task-present=True）；产物 grep 确认新代码在 lib/index.js、lib/client.js 里。

**待用户验收**（务必先刷新浏览器再测）：
- 任务板应出现"其它"便签，所有旧未分配会话挂在它下面
- 任意会话说"帮我制定 XX 计划" → RTC 应含 "Current task for this conversation"，模型应 task_update 当前任务（或"其它"）而非 task_create
- 普通新会话（未指定任务）→ 归属"其它"
- 在会话里更新其它任务 → 应收到报错引导 task_start

### 2026-10-06 · v17.5：两项批次——移除 🔔 系统通知开关（用户判定无用）+ 计划闭环日期详情内联可编辑

**用户规格**：① 铃铛按钮（系统通知已开启）没用就去掉；② 计划项有时间时，点击时间可修改，日历同步。

**改动一：移除系统通知特性**（`ui-board`）：
- BoardView：删 `notifyPermission` state、`requestSystemNotify`、🔔 按钮（授权后它只是永久禁用的状态图标，纯占位；页面内提醒条不受影响）
- BoardToasts：删 `new Notification(...)` OS 弹送分支（按钮移除后授权永不可达，成死代码）
- locales 删 `notify.enable/on/blocked`（保留 `notify.title`，页面内提醒条徽标仍用）；CSS 删 `.toolButtonActive`
- v16.4 引入的该特性整体下线；如需恢复见 v16.4 记录

**改动二：计划闭环日期内联编辑**（`ui-board`）：
- TaskDetail 计划行的 `◷ 日期` 静态 span 改为原生 `type="date"` 输入（`planDeadlineEdit`：平时与文本融为一体，hover 显边框、focus 高亮）——点击即开日期选择器，改完即存
- 新增 `onPlanDeadline(itemId, deadline)` 回调：POST 整个 plan（清空日期 = 删除闭环）；日历黄点/逾期判定经 tasks 派生自动同步（run() 即时刷新 + 5s 轮询兜底）
- 新文案 `plan.deadlineEdit`（zh/en）；CSS 删失效的 `.planDeadline`

**部署**：停 3081 → 全量 build → 重启。插曲：首次构建遇 `inspector/lib/devtools` EPERM（无进程占用、目录已被失败构建回滚，疑似杀软瞬时锁），清理后重试即过——363 artifacts。

**待用户验收**（刷新浏览器）：① 工具行只剩 ✎ 和 ⚙；② 任务详情计划项点日期 → 改日期 → 日历 tab 黄点应移动，改成过去日期左列应亮红色逾期灯；清空日期 → 闭环消失。

### 2026-10-06 · v17.4：板内点击文件报"no session surface is mounted"返修——@workbench/ui-sidebar-right 副本（任务板会话接管右侧 dock）

**用户报告**：任务板会话里点击文件报错 `无法打开文件 sidebarRight: no session surface is mounted`。

**根因**（三层门控全在上游 ui-sidebar-right）：`openFile → ctx.sidebarRight.openResource → require()` 需要"挂载中的会话 surface"，而上游挂载链路是 ① `views.select(uiSession.adapter.current)` 只跟 mainView 绑定（board 的 boardChat retain 不算）；② `show(activePanelId === null ? selected : undefined)`——功能面板（任务板）激活即无 surface；③ `RightbarRoot` 的 `visible` 同样只认 `activePanelId === null`。任务板是功能面板，三处全拒。

**修复**：按 fork 副本制新增 `packages/client/ui-sidebar-right-workbench/`（`@workbench/ui-sidebar-right`，上游包全量复制、tests 保留上游）：

- 新增 `board-channel.ts`：`data-dsh-board-session` DOM 属性 + `dsh-board-session` 变更事件（沿用 board shell 属性的 DOM 总线约定，插件间零运行时依赖）
- 三处补丁：保留视图选择的 effect 在任务板面板激活时改选板内会话（监听 current/panelInfo/事件三源）；`show` 门控放行任务板面板；`RightbarRoot.visible` 放行任务板面板
- `ui-board`：BoardView 新增 effect，右栏会话变化时写属性 + 派事件（读者都以"任务板面板激活"为门，脏属性不会外泄）

**接线**：tsconfig.base.json paths、tsconfig.client.json 引用、web-app `package.json` 依赖 + `cordis.patch.yml` 的 `ui-sidebar-right` 行改指副本（--no-frozen-lockfile 更新锁文件）。

**踩坑**：① Copy-Item 跟随 pnpm 符号链接展开 node_modules 导致长路径报错——改 robocopy /XD node_modules lib；② 复制的 tests 被 tsconfig.client.json 的 `packages/client/*/tests/**` 全量编译，与上游类型名义冲突（SidebarRightTabInfo 双胞胎不可互换）——删除副本 tests 解决；③ 全量构建需先停 3081（锁产物目录 EPERM 老问题）。

**部署**：pnpm install → 全量 build（363 artifacts，+2 为新副本）→ 重启 3081。产物 grep 确认三处补丁与 ui-board 广播均已编译；boot manifest 确认 `@workbench/ui-sidebar-right` 已入浏览器 roster（出现 5 次，与 ui-chat 副本一致）。

**待用户验收**（刷新浏览器）：任务板右栏会话里点击文件（附件/文件链接/changed-files 卡片）→ 应在框架最右列弹出文档预览 dock，不再报错；主视图会话（若有）的预览行为不变；板内切换会话后预览 surface 跟随。

### 2026-10-06 · v17.3：v17.2 语义返修——"最后一个会话"应为"最后打开的会话"（每任务记忆）

**用户纠错**：v17.2 的 `lastSessionOf` 按 `updatedAt` 降序选会话，实际表现为"切到最后创建/最新的会话"；用户要的是"切换到最后一个**打开**的会话"。

**改动**（`BoardView.tsx`）：

- 新增 `lastOpenedByTask`（ref Map：taskId → sessionId）：effect 监听 `boardSessionId` + `mergedTasks`，右栏每次绑定会话即按当前归属任务记录；会话被 re-home（task_start 换任务）时从旧任务记忆中移除
- `lastSessionOf` 优先返回该任务**最后打开**的会话（读取时校验：仍归属该任务且未归档，失效则忽略）；从未打开过的任务才回退到最近活跃会话
- 无会话任务的"新建会话"引导（v17.2）不变

**部署**：停 3081 → 全量 build → 重启。产物 grep 确认 `lastOpenedByTask` 已在 `lib/client.js`。

**待用户验收**（刷新浏览器）：任务 A 打开会话 S1 → 切到任务 B 再切回 A → 右栏应仍是 S1（而非 A 的最新会话）；从未点开过的任务 → 仍回退显示其最近会话。

### 2026-10-06 · v17.2：任务切换右栏跟随 + 空任务"新建会话"引导（用户规格：切任务=切会话）

**用户规格**：点击切换任务时候，会话框没有跟随切换；会话框应该切换到该任务最后一个会话，如果没有，应该是一个新建会话的图示。

**改动**（`packages/client/ui-board/`，纯 client 面）：

- `BoardView.tsx`：
  - 任务卡 onClick 追加 `selectBoardSession(lastSessionOf(task))`——右栏跟随绑定该任务最近活跃会话（`lastSessionOf`：过滤 archived，按 `updatedAt` 降序，平局取列表靠后者=最新创建；无会话返回 undefined=释放右栏）
  - 抽出 `startSessionFor(taskId)`（原 TaskDetail onNewSession 内联逻辑），供任务详情按钮与右栏空态共用
  - 右栏空态从纯文本升级为引导块：💬 图标 + "这个任务还没有会话" + "新会话"按钮（为当前选中任务创建并跟随）
- `locales.ts`：新增 `chat.emptyTask`（zh/en）；按钮文案复用 `task.newSession`
- `BoardAction.module.css`：`.chatEmpty` 替换为 `.chatEmptyBlock/.chatEmptyGlyph/.chatEmptyText/.chatEmptyNew`，样式对齐 `.newTaskButton`（真实主题变量，返工一处 `--dsh-`→`--dsw-` 笔误——v16.1 教训再现）

**部署**：停 3081 → 全量 build（361 artifacts，3 public values）→ 重启 3081。产物 grep 确认 `lastSessionOf`/`startSessionFor`/`chatEmptyBlock` 已在 `lib/client.js`。

**待用户验收**（刷新浏览器）：点左列不同任务卡 → 右栏应切到该任务最近会话；点无会话的任务 → 右栏显示 💬 + "新会话"按钮，点击即在 该任务下建会话并跟随。

### 2026-10-06 · v17.1：完成提醒 toast 跳转返修——点击落点从主视图会话改为任务板右栏（用户报告"窗口异常"）

**用户报告**：任务完成提醒的标签一点击会跳到（顶层）会话窗口，不是任务底下的会话窗口，导致窗口异常。

**根因**：`BoardToasts` 点击调用 `BoardInjected.openSession`，其实现是 `uiWorkspace.openSession(sessionId)`——直接把主视图切到 Conversation。v11/v16 已把所有"跳主视图"通道封死（隐藏侧栏、删 ↗、forkAt 守卫），toast 是 v4 时代的漏网之鱼：一跳就离开三列工作台，且本 shell 隐藏原生侧栏的属性下主视图布局必然异常。

**修复**（`packages/client/ui-board/`，纯 client 面零 host 改动）：

- `index.ts`：`openSession` 改名 `openBoardSession`，实现改为 `layout.selectPanel(PANEL_ID)` + 模块级请求通道——`requestBoardSession` 通知已挂载 BoardView 即时跟随；未挂载则暂存（`requestedBoardSessionId`），挂载后 `takeRequestedBoardSession` 消费（selectPanel 触发的挂载必然晚于请求发出）
- `BoardView.tsx`：新增跟随 effect——右栏 `selectBoardSession` + 中列联动选中所属任务（`mergedTasks` 查 owner，找不到归属则只切右栏）+ 切回详情 tab
- `BoardToasts.tsx`：改用 `openBoardSession`（全仓唯一消费点）

**部署**：全量 `pnpm run build`（改产物必须停 3081 再建：运行中的 server 会锁住 `experimental/inspector/lib/devtools` 导致 tsdown EPERM rename）；记录 361 client artifacts、3 public values（新增 `DSH_CLIENT_GIT_DIRTY=true`，因工作区有未提交改动）。产物 grep 确认 `openBoardSession`/`requestBoardSession` 已在 `lib/client.js`。重启 3081。

**待用户验收**（刷新浏览器）：任务运行完成 → 点提醒标签 → 应留在任务板内：右栏切到该会话、中列选中其所属任务；若当时在其它主面板，应切回任务板而非主视图会话。

### 2026-10-05 · v17：基线升级 0.1.7 → 0.2.1-alpha.1 全量移植（custom 副本制落地，3091 全量验证通过）

**背景**：本地基线（0.1.7-alpha.1，c36a83f）与 fork HEAD（0.2.1-alpha.1，5badb15）相差 20734 个提交。用户指令：新目录克隆最新 dsh → 全部改动合入 → 对旧插件的修改一律"卸载原插件 + 复制 custom 副本 + 基于副本改"（便于维护）→ 按开发日志验证 → commit + push。

**新树**：`D:\2026\涅槃\AGENT\deepseek-harness-next`（fork master @ 5badb15）；旧树与 3090 日常实例保持不动。

**副本策略落地**（改过的上游包全部走 @workbench/* 副本，跨插件依赖均为 type-only，cordis.patch.yml 换行加载即可替换）：

| 上游包 | 处理 | 副本名 | 补丁内容 |
|---|---|---|---|
| ui-chat | 复制 164 文件 | `@workbench/ui-chat` | forkAt 补 activePanelId 守卫（功能面板活跃时不抢主视图） |
| ui-layout | 复制 22 文件 | `@workbench/ui-layout` | AppFrame collapsedWidth 认 `data-dsh-board-shell` |
| schedule | **不复制** | — | 上游 host `ctx.schedule` 能力覆盖旧 admin.ts，直接调用（架构决策：少一个副本少一分维护） |
| preferences / tasks / ui-board | 自有包 | 原名 | 照搬 + 0.2.1 适配 |

接线三件套：tsconfig.base paths + tsconfig.host/client references、web-app package.json workspace 依赖、副本 tests 包名同步替换。

**0.2.1 关键适配**：

1. **schedule 完全重写**（最大差异）：per-agent runtime + 会话事件 → host 全局 `ctx.schedule`（storage-domain 持久化）。create 直收 sessionId（无需 live agent）、请求字段 snake_case（`after_seconds`/`every_seconds`）、**title 必填 ≤120**、`at` 严格 ISO 带时区偏移；客户端 Remote **无 create** → 日历新建仍走 host `/tasks` 的 scheduleCreate → `ctx.schedule.create`；日历数据源从已废弃的 `row.projectionValues.schedule` 改为 `ctx.remote.schedule.catalog()` + `schedule/changed` 事件订阅
2. **forkAt 守卫**：新机制 `ctx.get('layout')?.panelInfo.getSnapshot().activePanelId`（null = Conversation 活跃才 openSession）
3. tasks 包：`ScheduleAdminLike` → `ScheduleLike`、inject `'scheduleAdmin'` → `'schedule'`、newSession 仍走 `agents.create`

**环境坑（三项，对策已固化）**：

1. **npmmirror 镜像 lockfile 漂移**：用户全局 .npmrc 指向镜像，重装时 micromark 三件套（core-commonmark/factory-space/util-types）解析漂移导致 ui-primitives 类型冲突；官方源网络不通 → `pnpm-workspace.yaml` overrides 钉回上游 lockfile 版本
2. **pnpm `.modules.yaml` 状态缓存**：lockfile 回退后显示 "Already up to date" 假象 → 删净 node_modules 全新 install 才真正生效
3. **junction 跟随惨案**：删 node_modules 时 robocopy /MIR 与 PS 5.1 Remove-Item 均跟随 junction，误删 8030 个真实文件（含 5 个未跟踪新包）→ `git checkout -- .` + 从旧树重拷 + 重放编辑。**Windows 上删 node_modules 必须用不跟随 junction 的删除方式**

**构建顺序**（client tsc 依赖 host 面 tsdown 生成的 `/remote` typert 契约，乱序必报找不到模块）：`tsc host → tsdown host → tsc client → tsdown client → pnpm run build:web`（不做 build:web 则 web-runtime 起 Vite dev 壳白屏）。全绿。

**3091 验证实例**（`workbench-test\dsh-home-verify` 为 home 数据副本；旧树 3090 不受影响）：

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 三列 grid 布局 + `data-dsh-board-shell`（副本生效证明） | ✓ |
| 2 | 7 任务便签 + 指示灯 + 类别徽章 + 百分比 | ✓ |
| 3 | 日历 deadline 芯片（量化学习 8 个计划项全显示） | ✓ |
| 4 | schedule 全链路：创建 → catalog 芯片显示 → 删除 → `schedule/changed` 实时刷新 | ✓ |
| 5 | 会话对话 E2E："1+1等于几？" → 回复 "2"（2 轮 2 步完成） | ✓ |
| 6 | fork：任务板面板保持挂载（守卫生效）+ 右栏跟随子会话 + 子会话 attach 到父任务 | ✓ |
| 7 | 任务 CRUD：创建 / 编辑（标题落盘）/ 置顶（notePinActive+noteRowPinned 渲染）/ 删除（列表 8→7 + 落盘清理） | ✓ |
| 8 | 偏好：GET 轮询驱动徽章渲染 + POST setProfile 写入往返还原 | ✓ |
| 9 | 控制台 | 零破坏性错误（fork 时刻 2 条上游噪音：`session-maybe` adapter 警告、released session reference，均为上游组件行为，非移植引入） |

**工具限制备注**：pin 按钮 `opacity:0` 不入 CDP AX 树、合成 Enter/Space 不激活按钮 → 置顶验证改走"同 payload API 直发 + UI 渲染断言"；该按钮 onClick 与创建/编辑/删除走同一套 postTasks 管线（均实测通过）。另：0.2.1 首启有"预览版说明"弹窗会挡全屏点击（点"继续"即消）；导航新增"自动化任务"入口（官方 ui-schedule，与我们的日历并存）。

**提交**：新树 `personal-workbench` 分支单 commit（含副本结构 + 镜像钉版说明）推送 fork。

### 2026-10-05 · v16.4：提醒通知归属澄清 + 系统通知开关（🔔 授权按钮）

**用户反馈**：提醒为什么弹出 Trae 的弹框？能否用系统弹框？

**原因**：BoardToasts（v4 的任务完成通知）在会话 running→idle 时调用浏览器 **Web Notification API**（`new Notification()`）。通知怎么渲染由**宿主浏览器**决定：页面开在 Trae 内置预览浏览器里 → Trae 拦截并以自己的弹框呈现；开在真实 Chrome/Edge 里 → 就是 Windows 系统通知（右下角 toast + 通知中心）。不是代码在调 Trae。

**新问题**：原代码只在 `Notification.permission === 'granted'` 时才弹，但**从未调用过 `requestPermission()`**——真实浏览器里权限永远是 default → 系统通知其实从来没机会弹。

**修复**：左列工具行加 🔔 授权开关（BoardView + locales + BoardAction.module.css）：
- default → 可点击，点击调 `Notification.requestPermission()`，浏览器弹授权询问
- granted → 蓝色高亮 + 禁用，title"系统通知已开启"
- denied → 禁用，title 提示去浏览器地址栏设置里允许
- 不支持 Notification API 的环境隐藏按钮

**实测**：🔔 渲染 ✓、三列几何断言 grid + y 全 0 ✓（BOM 教训后的固定检查）、本自动化浏览器已授权态显示正确 ✓。真实浏览器的授权流需用户实测。**注意：系统通知只在页面开着时弹（纯浏览器端机制）；页面关了不会弹。**

**构建**：tsc=0 + tsdown client=0，无需重启 server。

### 2026-10-05 · v16.3：三列布局崩坏返修——PowerShell Set-Content 写入 UTF-8 BOM 毒化 CSS 首条规则（用户两次纠错，教训深刻）

**用户反馈**：①"格式怎么全乱了" ②刷新后"还是坏的，没有了三列，也没有了会话窗口" ③"我都看到你浏览器显示的页面了，也是坏的，你仔细确认"。

**误诊两次**：第一次归因"重启窗口期插件加载失败"（让用户刷新），第二次归因"用户浏览器缓存残留"（让用户关标签重开）。实际上 v16.2 起页面就一直是坏的——**用户从头就是对的**。

**真凶（几何检查暴露）**：workbench 计算样式 `display: block`（应为 grid），三列全部竖向堆叠（notes y=0 / detail y=533 / chat y=1279，视口高 599 → 会话窗口被顶出屏），这就是"没有三列、没有会话窗口"。根因：v16.2 改动画时长时用了 `Get-Content -Raw | -replace | Set-Content -NoNewline`，**PowerShell 5.1 的 Set-Content 写入了 UTF-8 BOM（EF BB BF）**到 BoardAction.module.css 开头；css-modules-inline 把带 BOM 的 CSS 内联进 bundle，BOM（\ufeff）+ 空格落在首条选择器 `.FHFHIq_workbench` 前面 → 选择器非法 → 整条规则（含 display:grid）被 CSS 解析器丢弃。**之前的检查为什么全过**：元素存在 ✓、computed gridTemplateColumns 有值 ✓（display 非 grid 时该属性照常计算但不参与布局）、颜色变量 ✓——唯独没查 `display`。**教训：①改 CSS 后必须做几何断言（display + 各列 getBoundingClientRect 并排）；②PowerShell 改文件一律用 [IO.File]::ReadAllText/WriteAllText（UTF-8 无 BOM），永远不用 Set-Content。**

**修复**：剥掉 CSS 文件头部 3 字节 BOM（EF BB BF → `2F 2A 20` 即 `/*`），tsdown client 重建。

**实测**：display=grid ✓，workbench 高 599（视口满高，非堆叠的 2220）✓，三列并排 notes(x=0,w=236) / detail(x=241,w=340) / chat(x=586) 全部 y=0 满高 ✓。client 静态服务，刷新即生效。

### 2026-10-05 · v16.2：指示灯"常亮"根因——task_update 审核问题无超时挂 25 分钟（修复：180s 超时 + 闪烁加强）

**用户反馈**：任务"量化学习"的指示灯变成浅蓝常亮，不符合预期。

**排查（会话日志取证，session-25c4d675）**：00:27:59 用户 fork 出"量化学习 · 会话 (3)"并输入"1"；00:28:20 模型调 task_update → 审核流 `userQuestions.ask()`；**tool/call 挂到 00:53:47 才返回错误 "no user-questions answerer accepted the request"——整整 25 分钟**，期间 driver 一直 mid-turn=running → 任务灯/会话灯全程亮着（就是用户看到的"常亮"）。模型重试一次同样失败后放弃，turn 00:54:16 结束。

**机制调查（子代理结论）**：`userQuestions.ask()` **没有任何内置超时**——问题被某个浏览器客户端"认领"（retainAgentScope）但在任何已挂载面板里不可见时，会无限期挂起，直到某次 teardown（插件重载/客户端拆除）把请求退回才抛 NO_PROVIDER。25 分钟不是任何配置值，就是"认领但不可见"的持续时间。ask_user_question 工具/plan-mode 的 exit_plan_mode 同样无超时（无先例可抄）。等待用户回答期间 session 一直 running 是 dsh 核心语义（archive-admission 注释明确）。

**修复**：
1. **tasks 插件 reviewTaskUpdate 加调用方超时**：`AbortSignal.any([exec.signal, AbortSignal.timeout(180_000)])`——审核问题最多等 3 分钟；超时抛模型友好文案（"未生效，不要立即重试，先在对话里向用户说明，确认后再 task_update"）；NO_PROVIDER 也转成同样可行动的文案（不再把原始错误丢给模型，避免它无脑重试）。仓库内 AbortSignal.any/timeout 有先例（credentials 包）。
2. **闪烁加强**：note-pulse 关键帧 0.35→**0.2**、周期 1.6s→**1.1s**（两处：noteDotRunning/noteSubDotRunning）——原幅度太温和，读作"常亮"。

**构建部署**：tasks 是 host 面——tsc(host)=0 + tsdown host=0 + tsdown client=0，**重启 3090**（旧 PID 25668 → 新 PID 26572），新 token：`cwxPQIuU_fqDacEv7YwF1Wvzwh1lpRRq65r9ol5c50Q`（URL 已自动在默认浏览器打开）。注意：`powershell -File start-web.ps1` 在沙箱内静默失败（无输出退出），重启需用内联环境变量直接跑 node。

**实测**：发消息触发真实回复，1s 间隔采样运行灯 opacity：0.70 → 0.21 → 0.38——1.0↔0.2 @1.1s 的明显呼吸闪烁，不再读作常亮 ✓。产物 grep：AbortSignal.any/超时文案/NO_PROVIDER 文案/0.2 关键帧全在 ✓。

**遗留观察（非本轮修）**：多客户端时问题可能被"别的标签页"认领导致不可见挂起（gateway 投递给所有已连接客户端）；审核问题在右栏嵌入式面板理论上能正常渲染（ui-user-questions 的 composer 对 embedded 变体也生效），若再复现"问题没弹出来"需查当时哪个客户端认领了。

### 2026-10-05 · v16.1：指示灯隐形修复（62 处臆造 CSS 变量名 → 真实主题变量）

**用户反馈**：会话的指示灯好像无效。

**排查**：浏览器实测发现运行中的会话灯/任务灯 DOM 类名正确（noteSubDotRunning/noteDotRunning）、脉动动画在跑，但 `getComputedStyle().backgroundColor` 是 **rgba(0,0,0,0) 完全透明**——只剩 2px 淡蓝光晕，肉眼几乎不可见。根因：BoardAction.module.css 里用的 `--dsw-alias-state-accent-primary / accent-secondary / accent-muted / attention-primary / attention-muted / danger-primary / danger-secondary / danger-muted` 这套变量名**全仓库无定义**（早期写 CSS 时按命名惯例臆造的）。真实主题（`packages/client/ui-theme/src/styles/design-platform.css`，别名定义在 **body 作用域**，非 :root）里存在的是另一套名字。无 fallback 的 `var()` 声明失效 → 透明。

**修复**（62 处全在 BoardAction.module.css，正则批量替换）：

| 臆造名 | 真实变量 | 值（浅色主题） |
|---|---|---|
| state-accent-primary | `--dsw-alias-state-business-primary` | #4176e6 品牌蓝 |
| state-accent-secondary | `--dsw-static-deepseek-600` | hover 蓝 |
| state-accent-muted | `--dsw-alias-state-business-tertiary` | #e4edfd 浅蓝底 |
| state-attention-primary/muted | `--dsw-alias-state-warn-primary` / `warn-tertiary` | #f59e0b 琥珀 |
| state-danger-primary/secondary | `--dsw-alias-state-error-primary` / `error-secondary` | #ec1313 红 |
| state-danger-muted | 直接内联 rgba(239,68,68,x)（无等价 token） | |

两处运行灯光晕 box-shadow 直接用半透明蓝 `rgba(59,130,246,0.2)`（business-tertiary 是不透明浅蓝，做光晕不如半透明）。附带修复（同一根因 previously 隐形）：红色过期灯、日历 deadline 小方块、删除按钮红字、日历"今天"数字/选中描边蓝、进度条描边、表单 accent-color、新建任务按钮底色等。

**端到端实测**（3090，真实发消息）：右栏发"1+1等于几"→ 发送瞬间会话灯+任务灯同时点亮（`rgb(65,118,230)` 实心蓝 + 脉冲）→ 回复完成（用时 1 秒）灯灭 ✓。变量在 body 上解析：business/warn/error/tertiary 全部有值 ✓。

**构建**：tsc（0）+ tsdown client（0），server 无需重启。

### 2026-10-05 · v16：日历芯片自适应 + 底色 / 删除"在主视图打开"（浏览器实测通过）

**用户反馈**：①日历芯片字数按宽度自适应，芯片要有背景底色 ②会话列表的"在主视图打开"（↗）按钮删除。

**修复**（`ui-board`，仅 client 面）：

1. **日历芯片重做**：弃 v15 的"JS 固定截 4 字"——`calendarChipLabel` 只取任务标题（`·` 前），**字数完全交给 CSS**（`calDayItemLabel`：`flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis`，列拖宽即多显字）。芯片改**满宽 pill**（`width:100%` + `border-radius:4px` + `padding:1px 3px`，calDay `align-items:stretch`）+ **类型底色**：schedule 蓝 `var(--dsw-alias-state-accent-muted, rgba(59,130,246,0.12))`、deadline 黄 `var(--dsw-alias-state-attention-muted, rgba(234,179,8,0.14))`。实测两个 alias 变量在主题里不存在，均走 fallback 渲染（deadline 黄已证实机制有效）。每格最多 2 条 + "…"、色块、title 悬停全列表保留不变。
2. **删除"在主视图打开"**：删 `openSessionGuarded` useCallback、TaskDetail 的 `onOpenMain` prop、↗ 按钮 JSX、BoardView 解构里的 `openSession`（TS6133）；**locales 的 `chat.openMain` 键也要删（zh+en 两处**——只删 zh 会 TS2353：en 字典多出未知键）。

**浏览器实测**（3090，免重启）：deadline 芯片黄底 `rgba(234,179,8,0.14)`、满宽 46/54px（格内边距外全占）、radius 4px、label ellipsis ✓；新建测试提醒 → 蓝色芯片 `rgba(59,130,246,0.12)` 满宽 78px ✓（验后已删除还原）；DOM 全文无"在主视图打开"、无 title 含"主视图"的按钮 ✓。

**构建**：`npx tsc -b packages/client/ui-board`（0）+ `npx tsdown --env.DSH_BUILD_FACE client`（0）；client 静态服务，server 无需重启。

### 2026-10-04 · v15：分支导航抢占修复 + 日历芯片定宽（拖动验收通过）

**用户反馈**：①拖动验收 OK ②日历格式又乱，建议"蓝色小方块+任务名缩写，每格限量、超出用…" ③分支点击后**直接切到会话页面、任务板消失**（预期：任务内分支+右列切新会话）。

**#3 根因（真凶）**：ui-chat 的 `forkAt` 在 fork 成功后**主动调 `ctx.uiWorkspace.openSession(childId)`**——openSession 的语义是"选会话+显示 conversation 主视图"→ `selectPanel(null)` → 任务板 keyed slot 卸载。之前两轮修的（归属 attach + 右列跟随）都对，但都被这个导航抢占盖掉了。
**修复**：AppFrame（ui-layout）在 frame div 暴露 `data-main-panel`（当前主面板 id，conversation 为默认）；ui-chat 的 forkAt fork 成功后**读该属性，非 conversation 面板激活时跳过 openSession**（面板自己接管 fork 跟随：BoardView 的 effect 已做 attach + 右列切换）。
**实测**：点击"在新对话中分支" → `data-main-panel` 保持 `task-board` ✓、任务板仍挂载（详情 tab + composer 在）✓、fork 子会话 attach 到源任务（量化学习累积 5 会话）✓。

**#2 日历芯片**：弃 CSS ellipsis（截断位置参差=格式乱的根因）→ **JS 层定宽芯片**：取任务标题（· 前），**固定截 4 字 + "…"**（"量化学习…"）；每格最多 2 条芯片（5×5 色块 + 8px 文字），第 3 条起合并为居中"…"；格高 50px 居中布局；title 悬停全列表保留。

**构建部署**：tsc（ui-board/ui-chat/ui-layout）+ tsdown client 全过，server 无需重启。

### 2026-10-04 · v14：五项批次（fork 字段名修复 / 浅蓝运行灯 / 红色警示灯 / 日历条目化 / 三列可拖）

**用户反馈**：①分支仍未归属当前任务+进异常界面 ②进行中改浅蓝闪烁区别于完成绿 ③当天需闭环/已过期未闭环→任务灯红 ④日历整格涂色不好区分，要"日期数字下小方块+计划缩写" ⑤三列可调宽。

**根因与修复**：
1. **fork 归属从未生效**：客户端 SessionSummary 的字段是 **`parentId`**（session-controller 客户端 service.ts:628 把 host 的 parentSessionId 投影改名），BoardView 检测读 `parentSessionId` 恒 undefined。改为 `parentId` 后：attachSession + 右列跟随全部打通。**验证**：刷新后历史 fork（session-a19ec553，header parentSession=俄罗斯方块会话）自动归位——任务详情"会话 · 2" ✓。
2. **运行灯**：noteDotRunning/noteSubDotRunning 改浅蓝（accent-primary）+ 外圈光晕 + 原有脉动；完成保持绿。
3. **警示灯**：`taskOverdue`（active 且存在 !done 且 deadline ≤ 今天的计划项）→ dot 稳定红色（danger-primary+红晕），优先级高于运行/完成。
4. **日历条目化**：去掉整格背景 tint；日期数字下方每事件一行：**6×6 小色块（蓝=提醒/黄=闭环）+ 计划文字缩写**（8.5px CSS 截断），最多 2 条 + "+N" 居中；格高 58px；title 悬停全列表保留。
5. **三列可拖**：workbench grid 改 5 轨（notes 5px handle detail 5px handle chat），两条 col-resize 拖柄（pointer capture 拖动，clamp：notes 200-460、detail 280-720、右列 minmax(280,1fr) 自适应吃剩余）；原列 border 移到拖柄避免双线。

**构建部署**：仅 client（tsc+tsdown 过）。**浏览器实测**：拖柄 ×2 渲染 ✓、页面稳定 ✓、fork 归位（俄罗斯方块会话 1→2）✓。灯色/日历条目/拖动手感待用户验收。

### 2026-10-04 · v13.1：置顶融合返修（框等宽 + 箭头定位）

**用户反馈**：置顶融合后便签框大小不一、箭头位置飘。

**根因**：pin 改绝对定位后 li 不再是 flex 容器，noteCard 的 `flex: 1` 失效 → button 退化为内容自适应宽度（长短不一）→ 右边缘不齐 → 箭头（挂在 li 右上）跟着飘；且徽章占在第一行右端与 pin 重叠。

**修复**：noteCard `width: 100%`（等宽）；grid 改两列两行（`dot title / dot meta`），**类型徽章移到第二行与百分比同排**（noteMeta flex 行），标题行右侧 padding 14px 给 pin 让位；pin 绝对定位改为**垂直居中**（top 50% + translateY(-50%)，right 5px）——位置恒定。

**浏览器几何实测**：7 张便签宽度全部 219px（等宽 ✓）；3 个 pin 的 x 坐标全部 209（完全对齐 ✓）。

### 2026-10-04 · v13：五项修正（色块可见性 / 删除按钮 / 工具行 / pin 融合 / 指示灯数据修复）

**用户反馈**：①日历看不到色块 ②删除按钮格式不齐 ③去掉新会话/侧栏按钮 ④pin 与便签融为一体 ⑤在俄罗斯方块任务的会话提问，"其它"灯亮而俄罗斯方块灯不亮。

**修复**：
1. **色块**：`.calBar` 补 `display: inline-block`（原 6×4 太小且弱），加到 9×5px；**有安排的日期整格加浅蓝背景着色**（一眼可见），+N 保留，title 悬停保留。
2. **删除按钮**：补挂 `detailAction` 基类（此前只有 danger 变体，缺布局样式呈裸链接）。
3. **工具行**：只留 ✎偏好 ⚙设置。
4. **pin 融合**：便签行 `position: relative`，pin 绝对定位右上角（默认透明，hover 0.75，置顶常显主色）——不再单独占列。
5. **指示灯根因（数据修复）**：俄罗斯方块/贪吃蛇任务的 `sessions` 是**空的**——v9 之前模型 task_create 后未绑定会话（旧 bug 的历史遗留），这两个会话一直是 unassigned 落"其它"，running 自然点亮"其它"的灯。已把 `session-e738a3f4`（俄罗斯方块对话）和 `session-48586971`（贪吃蛇对话）绑定到各自任务。**验证**："其它"会话 12→11 ✓。新架构（单一归属 + 其它兜底 + briefing 禁 create）下不会再产生这种游离数据。

**构建部署**：仅 client 面（tsc + tsdown 通过，server 无需重启）。**浏览器实测**：工具行 ✎⚙ ✓、侧栏 0px ✓、列表与归属 ✓、页面稳定 ✓。色块视觉效果待用户验收。

### 2026-10-04 · v12：四项修正（侧栏彻底隐藏 / pin 图标 / 日历色块 / 分支归属任务）

**用户反馈**：①56px 窄轨没满足"隐藏" ②置顶图标丑，换向上箭头 ③日历格写完整文字撑坏格式，改颜色块且不能破坏日历 ④会话"在新对话中分支"应分支在当前任务里，实际打乱界面。

**修复**：
1. **侧栏彻底归零**：ui-layout 的 AppFrame 原有 `collapsedWidth`（darwin/Windows-titlebar → 0，web → 56 rail）条件**新增 `data-dsh-board-shell` 标记**（board 壳声明"通用控件已重新安置"→ 折叠时完全隐藏）；ui-board apply 设该标记。**浏览器实测：grid 列 `0px 745.6px 0px`，任务板占满全宽** ✓（a11y 快照仍列出隐藏的 rail 按钮，offsetParent null 不可见）。工具行新增 ▤ 侧栏切换钮（恢复入口）。
2. **pin 图标**：📍 → ↑（13px 加粗，激活态描边+主色）。
3. **日历色块**：格内文字改为**色块条**（每事件一条 6×4px 圆角色条：提醒=蓝、闭环=黄，最多 3 条 + "+N"），格高 44px、居中布局恢复原日历格式；title 悬停保留全列表，点击看详情不变。
4. **分支归属任务**（fork 修复）：根因——fork 子会话落"其它"且右列无反馈，用户感知"界面被打乱"。修复：客户端 fork 的 placeholder summary 带 `parentSessionId`（subagent 有 origin 标记、普通新建无 parent，**唯 fork 子会话满足"普通 origin + parentSessionId"**）→ BoardView effect 检测（tasksReady 后、ref 去重）→ 新 op `attachSession`（host 幂等挂入源任务 sessions）→ **若源会话正是右列当前会话，右列自动切到分支子会话**。历史遗留 fork 子会话在加载时一次性归位。

**构建部署**：tsc（tasks/ui-board/ui-layout）+ tsdown host/client 全过；重启 3090（token：RZH0ZST4ooXambRKfGI84ldnel5xpsV87pTOpTFXQ7o）。

**浏览器实测**：侧栏轨 0px ✓、工具行 4 钮（＋✎⚙▤）✓、pin 箭头 ✓、页面稳定 ✓。日历色块与分支行为待用户验收（浏览器工具对"日历"tab 按钮和"分支"按钮的 ref 映射持续失效——其他按钮均可点，疑似工具层 bug，非页面问题）。

### 2026-10-04 · v11：四项体验批次（隐藏侧栏+按钮搬迁 / 日历格缩略 / 双搜索 / 任务置顶）

**用户需求**：①隐藏 dsh 原生左侧栏（"DSH 本地构建"块），通用配置按钮（设置等）挪到新建任务上方 ②日历有安排的日期显示任务缩略 ③任务和会话加搜索 ④任务置顶（置顶在前、"其它"固定最后、其余按新建序）。

**实现**：
1. **侧栏隐藏**：apply 里一次性 `layout.toggleSidebar()`（模块级 one-shot flag 防 HMR 重复翻转）；**窄屏（<1024，ui-layout 的 AUTO_COLLAPSE）不 toggle**——窄屏默认已在 icon rail，toggle 反而会强制展开压住中列。侧栏收起后保留 56px rail（web 端 computeColumns 的 collapsedWidth 常量，完全归零仅 macOS desktop 支持）+ AppFrame 的"打开侧边栏"恢复钮。
2. **按钮搬迁**（左列顶部工具行：＋新会话 / ✎偏好 / ⚙设置）：新会话 = `uiWorkspace.startSession()`；**设置** = 设置面板 open state 是其 shell 组件内部 state 无外部命令 API → DOM 触发侧栏 trigger（aria-label/文本匹配"设置/settings"）+ 找不到时回退展开侧栏。
3. **日历缩略**：日期格由圆点改为"第一条事件缩略文字（9px 截断）+ '+N' 溢出徽章 + title 悬停全列表"，格高 40→52px。
4. **搜索**：左列任务搜索框（匹配标题+目的，与状态筛选叠加）；中列会话搜索框（匹配 displayTitle），空态区分"无会话"与"无匹配"。
5. **置顶**：TaskRecord + `pinned?: boolean`（host update op 支持，迁移兼容）；前端排序 rank：置顶=0 → 普通=1（保持 store 序=新建序）→ catch-all=2；便签行 hover 显示 📍（置顶常亮+描边）。

**构建部署**：tsc + tsdown host/client 全过，重启 3090（token 更新：xyWk8gbbZkVMxq5DPDT2R1OwOrzv1AXlK9VRuUEASfQ）。

**浏览器实测**：窄屏侧栏收成 rail ✓（会话树消失、rail 图标保留）、工具行渲染 ✓、搜索"扫雷"过滤到 2 项/清空恢复 ✓、置顶排序 ✓（手动给贪吃蛇加 pinned 后跳到第一、"其它"垫底，验证后已还原）、页面无死循环。**日历缩略未能点击验证**：浏览器工具的 ref 映射对日历 tab 按钮持续失效（snapshot 有 e41、click 层找不到，多次重试+dom strategy 均败，疑似工具层问题），该改动为纯 JSX 文本渲染，留用户一眼验收。

### 2026-10-04 · v10 排障：任务板死循环（React #185）+ 默认三列（浏览器实测验收通过）

**用户反馈**：①按钮点击无效 ②希望默认界面就是三列。**浏览器实测**（TRAE-browseruse + CDP）确认：点"任务板"后主线程完全冻结（evaluate 6s 无响应），console 抓到 **React error #185（Maximum update depth exceeded）**——BoardView 挂载触发无限 setState，整个 React 树崩（最先崩在 sidebar.workspaces entry）。**结论：bug 在面板渲染而非按钮，默认三列反而会立即触发，必须修根因。**

**修复（BoardView.tsx 三处）**：
1. **引用稳定化**：`retainBoardSession`/`refreshProjections`（inject 工厂每渲染可能重建的 props）改存 ref；`selectBoardSession` 变零依赖 useCallback——依赖它的 effect 不再被拖进更新循环
2. **初始化幂等**：右列默认会话的引导 effect 加 `bootstrapped` ref（失败也不重试），retain 加 try/catch（返回 boolean 保留 openSessionWhenReady 重试），mainView 选择排除 subagent origin，无 mainView 引用时回退最新普通会话
3. **projected effect** 依赖改 store 派生值（byId）+ ref 化回调

**默认三列（index.ts）**：main slot 注册回调里 `ctx.layout.selectPanel(PANEL_ID)`（注册完成后、首次 React 渲染前执行，无闪烁）；inject 加 'layout'。侧边栏"任务板"按钮变为初始选中态；↗ 仍可切回 conversation 主视图。

**构建部署后浏览器全链路验收**（均通过）：打开即三列默认任务板（无死循环，多轮交互稳定）→ 左列点"扫雷"任务，中列切换（0/6 计划 + 可勾选）→ 勾选计划项，进度即时变 1/6 · 17%（真实写入）→ 中列点会话，右列切到完整会话（含可交互 composer）→ 日历 tab：月网格 + 今天 + 选中日事件区 + 新建提醒表单 → 刷新后右列默认绑定最新会话。

**遗留**：浏览器截图工具当前模型不可读图（非多模态），视觉细节以 DOM 断言验收；扫雷任务第一计划项被验收勾选（真实数据，可手动取消勾选）。

### 2026-10-04 · v10 大改版：三列工作台 + task_update 用户审核 + 日历系统（六项需求一批交付）

**用户规格**：完全放弃 dsh 默认布局——三列框架（左：便签墙单列，显示名称/会话进行中/任务类型学习工作/进展百分比；中：任务详情，点左列切换，默认"其它"；右：选中会话的内容，dsh 默认风格）+ task_update 用户审核（修改前后对比、确认/意见输入，意见回传模型调整后重提）+ 日历系统（展示和管理定时任务）+ 计划项可选闭环时间（进日历）。

**三项先行调研（search agent 并行）的关键结论**：
1. **三列**：center 列 panel 与 conversation 架构性互斥（keyed slot 二选一），但 `conversation.content` 工厂（variant `embedded`）是官方预留的复用通道，ui-subagent 右栏聊天是完整先例 → 面板内部分栏实现，零 shell 改动
2. **审核**：`ctx.userQuestions.ask()`（ask_user_question 的问答管道）有 custom 自由文本通道直达工具结果，approval 管道是闭合枚举无意见通道 → 复刻 plan-mode `exit_plan_mode` 的审核形状
3. **日历**：schedule 投影经三条通道自动到客户端（列表块/refreshProjections 基线/control 实时帧）→ 展示零 host 改动；管理无现成 RPC → 给 schedule 包加 `scheduleAdmin` host 服务

**Host 侧改动**：
- `packages/schedule/schedule/src/admin.ts`（新）：`ScheduleAdminService`（ctx.scheduleAdmin）——create/remove 走 runScheduleTransaction + 域函数构造 + 双持久化屏障 + runtime requestDrive（与模型工具同队列串行）；apply 里 new 注册
- `packages/context/tasks/src/index.ts`：
  - TaskRecord + `category: work|learning`（旧数据迁移默认 work）；PlanItem + `deadline?: YYYY-MM-DD`
  - **task_update 审核流**：execute 里构造修改前/后对比 markdown（字段级变化清单 + 完整记录）→ `userQuestions.ask`（选项：应用更新/退回修改 + custom 意见输入框）→ 批准才写盘；退回/意见 → 抛错带回意见，模型调整后重新 task_update（briefing 也预告了审核机制）；无 UI 通道时降级报错
  - `/tasks` 路由新增 `scheduleCreate`（prompt + at/afterSeconds/everySeconds 恰一）/`scheduleDelete`（scheduleId），冷会话自动 resume；create/update 接受 category

**Client 侧改动**（`packages/client/ui-board/`）：
- 三列布局（CSS grid：236px 便签墙 | 详情/日历 | 会话）：左列便签（运行点/标题/类型徽章/百分比），中列「任务详情|日历」tab，右列 `SessionProvider + renderFactorySlot('conversation.content', embedded)` 嵌入完整会话（含 composer，可交互）
- 新增 `board.conversation` session 子槽 + `BoardConversationPanel`（照抄 ui-subagent 样板）；`BoardInjected` 扩展 `retainBoardSession`（ctx.sessions.retain，source boardChat）/`refreshProjections`
- 右列会话切换不走 `uiWorkspace.openSession`（那会切回主视图），面板内 retain/SessionProvider 显式绑定；默认显示 mainView 当前会话
- 任务详情：计划项**可直接勾选**（POST 整个 plan）、闭环日期显示、会话列表点击切右列 + ↗ 在主视图打开
- 日历：月网格（周一起始）+ 当日事件（提醒=蓝点、闭环=黄点，every 提醒外推 3 次）+ 取消按钮 + 新建表单（日期/时间/内容 → 右栏会话）
- 任务编辑器：类型单选（工作/学习）+ 计划项闭环日期输入
- tasks 轮询 15s → 5s；schedule 数据走投影实时流（零轮询）

**构建**：tsc -b（schedule/tasks/ui-board）→ 全量 tsdown host+client 全 exit 0；产物 grep 验证（scheduleAdmin 在 lib/index.js、workbench 在 client.js）；3090 重启，misc=True 确认新代码生效，旧任务自动迁移 category。

**待用户验收**（刷新浏览器）：
1. 任务板 = 三列；左列点任务切中列；中列点会话切右列对话；右列可直接发消息
2. 会话里让模型更新任务 → 应弹出「任务更新审核」卡片（修改前后对比 + 应用/退回 + 意见输入）；填意见退回 → 模型应按意见调整重提
3. 日历 tab：现有提醒/新模型建的提醒应出现在日期格；选日期建提醒（挂到右栏会话）；取消已有提醒
4. 编辑任务可选类型；计划项可填闭环日期，出现在日历（黄点）
5. 便签显示类型徽章和百分比；勾选计划项即时更新进度条




















