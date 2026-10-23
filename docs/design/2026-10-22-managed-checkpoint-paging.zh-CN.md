# Managed Harness 检查点历史分页

[English](2026-10-22-managed-checkpoint-paging.md) | [简体中文](2026-10-22-managed-checkpoint-paging.zh-CN.md)

## 状态与问题

实现已完成，本地专项验收通过；完整回归的保留失败及原生路径限制见下文。本次承接 #15094 的有界预算和恢复修复。一个尚未结束的 Turn 会在检查点中累积已完成工具收据与 Runtime 绑定。将物理上限从 64 KiB 提高到 1 MiB 只能推迟超限；删除已消费条目会移除持久化的重复执行保护。HTTP 事务还会重新枚举所有传递依赖，并受 1,024 个资源的限制。没有已提交历史复用的分页列表不能解决第二个限制。

这个以 main 为目标的后续改动依赖 #15094 提供 1 MiB 物理根和 publication/readback 引用预算。在该前置 PR 合入之前，main 仍拒绝超过 64 KiB 的检查点资源；48 KiB 的有界历史页没有消除活动根的预算前置。预算与恢复补丁继续由 #15094 跟进，本 PR 不重复包含它们。上线前需 rebase 并验证组合后的部署。

## 目标与边界

让物理检查点和不可变历史页保持有界，增量追加历史，保留每个执行身份与结果引用，恢复时不重放已完成工具。待完成、未消费调用保留在活动检查点。新页、引用、检查点根与 journal/head 推进沿用既有原子事务提交。

本次改变检查点持久化，不重构整个 Session 的保留模型。逻辑执行视图仍完整物化工具和绑定数组，保留现有状态转换校验及重复执行保护的权威性。单个检查点的加载和逻辑校验仍为 O(历史量)。完整 journal 重放可能反复访问历史前缀，代价更高；不声明进程内存有界或恢复耗时恒定。journal 压缩、对象存储、UI 历史分页及未知物理执行的自动续跑不在范围内。现有 Session/CSI inventory 与 snapshot 的总行数、字节上限仍作为显式容量保护，包括 4,096 项 history/inventory 限制；本功能不证明 10,000 次原生 CSI 调用可用。活动批次和工具发布 profile 保留现有上限。在 #15094 合入前，main 的发布 profile 仍保留 64 KiB 检查点引用限制；仅有 codec 的 1 MiB 根保护不足以部署该大小的根。

## 逻辑与物理格式

保留现有 Harness v1 逻辑状态及对象级 schema 校验。小型内联 v1 检查点不变并保持可读。分页物理检查点保留相同的顶层 identity、continuation、活动 tools 与 Runtime 分组，并增加明确的 `storageProfile=managed-checkpoint-paged/1`、历史头引用以及工具/绑定累计数量。普通 `managed-checkpoint` 引用的 kind/version 不变。旧 Harness 读取器拒绝陌生物理字段并保持恢复阻塞。

只有已 settled、已 consumed 的工具前缀及其终态 Runtime 绑定可以封存。近期尾部以及全部未完成、未消费条目保持内联。每批最多封存 32 个工具；每个 `managed-checkpoint-history` 页最多 48 KiB，包含 Session/Turn/prompt 作用域、前页引用、累计数量、工具条目及匹配绑定。编码字节达到页上限时拆分该批。正常增量执行时，根内保留最多 63 个已完成且已消费条目，以及全部待处理或未消费条目；现有 1 MiB 物理上限继续保护异常大的活动元数据。

历史条目只包含有界标识符和持久化引用，不内联工具输出正文。既有 stable-ID 校验将每个标识符限制为 512 个 UTF-8 字节，摘要和数字元数据也有界。较大的 outcome 保留在引用指向的独立资源中，不会让单个合法历史条目超过 48 KiB。提高根预算不会放宽这些字段限制。单条容量检查保留为针对未来 schema 变化的防御性守卫。

