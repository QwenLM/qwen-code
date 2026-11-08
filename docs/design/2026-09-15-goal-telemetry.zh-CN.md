# Goal 遥测

[English](2026-09-15-goal-telemetry.md) | [简体中文](2026-09-15-goal-telemetry.zh-CN.md)

## 问题

Goal 是自主运行的，它停下来的方式——verifier 判定完成或 blocked、token/轮数/活跃时长预算耗尽、空转上限触发 pause、用户 pause 或 clear——只记录在会话 transcript 里。遥测包里既没有 Goal 事件，也没有 Goal 指标。运维人员想知道 Goal 有多大比例以 blocked 结束、一个完成的 Goal 花了多少、某个预算是否设得太低，只能逐个翻 transcript。

Codex 在指标里统计 goal 结果，Claude Code 发出 `tengu_goal_*` 分析事件。两者都不携带目标文本。

## 设计

**一个事件，用 cause 区分。** 每次上报的状态转换都是一个 `qwen-code.goal_state` 事件，其 `cause` 就是运行时自身的 `GoalStateCause`。如果每种转换单独一个事件，每个都要一个类型、一个 logger、一个分析 sink 方法和一条文档，而字段完全相同。

**上报哪些 cause。** `create`、`replace`、`edit`、`pause`、`resume`、`clear`、`complete`、`blocked`、`usage_limited` 和 `verifier_reject`：用户的控制操作，以及用户需要处理的停止。`turn_finished` 与 `checkpoint` 每轮都会发生，会成倍放大事件量，而每轮的 token 花费已经在 API 指标里。`migrated` 是一次性的格式迁移。`verifier_accept` 之后总会紧跟它所接受的 `complete` 或 `blocked`。没有 cause 的广播是运行时内部的活动状态变化。

**接线位置。** `Config.initializeGoalRuntime` 订阅它刚创建的运行时。这是唯一同时持有运行时和每个遥测 logger 所需 `Config` 的地方；并且订阅发生在它启动 restore 之前，所以不存在状态转换已提交却没有监听者的窗口。从快照到事件的映射是遥测包里的纯函数 `goalStateEventFromSnapshot`。

**恢复出来的状态不重复上报。** `restore()` 会以所恢复记录的 cause 重新发布续跑会话的 Goal：一个 paused 的 Goal 以 `pause` 广播回来，一个因预算停下的 Goal 以 `usage_limited` 回来。订阅者无法把这次广播和最初产生它的那次实时转换区分开；而与 `getRecoveryCause()` 比较，一旦之后的实时转换带着相同 cause 就会产生歧义。因此运行时给广播加第三个参数 `meta`，只在这一次广播上传 `replayed: true`，其余广播都不传；遥测订阅者跳过重播。只接收两个参数的现有监听者不受影响。

**不带自由文本。** 事件只携带标识、枚举和数字：Goal id 与 revision、转换后的状态、限制类型、轮数与轮数预算、已用 token 与 token 预算、活跃时长与活跃时长预算，以及目标按码点计的长度。目标、停止原因和 checkpoint 失败信息一律不包含。别处用来控制 prompt 文本的开关 `telemetry.logPrompts` 默认开启，所以把目标放在它后面就等于默认上报。active 状态的 Goal 已提交的 `activeTimeMs` 落后于时钟，所以事件按广播时刻读取。

**指标保持有界。** `qwen-code.goal.transition.count` 统计每个事件，属性为 `cause`、`status` 和 `limit_kind`。在 `complete`、`blocked` 和 `usage_limited` 时，直方图 `qwen-code.goal.tokens_used` 与 `qwen-code.goal.turn_count` 记录 Goal 到此为止的花费，属性为 `cause` 和 `limit_kind`。Goal id 只留在日志记录上：每个 Goal 都是一个新值，这正是指标模块默认对 `session.id` 所拒绝的无界时间序列膨胀。 恢复后的 Goal 每次停止都会贡献一个观测值，其中花费和轮数按整个 Goal 生命周期累计。因此直方图 `_count` 统计停止次数而非不同 Goal 的数量，`_sum` 不能作为 Goal 的总花费。

**两个 sink。** 与其他所有事件一样，OpenTelemetry SDK 初始化时日志记录发往 OpenTelemetry，启用使用统计时分析 sink 收到该事件。分析 sink 的载荷不含 Goal id，因为该 sink 按安装实例聚合。

## 范围

- `goal-protocol.ts`：`GoalBroadcastMeta`。
- `goal-runtime.ts`：`subscribe` 监听器与 `broadcast` 上可选的 `meta` 参数，在 restore 广播上设置。
- `telemetry/types.ts` 与 `constants.ts`：`GoalStateEvent`、`GOAL_STATE_EVENT_CAUSES`、`makeGoalStateEvent`、`EVENT_GOAL_STATE`。
- `telemetry/goal-events.ts`：`goalStateEventFromSnapshot`。
- `telemetry/loggers.ts`、`qwen-logger/qwen-logger.ts`、`metrics.ts` 与 `index.ts`：`logGoalState`、`logGoalStateEvent`、`recordGoalStateMetrics` 以及三个指标。
- `config/config.ts`：订阅者。
- 文档：遥测参考文档与 Goal 功能页。

不改动：`client.ts` 里为 UI 提供数据的按流 Goal 状态订阅、Goal 提案审批、Goal 轮的 span。

## 验证

- `goal-events.test.ts`：每个上报的 cause 都映射为事件，每个不上报的 cause 都不产生事件；数值字段被携带，缺失的字段直接省略而不是设为 `undefined`；active Goal 的时长按广播时刻读取；目标长度按码点计数；`clear` 给出被移除的 Goal 且不带数值；序列化后的事件里不出现目标或原因文本。
- `goal-runtime.test.ts`：restore 广播带 `meta.replayed`，之后的实时转换不带 `meta`。
- `loggers.test.ts`：日志记录的 body 与属性、指标调用，以及 OpenTelemetry SDK 关闭时分析 sink 仍被调用。
- `qwen-logger.test.ts`：分析事件不含 Goal id 与缺失的数值字段。
- `metrics.test.ts`：三个指标已注册；计数器只带三个有界属性；直方图只在三种结果时记录。
- `config.test.ts`：新建的 Goal 上报一次；续跑会话恢复出来的 Goal 不上报，用户对它的下一次控制操作会上报。
- 端到端：改动前后各跑一次把遥测写入文件的 headless 运行，并验证续跑会话不会为恢复出来的 Goal 再上报一次转换。
