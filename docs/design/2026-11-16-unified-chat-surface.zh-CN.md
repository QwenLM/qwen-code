# Daemon 与 Managed 会话的统一聊天面

[English](2026-11-16-unified-chat-surface.md) |
[简体中文](2026-11-16-unified-chat-surface.zh-CN.md)

状态：提案。日期：2026-11-16。本文档所有内容均未实现；下文「现状」描述的是
提案之日的代码。

## 问题

Web Shell 在 `packages/web-shell` 内部用两套独立的聊天编排渲染两类会话——
普通 daemon 会话与 Java Managed Agent 会话。转录渲染、编辑器和 UI 基础组件
已经共享，但其上的一切（页面布局、输入框接线、审批流程、状态展示、会话操作）
都实现了两遍：一遍内联在 `App.tsx` 里服务 daemon 会话，一遍在
`ManagedSessionsPage.tsx` 加 `components/managed/**` 的 hooks 里服务 managed
会话。

后果今天已经可见：

- 功能漂移。daemon 聊天面引入了 `ComposerStatusStack`、
  `ComposerUsageStats`、`ConversationSearch`、`GoalStatusStrip`；
  `ManagedSessionsPage.tsx` 一个都没有引入，而是展示自己的
  `ManagedSessionProgress`。同一个外壳里的 managed 会话与 daemon 会话
  观感和行为都不一致。
- 双倍实现成本。草稿持久化、审批应答、模型选择、审批模式选择、上下文压缩、
  重命名、导出、取消、生命周期各有一份 daemon 实现和一份平行的
  `use-managed-*` 实现。每个新聊天功能都要做两遍，而第二份经常被遗忘。
- 没有复用路径。daemon 聊天面不是组件，而是内联在约 27k 行的 `App.tsx`
  里。其他嵌入 Web Shell 的产品（例如 VS Code companion，ESLint 已强制其
  通过 `@qwen-code/web-shell` 渲染）同样无法复用。

## 现状

以下路径均相对 `packages/web-shell/client/`。行数为提案之日约计的生产代码
行数，不含测试。

### 已共享（单一实现）

| 层                                     | 文件                                                                                                                                                                                    | 消费方     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 转录渲染                               | `components/MessageList.tsx`（约 6.4k 行）、`components/messages/**`（约 28k 行）                                                                                                       | 两条路径   |
| 消息模型                               | `adapters/types.ts`（`Message`、`ACPToolCall`）                                                                                                                                         | 两个投影器 |
| 输入框                                 | `components/ChatEditor.tsx`、`hooks/useComposerCore.ts`                                                                                                                                 | 两条路径   |
| UI 基础组件、主题、i18n、portal 作用域 | `components/ui/**`、`themeContext.ts`、`i18n.tsx`、`portalRoot.ts`                                                                                                                      | 两条路径   |
| 外壳与工作区导航                       | `App.tsx` 外壳；统一导航见 [managed-daemon-web-shell](2026-10-21-managed-daemon-web-shell.zh-CN.md) 与 [unified-workspace-navigation](2026-10-21-unified-workspace-navigation.zh-CN.md) | 两条路径   |

两条路径已经把各自的后端事件投影到同一份 `Message` 模型：daemon 路径经
`adapters/transcriptToMessages.ts` 与 `adapters/transcriptAdapter.ts`
（由 `App.tsx` 引入），managed 路径经
`components/managed/managed-session-messages.ts` 的
`createManagedMessageProjector`。managed 投影按设计是增量的
（[managed-incremental-message-projection](managed-incremental-message-projection.zh-CN.md)）。

### 分叉（两套实现）

| 关注点     | Daemon 路径                                                                    | Managed 路径                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 聊天编排   | 内联于 `App.tsx`（总计约 27k 行）                                              | `components/managed/ManagedSessionsPage.tsx`（约 3.4k 行）                                                                                         |
| 会话状态   | `daemon/session/DaemonSessionProvider.tsx`（约 7.1k 行）及 `daemon/session/**` | `components/managed/use-managed-session.ts` 与各 `use-managed-*` hooks                                                                             |
| 后端契约   | `@qwen-code/sdk/daemon` 的 `DaemonSessionClient`                               | `ManagedAgentProvider`（`components/managed/managed-agent-provider.ts`，约 910 行接口），走 `/api/agent/web-shell/v1/**`                           |
| 状态展示   | `ComposerStatusStack`、`ComposerUsageStats`、`GoalStatusStrip`                 | `ManagedSessionProgress`                                                                                                                           |
| 会话内搜索 | `ConversationSearch`                                                           | 缺失                                                                                                                                               |
| 面板       | daemon 终端、artifacts、本地文件、git 模式、语音、Live                         | `ManagedTerminalPanel`、`ManagedToolResultPanel`、`ManagedTaskPanel`、`ManagedDiagnosticsPanel`、`ManagedRecoveryPanel`、`ManagedChildSessionView` |

