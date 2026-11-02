# 把会话 config-sync 域绑定到附件生命周期，而不是 SSE 流

[English](2026-11-02-web-shell-config-sync-attachment-lifetime.md) | [简体中文](2026-11-02-web-shell-config-sync-attachment-lifetime.zh-CN.md)

状态：已随本次改动实现。

## 问题

`E2E Smoke` lane 在 `web-shell.smoke.spec.ts` 的「previews qwen3.8-max reasoning
before lazy session creation @smoke」上失败，而这些运行的 diff 不含任何
web-shell 代码（issue #16065）。模型按钮稳定停在 `qwen3.8-max · Thinking Off`，
测试期望的是 `qwen3.8-max · Medium`；三次尝试签名完全一致，并在整个 20 秒 expect
窗口内一直是错的。

这不是超时，也不是请求顺序违约。daemon 收到并确认了 `reasoning_effort=medium`
写入，客户端随后丢弃了这个已确认值，而且再也没把它读回来。用户可见的后果是：
首条 prompt 之前做出的 reasoning 选择在会话创建时被静默丢失，输入框继续显示
选择之前的值。

同一 lane 里还有另一个互不相关的失败——`web-shell.settings-exclusions.spec.ts`
——它耗尽了共享的 60 秒单测预算。下面「范围」一节会覆盖它，但它不需要设计决策。

## 现状

`attachSession()` 在 transcript replay 注入完成后就 resolve，早于会话元数据请求
落定。这是有意为之：`DaemonSessionProvider.tsx` 中 replay 注入上方的注释记录了
transcript 会提前一个元数据往返就完成绘制，这在高延迟移动端上有意义。

`createAndAttachSessionForPrompt()`（`utils/sessionPreparation.ts`）利用这个提前
resolve，在 load effect 仍在 await 元数据时就依次执行 `setModel()` 与
`setReasoningEffort()`。

配置读写的顺序由一个按会话存在的域对象维护（`session-config-sync.ts`，一个
`WeakMap` 条目，持有 `generation`、`pendingWrites`、`readSequence`）。
`daemon/session/actions.ts` 里的 `captureConfigOwner()` 快照该对象的身份，
`beginSessionConfigMutation()` 快照它的计数器；两者都会在 daemon 应答到达时
再次校验。

load effect 原先在建立 SSE 流的位置调用 `resetSessionConfigSync()`——它删除条目
并创建一个全新对象。这个位置在 `await metadataPromise` **之后**，因此可能正好
落在首 prompt 配置写入的中途。

### 证据

取自 CI run `41444684995` attempt 2、retry 1 的 trace（artifact
`web-shell-e2e-smoke`，`0-trace.network`）：

```
13:56:03.643  POST /session                          创建
13:56:04.411  GET  /workspace/providers   耗时 510.7 ms -> 04.922 落地
13:56:04.413  GET  /session/<id>/context             load 的元数据读
13:56:04.415  POST /session/<id>/model               setModel
13:56:04.557  GET  /session/<id>/context             setModel 自己的读
13:56:04.935  POST /session/<id>/config-option       已确认的 medium 写入
13:56:04.966  POST /session/<id>/prompt
```

由此得到三个事实：

1. 两次 `context` 读都在写入之前，因此都携带场景初始的 `reasoning_effort` 值
   `none`。`setModel` 应用的就是这个值。
2. 写入之后没有再发出任何 `context` 请求，说明 `setReasoningEffort` 的 `finally`
   块欠下的那次 reconcile 从未运行。
3. 浏览器 console 里没有任何 `[WebShell] failed to ...` 警告，说明写入在 HTTP
   层成功、且 daemon 已确认。

同时门禁住「应用」与「reconcile」的谓词只有 `isOwner()`。在它的各个子句中，
config-sync 对象身份是 load effect 在这个窗口内可证明会改变的那一个。epoch 子句
不是元凶：mock daemon 从不下发 epoch，而真正的 epoch 重置以
`state_resync_required`（reason 为 `epoch_reset`）到达，会经
`requestEpochResetReload()` 拆掉会话，那条路径已被
`sessionRef.current === session` 子句覆盖。

这个窗口之所以与负载相关，是因为 `resetSessionConfigSync()` 在 providers fetch
resolve 之后的 JS 续体里**同步**执行。在拥挤的 runner 上，这段续体可能被推迟到
`setReasoningEffort` 捕获 ownership token 之后、又早于已确认值被应用之前。

一次本地复现独立给出了同样的顺序：providers 于 10.91 秒落地，已确认写入在
10.93 秒开始，间隔 20 毫秒，而 CI 是 13 毫秒。原始 spec 在本地不加压的情况下
9 个 attempt 失败了 8 个。把 `providersDelayMs` 放大到 2000 会让迟到响应移出
创建窗口，两个 attempt 均通过——这说明失败需要过期响应落在窗口*之内*，而不是
单纯地晚到。

