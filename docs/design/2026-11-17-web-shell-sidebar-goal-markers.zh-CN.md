# Web Shell 侧栏目标标记

[English](2026-11-17-web-shell-sidebar-goal-markers.md) | [简体中文](2026-11-17-web-shell-sidebar-goal-markers.zh-CN.md)

状态：提案（2026-11-17）。Goal 展示增强（#17349，已合入为 2b4ce375d2）的续作；该 PR 的「非目标」段明确延后了本特性。

## 问题

Goals 页（#17230、#17291、#17349）展示每个已加载会话的目标，带生命周期色调、预算条与会话跳转——但前提是用户先打开它。侧栏会话列表才是用户日常扫视找会话的界面，却看不出哪些会话承载目标。跨项目跑多个目标的用户必须打开 Goals 页（或逐个会话）才能想起目标在哪；而未加载会话里暂停的目标，除了 Goals 页的仅存活列表外，在任何地方都不可见。

## 现状

引用以符号名而非行号标注——行号随 `main` 漂移，符号名可在所指文件中解析。

- 目标运行时以会话为作用域，归各 `qwen --acp` 子进程所有；serve 进程不持有可变副本（`packages/cli/src/serve/routes/goals.ts`）。`GET /goals` 对每个**存活**会话扇出一个 `sessionGoalGet` IPC 探针（并发受限），既有成本又看不见未加载会话。
- 目标状态以 `goal_state` 系统记录持久化在会话转录中。唯一日志写入点是 `ChatRecordingService.recordGoalState`（`packages/core/src/services/chatRecordingService.ts`）；恢复时从新到旧扫描记录（`goals/goal-persistence.ts`）。今天没有独立的目标文件。
- 会话目录（`POST /sessions/catalog` → `packages/cli/src/serve/server/session-list.ts`）已经从磁盘读取每会话 sidecar 文件并合并进摘要：PR 绑定（`<chatsDir>/<sessionId>.pr.json`，由 `enrichPrSidecars` 读取）、worktree 信息（`enrichWorktreeSidecars`）、标题 sidecar。路径助手在 `SessionService`（`packages/core/src/services/sessionService.ts`，`getPrSessionPathForState` / `getPrSessionPathForArchiveState` 及归档态变体）；PR sidecar 在四个生命周期站点搬移/删除：`removePrSidecars`（删除会话，两个归档态）、`moveArchiveSidecars`（通用归档/恢复搬移）、以及 `archiveSessions` / `unarchiveSessions` 的归档冲突与恢复冲突分支（各为被丢弃谱系调用 `moveSessionPrSidecar`）。
- 存活 sidecar 更新无需轮询即可传播：子进程自己写 PR sidecar，触发 `SessionService.emitSessionPrBound`（经 `setSessionPrBoundCallback` 注册），ACP 会话从 `Session.#registerBackgroundNotificationCallbacks` 发送 `qwen/notify/session/pr-binding`（`packages/cli/src/acp-integration/session/Session.ts`），bridge 校验后标记目录时钟（`packages/acp-bridge/src/bridgeClient.ts` 的 `pr-binding` ext 通知处理器），监视版本的客户端随之重取目录。
- 摘要 wire 类型携带 `prs?: DaemonSessionPrInfo[]`（`packages/sdk-typescript/src/daemon/types.ts`，`DaemonSessionSummary`）；侧栏在两种布局变体的会话标题旁渲染 `SessionPrBadge`（`WebShellSidebar.tsx` 的归档行与活跃行渲染分支）。
- 客户端已有 #17349 的 `goalStatusTone` 与共享执行状态色板（`GoalStatusStrip.tsx`），以及全应用 Goals 图标 `Target`。

## 目标

- 一眼看出侧栏哪些会话承载目标及其生命周期状态，与 Goals 页同一颜色语言。
- 覆盖未加载与已归档会话，不只是存活会话。
- 不新增轮询，不在目录读取里加 IPC 探针。
- 转录保持权威；标记是可滞后的投影。

## 非目标

- 不改 Goals 页、目标控制语义、转录 schema。
- 不在分组头部或导航栏加目标标记——仅会话行（两种布局变体）。
- 侧栏不带预算数字；标记只承载身份+状态，Goals 页仍是详情界面。
- 已完成目标不显示标记：两个 Goals 列表都过滤 `complete`（daemon 既有策略），侧栏遵循同一策略。

## 改动方案

### Core：目标 sidecar 投影

