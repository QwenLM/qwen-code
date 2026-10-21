# Workspace profile 生命周期（L4）

[English](workspace-profile-lifecycle.md) | [简体中文](workspace-profile-lifecycle.zh-CN.md)

## 问题与范围

L3 只支持活跃的 `hosted-workspace-files/1` 会话关闭和删除。Shell capture、publication、后台 Shell、Monitor 与 MCP 连接必须先完成持久结算，才能复用关闭与删除屏障。本设计实现 #13164 L4，分 Shell、MCP 两片交付；开发基线包含 #13673、#13674、#13889 的原 worker 恢复、公开 Shell 准入和 H3 drain 接口。

精确支持 `hosted-workspace-shell/1` 与 `hosted-workspace-mcp/1`；不扩展 `/2`、CSI、内部 TeamLead profile、UI 控件或子会话前台取消策略。沿用已有子会话级联。授权仍为会话 owner 且当前可读；幂等键仍按 actor 隔离。前台 Turn 运行、取消或等待审批时返回 `turn_active`。

close 保留字节。archive/unarchive 复用 L1，unarchive 恢复 closed，不恢复 active。delete 复用 L2，原子提交 tombstone 与私有恢复/publication 退役。物理回收归 O4-2；保留其他会话和共享 Workspace 文件。关闭 profile 新执行开关不关闭已有会话的生命周期清理。

## 协议与状态机

保留 files 客户端使用的 `lifecycleProtocolVersion: 1`。新增可选 `lifecycleV2Profiles`，精确列出支持的 profile，缺省表示不支持 v2。Java 同时检查 Broker 的原 worker 退役证明能力。活跃 Shell/MCP 新操作持久化 protocol 2。历史 protocol 0/1 保持语义；未知版本拒绝，不能按 legacy close 执行。

复用私有 `/session/:id/lifecycle`。v2 请求携带 `protocolVersion: 2`、`phase: effects | prepare_resources | settle_resources`、Session key、操作 kind 与当前 operation/claim authority；v1 保留原请求格式。响应绑定 operation、Session、phase 和版本。资源 ACK 不等于完成证明。

1. 准入检查 actor/read/owner、幂等键、空闲前台 journal 和精确 profile 能力，提交围栏与 closing/deleting，拒绝新普通工作和 warm。
2. `LIFECYCLE_ONLY` 中按原身份核对已启动业务效果与旧 Hook。close 执行 SessionEnd；delete 再执行 SessionDelete，沿用 L3 的稳定 occurrence ID。未知业务效果不重放。
3. Java 独立验证并保存 effects receipt，进入 `DRAINING`。复用现有 receipt 列；它只证明 Hook effects。
4. drain 前总是按当前 claim 准备资源 attachment，即使 effects 已保存。writer 与原 publisher 保持可用期间结算资源。
5. Java 独立验证资源闭合，detach writer、停止原 worker；最终事务重验 effects、资源、writer 退役和原停止证据，然后完成 close，或原子提交 O4 退役与 tombstone。

不新增业务表或无界汇总 receipt。恢复依赖持久 protocol、围栏 phase、资源/publication 记录和 Broker 台账。资源不确定时报告 `workspace_lifecycle_resources_unsettled`，保持 closing/deleting 与 recovery blocked；保留独立的身份、Hook、业务执行错误。

## 清理授权与恢复

v2 `DRAINING` 允许当前 operation claim 获取仅供清理的 writer。协调器停机期间租约过期的驻留 writer，只有 token、writer ID 和 generation 仍拥有已锁定的 journal head，且当前资源 claim 有效时，才可续租。冷 acquire 与该续租通过同一 head 串行决策，先成功的一方围栏另一方。普通续租、files v1、effects 阶段、旧 claim 和已被替换的 writer 保留租约检查。冷 attachment 读取已保存 definition 与原身份，不运行 SessionStart、模型、普通工具、configure/discover/invoke 或 Monitor rebuild。Broker recovery acquire、status、release 自身校验当前 claim 和保存的 binding/generation；禁止新普通 acquire。