Managed-only 入口 `ManagedAgentWebShell.tsx`（由 `ManagedStandaloneApp.tsx`
经 `/managed/boot` 启动）在不创建任何 daemon 上下文的情况下挂载
`ManagedSessionsPage`。完整外壳为 managed 会话挂载同一个页面，而 daemon
会话走 `App.tsx` 内联聊天面渲染。

### 本设计必须遵守的既有决策

- [managed-agent-dual-path-web-shell](2026-09-20-managed-agent-dual-path-web-shell.zh-CN.md)：
  每个界面路由到原有 owner；daemon 与 Java 协议之间不加转换层；
  Managed-only 入口不依赖 daemon；两个会话 ID 命名空间与存储键永不合并。
- [managed-daemon-web-shell](2026-10-21-managed-daemon-web-shell.zh-CN.md)：
  导航已经统一；两种会话组件保持挂载；不做跨 provider 操作、不迁移会话、
  不合并存储。
- 后端收敛不在范围内：unified-agent-loop 工作与 Hosted harness 评估都保留
  各自的服务端实现。因此统一只发生在客户端。

## 目标

1. 一个聊天面组件同时渲染 daemon 与 managed 会话，使布局、输入框行为、
   审批流程与状态展示从构造上就一致。
2. 新聊天功能只实现一次，面向后端无关的契约，在后端支持的范围内同时到达
   两类会话。
3. 上文列出的重复编排被删除，而不是被包装。
4. Managed-only 入口继续在没有 daemon、不引入 daemon 代码的情况下工作。

## 非目标

- 不做任何方向的协议转换层，无论客户端还是服务端。
- 不合并跨 provider 的会话状态、存储键或 ID 命名空间；不做跨 provider
  操作。
- 本设计不要求任何后端改动。某一侧缺少后端支持的功能保持能力门控，
  不做模拟。
- daemon 专属界面（语音、Live 会话、desktop relay、channels、git 模式、
  本地文件）不移植到 managed 会话；它们成为共享聊天面上按能力门控的插槽。
- 工作区导航、创建弹窗与外壳 chrome 已经统一，本次不重做。

## 方案

在新目录 `packages/web-shell/client/chat-core/`（最终命名在切片 1 评审
确定）引入后端无关的聊天内核，由一个视图模型契约、一个聊天面组件和两个
适配器组成：

```text
App.tsx（外壳、导航、设置）                    ManagedAgentWebShell（managed-only）
        │                                              │
        ▼                                              ▼
  ChatSurface  ◄──────────── 同一个组件 ───────────────►
        ▲
        │ SessionChatController（视图模型）
   ┌────┴─────────────────────┐
   │                          │
daemon 适配器              managed 适配器
(DaemonSessionProvider     (use-managed-session +
 状态、ACP 更新)            use-managed-* hooks、
                           Java 操作)
```

### SessionChatController 契约

控制器是视图模型，不是协议客户端。它暴露可观察状态与意图级操作；幂等键、
期望 revision、回执与操作轮询全部留在 managed 适配器内部。示意形状
（最终字段名在切片 1 确定）：

```ts
interface SessionChatController {
  readonly kind: 'daemon' | 'managed';
  readonly sessionId: string;
  readonly storageKey: string;

  // 转录：共享 Message 模型，已由投影器增量投影。
  readonly messages: readonly Message[];
  readonly transcriptState: 'loading' | 'ready' | 'error';
  loadOlder?(): Promise<void>;

  // 回合生命周期。
  readonly phase: ChatPhase; // idle | submitting | running | cancelling | failed
  submit(input: ComposerSubmit): Promise<SubmitOutcome>;
  cancel(): Promise<CancelOutcome>;

  // 审批与提问，规范化为共享 ToolApproval / ManagedQuestionForm 的输入。
  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingQuestions: readonly PendingQuestion[];
  respondApproval(id: string, optionId: string): Promise<void>;
  respondQuestion(id: string, answers: QuestionAnswer[]): Promise<void>;

  // 按能力门控的子控制器；后端不支持时缺席。
  readonly modelSelection?: ModelSelectionController;
  readonly approvalSelection?: ApprovalSelectionController;
  readonly contextUsage?: ContextUsageController; // 用量事实 + 压缩
  readonly sessionOps?: SessionOpsController; // 重命名、导出、生命周期

  // 供共享状态栈与用量统计使用的事实。
  readonly statusFacts: ChatStatusFacts;
  readonly capabilities: ChatCapabilities;
}
```

