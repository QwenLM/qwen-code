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
- 只暂停新 ACP child 分配：新建入口禁用或拦截分配，空白草稿的首条 prompt（会分配会话）以同一警告拒绝。已有会话 prompt、cancel、导航与 warm runtime 复用不受影响。managed 模式豁免：其 home 按钮不创建 daemon 会话。
- daemon 侧闸门阈值（包括 `#18420` 的事件循环延迟联合判定）、`runtime.loadAdmission` 状态契约与 `503 system_overloaded` 错误形态均已随 `#18052` + `#18420` 合入 `main` 并在本分支实时生效。在 daemon 侧，本 PR 只补充 `createServeApp` 中默认 bridge 对应的 `loadAdmissionMonitor` 生命周期释放（将非法 origin 与 managed-local-web 校验提前到 monitor 创建之前，且默认 bridge 构造失败时立即 dispose），并为 `#18009` 新增的冷 `POST /session/:id/worktree-restore` 补上改磁盘前的过载预检（保持已存活 warm 会话不受阻断）。
- 向下兼容旧版 daemon：`DaemonStatusReport` 上的 `runtime.loadAdmission` 保持可选；不返回该字段的旧 daemon 不触发轮询暂停，`--no-load-admission` 也不会触发任一暂停来源。

## 设计

### 状态来源

两个独立来源，渲染时 OR 组合：

1. **主动轮询。** `useDaemonOverloadPause` 内部通过 `useOptionalDaemonWorkspace()` 将 `actions.loadDaemonStatus('summary')` 交给 `useDaemonResource`（`autoLoad: true`，门控在 `enabled && actions !== undefined && visible`），在 daemon 可用且标签页可见期间按 5 秒间隔 reload（挂载与定时间隔共用在途记账）。`useDaemonResource` 在重试在途期间保留上一条已结算的轮询错误，直到下一次成功响应才清除，避免状态轮询失败后在待定重试期间复活过期的 `overloaded: true` 载荷。`report.runtime.loadAdmission.overloaded`（门控在 `enabled && error === undefined`）驱动暂停状态；tooltip 文案由快照的 `reason`、`loadRatio`、`eventLoopLagP99Ms` 经 i18n 组合。
2. **被动拒绝。** 已处理 `session_limit_exceeded` 的现有 notice effect 同时处理 `create_session`、`branch_session`、`fork_session`、`load_session`（含 `restoreWorktreeSession` 的 503 过载）和 `resume_session` 上 `code === 'system_overloaded'`：以 `Date.now() + 15_000`（daemon 的 `Retry-After`）为过期时间存储 notice 消息，由 timeout 清除。`createScheduledTask` 与 `runScheduledTask` 同样保留 `DaemonHttpError` 状态码与响应体，使 `App` 的 `reportError` 触发同一 15 秒被动暂停与警告 toast。覆盖轮询之间的窗口与 status 轮询失败的 daemon。

`overloadPaused = pollOverloaded || reactiveUnexpired`。tooltip 在轮询报告过载时优先用轮询的本地化读数，否则用拒绝消息。不做合并状态机：轮询侧每次渲染从资源派生，被动侧是单个带过期时间的状态值。

### 侧栏呈现

`WebShellSidebar` 新增可选 `overloadPaused`、`overloadDetail` 与 `onOverloadRefused` prop。暂停期间：

- 新建任务 nav 行内、按钮上方渲染警示条：警告图标加 `sidebar.overloadPaused`（"系统过载 · 暂停新建"），`title`/`aria-label` 携带 `overloadDetail`。
- 在 rail 模式下，折叠 rail 或打开非 Home 页面会隐藏 Home surface，此时同样的警示以图标形式放在始终可见的 rail 中，保留详情 tooltip 与无障碍标签。打开 Home 预览时隐藏该图标，改在预览内显示完整警示条；同一个 pause 不会同时显示两条可见警示。
- 完整面板的 `sectionView`、`selectionMode` 抑制规则只作用于完整面板；面板自身被隐藏时，不移除 rail 中的紧凑警示图标。
- `newSessionDisabled` 变为 `creatingSession || overloadPaused`，禁用按钮；`handleNewSession` 与 worktree 变体在暂停期间提前 return，使侧栏所有入口受同一谓词守卫。
- App 层 create handler 在暂停期间以警告 toast 拒绝，覆盖侧栏之外的入口（panel、空页），裁决相同。
- 所有可能激活新 child 的 branch 流程，包括 record-point branch，都经过 `branchCurrentSession` 的同一预派发暂停守卫。`atRecordId` 只是历史引用，不能证明 UI 留在当前 runtime：返回的 session 可能在发布之后再通过 `startSessionSwitch` 进行 fresh load。先拒绝也避免在暂停激活期间留下额外的已发布历史点。slash handler 用显式 `false` 保留输入指令；`onBranchSession` 回调则继续保持既有 `void | Promise<void>` 契约。

