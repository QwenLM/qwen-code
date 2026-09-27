# Hosted 无工具进程门禁

[English](2026-09-26-hosted-no-tool-process-gate.md) | [简体中文](2026-09-26-hosted-no-tool-process-gate.zh-CN.md)

状态：实现 #12728。

## 问题与基线

PR #12713 的 Hosted 无工具运行时曾通过 mock 测试，但打包 CLI 边界出现配置初始化失败和旧提示词重放。首次独立复验使用精确提交 `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5`，无生产补丁。#12713 合入后，本变更新基线为其在 main 上的 squash 提交 `879c311092f847e29539a9fc49dc7dbbabe0db63`，仅保留进程测试和 CI 门禁。

## 测试方案

新增聚焦集成测试，启动 `node dist/cli.js`，复用确定性 OpenAI fixture，并通过 HTTP 适配器访问仓库 Session Store 日志及资源实现。检查模型请求次数和内容、已提交文本及终态顺序、重试回执、游标重放、失败/取消 A → 成功 B → C 的历史、拒绝工具且无文件副作用、私有协议拒绝行为及 detach/close 释放 writer。

## 隔离和失败处理

每个用例拥有独立临时 home、工作区及 Store 目录、临时端口上的 loopback listener，以及受时限约束的子进程。子进程环境采用白名单，仅使用本地假凭据。包括启动超时和断言失败在内，始终终止进程、中止 SSE reader、关闭 fixture listener 并清理临时状态。失败时保留有界诊断。缺少构建前置必须明确失败，不得因缺少凭据而跳过。

## CI 与数据库切片

新增可复现 npm 入口并接入现有无 AK PR 必跑门禁，包含构建/打包前置及 workflow 守护测试。在现有 macOS/Windows lane 添加启动、绑定及清理验证。独立使用真实 Java HostedHarnessClient → 打包 CLI → Spring 私有 Store → 隔离真实 MySQL，检查数据库种类和版本以拒绝 MariaDB/H2 替代。Java/数据库与 fixture 证据分别记录。

## 文件与范围

变更仅涉及集成测试辅助程序、用例及配置、npm 脚本、CI workflow 及守护测试、Java 集成测试和本设计。不包含工具、审批、输出产物、公共控制面流程、强杀接管恢复、不确定轮次重放、多实例故障转移或生产认证。不调用付费模型。

## 验证与验收

记录精确 SHA、平台、命令、结果及遗漏项。分别恢复配置初始化和旧历史缺陷，证明对应进程回归会失败。执行构建、类型检查、聚焦测试及 workflow 守护测试，再做无方向审计和反向证据核验，直到连续两轮干净。远端 CI 必须实际运行才能作为证据；跳过或未运行不计通过。

## 复现入口与已记录证据

使用 `corepack pnpm install --frozen-lockfile` 安装（prepare 会构建并打包），或在工作树依赖准备后执行 `npm run build && npm run bundle`。测试入口为 `npm run test:integration:hosted:sandbox:none`；可移植子集为 `npm run test:integration:hosted:sandbox:none -- -t 'portable startup'`。

数据库切片先安装 `qwencode` 和 `runtime-broker` Maven 模块，再使用 Java 21 和 Node 22 执行 `mvn -f packages/sdk-java/managed-agent-server/pom.xml -Phosted-harness-mysql -Dit.test=HostedHarnessMySqlIT -Dqwen.cli.entry=<absolute-path-to-dist/cli.js> -Dmysql.url=<isolated-MySQL-JDBC-URL> -Dmysql.user=<user> -Dmysql.password=<password> verify checkstyle:check`。缺少前置或测试时该 profile 必须失败。现有 MariaDB profile 排除此测试；新增 CI 作业提供临时 `mysql:8.4.6` service。

2026-09-26，在 macOS 26.5.1 arm64 / Node 22.22.2 上，针对生产提交 `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5` 独立跑通全部 7 项 fixture 进程测试，无生产源码改动。从打包后的模型函数移除 `lenientToolWarmup: true` 会恢复原初始化缺陷：新会话测试失败，模型请求为 0，错误为 `SkillManager not available`。恢复旧 `setHistory(history)` 后，失败/取消两项历史测试均因 B 包含 A 而失败。恢复并重新打包后再次通过，全部 1303 个 bundle 文件与基线校验值相同。

独立 Java 21 / Spring 私有 Store / 打包 CLI 测试已在隔离的 Oracle MySQL **8.4.6, MySQL Community Server - GPL** 上通过，实际执行 1 项集成测试，跳过 0 项。覆盖创建、close/load、Prompt 回执重试、SSE 重连、显式取消及后续历史、detach/load、持久化 writer 代数。临时数据库进程已停止，数据目录已删除。这是 macOS 的实测证据，与本地 JSONL fixture 证据分别记录。

变基到 main `879c311092f847e29539a9fc49dc7dbbabe0db63` 后，完整构建、打包及类型检查再次通过。聚焦配置及标准无 AK 配置均通过全部 7 项进程测试，跳过 0 项。重新安装该版本的 Java 依赖后，在隔离 MySQL 8.4.6 上通过 1 项集成测试和 86 项 Java 单测，均跳过 0 项；Checkstyle 和资源清理检查也通过。

## 待完成证据

前置 PR 已合入，本 PR 现以 main 为目标。远端 CI 验收仍需最终 workflow 版本的成功运行。本地尚未验证 Linux、Windows；现有 macOS/Windows CI lane 在 merge-group、定时或手动触发时运行，不在普通 PR 上运行。无 AK PR 必跑作业包含全部进程用例。强杀接管恢复及生产就绪仍不在本次验证范围内。
