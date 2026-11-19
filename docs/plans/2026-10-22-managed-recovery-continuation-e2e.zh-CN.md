# Managed 恢复收敛与继续使用 E2E 计划

[English](2026-10-22-managed-recovery-continuation-e2e.md) | [简体中文](2026-10-22-managed-recovery-continuation-e2e.zh-CN.md)

## 范围与基线

本计划验证[恢复设计](../design/2026-10-22-managed-recovery-continuation.zh-CN.md)（[English](../design/2026-10-22-managed-recovery-continuation.md)），覆盖 Hosted Workspace 失败取消、原输入结算、清理和后续使用，以及 WebShell 恢复与可编辑文字交接。跨主机 HA、完整历史克隆和新增 MCP/Hook 续跑不属于本次交付。

实施前记录 `qwen --version`，先用全局 CLI 在隔离运行目录尝试相关行为。Java 协调器属于独立控制平面：全局入口无法触达时，应记录限制，并在准确的基准提交上使用聚焦 Java/Hosted 测试替代。首次调查基于 `21337f0e5131`；修改实现前保留失败断言。不得构建新二进制并用它替代基线。

## 隔离前提

使用 JDK 21、Maven 3.8.9+、Node 22+、仓库固定的包管理器和可丢弃的 MySQL 8.4。任务使用独立运行目录、数据库、端口和 Maven 仓库，不改动现有部署。将当前 Java SDK 安装到该仓库。在 Java 原生一致性测试前构建 Core/CLI，在进程测试前打包当前 CLI。根 build、bundle、typecheck 应串行执行，避免读取尚未完整替换的 `dist`。

MySQL 必须开启 `performance_schema`。并发检查前，使用真实阻塞事务确认 `sys.innodb_lock_waits` 和 `performance_schema.data_lock_waits` 能观察等待锁；仅验证版本、登录和隔离级别不足以证明这一前提。完整测试失败时保留失败结果，修正隔离 fixture 后完整重跑，不得弱化断言。

正向 `recovery-settlement` fixture 保持独立 Broker 进程及其原 worker 存活，仅杀死 Java 协调器。两者使用真实 JDBC 权限和 Workspace mount；协调器通过仅作用于本实例的测试接线关闭可选本地预热，原生 acquire 和工具执行仍走常驻 Broker。断言 Broker 和同一 worker 始终存活，协调器没有创建替代 worker。持久 worker 的私有运行状态位于 Workspace 根目录之外，可信整机重启恢复始终关闭。内嵌 Broker 自身丢失后的恢复属于另一个仅限 Linux 的边界，需要既有可信重启授权；缺少授权时保留 marker 并保持受阻属于预期负向结果。

记录工具版本、提交、所选测试、数据库引擎和进程身份。凭据和机器路径保留在被忽略的工作产物中。本次详细报告位于 `.qwen/e2e-tests/managed-recovery-continuation.md`；提交的计划不代表所有场景已经通过。

## 行为矩阵

| 分组           | 操作                                                                                            | 必须观察到的结果                                                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 取消受理       | 可能已提交后的恢复拒绝、协议错误和重试耗尽；取消 ACK 后原生输入仍运行                           | 取消前已持久化仅取消意图；Java 保留驱动，输入保持受阻。没有 takeover 工作的存活 attachment 仍收到取消。                                                                                                                                                       |
| 协调器崩溃     | 在真实 Workspace 工具仍执行时，确认 marker 和原生取消受理后杀死 Java，再重启协调器              | 只核验、取消原身份；不重新提交输入、不 continue、不调用模型或再次调度工具。结算后原 Session 能完成下一轮。                                                                                                                                                    |
| 原生结果与清理 | 已提交终态、Java 丢失 admission 响应、提交一个 delta 后尾部读取失败，以及结果/终态/清理崩溃窗口 | 只补投影一次真实未消费正文和终态，保留 cursor。读取失败停泊。清理欠账保持可见并阻挡准入，不丢弃已确认正文。                                                                                                                                                   |
| 初始状态       | 首个检查点前安全取消；空 Session 改名并重新打开后发送首条输入                                   | 合法初始状态允许首轮或下一轮。缺失、损坏的 journal、checkpoint、资源或身份均不能证明就绪。                                                                                                                                                                    |
| 竞态与 fencing | 自然完成、用户取消、失败恢复、两个标签页、旧 owner/generation 和迟到原生取消                    | 已确认终态优先；复查保留预算和原身份。后续模型活跃时重放捕获的原取消请求，后续 Turn 必须正常完成；后续输入停泊时重放旧取消接管加载，后续输入必须保持不变；缺少 `targeted-cancel/1` 时在任何有副作用的加载或发送前拒绝，旧请求不能修改后续 Turn 或释放新资源。 |
| API 与兼容     | 读取/复查授权、其他租户/Turn、冷 attachment、旧 Harness 和证据读取失败                          | GET 不加载、不执行、不解锁。复查只唤醒已有目标工作并合并重复请求。202 只代表安排。证据不足继续受阻。                                                                                                                                                          |
| 浏览器恢复     | 取消期间刷新、断网、可见性变化、终态 SSE 和后续 Turn                                            | 保留同一个幂等 key/operation。仅可见时每五秒轮询未完成恢复。终态证据刷新准入；旧 operation 不能取消后续 Turn。                                                                                                                                                |
| 文字交接       | 同时含已完成和部分历史的受阻 Session、失权默认值、原 Workspace 与服务端默认值不同               | 打开既有创建界面，预选仍有权限的原 Workspace/cwd/Agent，并提供可编辑引用草稿；不自动创建、发送。遵守 32 KiB UTF-8，保留完整已确认用户/助手消息，明确未知和截断，排除工具输出、部分正文、审批和执行身份，保留 Workspace 准入。                                 |

