# Web Shell Goals 页：multi-workspace 支持

[English](2026-11-14-web-shell-goals-multi-workspace.md) | [简体中文](2026-11-14-web-shell-goals-multi-workspace.zh-CN.md)

状态：已实现、待评审（2026-11-14）。「现状」声明已按 `origin/main`
`114694062b` 核实；实现基于 `23ccf4d0b7`（两个提交之间 goals 各面无变化）。

## 问题

Web Shell 侧栏「Goals」页目前**只列 primary workspace** 的活跃 Goal。在
multi-workspace daemon 上：

- secondary workspace 里运行的 Goal 在页面上不可见——尽管 Goal 运行时本身
  是会话级、与 workspace 无关的。
- 页面的创建表单以当前选中的 workspace 为目标
  （`resolveWorkspaceMaintenanceTargetCwd`），因此选中 secondary 时创建的
  Goal 永远不会出现在页面自己的列表里。

姊妹页面「Scheduled tasks」已经用「workspace 限定 daemon 路由 + 客户端聚
合」解决了同一问题。Goals 应沿用该模式。

## 现状

按 `origin/main` `114694062b` 核实（行号取自该提交）：

| 层                                                                                                      | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal 运行时                                                                                             | 会话级，由各 `qwen --acp` 子进程自持。任何 workspace 的会话都能跑 Goal。无需改动。                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /goals`（`packages/cli/src/serve/routes/goals.ts`）                                                | 在 `server.ts` 只注册一次（`registerGoalsRoutes`，3935 行），绑定 `boundWorkspace: primaryBoundWorkspace`、`bridge: primaryBridge`、primary 信任门与 primary generation 断言。枚举 `bridge.listWorkspaceSessions(boundWorkspace)`，过滤 agent-host 会话，fan-out `sessionGoalGet` 探针（并发 10），失败探针计入 `droppedCount` 后丢弃。                                                                                                                                                                                 |
| 会话级 Goal 路由（`routes/session.ts` 的 `POST/GET /session/:id/goal`、`POST /session/:id/goal/clear`） | 已具备 workspace 感知：`withOwnerMutableSession` / `withOwnerReadSession` 跨 workspace 解析属主运行时（`resolveLiveSessionRuntime`）。有 `multi-workspace-sessions.test.ts` 钉子。无需改动。                                                                                                                                                                                                                                                                                                                            |
| 客户端 `listGoals()`（`packages/web-shell/client/daemon/workspace/actions.ts`，1026 行）                | 固定请求无后缀 `/goals`；无 `workspaceId` 参数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GoalsDialog`（`packages/web-shell/client/components/dialogs/GoalsDialog.tsx`）                         | 每 10 s 轮询 `actions.listGoals()`；卡片以 `sessionId` 为键；控制走上述会话级路由；创建委托 App 的 `onCreateGoal(condition)`。无 workspace 感知。                                                                                                                                                                                                                                                                                                                                                                       |
| Scheduled-tasks 参照模式                                                                                | daemon：`registerWorkspaceQualifiedScheduledTasksRoutes`（`routes/scheduled-tasks.ts`，2312 行）经 `resolveWorkspaceRuntimeWithLiveCompatibilityFromParam` + `requireTrustedWorkspaceRuntime` 解析 `:workspace`。客户端：`listScheduledTasks(workspaceId?)` 为 secondary 构造 `/workspaces/:id/scheduled-tasks`，primary 保留无后缀路由；`ScheduledTasksDialog` 对 `operableWorkspaces`（primary + 受信 secondary）fan-out，给每条任务打 `workspaceId`/`workspaceCwd` 标签，卡片加徽章，创建表单提供 workspace 选择器。 |

两个 primary 读面都带信任门：primary scheduled-tasks 列表经与限定路由相同
的 `requireTrustedWorkspaceRuntime` 检查解析运行时，primary `GET /goals`
保留 `isWorkspaceTrusted` 门。（二者在运行时不活跃时的状态码不同——
scheduled tasks 回 503，goals primary 列举不做运行时查询。）本设计保留各
面现有的门。

## 目标

- Goals 页列出每个可操作 workspace（primary 加所有受信 secondary）的非终
  态 Goal；存在多个 workspace 时每张卡片标注所属 workspace。
