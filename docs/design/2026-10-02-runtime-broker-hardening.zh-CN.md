# Runtime Broker 加固：原子会话释放、独立续约、监听姿态

[English](2026-10-02-runtime-broker-hardening.md) | [简体中文](2026-10-02-runtime-broker-hardening.zh-CN.md)

状态：已在 `packages/sdk-java/runtime-broker` 实现（PR #13214,issue #13183)。

## 问题

一次代码审计发现 Runtime Broker 的三个高危缺陷。其一，会话释放决策与"无活跃 execution"检查分属两个事务，仅由进程内锁守护：当两个 Broker 进程共享一个数据库时，可能出现 execution 已准入而 session 被标记为 `RELEASED` 的矛盾态。其二，所有租约续约都跑在与重试、截止围栏和轮询共用的单条调度线程上，且均为同步 JDBC：存储抖动 1-2 秒就会让续约排队错过租约，把健康的 binding 围栏。其三，Broker 的 HTTP 面以明文 HTTP 服务单一全局 Bearer token，并接受非回环监听地址。

同一次变更还修掉两个成本较低的中等缺陷。忽略 SIGTERM 的已释放 worker 从不会被强制销毁，且 ready 握手期间的 JVM 退出会遗弃它。LOST 回收每个阶段也只跑一趟有界的 100 行恢复批次，因此超过一趟容量的代际需要连续多次 reclaim 才能排空，而每一次都回答 `runtime_broker_runtime_lost`，binding 在此期间无法复用。

## 决策

**单事务释放。** `RuntimeBindingRepository.beginSessionRelease` 把"无活跃 execution"检查移入 RELEASING 转换自身的事务。该转换持有 Session 行的 `FOR UPDATE` 锁——与 `admitExecution` 获取的是同一把锁——因此两条路径在跨进程场景下按会话行互斥。带活跃 execution 的释放以 `runtime_session_busy` 失败；输给 RELEASING 会话的准入以 `runtime_admission_closed` 失败。进程内预检只保留零成本的 `hasActiveControl` 判断，转换自身的检查以相同的 code 和消息回答同一个 409。已持久化为 RELEASING 的行根本不会进入该转换，因此它的幂等重入自行复查活跃 execution：这样的行可能早于本次加固存在——旧版本对端的 check-then-act 放进了准入，而它的 worker 释放随后失败——若把这次释放做完，就会放走一个仍在执行工具的 worker。

**续约线程池。** 续约（binding claim 与 dispatch claim）运行在独立的双线程 `ScheduledThreadPoolExecutor`；协调工作（重试、围栏、轮询）保留单线程调度器。一次卡在 JDBC 调用里的 tick 会占用池中两个线程之一，因此它可能拖慢其它续约，且 `close()` 会中断两个线程池、不等待卡住的 tick。这次拆分买到的是：卡住的 tick 不再**就是**协调线程本身——在 merge base 上它正是那条线程，所有协调任务都排在它后面。它并没有让协调对存储卡顿免疫：卡住的 tick 仍持有该 claim 的续约监视器，而供应围栏、回收围栏与 reconcile 重入都会从协调调度器的任务里取这把监视器（分发结算则在其完成线程上取）。因此一次足以让 tick 卡住的存储停顿，仍可能通过这把监视器阻塞唯一的协调线程，连带阻塞其它所有执行的结果轮询、围栏、重试与冷却淘汰。要连这一层也解耦，需要给续约的 JDBC 加语句/套接字超时，或改用不持监视器的续约句柄；两者都不在本次变更内（#13275）。v3 结果轮询从 100ms 起指数退避、2s 封顶（该上限约束的是单个执行两轮之间的排程延迟；所有执行的轮询共用这条协调线程，因此并发下的取走延迟是"上限 + 该线程的排队等待"），轮询所处的窗口可配置（`v3ResultWindow`，默认 30 分钟，下限 1 秒——无后缀的配置值会被解析为毫秒，构造函数现在拒绝这种值）；窗口到期后，已派发的执行被标记为 UNKNOWN 而不是无限轮询，因此它是轮询截止期，不是结果保留期。对 UNKNOWN 执行的自动观测在 1 秒冷却内复用最近一次查询结果，不再把每次轮询穿透到 worker；自身记录已不再是 UNKNOWN 的缓存查询整体回放，两侧都仍为 UNKNOWN 时取 version 更大的一方，因此绝不会把已结算的答案与过期记录拼配。显式 `reconcile=true` 与 mutation 响应（`:start`、`:cancel`）永远不走缓存——这也意味着现网的 MCP 轮询器每 250ms 以 `reconcile=true` 询问，仍然每次穿透到 worker：该路径上实测到的扇出量并未改变，需要客户端退避或另行决策。

**默认回环。** `RuntimeBrokerHttpServer` 拒绝非回环或未解析的绑定地址，除非部署方显式开启（`allow-non-loopback` / `QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK`)，因为该面在明文 HTTP 上没有租户级授权。

**有界强杀关停。** 被释放的非 durable worker 先 `destroy()`，经 5 秒有界宽限后 `destroyForcibly()`;`close()` 与非 durable provisioner 的 JVM 退出钩子同样如此。worker 从 spawn 起到租约签发前登记在 `starting` 集合中，从释放起到强制升级完成前再次登记——两次搬移都在 `lifecycle` 锁内完成——因此无论是 ready 握手期的退出还是宽限期内的退出，都不会遗弃 worker。

**排空式回收。** LOST 回收循环驱动有界的 100 行恢复批次直到代际排空，每次调用最多 16 趟；更大的代际回答 `runtime_broker_runtime_lost`，由下一次 reclaim 继续——因为各批次是逐批提交的。

## 延期项

凭证密钥轮换（#13202)、终态行保留作业（#13203)、InMemory/JDBC 语义对齐（#13204）拆分为跟进 issue。

## 验证

`Issue13183RegressionTest` 与 `Issue13183AdversarialTest` 以修复后的期望编码了 issue 的场景：竞态交错、卡住的续约、观测冷却、回环拒绝、楔住 worker 的升级强杀、整代际排空，另有 600 轮跨进程对撞（其中 300 轮为紧竞态、300 轮由准入先提交）与 forked-JVM 退出钩子实证。`RuntimeRecoveryContract.verifyBeginSessionRelease` 在两种仓库后端上覆盖新原语：READY 与 ACQUIRING 两种转换、快照过期时返回 null、已 RELEASING 或 RELEASED 时原样返回、`runtime_session_busy`，以及 `runtime_session_not_ready`。`packages/sdk-java/runtime-broker` 的 `mvn clean test` 与 managed-agent-server 修复邻近套件通过；`mvn checkstyle:check` 干净。
