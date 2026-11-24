# Managed Chat Controller Provider 绑定（切片 3b）

[English](2026-11-24-managed-chat-controller-binding.md) |
[简体中文](2026-11-24-managed-chat-controller-binding.zh-CN.md)

状态：提议（slice 3b）。日期：2026-11-24。
基准：`9192034e9404f5de75951f27ae5fa595ef1f529e`，即 #18117 squash 合入 main
的提交。属于[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)，基于
[切片 3a 适配器核心](2026-11-22-managed-chat-controller.zh-CN.md)。

## 问题与现状

切片 3a 提供了 `createManagedChatController(deps)`，并验证了后端中立的意图
台账、待动作投影与结果映射。那些测试使用注入依赖，不是真实 Managed
provider。

真实 Java provider 能提供 prompt 准入与规范化 session 事件，足以表达 turn
终态。其 `actions.respond()` 在内部也拥有正确的 operation 数据，却把准入回执
与最终 operation 隐藏在 `Promise<void>` 之后。它在内部能区分成功、失败、恢复
阻塞和未确认超时，调用方却无法可靠重建 `accepted + unsettled` 与
`accepted + failed`。简短的 `action.updated` 只能提示刷新，不能证明当前修订
对应的回答已经应用。

`useManagedSession`、`useManagedActions` 与 `useManagedTurnCancel` 已经分别负责
增量历史、待处理列表、修订、幂等与取消恢复。绑定必须保留这些职责，不能再造
一套协议、一次转录投影或另一套轮询生命周期。

切片 3b 只做这一层窄绑定，不切换 `ManagedSessionsPage`，也不承担留给切片
3c 的视觉一致性验收。

## 目标

- 把既有 Managed session 接入 `SessionChatController`，使用真实 provider 事实
  与既有增量消息、待动作 hooks。
- 在 owner 不变时保持同一个 controller 及其本地意图／投影状态，而不是在每次
  summary、event 或 pending-list 渲染时重建。
- 暴露“已有”的原生 operation 证据，区分准入、建立、失败和未确认结果，不虚构
  新路由、协议字段或终态见证。
- 收口 3a 评审留下的两项要求：只有期限变化时不重置用户尚未完成的作答；四项
  防御性结算条件分别得到有意义的见证或准确的冗余说明。
- 保留既有 provider、历史、动作与取消调用方的行为。新增 hook 在 3c 之前仍不
  接入生产页面。

## 范围与非目标

本切片覆盖一个既有 session 的消息、待权限／提问、submit/cancel 意图，以及相应
结算事实。待动作按 `includeChildren=false` 加载：controller 的动作身份限定在
单个 session 内，不混用 child session 集合。

不包含创建 Session、消息排队、页面 prompt 持久化逻辑大提取、
`ManagedSessionsPage` 迁移、共享提问卡片中 `required`/`allowText` 改造、视觉
before/after 验收、向 managed 新代码引入 daemon runtime 依赖、Java 服务端或
OpenAPI 改动、生成契约改动、session-id/tenant 命名空间变化、全局能力对齐或
新的子控制器。本切片不臆造 model、approval、compression、lifecycle 等可选
子控制器的全面接线。

## 设计

### owner 身份与实时事实

`useManagedChatController` 接收一组精简的 owner 输入：

- `provider: ManagedAgentProvider`：真实 provider 对象，不新建另一层 context。
- `clientId: string`：既有的 scoped Managed client 标识。
- `sessionId: string | undefined`：选中的既有 session。

只有得到匹配的真实 session summary 时才返回 controller；owner 或 summary 尚不
可用时返回 `undefined`。不得凭空置造 `'created'` 状态，也不得把缺失 session
回退到 daemon 后端。

controller 的主人由 `provider 对象身份 + clientId + sessionId` 组成。provider 快照
或 React updater 不得误改这一归属。hook 按 owner 构造一次 controller，把最新事实
与传输函数保存在 refs 中，经 getter 与 forwarder 暴露。普通的 event、summary、
history、pending-list 更新都保持同一个 controller 及其不变量。owner 变化会终止
旧的订阅投递和迟到回调，不能修改新 owner 的台账，也不能替新 owner 回答待处理
提问。