- 创建表单可指向任一可操作 workspace；默认仍是当前选中的 workspace。
- 暂停 / 恢复 / 编辑 / 清除对任何 workspace 的 Goal 保持可用（会话级控制
  路由已能解析属主）。
- 单 workspace 部署保持今天的行为与外观（无徽章、无选择器）。锁定到
  primary 的部署保持无后缀路由；锁定到 secondary 的部署经该 workspace 的
  限定路由列举，同样无徽章、无选择器。

## 非目标

- 不改 Goal 运行时、会话级控制路由、primary `GET /goals` 契约。
- 不做 daemon 侧跨 workspace 聚合：fan-out 留在客户端，与 scheduled tasks
  完全一致。
- 页面 UI 不列内部「Conversations」（live）workspace 的 Goal：页面聚合
  `ordinaryWorkspaces`，其中不含 live 条目，与 scheduled tasks 一致。限定
  daemon 路由本身仍支持 live-conversation 运行时的只读列举，镜像限定
  scheduled-tasks 解析器。
- 不新增 telemetry 路由条目：`/goals` 与 `/scheduled-tasks` 今天都不在
  telemetry 路由表里；限定 goals 路由与之保持一致。

## 提议的改动

### daemon：workspace 限定的 goals 列举

重构 `routes/goals.ts`，共享探针/收集/投影逻辑，并新增第二个注册：

- `registerGoalsRoutes` 保持 primary 契约逐字不变（路径、信任门、
  generation 断言、响应形状 `{ v: 1, goals, droppedCount }`）。
- 新增 `registerWorkspaceQualifiedGoalsRoutes(app, { workspaceRegistry })`，
  注册 `GET /workspaces/:workspace/goals`。每个请求：
  1. 用 `resolveWorkspaceRuntimeWithLiveCompatibilityFromParam` 解析运行时
     （未知或非法选择器 → 400 `workspace_mismatch`；运行时未激活 → 503
     `workspace_runtime_unavailable`；Conversations 运行时不可用 → 503
     `conversation_runtime_unavailable`）。
  2. 经 `requireTrustedWorkspaceRuntime` 要求信任（403
     `untrusted_workspace`）。
  3. 对 `runtime.bridge` 与 `runtime.workspaceCwd` 跑共享列举逻辑；运行时
     带 `generationGuard` 时以其为 generation 断言。
- 共享列举保持今天的语义：过滤 agent-host 会话、探针并发 10、失败探针丢弃
  并计数、按设置时间倒序、只读。

`server.ts` 在现有 `registerGoalsRoutes` 调用旁注册限定面，传入与其他限定
路由相同的 `workspaceRegistry`。

### 客户端 SDK：workspace 感知的 `listGoals`

- `daemon/workspace/types.ts` 与 `actions.ts` 中的
  `DaemonWorkspaceActions.listGoals(workspaceId?: string)`：带 `workspaceId`
  时请求 `/workspaces/<编码 id>/goals`；不带时保持 `/goals`。响应解析与快
  照过滤与今天一致。
- `DaemonGoal` 增加可选 `workspaceCwd?: string`，由页面在每个列举分支填充
  （daemon 载荷不携带）。与 `DaemonScheduledTask` 不同，不加 `workspaceId`
  字段：Goal 变更走按属主解析的会话级路由，没有任何消费方读 workspace id。

### GoalsDialog：聚合、徽章、选择器

镜像 `ScheduledTasksDialog` 的 multi-workspace 形状：

- 新增可选 props `workspaces?: DaemonWorkspaceCapability[]` 与
  `lockedWorkspace?: DaemonWorkspaceCapability`，由 App 按 scheduled tasks
  的同一方式传入（`lockedWorkspaceCwd ? visibleWorkspaces :
ordinaryWorkspaces`，以及 `lockedWorkspaceCapability`）。
- 派生状态：`isMultiWorkspace = !lockedWorkspace && workspaces.length > 1`；
  `operableWorkspaces = workspaces.filter(ws => ws.primary || ws.trusted)`；
  `workspaceActionId(ws) = ws.primary ? undefined : ws.id`。