- **当前 standalone 会话归档前先解除自身附件。** 后端只有确认没有活跃 prompt 且客户端附着数为零，才会关闭 standalone runtime。`SessionOverviewPanel` 仅针对选中的会话，用记录的 session/client 身份先调用 detach，不取消工作，也不创建替代 child。其它客户端仍附着或工作仍活跃时，仍返回既有 busy 失败，不冒充成功归档。

#### `fork` 与新 ACP child 的边界

- `/fork` 通过现有 ACP 的 `entry.connection` 及其队列启动后台 `Agent` tool fork，不经过 `reserveFreshSession`。fork 子代理共享父生命周期和由父会话派生的运行时配置，属于现有工作，而不是 `spawn`、`load`、`resume`、`branch` 所表示的新 ACP child 分类。新建任务暂停不禁止这条现有会话的后台路径。
- 真正来自 daemon 的 `503 { code: "system_overloaded" }` 与预先拒绝分配并不相同。`forkSession` 和 `branchSession` 保留该 code，同时保留各自的 `fork_session` / `branch_session` operation，包括 branch 已发布后经 `startSessionSwitch` 延迟出现的失败。App 的 notice effect 同时识别它们与 `create_session`，因此意外返回的过载错误仍能触发被动暂停，而不只是普通命令失败 toast。不会把它们的真实 operation 误标为 `create_session`。
- 同一个底层 503 不能产生两条 warning：deferred branch 在 `startSessionSwitch` 内首次发出的通知就保留 `branch_session` 和 branch 专属操作文本，而不是再发 `load_session`；`_alreadyDispatched` 使外层 branch 错误处理器返回原错误，不再次通知。
- 延迟出现 branch-load overload 属于恢复状态，不应再次请求 branch。已发布 branch 保留其 sessionId，待准入恢复后由调用方显式 load。`actions` 测试在发布后直接拒绝真实的 `pendingSessionLoadRef`，检查延迟 notice 同时保留 `branch_session` 与 `system_overloaded`。
- 两个来源都清除后警示条消失、按钮重新可用。

#### 控制导航与恢复语义

- **删除与归档恢复不被暂停阻断。** 已删除或归档的当前会话不能把失效历史留在屏幕上。明确的 workspace 目录 recovery reset 可以清除本地选择状态并准备草稿，这一步不分配 ACP child；随后首条 prompt 仍须通过 admission。该例外必须同时具有显式 recovery reset 与非 inherited 的 workspace/global 意图。没有 recovery flag 的普通新建，以及 inherited retry，仍然会被拒绝。过载时 Session Overview 的 Back 只关闭面板并保留当前选中会话，既不清空也不分配新会话。
- **异步准入可能返回“无目标会话”。** 若 pause 在预检或草稿创建的飞行途中到达，`sendPrompt` 在清空编辑器前检查 `sessionIdAfterEnsure`。缺少 ID 时恢复取消/预派发状态并返回 `false`，不会乐观提交、向未连接会话发送或擦除草稿；正常准入的会话继续走原有 owner 校验。
- **任务消费以刷新后的真实状态为准。** `ScheduledTasksDialog` 刷新任务后，在删除一次性任务或派发新 child 之前调用 `shouldRefuseManualRun`。App 读取最新暂停与连接 ref，避免使用渲染闭包里的旧裁决。周期性 per-run 派发也受保护；匹配且已加载完毕的当前连接，或复用该连接的未绑定任务，仍可运行。不同 bound ID 按可能需要冷恢复来保守处理。
- **`/send`、`load`、`resume` 保留各自资源边界。** 没有 `--session-id` 的 `/send` 会创建新 child，在 RPC 前就拒绝；显式 target 仍可通过 `byId` attach 到已有 runtime。它若返回真正的 overload，则转为可恢复的提示与 warning toast。`startSessionSwitch` 派发失败时，overload 转为 `load_session` 或 `resume_session` 的 warning，并携带 `code: system_overloaded` 和 `_alreadyDispatched`，避免第二个错误 toast。其它错误和 abort 保持原处理，主机恢复后仍能进行冷恢复重试。
- **已发布 worktree branch 保持可恢复。** 发布后的过载使请求开始时捕获的源 workspace 缓存失效，而不是让错误到达时用户后来选择的 workspace 失效。持久化的 sessionId 在主机恢复后可显式打开。普通 branch 回调继续保持 pending Promise 契约。
- **过载提示使用实时原因。** `dispatchActionError` 将 overload 发为 warning，其它失败仍保留原 error tone。侧栏可选的 `onOverloadRefused` 接收 App 当前的真实原因，而不是泛化的 error 占位文案。未提供此回调的嵌入方继续沿用既有 `onError` fallback，原生 disabled 仍是硬 UI 边界。

