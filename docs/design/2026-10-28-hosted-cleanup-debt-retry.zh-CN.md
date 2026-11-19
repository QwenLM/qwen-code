# Hosted 清理欠债跨 Harness 代际重试

[English](2026-10-28-hosted-cleanup-debt-retry.md) | [简体中文](2026-10-28-hosted-cleanup-debt-retry.zh-CN.md)

## 问题

Hosted Turn 的终态提交与物理清理是两个独立事实。Broker 释放、文件历史标记
或 producer 清理被拒时，Harness 会把 `hosted.cleanup` 以 `owed` 提交，并在
自己存活期间持续重试。这笔欠债还会作为 `ma_resource_ref` 中的
`HOSTED_CLEANUP` owner 持久投影，阻止原 Runtime binding 家族被回收。

打包的 C3 支路复现了这一代先死时的后果：控制面已经投影了终态，Harness 在
一次被拒的释放之后被杀死。此时没有任何 Turn 可调度，也就没有任何路径把
Session 加载进替换代际。`SessionRecoveryService` 只在 operator 主动触发的
路由上重查 cleanup，替换方的 `/load` 从未到达。原 Runtime 一直被保留，
公开 Turn 保持在“已完成但清理欠付”的状态。同一个支路在崩溃早于终态投影时
却能通过——那时普通的 Turn 重派会接手并清偿欠债——因此它是对时序敏感，
而不是确定性的。

## 决定

由控制面负责这笔欠债的自动重试：它是唯一跨代际存活的角色，并且已经持有所需
的持久投影。

周期性扫描列出仍欠付、且所在 Session 没有活跃 Turn 的 `HOSTED_CLEANUP`
owner，从 cleanup descriptor 解析出欠付的 Turn，再通过既有的
`HarnessConnector.recheckRecoveryCleanup` 发出 prompt 作用域的 cleanup-only
load。该 load 用原 Runtime 身份完成释放，并在同一 cleanup ID 下提交
`confirmed`。这里不新增路由、协议字段、schema 列或持久重试行：欠债投影本身
就是重试状态。Store 通过限定符读取专用的 `managedJdbcTemplate`，因此嵌入部署
绝不会去扫宿主的业务库。扫描采用 keyset 分页：游标跨过它读到的每一行原始
记录（包括不可读的 descriptor），并在一页不足时回绕到起点，因此一段卡住的
前缀不会饿死它后面可恢复的欠债。

## 范围与边界

- 只处理带 Workspace 的 Session。descriptor 必须是该 Session 自己的内联
  `hosted-turn-cleanup/1` 资源；外来或不可读的 descriptor 只记录日志并保持
  欠付，绝不删除。
- 存在 `ACCEPTED`、`RUNNING` 或 `CANCELLING` Turn 的 Session 会被跳过。它的
  driver 仍拥有这笔欠债，此时发 cleanup-only load 会与活跃 Turn 争夺 Session。
- 扫描不重写 Turn、公开事件流或终态。已完成的 Turn 保持已完成。
- cleanup-only load 不能启动 Turn、执行工具或重新发起推理。
- 释放仍使用 descriptor 的 binding 与 generation。证据不明时保留欠债与保留
  栅栏；绝不回退到更新的 owner 或 primary Runtime。

## 重试与并发

该 tick 运行在 `managedAgentScheduler` 上，与本模块其它所有 dispatch 扫描用
同一个具名调度器；裸写的 `@Scheduled` 会落到一个已被阻塞式 Git 扫描占用的
共享单线程池。

一次尝试如果没有可行动的证词或抛出异常，会在内存中按显式阶梯退避——
10s、20s、40s、80s、160s，然后封顶 5 分钟。一条退避记录在空闲达到上限两倍后
才被清除，而那只会发生在它的欠债已确认、离开投影之后；因此轮转绝不会重置
一笔仍欠付债务的退避。失败的尝试是否同时丢弃连接器缓存的 attachment，由一份
显式白名单决定，它与 `HarnessPoolConnector` 自身的可达性分类一致：传输丢失、
代际移动、未知 mutation 结果，外加引用消失（404）与可能挡在已死 daemon 前面
的 5xx。这些意味着缓存代际不可达，于是下一次尝试自行发起冷 cleanup load。
具名拒绝——被拒的 load（`HostedHarnessRecoveryDeclinedException`）、
`harness_pool_unavailable`、或 4xx——不是陈旧证据，只退避：淘汰那个
attachment 会搅动 Turn 仍在运行的 Session。每个 tick 对每个 Session 最多尝试
一笔欠债。

两个控制面可能扫到同一笔欠债。cleanup load 是幂等的：存在活跃工作时 Harness
会拒绝并发 attachment，失败方退避；一旦确认清理删除投影，另一侧扫描就看不到
任何欠债。与第 3 步其余部分一致，一个 Session 的 Turn 所有权仍假定只有一个
活跃控制面。

## 验证

- `HostedCleanupDebtStoreTest` 在 H2 的真实 schema 上钉住列出规则：本
  Session、无活跃 Turn、内联 descriptor、存在 Workspace；外来与不可读
  descriptor 不会被返回。它还钉住游标：一页二十条不可读 descriptor 不返回
  任何欠债、但也不算到底，推进游标即可读到它们后面的有效欠债。
- `HostedCleanupRetryCoordinatorTest` 钉住重试路径、按 Session 退避、每 tick
  一笔、满页推进游标与短页回绕、失效 attachment 淘汰（以及具名拒绝时保留
  attachment），还有 Harness 不可用时不扫描。
- `ManagedAgentEmbeddingTest` 钉住 Store 绑定专用的 `managedJdbcTemplate`：
  在宿主业务库存在时，扫描读取的是 managed schema，而不是以
  `ma_resource_ref` not found 失败。去掉限定符即可复现该失败。
- 打包 C3 支路（`--g3-fault cleanup-failed`）拒绝第一次释放，等待控制面投影
  终态后杀死该代际，启动替换方，并要求替换方通过扫描释放原身份：
  `releaseFailures=1`、`releaseSuccesses=1`、一次 `confirmed`、不再有
  `HOSTED_CLEANUP` 欠债、原 Runtime 为 `RELEASED`、一次执行、一次文件效果、
  原终态与恢复出的答案。关闭扫描会让支路在
  `Post-fault cleanup retry reached the replacement` 超时；此时替换方健康，
  却始终收不到 load。

## 兼容性

没有 schema、协议、路由或配置变更。既有的 operator recheck 路由继续可用，
并作为 cleanup load 会拒绝的 profile（Hook、MCP，或没有 `recovery-cleanup/1`
的 Harness）的兜底。这些 Session 在 operator 或后来的兼容代际清偿之前，保留
欠债与保留栅栏。
