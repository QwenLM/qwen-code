# 空闲期自动压缩

[English](idle-compaction.md) | [简体中文](idle-compaction.zh-CN.md)

状态：提案（issue #16508），经 triage 轮与验证轮修订。尚无实现；本文固定
设计，使实现 PR 拥有可评审的契约。行号锚点以本次修订所依据的树
（base `2258518d`）为准；易漂移处同时标注符号名。

## 为什么

当前自动压缩在 `chat.sendMessageStream` 内部经两个 `tryCompress` 入口触发：
阈值门禁——发送前有效提示估算越过 `computeThresholds(...)` 计算出的阈值
（`llm-chat.ts:3537`）；以及响应式路径——HTTP 413 / 上下文溢出响应以
`force = true` 强制回合中压缩（`llm-chat.ts:4973`）。摘要往返落在**回合中**：
用户刚发出请求，却要为一件与该请求无关的工作等
30–60 秒；且阈值触发偏晚，会话长期贴近上限运行，压缩输入在其最大时刻才被
处理。

在用户空闲时压缩，把这段延迟移到无人经历它的时刻。缓存经济学只在特定
条件下成立（见下），本设计把触发严格限制在这些条件内。

## 设计

### 新增 core 侧空闲调度器（不声称复用）

现有代码没有任何组件度量"离开时长"：`use-program-status` 的 `'idle'` 是
回合结果（"尚无回合结束"）；`AppContainer` 的 `IDLE_SPECULATION` 意为
"未在推测执行"；唯一真实的间隔测量——`microcompactHistory` 里的
`evaluateTimeBasedTrigger(lastApiCompletionTimestamp, ...)`——是在下一次
发送时**惰性求值**（`client.ts:4777` → `microcompactHistoryBeforeSend`），
而这恰恰无法实现"用户离开期间完成工作"的目的。

因此本功能新增**一个调度器**：由交互式 Chat 持有的单一计时器，在回合
落定后武装、任何新活动（提交提示、排队动作）到来即取消；计时器的触发
是对 core 的一次显式"空闲心跳"，core 自身不携带定时器。它与微压缩的
惰性触发相邻但主动：间隔只有在间隔中有东西触发时才有用。

### 触发：两个条件域，满足其一即可

压缩会重写历史，因而**使提供商前缀缓存失效**（显式断点与
`prompt_cache_key`，`openaiContentGenerator/prefix-caching.ts`）。短空闲
压缩会丢弃仍然温热的缓存（提供商 TTL 约一小时级），让用户返回后的第一
个回合付出本可不必付的冷重建。触发因此被限制在"重写免费"或"重写本已
注定"的两个条件域：

- **条件域 A —— 缓存已过期**：空闲 ≥ `context.idleCompactionMinutes`
  （默认 `60`，取自典型的提供商缓存 TTL——该 TTL 是假设值，校准见待定问题 1；缺省或 `0` 禁用功能）
  **且** 有效提示估算 ≥ 软水位（`context.idleCompactionWatermark`，默认
  `0.7`）× 生效的自动压缩阈值。缓存已死，压缩不损失任何本未损失的东西。
- **条件域 B —— 压缩本已迫近**：空闲 ≥ 小地板
  （`context.idleCompactionFloorMinutes`，默认 `3`，足以判断用户已离开）
  **且** 有效提示估算已 ≥ 自动压缩阈值本身。下一次发送无论如何都会在
  回合中压缩并使缓存失效；现在做只是把延迟移出回合，相对现状**无额外
  缓存成本**。

两项估算复用回合内门禁读取的同一套 `computeThresholds(...)` 记账，空闲
与回合内触发器对"满"的判定不会分歧。两个条件域中，若空闲压缩被打断，
回合内路径仍是不变的兜底——唯一例外是 exact-route 发送会跳过发送前门禁
（`llm-chat.ts:3890`），按回合覆盖路由时，空闲压缩是那些回合唯一可能的
压缩。

### 不经 force 通过廉价门禁

回合内门禁的廉价路径在 `effectiveTokens < auto` 时直接 NOOP
（`chatCompressionService.ts:585`），除非 screenshot-overflow 分支触发
（`:592-611`）；除此之外唯一的通道是 `force = true`——它会绕过连续失败
熔断器，并向 hook 报告 `PreCompactTrigger.Manual`。空闲压缩因此走与
screenshot 触发器相同的 sub-`auto` 分支：在同一 NOOP 路径下新增一个兄弟
条件（存在空闲心跳、未强制），从而对 hook 保持 `auto` 语义、保持熔断器
武装（摘要连续失败时与回合内自动压缩一样停下），并携带新的 `'idle'`
通知原因。明确不使用 `force = true`。

### 并发提示：中止 + 提交门

