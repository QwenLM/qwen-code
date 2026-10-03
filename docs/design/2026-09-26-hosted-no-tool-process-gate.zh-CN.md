# Hosted 无工具进程门禁

[English](2026-09-26-hosted-no-tool-process-gate.md) | [简体中文](2026-09-26-hosted-no-tool-process-gate.zh-CN.md)

状态：已由 #12733 及其审查后续实现 #12728。该审查后续延后的事项已在 #12823 下实现；完整套件在自托管 Windows 上的首次运行尚待记录。

## 问题与基线

PR #12713 的 Hosted 无工具运行时曾通过 mock 测试，但打包 CLI 边界出现配置初始化失败和旧提示词重放。首次独立复验使用精确提交 `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5`，无生产补丁。#12713 合入后，本变更新基线为其在 main 上的 squash 提交 `879c311092f847e29539a9fc49dc7dbbabe0db63`，仅保留进程测试和 CI 门禁。

## 测试方案

新增聚焦集成测试，启动 `node dist/cli.js`，复用确定性 OpenAI fixture，并通过 HTTP 适配器访问仓库 Session Store 日志及资源实现。检查模型请求次数和内容、已提交文本及终态顺序、重试回执、游标重放、失败/取消/空回答 A → 成功 B → C 的历史、拒绝工具且无文件副作用、私有协议拒绝行为及 detach/close 释放 writer。空回答 A 指仅含思考内容的回复：轮次正常完成但没有回答文本，其提示词与未回答的提示词一样被省略。私有协议探测覆盖普通 profile daemon 对同一 token 会正常响应的路由（带认证与不带认证）、位于 Hosted 路由共用的 `/session/` 前缀下的普通 shell 路由、无认证的 `/health`，以及声明其他 writer 的 Store 连接。

## 隔离和失败处理

每个用例拥有独立临时 home、工作区及 Store 目录、临时端口上的 loopback listener，以及受时限约束的子进程。临时根目录使用 `qwen-e2e-home-` 前缀，被中途拆除的 worker 遗留的目录可由集成测试清扫器回收。只要集成运行自己拥有临时 home（即未设置 `QWEN_HOME`），就会执行清扫，扫描该运行的临时目录。必需的无 AK lane 固定了 `QWEN_HOME`，聚焦配置没有 global setup，因此两者都不清扫。经 `run-e2e-tests.sh` 运行的各 Linux E2E leg 只清扫该脚本为每次运行新建的私有临时目录，其中没有早先留下的目录；`cli` 路径过滤 lane 和 macOS E2E leg 使用默认临时目录，会回收这些目录。子进程环境采用白名单，仅使用本地假凭据；调用方的 `HOME` 或 `QWEN_HOME` 进入子进程，或调用方环境被整体传入时，用例失败。`qwen serve` 的 listening banner 匹配和清理序列（SIGTERM，5 秒后 SIGKILL）位于与 daemon 测试 harness 共用的模块中，该模块不导入 SDK 和 core。包括启动超时和断言失败在内，始终终止进程、中止 SSE reader、关闭 fixture listener 并清理临时状态。失败时保留有界诊断，teardown 在所有配置下使用同一显式 hook 时限。缺少构建前置必须明确失败，不得因缺少凭据而跳过。

## CI 与数据库切片

新增可复现 npm 入口并接入现有无 AK PR 必跑门禁，包含构建/打包前置及 workflow 守护测试。现有 macOS lane 运行启动、绑定及清理子集，现有 Windows lane 在单测之后运行完整套件，任何用例被跳过即失败，因为没有其他 Windows lane 运行这些用例。独立使用真实 Java HostedHarnessClient → 打包 CLI → Spring 私有 Store → 隔离真实 MySQL，检查数据库种类和版本以拒绝 MariaDB/H2 替代。Java/数据库与 fixture 证据分别记录。