- 新增 `session-goal-sidecar.ts`，与 `session-pr-service.ts` 并列：小 JSON 投影 `{ v: 1, goalId, status, objective, updatedAt }`，原子写、容忍 ENOENT 的读（「无目标」）、归档搬移助手——镜像 PR sidecar 服务的形态。
- `SessionService` 新增 `getGoalSessionPathForState` / `getGoalSessionPathForArchiveState`，返回 `<chatsDir>/<sessionId>.goal.json`；目标 sidecar 在与 PR sidecar 相同的四个生命周期站点搬移/删除：`removeGoalSidecars`（删除会话，两个归档态）、`moveArchiveSidecars` 中的目标搬移（通用归档/恢复搬移）、以及 `archiveSessions` / `unarchiveSessions` 的归档冲突与恢复冲突分支。两个冲突分支做调和而非盲搬：`reconcileGoalSidecarOnConflict` 保留存活转录的投影（存活方有 sidecar 时删除被丢弃谱系的 sidecar，仅当存活方没有时才搬入），镜像 `reconcileTitleSidecarOnConflict`，使被删除谱系无法覆盖存活方的标记。
- `ChatRecordingService.recordGoalState` 在严格日志追加成功后写投影：载荷快照有目标 → upsert sidecar；`snapshot.goal === null`（清除）→ 删除。写入尽力而为：sidecar 失败只记日志，绝不让日志失败——转录仍是权威记录，标记滞后或缺失与 PR 徽章已接受的降级模式相同。
- 恢复本身不写任何东西（运行时的不变量）；改由 `Config.initializeGoalRuntime` 在 `goalRuntimeReady` 落定后经 recorder 的公开方法 `refreshGoalProjection` 刷新一次投影。本特性之前记入日志的会话在下次加载时即获得标记，无需等待下一次状态转换。
- `SessionService` 新增 `emitSessionGoalChanged` / `setSessionGoalChangedCallback`，镜像 PR 绑定回调对；`Config.relocateWorkingDirectory` 与携带 PR 绑定回调一样把该回调带到替换后的服务实例。

### ACP 会话 + bridge：目录时钟通知

- ACP 会话把回调接到尽力而为的 `qwen/notify/session/goal-changed` ext 通知 `{ v: 1, sessionId }`——与 pr-binding 同样的发后不管形态。只带会话 id：没有任何消费方渲染通知里的值，status 字段只会徒增校验面。
- bridge 校验 `v` 与 `sessionId`、检查会话归属，然后标记目录时钟；通知**不**携带投影本身。磁盘 sidecar 才是目录读取的来源，与 PR 绑定完全一致——通知丢失只会把标记延迟到下次目录刷新。

### Serve：目录读 sidecar

- `session-list.ts` 在 PR sidecar 旁按会话读目标 sidecar（同样的归档态参数化、同样的 ENOENT → 缺席语义），在摘要上置 `goal`。无 IPC、无转录解析。

### SDK：摘要字段

- `DaemonSessionSummary` 在 `prs` 旁新增 `goal?: { status: GoalStatus; objective: string; updatedAt: string }`（`DaemonSessionGoalInfo`）。处处可选；旧 daemon 省略该字段，不渲染标记。

### Web Shell 客户端：标记

- 会话目录 store 无需改动：它整体 spread 目录摘要（`...session`），`goal` 与 `prs` 一样自然透传。E2E 经真实 store 钉住该透传。
- 新增 `SessionGoalMarker`，在两种侧栏布局变体中渲染于 `SessionPrBadge` 旁：`Target` 图标按 `goalStatusTone(status)` 着色（running / attention；`complete` 在渲染前过滤，与 Goals 列表一致），tooltip 带本地化状态与目标内容，可访问名同时携带两者。点击标记打开会话——与行点击同一动作，标记是带标签的快捷入口而非新导航目的地。
- i18n：en / zh / ru 的 tooltip/aria 键，状态词复用现有 `goal.status.*` 字符串。

## 设计决策

- **sidecar 投影，而非探针。** PR 绑定特性已验证该模式：每会话 sidecar + 目录读取 + 时钟标记通知。它覆盖未加载/已归档会话（Goals 列表做不到），每次目录取数每会话只多读一个小文件，零 IPC。按目录调用重解析转录因成本被否；仅存活的 serve 缓存被否，因为未加载会话里暂停的目标正是标记必须呈现的场景。
- **日志钩子，而非运行时多处钩子。** `recordGoalState` 是所有状态转换（创建、编辑、暂停、继续、清除、用量受限结算，以及每轮 `turn_finished` 重发布）必经的唯一写入点。一处钩子覆盖全部路径；在 reducer 各调用方分散写入会漂移。
- **转录保持权威。** sidecar 在严格追加之后写，绝不反向门禁。恢复仍读记录；sidecar 只服务列表。追加与 sidecar 写之间崩溃会留下滞后标记，由下次转换或加载修复——与 PR 徽章的一致性契约相同。
- **变更按路径进程内序列化。** 运行时会自动结算界限，转换可能快于磁盘写入；两个盲覆盖竞争可能让较旧的投影最后落盘。按路径的 promise 队列保证写/删有序（失败的变更不阻塞后续）。无需跨进程锁：给定会话的 sidecar 只由该会话子进程写；daemon 的归档搬移有所有权围栏，被搁浅的投影由下次转换/加载修复。
- **通知携带时钟标记，而非数据。** 镜像 pr-binding 保持单一传播机制与单一校验面；目录读取仍是投影值的唯一来源。
- **complete 隐藏，done 色调在此不用。** 与两个 Goals 列表过滤 `complete` 一致；完成的目标不再充当导航线索。sidecar 仍记录 `complete`，策略放在 UI 而非持久层。
- **标记点击打开会话。** 行点击本就如此；标记作为同一动作的第二入口，是带完整可访问名的标签快捷方式，而非发明新目的地。Goals 页仍经现有侧栏入口一键可达。

