# 通过 load 内嵌 artifact 实现会话级产物头部入口提前显示

[English](2026-11-15-early-session-artifact-entry.md) | [简体中文](2026-11-15-early-session-artifact-entry.zh-CN.md)

状态：已实现（范围 A）；范围 B 为提案。

## 问题陈述

在 Web Shell 中冷开一条会话时，会话的产物要等 replay 注入完成、artifact 列表
拉取回来之后才会呈现。目前没有一个在对话正文渲染之前就能出现的、可见的会话级
产物入口。想直接跳到某个已发布产物的用户，必须等完整个冷开路径。

按轮产物芯片（`TurnOutputs`）无法更早出现：它们由 `getArtifactsByTurn` 关联到
transcript 的轮，因此必须等 replay。但**会话级**入口只需要 artifact 列表，不需要
replay。只要列表早到，入口就能早显示。

## 基线（实现前实测）

以下实测与行为描述的是促成此次工作的改动前基线；范围 A 已落地，改变了这里描述
的响应形状与客户端时刻。

对会话 `82c7298a-9233-4efc-b57e-cb1f79ccc06b`（workspace `qwen-code`，daemon
`0.27.3`）以 headless 冷开、以网络时刻为承重证据的实测：

- `POST /session/:id/load` 约 436–464 ms 返回，replay 约 1.15 MB
  （`compactedReplay` 404 事件，`liveJournal` 0）。响应**不含** artifact 列表
  （只有 `artifactWarnings`）。
- 对话正文首帧在点击会话后约 683–722 ms。load 响应到首帧之间约 250 ms 是客户端
  replay 注入，正文本身也要等它。
- `GET /session/:id/artifacts` 服务端约 1 ms，但客户端要等 `catchingUp` 门放行
  才发出（`packages/web-shell/client/hooks/useSessionArtifacts.ts` 中 `refresh`
  的 `!isConnected || connection.catchingUp || !supportsArtifacts` 守卫）。它在
  点击后约 638–709 ms 完成——与正文首帧相差 ±45 ms 以内。

结论：artifact 列表本就与正文几乎同时到位。为加快**按轮芯片**而内嵌 artifact
只能省 ~0 ms。但读取早到列表的**会话级头部入口**可以在 load 响应时刻（约
450 ms）出现，比正文早约 250 ms，因为它不需要 replay。

相关基线行为（改动前）：

- bridge 在 `loadSession` 期间、构造 load 响应之前，就把 artifact 恢复进内存
  store（`packages/acp-bridge/src/session-control-plane.ts` 恢复路径中的
  `entry.artifacts.restore`），但响应只带 `artifactWarnings`。
- `SessionArtifactStore.list()`（`packages/acp-bridge/src/sessionArtifacts.ts`）
  返回前会执行 `refreshWorkspaceStatuses()`（workspace stat/hash）与
  `forgetVanishedAutoRecordedArtifacts()`。在 load 路径调用它会拖慢 `/load`。
- `DaemonRestoredSession`（`packages/sdk-typescript/src/daemon/types.ts`）没有
  artifact 字段。
- 会话摘要已携带派生的每会话数据（`prs`），在
  `packages/cli/src/serve/routes/session.ts` 中从 sidecar 尽力读取回填——这是
  元数据增强的先例，留作后续（范围 B）。
- 聊天头部项由 `WebShellChatHeaderItem`
  （`packages/web-shell/client/customization.tsx`）声明，在
  `DEFAULT_CHAT_HEADER_ITEMS` 给默认值、在 `packages/web-shell/client/App.tsx`
  （`chatHeaderItems`）消费，由 `ChatContextHeader` 渲染。

## 目标

- 一旦 artifact 列表可从 load 响应获得（实测会话约 450 ms），就在聊天头部显示
  一个可见的会话级产物入口，早于对话正文渲染。
- 入口显示产物数量，并打开环境面板的 artifacts 区。
- 不拖慢 `/load`。
- 保持旧 daemon 与按轮芯片的既有行为。