`session-config-sync.ts` 由 `d415444b78`（#15779，Workflow mode 控件）新增——
正是 issue 指认的 main 变更窗口的上界。因此该失败属于 main 分支回归，与报告人
「与 PR 无关」的观察一致。只有这个 spec 设置了
`scenario.providersDelayMs = 500`，这也解释了为什么只有它把窗口撑大到反复失败。

## 方案

把 `resetSessionConfigSync()` 调用从「建立 SSE 流」的位置移到同一次 load effect
迭代中的「会话绑定」位置，即紧挨 `pendingLoadToResolve.resolve()` 之前。SSE 建立
处继续通过 `getSessionConfigSync()` 读取该域，不再重建它。

这样域的生命周期就与附件的生命周期一致：在会话成为当前会话时建立一次，在附件
结束时由 `clearEventStream()` 拆除。首 prompt 的配置写入不再可能跨越域的重建，
因此 daemon 已确认的写入会被应用，它的 reconcile 也会被排程。

不改动 `attachSession()` 的 resolve 时机，因此首 prompt 延迟与提前绘制
transcript 的行为都不受影响。

## 设计决策

**为什么移动重置，而不是放宽守卫。** 守卫本身是对的：在被取代的域里捕获的读
不应发布。放宽 `captureConfigOwner()` 或 `mutation.isCurrent()` 等于为了救回一次
已确认写入而放过陈旧快照。移动重置消除的是那次*虚假的*域变更，所有守卫原样保留。

**为什么绑定位置是安全的落点。** 重置仍然必须每个附件恰好发生一次。从打开 load
路径的 `try {` 到迭代体结束，该缩进层级上没有任何分支能绕过绑定而到达 SSE 建立，
且绑定不在任何条件语句内。重连会重新进入循环并重新绑定，因此仍会重置。
`clearEventStream()` 保留它自己用于拆除的重置。

**为什么并发写入不会失去所有权。** SSE 块里的 `isConfigOwner()` 比较的是域对象
的身份，而不是它的 `generation`。因此在绑定与 SSE 建立之间 bump 了
`generation` 的写入，不会让流的所有权声明失效——这正是期望行为。

**为什么 load 自己的陈旧快照仍会被拒绝。** load effect 在绑定位置之后捕获
`configCurrent = beginSessionConfigRead(...)`。把重置前移并不会移动这次捕获，
所以并发的 `setModel` 或 `setReasoningEffort` 仍会让它失效，迟到的元数据依旧
无法覆盖更新的配置。

**已否决的替代方案：让 `attachSession()` 在 SSE 建立之后再 resolve。** 这同样能
关闭窗口，但会让输入框阻塞在元数据往返上，并撤销已被文档化的提前绘制优化。

**已否决的替代方案：在 `finally` 块里重新捕获所有权。** 这能通过一次新的读把
显示值治好，但已确认写入自身的应用——包括把持久化选择带进下一个 deferred 会话的
`withPersistedReasoningPreview()`——仍会丢失，而且 UI 会在那次读落地前一直显示
错误值。

### 后果：有一条既有测试钉住的正是「写入被丢弃」

`DaemonSessionProvider.test.tsx` 的「initial subscription recovery > handles
immediate 'turn_error' history=false approvalPending=true」在
`setApprovalMode('auto-edit')` **已被 daemon 确认**之后，断言
`connection.currentMode` 为 `undefined`。该断言之所以成立，只是因为同一次
写入中途的域重置把已确认的 approval mode 连同它的 reconcile 一起丢弃了。它钉住
的正是本次为 reasoning 修掉的那个缺陷，只不过对象是 approval mode。

域存活下来之后，写入会被应用、它的 reconcile 也会运行。但该测试的 context mock
在确认写入之后仍然报告写入前的 `currentModeId`，于是 reconcile 重新发布了
`default`。因此这次是**重做该测试**，而不是翻转它的断言：

- mock 改为在调用时读取一个 `confirmedMode` 变量，使确认写入之后的 context 读
  报告 `auto-edit`，与真实 daemon 一致；
- 中间断言改为 `currentMode === 'auto-edit'`，这比 `undefined` **严格更强**——
  它现在要求已确认值同时挺过陈旧快照与 reconcile；
- pending-approval 情形下期望的 context 读次数增加一次，对应不再被误杀的写入后
  reconcile；
- 后面那次把 mock 改成 `auto-edit` 的重复设置成为冗余，已删除。

该测试的另外三个参数组合不受影响：`confirmedMode` 保持 `default`，与原先的
`latest` fixture 在结构上完全等价。

## 范围

范围内：

- `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx`——迁移域
  重置的位置。
- `packages/web-shell/client/daemon/session/DaemonSessionProvider.test.tsx`——
  新增 reasoning 写入的回归测试，以及上面描述的 approval-mode 测试重做。