协调器崩溃用例保留原 A 的完整取消请求，结清 A，再将同一 Session 的下一轮 B 保持在活跃模型调用中。放行 B 前重放 A：请求须仍指向 A 并幂等返回，B 能完成且输出 `FOLLOW_UP_OK`。直到结束都要验证原工具只执行一次、binding generation 保持 1。聚焦协议测试另行覆盖迟到的取消接管加载，以及任何有副作用请求之前的能力拒绝。已有排队唤醒输入时，对唯一停泊普通输入的常驻和冷加载取消仍须有效；在该 fixture 中隔离独立唤醒 pump，验证取消链本身不操作排队工作。覆盖 A 已终结、B 持有恢复 Runtime 时的 managed-runtime cancel/continue 成功重放：B 必须继续持有且不被释放，重放仍能重试原 A 自身的清理。

初始状态负例应通过现有授权 commit 路径创建全新的完整 genesis，资源引用、字节数和摘要均匹配，但 managed-definition JSON 不可读。此时必须保持受阻，不直接修改已存资源，也不弱化完整性校验。继续使用真实 Core 生成并冷态重新打开的合法 fixture 作为正向对照。

对已终结的 Java Turn，分别在状态读取与清理变更时触发 Harness generation 变化。发现变化的 POST 必须返回身份变化、仅逐出过期 connector 身份，使后续显式重新检查可以协商仅清理恢复；GET 不协商、不加载。将冷清理加载暂停在 generation 接纳及 attachment 发布前后：迟到旧 ref 既不能重植过期缓存，也不能覆盖更新的赢家。attachment 解析或授权期间替换 client 后，接下来的状态／清理 RPC 不得继续使用旧 client。

持有关系断言须遵守基线的真实协议。普通 LOCAL claim 使用共享 Storage 成员，即使 Runtime binding 仍按 Session 隔离。独占 owner 行处于中性状态时，须严格证明唯一原成员、tenant／Session／Workspace 作用域、能力／profile、就绪 binding 与 mount、匹配的物理 Storage、不变代际及 `execution_exclusive=false`；独占 claim 保留原 owner 完整断言。不得仅接受 nullable owner，也不得放宽执行身份、派发次数、故障信号、journal 或单次副作用断言。

## 可复用命令

从各自包目录执行测试。在 `packages/cli` 运行原生状态测试及 `src/serve/hosted-harness-session.test.ts` 中所选恢复清理用例，记录 selector 与未执行数量。在 `packages/web-shell` 运行受影响的 provider、Session/recovery/cancel hooks、Session 页面、Workspace 创建和交接测试。浏览器 fixture 应通过真实 Chromium 验证准入、刷新后 operation 跟踪和可编辑交接，并注明 HTTP adapter 是受控替代。

同时覆盖未启用 durable operations 的取消：A 已收到投递 ACK 后不能阻挡用户明确停止后续 B；A 失败且仍缺匹配 ready 证明时继续显示未确认。丢回复保留原 key 和 Turn，过期或其他 Session 的响应不能退休投递跟踪。退休已确认投递槽不表示 A 已取消，也不改变恢复发送门禁。

在仓库根目录依次准备最终产物：

```bash
npm run build
npm run bundle
npm run typecheck
```

在 `packages/managed-agent-server` 使用任务环境变量指定当前 Node/CLI 的绝对路径、Maven 仓库和可丢弃数据库凭据：

