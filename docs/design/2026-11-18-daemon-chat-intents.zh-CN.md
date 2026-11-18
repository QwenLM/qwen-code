# Daemon 聊天适配器：意图生命周期（Slice 2b）

[English](2026-11-18-daemon-chat-intents.md) |
[简体中文](2026-11-18-daemon-chat-intents.zh-CN.md)

状态：已实现（slice 2b）。日期：2026-11-18。属于
[统一聊天界面](2026-11-16-unified-chat-surface.md)迁移的一部分。Slice 1
（#17520）已落地契约与纯 admission/outcome 助手；composer 解耦（#17661）与
共享状态栈抽取（#17684）均已合入。本切片落地 daemon 适配器的意图生命周期核心，
以及证明「admission 不等于 establishment」不变量的负向测试。

## 范围

daemon 适配器把 daemon 会话状态与动作转成后端中立的
`SessionChatController`。它的新逻辑不在 transcript 或子控制器——那些在下一步
从现有 provider 组装——而在**意图生命周期**：submit、cancel、approval、question
如何报告 admission 与 outcome，且绝不把一次已 resolve 的 transport 调用与一个
已建立的效果混为一谈。

本切片以一个小的、依赖注入的引擎 `createDaemonChatIntents` 交付该生命周期，
并随附父设计要求随 daemon 适配器落地的三个负向测试（延迟的 turn 结果、未决的
cancel、被取代的 approval），以及一条见证关联测试，使每份证据只作用于它所结算
的那次尝试。把引擎接到真实 `DaemonSessionProvider` 的动作与证据、
并组装控制器界面的其余部分（messages、待处理审批/提问、能力门控的子控制器），
是紧随其后的一步（slice 2c），该步把主列切换到 `ChatSurface`。本切片不改动任何
现有 UI。

## 不变量重述

契约区分了两个会被单一「completed」标签混淆的事实：

- **Admission**——请求是否被后端接受（`accepted`、`rejected`、`unknown`）。这是
  transport 调用所报告的。
- **Outcome**——是否有权威证据表明预期效果已建立（`established`、`unsettled`、
  `failed`）。这只能来自见证（witness）：turn 结束、取消结算、作用于仍当前请求的
  决定。

一个已 resolve 的 promise 是 admission，绝不是 establishment。Slice 1 已把真值表
（`resolveOutcome`）与操作保留/phase 派生钉为纯函数。本切片钉住**喂给它们的生命
周期**：引擎必须从证据而非 transport promise 取得 witness。

## 设计

`createDaemonChatIntents()` 返回一个跟踪器，含：

- `dispatch(kind, target, transport)`——执行意图的 transport，导出 admission
  （`accepted`/`rejected`；抛错的 transport 记为 `unknown`），记录一个
  `ChatOperation`，并返回 `{ operationId, result }`。该操作 id 就是结算证据必须
  点名的身份。outcome 以 witness `none` 解析，故已准入的意图在证据到达前保持
  `unsettled`。`rejected` 准入不携带 outcome，也不被跟踪，故结算其 id 是空操作。
- `settle(operationId, witness)`——把权威证据只作用于该 id 所标识的那次尝试，并
  重算其 outcome。未知或已终态的 id 是空操作，因此证据无法结算它并非为之下发的
  尝试。对 approval，决定**仅在仍作用于当前请求时**才建立：若记录下来的
  `target.requestId` 缺失或不再是 `currentApprovalRequestId`，witness 被强制为
  `none`，该决定绝不建立（被取代的 approval 是待处理项状态，而非已应用的结果）。
- `setCurrentApprovalRequest(requestId)`——跟踪哪个 approval 请求仍当前，使取代
  可被检测。
- `operations`——保留后的操作列表（slice 1 `retainOperations`：每个非终态条目，
  每个 kind+target 至多一个最新终态）。
- `phase(settled)`——slice 1 `deriveChatPhase`；一个未建立的 cancel 操作产生
  `cancelling`，与 cancel promise 是否 resolve 无关。

引擎只导入 `chat-core` 的契约类型与助手。它不导入 daemon 运行时，也不导入
`@qwen-code/sdk/daemon`，因此无需 daemon 即可测试，并按父设计的适配器放置原则
作为 daemon 适配器核心位于内核之外。其形式是后端中立的；managed 适配器（slice 3）
拥有自己的 receipts/revisions 映射，届时可通过把该生命周期提升进内核来共享，
而不是导入 `daemon/**`。