- `packages/web-shell/client/e2e/web-shell.settings-exclusions.spec.ts`——用
  `test.beforeAll`/`test.afterAll` 共享真实 daemon，并把六 case 循环拆成六个
  test，使每个 case 独享完整预算、失败时能点名到 case。沿用
  `web-shell.live-preview.spec.ts` 已有的 fixture 模式。各 case 的 `name` 值保持
  不变，因此设计文档 PNG 产物文件名也不变。

范围外：

- `web-shell.files.spec.ts:547`，issue 矩阵中列为 flaky。它失败一次、重试通过，
  签名不同，且不在 issue 标题内。
- 专用 runner 池提案（#15967）。它能缓解预算那一半，但修不了在空闲 runner 上
  同样会失败的状态竞态。
- 任何对 `attachSession()` resolve 时机或守卫谓词的改动。
- 「持久化 reasoning 写入确认时 `connection.providers` 完全尚未填充，导致
  `withPersistedReasoningPreview()` 无对象可更新」这一情形。所报告的流程总是
  已从更早的无会话 connect 拿到 providers；见「待解问题」。

## 约束与风险

- 域重置被所有配置动作共享（`setModel`、`setReasoningEffort`、`setWorkflowMode`、
  `getContext`、reconcile、recovery 刷新）。移动它会改变所有这些动作的在途读
  何时失效，因此既有的 config-sync 单测是首要回归门禁。
- 在绑定与 SSE 建立之间发出的读，现在会存活进入新流，而不再被作废。它们受
  `readSequence` 与 `generation` 守卫，且 load 自己的捕获仍晚于绑定，所以陈旧
  快照依旧无法发布。这是需要重点观察的行为变化，也正是重做后的 approval-mode
  测试现在所覆盖的路径。
- 唯一一条被追踪到的、方向相反的行为翻转：若某次配置写入的所有权是在重连可用性
  间隙（`clearEventStream()` 重置之后、下一次绑定之前）捕获的，而确认落在该次绑定
  之后，那么旧代码会应用它、新代码会在绑定处将其作废。它会自愈——增量重连
  （Last-Event-ID）即使没有回放任何事件也会发出 `replay_complete`，从而置
  `acceptingConfig` 并触发 `requestInitialConfigRead()` 读回 daemon 的真实状态，
  其中就包含那次已确认写入。因此暴露面是断连期间的一次瞬态显示，而不是写入丢失。
- E2E 拆分把该文件的 `@smoke` 测试数从 1 变为 6。因为每个 test 各自安装场景，
  lane 墙钟时间可能略升；daemon 本身每文件只 spawn 一次。
- 真实 daemon 测试仍然只支持 POSIX；win32 skip 已移入 `beforeAll`，因此共享
  fixture 绝不会在 Windows 上 spawn。

## 验证计划

1. 单测：在 `packages/web-shell` 里于改动前后各跑一遍 `daemon/session` 套件。
2. 新回归测试：把 attach 的元数据读持有为未完成，在该窗口内确认一次 reasoning
   写入，断言已确认值被应用、且随后发生一次 reconcile 读。该测试同时断言窗口
   本身确实存在（providers 读已发出、至少一次 context 读），因此不可能空转通过。
   已做变异校验：它在改动前的代码上会失败。
3. E2E：两个指名的 spec，均在强制 `providersDelayMs = 500` 下运行，包含
   「New session」之后的持久化 preview 断言。
4. 对改动文件跑 lint 与 format，外加包级 typecheck。
5. CI：PR 上的 `E2E Smoke` lane 是与负载相关那一半的权威判据。

新单测有意只断言到「已应用值」与「reconcile 读」为止，不断言持久化的 providers
preview：在挂载即 load 的 fixture 里，元数据被持有期间 `connection.providers`
尚未填充，`withPersistedReasoningPreview()` 无对象可更新。该路径由 E2E spec
覆盖——那里的无会话 connect 已经填充了 providers。

## 验收标准

- 在 `providersDelayMs = 500` 生效的前提下，lazy 会话创建后 smoke spec 的模型
  按钮显示 `qwen3.8-max · Medium`，且点击「New session」之后仍显示 `Medium`。
- 新回归测试在有改动时通过、无改动时失败。
- 唯一期望值发生变化的既有测试就是上面描述的 approval-mode 情形，且它变强的
  断言而非变弱。
- 每个 settings-exclusions case 都是独立 test、各自拥有预算；真实 daemon 每文件
  只 spawn 一次；win32 skip 仍然成立。
- 首 prompt 延迟不变：`attachSession()` 仍在元数据请求落定之前 resolve。

## 待解问题

- 同样的「域生命周期」推理是否也应适用于迭代中途 SSE 重启时
  `clearEventStream()` 的重置——那种情况下附件存活、只有流不存活。本次不改，
  因为本 issue 没有证据指向它。
- 在任何 providers 快照存在之前就确认的持久化 reasoning 写入，是否应当为下一个
  deferred 会话记录它的 preview。所报告的流程不会走到这里；若某个宿主曾在没有
  先行无会话 connect 的情况下直接 attach 会话，值得单独审视。
