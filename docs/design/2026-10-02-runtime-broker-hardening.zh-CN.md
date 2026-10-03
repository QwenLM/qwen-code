# Runtime Broker 加固：原子会话释放、独立续约、监听姿态

[English](2026-10-02-runtime-broker-hardening.md) | [简体中文](2026-10-02-runtime-broker-hardening.zh-CN.md)

状态：已在 `packages/sdk-java/runtime-broker` 实现（PR #13214,issue #13183)。

## 问题

一次代码审计发现 Runtime Broker 的三个高危缺陷。其一，会话释放决策与"无活跃 execution"检查分属两个事务，仅由进程内锁守护：当两个 Broker 进程共享一个数据库时，可能出现 execution 已准入而 session 被标记为 `RELEASED` 的矛盾态。其二，所有租约续约都跑在与重试、截止围栏和轮询共用的单条调度线程上，且均为同步 JDBC：存储抖动 1-2 秒就会让续约排队错过租约，把健康的 binding 围栏。其三，Broker 的 HTTP 面以明文 HTTP 服务单一全局 Bearer token，并接受非回环监听地址。

同一次变更还修掉两个成本较低的中等缺陷。忽略 SIGTERM 的已释放 worker 从不会被强制销毁，且 ready 握手期间的 JVM 退出会遗弃它。LOST 回收每个阶段也只跑一趟有界的 100 行恢复批次，因此超过一趟容量的代际会一直停在 LOST，之后每次尝试都回答 `runtime_broker_runtime_lost`。

## 决策

**单事务释放。** `RuntimeBindingRepository.beginSessionRelease` 把"无活跃 execution"检查移入 RELEASING 转换自身的事务。该转换持有 Session 行的 `FOR UPDATE` 锁——与 `admitExecution` 获取的是同一把锁——因此两条路径在跨进程场景下按会话行互斥。带活跃 execution 的释放以 `runtime_session_busy` 失败；输给 RELEASING 会话的准入以 `runtime_admission_closed` 失败。进程内预检只保留零成本的 `hasActiveControl` 判断；原先那次数据库往返被取消，因为转换自身的检查以相同的 code 和消息回答同一个 409。

**续约线程池。** 续约（binding claim 与 dispatch claim）运行在独立的双线程 `ScheduledThreadPoolExecutor`；协调工作（重试、围栏、轮询）保留单线程调度器。一次卡在 JDBC 调用里的 tick 会占用池中两个线程之一并持有该 claim 的续约监视器，因此它可能拖慢其它续约，但不再拖慢协调工作，且 `close()` 会中断两个线程池、不等待卡住的 tick。v3 结果轮询从 100ms 起指数退避、2s 封顶（该上限约束了已完成结果被取走的最大延迟），轮询所处的窗口可配置（`v3ResultWindow`，默认 30 分钟，下限 1 秒——无后缀的配置值会被解析为毫秒，构造函数现在拒绝这种值）；窗口到期后，已派发的执行被标记为 UNKNOWN 而不是无限轮询，因此它是轮询截止期，不是结果保留期。对 UNKNOWN 执行的自动观测在 1 秒冷却内复用最近一次查询结果，不再把每次轮询穿透到 worker；自身记录已不再是 UNKNOWN 的缓存查询整体回放，两侧都仍为 UNKNOWN 时取 version 更大的一方，因此绝不会把已结算的答案与过期记录拼配。显式 `reconcile=true` 与 mutation 响应（`:start`、`:cancel`）永远不走缓存。

**默认回环。** `RuntimeBrokerHttpServer` 拒绝非回环或未解析的绑定地址，除非部署方显式开启（`allow-non-loopback` / `QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK`)，因为该面在明文 HTTP 上没有租户级授权。

**有界强杀关停。** 被释放的非 durable worker 先 `destroy()`，经 5 秒有界宽限后 `destroyForcibly()`;`close()` 与非 durable provisioner 的 JVM 退出钩子同样如此。worker 从 spawn 起即登记进 `starting` 集合（在 `lifecycle` 锁下注册）,ready 握手期的退出不会再遗弃它。

**排空式回收。** LOST 回收循环驱动有界的 100 行恢复批次直到代际排空，每次调用最多 16 趟；更大的代际回答 `runtime_broker_runtime_lost`，由下一次 reclaim 继续——因为各批次是逐批提交的。

## 延期项

凭证密钥轮换（#13202)、终态行保留作业（#13203)、InMemory/JDBC 语义对齐（#13204）拆分为跟进 issue。

## 验证

`Issue13183RegressionTest` 与 `Issue13183AdversarialTest` 以修复后的期望编码了 issue 的场景：竞态交错、卡住的续约、观测冷却、回环拒绝、楔住 worker 的升级强杀、整代际排空，另有 200 轮跨进程对撞与 forked-JVM 退出钩子实证。`RuntimeRecoveryContract.verifyBeginSessionRelease` 在两种仓库后端上覆盖新原语的四种结果。`packages/sdk-java/runtime-broker` 的 `mvn clean test` 与 managed-agent-server 修复邻近套件通过；`mvn checkstyle:check` 干净。