journal/publication 写入按已有资源身份严格限定为输出引用推进、终态、释放证据和已有通知取消。拒绝新执行、换 Runtime 身份和新普通输入。新生命周期 Hook dispatch 仍校验当前 ACL 与挂载授权。claim 接管更新驻留和冷 attachment，旧 claim 不能修改清理记录。

## Shell 切片

prepare 禁止新 Monitor wake 和通知产生，不提前宣称物理停止；原 observer 和 publisher 继续收尾输出。按持久 Broker 台账枚举全部保存的 RuntimeSession，不依赖 `heldRuntimeTurns`。提取现有 binding drain 的 Session drain 部分，不调用 `stopDrained`。

原 RuntimeSession drain 后，按原进程退出/停止证据结算 stdout/stderr capture、publication manifest、后台任务与 Monitor 终态；无模型取消已有通知，然后关闭 publisher 并 detach。Java 独立核对 tool receipt、输出引用、manifest、publication 状态和后台记录。输出须封口或有明确可验证的失败终态；新 publisher 没有 pending 不构成证据。

前台 inline capture 的 receipt outcome 为 `REFERENCED`，间接引用的 manifest、page 和 segment 可以仍为 `PUBLISHED`。先验证原 journal 来源和保留的 outcome，再检查 manifest 的原执行身份、stream 摘要与封口证据。capture 被阻塞时，即使 `resultRef` 为 null，仍须验证其 manifest。O2 publication outcome 使用 `TOOL_PUBLICATION`：在最终事务前执行已有对象/receipt 验证，再在事务内复核 publication phase、quarantine 标记和精确的 admission、receipt sequence 与 revision。MCP inline record 读取器不能用作输出读取器。

Shell profile 中的原生 `read_file`、`write_file`、`edit` 和 `glob` 使用普通文件结果，不产生 O3 capture receipt。只有同一 Session 已提交的 `managed-tool-input` 校验通过字节与摘要、指向原 Harness 与 Runtime Session，且其精确 `payloadJson` 摘要匹配执行请求时，已结算的 Broker 台账才能满足文件调用的资源关闭条件。调用必须是没有 `runtimeProtocol` 和 publication grant 的旧 `deferred` 路径。不能仅凭缺少 capture 或 receipt 认定文件调用：旧 tool v2 也支持 Shell。未知执行、跨作用域/损坏/未提交的输入以及缺失 receipt 的 Shell 仍须阻塞。验收包括 Shell profile 的真实 Write/Read 后 close，以及运行中 Shell 取消 → 原生文件工具续轮 → close 的连续场景。

manifest 的 invocation digest 遵循原执行协议。仅持久记录为 `runtimeProtocol: 3` 且 `dispatchMode: deferred` 时使用原始裸 `inputDigest`；摘要缺失或格式无效时阻塞清理。该记录的 `argsDigest` 对完整请求求摘要，不能替代输入摘要。Deferred v3/O2 与 H3 start invocation 继续比较原 `argsDigest`，后台 process hold 不能替代 start invocation 的身份。不能只按字段是否存在选择摘要，也不能通过剥掉 hash 前缀猜测。

worker 已停止不能证明缺失输出已发布。未知输出继续阻塞；禁止重跑 Shell、新建 capture 或 Monitor rebuild 来补造完成。已知 capture 失败保留为失败，不改成成功输出。

## MCP 切片

生命周期 Hook 前核对所有已启动 configure、raw operation、tool invocation 和旧 Hook。仅有支持证据的未 dispatch intent 可以记为 `not_started_proven`。已启动效果未知时，即使 worker 已死也继续阻塞。

原 worker 存活时：通过 recovery acquire 恢复原 owner；使用 configuration 的稳定 H1 release ID；持久化 `drained`；释放原 Broker RuntimeSession；持久化 `released`。先释放 owner 会使后续 H1 status/release 失去执行条件。覆盖全部 configuration revision，以及与 Hooks 共享的 owner，包括没有 MCP configuration 的 Hook-only owner。

