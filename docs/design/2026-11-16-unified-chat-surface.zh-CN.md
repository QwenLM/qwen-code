# Daemon 与 Managed 会话的统一聊天面

[English](2026-11-16-unified-chat-surface.md) |
[简体中文](2026-11-16-unified-chat-surface.zh-CN.md)

状态：提案。日期：2026-11-16。2026-11-16 评审后修订：ChatPane 聊天列纳入
范围，契约区分受理与结果确立，并修正若干现状主张。第二次修订收紧契约
（可观察操作状态、关联身份、编译期能力映射守卫），并修正 daemon 导入
例外范围与守卫车道。本文档所有内容均未实现；下文「现状」描述的是提案
之日的代码。

## 问题

Web Shell 在 `packages/web-shell` 内部用三套独立的聊天编排渲染聊天：
内联在 `App.tsx` 里的 daemon 主聊天列、`components/ChatPane.tsx` 里的
第二套 daemon 聊天列（分屏与侧任务面板），以及 `ManagedSessionsPage.tsx`
加 `components/managed/**` hooks 里的 managed 聊天列。转录渲染、编辑器和
UI 基础组件已经共享，但其上的一切（页面布局、输入框接线、审批流程、
状态展示、会话操作）每个聊天列各实现一遍。

后果今天已经可见：

- 功能漂移。daemon 侧渲染输入框状态栈（`App.tsx` 与 `ChatPane.tsx` 里
  各一份内联 JSX，共用 `ComposerStatusStack.module.css`）、用量统计
  （`ComposerUsageStats`）、会话内搜索（`ConversationSearch`）与目标条
  （`GoalStatusStrip`）；managed 聊天面没有任何一项的对应物，而是展示
  自己的 `ManagedSessionProgress`。连两个 daemon 聊天列之间也重复着
  状态栈 JSX。同一个外壳里的 managed 会话与 daemon 会话观感和行为都
  不一致。
- 多份实现成本。草稿持久化、审批应答、模型选择、审批模式选择、上下文
  压缩、重命名、导出、取消、生命周期各有一份 daemon 实现和一份平行的
  `use-managed-*` 实现，分屏聊天列还保留自己的提交、取消、审批与状态
  接线。每个新聊天功能都要按聊天列各做一遍，而总有一份被遗忘。
- 没有复用路径。daemon 主聊天列不是组件，而是内联在约 27k 行的
  `App.tsx` 里。`ChatPane.tsx` 是组件，但它是 daemon 形状的，且带着
  自己的一份编排。嵌入整个外壳的产品——VS Code companion 已经渲染
  `WebShellWithProviders`——仍然无法跨后端单独复用一个聊天列。

## 现状

以下路径均相对 `packages/web-shell/client/`。行数为提案之日约计的生产代码
行数，不含测试。

### 已共享（单一实现）

| 层                                     | 文件                                                                                                                                                                                    | 消费方                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 转录渲染                               | `components/MessageList.tsx`（约 6.4k 行）、`components/messages/**`（约 31.6k 行）；`ChatPane` 经 `components/TranscriptViewport.tsx` 到达 `MessageList`                               | 三个聊天列                              |
| 消息模型                               | `adapters/types.ts`（`Message`、`ACPToolCall`）                                                                                                                                         | 两个投影器                              |
| 输入框                                 | `components/ChatEditor.tsx`、`hooks/useComposerCore.ts`                                                                                                                                 | 三个聊天列                              |
| UI 基础组件、主题、i18n、portal 作用域 | `components/ui/**`、`themeContext.ts`、`i18n.tsx`、`portalRoot.ts`                                                                                                                      | 三个聊天列（ChatPane 部分经共享子组件） |
| 外壳与工作区导航                       | `App.tsx` 外壳；统一导航见 [managed-daemon-web-shell](2026-10-21-managed-daemon-web-shell.zh-CN.md) 与 [unified-workspace-navigation](2026-10-21-unified-workspace-navigation.zh-CN.md) | 两类会话                                |

两条路径已经把各自的后端事件投影到同一份 `Message` 模型：daemon 路径经
`adapters/transcriptToMessages.ts` 与 `adapters/transcriptAdapter.ts`
（由 `App.tsx` 引入），managed 路径经
`components/managed/managed-session-messages.ts` 的
`createManagedMessageProjector`。managed 投影按设计是增量的
（[managed-incremental-message-projection](managed-incremental-message-projection.zh-CN.md)）。

