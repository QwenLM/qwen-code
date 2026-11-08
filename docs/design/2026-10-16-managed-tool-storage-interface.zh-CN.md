# Managed 工具存储接口

[English](2026-10-16-managed-tool-storage-interface.md) | [简体中文](2026-10-16-managed-tool-storage-interface.zh-CN.md)

状态：已实现，macOS 本地存储检查通过。当前基线的完整验证存在已独立复现的 main 错误。部署资格验证仍需单独进行。

## 问题与原有实现

本次修改前，Managed 工具发布已经向发布、保留、回收和恢复读取路径注入 `ToolPublicationObjectStore`。但 Spring 配置总会创建阿里云 OSS 客户端，API 和异步校验路径直接判断 `OSSException`，接口还通过 `requireUnversioned()` 暴露 bucket 版本检查。应用提供其他实现时，仍需配置或覆盖 OSS 基础设施。

## 目标与范围

让现有字节存储接口可以替换，同时保留阿里云 OSS 作为默认实现。保持发布授权、字节不可变、配额、校验、恢复、垃圾回收、公开响应及默认关闭设置。SQL 继续作为发布身份、操作和归属的权威来源；对象存储负责保存字节。

本次不实现 S3、MinIO 或生产文件系统后端，不增加后端路由，不搬迁 Workspace 文件，不修改公开 API，也不迁移已有对象。服务仍打包 OSS SDK。替换实现通过应用集成 Spring `@Bean` 完成，不提供运行时插件安装器。

## 方案

### 存储契约

保留 `ToolPublicationObjectStore` 及现有创建、读取和删除操作。将 `requireUnversioned()` 改名为 `validateConfiguration()`，保留现有校验和回收调用点。该方法检查实现所需的存储保证；OSS 内部沿用 bucket 版本检查。实现必须提供私有、持久、不可变的对象，原子创建且禁止覆盖，能够读取原始字节，并物理删除准确归属的 key。完成的物理创建绝不能自动重放，包括随后回收对象的情况。SQL 持久写入尝试账本继续控制对账。

带 guard 的读取重载必须在每个新存储请求或重试之前检查调用方提供的授权或租约。返回流不意味着可以重放读取失败的流。自定义实现必须明确满足这些保证；空校验仅适用于测试桩或由实现本身强制保证契约的后端。生产实现即使关闭定时 GC，也必须实现 `deleteIfPresent`，因为发布失败的清理也会删除对象。保留现有默认拒绝行为。

### 与后端无关的异常

新增 `ToolPublicationStorageException`，提供 `ACCESS_DENIED`、`FAILURE` 原因及原始 cause。OSS 适配器在边界内转换 OSS 服务端和客户端异常，沿用现有有界读取重试。创建和删除请求保留原有重试策略。guard 失败及标准流 I/O 失败保留现有行为。

API 异常处理和异步校验只判断通用原因。拒绝访问仍返回 HTTP 403 和 `managed_tool_publication_storage_denied`；其他失败保留现有通用处理。后端消息、凭证和对象位置不会进入公开响应。原始诊断通过异常 cause 保留。

### 默认 OSS 装配

将 OSS 客户端构建和默认存储 Bean 移入独立 Boot 自动配置，通过 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 注册。仅在通用发布配置存在、工具发布开启且不存在 `ToolPublicationObjectStore` Bean 时启用。延后执行的自动配置先观察应用 Bean，避免依赖组件扫描顺序。仅包含维护能力的 Boot 上下文不得初始化发布存储。默认实现保留自己的专用 OSS 客户端，不复用应用中无关的 OSS Bean。

通用发布配置不依赖 OSS 类型，并负责校验通用发布服务 URL。自定义存储仍需配置通用发布容量、截止时间和服务 URL，但无需 OSS endpoint、region、bucket 或凭证。没有自定义实现的既有部署继续使用原有 OSS 配置，保留固定区域 HTTPS 校验、V4 签名、私有 bucket 检查、重试行为和客户端关闭。

### 消费者与维护工具

发布写入与校验、保留读取、回收、Managed Session 资源读取、Workspace 恢复读取及公开产物下载继续使用同一个注入的存储。任何消费者都不自行选择其他后端，也不会在对象缺失时降级到其他存储。