轮询/过期/OR 逻辑放在 `useDaemonStatusReport` 旁的小 hook `useDaemonOverloadPause` 中，无需渲染 App 即可测试；App 持有 notice effect 喂入的拒绝状态并组合本地化 tooltip。

### i18n

四个随包发布的语言目录（`en`、`zh-CN`、`zh-TW`、`ru`）均新增 key：`sidebar.overloadPaused`（条标签）与 `sidebar.overloadDetail`（格式化 reason、loadRatio、eventLoopLagP99Ms 的插值函数）。文档导出 bundle 仅内联 `en` 与 `zh-CN`（`zh-TW` 与 `ru` 被 transcript stub 替换）。被动路径原样复用 daemon 自己的消息。

## 设计决策与理由

- **动作点，而非仪表盘。** 侧栏头部是被管辖操作所在；那里的条把意外 503 变成可见、有解释的暂停。原始指标在 status 对话框已有归宿。
- **轮询加拒绝，而非仅轮询。** 5 秒轮询可能落后闸门至多一个间隔加闸门自身去抖；被动拒绝让第一次失败点击立即有解释，其 TTL 与 daemon 的重试提示一致，使 UI 在没有轮询确认时不会暂停得比 daemon 建议的更久。
- **仅轮询也不够。** 没有它状态只在失败点击后出现，而那正是本切片要消除的意外。
- **复用先于拒绝。** `resolveSessionForWorkspace` 的暂停守卫位于两条复用分支（连接会话所有权、目录最新会话）之下、分配之上：GitDialog 提交/PR 生成不分配会话，过载时须继续工作；仅 forceCreate/分配被拒。
- **轮询裁决的新鲜度界。** `useDaemonResource` 在轮询失败或禁用时保留旧 payload，故 `pollOverloaded` 要求 `enabled && error === undefined`；status 不可达或离线期间仅带过期的拒绝提示可暂停 UI。
- **挂载请求记账与隐藏标签页门。** autoLoad/挂载请求与 interval 轮询共用同一在途记账；资源仅在标签页可见时 enabled（visibilitychange 监听在回到前台时重新启用并重拉），后台或饱和 daemon 的标签页不堆叠 summary 请求。
- **所有受守卫入口共享同一 managed 豁免。** `App.tsx` 的全部守卫均带 `!managedModeRef.current`——`createNewSession`、`sendPrompt`、`ensureSessionForPrompt`、`resolveSessionForWorkspace`、`handleGoalSlashCommand`、`branchCurrentSession`（包括 checkpoint 在 worktree 预检前的提前检查）、`handleSubmit` 的 `!` 行内 shell 分支（需要新会话时，拒绝先于命令排队）、`ensureAgentMentionSession`（返回 `{ paused: true }` 使 `useAgentChatEntry` 跳过 `collab.mention.noSession`）、以及 side task 的两个创建边界。`createSideTask` 保持公共 boolean 契约，`createEmptySideTask` 不重复弹错误；`createSideTaskSession` 也会拒绝失败标签的 Retry 并回传已派发错误，避免重复提示。`WebShellSidebar` 与 `ArtifactPanel` 接收 `overloadPaused && !managedMode`。`ScheduledTasksDialog` 改收 `shouldRefuseManualRun`，在服务端刷新后、消费一次性任务或记录 per-run 尝试前判断；predicate 重新读取实时的暂停 ref 与连接 ref。每个 per-run 派发都视为新分配；没有当前连接、正在加载 transcript 或绑定的是不同 session ID，都保守地视作可能需要冷恢复。只有与当前连接 ID 相符、`status: connected` 且没有进行中的 transcript 加载的连接，或由未绑定任务复用的这种当前连接，才允许在暂停期间继续已存在的工作。这样避免在冷加载被拒前先删除一次性任务，同时不声称任意 bound ID 都能由 UI 证明是 warm 会话。
- **显式拒绝契约。** `sendPrompt` 暂停拒绝返回 `false`；composer submit 与设置语言同步遵从（保留草稿/不报假成功），`enqueueManualRun` 以带 `_alreadyDispatched: true` 的 Error 拒绝以防 `reportError` 弹出重复错误 toast，fire-and-forget 调用点不受影响。
- **派生 OR，不做合并机器。** 两个生命周期不同的来源（渲染派生 vs 带过期状态）在一个表达式里组合；存储合并裁决需要在每次轮询与每次过期时对账。
- **加性 SDK 字段。** 旧 daemon 省略 `loadAdmission`；可选字段保持客户端对它们与 opt-out flag（`enabled: false` 永不暂停）的兼容。