### 分叉（每个聊天列一份实现）

| 关注点        | Daemon 路径                                                                                                                                         | Managed 路径                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主聊天编排    | 内联于 `App.tsx`（总计约 27k 行）                                                                                                                   | `components/managed/ManagedSessionsPage.tsx`（约 3.4k 行）                                                                                         |
| 分屏/侧任务列 | `components/ChatPane.tsx`（约 2.2k 行），由 `components/SplitView.tsx` 与 `components/artifacts/SideTaskPanel.tsx` 渲染；`App.tsx` 渲染 `SplitView` | 缺席——managed 会话不在分屏或侧任务中打开                                                                                                           |
| 会话状态      | `daemon/session/DaemonSessionProvider.tsx`（约 7.1k 行）及 `daemon/session/**`                                                                      | `components/managed/use-managed-session.ts` 与各 `use-managed-*` hooks                                                                             |
| 后端契约      | `@qwen-code/sdk/daemon` 的 `DaemonSessionClient`                                                                                                    | `ManagedAgentProvider`（`components/managed/managed-agent-provider.ts`，约 910 行接口），走 `/api/agent/web-shell/v1/**`                           |
| 状态展示      | `App.tsx` 与 `ChatPane.tsx` 里的内联状态栈 JSX（共用 `ComposerStatusStack.module.css`）、`ComposerUsageStats`、`GoalStatusStrip`                    | `ManagedSessionProgress`                                                                                                                           |
| 会话内搜索    | `ConversationSearch`（主聊天列）                                                                                                                    | 缺失                                                                                                                                               |
| 面板          | daemon 终端、artifacts、本地文件、git 模式、语音、Live                                                                                              | `ManagedTerminalPanel`、`ManagedToolResultPanel`、`ManagedTaskPanel`、`ManagedDiagnosticsPanel`、`ManagedRecoveryPanel`、`ManagedChildSessionView` |

`ChatPane.tsx` 独立接线 `TranscriptViewport`、`ToolApproval`、
`AskUserQuestion`、`GoalStatusStrip` 与 `ChatEditor`，拥有提交与取消，
并渲染自己的内联状态栈块。它是现有代码里最接近所提 `ChatSurface` 的
东西，但其 props 是 daemon 形状的（daemon 会话摘要、workspace cwd），
且重复着主聊天列的编排；本设计把它列为明确的迁移目标，而不是留下第三份
副本。今天不存在 `ComposerStatusStack` 组件——只有 CSS module；状态栈
是两个 daemon 聊天列里的内联 JSX，由切片 2 创建该组件。

Managed-only 入口 `ManagedAgentWebShell.tsx`（由 `ManagedStandaloneApp.tsx`
经 `/managed/boot` 启动）在不创建任何 daemon 上下文的情况下挂载
`ManagedSessionsPage`。完整外壳为 managed 会话挂载同一个页面，而 daemon
会话走 `App.tsx` 内联聊天面与 `ChatPane` 各列渲染。

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

1. 一个聊天面组件渲染每一个聊天列——daemon 主列、分屏、侧任务与
   managed——使布局、输入框行为、审批流程与状态展示从构造上就一致。
2. 新聊天功能只实现一次，面向后端无关的契约，在后端支持的范围内到达
   每一个聊天列。
3. 上文列出的重复编排被删除，而不是被包装。
4. Managed-only 入口继续在没有 daemon 的情况下工作，且不向共享内核
   引入 daemon 代码。

## 非目标

- 不做任何方向的协议转换层，无论客户端还是服务端。
- 不合并跨 provider 的会话状态、存储键或 ID 命名空间；不做跨 provider
  操作。
- 本设计不要求任何后端改动。某一侧缺少后端支持的功能保持能力门控，
  不做模拟。
- daemon 专属界面（语音、Live 会话、desktop relay、channels、git 模式、
  本地文件）不移植到 managed 会话；它们成为共享聊天面上按能力门控的插槽。
- 工作区导航、创建弹窗、外壳 chrome 与分屏面板 chrome（标题、
  最大化/关闭、头部操作）本次不重做；它们留在各自的宿主里。

## 方案

在新目录 `packages/web-shell/client/chat-core/`（最终命名在切片 1 评审
确定）引入后端无关的聊天内核。`chat-core` 只存放契约类型与聊天面组件；
两个适配器放在内核之外、各自的 provider 旁边（daemon 适配器在 `daemon/`
下，managed 适配器在 `components/managed/` 下），这正是内核导入禁令
可满足的前提：