- 重载：锁定 → 单次限定（或 primary）请求，打上锁定 workspace 的 cwd；
  多 workspace → 对 `operableWorkspaces` 用 `Promise.all` fan-out，给每条
  Goal 打 workspace 标签，`droppedCount` 求和；部分失败时留住其他
  workspace 的 Goal，第一个错误带上失败 workspace 的显示名；全部失败
  （每个列举都 reject）时保留上一份列表而不清空页面，与单/锁定视图既有
  的保留行为一致。单 workspace → 今天的无后缀请求，daemon 恰好广告一个
  workspace 时打上该 primary 的 cwd（不广告 workspace 列表的 daemon 保持
  无标签的旧形状）。三个分支都打标签，镜像 `ScheduledTasksDialog`，使打开
  Goal 会话时即使无徽章也带上 workspace 上下文。现有单调重载序号与自链式
  10 s 轮询保持不变。
- 卡片：多 workspace 视图下，卡片 footer 起始处加共享 `WorkspacePill`
  徽章（Scheduled Tasks 页同用）。卡片键仍是 `sessionId`（会话 id 是
  daemon 全局的，不同于 scheduled-task id）。
- 未受信 secondary 被排除在 fan-out 之外，聚合视图显示计数提示
  （`goals.untrustedSkipped`），而不是对从未读取的 workspace 显示干巴巴
  的「没有目标」空态。
- 创建表单：多 workspace 视图下提供 workspace 选择器，默认当前选中的
  workspace（若可操作），否则 primary。App 通过 `defaultWorkspaceCwd`
  prop 提供该默认值。选择器与徽章标签经 `disambiguateWorkspaceLabels`
  消歧，两个同 basename 的 checkout 在原生 `<select>`（无法承载 tooltip）
  里仍可区分。编辑表单无选择器——Goal 的会话已确定其 workspace。
- `onCreateGoal` 变为 `(condition: string, workspaceCwd?: string)`。
  `onOpenSession` 变为 `(sessionId: string, workspaceCwd?: string)`，App
  在 Goal 自己的 workspace 里加载会话，与 scheduled-tasks 页完全一致。
  控制（`controlGoal`、清除）不变：会话级路由自行解析属主运行时。

### App 接线

- 向 `GoalsDialog` 传 `workspaces` / `lockedWorkspace` /
  `defaultWorkspaceCwd`（与 scheduled-tasks 页相同的 workspace 数组）。
- `onCreateGoal(condition, workspaceCwd?)`：选择器提供了 cwd 时在该
  workspace 创建会话；否则保持 `resolveWorkspaceMaintenanceTargetCwd()`。
  搁浅会话恢复仅在选择器仍指向其所属 workspace 时复用搁浅会话；重试时若
  选择器改指其他 workspace，则在那里新分配会话，而不是静默把 Goal 建在
  上一个 workspace。owner 守卫与跳转聊天流程不变。
- `onOpenSession` 带上 Goal 被打标签的 `workspaceCwd`，使
  `loadSidebarSession` 切换到 Goal 的 workspace 上下文，镜像
  scheduled-tasks 的接线。

### i18n

en、zh、ru 三个语言包各新增 `goals.workspace`（选择器标签）与
`goals.untrustedSkipped`（被跳过 workspace 提示）——ru 语言包翻译了整个
Goals 对话框，因此补全这两个键，而不是在整片俄文里留一个英文回退。
workspace 显示名来自现有 `workspaceLabel` / `disambiguateWorkspaceLabels`
工具；徽章提示是原始 cwd。

## 设计决策

1. **客户端 fan-out，而非 daemon 聚合路由。** 与 scheduled tasks 一致；
   daemon 读面保持按 workspace 划分，单个 workspace 失败时优雅降级而不是
   整列表失败。
2. **primary 保留无后缀、带信任门的路由。** 客户端对 primary 传
   `undefined`，与 scheduled tasks 完全一致。两个 primary 读面都带信任门，
   因此未受信 primary 的 fan-out 成员返回 403，表现为页面的部分加载错误，
   其他 workspace 照常渲染——把 primary 留在 fan-out 里让这种不可读「响亮
   地」暴露，而不是静默丢掉它的 Goal。这是 primary 的既有行为，不是回归。
3. **daemon 载荷不加 workspace 字段。** 客户端在每个列举分支给 Goal 打
   `workspaceCwd` 标签；primary 契约保持字节级兼容。不携带 `workspaceId`，
   因为 Goal 变更走按属主解析的会话级路由，而非 workspace 限定路由。
