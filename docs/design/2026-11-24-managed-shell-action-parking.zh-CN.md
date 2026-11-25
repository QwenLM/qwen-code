# Managed 审批停靠 S8a：派发前的 Shell 审批（G3 扩展）

[English](2026-11-24-managed-shell-action-parking.md) | [简体中文](2026-11-24-managed-shell-action-parking.zh-CN.md)

状态：已实现。日期：2026-11-24。对照 `main` 的 `f38f6fe7c3` 核实，下文的代码引用均对应该提交。[覆盖面设计](2026-11-22-managed-action-parking-coverage.zh-CN.md) §4.8 要求在实现 S8a 其余部分之前，单独写一份 G3 扩展设计，本文就是这份设计。本文同时完成覆盖面设计决策 8 仍欠着的、对 public-children Shell 路径的 G3 审查。由 #18149（阶段 5）跟踪。标为"待验证"的结论来自代码阅读，未经测试证实，必须在实现前用测试确认。开工前检查 1 和 2（§7.1）已由随本设计提交的测试确认。实现补上了 §7.2 的用例，并纠正了设计原先假定的两种形态：后台 Shell 只存在于发布通道上，带 MCP 的公开 Shell Session 永远不会停靠。

## 1. 问题与现状

[G3 第 3 步](2026-10-09-hosted-g3-step3-recovery.zh-CN.md) §4.3 要求"派发前的私有 Shell"自带"正向的续接证据和所有权证据"，派发后的 Shell 则继续拒绝。现在 Shell profile 上的审批等待只有在带 public children 的 Session 上才能停靠：

- **捕获。** 除非 Session 带 public children，`captureNativeBatch` 对 Shell profile 上的每个批次都以 `shell_profile` 拒绝（`hosted-workspace-tool-turn.ts:4626-4634`）。这个拒绝按 profile 判断，而不是按工具，所以这类 Session 上的 `write_file` 审批同样保持常驻。工具白名单只在有 public children 时才放行 `run_shell_command` 和 `agent`（`:4654-4656`）。也只有 public children 才会记录 Shell 调用的 `publicationId`（`:4737`）和计划里的 `publicChildModel` pin（`:4745-4747`）。
- **读取。** 读取端只在计划带有 `publicChildModel` 时才把它当作 Shell 计划（`hosted-approval-continuation.ts:299`）。只有这时它才接受 `publicationId`（`:342-349`）或 `run_shell_command` 调用（`:357`）。
- **恢复。** `resumeSavedNativeBatch` 对 Shell 没有 public-children 条件。它按计划重建每个请求；在发布通道上，Shell 调用缺少身份时拒绝（`hosted-workspace-tool-turn.ts:4511-4516`）。随后 `executeNative` 在发布通道上通过 `prepareV3` 预留调用，否则通过 `prepare`（`:6206-6227`）。
- **Broker。** 两条 prepare 路径都走到 `dispatch = false` 的 `createExecution`（`RuntimeBrokerService.java:995`、`:1613-1667`）。预留从不派发。相同 key 加相同 reference 返回原记录；同一 key 下 reference 不同，则以 `runtime_idempotency_conflict` 拒绝。#18231 为 Tool v3 用测试固定了这一点，开工前检查 1 为 Shell 通道固定了这一点（§7.1）。

不带 public children 的 Session，也就是 S8a 剩下的范围：

| Session            | Profile                                                                            | 为什么没有 public children                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公开 Shell，版本 0 | `hosted-workspace-shell/1`、`hosted-workspace-shell/3`、`hosted-workspace-shell/4` | 版本 1 只在创建时设置，而且要同时满足：child agents 已启用，部署和 Harness 支持 public children，并且 Session 使用内置的 `qwen-code` agent 或部署启用了 managed extension 执行（`AgentSessionAdmissions.java:247-252`）。其他公开 Shell Session，包括 #15171 之前创建的，都停在版本 0 |
| 内部 team lead     | `hosted-workspace-team-lead/1`、`hosted-workspace-team-lead/2`                     | public children 需要公开 Shell profile。这个 profile 是内部的，公开定义永远不能选它（`AgentDefinitionCompiler.java:99-101`）                                                                                                                                                          |

