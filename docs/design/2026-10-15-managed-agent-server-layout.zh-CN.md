# Managed Agent Server 源码布局

[English](2026-10-15-managed-agent-server-layout.md) | [简体中文](2026-10-15-managed-agent-server-layout.zh-CN.md)

状态：已实现并完成本地验证。本次尚未运行远端 CI 或真实 MySQL/Linux 部署验收。

## 问题与现状

本次修改前，Managed Agent Server 源码位于 `packages/sdk-java/managed-agent-server`。其 Runtime Broker 作为独立 Maven 产物放在 `packages/sdk-java/runtime-broker`，而 Server 是仓库中唯一的生产调用方。开发、Docker 打包和 CI 都需要先安装 Broker 产物，再构建 Server；Server 还通过 Broker 测试 JAR 复用 repository 契约测试。

## 目标布局

将应用移至 `packages/managed-agent-server`，与 `packages/sdk-java` 并列。将 Broker 生产源码、资源、测试和夹具合入 Server 对应的源码目录。保留现有 `com.alibaba.qwen.code.runtimebroker` 和 `com.alibaba.qwen.code.managedagent` 包名。删除 Broker 独立 POM、版本属性、主依赖和测试 JAR 依赖。Server 继续依赖 `packages/sdk-java/qwencode` 中的 Java SDK。

合并后应用只有一份 POM、一套依赖图和构建输出。Broker repository 契约成为该模块内的普通测试。合并 Maven 配置时保留故障门禁 profile、覆盖率采集和既有样式检查。同时更新仓库相对路径、Docker 构建输入、开发启动器、打包、CI、工作流契约测试和文档。

## 决策与约束

- 源码归属于应用。通过独立 Java package 保留内部职责边界，无需另行发布产物。
- 保留 Java 包名、公开 API 行为、私有 HTTP 协议、Runtime 身份、租约、取消和恢复语义。
- 保留 classpath 资源名和迁移内容。本次不迁移数据库，也不改变 schema 权威来源。
- 保留默认测试排除规则以及显式 MySQL、Hosted 和故障门禁通道，不把可选外部前提变成默认单元测试要求。
- 保持 Broker 核心类不依赖 Spring，移动源码不要求在其实现中引入应用依赖。
- 运行时库使用既有 Server 依赖管理，在合并模块中保留 Broker 的 H2 和 JUnit 测试依赖版本。
- 保留既有工作流名称与触发条件，仅调整路径及过时的独立模块构建步骤。

## 范围与影响区域

本次覆盖两个 Java 源码目录、合并后的 Maven 配置与 Dockerfile、仓库脚本及测试、集成测试启动路径、GitHub 工作流和依赖配置，以及当前源码与构建文档。不改 SDK API，不新增部署拓扑，不重命名 Java 包，也不在旧路径引入兼容目录。

## 风险与验证

主要风险是相对路径仍假定需向上三级才能到达仓库根目录、Broker 资源或测试遗漏、Maven 测试选择变化、依赖版本差异，以及脚本或 CI 继续安装已删除的产物。对照原始目录核查源码和资源清单，使用 JDK 21 编译并打包合并后的应用，运行合并后的 Java 单元测试和相关脚本、工作流测试，并检查打包 JAR。执行仓库 build 和 typecheck。前提具备时运行既有故障和进程门禁，单独说明不可用的外部服务。

## 验收标准

安装 Java SDK 后，`packages/managed-agent-server/pom.xml` 可直接构建 Server 和 Broker，无需已安装的 `qwen-managed-runtime-broker` 产物。两个原有 Java package 及其全部 classpath 资源和测试均保留。构建、开发、打包和 CI 引用均使用新的应用位置。既有协议和 schema 夹具保持原样，验证报告区分本地结果与未执行的 CI 或环境专用门禁。

## 待定问题

此次迁移没有待定问题。后续出现真实复用方时，再评估提取共享库。
