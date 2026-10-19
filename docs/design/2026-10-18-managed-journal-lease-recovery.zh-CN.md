# 写者租约逾期后的托管日志恢复

- 状态：已实现
- Issue: #13650

## 问题

Hosted Session 通过 Session Store 为日志激活续租。控制面停机超过写者租约时，
续租提交无法获得确认。本地权威把任何追加失败都视为「日志可能写了一半」，锁定
`writeFailure`，此后每次追加都返回 `ManagedSessionWritesStoppedError`——一个
比停机本身活得更久的 503。持久日志其实完好，死掉的只是本地写者，而且再没有
任何路径去问 Store 一次。

## 决策

把停机造成的写者租约逾期视为「按设计可恢复」。判断一次追加是否落地的是持久
头部，而不是过期的授权。

日志句柄增加一个可选的结算步骤。能从头部证明答案的 Store 实现
`settleAppend()`；本地 JSONL 日志不实现，保持原有的封闭语义。

## 规则

- **未知结果不等于死亡。** 传输失败、429、5xx，以及过期写者租约返回的 `409`
  抛出 `ManagedSessionAppendUnsettledError`。权威保留本次尝试的原始记录，
  不再锁定日志。
- **下一次追加前先结算。** 下一次提交先问日志两种事实中的哪一种成立：
  - 头部仍在追加前的 revision：本次追加 `absent`；
  - 头部前进一个 revision，且其记录摘要正是本次尝试：事务 `landed`，权威
    通过正常提交后的处理应用同一批事件与 commit marker。
    头部被任何其他事务推进都属致命：本写者已失去日志，该 Session 需要 takeover。
- **先重取授权，再读头部。** 过期授权先以同一写者身份重新 acquire；若 acquire
  本身失败，则恢复过期授权，使后续结算仍可重试，而不会落成「无写者」状态。
- **读取 replay 状态前先结算。** 串行队列在下一次操作体读取 replay 状态或发布
  即将重建的 body 之前完成结算，因此重试的 domain/extension 记录返回实际已提交
  的引用且只应用一次。
- **结算的确定性失败会停止保活。** 位置被 fence、头部回退或回执畸形都会停止写者
  的租约续期；只有 `ManagedSessionAppendUnsettledError` 保持可恢复。
- **读取期间租约过期时重取一次授权。** 若租约过期后 Store 以 writer conflict
  拒绝结算读取，客户端重新 acquire 并再读一次；第二次拒绝，或租约仍有效时的
  拒绝，都属被其他写者 fence。
- **Hosted 路由把未结算追加当作存储故障。** automation、message、command、
  child、channel 路由都返回与存储故障相同的可重试 503，绝不返回 4xx 记录拒绝；
  `send_message` 与成员命令调用都把它当作故障而不是拒绝；成员的已停放等待保持
  在 `await_command` 交给恢复。
- **确定性失败仍然封闭日志。** 可回滚的提交拒绝保持可重试且不锁定；租户守卫
  预算耗尽、回执形状错误、头部回退、被其他写者 fence 仍然终止。
- **续租不堆积。** 上一次续租仍在途时，激活续租定时器跳过本次 tick，避免停机
  期间每个间隔都排入一个卡住的请求。
- **不重复应用。** 结算路径与正常追加共用同一个提交后处理函数（含扩展记录的
  apply 回调），落地事务在权威中只前进一次。

## 流程

1. 续租提交以未知结果失败；客户端保留记录摘要与追加前的 revision，权威保留
   本次事务。
2. 下一个续租 tick 结算：租约逾期则重新 acquire，然后读头部。
3. `absent` 重试续租；`landed` 应用记录的事务，紧随其后的续租成为空操作；
   头部被他人推进则封闭 Session。

## 测试

- `packages/core/src/managed-runtime/http-managed-session-store.test.ts`
  - 停机超过写者租约后重新取证，并接受用户 Turn；
  - 回复丢失但已落地的续租只应用一次；
  - 日志的追加位置被其他写者的事务占据时由结算封闭，并停止保活；
  - 已落地的 domain 记录以实际提交的引用重放，不重复发布；
  - 已落地的 extension 记录重放，而不是因缺少 body 失败；
  - 结算读取期间租约过期时重新 acquire 并重读头部；
  - 租约逾期叠加租户守卫预算耗尽时仍然封闭；
  - 永久 fence 仍然停止保活。
- `packages/cli/src/serve/hosted-harness-session.test.ts`
  - 未结算的消息追加返回 503 `session_message_failed`，而不是 409 记录拒绝。
- `packages/cli/src/serve/hosted-workspace-tool-turn.commands.test.ts`
  - 未结算的成员命令以 `HostedToolRecoveryRequiredError` 传播，并保留
    `await_command` 的已停放等待。
- `packages/core/src/managed-runtime/managed-session-assembly.test.ts`
  - 激活续租不会在慢请求后堆叠。

## 非目标

- 自动接管被其他写者推进过的日志。
- 改变本地 JSONL 日志的崩溃语义。
- 重新设计控制面的租约协议。
