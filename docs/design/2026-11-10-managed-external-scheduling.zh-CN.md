# Managed Agent 调度：内置与外部调度器

[English](2026-11-10-managed-external-scheduling.md) | [简体中文](2026-11-10-managed-external-scheduling.zh-CN.md)

状态：提案，尚未实现。本设计让 Managed Agent 的调度可插拔：内置 H6
automation 调度器保持默认，外部调度器——阿里云 DataWorks 优先，其后
Airflow、DolphinScheduler 等——通过一个通用的外部触发契约驱动运行。它消费
[H6 automation 设计](2026-10-04-managed-automation.zh-CN.md)及其
[运行时](2026-10-07-managed-automation-runtime.zh-CN.md)、
[Managed MCP 运行时](2026-09-28-managed-mcp-runtime.zh-CN.md)，以及
channel 适配器的打包先例（`packages/channels/base`）；不重新设计其中任何
一个。自定步调与固定间隔 `/loop`
[设计](2026-11-10-managed-loop-schedule.zh-CN.md)走内置分支。

## 问题

Managed Agent 今天只有一个计时所有者：H6 控制面 scanner，从 definition
推导 cron slot 并触发进绑定 Session。企业已经在运行调度器——DataWorks、
Airflow、DolphinScheduler——它们的日历、依赖、重试与告警不会在 agent 平台
内重建。它们需要 agent 成为其调度器可触发的任务，同时保持 agent 的执行
保证（恰好一次运行、持久账本、恢复）完好；也需要 agent 反过来操作其调度器
（查询、触发、管理节点）。

因此架构必须在不于控制面点名任何产品的前提下回答三个问题：外部调度器的
触发如何成为带稳定身份的运行；来自任何调度器的重试与补数据如何保持恰好
一次；产品特定代码放在哪里。模块边界已经固定：`managed-agent-server` 不保留
DataWorks 或其他产品依赖，因此控制面只能暴露通用面。

## 现状

以下事实来自本仓库 `41ffb223448`。

- **内置分支对 persistent 目标已完整。** H6 拥有 definition（append-only
  修订版）、单认领 scanner（lease + fence + watermark）、run 账本、overlap
  与 catch-up 策略、gate 探针，以及在同一事务中提交 run 的 input 与 wake
  的 persistent fire。`per_run` 子会话（H4）与 channel 投递（H5）在各自
  切片落地前仍被拒绝。
- **外部触发已预留，未建造。** run 记录的 occurrence 身份是一个封闭联合：
  `schedule:<slot>`、`manual:<commandId>`、`webhook:<eventId>`——第三个已
  注册但在准入时拒绝，直到 webhook ingress 切片落地
  （`managed-automation-record.ts`，由 `webhook-reserved` fixture 钉住）。
  H6 设计把带验证事件 ID 的 webhook ingress 点名为拥有它的后续切片。今天
  的 run trigger 是 `scheduled`、`manual`、`catch_up`
  （`AUTOMATION_RUN_TRIGGERS`）。
- **推送路径今天可用。** `POST /v1/agent-automations/{id}/runs` 以
  `Idempotency-Key` 为键触发 manual run；occurrence 是
  `manual:<commandId>`，重放安全，与 scheduled fire 有相同的 overlap 准入
  与账本。外部调度器现在就能驱动它，以其实例身份作 key。
- **结果可读，不可推。** 公开 runs API 分页 definition 的 occurrence 及其
  run/execution 状态；会推送已结算结果的 H5 `channel_delivery` outbox 尚未
  落地。
- **Managed Session 运行 MCP 服务器。** Managed MCP 运行时把 stdio 与 HTTP
  服务器准入 Session 的 catalog，带 discovery pin 与预算——外部调度器 MCP
  服务器将走的出站工具面。
- **Channel 适配器是打包先例，但 bridge 不同。** `packages/channels/*`
  （dws、github、gitlab……）是控制面之外的产品适配器，建于 `channel-base`
  （已发布包）之上。它们的 bridge 指向 daemon/ACP（`AcpBridge`、
  `DaemonChannelBridge`），而非控制面；Managed 适配器需要的是控制面 API
  客户端。

## 目标

- 两个计时所有者共用一条执行路径与一个 run 账本：内置 scanner 与任何外部
  调度器。
- 一个通用、与产品无关的外部触发契约，带稳定 occurrence 身份，使
  DataWorks、Airflow、DolphinScheduler 适配器只在翻译上不同，执行语义绝不
  不同。
- 外部重试与补数据下恰好一次运行，继承 H6 的去重、lease、fence 机制。
- 双向集成：外部调度器触发运行（入站），agent 经准入工具操作外部调度器
  （出站）。
- 产品代码在 `managed-agent-server` 之外、开源 repo 之内，沿用 channel
  适配器先例。

## 非目标

- **重建外部调度器。** 日历、DAG 依赖、补数据编排、告警留在外部产品；
  Managed Agent 执行到达的东西并报告发生的东西。
