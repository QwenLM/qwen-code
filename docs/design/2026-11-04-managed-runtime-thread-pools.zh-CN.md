# Managed Runtime 线程池限额

[English](2026-11-04-managed-runtime-thread-pools.md) | [简体中文](2026-11-04-managed-runtime-thread-pools.zh-CN.md)

## 问题与范围

11 月 4 日的 Java 规约审计发现，私有 Broker HTTP 服务和本地 Runtime provisioner
使用无界 cached 平台线程池。每个非持久化本地 worker 还手动启动一个 stdout
读取线程。慢请求或 worker 握手集中到来时，平台线程数量因此可能无限增长。
让读取任务共用启动线程池则可能造成握手死锁，或停止消费存活 worker 的输出。

本次治理这两个线程池和本地 stdout 读取线程。不改变数据库 schema、API schema、
认证、worker 身份、持久化恢复或租约续期。虚拟线程命名和其他审计发现由单独的
规约清理处理。定时续期队列仍遵循现有生命周期；本次不声称限制服务中的全部任务，
也不声称限制全部尚未完成的异步 HTTP exchange。

## 设计

使用组件拥有的 JDK 执行器，显式配置具名 daemon 线程和 `AbortPolicy`。
限额作为内部常量；没有运行证据时不增加公共配置。

| 任务                                               | 最大线程数 | 队列                     | 饱和处理                                                    |
| -------------------------------------------------- | ---------: | ------------------------ | ----------------------------------------------------------- |
| Broker HTTP 分发                                   |         32 | 64 个请求                | JDK 在进入 handler 前关闭连接                               |
| 本地启动、注册、reconcile、confirm 和 drained stop |         16 | 无（`SynchronousQueue`） | 返回失败 stage，错误为可重试的 `503 runtime_local_capacity` |
| 非持久化 worker stdout                             |         64 | 无（`SynchronousQueue`） | 在启动进程前拒绝                                            |
| 非持久化 worker 停止升级                           |          4 | 无（`SynchronousQueue`） | 立即强制停止已经释放的进程                                  |

这些是资源安全上限，不是经过负载验证的生产容量建议。本地线程池在空闲 60 秒后
释放线程。操作不在执行器队列中等待，因此关闭时不会丢弃排队操作而使其 completion
stage 永不完成。provisioner SPI 的拒绝仍通过异步失败返回。

启动 worker 前先提交读取任务以预留 reader。读取任务等待进程引用，读取有大小限制的
ready 记录，然后持续消费 stdout 至 EOF。若启动在创建进程前失败，则取消该引用以释放
reader。因此 reader 饱和不会启动无人观察的子进程，也不会把准入拒绝转换成
managed-context 恢复失败。reader 不消耗启动或停止任务的容量。

Broker 通过 provider kind、状态码、错误码、可重试标志和进程内
`RejectedExecutionException` cause 识别本地准入拒绝，保留原 PROVISIONING Binding
和 seed，不封锁恢复。本轮新保存的非持久化占位 handle 通过当前 claim 的
compare-and-set 栅栏清除；真实持久化 handle 保持不变。这样下一次可用相同身份重试，
而已经启动的任务仍保留原失败处理。worker 或传输错误即使返回相同字符串错误码，
也没有本地拒绝 cause，因此不适用这一恢复封锁例外。

release 保持立即返回。停止升级使用独立容量，避免启动池饱和无限延迟 SIGKILL。
停止池已满或已关闭时立即强制停止。关闭时先终止非持久化子进程，再关闭三个执行器。
持久化 worker 保持原有重启和恢复所有权语义，继续在 provisioner 关闭后存活。

HTTP 池覆盖全部已注册 context，包括 CSI native readback 和原 Session authority
路由。保留 `server.stop(0)`、关闭执行器、关闭 service 的顺序。JDK 21 在执行器拒绝
提交时关闭连接；此时尚无 `HttpExchange` 可用于生成 JSON 503。拒绝的工作不在 HTTP
dispatcher 上运行。客户端继续按各路由已有逻辑处理传输故障，本次不增加全量自动重试。
handler 可能在异步操作完成前返回，因此这个池限制分发线程和排队分发数，不限制全部
正在进行的业务操作。

## 实现与调用方

修改 `runtime-local` 的 `LocalProcessRuntimeProvisioner`、`RuntimeBrokerService`
的准入失败处理和 `server` 的 `RuntimeBrokerHttpServer`，在 `verification` 中增加
聚焦测试。HTTP 调用方为
`EmbeddedRuntimeBroker` 和 `WorkspaceCsiRuntimeMain`，构造和所有权契约保持不变。
本地 provisioner 由 Broker Binding 启动、reconcile 及 Workspace drained stop
调用，继续使用现有完成及失败契约。

## 验证与验收

1. 建立当前无界线程池基线。全局 CLI 不承载 Java 执行器，因此使用 Java 测试脚本
   fallback 验证其行为。
2. 填满 HTTP 线程和队列，观察连接失败；释放阻塞 handler 后验证排队和后续请求
   仍能完成，并检查线程命名、关闭和认证回归。
3. 填满本地操作和 reader 容量，验证及时返回失败 stage、reader 拒绝时不启动子进程、
   关闭后没有悬挂的 completion，以及容量释放后可成功重试。
4. 验证 ready 后持续消费 stdout、启动饱和时仍能 release、强制停止忽略 SIGTERM 的
   子进程，以及 close 的清理行为。
5. 运行已有 HTTP、本地进程、持久化恢复和停止聚焦测试及 Checkstyle。在模块共用的
   十分钟本地验证预算内选取受影响的真实 MySQL 集成路径。完整 Maven、SpotBugs、
   MySQL 和 Hosted/fault 门禁保留在 CI；不可用路径标记为待验证，不用 H2 或 fixture
   测试替代其证据。

聚焦本地测试不代表生产吞吐、全部平台或完整 Hosted 验收。进一步调参需要真实负载证据。
