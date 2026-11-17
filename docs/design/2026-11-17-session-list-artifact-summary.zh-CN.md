# 会话列表产物摘要：点击即现的头部入口

[English](2026-11-17-session-list-artifact-summary.md) | [简体中文](2026-11-17-session-list-artifact-summary.zh-CN.md)

状态：随本次改动实现。是
[早会话产物头部入口](2026-11-15-early-session-artifact-entry.zh-CN.md)
的后续（该设计的范围 B）。

## 问题陈述

范围 A 把已恢复的 artifact 列表内嵌进 `/session/:id/load` 与 `/resume`
响应，使会话级头部产物入口在 load 响应时刻（实测会话约 450 ms）先于对话正文
渲染。但**点击时刻**仍拿不到数量：会话列表不携带任何产物信息，从点击到 load
响应之间，头部对该会话的产物一无所知。

会话列表已经携带派生的每会话数据（`prs`、`worktree`），从 sidecar 文件尽力
回填。把产物摘要放进同一份元数据，就能在点击会话的瞬间，用侧栏已持有的列表
数据显示头部入口的数量。

## 现状（在 main 的 91690e86e5 上核实）

- 产物持久化基于 journal：bridge 的 `SessionArtifactStore` 把 durable 变更
  经 agent 的 chat recording service 记为 `session_artifact_event` 记录，
  并周期性写 `session_artifact_snapshot` 记录
  （`packages/core/src/services/chatRecordingService.ts` 的
  `recordSessionArtifactEvent` / `recordSessionArtifactSnapshot`）。快照每
  50 个 durable 事件写一次（`SNAPSHOT_AFTER_DURABLE_EVENTS`），rewind 后也
  写；close 时不写。典型的小会话只有 event 记录。
- event payload（`SessionArtifactEventRecordPayload`，
  `packages/core/src/services/session-artifact-persistence.ts`）只带变更，
  不带总数。snapshot payload 带完整的可恢复 artifact 数组。
- 磁盘上没有每会话的产物摘要。现有的小型每会话 sidecar 只有标题
  （`.title.json`）、PR 绑定（`.pr.json`）、worktree（`.worktree.json`）、
  prompt ledger（`.ledger.jsonl`），都在 transcript 旁的 chats 目录里。
- 会话摘要（`packages/acp-bridge/src/bridgeTypes.ts` 的
  `BridgeSessionSummary`，镜像为 `packages/sdk-typescript/src/daemon/types.ts`
  的 `DaemonSessionSummary`）没有产物字段。`toSessionSummary`
  （`packages/acp-bridge/src/session-control-plane.ts`）从内存 entry 构造
  live 摘要。
- 列表响应（`packages/cli/src/serve/server/session-list.ts`）在三处从
  sidecar 增强 persisted 摘要：默认分页路径、`loadAllPersistedSummaries`
  （organized 与 metadata 过滤路径共享的全量扫描，2 s TTL 缓存）、搜索路径。
  `mergeLiveSessionSummary` 叠加 live 状态；`liveOnlySummary` 插入没有
  persisted 记录的 live 会话。
- 产物库的冷删除（`SessionService.removeSessionArtifactsForLibrary`）直接
  向 journal 追加 event 记录，绕过 recording service。
- `SessionService.loadSession` 在每次 load/resume 时从活动分支重建产物
  快照；这是恢复读取的中心路径。
- 客户端：头部入口数量来自 `useSessionArtifacts`（每会话缓存，其次是以
  `restoredArtifactsSessionId` 键控的 load 内嵌快照）。点击流程为
  侧栏 `onLoadSession` → App `loadSidebarSession` →
  `sessionActions.loadSession` → `startSessionSwitch`
  （`packages/web-shell/client/daemon/session/actions.ts`），后者同步提交
  乐观 connection（`sessionId`、`loadingTranscript`）。provider 的 load
  effect 随后在 replay 之前用 `flushSync` 提交内嵌快照，attach 无条件提交。

## 目标

- 会话摘要携带产物数量：live 会话与 persisted（冷）会话都带，覆盖工作区
  列表的全部路径。