每个 Shell Session 运行在两条 Shell 通道之一上，在 Session 创建时确定：

- **发布通道（Tool v3）。** 当 `qwen.managed-agent.tool-publication.enabled` 打开时，控制面为公开 Shell 和 team-lead profile 下发 `captureBytes`（`QwenHostedHarnessConnector.java:1990-1994`）。Harness 随之拿到一个 publication owner 和一条后台通道（`hosted-harness-session.ts:7512-7531`）。
- **Shell 通道。** 没有 `captureBytes` 时，Harness 拿到较早的 `shell` 通道（`:7533-7541`）。Shell 调用通过 `prepare` 预留，带 `runtimeProtocol: 3` 和规范化的 `inputDigest`（`hosted-workspace-broker.ts:569-611`）。工具发布默认关闭（`application.yml:74`），所以这条通道可能很常见。

Session 定义同时 pin 住 profile 和通道。load 时 `toolProfile` 或 `captureBytes` 与定义不一致，会以 `hosted_tool_profile_conflict` 拒绝（`hosted-harness-session.ts:7557-7568`）。

public child 准入不要求工具发布，所以 public-children Session 也可以运行在 Shell 通道上。#18231 的 Shell 停靠用例只跑在发布通道上；开工前检查 2 让它们也在 Shell 通道上跑（§7.1）。

## 2. 目标与范围

目标：

- 版本 0 的公开 Shell Session 在两条通道上都能停靠审批等待，包括派发前的 Shell 调用，并通过现有的 G3 审批续接驱动恢复。
- 完成决策 8 对 public-children Shell 的 G3 审查，包括 #18231 没有覆盖的 Shell 通道（开工前检查 2，§7.1）。
- 只改 Harness 的生产者、读取端和一个拒绝原因。seal、证书、Store 和 Broker 都不变。

非目标：

- team-lead profile。它们继续拒绝，只是换成新的原因（§4.5）。
- 派发后的 Shell。已启动的 Shell 不是等待，它的崩溃恢复不变。
- 批次里其他 Shell 通道工具：`monitor`、workflow、team、messaging、loop 和 cron 工具，以及私有的 `agent`。它们继续以 `unsupported_tool` 拒绝。
- 外部 Shell 放置（`hosted-workspace-external-shell/1`）。这段代码不把它当作 Shell profile（`hosted-workspace-profiles.ts:86-96`），它的 Shell 调用以 `unsupported_tool` 拒绝。
- 带 MCP 的公开 Shell Session。Phase 1 从不挂起它们（[无状态 Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)，空闲判定）。`hosted-harness-session.ts:5340-5342` 的条件豁免了生命周期 v2，但 Session 只有在 close 或 delete 持有生命周期授权期间才运行在生命周期 v2 上。那时它已经算作活跃工作，也不再接收 Turn。

## 3. 总体方案

S8a 把"这份计划可以包含 Shell 调用"的判断，从 public-children pin 移到计划已经 pin 住的 Session 定义上。

1. **捕获。** profile 条件只拒绝 team-lead profile。白名单在所有公开 Shell profile 上放行 `run_shell_command`。公开 Shell profile 上的每个 Shell 调用都记录 `publicationId`，与 public children 现在的做法一样：发布通道上是字符串，Shell 通道上是 `null`。
2. **读取。** 计划中有 `run_shell_command` 调用或 `publicationId` 时，读取端读取 pin 住的定义，并要求那里是公开 Shell profile。每个 Shell 调用都必须带 `publicationId`，并且只有在定义 pin 了 `captureBytes` 时才是字符串。public-children pin 的检查保持不变，仍然决定是否放行 `agent`。
3. **恢复与执行。** 不变。
4. **owner、停靠资格和恢复入口。** 不变。共享的形态函数里没有 Shell 条件。

## 4. 设计

### 4.1 用 pin 住的定义来识别

计划的 `definitionRef` 必须等于 Session 头部的那一个（`hosted-approval-continuation.ts:193`）。这份定义 pin 住了 `toolProfile`、`publicChildAgentsVersion` 和 `captureBytes`，load 也不能让 Session 换成别的 profile 或通道运行（§1）。所以定义本身已经记录了计划是在哪个 profile 和通道下捕获的，S8a 不新增计划字段。代价是恢复带 Shell 调用的计划时多读一次资源。