```bash
managed_verify() {
  mvn --batch-mode --no-transfer-progress \
    "-Dmaven.repo.local=$QWEN_TEST_MAVEN_REPOSITORY" \
    "-Dnode.executable=$QWEN_TEST_NODE" \
    "-Dqwen.cli.entry=$QWEN_TEST_CLI" \
    "-Dmysql.url=$QWEN_TEST_MYSQL_URL" \
    "-Dmysql.user=$QWEN_TEST_MYSQL_USER" \
    "-Dmysql.password=$QWEN_TEST_MYSQL_PASSWORD" "$@"
}

managed_verify '-Dtest=RecoverySettlementTest,RecoverySettlementStoreTest,HarnessCoordinatorTest,AdmittedTurnRetryTerminalStateTest,SessionRecoveryServiceTest,SessionRecoveryInitialStateTest,ManagedAgentApiContractTest,SurfaceRegistryGateTest' test

managed_verify -Phosted-harness-mysql -Dit.test=HostedProcessCrashIT \
  -Dqwen.fg6c.case=recovery-settlement verify

managed_verify -Pmysql-integration clean verify

managed_verify -Phosted-harness-mysql -Dit.test=HostedProcessCrashIT verify

managed_verify -Phosted-harness-gates -Dit.test=HostedRecoveryWedgeGate verify
```

组合的 `mysql-integration` 验证包含完整 unit/H2、真实 MySQL 集成测试、Checkstyle 和 SpotBugs。在 `clean` 前保存烟测证据。Hosted profile 按既有配置跳过重复单测，仍执行所选进程用例。其数据库隔离会在顶层 Hosted 测试类之间清空 managed 表，因此数据库必须由本次调用独占。同一次变更应从 OpenAPI 重新生成公开前端类型，并验证受影响的 Java SDK 和 SurfaceRegistry 契约。

## 证据边界

完整 `HostedProcessCrashIT` 命令不得传入 `qwen.fg6c.case`。两个 JUnit 方法包含九个实际窗口：Harness prepare/start/unknown/result、Spring SIGKILL、worker SIGKILL/SIGSTOP、取消受理后重启并在后续轮次重放迟到原取消，以及仅协调器重启后的驻留接回。选择单个烟测时，另一个方法直接返回，不能当作额外进程验收。应保留真实信号、工具/模型/提交次数、放行前原生活跃状态、原生终态投影及后续完成正文。

通用 Store H2/MySQL fixture 验证 marker/lease/cursor/终态 SQL，不能单独证明 Workspace 集成。非空 Workspace 协调器 fixture 和真实 Workspace 进程用例验证该边界。真实浏览器加受控 HTTP adapter 证明 UI 行为，不证明后端恢复；确定性模型加真实 Java/Harness/Broker/worker 进程证明所测执行协议，不证明真实模型质量。

恢复读取不得加载、获取新的执行授权、执行或解锁。既有资源读取可能续租已持有的 writer lease，或更新校验元数据；不能把这一执行边界表述为零 SQL/HTTP 写入。

`HostedRecoveryWedgeGate` 验证受阻 Session 是否拖住其他 Session，但明确依赖 Linux 物理 Workspace 存储。`HostedShellLifecycleRecoveryIT` 和 `HostedExtensionsIT` 只支持 Linux；扩展验收还需要 delegated cgroup v2 子树。应记录 macOS 跳过或不可用项，保留 Linux 后续命令，不能将跳过作为恢复证据。不得伪装 OS 或弱化门禁以获得绿色结果。

## 验收与报告

已安全结算的 Session 必须展示已确认正文，并在不重复副作用的前提下完成下一轮。无法取得可信证明的 Session 必须保持受阻，并能准备可编辑交接草稿，不绕过准入或自动创建工作。

分别报告基线复现、聚焦检查、完整 Maven/MySQL 结果、每个实际进程窗口和浏览器结果。记录失败及其解决、主动中断、未选中的测试和平台限制。准确本地命令与日志留在被忽略的报告中，不将重叠重跑相加为独立测试数量。中英文计划与设计保持完整同步并互链。

2026-10-22 的最终执行已完成当前 macOS 可用范围：根目录 build/bundle/typecheck、754 项 CLI 测试、479 项 WebShell 测试及 3 项受控 adapter 的 Chromium 场景；SDK verify（403 项测试、9 项配置性跳过）；完整单测/H2（5,280 项测试、18 项已记录的条件性跳过）；真实 MySQL 8.4（1,067 项测试、无跳过）；不带场景选择器的完整 Hosted 类（两个 JUnit 方法、全部 9 个故障窗口、无跳过）。这些最终运行均无失败或错误，Checkstyle 与服务端 SpotBugs 检查通过。Linux 物理 Workspace 门禁已执行，其中 1 项因 macOS 平台跳过；Linux 生命周期、扩展及 delegated cgroup 验收仍未验证。[设计文档](../design/2026-10-22-managed-recovery-continuation.zh-CN.md)和忽略的执行报告记录证据及边界；此前失败或中断的运行均单独保留。