该测试文件也会被 `cli` 路径过滤 lane（merge group 与发布）和 E2E 完整套件 leg 以默认配置收集，describe 级超时和重试设置在那里同样生效。`managed-agent-server` 的 profile 按测试族分流集成测试：`Hosted*IT` 只在 MySQL 作业中运行，该作业按 profile 选择测试而非 `-Dit.test`；其余 `*IT` 留在 MariaDB 作业。`runtime-broker` 没有 Hosted 族，放在那里的 `Hosted*IT` 会让 MariaDB 检查失败。profile 的 `<includes>`，或 `MAVEN_ARGS`、`.mvn/maven.config` 中的 `-Dit.test` 收窄这一选择时 Maven 仍会通过，因此每个作业在测试后把 failsafe 报告与源码树比对：本族每个 `*IT` 类都必须至少执行一项测试，其他测试类都不得执行。failsafe 还会把 Maven 的用户属性记录在报告中，因此在命令行、`MAVEN_ARGS` 或 `.mvn/maven.config` 中传入 `-Dit.test`、`-Dfailsafe.includesFile` 或 `-Dfailsafe.excludesFile` 的运行会让检查失败，缺少属性的报告也会让检查失败。workflow 守护拒绝在 workflow 和 POM 中出现这些选择方式以及 `<test>` 元素。MariaDB 作业检查 `runtime-broker` 和 `managed-agent-server`，MySQL 作业检查 `managed-agent-server`。检查脚本或任何 `.mvn` 目录改动时 workflow 也会运行，因为 Maven 从构建目录向上最近的 `.mvn` 目录读取配置。SDK Java workflow 还会因 `packages/cli/src/config/**`、`packages/core/src/config/**` 和 `packages/core/src/core/**` 触发，因为 Hosted 运行时会加载这些代码。以 2026-08-27 至 2026-09-26 的 main 提交回放，触发率由约 32% 升至 42%，每次运行都会多跑 MySQL 作业。

## 文件与范围

变更仅涉及集成测试辅助程序、用例及配置、npm 脚本、CI workflow 及其守护测试和报告检查、Java 集成测试及其 Maven 测试选择，以及本设计。不包含工具、审批、输出产物、公共控制面流程、强杀接管恢复、不确定轮次重放、多实例故障转移或生产认证。不调用付费模型。

## 验证与验收

记录精确 SHA、平台、命令、结果及遗漏项。分别恢复配置初始化和旧历史缺陷，证明对应进程回归会失败。执行构建、类型检查、聚焦测试及 workflow 守护测试，再做无方向审计和反向证据核验，直到连续两轮干净。远端 CI 必须实际运行才能作为证据；跳过或未运行不计通过。

## 复现入口与已记录证据

使用 `corepack pnpm install --frozen-lockfile` 安装（prepare 会构建并打包），或在工作树依赖准备后执行 `npm run build && npm run bundle`。测试入口为 `npm run test:integration:hosted:sandbox:none`；macOS lane 运行的可移植子集为 `npm run test:integration:hosted:sandbox:none -- -t 'portable startup'`。

数据库切片先安装 `qwencode` 和 `runtime-broker` Maven 模块，再使用 Java 21 和 Node 22 执行 `mvn -f packages/sdk-java/managed-agent-server/pom.xml -Phosted-harness-mysql -Dqwen.cli.entry=<absolute-path-to-dist/cli.js> -Dmysql.url=<isolated-MySQL-JDBC-URL> -Dmysql.user=<user> -Dmysql.password=<password> clean verify checkstyle:check`。缺少前置或测试时该 profile 必须失败。现有 MariaDB profile 排除 `Hosted*IT`；新增 CI 作业提供临时 `mysql:8.4.6` service。随后 `node scripts/check-failsafe-reports.js hosted packages/sdk-java/managed-agent-server` 把报告与源码树比对；MariaDB 作业以 `non-hosted packages/sdk-java/runtime-broker packages/sdk-java/managed-agent-server` 运行它。

2026-09-26，在 macOS 26.5.1 arm64 / Node 22.22.2 上，针对生产提交 `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5` 独立跑通全部 7 项 fixture 进程测试，无生产源码改动。从打包后的模型函数移除 `lenientToolWarmup: true` 会恢复原初始化缺陷：新会话测试失败，模型请求为 0，错误为 `SkillManager not available`。恢复旧 `setHistory(history)` 后，失败/取消两项历史测试均因 B 包含 A 而失败。恢复并重新打包后再次通过，全部 1303 个 bundle 文件与基线校验值相同。

独立 Java 21 / Spring 私有 Store / 打包 CLI 测试已在隔离的 Oracle MySQL **8.4.6, MySQL Community Server - GPL** 上通过，实际执行 1 项集成测试，跳过 0 项。覆盖创建、close/load、Prompt 回执重试、SSE 重连、显式取消及后续历史、detach/load、持久化 writer 代数。临时数据库进程已停止，数据目录已删除。这是 macOS 的实测证据，与本地 JSONL fixture 证据分别记录。

变基到 main `879c311092f847e29539a9fc49dc7dbbabe0db63` 后，完整构建、打包及类型检查再次通过。聚焦配置及标准无 AK 配置均通过全部 7 项进程测试，跳过 0 项。重新安装该版本的 Java 依赖后，在隔离 MySQL 8.4.6 上通过 1 项集成测试和 86 项 Java 单测，均跳过 0 项；Checkstyle 和资源清理检查也通过。