### 4.2 捕获

三处改动，都在 `captureNativeBatch` 里：

1. `shell_profile` 条件（`hosted-workspace-tool-turn.ts:4626-4634`）改成 team-lead 条件，返回 `team_lead_profile`。现有的豁免（command step、单个 plan exit、单个提问、memory 批次）保留。
2. 白名单（`:4654-4656`）在所有公开 Shell profile 上放行 `run_shell_command`。`agent` 仍然只限 public children。
3. 只要 profile 是公开 Shell profile，Shell 调用就记录 `publicationId`（`:4737`），不再只限 public children。取值就是 `prepareRequests` 分配的那个：发布通道上是 UUID，Shell 通道上是 `null`（`:5720-5724`）。

计划仍然在持久等待之前发布。Shell 只在最终计划链接之后才预留（`:6051-6066` 在 `:6166` 的预留之前），所以审批等待期间不存在任何预留。

### 4.3 读取

在 `readHostedApprovalContinuation` 中：

- 只要有调用是 `run_shell_command` 或带 `publicationId`，就读取 pin 住的定义。除非 `isHostedWorkspacePublicShellProfile(definition.toolProfile)` 成立，否则拒绝这份计划。
- `publicationId` 只允许出现在 `run_shell_command` 上，并且每个 `run_shell_command` 调用都必须带。定义设置了 `captureBytes` 时它必须是 UUID 字符串，没有设置时必须是 `null`。
- 带 `publicChildModel` 的计划保留它自己的检查（`:300-318`），包括类型化的 `HostedPublicChildRecoveryProfileChanged` decline。`agent` 仍然只在带这个 pin 时放行。

不满足这些检查的计划属于持久冲突，按失败关闭处理，和今天任何格式不对的计划一样。public-children 的计划已经满足这些规则，因为它的写入端已经在每个 Shell 调用上记录 `publicationId`。

### 4.4 恢复、执行与清理（不变）

- **Pin。** 恢复的批次按计划的 binding 和 generation 重新获取，并拒绝不同的 Workspace generation（`hosted-workspace-tool-turn.ts:4478-4483`）。它还会拒绝与重新加载的声明不一致的工具定义（`:4494-4507`）、不同的参数（`:4508-4510`），以及缺失的 publication 身份（`:4511-4516`）。
- **预留。** 每个调用沿用 key `${runtimeSessionId}:${runtimeCallId}` 和保存的 reference。发布通道用保存的 `publicationId` 调用 `prepareV3`。Shell 通道调用 `prepare`，其 `inputDigest` 由保存的输入重新计算，与在线路径算出的摘要相同（`:5696-5701`）。因此在 prepare 和 start 之间崩溃，重放的是原来的预留，不会产生第二个。
- **清理。** 在没有 Hooks 和 MCP 的 Session 上，在线的 Shell Turn 在 `finish()` 中直接释放 Runtime（`:10990`），这就是 G3 所说的"Shell profile 保留其现有的执行/清理 owner"。恢复的驱动则记下 G3 的 Turn 清理债务（`:4440-4444`），在终态之后通过 `reconcileHostedTurnCleanup` 释放。如果后台 Shell 仍占着 Runtime session 且 journal 能证明这一点，这个函数会把债务保持为 `held`，而不是失败（`hosted-turn-cleanup.ts:465-475`、`:267-310`）。public-children Shell 已经在走这条路径。它是两者中更严格的一种，因为债务能在再次崩溃后保留下来，所以 S8a 保持不变。有 Hooks 或 MCP 时，两条路径都不记债务，因为 Runtime 由 Hook 或 MCP owner 持有（覆盖面设计 §4.5）。

### 4.5 拒绝原因

`HostedContinuationCaptureRefusal` 中的 `shell_profile` 换成 `team_lead_profile`（`hosted-action-parking.ts:20`）。P0 像统计其他原因一样统计它。升级之后，`parkRefusals.shell_profile` 消失。版本 0 公开 Shell 的等待要么能停靠，要么显示仍然适用于它的原因；team-lead 的等待显示 `team_lead_profile`。

