# Daemon 聊天控制器组装（Slice 2c）

[English](2026-11-19-daemon-chat-controller.md) |
[简体中文](2026-11-19-daemon-chat-controller.zh-CN.md)

状态：已实现（slice 2c，适配器核心）。日期：2026-11-19。属于
[统一聊天界面](2026-11-16-unified-chat-surface.md)迁移的一部分。建立在已合入的
契约（#17520）、composer 解耦（#17661）、状态栈抽取（#17684）与 daemon 意图引擎
（#17709）之上。

## 范围

Slice 2b 落地了意图生命周期引擎（`createDaemonChatIntents`）：它把 admission 与
outcome 分开、并把结算绑定到被派发的操作 id，但它不认识 daemon 的后端身份。本切片
落地 **daemon 适配器的控制器组装** `createDaemonChatController(deps)`，把注入的
provider 事实与动作包装成后端中立的 `SessionChatController`，并兑现引擎留下的关联
要求：到来的 daemon 事件在能结算任何东西**之前**，先被绑定到它所属的那次尝试。

适配器的新逻辑是**关联**，而非 transcript 或子控制器。transcript 消息、状态事实、
能力旗标、能力门控的子控制器都从 provider 透传；适配器不重新投影、不重新推导。
从 `DaemonSessionProvider` 各 context 构造 `deps` 的绑定 hook、以及消费该控制器的
`ChatSurface` 组件，是接下来的步骤（表面切换，含视觉前后对比门）。

## 依赖注入

`createDaemonChatController(deps)` 是纯组装：每个 provider 事实与动作都被注入，
故无需挂载约 7k 行的会话 provider 即可测试。事实字段经 getter 在每次访问时读取，
故带 getter 字段的 `deps` 对象在渲染之间保持最新；绑定 hook 用活的 provider 状态
支撑它们。transport 只 resolve 出 **admission**；权威 outcome 证据经独立订阅到来。

- `submitPrompt(input, onAdmitted)` 在 admission 时（provider 的 `onAdmitted`
  钩子）报告 daemon 的 `promptId`，先于 turn 运行。
- `cancelPrompt()`、`submitPermission(requestId, optionId)`、
  `submitQuestionAnswers(requestId, answers)` 仅 admission。
- `subscribePromptSettlement` 送达 turn 的终态事件
  （`completed` / `cancelled` / `failed`），按 `promptId` 键控。
- `subscribeDecisionSettlement` 送达某决定是否作用于它所点名的请求。
- `subscribeApprovalCurrency` 在请求到达时标存活、仅在被取代或取消时标不存活——
  绝不只因被应答。
- `signal` 在 abort 时释放证据订阅（绑定 hook 把它系到控制器的挂载生命周期）。

## 关联：证据必须点名它所建立的尝试

引擎按操作 id 结算；daemon 事件点名 `promptId` 或 `requestId`。适配器桥接两者，
且引擎暴露 `settleDecisionRequest(requestId, witness)` seam，使决策证据即便在该
尝试的 POST 仍在飞（操作 id 尚未绑定）时，也能作用于该请求的存活尝试。

Prompt（submit / cancel）：

- submit admission 时记录 `promptId -> operationId`。终态事件只结算绑定到其身份的
  尝试，绝不按可见的 session/turn target 匹配，故已结束尝试的迟到事件无法建立共享
  同一可见 target 的重试。
- 一个 turn 的终态事件同时关闭启动它的 submit 与指向它的 cancel
  （`promptId -> Set<operationId>`）。终态结果**按绑定操作的 kind 投影**：cancel
  仅由 `cancelled` 的 turn 建立——自行完成的 turn 恰证明取消未生效，故为 `failed`；
  submit 由任何终态结果结算，仅失败 turn 使其 failed。
- cancel 指向**存活 turn**——存活 turn FIFO 的队首（终态事件尚未到达的最旧准入
  prompt），在派发时捕获——绝不用最新被准入的 id。prompt 在终态事件到达或 submit
  被拒时出队。被拒的 prompt 记入墓碑，使指向它的 cancel（两种解析顺序皆然）走
  `failed` 终态出口，而非绑定一条永不结算的行；队列为空时 cancel 同样结算 `failed`，
  phase 不钉死。