## 约束与风险

- 轮询为每个打开的 Web Shell 每 5 秒增加一次 summary 请求；summary 是 status 对话框已在用的廉价内存视图。
- 剥离新 status 字段的代理后面的 daemon 退化为仅被动行为，即今天的行为加警示条。
- 警示条出现/消失时除自身行外不得移动布局；它渲染在现有 nav 容器内。

## 验证计划

- 组件测试：`overloadPaused` 时侧栏渲染警示条并禁用按钮（且 create handler 提前 return），清除后两者恢复；tooltip 携带 detail 字符串。
- Hook/App 级测试：轮询过载驱动暂停状态（轮询失败或 `enabled: false` 时清除）；`system_overloaded` notice 设置带过期的被动状态；过期清除；未过载的轮询不清除未过期的被动提示；暂停态的 `!ls`、`/goal set`、`@`-mention、新建 side task、`createNewSession`、未绑定手动运行各自仅弹一条警告 toast 且不创建会话，`ScheduledTasksDialog` 的未绑定一次性任务在 `runScheduledTask` 消费前被拒。暂停态的 `/branch` 与 checkpoint 激活在 branch 分配或 worktree 预检前被拒绝；普通 checkpoint 请求保留 pending Promise，两个 worktree fallback 均等待它。branch/fork 过载 notice 保留各自的 operation 与 code，包括已发布 branch 的延迟 load 拒绝；`/fork` 仍可沿用父 ACP runtime。删除会话后不能阻塞视图，Overview Back 可退出，异步预检到过载要保留草稿；刷新后的冷绑定一次性任务与周期性 per-run 都在消费/分配前被拒，当前匹配会话仍可复用。缺省 target 的 `/send` 拒绝，显式 warm target 能发送，真实 503 触发 warning 与被动暂停。load/resume notice 保留 operation/code，已发布 worktree 过载刷新源 workspace。侧栏 warning 回调保留不创建会话的拒绝语义，不转入普通错误 handler。
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

