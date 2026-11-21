# Web Shell 本地 daemon 工作区产物库

[English](2026-11-21-web-shell-workspace-artifact-library.md) | [简体中文](2026-11-21-web-shell-workspace-artifact-library.zh-CN.md)

状态：提案（尚未实现）。

## 问题陈述

Web Shell 的本地 daemon 模式只在会话内展示产物：按轮芯片、聊天头部入口打开的
右栏产物列表 tab、会话列表的产物数量。想找更早会话产出的交付物，必须先
打开那条会话；归档会话的产物在显式解归档并加载之前不可达。Managed 模式已有
工作区级产物库对话框（[managed 工作区产物库](managed-workspace-artifact-library.zh-CN.md)，
#17728）；本地 daemon 具备同一体验的后端，却没有 Web Shell 界面。

用户找的是交付物（「上周那份报告」），不是会话。跨历史浏览不应要求加载每条
对话——加载会额外创建 agent、仅为浏览输出就改变运行状态，这正是持久化产物库
路由要避免的问题（[会话产物库](session-artifact-library.zh-CN.md)）。

## 现状（在 main `232496db23` 上核实）

会话级界面（本地 daemon）：

- 按轮芯片（`TurnOutputs`）绑定 transcript replay。
- 右栏产物列表 tab（`ArtifactsListPanel.tsx`），由聊天头部入口打开。恢复响应
  内嵌产物列表（[早会话产物头部入口](2026-11-15-early-session-artifact-entry.zh-CN.md)
  的范围 A），会话列表携带 `artifactCount` / `artifactCountPending`
  （范围 B，[会话列表产物摘要](2026-11-17-session-list-artifact-summary.zh-CN.md)）。
- 以上全部要求会话已加载；`useSessionArtifacts` 的刷新受连接、`catchingUp`
  与 `session_artifacts` 能力门控。

工作区级后端（为 DAC 而建，Web Shell 未消费）：

- `GET /workspaces/:workspace/artifact-library`（全部会话）、
  `POST /workspaces/:workspace/artifact-library/query`（1–100 个 sessionId）、
  `POST /workspaces/:workspace/artifact-library/delete`（1–100 对）；能力
  `workspace_artifact_library` 与 `workspace_artifact_library_stream`
  （[工作区产物库](workspace-artifact-library.zh-CN.md)）。
- envelope 携带必填 `session` 对象（`displayName?`、`createdAt`、
  `archiveState`、`sourceType`、`sourceId?`）。读取覆盖运行中、冷、归档会话，
  不 attach/spawn/解归档；渐进 SSE（`start` / `session` / `session_error` /
  `complete` / `error`）；按 runtime 的有界缓存；JSON 全量扫描跳过不存在或
  属于其他项目的会话。
- 没有 SDK 封装（后端设计明确延期），`packages/web-shell` 也没有任何
  artifact-library 消费。

Managed 先例：

- `ManagedArtifactLibraryPage.tsx`（#17728）：工作区级、最新优先的游标分页，
  每行标注来源会话，经既有字节路由预览/下载；只读。parity 将
  `workspace_artifact_library` 记为 `managed` 立场；
  `workspace_artifact_library_stream` 保持缺席（JSON 分页，无渐进扫描）。

内容路径：

- `GET /session/:id/artifacts/:artifactId/content` 要求运行中会话
  （`withOwnerReadSession`）。
- workspace 存储的产物经带工作区归属检查的文件读取预览
  （`useArtifactWorkspaceTarget.ts`），与会话加载无关。

## 目标

- 为本地 daemon 模式提供一个工作区作用域的只读产物库页面，对齐 managed 产物库
  的产品形态：当前工作区全部运行中、冷、归档会话的产物按最新优先排列，每行
  标注来源会话。
- 浏览不加载会话；扫描期间渐进出结果；逐会话失败显式可见。
- workspace 存储的产物免加载预览；冷 managed 快照与会话经既有打开/解归档
  流程到达。
- 不新增后端路由；不改变会话级界面与 managed 产物库。

## 非目标 / 范围边界

- 不做删除、置顶、视图偏好 UI。daemon 批量删除路由已存在，留待后续切片
  （managed 产物库同样只读）。