`ChatCapabilities` 沿用 `ManagedAgentSessionSummary.capabilities` 与 daemon
capabilities 的既有能力风格：聊天面对每个可选区域的门控只看标志，绝不看
`kind`。managed 的异步操作（压缩、生命周期、取消、MCP 命令）以通用操作状态
（`pending | running | completed | failed`）呈现，使聊天面对两种后端渲染
同一套进度语汇。

### ChatSurface 组件

`ChatSurface` 只拥有聊天列：头部（`ChatContextHeader` 加头部操作插槽）、
`MessageList` 接线、审批与提问渲染、输入框（`ChatEditor` 加由 `statusFacts`
驱动的 `ComposerStatusStack` 与用量统计），以及面板插槽区。它接收控制器与
插槽渲染器作为 props，不引入 `daemon/**`、`components/managed/**` 或
`@qwen-code/sdk/daemon` 的任何内容。后端专属面板（daemon artifacts、
managed 诊断/任务/恢复/终端）由所属页面以插槽传入。

### 适配器

- `createDaemonChatController` 包装现有 `DaemonSessionProvider` 的状态与
  操作，把 ACP 驱动的状态映射到契约；daemon 的即时结果映射为已完成的
  操作状态。
- `createManagedChatController` 包装 `use-managed-session` 与现有
  `use-managed-*` hooks。各 hook 保持现有职责（回执、revision、恢复屏障、
  未决命令存储）；适配器只规范化其输出。增量投影器仍是 `messages` 的唯一
  来源；控制器绝不重新投影。

### 迁移后的页面接线

- `App.tsx` 为 daemon 会话渲染 `ChatSurface` 加 daemon 适配器，保留导航、
  设置与 daemon 专属面板。
- `ManagedSessionsPage.tsx` 收缩为会话导航加 managed 适配器与 managed
  专属面板插槽；其聊天列变为 `ChatSurface`。Managed-only 入口保持现有
  布局与启动方式。

## 设计决策与理由

1. **视图模型契约，而非协议适配器。** 考虑过并否决了「在客户端把 Java API
   包装成 daemon 协议形状」的方案：它必须模拟 capabilities、workspace
   上下文、artifacts、终端票据与语音语义，恰好重建双通道设计禁止的转换层，
   且模拟层本身会成为新的维护负担。视图模型位于两个协议之上，只规范化
   UI 展示与操作的内容。
2. **能力门控代替后端分支。** 聊天面从不询问自己服务哪个后端。缺少后端
   支持就隐藏对应区域，绝不触发向另一个 provider 的回退，与既有的
   不回退规则一致。
3. **daemon 先行抽取。** daemon 聊天面先迁入 `ChatSurface`，并带视觉
   before/after 门禁，因为它是更大、风险更高的抽取。managed 第二步切换
   到一个已被验证的组件上，其重复编排在替换它的同一切片里删除。
4. **操作保持封装。** 若把 Java 原始操作（幂等键、revision、回执）暴露进
   契约，managed 语义会泄漏进共享聊天面，并迫使 daemon 适配器伪造它们。
   通用操作状态是聊天面可见的唯一异步语汇。
5. **一致性跟随后端事实。** managed 在其事件与诊断已提供事实的范围内
   （例如 `modelContext` 的 token 观测）获得状态栈与用量展示。没有后端
   事实的区域保持隐藏，而不是填入编造的数据。

## 迁移切片

每个切片是独立可发布的 PR，带自己的测试。按仓库惯例，设计文档与第一个
实现切片同 PR 落地。

1. **契约与特征钉桩。** 新增 `chat-core`，含契约类型与能力模型；新增
   DOM 级特征测试，钉住两个聊天面的当前行为（输入框提交、审批应答、
   状态展示、草稿恢复）。无行为变化。
2. **抽取 ChatSurface，daemon 切换。** 把聊天列从 `App.tsx` 迁入
   `ChatSurface` 加 daemon 适配器。视觉 before/after 预览不得出现无法
   解释的 daemon 侧差异。managed 不动。
3. **managed 切换，删除重复编排。** 新增 managed 适配器；managed 聊天列
   渲染 `ChatSurface`；从 `ManagedSessionsPage.tsx` 删除被替换的
   转录/输入框/审批/状态编排。managed 专属面板变为插槽。
4. **按能力门控的一致性。** 在后端事实存在的范围内统一两侧的状态栈、
   用量统计与上下文用量/压缩展示。会话内搜索与目标展示在下文未决问题
   解决前保持门控。