- **第二条执行路径。** 外部触发经同一 funnel 创建同样的 `automation_run`
  记录；没有并行 runner。
- **控制面里的产品 API。** ingress 契约不点名任何 DataWorks、Airflow、
  DolphinScheduler 字段；适配器负责翻译。
- **H4/H5 重新设计。** `per_run` 会话与投递回调在各自切片落地时消费，不在
  此规定。
- **具体产品 API 契约。** 本设计钉住适配器必须保持的属性；实际的
  DataWorks/Airflow/DolphinScheduler 事件、鉴权、OpenAPI 形状是产品团队的
  输入。

## 决策

1. **两个计时所有者，一个账本。** 内置 H6 scanner 拥有 cron 推导的计时；
   外部调度器拥有自己的计时并推送触发。两者都经同一 funnel 在目标 Session
   的 journal 中产生 `automation_run` 记录，带同样的 run block、overlap
   准入与 settle 路径。执行、恢复、可观测性绝不按计时所有者分叉。
2. **内置分支不变。** H6 definition、scanner、gate 探针与 `/loop` 设计原样
   运行。本设计不新增 cron 能力，不改任何内置策略。
3. **外部触发是一等 occurrence。** webhook ingress 切片激活预留的
   `webhook:<eventId>` 身份。`eventId` 是外部调度器经验证的稳定实例身份——
   每个点名调度器都有的属性（DataWorks 调度实例、Airflow DAG run / task
   instance、DolphinScheduler 进程 / task instance）；适配器把其产品身份
   映射进 `eventId`，控制面从不解析它。run 记录其 trigger kind，使账本区分
   外部 fire 与 manual 或 scheduled。
4. **零改动路径是 manual run，如实标注。** ingress 切片落地前，适配器以
   外部实例身份作 `Idempotency-Key` 驱动
   `POST /v1/agent-automations/{id}/runs`。今天这就恰好一次且持久，但账本
   记为 `manual`——适配器与运维绝不能把它读成「人跑的」。ingress 切片把
   同一流程升级为 `webhook` trigger，不改适配器的身份纪律。
5. **ingress 契约通用且经鉴权。** 一次推送携带：稳定事件身份（`eventId`）、
   目标（run 所属的 definition 或 Session）、输入 payload（run 执行的
   prompt/context）、以及 ingress 在准入前验证的鉴权证明。验证是 ingress
   的职责——签名或 token 方案是切片决策——未验证事件绝不进 funnel。契约
   与传输无关（先 HTTP 推送；轮询适配器可走同一准入路径）。
6. **适配器在控制面之外、开源 repo 之内。** `packages/channels/dataworks`
   是第一个适配器；Airflow 与 DolphinScheduler 沿用同一形状。适配器把产品
   事件翻译成通用 ingress、把产品凭据翻译成控制面凭据；它在边缘拥有产品的
   重试/补数据语义。其运行时是控制面 API 客户端，而非 daemon channel
   总线——channel 打包是先例，bridge 不同。`channel-base` 原语可复用，但
   其已发布导出形状不得为本工作改变。
7. **出站编排是准入的 MCP 工具面。** 操作外部调度器（查询节点、触发运行、
   管理调度）走经 Managed MCP 运行时准入的按产品 MCP 服务器——DataWorks
   OpenAPI 优先。有副作用的操作像任何其他工具一样遵守 Session 的权限规则；
   agent 是同一审批模型下的编排者，不是特权旁路。具体操作集是产品团队的
   输入，以其 OpenAPI 暴露者为界。
8. **恰好一次是继承的，不是重新实现的。** 重复事件身份的外部重试或补数据
   遇到已提交 occurrence 并重放它——与重复 manual key 获得的结构去重相同。
   错过外部事件的 catch-up 属于外部调度器：ingress 执行到达的东西、去重，
   绝不合成错过的外部 slot。overlap 准入像对任何 fire 一样适用；繁忙目标
   按 definition 策略排队或跳过。
9. **结果消费保持开放。** 轮询 runs API 今天可用，是基线。推送回调（agent
   的已结算结果驱动下游节点）在 H5 落地时走它；本设计不把回调形状烧进
   ingress 契约，使该决定可按产品做出而无需契约变更。
10. **会话模型与租户由适配器映射。** 触发今天指向 persistent 绑定 Session；
    每外部实例的 `per_run` 隔离随 H4 到来，是期望独立任务运行的调度器的
    自然模型。适配器在平台授权下把产品 tenant/project/workspace 身份映射到
    控制面 tenant/Workspace/Session；任何产品机密不进 journal（凭据走现有
    凭据处理，payload 携带引用）。
11. **外部驱动的 definition 对 scanner 不可见。** 为外部触发创建的
    definition 绝不能同时被内置 scanner 触发——否则两个计时所有者会对同一
    definition 双重触发。这样的 definition 携带 scanner 跳过的外部 trigger
    source（具体标记是 ingress 切片的契约决策）；内置 cron 路径与外部路径
    绝不同时武装同一个 definition。