## 非目标 / 范围边界

- 仅范围 A：把 artifact 列表内嵌进 `/load`（及 `/resume`）响应。范围 B（会话列表
  元数据中的产物摘要，用于点击即现）是后续，不在本次实现。
- 按轮 `TurnOutputs` 芯片不变，仍等 replay。
- 不改变产物面板的 live 更新路径（`artifactsVersion` 事件）。
- 不新增 artifact 存储格式或 sidecar。

## 提议方案

### 服务端：在恢复响应中携带已恢复的 artifact 列表

- 给 `SessionArtifactStore` 增加一个轻量读取 accessor：把当前 artifact 经
  `toPublicArtifact` 映射、按 `insertSeq` 排序返回，**不执行**
  `refreshWorkspaceStatuses()` 与 `forgetVanishedAutoRecordedArtifacts()`。它反映
  已恢复的快照；workspace 状态由随后正常的门控 `/artifacts` 拉取刷新。
- 在 bridge 恢复路径 `entry.artifacts.restore(...)` 之后，把该 accessor 的
  artifact 数组作为可选 `artifacts` 字段加入 load/resume 响应。会话无产物或
  artifact 持久化不可用时省略该字段，使载荷保持小、旧客户端不受影响。「已存活
  会话」的 attach 返回（daemon 仍持有该会话时刷新页面/开第二个标签页，以及与其
  他注册竞态的恢复）也经同一廉价 accessor 携带相同快照，使最常见的「回到本会话」
  路径同样早显示入口，而不仅是冷恢复。
- `packages/cli/src/serve` 的恢复路由已经通过 `redactSdkSurfaceReplay` 转发
  bridge 响应；确保 artifact 数组不被脱敏（其中不含 skill 正文）。

### SDK：为字段定型

- 在 `packages/sdk-typescript/src/daemon/types.ts` 的 `DaemonRestoredSession`
  增加可选 `artifacts?: DaemonSessionArtifact[]`。可选，使省略该字段的旧 daemon
  仍然合法。

### 客户端：在 replay 之前提交 artifact 快照并新增头部入口

- daemon 会话 client 将恢复响应中的 `artifacts` 保留为 `restoredArtifacts`；
  provider 将其暴露到连接状态上。
- 为使入口**早于**对话正文绘制，provider 在 replay 注入之前、仅当
  `restoredArtifacts` 存在时，用 `flushSync` 将 `sessionId`、`restoredArtifacts`
  与 `restoredArtifactsSessionId` 单独提交成一次渲染。只触碰这几个字段；
  `catchingUp` 及其余连接状态仍交给既有的 replay/attach 逻辑。若不强制提交，
  React 会把快照与 replay 注入批处理，入口就会与正文同帧绘制。
- `useSessionArtifacts` 在每会话缓存为空时回退到 `connection.restoredArtifacts`，
  使 `artifacts` 无需等 `catchingUp` 门即被填充。该回退以
  `connection.restoredArtifactsSessionId === sessionId` 为门，使乐观切换（展开上
  一个连接并在 restore 落地前设置新 `sessionId`）不会把上一会话的快照显示在新会
  话下。快照与其键在会话清空时一并清除。现有门控 `refresh` 与 `artifactsVersion`
  驱动的刷新仍是 live 更新来源，并会覆盖该回退值。字段缺失（旧 daemon）时行为与
  今天完全一致。
- 在 `WebShellChatHeaderItem` 与 standalone 默认头部项中新增聊天头部项
  `artifacts`。渲染一个带产物数量的头部按钮（如「产物 · N」），打开环境面板——其
  artifacts 区默认展开并列出本会话产物。刻意不以按 tab 的产物面板为目标：它在无
  tab 时显示的是启动器空态，而非产物列表。数量为 0 或缺少 `session_artifacts`
  能力时隐藏按钮。
- 为按钮 label/aria 在两种语言中新增 i18n 文案。

## 关键设计决策与理由