### 4.6 owner 与 wake 的组合

owner 和 wake 条件是共享的，且不依赖 profile，所以下面这些形态不需要新代码。当 Harness 在生命周期 v2 上支持 extension package 时，public-children Session 已经可以带 extension Hook 目录或 MCP（`hosted-harness-session.ts:6011-6027`）。去掉 profile 条件后，版本 0 的 Session 也会走到这些形态：

- 带 extension Hook 目录、使用配置作用域 owner 的 Shell profile（S5）。S5 已经在 public-children Session 的发布通道上，为这种形态下的 Shell 调用固定了用例（"resumes a public-children Shell approval with extension Hooks"）。
- Shell Session 上由 wake 启动的 Turn，例如 loop 和 monitor 的 wake（S4）。这里也还没有带 Shell 调用的用例。

§7.2 为每种形态补一个版本 0 的用例。MCP 不在这些形态之中，因为带 MCP 的公开 Shell Session 永远不会挂起（§2）。

## 5. 派发前 Shell 的 G3 审查（决策 8）

在恢复、执行和清理中，Shell 都没有 public-children 条件，S8a 也只改捕获和识别。因此下面的审查同时适用于 public-children Session 和版本 0 Session。第一列里的"G3 §"指 G3 第 3 步设计的章节，其他章节号指本文。

| G3 要求                                                                   | 派发前 Shell 的证据                                                                 | 状态                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 计划在等待发布之前保存（G3 §4.1）                                         | 与原生文件是同一个生产者。Shell 调用只多一个 `publicationId`                        | 已有                                                                       |
| 定义、profile 和策略的 pin（G3 §4.1）                                     | `definitionRef` pin 住 profile 和通道，load 不能改变它们（§1）                      | 已有；S8a 读取它们（§4.3）                                                 |
| 原始调用、Runtime 和预留身份，不经过 `prepareRequests`（G3 §4.2 第 5 步） | `resumeSavedNativeBatch` 按计划重建请求，包括 `publicationId`                       | 已有                                                                       |
| 等待时没有已派发的工作（G3 §4.3）                                         | 只在最终计划之后才预留（§4.2），Broker 在 prepare 时从不派发                        | 两条通道都已确认（#18231；§7.1 检查 1）                                    |
| prepare 之间崩溃时重放原来的预留（G3 §4.2 第 5 步）                       | 按精确 key 重放返回原记录；`publicationId`、payload 摘要或 `inputDigest` 变化则冲突 | 两条通道都已确认（#18231；§7.1 检查 1）                                    |
| Allow 只执行一次；Deny 和过期执行零次（G3 §4.2 第 4、6 步）               | #18231 的门槛用例，停靠之后和 Harness 死亡之后各一遍                                | public children 和版本 0 在两条通道上都已固定（#18231；§7.1 检查 2；§7.2） |
| 后台 Shell 不会启动第二个进程                                             | Allow 之后的每条 `child_run` 记录都属于那一个预留的执行                             | public children 和版本 0 都已固定（§7.2）。只有发布通道有后台 Shell        |
| 只在安全结算之后释放 Runtime（G3 §4.2 第 7 步）                           | 恢复时记下的清理债务，以及 `held` 豁免（§4.4）                                      | 已有                                                                       |
| 过期的授权或变化的 pin 永远不会授予执行（G3 §2）                          | Workspace generation、定义和参数的检查（§4.4）                                      | 已有                                                                       |
| 派发后的 Shell 继续拒绝（G3 §4.3）                                        | 已启动的 Shell 已经越过等待点，停靠永远不会碰到它                                   | 不变                                                                       |

结论：

1. 证据链不依赖 public children。Shell 上仅有的 public-children 条件在捕获和识别中，它们决定计划是否存在，而不是计划如何恢复。
2. 决策 8 原先有一条通道没有测过。Shell 通道上的 public-children Session 在现有开关下已经会停靠，但 #18231 只覆盖了发布通道。开工前检查 1 和 2（§7.1）现在覆盖了 Shell 通道并且通过，所以不需要决策 8 所允许的那种临时、只针对停靠的拒绝。
3. §4.4 中的清理不对称是有意的。它是同一次释放的更严格的 owner，不是第二个 owner。