- 点击侧栏会话时，只要数量已知，头部产物入口立即以该数量显示——早于 load
  响应。
- 不拖慢 `/load`；列表路径的开销不超出既有 sidecar 读取成本模型（每会话
  一次小文件读取，有缓存）。
- 保持旧 daemon（无字段）与 load 内嵌快照路径（范围 A）的既有行为。

## 非目标 / 范围边界

- 列表元数据只带数量，不带 artifact 列表。列表保持小体积；完整列表仍经
  范围 A 的 load 内嵌与门控 `/artifacts` 拉取到达。
- 不做会话行徽章。数量在点击时刻显示于聊天头部（即设计所说的「点击即现」）；
  行徽章是可能的后续增强，不在本次范围。
- 不增强 standalone（Conversations）目录行：它们使用独立的摘要类型与目录
  路径。live standalone entry 在 `BridgeSessionSummary` 流经之处仍带 live
  数量；冷 standalone 行保持现状。如有需要另作后续。
- 不改按轮芯片、产物面板的 live 更新路径、产物存储格式。journal 仍是权威；
  sidecar 是派生缓存。
- 不新增 capability tag：字段是既有会话列表面上的增量元数据，客户端沿用
  既有 `session_artifacts` capability 检查门控。

## 提议方案

### 服务端：派生的产物摘要 sidecar

- 新增 core 模块 `session-artifact-summary-sidecar.ts`，镜像
  `session-title-sidecar.ts`：文件为 chats 目录下的
  `<sessionId>.artifacts.json`，形状
  `{ version: 1, artifactCount: number, updatedAt: string }`。原子尽力写入
  （返回 boolean）、带校验的读取（version、安全非负整数且不超过
  `MAX_PERSISTED_ARTIFACTS`、字符串时间戳），同步与异步两个变体共享同一
  形状校验、move 与 remove 助手。
- event payload 增加可选 `artifactCount` 字段：store 的权威**可恢复**数量
  （与 snapshot payload 同一过滤条件：非 ephemeral、排除非快照的 published
  file URL），在 `persistChanges` 构造 payload 时计算。
  `normalizeEventPayload` 在值合法时静默保留（派生字段畸形绝不使权威的
  journal 记录失效）。fork remap 剥离该字段：fork 会话的数量在其自己的
  store 写入之前是未知的。
- recording service 在 journal 追加成功后写 sidecar：event 用
  `payload.artifactCount`（存在时）；snapshot 用 `payload.artifacts.length`。
  这两处是 store 驱动持久化的唯一 journal 写入点，因此每次 durable 变更都
  刷新 sidecar。
- `SessionService.loadSession` 从重建的快照尽力播种 sidecar。这覆盖 legacy
  会话（journal 记录早于 sidecar）与 fork 的首次打开，并在任何带外 journal
  编辑后重新播种。零数量会治愈已存在的陈旧 sidecar（一次失败的尽力零写入
  不能留下永久幻影计数），但不会为无产物会话新建；数量相等时跳过写入，
  暖 load 不新增写盘；部分读取的 transcript 绝不播种。
- 产物库冷删除在其直接 journal 写入后，用剩余可恢复数量更新 sidecar。
- `SessionService` 增加按归档状态的路径助手；archive/unarchive 与其他
  sidecar 一起移动它；会话删除移除它；冲突解决丢弃被丢弃一方的 sidecar
  （保留 transcript 的产物集不同，被丢弃的数量不能转移）。
- 工作目录搬迁（`Config.getCurrentSessionArtifactMoves`）把 sidecar 与
  transcript 及其他展示用 sidecar 一起带走，因此 `/cd` 既不会把数量遗留在
  旧项目，也不会在切回时让陈旧数量重新出现在 transcript 旁。

### 服务端：摘要携带数量

- `SessionArtifactStore` 增加同步 `count()` 访问器（live 公开产物数量，
  即 `artifacts.size`；不进队列、不做状态刷新）。
- `toSessionSummary` 在非零时携带 `artifactCount`。live entry 对其数量是
  权威的，因此 live 摘要省略（数量为零）时，合并要丢弃 sidecar 派生的陈旧
  数量。