- 不新增内容路由或内容语义；冷 managed 快照预览经会话跳转。
- 不做实时订阅：有限快照扫描加手动刷新。打开会话的实时更新仍走既有会话路径。
- 不做游标分页：daemon 产物库是全量/批量扫描，不是 keyset 分页；渐进 SSE 是
  交付机制。
- 不做跨工作区聚合；页面查询 shell 当前作用域的工作区。Managed 工作区保留
  自己的产物库对话框。
- 不做磁盘索引；不改变按轮芯片、右栏 tab、头部入口、会话列表数量。

## 提议方案

### SDK：为产物库读取定型与封装

- `packages/sdk-typescript/src/daemon/types.ts`：产物库 envelope
  （`DaemonSessionArtifactsEnvelope` 加必填 `session` 元数据）、全量查询结果
  `{ v: 1, sessions, errors }`、成员错误形状
  `{ sessionId, status, code, message }`、SSE 事件载荷
  （`start` / `session` / `session_error` / `complete` / `error`）。
- `WorkspaceDaemonClient`（`DaemonClient.ts`）：`artifactLibrary()`——全量
  GET，JSON；`artifactLibraryStream()`——同一 GET 带
  `Accept: text/event-stream`，经既有 SSE 解析 helper 产出定型事件。调用方
  先从 `capabilities()` 预检 `workspace_artifact_library` /
  `workspace_artifact_library_stream`。只读：本切片不封装删除。

### 客户端：渐进扫描 hook

- `useWorkspaceArtifactLibrary(workspaceTarget)`：能力门控；声明
  `workspace_artifact_library_stream` 时 SSE 优先，否则 JSON 回退；按
  `sessionId` 累积 envelope；展平产物并按最新优先排序（`updatedAt` 降序、
  `createdAt` 回退、`(sessionId, artifactId)` 稳定 tiebreak）；跟踪扫描进度
  （`total` 来自 `start`；仅 `complete` 表示终止）；未收到 `complete` 的断连
  或终止 `error` 将结果标记为部分并给出重试。不轮询。
- 扫描 generation 所有权：每次扫描——首次加载、手动刷新或工作区切换——都
  中止上一次扫描，并递增一个绑定工作区键的单调 generation
  （`ScanOwner = { workspaceKey, generation }`）。每个事件与终态提交
  （`start` / `session` / `session_error` / `complete` / `error`）都经过
  所有权检查：signal 未中止、工作区键匹配、generation 与当前扫描一致。
  abort 本身不是所有权证明——传输层可能在 abort 之后仍投递排队事件；迟到的
  `complete(A)` 不得终止更新的刷新 B，迟到的 `session(A)` 不得覆盖 B 的更新
  结果。A→B→A 的工作区切换不得复活旧的 A 扫描：需要 generation 身份，不能
  只凭工作区键字符串再次相等。
- envelope 与错误按 generation 保存，新扫描开始时整体替换；进度、部分横幅与
  终态永远描述当前 generation，绝不描述已结算但被取代的那一次。
- 会话元数据来自 envelope（不像 managed 页面那样在客户端解析摘要）；
  `displayName` 缺失时回退为缩短的会话 id。
- 无产物的会话不出现在列表里，但仍计入扫描进度。

### UI：整页产物库视图

- 新增 `mainView` `'artifacts'` 与主导航项 `'artifacts'`，沿用
  scheduledTasks / prWatches / goals / workflows 的功能页模式
  （`App.tsx`、`WebShellSidebar.tsx` `DEFAULT_PRIMARY_NAV_ITEMS`、
  customization 类型）。入口仅在声明 `workspace_artifact_library` 时渲染；
  否则隐藏——不做静默的 live-only 回退（产物库设计要求显式升级状态而非部分
  视图；隐藏入口直接避免降级视图）。
- 行：产物图标与标题（`artifactUtils.ts`、`FileTypeIcon`）、大小与更新时间、
  带 `archiveState` 徽标的来源会话标签；点击标签打开会话。单个客户端文本
  过滤器，覆盖产物标题/描述与会话标签。