## 6. 决策与理由

1. **用 pin 住的定义识别 Shell 计划，不新增计划字段。** 定义已经 pin 住 profile 和通道，load 也不能改变其中任何一个。新增字段会重复这个 pin，并改变计划格式。被否决的方案：在计划中加 `shellLane` 字段。它引入了第二个必须与定义一致的事实来源，而且仍然免不了读取定义。
2. **两条通道都做，前面放一项开工前检查。** 工具发布默认关闭，排除 Shell 通道可能会让大多数 Shell Session 继续常驻。Broker 路径是共用的（§1），开工前检查 1 和 2 已确认这一点（§7.1）。
3. **team-lead profile 不纳入。** 它们是内部的，通道上带着 team orchestrator，而停靠中的 lead 与它如何交互还没有分析过。这与覆盖面设计对团队计划审批的处理一致。用一个具名的原因，可以让它们的占比保持可见。
4. **保留恢复时的清理债务。** 让恢复的 Shell Turn 像在线时那样直接释放，会削弱崩溃安全，又没有收益。
5. **不加能力位。** seal 和证书都不变。读取端的改动沿用 S1、S5 和 S6b 的做法：较旧的 Harness load 新计划时，在产生任何效果之前就会拒绝，load 会被重试。

## 7. 验证计划

### 7.1 开工前检查（实现之前）

1. **Broker，Shell 通道。** Shell 通道的预留（`runtimeProtocol: 3`、`inputDigest`）按精确 key 重放时不派发，并返回原记录。同一 key 下 `inputDigest` 或请求摘要变化时，以 `runtime_idempotency_conflict` 拒绝；执行结算后，同一 key 返回已结算的记录。这是 #18231 中 Broker 测试在 Shell 通道上的对应版本。已由 `RuntimeBrokerServiceTest.shellLanePrepareReplaysTheOriginalReservationUnderItsExactKey` 确认。
2. **Harness，决策 8 在 Shell 通道上。** 在现有代码上，一个没有 `captureBytes` 的 public-children Session 停靠一个 Shell 审批，经冷 load 后被 Allow。应看到一次使用保存 key 的 `prepare` 和一次 start。Deny、过期以及代用户放行的模式切换，行为与发布通道上相同。已确认：#18231 的用例矩阵（现名 "settles a %s Shell approval through %s after a %s on the %s lane"）也在 Shell 通道上运行，Shell 通道的八个用例全部通过。每个用例都断言保存的计划记录 `publicationId: null`；每个 Allow 或模式切换用例都断言恰好一次 `prepare`，参数是保存的调用 ID、请求摘要和重新计算的 `inputDigest`。把恢复中重新计算 `inputDigest` 的那一步去掉，这些用例就会失败。
3. **影响哪些 Session。** 从 `suspensionStats` 读取 canary 的 `parkRefusals.shell_profile` 计数。它决定 S8a 的优先级，但不阻塞实现。

### 7.2 S8a 用例

每个用例都在停靠之后和 Harness 在等待中死亡之后各跑一遍，两者的 journal 结果必须相同（覆盖面设计 §7，崩溃等价）：