### 为什么单独设 `settle` 入口

若 `dispatch` 从 transport promise 的 resolve 导出 witness，那么一个快速或被 mock
的 transport 就会伪装成已建立的效果。把 `settle` 作为唯一能提升 witness 的路径，
使该不变量成为结构性的：transport 路径在字面上就无法产生 `established`。下面的
负向测试在这一边界被折叠时转红。

### 为什么结算要点名具体尝试

只有当 witness 属于它所建立的那次尝试时，它才算认证了 outcome——状态本身正确与
证据来源可信是两个独立条件。仅按 kind 加可见 target 匹配证据并不够：同一
session/turn 上的重试会复用该 target，于是已结束尝试的迟到 witness 会提升重试，
两份乱序到达的 witness 也会互换尝试。因此 `dispatch` 返回操作 id，`settle` 要求
提供它，引擎只能提升被点名的那次尝试的 witness，而结算已终态尝试是空操作。

引擎事后自行发明的 id 本身不认证任何东西：slice 2c 必须在发起请求时把操作 id
记在请求的后端身份旁，使到来的事件能点名它所属的尝试。适配器无法绑定的证据保持
未验证，而不是宣告新尝试已完成。

## 负向测试（随 daemon 适配器落地）

1. **延迟的 turn 结果。** `dispatch('submit', …)` 配以 resolve 为 `accepted` 的
   transport，得到 `unsettled`，phase 为 `running`。只有
   `settle(operationId, 'settled')` 才产生 `established` 并使 phase 回到 `idle`。
2. **未决的 cancel。** `dispatch('cancel', …)` resolve 为 `accepted` 仍保持 phase
   `cancelling`；已 resolve 的 cancel promise 并不结束它。只有结算证据才建立 cancel
   并清除 `cancelling`。
3. **被取代的 approval。** 当请求 `r1` 当前时，一个在 `r2` 取代它之后才被确认的
   `r1` approval 决定绝不建立；仍当前的 `r2` 决定则可以（正向对照）。承载不了
   请求身份的 approval 同样绝不建立：没有该决定所作用的请求，就无法核实其时效。
4. **见证关联。** 尝试 A 结算为 `failed` 后，A 的迟到见证绝不能建立同一可见 target
   上的重试 B；B 自己的见证则可以。同一组两份见证无论以何种到达顺序应用，结果都
   是 A `failed`、B `established`，故乱序证据无法互换尝试。

配套用例钉住：rejected 准入（无 outcome、不跟踪，结算其 id 为空操作）、抛错的
transport（`unknown`，即便有 settled witness 也绝不建立）、failed witness、
对未知 id settle（空操作）、以及有界保留。

变异见证（可通过编辑引擎并从 `packages/web-shell` 运行
`npx vitest run client/daemon/chat-intents.test.ts` 复现）：把 dispatch 的 witness
取自 transport（用 `'settled'` 而非 `'none'`）会令延迟 turn 与 cancel 用例转红；
移除 approval 取代守卫会令被取代 approval 用例转红；按 kind 加 target 而非操作 id
结算会令两条关联用例转红；允许重复结算已终态尝试会令迟到见证用例转红；把缺失的
`requestId` 当作当前会令无身份 approval 用例转红。

## 遵守的约束

- 不改 daemon 路由、Java 路由或 OpenAPI；不改 UI 行为。
- 引擎位于 `chat-core` 之外，既不导入 `daemon/**` 值代码也不导入
  `@qwen-code/sdk/daemon`；`chat-core` 不导入它。
- 幂等/receipt 语义不在本切片；managed 适配器在 slice 3 保留它们。

## 后续（slice 2c）

把 `DaemonSessionProvider` 动作包装为 transport、把 daemon 事件作为 `settle`
证据，并在派发时登记的操作 id 上绑定每个事件（显式对照表；无法绑定的事件保持
未验证），组装控制器界面（messages、待处理审批/提问、能力门控的子控制器），并以
视觉前后对比门把主 daemon 列切换到 `ChatSurface`。