#12733 最终 head `fe524758a0bd4bf03d5a8582530b239654f06aa4` 的远端 CI 实际执行了必需的无 AK 门禁（206 项通过，含 7 项 Hosted 用例，跳过 0 项）和 MySQL 8.4.6 作业（86 项单测、1 项集成测试）。合入后，`d6f414190a` 上的定时运行 36265809340 在 macOS 和自托管 Windows 上执行了可移植 smoke，各为 2 项通过、5 项被过滤；此后 main 上的 SDK Java push 运行中 MySQL 作业均通过。

审查后续在 Debian 13 x86_64 / Node 22.22.2、main `663d98eac5` 上验证。全部 8 项进程用例通过。在 bundle 中分别去掉任一道 Hosted 路由闸门、全部三处强制 `/health` 认证、Store writer 校验或空回答过滤，都只让对应用例失败，而原先 7 项的套件对这些变异全部放行。原始配置缺陷和历史缺陷仍使对应用例失败；恢复后全部 1316 个 bundle 文件与基线一致。Java 21.0.10 在不带 `-Dit.test` 的情况下以 Hosted profile 连接 docker `mysql:8.4`（8.4.11）运行：95 项单测和 1 项集成测试通过，跳过 0 项。MariaDB 10.11.18 profile 只运行 `ManagedAgentMySqlIT`。临时 `HostedZzzProbeIT` 只在 MySQL 作业中运行；使用旧 POM 时它会在 MariaDB 作业中运行，且不出现在 Hosted 作业中。

#12823 后续在 Debian 13 x86_64 / Node 22.22.2 / Java 21.0.10、main `848cf5e6c4` 上验证，按步骤重放两个 Java 作业，数据库为 docker MariaDB 10.11.18 和 MySQL 8.4.11。两项报告检查都通过，并列出实际执行的测试：MariaDB 作业中是 `JdbcRuntimeBrokerMySqlIT`（2 项）和 `ManagedAgentMySqlIT`（10 项），MySQL 作业中是 `HostedHarnessMySqlIT`（1 项）。临时加入的 `ZzzProbeIT` 和 `HostedZzzProbeIT` 各自只在本族作业中执行。以下每种情况都让 Maven 保持通过，而作业的检查失败并列出未执行的类：在任一 profile 中加入收窄的 `<includes>`，包括在没有 `failIfNoTests` 的 MariaDB profile 中一项都不选；在任一作业的 `MAVEN_ARGS` 中传入 `-Dit.test`；在模块的 `.mvn/maven.config` 中写入 `-Dit.test`。检查还会列出 `-Dit.test` 的值，仅凭这一点，只保留 `ManagedAgentMySqlIT` 10 项测试中一项的方法过滤也会失败。通过 `-Dfailsafe.includesFile` 选中同一个方法，或加上 `-DenablePropertiesElement=false` 使报告不记录属性，同样会失败。failsafe 在 MariaDB 作业中运行的单测类会被判为族外的类而失败。在 MySQL 作业中用 `-Dit.test=*MySqlIT` 放宽选择时 Maven 同样通过，因为 `ManagedAgentMySqlIT` 在 MySQL 8.4 上也能通过；检查将它判为 Hosted 族以外的测试类而失败。Hosted 套件全部 9 项用例通过。必需的无 AK 配置中使用任一 daemon 辅助程序的文件全部通过，其余无需模型凭据的 daemon harness 套件（两个 live journal 恢复套件和两个 mem0 daemon 套件）也全部通过。该配置唯一的失败是 `qwen-serve-streaming.test.ts` 的子进程崩溃用例，它在基线上以同样方式失败：该用例在子进程命令行中查找 `qwen`，而 worktree 路径中没有。把调用方环境合并进子进程，或去掉子进程的 `HOME` 或 `QWEN_HOME`，都会让新增的环境用例失败。

## 限制

- Windows lane 运行完整套件；macOS lane 只运行可移植子集，因为 macOS E2E 完整套件 leg 已在 push 和 nightly 时运行整个文件。#12823 之前，基于 fixture 的用例在 Windows 上只在 GitHub 托管的 `windows-2022` runner 上运行过：#12718 让目录同步在 Windows 上可容忍失败后，当时的 7 项用例通过（见 #12733 第二轮验证记录）。
- macOS 和 Windows lane 在 merge group、定时或手动触发时运行，不在普通 PR 上运行。
- Java 报告检查按类进行。在类内部，它依赖报告记录的 Maven 用户属性，因此为每个类保留一项测试的收窄若以 JVM 选项的形式出现，例如写在 `.mvn/jvm.config` 中或 workflow 之外设置的 `MAVEN_OPTS` 中的 `-Dit.test`，仍能通过检查。
- 缺少 finish reason 的模型流会先被 core 以 `NO_FINISH_REASON` 拒绝，重试退避约 20 秒，Hosted 守卫看不到它。进程门禁不包含该场景。
- 强杀接管恢复、不确定轮次重放、多实例故障转移及生产就绪不在本门禁范围内，见 #12740。