发送在 chat 的 `sendPromise` 上串行（`llm-chat.ts:2403`、`:3426`）；带外
压缩不持有该锁，不受控的历史重写与已获准的发送竞争是核心风险（现有
带外写入者 `memoryPressureMonitor` 的 `compact_history` → `chat.setHistory`
至今没有 in-flight 保护——本设计不添加第二个无保护的写入者）。后台 LLM
工作的仓库先例也明确：新回合开始时推测执行**被中止**（
`AppContainer.tsx:4149-4160`，Idle → Responding 迁移清理；中止在
`:4157`）。

空闲压缩遵循先例，并加提交门：

1. 空闲摘要进行中新提示获准 → **中止**侧查询（取消从不触发冷回退——
   现有压缩语义）。每个空闲周期一次中止机会；用户反复离开不形成重试
   循环。
2. 即便没有中止竞争，提交 `setHistory` 前重新校验**空闲纪元**（idle
   epoch）：自本次压缩开始以来若有任何回合启动，结果直接丢弃、不触碰
   历史——提交点等效于 CAS，已获准的发送永远不会观察到它未曾等待的
   半压缩/过期压缩历史。
3. 摘要从不阻塞提示准入：走侧查询路径，失败形态沿用现有语义。

### Hook 契约：无 hook 面变更

三种触发类型中只有一种是 hook 面的：`PreCompactTrigger`/`PostCompactTrigger`
（`hooks/types.ts:1160`）会到达用户 hook；`CompactTrigger`
（`chatCompressionService.ts:280`）是压缩入口的内部 `'manual' | 'auto'`
参数；`CompactionTriggerReason`（`core/turn.ts:548`）是仅用于通知的联合
类型，hook 永远看不到它。向 hook 面枚举新增 `'idle'` 会静默破坏匹配
`trigger == "auto"` 的用户 hook，因此空闲压缩对 hook 仍报告 **`auto`**——
它未经强制走 sub-`auto` 门禁分支，与回合内自动压缩同样推导出
`PreCompactTrigger.Auto`（`chatCompressionService.ts:662-663`）。idle 区分
落在 `CompactionTriggerReason` 中：它**新增 `'idle'`** 作为通知原因与内部
遥测值。不修改任何 hook 面枚举；changelog 只记录新的通知原因字符串。

### 范围排除

Headless/SDK 运行（`runNonInteractive`）与 hosted/managed 会话整体禁用
——它们的"空闲"没有可返回的操作者，其回合内的记忆排空由 #13885 单独
负责。本提案只覆盖 CLI 交互会话。

### 通知

用户下一次交互时，标准自动压缩通知以 idle 原因渲染——无新界面，但原因
子句在三个消费者处是带 token 上限回退的等值链（`use-llm-stream.ts:2981`、
`opentui/event-adapter.ts:753`、`Session.ts:1245`），今天都没有 `'idle'`
分支。每处需要新增一个分支（或把三条链合并为一个共享 helper），否则
0.7 × auto 触发的空闲压缩会宣布"接近输入 token 上限"，与事实不符。
（`Session.ts` 在该处缺 `payload_overflow` 分支是既有问题，不在本设计
范围内。）实现 PR 会相应改动这些分支。

## 非目标

- 不改微压缩、记忆提取或压缩算法。
- 不做提供商专属的缓存固定、预热调用或 TTL 查询——TTL 假设是配置
  默认值，不是测量事实。
- 本切片不含 hosted/web-shell 等价物。
- 不修复既有的 `memoryPressureMonitor` 写入竞争；在此记录不等于授权
  依赖它。

## 实现要求

- 代码 PR 之前需 `.qwen/e2e-tests/` 计划覆盖两个条件域、中止竞争与
  提交门。
- 适用两档置信度门禁（`packages/core/src/**`）。

## 验收标准

- 条件域 A 满足 → 每个空闲周期恰好压缩一次；同一周期内的第二次心跳
  为空操作。
- 条件域 B 满足 → 压缩执行；用户下一回合观察到已压缩历史，且同等满度
  不再触发回合内压缩。
- 两条件域均不满足 → 不压缩、无通知。
- 压缩进行中提示获准：压缩中止、无历史写入、回合按今天完全相同的语义
  在压缩前历史上进行。
- 配置禁用 → 行为与今天完全一致。
- 所有空闲压缩事件中 hook 观察到 `trigger == "auto"`。
- 摘要在多个空闲周期连续失败时，触发与回合内压缩相同的连续失败熔断器
  （空闲压缩绝不走绕过熔断器的强制路线）。
- Headless 与 hosted 会话永不触发。

## 待定问题

1. 条件域 A 的默认时长取自典型的 ~1 小时提供商缓存 TTL，未经测量；
   按真实会话遥测校准（或按提供商配置 TTL）留作跟进。
2. 回合间模型选择器变更已使缓存共享资格失效（路由作用域预检）；是否
   应同时抑制空闲压缩，留待实现时测量。