- **版本 0 公开 Shell，每条通道。** Shell 审批经 Allow、Deny、过期以及代用户放行的模式切换完成。Allow 和模式切换按保存的 reservation 预留并执行一次；Deny 和过期执行零次。
- **后台 Shell，发布通道。** `is_background` 审批恢复后不启动第二个进程，在进程占着 Runtime 期间，恢复的 Turn 的清理债务保持 `held`。只有发布通道放行后台 Shell（`hosted-workspace-tool-turn.ts:2697-2703`）。Shell 通道在询问之前就把 `is_background` 当作校验错误拒绝，所以那里不存在这种等待。
- **Shell profile 上的文件审批。** 版本 0 公开 Shell Session 上的 `write_file` 审批能停靠并完成。这说明按 profile 的拒绝已经去掉。
- **Extension Hooks。** 在配置作用域的 Hook owner 上，Shell 调用已完成的 PreToolUse 和 PermissionRequest 不会重跑，Allow 之后它的 PostToolUse 只跑一次。
- **wake 启动的 Turn。** monitor 启动的 Turn 中的 Shell 审批能停靠，并且不经过 coordinator 完成。
- **一致性与拒绝。**
  - team-lead 的等待登记为 `team_lead_profile`，只计一次。
  - 读取端拒绝"带 Shell 调用、但定义不是公开 Shell profile"的计划。停靠资格和每个恢复入口都通过它读取计划，因此都会拒绝同一份计划。
  - 发布通道上 Shell 调用缺少身份的计划被拒绝，Shell 通道上 Shell 调用带了身份的计划也被拒绝。
  - Shell 与 `monitor` 混在一起的批次仍然是 `unsupported_tool`。
- **不变的相邻形态。** 现有的 public-children Shell 用例原样通过。

### 7.3 真实进程与 MySQL 8.4

按覆盖面设计 §7 的要求，在任何部署打开 `action-parking.enabled` 之前，每条通道至少有一个"停靠 → 新一代 Harness → 决定"的 Shell 用例进入必跑的 CI 层级。这些用例属于[父设计](2026-11-21-managed-action-parking.zh-CN.md)切片 3 的验收工作；H2 的结果不能替代它们。

## 8. 验收标准

- 版本 0 公开 Shell Session 的审批等待，在任一通道上经过一个空闲周期后都能停靠。一次冷恢复以不变的 Action、Prompt 和批次身份完成原 Turn。Allow 恰好执行一次，Deny 执行零次；Harness 在等待中死亡之后同样如此。
- team-lead 的等待、包含其他 Shell 通道工具的批次，以及已派发的 Shell，行为与之前完全一致。
- public-children Shell 用例通过，包括开工前检查 2 中的 Shell 通道。
- §7.3 的真实进程用例在任何部署打开 `action-parking.enabled` 之前通过。

## 9. 风险与兼容性

- **滚动发布与 Harness 回滚。** 低于 S8a 的 Harness 读不了版本 0 的 Shell 计划。它在产生任何效果之前，以普通的可重试恢复拒绝来回应 load，所以在 S8a 下停靠的 Turn 会一直等到较新的 Harness load 它。S1、S5 和 S6b 的计划也是这样。回滚 Harness 之前，先关闭 `action-parking.enabled`，让已停靠的 Turn 恢复完。
- **失败的方向是安全的。** Shell 工具定义变化、Workspace generation 不同或通道不匹配，都会拒绝恢复，在不执行的情况下结束 Turn。它永远不会用另一个身份去执行 Shell。
- **指标。** `parkRefusals.shell_profile` 消失，出现 `team_lead_profile`。读取旧 key 的看板需要更新。
- **作用范围。** 在 `action-parking.enabled` 打开之前，S8a 不起作用；在带 Hooks 的版本 0 Shell Session 上，它只在 S5 已经允许的情况下停靠；带 MCP 时永远不会停靠（§2）。

## 10. 开放问题

以下问题都不阻塞开发。

1. **team-lead profile。** 要纳入它们，需要分析队友仍在运行时停靠 lead 的情况，并与团队计划审批一起考虑。等 `team_lead_profile` 显示出实际占比时再回头看。
2. **通道分布。** 各部署中 Shell Session 在两条通道上的占比未知。这不改变设计，只影响 Shell 通道这几项检查的重要程度。

## 11. 实现范围

- Harness 生产代码：捕获条件、白名单和身份规则（`hosted-workspace-tool-turn.ts:4626-4656`、`:4737`）；读取端（`hosted-approval-continuation.ts:299-379`）；拒绝原因类型（`hosted-action-parking.ts:20`）。
- 测试：`hosted-harness-session.approval-parking.test.ts`、`hosted-harness-session.wake-approval-parking.test.ts`、`hosted-approval-continuation.test.ts`，以及 Broker 测试 `RuntimeBrokerServiceTest.java`。
- 不改 Java 生产代码、Store、seal 或证书。