4. **控制路由不动。** 按属主解析的会话级路由已跨 workspace 可用：
   `multi-workspace-sessions.test.ts` 钉住跨运行时的 clear 路径，跨
   workspace 暂停用例钉住控制路径（`controlSessionGoal` 到达 secondary 的
   bridge，绝不碰 primary）。新增限定控制路由只会重复这套机制。
5. **live-conversation workspace：页面不列，路由支持。** 与 scheduled
   tasks 同一划分：UI 聚合 ordinary workspace；限定解析器仍以只读方式处理
   内部运行时。

## 涉及文件

- `packages/cli/src/serve/routes/goals.ts`（共享列举 + 限定注册，诊断带
  workspace id）与 `goals.test.ts`
- `packages/cli/src/serve/server.ts`（注册限定面）
- `packages/cli/src/serve/multi-workspace-sessions.test.ts`（跨 workspace
  Goal 控制钉子）、`workspace-qualified-rest.test.ts`（createServeApp 级
  注册 + 信任钉子）
- `packages/web-shell/client/daemon/workspace/types.ts`、`actions.ts`、
  `goals.actions.test.ts`
- `packages/web-shell/client/components/WorkspacePill.tsx` +
  `.module.css`（共享徽章，Scheduled Tasks 同用）
- `packages/web-shell/client/components/dialogs/GoalsDialog.tsx`、
  `GoalsDialog.test.tsx`、`GoalsDialog.module.css`（选择器样式）；
  `ScheduledTasksDialog.tsx` / `.module.css`（改用共享徽章）
- `packages/web-shell/client/App.tsx`（props + 创建接线）、`App.test.tsx`
  （打开会话的 workspace 上下文钉子）
- `packages/web-shell/client/i18n.tsx`（新键，en/zh/ru）、`i18n.test.ts`
- `packages/web-shell/client/e2e/utils/mockDaemon.ts`（限定 `/goals` 分支
  按注册 + 信任判门；Goal 操作按 session id 解析目标快照）及 goals
  multi-workspace E2E spec

## 约束与风险

- **轮询成本。** 页面每 10 s 轮询；聚合使其乘以可操作 workspace 数，而每
  次列举本身又 fan-out 到 live 会话（每 workspace 并发 10）。以今天的
  workspace 数量可接受；自链式轮询本就防止重叠 fan-out。
- **workspace 列表过期。** capabilities 刷新可能在页面打开期间增删
  workspace；重载回调依赖 memo 化的 workspace 数组，变化会重跑挂载
  effect（与 scheduled tasks 一致）。
- **丢弃探针计数。** `droppedCount` 变为跨 workspace 求和；降级横幅文案
  仍按计数表述，保持准确。
- **未受信 secondary。** 被排除在 `operableWorkspaces` 之外；聚合视图显示
  计数提示，使缺席有交代。限定路由对直接读返回 403。

## 验证计划

- 单元：限定面的 daemon 路由测试（正常路径、信任 403、未知选择器 400、
  未激活运行时 503、generation 关闭 503、agent-host 过滤、丢弃探针、
  live-conversation 运行时）；客户端 action URL 测试；GoalsDialog 聚合/
  徽章/选择器/错误测试；既有 primary 面测试必须原样通过。
- E2E：mock-daemon Web Shell 跑两个注册 workspace、两边各有 Goal，验证聚
  合、徽章、选择器定向创建、跨 workspace 暂停/清除；单 workspace 回归。
- `npm run build && npm run typecheck`、每个改动文件的聚焦 vitest 套件、
  lint/format。

## 验收标准

- multi-workspace daemon 上，Goals 页显示 primary 与每个受信 secondary 的
  非终态 Goal，各标注所属 workspace。
- 经选择器创建的 Goal 落在所选 workspace，页面下次轮询即列出。
- 暂停/恢复/编辑/清除对 secondary workspace 的 Goal 可用。
- 单个 workspace 列举失败不清空其他 workspace；错误与丢弃计数可见。
- 单 workspace 视图不变（无徽章、无选择器、无后缀路由）。锁定到 primary
  的部署保持无后缀路由；锁定到 secondary 的部署走该 workspace 的限定路
  由，无徽章、无选择器。
- primary `GET /goals` 响应契约不变。

## 开放问题

- 提案时无。聚合 UX 沿用 scheduled-tasks 先例；日后若要按 workspace 过
  滤，可在已打标签的列表上直接加，无需 daemon 改动。