```text
App.tsx（主列、外壳）            SplitView / SideTaskPanel     ManagedAgentWebShell
        │                              │                              │
        ▼                              ▼                              ▼
  ChatSurface  ◄──────────────── 同一个组件 ─────────────────────────►
        ▲
        │ SessionChatController（视图模型，类型在 chat-core）
   ┌────┴─────────────────────┐
   │                          │
daemon 适配器              managed 适配器
(在 daemon/ 下，包装       (在 components/managed/ 下，
 DaemonSessionProvider)    包装 use-managed-* hooks)
```

### SessionChatController 契约

控制器是视图模型，不是协议客户端。它暴露可观察状态与意图级操作；幂等键、
期望 revision、回执与操作轮询全部留在 managed 适配器内部。每个意图报告
两段独立结果：受理（请求是否被接受，对应哪个 session/turn/attempt）与
结果（什么权威见证表明预期效果已确立）。示意形状（最终字段名在切片 1
确定）：

```ts
type Admission = 'accepted' | 'rejected' | 'unknown';
type Outcome = 'established' | 'unsettled' | 'failed';

interface IntentResult {
  readonly admission: Admission;
  // 受理为 rejected 时缺席；见下文合法的结果组合。
  readonly outcome?: Outcome;
  // 关联身份：本结果对应哪个 session/turn/attempt/request。
  readonly target: {
    sessionId: string;
    turnId?: string;
    attemptId?: string;
    requestId?: string;
  };
}

type OperationState =
  | 'pending'
  | 'running'
  | 'established'
  | 'unsettled'
  | 'failed';

interface ChatOperation {
  readonly id: string;
  readonly kind:
    | 'submit'
    | 'cancel'
    | 'approval'
    | 'question'
    | 'compression'
    | 'lifecycle'
    | 'mcp';
  readonly state: OperationState;
  readonly target: IntentResult['target'];
}

interface SessionChatController {
  // 仅身份标识；聊天面绝不在其上分支（决策 2）。
  readonly kind: 'daemon' | 'managed';
  readonly sessionId: string;
  readonly storageKey: string;

  // 在飞与近期已结算的意图，跨刷新可观察；`phase: 'cancelling'` 由未确立
  // 的取消操作派生（单一读取路径）。保留有界：见下文 operations 正文。
  readonly operations: readonly ChatOperation[];

  // 转录：共享 Message 模型，已由投影器增量投影。
  readonly messages: readonly Message[];
  readonly transcriptState: 'loading' | 'ready' | 'error';
  loadOlder?(): Promise<void>;

  // 回合生命周期。`cancelling` 持续到结算证据到达。
  readonly phase: ChatPhase; // idle | submitting | running | cancelling | failed
  submit(input: ComposerSubmit): Promise<IntentResult>;
  cancel(): Promise<IntentResult>;

  // 审批与提问，规范化为共享 ToolApproval / ManagedQuestionForm 的输入。
  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingQuestions: readonly PendingQuestion[];
  respondApproval(id: string, optionId: string): Promise<IntentResult>;
  respondQuestion(id: string, answers: QuestionAnswer[]): Promise<IntentResult>;

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

长时意图（提交、取消、审批、提问、压缩、生命周期、MCP 命令）是可观察的
契约状态：`operations` 为每个意图携带一个 `ChatOperation`，使用上述通用
状态，使聊天面对两种后端渲染同一套进度语汇，并能在刷新后恢复「已发送 /
等待结果」。终态条目（`established`、`failed`）保持可读直到被确认——
聊天面消费了结果，或同类新意图取代它——且适配器对每个 kind 与 target
至多保留最新一条终态条目，因此 `operations` 绝不会无界增长。
`phase: 'cancelling'` 由未确立的取消操作派生，而不是由 `cancel()` 的
Promise resolve 派生。契约携带一条不变式：**受理不等于确立。**

- Promise resolve 或传输层受理绝不单独产生 `established`；适配器必须
  持有权威证据（回合结束、结算回执、决定作用于仍当前的
  request/revision）。
- `unsettled` 是一等状态：已受理（或受理未知）但尚无见证，包括超时或
  刷新之后。它渲染为「已发送 / 等待结果」，不是 `failed`，也不提供
  绕过适配器的重试。
- 被取代的审批渲染为 superseded，而不是 applied；审批项只有在后端确认
  决定作用于仍当前的 request 时才移出 pending。
- 能力标志只决定控件是否存在；其后的状态展示跟随结果证据，绝不跟随
  标志。

合法的结果组合：`rejected` 受理不携带结果；`established` 与 `failed`
要求 `accepted` 受理；`unsettled` 伴随 `accepted` 或 `unknown` 受理
（超时情形：可能已生效、尚无见证）。被取代的审批是待决项状态
（`PendingApproval.status`），不是意图结果。区域只有在其子控制器存在时
才渲染；`ChatCapabilities` 标志由同一事实派生并门控辅助控件——存在性是
唯一权威。

`ChatCapabilities` 沿用 `ManagedAgentSessionSummary.capabilities` 与 daemon
capabilities 的既有能力风格。聊天面绝不在 `kind` 上分支：区域只有在其
子控制器存在时才渲染（如上所述，存在性是唯一权威），标志由同一事实
派生，门控区域内部的辅助控件。每个适配器拥有从自己后端的能力形状
（daemon 特性列表；managed 可选布尔）到 `ChatCapabilities` 的映射。遗漏
必须是编译错误，而不是手写映射与手写测试表共享的盲区：managed 映射以
`keyof ManagedAgentSessionSummary['capabilities']` 定型，并配一个基于
`Required<>` 夹具的键集断言（同时决定三态 `terminal?: boolean | null` 的
语义）；daemon 映射是对规范特性标签联合的穷举定型记录——即 CLI serve
层已在用的 `CAPABILITY_PARITY: Record<ServeFeature, ParityRow>` 注册表
键控模式，联合的共享归属在切片 1 确定——使后续版本新增的标签成为编译
错误，而不是悄悄隐藏一个区域。

### ChatSurface 组件

`ChatSurface` 只拥有聊天列：头部（`ChatContextHeader` 加头部操作插槽）、
`MessageList` 接线、审批与提问渲染、输入框（`ChatEditor` 加一个输入框
状态栈组件——由切片 2 从当前重复于 `App.tsx` 与 `ChatPane.tsx` 的内联
JSX 抽取——再加由 `statusFacts` 驱动的用量统计），以及面板插槽区。它接收
控制器与插槽渲染器作为 props，不引入 `daemon/**`、`components/managed/**`
或 `@qwen-code/sdk/daemon` 的任何内容。后端专属面板（daemon artifacts、
managed 诊断/任务/恢复/终端）由所属页面以插槽传入。

### 适配器

- `createDaemonChatController` 包装现有 `DaemonSessionProvider` 的状态与
  操作，把 ACP 驱动的状态映射到契约；只有 daemon 证据结算了结果（回合
  结束、已应用的权限应答）才标记 `established`；调用 resolve 本身只是
  受理。
- `createManagedChatController` 包装 `use-managed-session` 与现有
  `use-managed-*` hooks。各 hook 保持现有职责（回执、revision、恢复屏障、
  未决命令存储）；适配器只把其输出规范化为受理与结果。增量投影器仍是
  `messages` 的唯一来源；控制器绝不重新投影。

### 迁移后的页面接线

- `App.tsx` 为主聊天列渲染 `ChatSurface` 加 daemon 适配器，保留导航、
  设置与 daemon 专属面板。
- `SplitView` 与 `SideTaskPanel` 经收敛后的 `ChatPane` chrome 渲染
  `ChatSurface`；面板 chrome 留在宿主。
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
3. **daemon 先行抽取。** daemon 主聊天列先迁入 `ChatSurface`，并带视觉
   before/after 门禁，因为它是更大、风险更高的抽取。managed 第二步切换
   到一个已被验证的组件上；`ChatPane` 第三步收敛，使分屏与侧任务不保留
   第三套编排。每次切换都在替换它的同一切片里删除重复编排。
4. **操作保持封装。** 若把 Java 原始操作（幂等键、revision、回执）暴露进
   契约，managed 语义会泄漏进共享聊天面，并迫使 daemon 适配器伪造它们。
   通用的受理/结果语汇是聊天面可见的唯一异步语言。
5. **一致性跟随后端事实。** managed 在事实存在处获得共享状态栈与会话级
   用量统计（`ComposerUsageStats`，managed 侧事实来源是
   `diagnostics.getStatistics`）；context ring 今天已经渲染 `modelContext`
   的 token 观测，不算新增。没有后端事实的区域保持隐藏，而不是填入编造
   的数据。
6. **受理不等于确立。** 后端无关的 UI 状态不自动等于「动作已生效」的
   后端无关证明：一个笼统的 `completed` 标签可以对本地 API 调用为真、
   对用户的操作状态为假。两段结果把用户可见状态的真值条件留在共享契约
   里而不泄漏协议字段，且它是切片 1 的契约规则，不是适配器实现细节；
   每个适配器的负例测试随该适配器落地（切片 2 与 3）。决策 4 不变：
   回执、revision 与恢复屏障留在 managed 适配器内部。

## 迁移切片

本文档是独立提案；实现切片分别落地。每个切片是独立可发布的 PR，带自己
的测试。

1. **契约与特征钉桩。** 新增 `chat-core`，含契约类型、能力模型与能力
   映射守卫（定型 managed 映射、`Required<>` 键集夹具、daemon 标签穷举
   记录）；新增 DOM 级特征测试，钉住三个聊天列的当前行为（输入框提交、
   审批应答、状态展示、草稿恢复）；以纯函数测试钉住受理/结果真值表。
   证明传输层成功绝不单独产生 `established` 的每适配器负例测试——覆盖
   延迟的回合结果、未结算的取消、被取代的审批——随各适配器在切片 2
   与 3 落地，不在本切片。无行为变化。
2. **抽取 ChatSurface，daemon 主列切换。** 把主聊天列从 `App.tsx` 迁入
   `ChatSurface` 加 daemon 适配器，并从内联 JSX 创建输入框状态栈组件。
   `ChatSurface` 渲染的共享审批/输入框组件（`ToolApproval`、
   `ChatEditor`）在此与 daemon 值导入解耦——先于内核引入它们
   （`MessageList` 的 SDK 导入是 type-only，构建时擦除）；daemon 适配器
   的负例测试随其落地。视觉 before/after 预览不得出现无法解释的
   daemon 侧差异。managed 与 `ChatPane` 不动。
3. **managed 切换，删除重复编排。** 新增 managed 适配器及其负例测试；
   managed 聊天列渲染 `ChatSurface`；从 `ManagedSessionsPage.tsx` 删除
   被替换的转录/输入框/审批/状态编排。managed 专属面板变为插槽。
4. **ChatPane 收敛。** 分屏与侧任务经 daemon 适配器渲染 `ChatSurface`；
   面板 chrome（标题、最大化/关闭、头部操作）以插槽保留；删除
   `ChatPane` 重复的提交、取消、审批与状态编排。
5. **按能力门控的一致性。** 在后端事实存在的范围内统一两侧的状态栈、
   用量统计与上下文用量/压缩展示。会话内搜索与目标展示在下文未决问题
   解决前保持门控。
6. **边界强制与清理。** 先清空 managed-only 值导入图中剩余的 daemon
   导入——约束中的例子是示意，不是穷举预算，普查在此重跑——再新增
   两道守卫：一道源码级导入说明符检查，证明 `chat-core` 自身模块绝不
   引入 daemon 代码（沿用现有 `build-artifact.test.ts` 检查的风格，
   后者读 `dist/`）；另一道在 `web-shell-managed-host.yml` 车道里对
   `dist-managed-host/index.js` 做产物 grep，因为默认 `build` 不产出
   managed-only 产物，且该车道今天不跑任何测试。删除死掉的编排与
   陈旧导入。

切片 2–5 期间，已迁移区域的新聊天功能只允许落在 `chat-core`，避免迁移
与功能开发竞跑。

## 约束

- `chat-core` 自身模块不引入 `daemon/**` 与 `@qwen-code/sdk/daemon`；
  适配器放在内核之外。Managed-only 入口继续在没有 daemon 运行时的情况
  下工作。今天其源码图仍经许多共享模块传递性地到达 daemon 值导入；
  以下例子是示意，不是穷举清单：`ChatEditor.tsx` 从 `daemon-react-sdk`
  值导入 `useOptionalWorkspace`（后者重导出 `daemon/index.ts`，后者从
  `@qwen-code/sdk/daemon` 值导出），共享消息组件如 `SystemMessage.tsx`
  直接导入 `@qwen-code/sdk/daemon`。共享审批/输入框的值导入边在切片 2
  解耦，因为 `ChatSurface` 渲染它们；切片 6 清空整个剩余图，而不是
  点名的子集，然后守卫才落地。在此之前，无 daemon 导入约束适用于
  `chat-core` 自身模块，而非整个 managed 源码图。
- 不改动 daemon 路由、Java 路由或 OpenAPI 契约。
- provider 存储键、会话 ID 命名空间与 tenant/actor header 不动；managed
  错误绝不回退 daemon 后端。
- 每个被移动的组件都适用仓库 Web Shell 规范的 CSS 作用域
  （`data-web-shell-root`、portal root）与 React 18/19 `forwardRef` 规则。
- 保留 managed 增量投影及其 epoch/去重语义；控制器消费投影器输出。
- 幂等、期望 revision 与回执语义留在 managed 适配器及其 hooks 内部。

## 风险与缓解

| 风险                                                           | 缓解                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 从约 27k 行的 `App.tsx` 抽取并收敛 `ChatPane` 导致 daemon 回归 | 切片 1 对三个聊天列的特征钉桩；切片 2 的视觉 before/after 门禁；小切片、daemon 先行 |
| 契约向某一后端形状漂移                                         | 每个切片对照契约评审两个适配器；用能力标志而非 `kind` 分支                          |
| managed 异步语义泄漏进聊天面                                   | 通用受理/结果语汇；原始操作绝不跨越契约                                             |
| 传输层成功被展示为已确立的结果                                 | 随各适配器落地的负例测试；`unsettled` 是一等状态且跨刷新保留                        |
| 重新投影或丢失 memo 化导致性能回归                             | 控制器消费增量投影器；memo 边界由测试钉住                                           |
| 功能开发与迁移竞跑                                             | 冻结规则：已迁移区域的新功能只经 `chat-core` 进入                                   |

## 验证计划

- 每个被移动模块的并置单测；现有 daemon 与 managed 套件
  （`App.test.tsx`、`ManagedSessionsPage.test.tsx`、各 `use-managed-*`
  测试、`ManagedAgentWebShell.test.tsx`）保持绿，且随各适配器落地的
  负例测试证明传输层成功绝不单独产生 `established`。
  `managed-draft-retry.spec.ts` 已覆盖跨刷新的未结算提交；新增覆盖
  补上取消路径与一条显式的「区别于 `failed`」断言。
- 通过本地 dev server 对真实 daemon 与 managed 启动路径做两类会话的
  浏览器级验证：提交、审批、取消、草稿恢复、刷新/深链恢复与面板插槽，
  覆盖主聊天列与分屏/侧任务，断言打在 DOM 上而非仅看截图。
- 现有 managed Playwright 规格（`managed-usability`、
  `managed-context-compression`、`managed-recovery`、
  `managed-draft-retry` 及同类）在迁移后的聊天面上运行。
- web-shell 视觉预览 CI 为每个切片提供 before/after 证据；daemon 侧
  差异（含分屏与侧任务）必须为空或可解释。
- 门禁：包级 `typecheck`、`tsc -p tsconfig.lib.json`（更严格的 CI 构建
  门禁）、包级 `build`、根级 `build` 与 `bundle`、定向 lint 与格式检查。

## 验收标准

1. 每一个聊天列——daemon 主列、分屏、侧任务与 managed——经由同一个
   `ChatSurface` 组件渲染；导入图显示一个聊天面、两个适配器。
2. 现状表列出的分叉编排从 `ManagedSessionsPage.tsx` 与 `ChatPane.tsx`
   删除（转录、输入框接线、审批流程、状态展示），后端专属面板以插槽
   保留。
3. `chat-core` 自身模块不含 daemon 导入，且 managed-only 源码图已清空
   daemon 值导入，由源码级检查加 managed-host 车道的产物 grep 证明；
   Managed-only 入口继续在没有 daemon 的情况下工作。
4. 现有 daemon 与 managed 单测套件及 managed Playwright 规格通过；
   视觉预览无无法解释的 daemon 侧变化。
5. managed 会话在后端事实存在处展示共享状态栈与会话级用量统计
   （`ComposerUsageStats`），缺席区域按能力门控。
6. 受理不等于确立的不变式成立：每适配器的负例测试证明传输层成功绝不
   单独产生 `established`；`unsettled` 与 `failed` 渲染可区分且跨刷新
   保留；被取代的审批渲染为 superseded，而不是 applied。

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