- 行操作分派复用会话面板的预览路径：workspace 存储的产物经页面自身的工作区
  文件读取 actions 预览/下载（不加载会话）；运行中会话的 managed 快照走既有
  内容路由；冷/归档会话的 managed 快照先跳转到会话（既有打开路径，含归档
  解归档流程），再打开产物；外部 URL 走既有安全链接 opener。分派逻辑目前
  内嵌在 `ArtifactPanel` 的部分，抽取最小共享 helper，不改变会话面板行为。
- 状态：扫描进度（已收到/总会话数）、空工作区、持久化不可用
  （`409 artifact_library_unavailable`）、runtime 不可用
  （`503 workspace_runtime_unavailable`）、请求级错误带重试、逐会话错误摘要
  （`session_error` 行）、流未收到 `complete` 即结束时的部分结果横幅。终态
  措辞区分两种判断：带 `session_error` 行的 `complete` 读作「扫描结束，但有
  逐会话失败」，不是「工作区全部产物已核验」；无错误的 `complete` 读作
  「枚举完成」，不是「T 时刻的原子快照」——扫描期间源是可变的。
- 文案沿用 managed 产物库先例：专用文案模块（EN/ZH/RU）注册进 `i18n.tsx`，
  transcript stub 注册进 `vite.lib.config.ts`，使仅交互态文案不进导出
  transcript 预算，zh-TW 目录条目由 i18n 测试钉住。

## 关键设计决策与理由

- 对齐 managed 产物库的产品形态（最新优先、来源会话标签、只读、经既有内容
  路径预览），让两种模式呈现同一种产物库体验；仅在 daemon 后端不同处适配
  （按会话分组的 envelope、渐进扫描而非游标分页）。
- 原样复用 DAC 后端：本切片只有 SDK 加客户端；协议、信任、缓存与失败语义
  已经设计并测试过。
- SSE 优先、JSON 回退：全量扫描是 O(会话数) 且冷会话要重放转录；渐进渲染让
  大工作区下页面可用。保留有限查询语义：仅 `complete` 终止扫描；断连是部分
  结果，绝不静默当作完成。
- 传输完成不等于视图确立：`complete` 事件只终止拥有当前 generation 的那次
  扫描。每次状态提交的 generation 守卫是纯客户端契约——不新增 daemon
  语义——并由下文的交错测试钉住，使更晚结算的旧请求永远无法确立当前视图。
- 旧 daemon 隐藏入口而非做降级视图：满足「不能静默只返回 live 产物」，又不必
  为一个不存在的功能做升级状态屏。
- 冷 managed 预览走跳转而非新增工作区内容路由：保持切片只读，避免新增内容/
  信任语义；按需加载一条会话是既有用户流程，与为浏览而加载每条会话不同。
- 整页而非对话框或面板 tab：scheduled tasks、PR watches、goals、workflows
  确立了本地 shell 的功能页模式；环境面板与右栏是会话级的，工作区浏览必须
  在没有打开会话时可用。managed 对话框挂在 `ManagedSessionsPage` 内；本地
  shell 没有对等的共享页面。
- 快照加手动刷新：后端提供有限查询而非订阅；打开会话的新鲜度已由会话级
  live 路径处理。

## 涉及文件

- `packages/sdk-typescript/src/daemon/types.ts`、`DaemonClient.ts`
  （`WorkspaceDaemonClient`），及必要的 barrel 导出。
- `packages/web-shell/client/daemon-react-sdk` 工作区面（暴露产物库读取）。
- 新 hook 与页面：`hooks/useWorkspaceArtifactLibrary.ts`、
  `components/artifacts/WorkspaceArtifactLibraryPage.tsx`（加 module CSS）；
  按需从 `ArtifactPanel` 抽取的共享预览分派 helper。
- `App.tsx`（mainView、路由、打开会话接线）、`WebShellSidebar.tsx`（导航
  项）、`customization.tsx`（类型）、`i18n.tsx` 加文案模块、transcript stub、
  `i18n-zh-tw.ts`、`vite.lib.config.ts`、`build-artifact.test.ts`。
- 每个改动行为的同置测试。

## 约束与风险