这种稳定性也是 3a 的 pending projection 缓存得以成立的前提，但并不意味着
真正 change owner 后仍会保留本地 attempt 历史。

### 转录与待动作

- 使用 `useManagedSession(provider, clientId, sessionId)` 获取 summary、events、
  older cursor 和 loading 事实。
- 使用按 owner 建立的 `createManagedMessageProjector()`，并使用 `useI18n` 中既有
  `managed.truncated` 文案。controller 不再自行重投影原始 events；数据的新鲜度与
  去重遵循既有增量投影器，不能凭事件数量猜测。
- 只规范化当前 owner 的事件。turn 终态事件只按事件自身的 turn 身份转发。旧或
  重复快照、另一 owner 的迟到事件不得结算当前 controller。不得由 turn 级失败
  推演 operation 的 `recovery_blocked`。
- 使用 `useManagedActions` 获取权威 pending 列表，保留其 owner/revision/refresh
  行为与单 session 范围。其高级 response 帮助方法不用于证明 admission 或
  establishment，因为它为了兼容旧页面，会有意隐藏某些终止结果。
- 通过 `managedCapabilitiesFromSummary(summary)` 获取能力。独立的 `canSend` 与
  `canCancel` 传输谓词仍必须生效；它们没有映射为可见子控制器，并不代表准入
  放行。

历史方面，`hasOlderHistory` 来自真实 older cursor，`loadingOlder` 来自 hook 的
真实加载状态，实际 loader 通过 ref 保留。后端中立的 `{force: true}` 在这里是
建议性输入：Managed 现有的零参数 `loadOlder` 已包含自身的重试/cursor 生命周期。
绑定不会声称转发了或新实现了 `force` 选项。provider 没有明确依据的
capacity/pagination-error 可选字段保持缺省，不臆造为 `false`。

### 提交 prompt 与取消

- 提交只经过既有 Managed client：文本、图片和文件使用 `encodeManagedInput`，
  保留其中的 UTF-8 与编码大小检查。annotation 准备、新 Session 和排队消息
  的提交仍由原有职责负责。
- 原生 `{sessionId, turnId, operationId}` 是准入而不是建立。缺少准入身份的
  成功返回不能静默当作 accepted，应返回 `unknown`。匹配 owner 的 turn 终态
  事件结算绑定的 turn。早到事件可以继续使用 3a 的带 dispatch-sequence 缓冲，
  包括早于 transport promise resolve 到达的事件。
- 对新的一次 prompt 命令，在传输派发时使用一次 `managedRequestId()`，而不是
  每次渲染产生新 key。这只是这条命令的身份，不代表未知的确认缺失或刷新后
  可以安全重放。
- 取消沿用现有 `useManagedTurnCancel` 生命周期，保留其持久化 intent、owner
  abort、query 与 `refreshSummary` 行为。只在既有 receipt 与校验后的 query 位置
  增加窄观察：暴露 accepted operation 身份与最终原生 operation，不额外宣称
  完成。挂接的 controller 保持取消轮询可用；这用于观察活跃性，不是发送取消的
  授权。
- `completed`、`failed`、`cancelled` 与 `recovery_blocked` 继续区分。后者只能
  根据实际 cancel operation 读取结果映射为 `unsettled`。

本切片不重建页面的 prompt outbox，也不承诺丢失 prompt 确认后可以安全重放，
详见后方未决问题。

### 审批／提问响应的最小观察 seam

保留已有调用方使用的 `actions.respond(action, response, command)`，在命令选项
中增加两个可选、仅在进程内的回调：

- `onAccepted`：response operation 被接受且身份通过校验后，观察 session 与
  operation 身份。这是 durable admission 边界，不是终态结果。
- `onSettlement`：既有 operation 读取得到 `completed`、`failed`、`cancelled` 或
  `recovery_blocked` 后，观察 session、operation 身份及该原生终态。