页不可变并组成链，根不维护持续增长的页引用数组。加载时校验作用域、精确引用身份/摘要、递减累计数量、终态/消费标记、绑定对应关系、唯一性及重建后的完整 v1 阶段形状。缺失、损坏、成环或替换的历史会阻塞恢复，不会被当作空历史。原始数组顺序、ordinal 和引用必须保留。发布与冷解码均限制单个检查点最多 4,096 页、历史页编码总量最多 64 MiB。这是损坏及内存保护，不代表外围 Session 或 CSI 必然能达到该容量；它们现有且更低的 inventory/snapshot 总预算仍然生效。

## 发布、复用与崩溃行为

authority 在编码前分配检查点身份。命令摘要覆盖实际物理根。发布器只能复用上一检查点已经提交的历史，并拒绝修改该前缀。最新检查点缓存仅在 journal 明确提交后推进；结果不确定的 append 不得证明页面已提交。冷读取器从固定的已提交根重建依据。

HTTP census 包含新页内容和复用的历史边界，避免递归重报全部旧历史。只有在明确的历史页边界后才能省略历史后代。Java 校验精确元数据及同 tenant/Workspace/Session 的已提交所有权，其 revision 不得晚于固定的前序 head。新引入页的依赖必须位于当前事务，或有先前已提交历史的证明。继续禁止通用的缺 census 后 SQL 回退。

Native CSI 必须将物理根解码为完整逻辑状态，再执行现有 canonical 预期转换比较。物理 census 与有作用域的历史页读取分开：当前资源仍须与声明 census 精确一致，归档页使用原始已提交所有权证明。无关旧页不能替换预期执行前缀。Hosted closure 采用同样的窄边界规则。现有活动 `JOURNAL` owner 会保护旧页依赖直至 Session 永久退休，不新增 GC 或 schema 迁移。

提交前崩溃时，旧根继续权威。事务已提交但确认丢失时，沿用既有幂等与 head 校验结算。writer generation 和 activation 约束不变。缺少确认不能被声明为物理执行成功。

## 接入范围与发布

增加共享 Core 物理检查点 codec 与页引用提取器，接入 authority 两条提交路径、权威加载、原始收据检查、shell capture 授权、Hosted 冷加载及 Workspace 恢复。逻辑 schema 校验与有界字节解析分离。HTTP 事务 closure 和只读 snapshot 检查使用同一页 schema，但遍历目的不同：增量准入与完整固定 snapshot 校验。

在 Java Session Store、Hosted 恢复 closure 及原生 CSI 准入/proof 中增加对应的页/所有权校验，并在历史应用 inventory 中识别新 kind。工具发布可继续检查内联的 in-progress 条目，因为它们永不归档。只读 snapshot 与 CSI 导出/恢复继续在现有总预算内校验完整引用闭包。

| 层次                        | 主要实现路径                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 物理 codec 与逻辑 authority | `packages/core/src/managed-runtime/managed-checkpoint-history.ts`、`managed-harness-checkpoint.ts`、`managed-session-authority.ts`                                                                                                                                                                                       |
| 增量传输与冷恢复            | `packages/core/src/managed-runtime/http-managed-session-store.ts`、`packages/cli/src/serve/hosted-harness-session.ts`、`workspace-recovery-session.ts`                                                                                                                                                                   |
| SQL 准入与 Hosted closure   | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionStore.java`、`ManagedHostedRecoveryRecords.java`                                                                                                                                                               |
| 原生 proof 与历史应用校验   | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/runtimebroker/ManagedCheckpointHistory.java`、`CsiNativeActivationProof.java`、`JdbcCsiActivationAdmission.java`、`JdbcCsiExecutionAdmission.java`；persistence 下的 `WorkspaceCsiApplicationHistory.java` 和 `WorkspaceCsiApplicationInventory.java` |

生成分页根前，一并部署兼容的 Java 校验器/读取器与 Harness。既有内联检查点无需迁移；下一次成功提交可封存其消费前缀。分页后降级会明确阻塞。保持 #15094 可独立评审，在前置合入后验证组合部署。功能验证不重启或修改用户预览和 Session。