- 扫描成本：冷会话重放转录（四个并发 worker、按 runtime 的 32 MiB 序列化
  预算缓存；未缓存会话每次查询都重放）。大工作区首次访问可能慢；进度与部分
  渲染只能缓解，不能消除。
- 扫描结果到达时行会重排（SSE 完成序不是展示序）；列表是扫描快照，不是稳定
  分页窗口。
- 全量扫描是枚举完成，不是工作区的原子 as-of 快照：四个 worker 运行期间，
  运行中、冷、归档源都可能变化，各会话 envelope 的读取时刻互不相同。UI 不得
  把结果呈现为一致的 as-of 视图；也不要求后端提供事务语义。
- 产物库投影携带 metadata-only 的 workspace 恢复状态；列表不保证文件新鲜度。
  预览按需读取真实文件，缺失/变化显式报错。
- 快照在刷新前会过期；产物身份是 `(sessionId, artifactId)`，绝不能只用
  `artifactId`。
- 在飞扫描必须在刷新、卸载或工作区变化时中止；状态所有权由上文的
  generation 契约保证，缓存键沿用既有按会话守卫模式。
- 旧 daemon 隐藏入口；客户端不得用 live-only 读取伪造产物库。Managed 模式
  不受影响（其产物库对话框与 parity 立场保持原样）。

## 验证计划

- 单元：SDK 封装请求形状、Accept 头与错误映射；hook SSE 累积、JSON 回退、
  断连判部分、中止、刷新、排序稳定性；页面行/过滤器/状态/操作分派（workspace
  预览 vs live 内容 vs 冷跳转）；导航门控。
- 扫描 generation 所有权的交错见证：（负向）同工作区重叠刷新——扫描 A 先发出
  会话 S 的较旧 envelope，用户刷新，扫描 B 返回更新的 S 与 `complete(B)`，
  随后迟到的 `session(A)` 与 `complete(A)` 从一个 abort 后仍投递排队事件的
  传输层到达；最终行、进度与终态必须只反映 B，与哪个请求更晚结算无关。
  （负向）A→B→A 工作区切换——旧 A 请求不得仅因工作区键再次相等而复活；
  还要求 generation 身份。（正向）单次完成的扫描展示全部成功 envelope、保留
  逐会话错误报告，冷/归档跳转与 workspace 文件预览路径仍可用；当前流断连
  判部分。
- E2E（headless 对真实 daemon；计划在 `.qwen/e2e-tests/`）：含运行中、冷、
  归档会话且带产物的工作区——渐进显示且不加载会话（无 attach/spawn）、归档
  产物可见、workspace 文件免加载预览、冷 managed 跳转后加载再预览、会话标签
  跳转含解归档、能力缺席隐藏入口、持久化不可用与损坏转录的部分失败、未收到
  `complete` 断连的部分横幅。
- 回归：会话面板、芯片、头部入口、会话列表数量不变；managed 产物库不受影响；
  build、typecheck、bundle、lint、format。

## 验收标准

- 页面按最新优先列出当前工作区运行中、冷、归档会话的产物并标注来源会话，
  不加载会话；进度与逐会话错误可见。
- workspace 存储的产物免加载预览；冷 managed 产物经会话跳转到达预览；会话
  标签打开会话（归档经既有解归档流程）。
- 旧 daemon 隐藏入口；无 live-only 回退。流未收到 `complete` 即结束时显示为
  部分结果并可重试。
- 重叠刷新与 A→B→A 工作区往返绝不让被取代的扫描确立行、进度或终态；终态
  措辞区分「枚举完成」与「扫描结束，但有逐会话失败」，绝不声称原子 as-of
  快照。
- build、typecheck、聚焦单测通过；会话级界面与 managed 产物库不变。

## 开放问题

- standalone 主导航默认开启还是 opt-in（提议默认开启，沿用头部入口先例）；
  嵌入式宿主保留显式 items 列表。
- 多工作区 shell 需要页内工作区选择器，还是跟随 overview 的当前工作区上下文
  （提议：跟随当前上下文；选择器延期）。
- 后续切片：批量删除 UI（daemon 路由已存在）、按会话分组视图、置顶/视图偏好。
