# 任务侧栏的 daemon 过载指示

[English](daemon-overload-sidebar-indicator.md) | [简体中文](daemon-overload-sidebar-indicator.zh-CN.md)

状态：提案（proposed）

## 问题

负荷准入闸门（见[基于负荷的会话准入](load-based-session-admission.zh-CN.md)）在主机饱和期间以 `503 system_overloaded` 拒绝新建会话。今天 Web Shell 只在用户点击"新建任务"之后以 toast 呈现该拒绝：状态在点击前不可见，按钮在每次点击都必然失败时仍看起来可操作。原始仪表（CPU、内存、子进程 RSS）已在 Daemon Status 对话框的 metrics 页；缺的是动作点上的可操作状态。

## 目标

- 在任务侧栏头部、它所管辖的"新建任务"按钮旁展示过载状态。
- 过载期间禁用"新建任务"与所有新建入口，原因以 tooltip 提供。
- 主动从 `GET /daemon/status`（`runtime.loadAdmission`）获知状态，使其在第一次被拒点击之前可见；被动从 `system_overloaded` 拒绝获知，使轮询间隙藏不住它。
- daemon 报告恢复或拒绝提示过期时清除状态。

## 范围边界

- 不新建仪表盘，侧栏不放原始 CPU/内存数字；那些留在 Daemon Status 对话框。
- 指示条是仅在过载时占空间的薄警示条；正常运行视觉不变。
- 只禁用新建入口。已有会话、prompt、cancel、导航不受影响。
- daemon 侧闸门、阈值与 status 契约在本切片不变。

## 设计

### 状态来源

两个独立来源，渲染时 OR 组合：

1. **主动轮询。** App 中一个 `useDaemonStatusReport({ detail: 'summary' })` 资源，在 daemon 可用期间按 5 秒间隔 reload。`report.runtime.loadAdmission.overloaded` 驱动暂停状态；tooltip 文案由快照的 `reason`、`loadRatio`、`eventLoopLagP99Ms` 经 i18n 组合。SDK 的 `DaemonStatusReport` runtime 类型按既有"旧 daemon 省略该字段"约定新增加性可选 `loadAdmission` 字段；没有闸门的 daemon 永远不上报它。
2. **被动拒绝。** 已处理 `session_limit_exceeded` 的现有 notice effect 同时处理 `create_session` 上 `code === 'system_overloaded'`：以 `Date.now() + 15_000`（daemon 的 `Retry-After`）为过期时间存储 notice 消息，由 timeout 清除。覆盖轮询之间的窗口与 status 轮询失败的 daemon。

`overloadPaused = pollOverloaded || reactiveUnexpired`。tooltip 在轮询报告过载时优先用轮询的本地化读数，否则用拒绝消息。不做合并状态机：轮询侧每次渲染从资源派生，被动侧是单个带过期时间的状态值。

### 侧栏呈现

`WebShellSidebar` 新增两个可选 prop：`overloadPaused?: boolean` 与 `overloadDetail?: string`。暂停期间：

- 新建任务 nav 行内、按钮上方渲染警示条：警告图标加 `sidebar.overloadPaused`（"系统过载 · 暂停新建"），`title`/`aria-label` 携带 `overloadDetail`。
- `newSessionDisabled` 变为 `creatingSession || overloadPaused`，禁用按钮；`handleNewSession` 与 worktree 变体在暂停期间提前 return，使侧栏所有入口受同一谓词守卫。
- App 层 create handler 在暂停期间以警告 toast 拒绝，覆盖侧栏之外的入口（panel、空页），裁决相同。
- 两个来源都清除后警示条消失、按钮重新可用。

轮询/过期/OR 逻辑放在 `useDaemonStatusReport` 旁的小 hook `useDaemonOverloadPause` 中，无需渲染 App 即可测试；App 持有 notice effect 喂入的拒绝状态并组合本地化 tooltip。

### i18n

双语字典新增 key：`sidebar.overloadPaused`（条标签）与 `sidebar.overloadDetail`（带 reason/ratio/lag 占位符的 tooltip 模板）。被动路径原样复用 daemon 自己的消息。

## 设计决策与理由

- **动作点，而非仪表盘。** 侧栏头部是被管辖操作所在；那里的条把意外 503 变成可见、有解释的暂停。原始指标在 status 对话框已有归宿。
- **轮询加拒绝，而非仅轮询。** 5 秒轮询可能落后闸门至多一个间隔加闸门自身去抖；被动拒绝让第一次失败点击立即有解释，其 TTL 与 daemon 的重试提示一致，使 UI 在没有轮询确认时不会暂停得比 daemon 建议的更久。
- **仅轮询也不够。** 没有它状态只在失败点击后出现，而那正是本切片要消除的意外。
- **派生 OR，不做合并机器。** 两个生命周期不同的来源（渲染派生 vs 带过期状态）在一个表达式里组合；存储合并裁决需要在每次轮询与每次过期时对账。
- **加性 SDK 字段。** 旧 daemon 省略 `loadAdmission`；可选字段保持客户端对它们与 opt-out flag（`enabled: false` 永不暂停）的兼容。

## 约束与风险

- 轮询为每个打开的 Web Shell 每 5 秒增加一次 summary 请求；summary 是 status 对话框已在用的廉价内存视图。
- 剥离新 status 字段的代理后面的 daemon 退化为仅被动行为，即今天的行为加警示条。
- 警示条出现/消失时除自身行外不得移动布局；它渲染在现有 nav 容器内。

## 验证计划

- 组件测试：`overloadPaused` 时侧栏渲染警示条并禁用按钮（且 create handler 提前 return），清除后两者恢复；tooltip 携带 detail 字符串。
- Hook/App 级测试：轮询过载驱动暂停状态；`system_overloaded` notice 设置带过期的被动状态；过期清除；未过载的轮询不清除未过期的被动提示。
- `npm run build && npm run typecheck` 加 touched web-shell 套件；SDK 类型新增由 sdk typecheck 检查。
- E2E 计划：`.qwen/e2e-tests/daemon-overload-sidebar-indicator.md`（组件级矩阵加对加载 daemon 的可选实机探针）。

## 验收标准

- daemon 报告 `loadAdmission.overloaded` 期间，侧栏显示警示条、"新建任务"禁用且带原因 tooltip；任何新建入口都不创建。
- `503 system_overloaded` 拒绝即使轮询未跟上也要立即显示警示条，并在 15 秒提示后清除（除非轮询确认过载）。
- 恢复（轮询报告未过载且无未过期拒绝）移除警示条并重新允许新建。
- 没有闸门或以 `--no-load-admission` 启动的 daemon 永不显示警示条。

## 开放问题

- 警示条是否还提供打开对话框 metrics 页的"查看 daemon 状态"入口；为保持本切片最小而延期。

## 涉及文件

| 文件                                                                                   | 变更                              |
| -------------------------------------------------------------------------------------- | --------------------------------- |
| `packages/sdk-typescript/src/daemon/types.ts`                                          | 加性 `runtime.loadAdmission` 类型 |
| `packages/web-shell/client/App.tsx`                                                    | 轮询 + 被动状态、props、notice    |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`                     | 警示条、禁用谓词、handler 守卫    |
| `packages/web-shell/client/i18n.tsx`                                                   | en + zh keys                      |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css`              | 警示条样式                        |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.ts`           | 轮询 + 过期 + OR hook             |
| `packages/web-shell/client/daemon/workspace/hooks/index.ts`                            | hook barrel 导出                  |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.overload-strip.test.tsx` | 警示条/禁用测试                   |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.test.ts`      | 轮询/被动/过期测试                |