## 涉及文件

- `packages/core/src/services/session-goal-sidecar.ts`（新增）+ 测试，经 core barrel 导出
- `packages/core/src/services/sessionService.ts`（路径助手、生命周期搬移/删除、回调对）
- `packages/core/src/services/chatRecordingService.ts`（日志钩子 + 公开 `refreshGoalProjection`）
- `packages/core/src/config/config.ts`（恢复时投影刷新、relocation 回调携带）
- `packages/cli/src/acp-integration/session/Session.ts`（通知接线 + 清理）
- `packages/acp-bridge/src/bridgeClient.ts`（通知处理）+ `bridgeTypes.ts`（`BridgeSessionGoalInfo`、摘要字段）
- `packages/cli/src/serve/server/session-list.ts`（sidecar 读取+合并，三条列表路径）
- `packages/sdk-typescript/src/daemon/types.ts` + `daemon/index.ts`（`DaemonSessionGoalInfo`、摘要字段、导出）
- `packages/web-shell/client/components/SessionGoalMarker.tsx` + `.module.css`（新增）+ 测试、`sidebar/WebShellSidebar.tsx`（两种变体）、`i18n.tsx` + `i18n-ru-part3.ts`（en/zh/ru 键）
- 会话目录 store 不改动（spread 透传，E2E 经真实 store 钉住）
- 各包测试与源码同置；E2E 在 `packages/web-shell/client/e2e/`（mockDaemon sidecar 夹具）与真实 daemon rig。

## 约束与风险

- 跨包改动（core / acp-bridge / cli / sdk-typescript / web-shell）。维护者作者；涉及的 core 路径是记录/服务层，不是目标 reducer 或控制语义。
- 本特性之前记入日志的遗留会话，在下次加载或转换前不显示标记（恢复时写）。已记录的缺口，不做批量回填任务。
- sidecar 写不限于人类尺度的转换。目标活跃时，运行时在每轮结束重发布快照（cause `turn_finished`，刷新 `turnCount` / `activeTimeMs` / `tokensUsed`），每次重发布都经过 `recordGoalState`。因此活跃目标会话每轮重写一次 sidecar 并标记一次目录时钟——每轮每活跃目标会话一次小 fsync 写加一次目录重取，此外还有设/暂停/继续/清除转换。这与转录本就做的每轮日志相同；投影只增加一次文件写与一次时钟标记，不新增日志记录。暂停/阻塞的目标不跑轮，故无每轮成本。
- 卡死的子进程不会拖住目录：读取纯磁盘，通知尽力而为。

## 验证计划

- 单测：sidecar 写/读/搬移/删除（core）、日志钩子 upsert/删除含尽力而为的失败隔离、恢复时写、session-list 合并（有/无/已归档）、bridge 通知校验（坏 v/sessionId/status 拒绝、好的标记时钟）、SDK 类型面、侧栏标记渲染（各状态色调、tooltip、可访问名、点击打开会话、complete 隐藏、无目标缺席）。
- E2E（mockDaemon）：带目标 sidecar 的目录夹具 → 标记按色调渲染；goal-changed 通知刷新标记；清除移除标记。
- 真实环境：隔离 daemon + HTTP 真实会话/目标；设置时标记出现、暂停/继续色调翻转、清除消失、daemon 重启后仍在（磁盘 sidecar）、未加载会话也显示。截图上传 assets 分支并对账。
- 承重钉子的变异见证（日志钩子、sidecar 读取、色调映射、complete 过滤），字节级还原。

## 验收标准

- 会话恰有非 complete 目标 sidecar 时，侧栏会话行在两种布局变体显示生命周期着色的目标标记。
- 标记在目标转换时出现/更新/消失，无需新轮询。
- 未加载与已归档会话从磁盘显示标记。
- 已完成目标与无目标会话不显示标记；旧 daemon 侧栏渲染不变。
- 转录 schema 与 Goals 页不变；目录读取零新增 IPC。

## 开放问题

- 无阻塞项。标记置于 PR 徽章旁已定；若两徽章在窄行拥挤，沿用现有行溢出行为（本特性不新增截断逻辑）。