- 终态事件可能在 POST 在飞时、甚至在 `onAdmitted` 之前到达。适配器按 `promptId`
  保留终态结果并在尝试绑定时应用；意图返回绑定后的 outcome，而非证据前的 dispatch
  快照。只要 submit 派发未绑定、或者 cancel 绑定待定（按 prompt 引用计数，重叠的
  cancel 都使其保留），保留的结果就不被裁剪，故行保留期的更替不会搁死待定绑定。
  终态结果已到达的 prompt 不再入队作为存活 cancel 目标。
- transport 在 `onAdmitted` 已确认 prompt id **之后**抛错的 submit，是客户端丢失了
  admission 响应的真实 turn：prompt 保留为存活 cancel 目标，使其终态事件能结算已绑定
  的 cancel，仅 submit 行走 `abandon` 出口。`rejected` 的 submit（daemon 拒绝）不同：
  没有 turn 运行，故出队并记墓碑。

决策（approval / question）：

- `requestId` 在多次尝试间稳定，且 daemon 决策事件只点名请求（无尝试/选项判别符），
  故关联是**请求级**：引擎把证据路由到该请求唯一的存活（非终态）尝试，并在**证据
  到达时**冻结 approval 时效，而非 POST 解析时。对已终态尝试的迟到事件是空操作。
  决策 target 只带 `sessionId`/`requestId`（无逐尝试 id），故终态行保留仍按请求去重。
  **重放局限**：事件无尝试判别符，结算通道的重放投递可能落在存活重试上；除非结算
  通道去重或携带后端尝试身份，请求级关联对重放不安全。这是对绑定 hook/provider 的
  集成要求——适配器无法仅凭 `{requestId, applied}` 区分尝试——作为后续跟踪，而非
  在此声称已解决。
- 一个请求**至多一条非终态决策尝试**：已有在飞决策（已绑定或在飞）时第二次派发被
  拒绝，故不会孤儿化兄弟尝试。**存活局限**：已接受但永远收不到结算事件的尝试保持
  非终态、持续拒绝重试；给它有界出口（超时、或推迟到表面切换的 `acknowledge`/
  `abandon` 暴露）是后续工作，故该状态下不声称「永不永久无法回答」。
- 失败决策后的重试赢得自己的证据（失败决策保持请求存活）。由于引擎把证据作用于
  存活尝试，被拒或重试的派发绝不继承上一次尝试的判决。
- admission 未获确认的派发（`rejected`、或抛错留下 `unknown`）不会像已接受那样被
  绑定：给予引擎的 `abandon` 出口，使丢失的 admission 响应不钉死 phase。

### 关联状态有界

关联 map 以引擎的保留为上界：一旦尝试不再属于保留的操作（被确认或被取代），其
后端身份即停止被跟踪。只要仍有派发需要它——待定 cancel 绑定（引用计数）、或未绑定
的 submit 派发——保留的 prompt 结果就被保留，否则丢弃，故见证生命周期与展示行生命
周期解耦。prompt id 由 daemon 逐 turn 唯一，故保留的孤儿不会匹配后续尝试。结算订阅也会送达本控制器从未派发过的身份的终态事件（回放的历史、其他客户
端的决定）。这些**孤儿**结果除非有派发在飞，否则被丢弃，故既不累积、也不会认证未来
的尝试。被拒 prompt 的墓碑在无待定 cancel 绑定时清除。决策证据完全不在控制器缓冲
——引擎 seam 直接作用于存活尝试——故没有可泄漏的决策见证。

## 保留的不变量

admission 不等于 establishment。仅 transport resolve 使 outcome 保持 `unsettled`；
只有被绑定的终态/决定见证才提升它。被取代或无身份的 approval 在正向证据下绝不建立
（引擎的时效守卫），而否定证据仍使尝试终态化。负向测试随本适配器落地，符合父设计
要求。

## 测试