实现直接传递 `client.respondAction` 与 `settleActionResponse` 已产生的值，不增加
协议字段、wire 事件或轮询计划，回调不会序列化进入请求载荷。session、operation id
或 operation 类别不一致的 accepted response 必须拒绝。外层 `respond()` promise
即使 fulfilled 也不代表 establishment。旧方法把 failed／cancelled／recovery_blocked
转换成既有 `Error` 之前，可以先调用 `onSettlement`；原有错误契约及旧页面的错误
处理保持不变。

绑定按调用维护这些观察、按 owner 过滤，并经 `subscribeOperationSettlement`
映射终态 operation。不得把简略的 `action.updated` 改造成虚构的 action 结算。
由此，accepted 后失败与 recovery blocked 仍保留各自的契约含义；轮询超时仍未
确认时，已准入的 attempt 保持 `unsettled`，不能伪造成功或 rejected。其他
provider 若没有观察能力，约束结果是 `unknown`，不能仅因 `Promise<void>` fulfilled
就合成 accepted 凭据。

还没有 accepted 证据时，使用 `isNonRetryableClientError` 将权威、非认证的 4xx
映射为 `rejected`；认证问题、限流、网络错误、准入身份缺失以及未确定性映射为
`unknown`。后续已有终端 operation 证据的结果，不能因为事后 `respond()` 的错误
返回而被降级。

提问正文保留 `canonicalQuestionAnswers` 与 `questionResponseKey`；审批的幂等键仍
为 `${actionId}:${optionId}`。请求继续携带源 action 的 `inputRevision` 与
`policyRevision`，本切片不发明只有 label 或缺 id 的降级路径。
`QuestionAnswer.questionId`、`optionIds` 和自由输入 `text` 始终分离。

### 待动作期限与结算防御

当前 Action 生产者在创建时保存绝对期限，Java API 与 provider 只复制它，不在每次
读取时延长。渲染层仍应安全处理只有期限数值变化的情况：从**渲染内容签名**中
移除 `expiresAt`，同时保留每次读取按当前时间执行的 `isActionExpired` 过滤。
仅期限变化不得重建 request 或 `rawInput`。动作消失后重现、kind/revision 改变或
真实渲染内容改变，仍必须使投影失效。这既保留用户作答，又不延长已过期 Action
的生命周期。

此前指出的四项防御条件明确收口：

- 已终态的 operation 不能再次作为“未匹配”进入缓冲候选；缓冲资格与实际终态
  应用是两个决策。未匹配 operation 的缓冲仍要求有 dispatch 在飞。
- action 的 terminal-skip 与 `applyState` 的终态守卫重复。保留这份低成本直接
  防护，但明确指出它的冗余性，不把“已有覆盖”伪称为新见证。不得为了证明
  并不存在的差别而编造场景或制作删除变异表演。
- 只有在飞的那个 action 本身才允许写入 action 缓冲。其他 action 的事件或早于
  当前 attempt 的事件，不能因为另一个全局 dispatch 尚未排空而被救回。
- 保留 dispatch-sequence 门与终态不得削弱规则。回归见证必须覆盖真实
  provider/hook 观察点，至少包含一条早到或本地重放的实际顺序，不只是正向
  绿测。

### 生命周期、错误与投递

owner 改变或 unmount 时释放其注册。迟到的 transport 或事件结果不会进入新
owner 的 listeners。在 turn 事件投递开始前先建立初始事件 cursor，后续快照按
既有事件 identity/epoch 语义去重，不把快照当成新事件重播。停止观察并不等于
取消服务端已经接受的 operation。

`detail.stoppedReason`／`stoppedLeg` 与真实 loading 状态决定转录状态；一次
older-page 临时失败不得偷偷成为整个 session 的终态错误。queue 与 goal 字段继续
使用既有保守默认值，不在本切片制造虚假的 parity 事实。

## 涉及文件

- 新增 `packages/web-shell/client/components/managed/use-managed-chat-controller.ts`
  与 `.test.tsx`，覆盖 owner 归属绑定和真实组合测试。