原 worker 可证明已停止时，已知业务/Hook 效果与可信匹配 stop proof 可证明本地连接结束，释放精确 owner。保留证据来源，不伪造 H1 release ACK，也不宣称远端 Session 删除。只要本地 transport 已关闭，HTTP DELETE 超时不妨碍本地清理。endpoint、secret、连接 recipe 不进入公开 receipt。普通 MCP worker replacement 的现有限制保持不变。

匹配的 NOT_FOUND 观察允许停止清理路径在 LOST binding 仍有持久 owner 时等待原 worker 的 stop receipt，但它本身不能释放 owner。先持久化该 receipt，才将 binding 转入 DRAINING 或释放 owner；状态转换和每个停止后 owner 的释放都在 Broker 事务内独立校验当前生命周期 claim。已 dispatch 且结果未知的执行仍在 stop/release 前阻塞。MCP 资源阶段的 `workspace_close_identity_unverified` 可以进入这条核验证据的恢复路径；执行、授权和 claim 错误保留原错误码，Shell 身份错误也保持拒绝。重试可以复用原 receipt，但不能创建 worker、重放效果或补造 H1 ACK。

## 涉及组件

| 层                 | 变更                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------- |
| CLI Hosted Harness | 三个生命周期阶段、清理专用 attachment、原 Hook/MCP owner、Monitor wake 抑制与输出结算。 |
| Java SDK           | 可选精确 profile 能力、v2 load，以及生命周期请求/回执校验。                             |
| Managed server     | profile 准入、当前 claim 的 writer/record 授权、独立效果/资源校验和最终原子退役。       |
| Runtime Broker     | 持久 owner 枚举、原 RuntimeSession drain 与 recovery control 的 claim 检查。            |

源代码变更集中在 `packages/cli/src/serve/`、`packages/sdk-java/qwencode/`、`packages/managed-agent-server/` 和 `packages/managed-agent-server/`，测试与源码同目录。E2E 计划及执行结果保存在 `.qwen/e2e-tests/workspace-profile-lifecycle.md`。

## 验证与发布

Harness 默认不声明 v2。Shell 片验收通过后设置 `QWEN_HOSTED_LIFECYCLE_V2_PROFILES=hosted-workspace-shell/1`，MCP 验收通过后才加入 `hosted-workspace-mcp/1`。启动时拒绝不支持或重复的条目。publication 对象内容在最终 SQL 事务前校验；事务内复核不可变回执/catalog 身份、资源终态与停止证明。

验证计划覆盖精确协商、files v1、关闭新执行后的清理、actor 幂等与权限、活跃 Turn 拒绝、phase/claim fencing 和 DRAINING 冷恢复。Shell 覆盖前台、后台、Monitor、持久旧 hold、停止时最后输出和已知失败/未知输出。MCP 覆盖 stdio/HTTP/SSE、多 revision、Hook-only owner、release ACK 丢失、worker 死亡与未知业务效果。

真实 MySQL 与进程故障测试覆盖 Hook/effects、drain、publication seal、detach、stop、tombstone 前的切断；claim 接管不能重复 Hook 或业务效果。公开 API 删除 Shell 后直接触发 O4-2 回收，不使用测试接缝。close 不运行 SessionDelete，删除与退役原子提交。完成前执行 build、typecheck、bundle、针对性测试与 review；实际结果单独记录，不能以设计替代验证。macOS 开发环境的结果不能替代 Linux 原 worker/H3 cgroup 用例及完整 MCP transport 释放矩阵；这些仍是发布门槛，v2 profile 默认不声明。

先升级全部 Java/Broker 生命周期消费者，再部署声明 v2 的 Harness。Shell 验证通过后再启用 MCP。有未完成 v2 操作时不得降级到仅支持 v1 的消费者。没有未决产品问题。