5. **边界强制与清理。** 新增构建/导入守卫，证明 `chat-core` 与
   managed-only 产物绝不引入 daemon 代码（沿用现有
   `build-artifact.test.ts` 检查的风格）；删除死掉的 managed 编排与
   陈旧导入。

切片 2–4 期间，已迁移区域的新聊天功能只允许落在 `chat-core`，避免迁移
与功能开发竞跑。

## 约束

- Managed-only 入口（`ManagedAgentWebShell`）不得新增任何 daemon 导入；
  `chat-core` 不引入 `daemon/**` 与 `@qwen-code/sdk/daemon`。
- 不改动 daemon 路由、Java 路由或 OpenAPI 契约。
- provider 存储键、会话 ID 命名空间与 tenant/actor header 不动；managed
  错误绝不回退 daemon 后端。
- 每个被移动的组件都适用仓库 Web Shell 规范的 CSS 作用域
  （`data-web-shell-root`、portal root）与 React 18/19 `forwardRef` 规则。
- 保留 managed 增量投影及其 epoch/去重语义；控制器消费投影器输出。
- 幂等、期望 revision 与回执语义留在 managed 适配器及其 hooks 内部。

## 风险与缓解

| 风险                                             | 缓解                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| 从约 27k 行的 `App.tsx` 抽取导致 daemon 行为回归 | 切片 1 的特征钉桩；切片 2 的视觉 before/after 门禁；小切片、daemon 先行 |
| 契约向某一后端形状漂移                           | 每个切片对照契约评审两个适配器；用能力标志而非 `kind` 分支              |
| managed 异步语义泄漏进聊天面                     | 通用操作状态；原始操作绝不跨越契约                                      |
| 重新投影或丢失 memo 化导致性能回归               | 控制器消费增量投影器；memo 边界由测试钉住                               |
| 功能开发与迁移竞跑                               | 冻结规则：已迁移区域的新功能只经 `chat-core` 进入                       |
| managed-only 产物意外引入 daemon 代码            | 切片 5 的导入/构建守卫，CI 检查                                         |

## 验证计划

- 每个被移动模块的并置单测；现有 daemon 与 managed 套件
  （`App.test.tsx`、`ManagedSessionsPage.test.tsx`、各 `use-managed-*`
  测试、`ManagedAgentWebShell.test.tsx`）保持绿。
- 通过本地 dev server 对真实 daemon 与 managed 启动路径做两类会话的
  浏览器级验证：提交、审批、取消、草稿恢复、刷新/深链恢复与面板插槽，
  断言打在 DOM 上而非仅看截图。
- 现有 managed Playwright 规格（`managed-usability`、
  `managed-context-compression`、`managed-recovery`、
  `managed-draft-retry` 及同类）在迁移后的聊天面上运行。
- web-shell 视觉预览 CI 为每个切片提供 before/after 证据；daemon 侧
  差异必须为空或可解释。
- 门禁：包级 `typecheck`、`tsc -p tsconfig.lib.json`（更严格的 CI 构建
  门禁）、包级 `build`、根级 `build` 与 `bundle`、定向 lint 与格式检查。

## 验收标准

1. daemon 与 managed 聊天列经由同一个 `ChatSurface` 组件渲染；导入图
   显示一个聊天面、两个适配器。
2. 现状表列出的分叉编排从 `ManagedSessionsPage.tsx` 删除（转录、输入框
   接线、审批流程、状态展示），managed 专属面板以插槽保留。
3. Managed-only 入口与产物不含 daemon 导入，由自动化守卫证明。
4. 现有 daemon 与 managed 单测套件及 managed Playwright 规格通过；
   视觉预览无无法解释的 daemon 侧变化。
5. managed 会话在后端事实存在处展示共享状态栈与用量显示，缺席区域
   按能力门控。

## 未决问题

1. **会话内搜索的一致性。** managed provider 的 `titleSearch` 只覆盖会话
   列表标题搜索；转录内容搜索今天没有 managed 后端路由。一致性是需要
   新增 Java 查询路由，还是搜索保持 daemon 专属并置于能力标志之后？
2. **目标与 loop 展示。** managed loop 调度设计已存在，但 daemon
   `GoalStatusStrip` 的事实尚无 managed 对应物。在后端暴露目标事实之前
   确认按能力门控。
3. **daemon 专属附加项作为插槽。** 语音、git 模式与本地文件保持 daemon
   专属；其入口是在切片 2 迁入 `ChatSurface` 插槽还是留在 `App.tsx`
   chrome，在抽取时确定。
4. **内核命名与位置。** `chat-core/` 是工作名；最终目录与契约命名在
   切片 1 评审确定。
