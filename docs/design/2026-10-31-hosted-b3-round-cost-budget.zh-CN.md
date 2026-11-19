# Hosted B3 —— 跨替换的轮次与成本预算

[English](2026-10-31-hosted-b3-round-cost-budget.md) | [简体中文](2026-10-31-hosted-b3-round-cost-budget.zh-CN.md)

状态：提议中，2026-10-31。属于 [#14481][issue]（G3 Step 3 恢复矩阵验收，跟踪
#12380）。扩展 [G3 Step 3 恢复](2026-10-09-hosted-g3-step3-recovery.zh-CN.md) 所述
`hosted-failover-e2e` CI job 的打包故障支路。本切片打包矩阵行 **B3（「after earlier
tools」）**：在若干工具轮之后崩溃，恢复必须不重置逻辑轮次与回合成本账本。

## 问题

矩阵行 B3 写道：_「请求使用已保存的结果/历史；每次先前执行恰好发生一次；轮次与成本
预算不重置。」_ 目前 B3 仅有 focused/integration 证据。现有 `after-result` 支路在
**单个**工具轮之后崩溃、证明已保存请求被 deep-equal 重发，但没有任何支路在**若干**
工具轮之后崩溃并证明数值轮次计数器与回合成本账本跨替换存活。一个把轮次重启为 0
（让 Turn 跑过其配置轮次上限）或把 token 账本归零的恢复，本来都能通过 CI。

**这里「成本预算」的真实含义（已实证）。** 本仓没有独立的累计成本计数器。可恢复的
成本状态是 `TurnBudget` 快照（从用户 `+Nk` 指令解析出的输出 token 预算，加
`outputTokensAtTurnStart`）与每模型会话 token 指标（uiTelemetry），二者持久化在
`model.attempt` 的 route/usage 资源上并在冷加载时恢复。`toolOutputBatchBudget` 是
每代重新计算的无状态配置（重算无害），checkpoint 的 `budgetConsumed` 字段是恒 0
占位符；二者都不是 B3 的断言对象。因此「成本预算不重置」被证明为**快照 + 账本的恢复
保真**，而非主模型循环里的硬性花费闸门（主循环不按 token 花费停轮；只有
workflow/agent 派发消费该预算）。

## 现状（在 `main` 的 `b3e9ce0cd1` 上实证）

- **逻辑轮次。** 模型循环从
  `round = input.resumeModel?.round ?? input.initialRound ?? 0`
  （`hosted-harness-model.ts:979`）起跳，并强制
  `maxRounds > 0 && round >= maxRounds → HostedModelRoundLimitError`
  （`hosted-harness-model.ts:991`）。`maxRounds = config.getMaxSessionTurns()` 默认
  **-1（无限制）**。由于轮次索引是绝对的，轮次上限本身无法干净地检测重置，因此本臂
  通过恰好一次、deep-equal 与轮次连续性断言来检测轮次重置，而非依赖上限。轮次经两条通道持久化：`hosted-model-request` 资源带 `round`
  （`hosted-model-recovery.ts:33`），`hosted-approval-continuation` plan 带 `round`
  （`hosted-approval-continuation.ts:88`，在 `hosted-workspace-tool-turn.ts:3738`
  由 `logicalRound` 赋值）。恢复时循环从 `resumeModel.round`（saved-request 路径）或
  `initialRound = plan.round + 1`（`hosted-harness-session.ts:3981`）续跑。
- **成本账本。** `bindBudget`（`managed-hook-activation.ts:83-135`）冷加载时逆序扫
  `model.attempt` 事件，从 `usageRef`/`routeRef` 资源读回 `budget` 与 `models`，恢复
  `TurnBudget` 快照并调用 `restoreSessionModelMetrics`。仅当
  `shared.snapshot?.promptId !== this.turnId` 才起新快照，因此同轮恢复不会重启账本。
  每次 attempt 写 route 资源（`budget`）与 usage 资源（`budget` + `models`）
  （`managed-hook-activation.ts:176-183, 230-241`）。
- **恰好一次 / 已存结果。** saved-request 重放由 `requestDigest` 钉死，且若快照
  `throughSequence` 之后出现 assistant commit 或 `tool.intent` 即拒绝
  （`hosted-model-recovery.ts:213-222`）；tool-turn fold 以 functionResponse id 为键
  （`hosted-workspace-tool-turn.ts:1666`），`resumeSavedNativeBatch` 重验原始定义/参数
  摘要并复用原 `runtimeCallId`/`prepareKey`。
- **runner 可观测性。** 轮次不在 provider 请求体、也不在公共 feed；它在
  `hosted-model-request` / `hosted-approval-continuation` MySQL 资源里。budget/models
  在 `managed-hosted-model-route` / `managed-hosted-model-usage` 资源里。runner 已有
  这两种读法（journal HEX 解析与 `ma_resource` inline 读）。目前 runner **没有**对
  数值轮次或 budget 内容的断言。

## 目标与范围

**范围内。** 一个打包的 `hosted-failover-e2e` 支路：跑一个**多轮**工具夹具（两个先前
工具轮），在较后的 post-tool 模型请求被扣住时崩溃替换进程，并在 scrash 崩溃代磁盘后
仅凭 MySQL 证明：

1. 恢复出的模型请求以与已保存请求**相同的逻辑轮次**续跑（不重启为 0/1）；
2. 回合**成本快照与每模型 token 账本**被恢复，而非归零或重新起算；
3. 每个先前工具执行以原执行身份**恰好发生一次**，且重发请求与已保存请求 deep-equal；
4. Turn 恰好投影一个 terminal 并带恢复出的答案。

**范围外。** 主模型循环里的硬性 token 花费闸门（不存在）；`toolOutputBatchBudget`
（无状态配置）；checkpoint `budgetConsumed` 占位符；不带 `initialRound` 的 skill-only
/ 手动 continue 恢复路径（其在打包 native-tool 臂中的可达性未验证，留作后续）；
real-provider 验收；两侧 owner 重启。

**无生产行为改动。** 崩溃由 fake 模型侧扣住（既有 `holdUntil` 机制），因此本支路
**无需新 serve 钩子**——不同于 A3/B3a。唯一的生产源码改动（若有）是测试 gated 且惰性。

## 方案

### 窗口选择（W2）

崩在**较后一轮的 after-result 窗口**：第 N（N≥2）轮 post-tool 模型请求已发布（快照 +
`model.attempt: started` 已 durable），被 fake 模型在完成前扣住。这是风险最低的窗口
——复用 `after-result` 的 hold/barrier 机器，hold 点在 fake 服务器侧（无需新 serve
钩子），且已保存请求携带轮次、崩溃边界的 `managed-hosted-model-route` /
`managed-hosted-model-usage` 资源携带预算，恢复必须把两者都恢复，runner 也从各自
的资源分别读取。（备选 W1——工具结果 commit
与下一快照之间——可能停不住、且可能落到重置轮次的路径，干跑确认前延后。W3 与 B3a
边界重合、仅增的多轮/budget 维度并入 W2 断言。）

### 多轮夹具

fake 模型按 `"role":"tool"` 消息计数决定：前两个请求各回一个 `write_file` 工具调用
（两个不同路径/效果），第三个回被扣住的最终答案。提示词带 `+Nk` 指令使 `TurnBudget`
快照非空、其恢复可数值断言。每个响应还计入非零 usage（completion tokens
300/300/100）：fake 服务器默认 usage 全 0，会让 token 账本在数值上为空；且先前轮次
重于最终轮，使归零恢复的总量**低于**崩溃边界账本，而非把同一总和重算一遍。

### 恢复断言（在 after-result 模板之上新增）

- **轮次连续**：崩溃前读已保存 `hosted-model-request.round`，恢复后读恢复请求的轮次，
  要求相等（且 ≥2，使重置为 0 变红）。重跑先前轮次的重置还会被恰好一次执行计数与
  deep-equal 请求 parity 捕获。
- **成本账本连续**：崩溃前后读 route/usage 资源的 `budget` 与 `models`，要求崩溃边界
  快照非空（null 会让丢弃恢复以 null == null 空过）且恢复后 deep-equal，且崩溃边界
  每个模型的输出 token 总量存活（after ≥ before）。崩溃边界账本必须非空，使从未计入
  账本的夹具变红而非空过。
- **恰好一次 + deep-equal**：两个先前执行各 `SETTLED`/`dispatch_generation=1`、带原
  Runtime 身份（binding/generation/runtimeSessionId）；首个审批 plan 只含工具 A，故
  两个物理文件效果提供逐工具证据；重发 post-tool 请求与已保存请求 deep-equal；一个
  terminal；恢复出的答案。

### runner、CI 与契约钉

新增一个 `approvalFaults` 条目（allow-only 叠加）、穷举崩溃臂守卫里的 barrier 分支、
一个 npm script 与一个 `sdk-java.yml` step，并抬 `hosted-failover-e2e` 的臂数上限与
timeout。契约钉钉住多轮夹具、轮次/budget 读法及其断言；任何新 runner 顶层 helper 配
注入输入的行为化测试。

### 文档

双语更新 [G3 Step 3 恢复](2026-10-09-hosted-g3-step3-recovery.zh-CN.md) §9.1：十三→
十四条打包支路，把 B3 从 focused 移到 packaged，并记录「成本预算 = TurnBudget 快照 +
token 账本」的澄清。

## 设计决定与理由

- **W2 优于 W1/W3** —— W2 复用已验证的 after-result hold、无需新 serve 钩子；W1 的
  恢复路由未验证、可能停不住；W3 与 B3a 边界重复。
- **成本 = 快照 + 账本，非花费闸门** —— 符合真实机制；支路断言恢复保真，这正是此处
  「不重置」的含义。
- **显式 `+Nk` 指令** —— 默认 null 预算使账本重置不可观测；夹具显式开启使快照恢复可
  数值断言。不设 `maxSessionTurns`：绝对轮次索引意味着上限无法干净检测重置，故重置
  检测依赖恰好一次、deep-equal 与轮次连续性断言。
- **多轮 gated 在故障名上** —— 共享 fake 模型与断言被每个审批支路使用；gating 使单轮
  支路不变。

## 约束与风险

- **共享夹具回归。** fake 模型与执行身份断言共享；多轮路径必须完全 gated，单轮支路
  重跑绿。本臂与 `after-result` 共享的每个 gate——hold 的 arm **与释放**、已发布前缀
  的采集、前缀撤回证明——都必须枚举两个故障名：只 gate 在 `after-result` 的释放会让
  恢复代的重发请求被永远扣住（第一次 .75 head 运行即抓住）。
- **轮次/budget 读法须镜像恢复。** 轮次/budget 断言读取与恢复相同的 durable 资源；
  注入行的行为化测试证明读法，变异必须使其变红。资源以 `HEX(inline_bytes)` 读取并在
  runner 内解码：`mysql --batch` 会转义反斜杠，损坏已保存请求 JSON 的 `\"` 序列
  （请求携带完整 system prompt）。
- **账本形态（已确认）。** 未恢复的账本是 `{}` 而非 null——`getMetricsForSession`
  回退到 `createInitialMetrics()`——而 `{}` 为 truthy，仅查 null 会让归零恢复通过。
  因此断言比较逐模型输出 token 总量（after ≥ before，账本随被扣住轮次完成而增长），
  并要求崩溃边界账本非空。
- **CI 预算。** 多一条臂抬 `hosted-failover-e2e` 上限与 timeout。

## 验证计划

- **.75 真机**：head 臂绿——轮次连续、成本账本连续、两个先前执行各一次、deep-equal
  重发、一个 terminal、scrash 后仅凭 MySQL 恢复。
- **实测变异红**：把恢复轮次重置为 0→轮次连续红；把恢复的 models 账本归零→账本红；
  丢弃 `+Nk` 快照恢复→budget 红（三者均在 .75 真机于命名断言处被杀）。执行计数断言
  在 W2 是纵深防御：三个变异格（空 fold 谓词；破坏 replay 路由；两者同时）全部
  **存活**，因为此处恰好一次依赖三道独立守卫——saved-request replay 路由、
  continuation 路由的 settled-batch 采纳、Runtime 的 runtimeCallId 幂等（Java 侧，
  CLI 变异不可达）。使计数变红需要跨语言复合变异；已记录为后续。计数/身份断言与
  已打包且 CI 证明的 sibling-approval、after-result 支路共享。
- 契约套件 + 行为化测试绿；`npm run build && npm run typecheck && npm run bundle`。

## 验收标准

- `hosted-failover-e2e` 中一个打包支路，其 runner 在 scrash 崩溃代后仅凭 MySQL 断言
  轮次连续、成本账本连续、先前执行恰好一次与一个 terminal。
- 每个新增轮次/budget/账本信号都有一次实测命名变异红；共享的恰好一次计数/身份断言
  在 W2 为纵深防御，以存活变异证据记录各独立守卫层。
- 双语设计文档对齐；CI 绿；无生产行为改动。

## 开放问题

- 已解决：故障名为 `after-earlier-tools`，指令为 `+500k`（.75 崩溃边界证据钉住快照
  `budget: 500000`、`outputTokensAtTurnStart: 0`）。
- skill-only / 手动 continue 的轮次重置路径在打包臂中是否可达（延后；若确认将是独立
  缺口）。

[issue]: https://github.com/QwenLM/qwen-code/issues/14481
