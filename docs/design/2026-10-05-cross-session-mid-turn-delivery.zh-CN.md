---
title: '跨会话轮内投递'
date: '2026-10-05'
status: 'implemented'
---

# 跨会话轮内投递

[English](2026-10-05-cross-session-mid-turn-delivery.md) | [简体中文](2026-10-05-cross-session-mid-turn-delivery.zh-CN.md)

## 问题

基础的跨会话消息机制只在接收会话进入 Idle 状态时才投递已接受的 peer 消息。
因此，一个长时间的 agentic 任务——连续的工具轮、始终不回到 Idle——会把所有
传入的转向指令（包括 "stop and re-check the lease" 这类）压到整个任务结束。
线路上早已带有 `priority`（"now" / "next"）字段，但接收方忽略它；协议文档
把它描述为预留给未来中断路径的字段。

放松轮内投递有特定危险：peer 不携带本会话用户的任何权限，因此一个无人值守的
机制会让另一个会话——或者被提示注入的工具输出诱导模型运行的脚本——在用户
没有注视的时候转向正在运行的轮次。

## 目标

- 允许标了 `"now"` 的发送方在工具轮边界转向接收方的运行中轮次，且仅在接收方
  的操作员已选择开启时生效。
- 以结构性方式保留用户的知情地位：投递落在工具轮之间（绝不在请求进行中）、
  绝不越过接收方自己已排队的输入、绝不打断 Goal 轮。
- 限制 peer 可强加的成本：每个时间窗内被转向的消息数量设上限，且不静默限流
  ——每个窗口用户会看到一行暂停提示。
- 不丢失任何内容：现在未投递的信封会在轮次边界投递；提交失败的批次会完整地
  回到队列。

## 非目标

- 打断进行中的模型请求（不在流中途取消）。
- 发送方控制的紧迫性：`"now"` 只是请求；由接收方的设置、队列状态与 Goal
  归属权决定是否投递。但在已经排队的 peer 之间，它确实决定先后顺序，
  如下文的屏障规则所述。
- 区分"转向已获准"与"被延后"的回执：`delivered` 仍然只表示"已排队给模型"，
  线路不得向发送方泄露接收方策略。

## 方案设计

新增两个设置，对 workspace 均只可收紧：`agents.crossSessionMidTurn`
（boolean，默认 `false`）与 `agents.crossSessionMidTurnBudget`
（integer ≥ 0，默认 `3`，经 `peerMidTurnBudgetOf` 读取：任何无法解析的值
回退到默认值，`0` 表示关闭）。

在 `use-llm-stream.ts` 的每个工具轮边界，先完成 steer 与 teammate 的 drain，
随后 peer drain 至多取一个信封（`drainPeers(1)`）。该信封经过与 idle drain
相同的收件人复核（`drainQueuedFrame`，过期 pin 会以 `misaddressed` 回执结清），
并加入工具结果的提交内容，因此 `function_response` 块仍位于用户内容之前。
四道闸门会将其排除——drain 为 null（功能关闭或无收件箱）、Goal 轮占用会话、
continuation 已分离、continuation 已取消——每种排除都让信封留在队列中，
绝不丢弃。

排序由一条屏障规则管辖——排队在等待中信封之后的用户文本绝不越过它——但两条
路径各自按自己真正能够投递的范围施加。idle 路径上每个等待中的信封都会被投递，
因此 `popNextSubmission` 在第一个 peer 条目处停止。在边界上，`drainQueue` 只
在本边界此刻真正能取走的那个信封处停止：即本边界自己的 steer 抽取完成后
留在队首的第一个 `"now"`，且窗口预算还有余额。那次抽取先执行，正是它的移除
把信封提升到队首，因此扫描会越过它取走的条目，并在它无法取走的条目处停止——
那样的条目是 pop 会撞上的墙，其后的任何条目都不归本边界投递。若按队列此刻的
样子、而非按 pop 将会看到的样子判定屏障，就会放行用户文本，使其在同一次提交
中越过信封。本边界无法投递的信封不构成屏障，否则就会为了保住一条本
边界永远不会投递的消息的位置，而把用户自己的输入扣住整整一轮。peer 文本绝不
进入原始字符串的 steer 通道：那会丢失归属，并进入用户预处理路径。

投递像 idle 路径一样写入日志——`recordNotification` 存投影文本，外加重试债，
使接受后才失败的轮次不会随着 Retry 路径弹出的孤条而丢失信封。结算经由一个
carrier 恰好执行一次；其 restore 会把两个已 drain 的批次放回队列，且 peer
批次先于 steer 批次恢复——因为两者都是头插，最后执行的一方占据队头。恢复的
条目保留 `peer: true`（而在 resume 时，`display.peer` 标记由记录中的原始
parts 重新推导——parts 存有信封，而已存 displayText 字段只有投影）。

限流逻辑在 `PeerMidTurnBudget` 中：五分钟的滚动窗口、每个实际投递的信封
`tryConsume` 一次、结算证明未送达时 `refund`、以及只读的 `hasAllowance`
预探——窗口用尽后在 pop 之前就短路返回，而不是每个边界都跑一遍
pop → stale-pin → restore 的往返。每窗口一次的暂停提示在短路路径上依然保留，
但仅当确实有信封在等待时。预算以会话 id 为作用域：`/clear` 会原地替换 id，
因此 id 变化时窗口与提示节流一并重置。