独立 `WorkspaceRecoveryMain` 和 `WorkspaceCsiWorkerAckMain` 在 Spring 应用上下文之外构建存储，因此继续明确作为 OSS 专用启动器。更新其接口调用，保留环境变量契约。自定义后端的部署必须在恢复工具中接入相同存储；本次不会让内置 OSS 启动器自动支持任意后端。

## 兼容性与风险

一个部署只有一个权威存储，使用同一 SQL 目录的所有服务实例必须共享该存储。现有 SQL 记录对象 key，不记录 provider 身份，因此替换 Bean 或命名空间不等于迁移数据：必须保证保留对象仍可按原 key 读取，或先独立完成迁移再切换。旧对象缺失或损坏继续阻止读取或恢复，不降级到其他存储。

私有 Java 接口方法改名要求自定义实现及测试桩重新编译。无需修改 SQL、线协议 schema 或公开请求和响应。主要风险是默认 Bean 装配顺序错误、自定义存储仍触发 OSS 初始化、拒绝访问分类丢失，以及重试或回收保证弱化。

## 验证与验收标准

- 自定义存储无需 OSS 配置或凭证即可启动完整发布配置，是唯一注入的存储，不创建 OSS 客户端。H2 发布、保留和回收测试桩另行通过同一接口验证字节写入、读取和删除。
- 发布关闭时不创建默认存储或客户端。发布开启且无自定义存储时，默认 OSS 保留 endpoint、签名和生命周期行为。错误 OSS 配置仍使启动失败。
- 通用拒绝访问产生原有 API 响应和异步校验终态拒绝；普通存储失败保持通用行为，重试策略不变。
- 使用真实 SDK 的 HTTP 测试继续验证准确的读取请求次数、原始 cause、guard 过期、写入不重放及 bucket 版本拒绝。既有发布、保留、恢复读取和回收测试继续通过。
- 使用 JDK 21 和当前工作树 SDK 运行针对性 Maven 测试，再运行 `mvn verify`。为原生 CSI 测试构建既有 JavaScript 前置产物。新增后端部署资格、真实 bucket 验收和跨主机恢复属于独立验证。

## 验证结果

- 使用可用的内置 Node 24.19.0 完成仓库 `npm run build`。Java 检查使用 JDK 21.0.8、Maven 3.9.14、Node 22.22.3，以及安装到隔离 Maven 仓库中的当前工作树 SDK。
- 更新基线至 main `52ae53b02a` 后，全部 113 项存储专项测试通过，其中包括 9 项配置检查。2026-10-16 的完整 `mvn verify` 执行 4,193 项测试：4,183 项成功、9 项跳过，`WorkspaceCsiSessionMainTest.oldWorkspaceCreationDoesNotAcquireTheNewProfileOrRequestPin` 出现 1 个错误。在该 main 版本的未修改快照上，已独立复现同一失败：旧创建路径通过 `WorkspaceStorageKindGuard` 拒绝测试桩使用的 CSI 存储。本功能没有修改 `ManagedAgentStore` 或该测试。当前基线的完整验证未通过。
- 随后直接对更新基线后的功能分支编译产物运行两项已配置的 Checkstyle 检查及 SpotBugs：违规、问题实例和分析错误均为零。该单独成功结果不替代完整验证的失败记录。
- 30 个代码、测试和资源改动文件全部匹配本轮源码快照。多次更新基线没有改变服务端源码、测试和资源补丁，生产和资源文件的字节也保持一致；查询预算测试同时保留了上游无关改动。
- 9 项跳过分别为三项平台专用测试、四项要求真实 MySQL 的测试、一项按需开启的 Kubernetes 测试及一项要求显式提供真实 worker bundle 的测试。本次未验证新增后端、真实 OSS bucket、部署中的 Hosted 恢复或跨主机能力。Spring 替换检查和 H2 发布、保留、回收测试桩属于本地证据，不构成已部署自定义后端的 E2E 验收。
- 连续两轮干净自审及针对功能差异的独立只读审查均未发现可操作问题。更新基线后重新进行了集成审查。Markdown 格式、双语结构及本地引用检查通过。

## 未决问题

本次范围内无未决问题。其他后端实现及支持多后端的维护启动器根据实际部署需求另行实现。