| 文件                                                                                   | 变更                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `docs/design/daemon-overload-sidebar-indicator.md`                                     | 英文设计文档                                                 |
| `docs/design/daemon-overload-sidebar-indicator.zh-CN.md`                               | 中文设计文档                                                 |
| `packages/cli/src/serve/managed-local-web.ts`                                          | 导出共享 `parseManagedLocalJavaUrl` 供 monitor 创建前校验    |
| `packages/cli/src/serve/routes/session.ts`                                             | 冷 `worktree-restore` 改磁盘前过载预检（warm 会话不受阻断）  |
| `packages/cli/src/serve/routes/session-worktree-restore.test.ts`                       | 冷恢复过载 503 与 warm 负向对照测试                          |
| `packages/cli/src/serve/server.ts`                                                     | 默认 bridge `loadAdmissionMonitor` 所有权与释放              |
| `packages/cli/src/serve/server-default-bridge-wiring.test.ts`                          | 默认 bridge monitor 生命周期与前置校验测试                   |
| `packages/web-shell/client/App.tsx`                                                    | 轮询 + 被动状态、根守卫、branch 完成态与 notice              |
| `packages/web-shell/client/App.test.tsx`                                               | App 层暂停守卫、branch 完成态与被动 notice 测试              |
| `packages/web-shell/client/components/SessionOverviewPanel.tsx`                        | 归档选中的 standalone 会话前先解除自身附着                   |
| `packages/web-shell/client/components/SessionOverviewPanel.test.tsx`                   | standalone 归档先 detach 的回归测试                          |
| `packages/web-shell/client/components/artifacts/ArtifactPanel.tsx`                     | 新建 side task 的 `overloadPaused` 禁用                      |
| `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.tsx`                | 手动任务消费/派发前暂停守卫                                  |
| `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.test.tsx`           | 冷绑定与 per-run 守卫测试                                    |
| `packages/web-shell/client/components/sidebar/StandaloneRecents.tsx`                   | `newSessionDisabled` prop                                    |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`                     | 警示条、紧凑 rail 图标、禁用谓词、warning 回调               |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css`              | 警示条与禁用头部按钮样式                                     |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.overload-strip.test.tsx` | 警示条/rail/禁用/菜单/standalone 测试                        |
| `packages/web-shell/client/components/workspace-agents/useAgentChatEntry.ts`           | `@`-mention 的 `{ paused: true }` 短路                       |
| `packages/web-shell/client/daemon/session/DaemonSessionProvider.test.tsx`              | 延迟切换与过载接线测试                                       |
| `packages/web-shell/client/daemon/session/actions.ts`                                  | overload notice 元数据、`switchCompleted`、`restoreWorktree` |
| `packages/web-shell/client/daemon/session/actions.test.ts`                             | overload operation/code、延迟 branch 与 worktree 恢复测试    |
| `packages/web-shell/client/daemon/session/httpErrors.ts`                               | `isSystemOverloadedError` 分类器                             |
| `packages/web-shell/client/daemon/session/httpErrors.test.ts`                          | 分类器三形状与负向控制表                                     |
| `packages/web-shell/client/daemon/session/types.ts`                                    | 可选 `switchCompleted?: Promise<boolean>` 契约               |
| `packages/web-shell/client/daemon/workspace/actions.ts`                                | 定时任务创建/运行保留 `DaemonHttpError`                      |
| `packages/web-shell/client/daemon/workspace/scheduledTasks.actions.test.ts`            | 定时任务 503 过载分类测试                                    |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.ts`           | 轮询 + 过期 + 新鲜度 + OR hook                               |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.test.ts`      | 轮询/被动/过期/重试在途新鲜度测试                            |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonResource.ts`                | 重试在途期间保留已结算轮询错误                               |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonResource.test.tsx`          | 重试在途保留已结算错误测试                                   |
| `packages/web-shell/client/e2e/utils/mockDaemon.ts`                                    | 默认健康 `GET /daemon/status` mock 路由                      |
| `packages/web-shell/client/hooks/useSessionScheduledTasks.ts`                          | 将手动任务过载拒绝守卫透传至共享 helper                      |
| `packages/web-shell/client/hooks/useSessionScheduledTasks.test.tsx`                    | 手动任务过载拒绝透传测试                                     |
| `packages/web-shell/client/i18n.tsx`                                                   | `en` 过载文案                                                |
| `packages/web-shell/client/i18n-zh-cn.ts`                                              | `zh-CN` 过载文案                                             |
| `packages/web-shell/client/i18n-zh-tw.ts`                                              | `zh-TW` 过载文案                                             |
| `packages/web-shell/client/i18n-ru-part3.ts`                                           | `ru` 过载文案                                                |
| `packages/web-shell/client/i18n.test.ts`                                               | 四语言插值与 parity 测试                                     |
| `packages/web-shell/client/utils/scheduledTaskManualRun.ts`                            | 共享的手动任务消费/派发前过载拒绝守卫                        |
| `packages/web-shell/client/utils/scheduledTaskManualRun.test.ts`                       | 共享 helper 过载拒绝与健康放行对照测试                       |
| `packages/web-templates/src/export-html/build.mjs`                                     | 合并树导出体积预算重记                                       |