- **内嵌列表而非仅数量。** 列表很小（几 KB）且已在内存恢复；携带它可播种 artifact
  缓存，使从按钮打开的面板立即有内容，也为范围 B 铺路。
- **load 路径不做 workspace 状态刷新。** 廉价 accessor 避免 stat/hash，从而不拖慢
  `/load`。状态准确性由随后既有的门控拉取恢复。
- **播种而非取代门控拉取。** 早到列表是快照；live 正确性仍来自既有刷新路径。这保持
  reconnect 与 live 更新语义不变。
- **头部入口而非扁平产物条。** 数量按钮避免与按轮芯片重复，是最小的可见面。
- **accessor：`listRestored()`，共用一个快照 helper。** 廉价读取 accessor 命名为
  `listRestored()`；它与 `list()` 都经共享的同步 `snapshotPublicArtifacts()`
  helper 映射，使两条路径在排序与公共形状上不会漂移。该 helper 保持同步——
  `listRestored()` 用单次 `enqueue` 包裹它，若在其中再嵌套一次 `enqueue` 会在
  store 队列上自死锁。
- **头部项默认开启。** `artifacts` 头部项在 standalone shell 的默认头部项中默认
  启用（不像 `tokenUsage` 那样 opt-in），以保证可见性；数量为 0 或缺少能力时仍
  自行隐藏。

## 涉及文件

- `packages/acp-bridge/src/sessionArtifacts.ts`（廉价 accessor）。
- `packages/acp-bridge/src/session-control-plane.ts`（恢复响应字段）。
- `packages/acp-bridge/src/bridgeTypes.ts`（`BridgeRestoredSession` 定型）。
- `packages/sdk-typescript/src/daemon/types.ts`（`DaemonRestoredSession`）。
- `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`（在每个 load/resume
  工厂把字段保留为 `restoredArtifacts`）。
- `packages/web-shell/client/daemon/session/*`（provider 暴露/键控字段）。
- `packages/web-shell/client/hooks/useSessionArtifacts.ts`（提前播种）。
- `packages/web-shell/client/customization.tsx`（头部项类型）。
- `packages/web-shell/client/App.tsx`（默认项、头部按钮接线）。
- `packages/web-shell/client/main.tsx`（standalone 默认头部项）。
- `ChatContextHeader` 组件（渲染按钮）。
- `packages/web-shell/client/i18n.tsx`（文案）。
- 每个改动行为的同置测试。

## 约束与风险

- 早到快照在门控拉取刷新前可能显示过期的 workspace 状态；对数量/入口可接受，且面板
  打开时会刷新。
- 播种必须键控到正确会话、并在会话切换时清空，与既有缓存所有权守卫一致，避免跨会话
  泄漏。
- 恢复响应体积增加 artifact 列表（受 artifact 上限约束）；对典型会话可忽略。
- 前向/后向兼容：可选字段；旧 daemon 省略、客户端回退门控拉取；旧客户端忽略。

## 验证计划

- 单元：廉价 accessor 返回已恢复 artifact 且不做状态刷新；恢复响应正确包含/省略
  字段；`useSessionArtifacts` 从早到列表播种且仍在 `artifactsVersion` 时刷新；头部
  按钮显示数量并打开面板；字段缺失回退今天行为。
- E2E（headless 对真实 daemon，以网络时刻为承重证据）：冷开一条含已发布产物的会话；
  断言头部产物入口在 load 响应时刻（早于正文首帧）出现、数量正确，点击打开环境面板
  的 artifacts 区。复用驱逐 + 冷开的测量 harness。
- 回归：按轮芯片不变；`/load` 时延不增加；无产物会话不显示按钮。

## 验收标准

- 含产物的冷会话，头部产物入口在对话正文首帧之前可见，数量正确。
- 点击入口打开环境面板的 artifacts 区，并填充该会话的产物。
- `/load` 服务端耗时不回退。
- 旧 daemon（无字段）行为与今天完全一致。
- build、typecheck、聚焦单测通过。

## 开放问题

- 范围 B 后续：用于会话列表点击即现的产物摘要 sidecar。