- `BridgeSessionSummary` 与 `DaemonSessionSummary` 增加可选
  `artifactCount?: number`（wire 镜像，保持同步）。
- `session-list.ts` 增加 `enrichArtifactSummaries`，在三处增强点与
  `enrichPrSidecars` 并列调用。逐会话 await 异步 sidecar 读取——与兄弟
  增强器一致，使扫描中途的 abort 可被观察，且大扫描（至
  `MAX_ORGANIZED_SESSIONS`）不会阻塞事件循环——非零时设置数量。sidecar
  不可读或缺席时，持久化摘要保持字段未设置（未知，而非零）；live 摘要上
  缺省即为零，因为内存 store 是权威的。

### 客户端：点击时刻的 hint，被权威数据退役

- 侧栏把被点击会话的 `artifactCount` 经 `onLoadSession` →
  `loadSidebarSession` → `loadSession` 选项（`artifactCountHint`）传递。
  其他打开路径（总览、host 交接、standalone、重试）不传 hint，保持范围 A
  的时序。
- `startSessionSwitch` 的乐观 connection 提交同时设置 `artifactCountHint`
  与 `artifactCountHintSessionId`（未传 hint 时两者都清空），沿用
  `restoredArtifacts` / `restoredArtifactsSessionId` 的键控模式。
  `getConnectionAfterSessionClear` 删除两者。
- `useSessionArtifacts` 暴露 `artifactCountHint`：仅当 hint 键控到当前
  会话、为正、且该会话没有权威数据（无缓存条目、无键控的已恢复快照）时
  返回 connection hint。门控拉取成功（哪怕是空列表）或内嵌快照都会退役
  hint。
- provider 的早快照提交与 attach 提交清空 hint 字段：权威数据一旦落地，
  hint 即消失。
- App 头部入口在 `artifacts.length` 非零时用之，否则用 hint。单门契约
  （数量与 opener 由同一条件派生，spread 进两个头部渲染点）不变。

## 关键设计决策与理由

- **元数据带数量而非列表。** 一页最多 100 个会话，不能携带 100 份 artifact
  列表。数量即摘要；列表在 load 时经范围 A 到达。
- **磁盘存可恢复数量，内存存 live 数量。** sidecar 存可恢复数量——冷打开
  会恢复出来的那些。live 摘要存 live 公开数量（含 ephemeral），与会话 live
  时头部显示的一致。ephemeral 产物随 daemon 生命周期消亡，因此会话变冷时
  数量正确回落到可恢复数量。
- **数量搭乘既有持久化链。** 把总数加进 event payload（增量、可选）保持
  wire 面不变——没有新 ext method kind，没有新故障域。store 是唯一始终知道
  精确数量的组件；在 handler 里从变更增量推导，对 legacy 与 fork 会话需要
  一个未知基数。
- **sidecar 写入住在 recording service。** 它按构造与 transcript 同址
  （包括 SSH/managed runtime），且是 store 驱动 journal 写入的唯一漏斗。
  load 时播种住在 `SessionService.loadSession`——恢复读取的唯一漏斗。
- **处处尽力而为。** sidecar 失败绝不使 journal 写入、load 或列表页失败。
  journal 是权威；sidecar 在下一次持久化、load 或库变更时自愈。
- **hint 被权威数据退役。** hint 只桥接点击→load 窗口。内嵌快照与门控拉取
  取代它，因此陈旧的 sidecar 数量不会比 load 活得更久。按会话 id 键控防止
  乐观切换时的跨会话泄漏，与范围 A 的守卫一致。
- **不做 artifactsVersion→目录接线。** 目录已在 turn 准入/完成等失效事件
  时重新拉取；产物在 turn 中创建，因此徽章在 turn 边界刷新。列表里的实时
  计数不是目标。

## 涉及文件

- `packages/core/src/services/session-artifact-summary-sidecar.ts`（新增）。
- `packages/core/src/services/session-artifact-persistence.ts`（payload
  字段、规范化、fork 剥离）。
