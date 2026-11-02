# 自动化扫描器行线程池

[English](2026-10-24-automation-scanner-row-pool.md) | [简体中文](2026-10-24-automation-scanner-row-pool.zh-CN.md)

- 状态：已实现（2026-10-24）
- Issue：[#15418](https://github.com/QwenLM/qwen-code/issues/15418)
- 取代 [Managed 自动化闸门设计 §10](2026-10-22-managed-automation-gate.zh-CN.md)
  中的悬而未决项「扫描器容量」。

## 问题

扫描器在每次阻塞式 Harness 调用期间一直占住它唯一的线程。带闸门的
`fire_run` 要在中继的 30 秒内等待探针（最长 20 秒），任何 fire 还可能先等
Session 加载，最长 `load-timeout`（120 秒）。因此一个慢定义会拖慢该节点上的
所有定义：一旦同一时间槽的探针占满整个周期，tick 就会超时，触发比时间槽晚
几分钟，到期的时间槽越过 `late-tolerance`（5 分钟）后对所有定义一律记为
`missed`。报告者实测一次闸门运行 10–13 秒，对应上限约为每节点四个每分钟一次
的 PR 监视。

## 决策

把 tick 的行放到有界线程池上处理（闸门设计的第一条路线），推迟 fire 的异步
作答（第二条路线）。要点：

1. 在任务内认领。`tick(now)` 把候选快照——`findArmed` 加
   `findFiringSchedules` 的行，每行只出现一次——分发到有界执行器上，由每个
   任务自行认领本行。各行原本就在一条原子的 `claim()` 守卫（`lease_until IS
NULL OR lease_until < ?`）下逐行上租约，账本写入全部带 fence 校验，因此并
   发处理不同的行在结构上就是安全的；两个任务争抢同一行时遇到的正是两个节点
   竞争时的那道守卫。先统一认领再入队会让排队中的任务握着即将过期的租约等待，
   所以任务之外不发生任何认领。
2. 租约按认领时刻起算，而不是 tick 起始时刻。`claim()` 是唯一的租约写入方，
   没有任何续期路径，而一个任务可能在租约生命周期过半时才开始运行。按 tick
   起算发出的租约一生成就已部分过期，多节点部署时立即可能被别的节点抢走。
3. tick 返回前先 join 全部任务。`scan()` 保持 `fixedDelay` 语义——tick 永不
   自重叠——且返回时不留任何已提交而未完成的工作。
4. 独立的执行器 Bean（`automationScannerExecutor`），而不是调大
   `managedAutomationScheduler`。tick 在 join 期间占着调度器的线程，因此用
   同一个调度器跑扫描会在池大小为 1 时把 tick 锁死在自己唯一的线程上，调大
   也只会为每个 pending 的 join 空占一条线程。
5. 关闭时线程池不会中断任务，但也不等待任务完成，更不保证它们能在 JVM 退出前
   完成。`destroy()` 立即返回（`awaitTerminationSeconds(0)`），本身不引入任何
   关闭等待。卡在 join 里的
   tick 仍受调用它的调度器约束（`managedAutomationScheduler`，本身是
   `SmartLifecycle`）：生命周期处理器把该 Bean 的 stop 上限设为
   `spring.lifecycle.timeout-per-shutdown-phase`（此处 30 秒）。这是关闭的上界，
   而不是必然等满；该上界在本次改动之前就存在。认领是落库的：丢失的应答会由
   后续 tick 重新驱动。

本次改动拒绝 fire 的异步作答：今天的 `firing` 意味着「应答在本次调用内挂起」，
落库一个挂起态需要协议变更（目前没有任何事件信封把闸门裁定送回控制面）、新的
结算语义，还要挪动手动运行的契约。如果探针时长继续打满 `2 × SCAN_LIMIT ×
scanner-threads`，它仍是正确的后续方向。

## 配置

- `automation.scanner-threads`（默认 4，必须为正数，启动时校验）。它与
  `automation.concurrency`（默认 4）不同：后者限制单个定义未结束的运行数和一次
  决定的 reconcile 扇出，不是线程数。
- 部署提示，而非代码要求：一次 fire 可能跑满 load-timeout + relay-timeout，在
  这种耗时经常超过行租约的部署上，运维可以把 `automation.lease` 调到 ≥
  `load-timeout` + `request-timeout`。

## 仍存在的上限（接受并记录在案）

- Harness 在自动化 funnel 的串行队列里运行每个探针，每个 Session 一个队列，因此
  线程池只能并行不同 Session 之间，不能并行同一个 Session 之内。
- 共享一个 Session 的多个定义会并发地做出准入决定：没有公开 Turn 时，同时到期
  的定义都会 fire——跨定义的准入只守卫公开 Turn（`hasOpenTurn`，自动化 fire
  不会产生 `ma_turn` 行）和每个定义的活跃计数。它们的运行仍在 Harness funnel
  里串行执行，所以一个 Session 的执行仍然一次一个。这是接受的语义，由
  `twoDefinitionsSharingOneSessionBothFireWhenDueTogether` 钉住（#15442 验证
  lane 发现 1）。
- 关于共享 Session 排队的决定（#15667）：线程池不按 Session 对行分组。第二个
  fire 因此会在前一个探针之后、在自己 30 秒的中继预算内排队，并可能丢掉应答；
  该 occurrence 会按退避重新驱动，Harness 仍会完成这次运行，重驱动要么重放已
  认领的运行、要么读回已结算的收据，因此同一修订内不会运行两次。在 Harness
  池中，一次丢失的应答还可能让该 Harness 退出选择，直到下一次成功刷新
  （#15666）。这里判定为预期语义而不串行化：funnel 跨节点共享、也公共中继共享，
  单节点排序并不能消除排队。运维建议：探针较慢的带闸门定义单独使用一个 Session。
- 冷 Session 加载时（中继开始前最长 120 秒），一次 fire 仍可能超过 60 秒租约。
  fence 会拒绝旧持有者的写入，occurrence 保持 `firing`，后续 tick 用派生 run id
  幂等地重新驱动它。本次改动不增加续期运行。
- 同一行内，时间槽、重驱动和 reconcile 调用保持串行；线程池只并行行之间。
  `SCAN_LIMIT`（100）是 tick 两次行查询各自的上限，因此单次 tick 最多提交
  2 × `SCAN_LIMIT`（200）个任务；两次查询都返回的行只提交一次。
- 上下文关闭时，线程池除了进行中的行，也会在非 daemon 线程上跑**排队中**的行：
  `destroy()` 立即返回，而关机钩子返回后 JVM 不会等待这份积压，因此排队的行
  可能既不会运行、也不会被等待。真正运行的行都在同一 fence 下认领与触发，丢失
  的应答会由后续 tick 重新驱动（#15442 验证 lane 发现 3；#15527 评审后修正）。

## 验证

- 单测（H2，基于现有的假 funnel）：
  `firesDueTogetherSettleAcrossTheRowPool`、
  `theLeaseRunsFromTheClaimNotTheTick`、
  `aHolderThatLostItsLeaseMidFireCannotSettleAndTheNewOwnerRedrives`、
  `aBacklogDeeperThanThePoolStillCompletesWithinTheTick`、
  `aTickJoinsEveryRowBeforeItReportsOneFailure`、
  `theScannerWorksRowsOnItsOwnBoundedPool`、
  `theScannerRowPoolNeverInterruptsRowTasksAndClosesWithoutWaiting`、
  `theScannerRowPoolStillBootsWithAnUnvalidatedSizeWhileAutomationIsOff`、
  `twoDefinitionsSharingOneSessionBothFireWhenDueTogether`、
  `aRowBothQueriesReturnIsSubmittedOnce`、
  `anInterruptedJoinReportsTheInterruptAndLeavesTheRowItsClaim`，以及新属性的
  绑定/启动校验。既有的租约与 fence 回归套件经由直接执行器原样运行，钉住
  同一套分发与 join 的串行形态。`aTickJoinsEveryRowBeforeItReportsOneFailure`
  在真实的单线程池上运行，第一个认领抛出时第二个行的认领仍在飞行中：直接执行器
  钉不住 join，因为它的任务在提交阶段就已跑完（#15442 验证 lane 发现 2）。
- `commonClaimFailuresProduceOneBoundedSummary` 钉住统一的认领故障：五行已提交
  任务产生四个额外的已观测任务异常，一条 WARN 只带前三条 tenant/schedule 身份，
  不带 throwable 负载，并原样抛回第一个异常。计数覆盖已观测的行任务异常，不统计
  已在行内处理的 fire/decide 错误；即使中断提前停止 join，`submitted` 仍是已提交行总数。
- MySQL（`AutomationScannerConcurrencyMySqlIT`，`mysql-integration` profile）：
  InnoDB 行锁下竞争认领只有一个 fence 赢家；接管后旧所有者无法移动账本；两个
  扫描器跨线程池对每个 occurrence 只结算一次。