## 验证与验收

1. 先确认全局 CLI 基线；若不能进入 Managed 路径，保留证据并使用确定性当前基线 fixture。以小工具结果分别证明逻辑 1 MiB 超限和 1,024 资源 census 上限。
2. 增量增长同一 Turn 的逻辑历史，超过上述两个限制。断言根/页大小及每步 census/新增字节有界，历史页不可变复用，收据/绑定/结果身份精确保留，普通资源上限不变。
3. 在另一进程重新打开并重放早于进程内 1,024 条窗口的执行。要求新增执行/模型请求为零，待完成/未消费工作保留，后续 Turn 正常。
4. 覆盖提交前失败、确认丢失、generation 接管和旧 writer 拒绝。拒绝错误作用域、未来/未提交 owner、冲突摘要、缺页/依赖、成环、计数/顺序冲突及历史前缀替换。
5. 覆盖旧内联 v1、原始收据检查、shell capture、Hosted/Workspace 恢复、原生 CSI canonical 转换证明、完整 snapshot closure、inventory 有界拒绝及退休引用保留。
6. 执行根目录 build/typecheck/bundle、相关包测试、Java 验证、独立 MySQL 及对应原生 Hosted/恢复门禁。明确记录无法执行的外部模型和平台检查；本地确定性成功不等于生产验收。

## 本地验证观察

以下记录来自之前包含预算与恢复修复的集成预览，并非独立的 main 目标分支。抽取后 PR 的最新检查及保留失败会记录在独立的 E2E 报告中。

在 macOS、Node 24.19.0、JDK 21 和独立 MySQL 8.4.11 上，独立协议历史测试从 256 条增长到 2,560 条逻辑收据。真实 Java/MySQL 路径的当前 census 保持 35 个资源，最终物理根为 24,211 字节，逻辑状态达到 1,763,787 字节。Java 重启及第二个 Node 进程能读回全部结果，并在最早执行已被进程内缓存淘汰后仍拒绝重复执行。本轮冷读取加上逐项 HTTP 结果校验用时 171,563 毫秒；这不是独立的检查点解码或 Turn 延迟基准。这些是合成逻辑收据，不是 2,560 次原生 worker 执行。

构建后的 CLI 单独通过受控模型/Broker 适配器完成 96 次 Harness 协议文件读取。冷重放没有新增工具或模型调用，后续 Turn 也完成。独立的拒绝提交、确认丢失和 writer 接管检查通过。最初测试适配器清理及并发重试失败的记录仍保留；修正后在全新状态完整重跑通过，未为此修改产品代码。

build、typecheck、bundle、改动 TypeScript 的 lint/format、454 项 Core 聚焦测试、完整 Java 验证（5,175 项，18 项既有跳过）以及 206 项选定 MySQL 集成测试通过。独立源码审查未发现问题。最终按原预算、单 worker 完整复跑三个 CLI 测试文件，706 项全部通过；干净的未分页基线也通过相同的 706 项。最终复跑期间源码和构建产物均无变化。早前完整运行的 700 项通过、六项失败及 701 项通过、五项失败记录仍保留，包括两轮不同的超时、等待和 prompt 404 失败。其根因尚未确立；最终整套通过不会抹除这些观察，也不能据此认定负载或性能原因。

匹配的 Hosted/故障 profile 共 12 项测试、九项失败。干净的未分页 Java 和 CLI 基线复现了相同的九个失败测试名。首次工具的 Workspace 准入拒绝及初始存储 owner 缺失都发生在产生分页历史之前，因此这些本地门禁没有验证被拒绝的原生执行路径。其根因与本功能分开处理，没有绕过 Workspace 保护。本地证据不覆盖外部模型提供方、Windows 或仅支持 Linux 的 shell 恢复。用户预览和 Session 保持原样。

## 未决问题

本阶段不需要新的产品决策。更广泛的 journal 压缩和全局 CSI inventory 限制调整属于 #13184 跟踪的长会话存储工作，检查点分页验收不得隐含这些能力已经完成。