- `packages/core/src/services/chatRecordingService.ts`（sidecar 写入）。
- `packages/core/src/services/sessionService.ts`（路径助手、load 播种、
  库删除更新、archive 移动、delete 移除、冲突丢弃）。
- `packages/acp-bridge/src/sessionArtifacts.ts`（payload 数量、`count()`）。
- `packages/acp-bridge/src/session-control-plane.ts`（`toSessionSummary`）。
- `packages/acp-bridge/src/bridgeTypes.ts`（`BridgeSessionSummary`）。
- `packages/sdk-typescript/src/daemon/types.ts`（`DaemonSessionSummary`）。
- `packages/cli/src/serve/server/session-list.ts`（增强、合并规则）。
- `packages/web-shell/client/daemon/session/types.ts`（connection 字段、
  action 选项）。
- `packages/web-shell/client/daemon/session/actions.ts`（乐观 hint、清空）。
- `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx`
  （早提交与 attach 退役 hint）。
- `packages/web-shell/client/hooks/useSessionArtifacts.ts`（hint 暴露）。
- `packages/web-shell/client/App.tsx`（头部数量回退、hint 传递）。
- `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`
  （传递被点击会话的数量）。
- 每个改动行为的同址测试。

## 约束与风险

- sidecar 可能在一次失败写入到下一次成功持久化/load 之间滞后于 journal；
  数量是尽力而为的元数据，权威 load 会纠正它。对数量入口可接受。
- legacy 会话在升级后首次打开之前不显示数量（load 播种）。从未打开的会话
  保持现状。
- 列表路径每会话多读一个小文件；organized 全量扫描有缓存（2 s TTL），且
  本来每会话就读两个 sidecar。
- 点击→load 窗口内，从入口打开的面板显示空/加载态，直到 load 填充它；
  数量是「存在产物」的提示，不是已填充的列表。
- 前后兼容：两个方向都是可选字段；旧 daemon 省略数量，旧客户端忽略它。

## 验证计划

- 单测：sidecar 读写校验（同步与异步读取器）；event payload 数量保留与
  fork 剥离；recording-service sidecar 写入（带/不带数量的 event、
  snapshot）；load 播种；库删除更新（剩余数量算术，单个与批量）；
  archive/delete/冲突处理；工作目录搬迁；store `count()`；
  `toSessionSummary` 携带/省略；全部列表路径的增强（含扫描中途 abort）；
  合并丢弃陈旧数量；乐观 hint 键控与清空；hook hint 有效性（缓存/快照
  退役、跨会话键控）；头部数量回退；侧栏传递。
- 变异见证：回退每个承重守卫（键控、退役、合并丢弃、fork 剥离、播种），
  展示配对测试变红。
- E2E（真实 daemon + 无头 Chromium，网络时序为承重证据）：冷打开带
  sidecar 的会话；断言头部入口在点击时刻（load 响应之前）以列表数量出现；
  断言 load 内嵌快照取代 hint；legacy 会话首次打开播种；live 数量反映
  ephemeral 产物；archive 移动 sidecar；delete 移除；A→B 切换绝不泄漏
  hint；旧 daemon 回退保持范围 A 时序。
- 回归：`/load` 时延不变；列表时延在 sidecar 读取成本模型内；按轮芯片
  不变；无产物会话不显示入口。

## 验收标准

- 点击摘要携带正产物数量的会话时，头部产物入口在 load 响应到达之前以该
  数量显示。
- 内嵌快照与门控拉取取代 hint；陈旧 hint 不会比 load 活得更久，也不会跨
  会话泄漏。
- 冷会话在全部工作区列表路径上携带来自 sidecar 的可恢复数量；live 会话
  携带 live 数量。
- legacy 会话首次打开获得数量；archive/delete/冲突保持 sidecar 与
  transcript 一致。
- 旧 daemon（无字段）行为与今天完全一致。
- 构建、类型检查、聚焦单测通过。

## 开放问题

- 是否后续增加会话行徽章（独立表面，不在本次范围）。
- standalone 目录是否获得同样的增强（独立摘要类型与路径；后续）。