## 流水线，逐步

| 步骤 | 位置                   | 提交                                                                             |
| ---- | ---------------------- | -------------------------------------------------------------------------------- |
| 1    | 外部调度器             | 其自有日历/依赖触发一个实例（Managed Agent 之外）                                |
| 2    | 适配器（边缘）         | 把产品事件翻译成通用 ingress：eventId、目标、payload、鉴权证明；产品重试留在边缘 |
| 3    | ingress（控制面）      | 验证鉴权证明；准入事件；按 eventId 对已提交 occurrence 去重                      |
| 4    | Harness funnel         | `automation_run` claim + dispatch + input + wake 同事务（现有 persistent fire）  |
| 5    | wake pump              | run 的 turn 执行；`turn.settled` settle 该 run                                   |
| 6    | 结果消费               | 今天轮询 runs API；之后按产品决定走 H5 回调                                      |
| 7    | 出站（agent → 调度器） | agent 在 Session 权限规则下调用产品 MCP 服务器的准入工具                         |

## 契约触点

- `packages/core/src/managed-runtime/managed-automation-record.ts`：
  `webhook` occurrence 拒绝在 ingress 切片解除；trigger 词汇新增外部种类，
  由两个宿主的 fixture 重放。
- ingress 面（新增）：准入、验证、通用事件形状，配 `SurfaceRegistry` 条目、
  OpenAPI 契约、`ManagedAgentApiContractTest`、`SurfaceRegistryGateTest`。
- `ManagedAutomationService` / Harness funnel：无执行变更；ingress 经现有
  fire 路径准入。
- `packages/channels/dataworks`（新增）：第一个入站适配器与 DataWorks
  OpenAPI MCP 服务器（出站）；Airflow/DolphinScheduler 适配器沿用此形状。
- Managed MCP 运行时：不变；产品 MCP 服务器经它准入。
- `channel-base`：复用，不重塑（已发布包）。

## 验证计划

- fixture 对等：激活的 `webhook` occurrence 与新 trigger kind 在两个宿主
  一致重放；`webhook-reserved` fixture 在准入它的同一改动中翻转。
- 身份去重：重复事件身份重放已提交 run，绝不创建第二个；两个适配器重复同一
  实例收敛到一个 run。
- 验证：未验证或错误签名的事件在 funnel 前被拒绝；已验证事件准入。
- manual 路径诚实：零改动路径记 `manual` 且在实例 key 下恰好一次；ingress
  路径记外部 trigger kind。
- overlap 与繁忙目标：外部 fire 像 scheduled fire 一样遇到 definition 的
  overlap 策略。
- scanner 不可见：外部驱动的 definition 绝不被内置 scanner 触发；内置
  definition 绝不被 ingress 触发。
- 出站准入：产品 MCP 服务器的有副作用工具遵守 Session 权限规则；被拒绝的
  操作不执行。
- 适配器隔离：产品凭据绝不出现在 journal；控制面不解析任何产品字段。
- 变异检查：逐个禁用各守卫都会使某个测试失败（去重、验证、trigger-kind
  记录、权限准入）。

## 验收标准

- 一个外部调度器实例触发恰好一个 run，同一实例的重试重放它而非创建第二个。
- 账本区分外部触发与 manual 或 scheduled run。
- 外部驱动的 definition 绝不被内置 scanner 双重触发。
- 控制面不含任何产品特定字段或依赖；第二个调度器适配器复用同一 ingress 而
  无需控制面变更。
- agent 在 Session 权限规则下经准入 MCP 工具操作外部调度器。
- 结果可经 runs API 读取；若选择回调，走 H5 而无需 ingress 契约变更。

## 开放问题

1. **结果消费。** 轮询是基线；DataWorks（及后续产品）是否需要推送回调驱动
   下游节点决定 H5 的优先级。产品团队未定。
2. **每实例会话模型。** 外部实例想要 `per_run` 隔离（H4）还是 persistent
   绑定 Session 是产品决定；ingress 指向两者皆无需契约变更。
3. **ingress 鉴权方案。** 签名 vs token、产品凭据如何映射到控制面凭据，在
   ingress 切片中与平台鉴权模型一起敲定。
4. **出站操作范围。** 具体 DataWorks OpenAPI 操作集（及后续
   Airflow/DolphinScheduler）是产品团队的输入，以其 API 暴露者与权限模型
   准入者为界。

## 需要产品团队提供的输入

- 每个调度器暴露的稳定实例身份（DataWorks 调度实例；Airflow DAG run /
  task instance；DolphinScheduler 进程 / task instance）及其重试/补数据
  语义。
- 推送的事件/鉴权契约（或轮询 API）与凭据模型。
- 出站编排的 OpenAPI 面及其权限预期。