`chat-controller.test.ts` 用 fake 注入 provider 钉住：已 resolve 的 submit 在 turn
结算前保持 unsettled；失败 turn 终态化；rejected submit 不跟踪；已结束尝试的迟到
事件无法建立同 target 重试；乱序事件各落在它点名的尝试；在飞证据在 admission 解析
后应用；孤儿终态事件不能认证之后的尝试；重复终态事件不再结算；已 resolve 的 cancel
在 turn 结算 cancelled 前保持 cancelling；turn 已结算后的 cancel 既不认证也不钉死；
cancel 绑定存活（FIFO 队首）turn 而非排队 prompt；在飞的 rejected cancel 不搁死与之
重叠的 submit；作用于存活请求的决定建立而被取代者绝不；无证据的已准入决定保持
unsettled；失败决策后的重试赢得自己的证据；rejected 决策派发不破坏关联；已有在飞决策
时第二次派发被拒绝；question 应答建立；透传事实被逐一区分暴露且活读、`loadOlder`
保持 deps 绑定；无操作持有时报告结算 `failed` phase；signal 释放全部三个订阅。竞速
关联用例另钉住：首个 POST 在飞时第二次决策派发被拒绝（采样 pending 行）；重试 POST
期间的决策证据结算重试而非上一次尝试；对已终态尝试的迟到重复决策是空操作；rejected
决策派发不给下一次尝试留证据；时效在证据时冻结的两个顺序（存活后被取代仍建立；被取代
后存活走 `failed` 终态出口）；POST 期间的决策证据在 admission 解析后应用；同一请求的
孤儿决策不产生任何操作；cancel 先于/后于其 submit 被拒的两种顺序都被终态化；被拒
prompt 上两个重叠 cancel 都终态化；后续 submit 挤掉目标行时 cancel 仍能结算；cancel
行被挤掉时在飞 submit 仍能结算；`onAdmitted` 之前的终态事件结算 submit、其后继存活
turn 仍可取消；目标 turn 自行完成的 cancel 为 `failed`；rejected submit 不留存活
cancel 目标；admission 后抛错的 submit 保留已确认 turn 可取消；抛错的
permission/question/cancel transport 获得出口（决策仍可回答且可认证、phase 不钉死）。
每条修复均可经变异判别：按 kind 的 cancel 投影、待定 cancel 引用计数、已确认 turn
保留、终态先于 `onAdmitted` 的队列守卫、未确认的 `abandon` 出口，还原各自即红其对应
用例、相邻用例仍绿。

## 留给表面切换的后续

- 契约尚未暴露 `acknowledge`；表面必须释放已消费的终态行（否则按不同 target 增长）。
  `abandon` 已在内部用于给未确认的派发一条出路。
- 决策关联是请求级，因为 daemon 决策事件只点名请求（无尝试/选项判别符）。重放安全
  的决策关联要求结算通道去重、或携带 daemon 目前不发出的后端尝试身份；在此之前重放
  投递可能落在存活重试上。这是集成要求，未在适配器层解决。
- 已接受但永远收不到结算事件的决策尝试需要有界出口（超时、或上述 `acknowledge`/
  `abandon` 暴露），使其不至于持续拒绝重试；同理，控制器挂载前已被准入的 turn 的
  cancel/submit 需要绑定 hook 播种存活 turn 队列。两者均属表面切换。
- approval 时效须为构造时已存活的请求播种（`deps.liveApprovalRequestIds`、或回放
  存活集合的订阅），并遵循 `pendingApprovals[].status`，使被取代请求不被播种为存活。
- 无存活 turn 时派发的 cancel 结算为 `failed`（终态出口）；表面仍仅在 turn 在飞时
  启用 cancel。
- `deps.settledPhase` 由绑定 hook 从会话的结算态填充；其 `failed` 读取在此已有测试
  钉住，故该分支非死开关。
- 绑定 hook（provider context -> `deps`，复用既有 daemon 能力映射）与带视觉前后
  对比门的 `ChatSurface` 主列切换，是接下来的增量。

## 遵守的约束

- 不改 daemon 路由、Java 路由或 OpenAPI；不改 UI 行为（控制器尚未被渲染）。
- 适配器位于 `daemon/`、在 `chat-core` 之外；它导入契约与引擎，`chat-core` 不导入它。
- 会话 id 命名空间与存储键不变。