## 设计决策与理由

- **默认关闭，同意权属于接收方。** 轮内转向把投递点从有人注视的边界移到了
  无人值守的边界；是否开启应当由接收会话的操作员说了算，而不是发送方。
  文档化的同意范围覆盖任何被接受的 `"now"` 帧：其他会话、受信 controller，
  以及用子令牌启动的本会话自有进程。
- **每个边界一个信封。** 话多的 peer 可以拖慢一个轮次，但绝不能霸占它：
  无论预算多少，每个工具轮至多一条 peer 消息。
- **每五分钟窗口预算 3。** 与 hold 上限对称；peer 即使被妥善处理，消耗的也
  是本会话真实的模型算力。常量放在 `peerMessaging/mid-turn-constants.ts`
  这个零依赖叶子模块里，settings schema 因此可以使用该默认值，而无需从配置
  依赖图向 core 建立运行时边——CLI 有三个套件对该依赖图做了部分 mock，直接
  导入曾让它们在收集阶段全部失败。
- **不可解析的值 = 默认值，而不是"无限制"。** 上限存在的理由是 peer 消耗本
  会话的模型算力，因此任何解析失败都不可能是"没有上限"；`0` 是显式关闭，
  且每个界面都如此说明。
- **每窗口至多一次提示，且仅在有东西等待时。** 静默限流正是当初的症状；而
  无条件提示会让一个"已限流但空闲"的会话打印出限流了个寂寞的行文。
- **结算失败时 refund。** 被恢复的批次稍后由 idle drain 投递，为本未到达
  模型的批次扣预算，会让反复取消在什么都没送出的情况下饿死预算。
- **两条路径回执相同。** 告诉发送方它的转向被延后，既泄露接收方策略，又会
  招来紧迫性洪水。

## 约束

- `packages/cli/src/config/settingsSchema.ts` 与 `settingsUtils.ts` 不得在
  运行时导入 `peerMessaging` 模块；轮内常量一律来自该叶子模块。
- `boundaryEnvelopeTexts` 必须保持推送顺序：合并 strip 移除的是精确的尾部
  后缀，另一批次恰为尾部时按批 strip 会静默失效。
- `drainQueue` 的 rest 计算基于对象身份——屏障会把本可 drain 的条目留在队列
  里，谓词式过滤会将其丢失。
- 生成的 `packages/vscode-ide-companion/schemas/settings.schema.json` 由 CI
  重新生成并比对；修改 schema 必须连同再生成一起提交。
- 两个设置的 workspace 覆盖均为只可收紧
  （`WORKSPACE_TIGHTEN_ONLY_SETTINGS`）。

## 风险

- **话多 peer 霸占轮次**——由每边界单信封加窗口预算共同封顶；提示让该上限
  对用户可见。
- **提示注入式转向**——一旦选择开启，peer（以及自有进程、controller）帧可以
  转向运行中的轮次；它们保留信封与权限声明文本，入站审核策略在此之前照常
  把关，且 Goal 轮被排除。
- **自有进程注入在 mode-parity 默认下免审核，且现在可转向运行中的轮次**
  ——有意为之（build hook 场景），并已在设置说明、`settings.md` 与
  `commands.md` §6 中文档化。

## 验证计划

单元测试套件如下，且每处修复都额外做了变异检查（回退修复则测试必红）：
`AppContainer.test.tsx` 中的 drain hook 与调用点门控；
`use-llm-stream.test.tsx` 中的边界结算、恢复顺序与排除闸门；
`useMessageQueue.test.ts` 中的屏障与轮内 drain；
`peer-messaging.test.ts` 中的预算窗口/退款与 `peerMidTurnBudgetOf`；
`resumeHistoryUtils.test.ts` 中的 resume peer 标记。三个做部分 mock 的套件
（`workspace-service/__tests__/facade`、`acp-integration/acpAgent.worktree`、
`startInteractiveUI`）必须能正常收集用例。

## 验收标准

- `agents.crossSessionMidTurn` 关闭（默认）时，边界行为与本特性之前逐字节
  一致：信封等待 Idle。
- 开启后，一条被接受的 `"now"` 信封可以在工具轮边界到达模型：每边界至多一
  条、每五分钟至多 3 条、排在接收方已排队的用户输入之后、绝不在 Goal 轮中。
- 任何路径都不丢失或重复投递信封：恰好一次结算，restore 时退款；恢复的条目
  带 `peer` 标记重新入队，`/resume` 后其通知仍渲染 peer 标记。
- `settings.schema.json` 在再生成下保持不变；全部套件通过。

## 未决问题

- 预算是否应按发送方而非按接收会话分配？暂时保持全局：公平地按发送方记账
  需要队列目前不携带的发送方身份。
- 区分"转向已获准"的回执属于未来的事，这里刻意不做；线路格式目前也不阻碍
  将来加入。