- `managed-agent-provider.ts`、`java-managed-agent-provider.ts` 及后者测试，加入可选
  响应观察与原生身份校验。
- `use-managed-turn-cancel.ts` 与 `.test.tsx`，在已有取消 receipt/query 位置增加
  观察，不替换持久化 intent 逻辑。
- `chat-controller.ts` 及针对性测试，覆盖期限与身份稳定性；既有
  `chat-controller.local-integration.test.tsx` 只新增 expiry-only 父级重渲染回归，
  不扩展为完整页面集成。
- 本双语设计，以及 3a 文档中的后续切片指引。

## 验证与验收标准

- 既有 managed、action、cancel、controller 测试保持通过；不能悄悄改变原有错误
  分类或幂等行为。
- 使用真实 Java provider 对象加 mock HTTP，验证精确的 submit/action/cancel 请求
  载荷，并将准入与最终 operation 证据分开。测试替身不得加入真实 provider 没有
  的方法或响应类型。
- 真实 hook/provider 组合必须覆盖：普通 re-render 稳定、owner 切换、旧事件拒绝、
  订阅清理、accepted/rejected/unknown 准入、早到结算、accepted 后失败以及真实
  recovery blocking。
- `optionIds`、`text`、revisions 与幂等键一路保留到实际记录的 HTTP 调用中；结构
  化答案不能退回 label。无效、过期与重复决策不得派发。
- 只有期限变化时，array/request/`rawInput` 身份保持不变；推进时钟仍使动作
  过期；消失或真实内容变化仍使其失效。真实共享提问卡片在 expiry-only 的
  父级重渲染后保留用户选择和文本。
- 四项结算防御都获得有意义的见证或准确的冗余依据。正向见证必须证明进入了
  被保护的分支，而不是走默认路径。
- package build、两个 web-shell 类型门、聚焦单测／集成测试、针对性 lint/format
  与仓库 build/typecheck/bundle 通过。

mock HTTP 测试不代表真实 Java 服务或真实模型调用。实际页面切换、对应浏览器
场景和视觉 before/after 证据仍然是 3c 的验收工作。

## 风险与取舍

首要风险是把 client 方法的 fulfilled 直接伪装成终态并宣称绑定已完成。观察
seam 为 provider 增加了窄接口，就是为了避免这种不诚实的捷径。绑定复用既有
pending 与 cancel 生命周期，不另建一套命令队列，也不重写 session storage。

稳定的 session controller 并不意味着真实 owner 重建后能自动恢复本地已准入
attempt 台账。当前纯适配器没有通用的 live-operation seed contract。测试会区分
普通生命周期保证与这个明确限制，不会模拟并不存在的 seed endpoint。

expiry-only 的稳定性是渲染不变量，不是回答已过期 Action 的许可。未来 provider
如果真的续期，身份规则已覆盖；但并不声称今天的 provider 会在每次读取时延长
期限。

## 页面接线需要显式回答的问题（不是隐藏默认值）

1. **确认缺失时的 prompt attempt 身份。** `ComposerSubmit` metadata 没有 Managed
   的幂等 key，现有页面掌握持久化 prompt intents 及其 key。hook 新发出的 prompt
   不能默默宣称支持刷新后的安全重放，也不能在无法辨识是否为同一用户回合时
   使用新 key 再次发送。未知准入始终保持明确的 unknown/unsettled，而不是自动的
   安全重试。进入 3c 前后，调用侧绑定时必须通过显式窄契约提供既有稳定 attempt
   身份，或者明确接受并记录不支持这种重试；不能根据草稿文本相同来猜测意图。
2. **真实 owner 重建后的既有 operation 恢复。** 真正的 seeded restoration 需要
   实际 summary/operation 证据及兼容的 controller seed contract；单独一个
   `activeTurnId` 不能恢复本地 attempt。这必须在后续切片结合真实 provider 数据
   设计，不能假装当前 hook 已经提供完整的跨刷新意图连续性。
