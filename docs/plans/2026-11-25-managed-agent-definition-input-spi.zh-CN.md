# Managed Agent SPI 定义输入：实施计划

[English](2026-11-25-managed-agent-definition-input-spi.md) | [简体中文](2026-11-25-managed-agent-definition-input-spi.zh-CN.md)

> 状态：Q1–Q3 已实现并通过本地验证；Q4 记录实际实现、配置及剩余 CI/进程验收项。日期：2026-11-25。
>
> 已实现提交：Q1 `97e4b6c2efc024e9eba26327352d87c2e5a7c4de`，Q2 `e07b74d2c5`，Q3 `d48bc5a036`。这些是功能分支提交，不是已合并基线或发布版本。
>
> Q1：14 个聚焦测试及 Checkstyle。Q2：32 个聚焦测试及 1 个真实 MySQL 8.4 并发准备用例。Q3：76 个聚焦测试及同一条真实 MySQL 路径，随后执行了 28 个契约、下载与回放检查，包含新增授权用例。重叠的选择器不合并计算为独立覆盖量。
>
> 验证使用 JDK 21、Maven 3.9.11 和任务专属 Maven repository。完整 CI 门禁、完整 SQL/Hosted profile、SpotBugs、真实 Node/Worker 应用、宿主产品验收及生产 OSS 验证仍需独立完成，不在此宣称通过。
>
> 上级契约：[执行定义与初始化输入设计](../design/2026-11-25-managed-agent-execution-definition-spi.md)（[English](../design/2026-11-25-managed-agent-execution-definition-spi.md)）。
>
> Issue：[QwenLM/qwen-code#18289](https://github.com/QwenLM/qwen-code/issues/18289)。
>
> 本切片仅限 qwen-code，不实现宿主产品适配，也不改变预注册 AgentDefinition 的流程。

## 1. 交付物与硬性边界

交付一条 **Java 嵌入式、可选开启的 SPI 准备路径**，产出不可变 native Definition 和初始化归档包。首个纵向切片仅包含：

- 精确的 `sourceRef → native Definition/材料引用` 映射；
- 从宿主 Source 取得类型化 Definition 输入；
- 只有在不存在匹配 native 初始化制品时，才下载原始归档包；
- 可供后续独立原生应用操作消费的不可变引用。

`PRE_REGISTERED` 仍是默认值，已有公开 definition API、JSON 形状、JDBC store 和 Session 行为保持原样。SPI 通过嵌入方显式配置及已注册的 provider 启用，不允许请求方或 Turn 临时指定。没有 provider 或必要配置时必须拒绝，不能悄悄退回另一个数据库或 latest 对象。

### 本切片明确不做

- 宿主产品适配模块实现；
- 通用 Personal MCP OAuth、自动 token 轮换、已有 Session 动态重新绑定 definition；
- 新 MCP v1 字段、公共 HTTP 端点、提前新增 preparation/material 表，以及第二套 Session/Turn 状态机；
- 执行任意 vendor ZIP、将完整 ZIP 字节放入 JVM 堆或 `ma_agent_definition.definition_json`，以及从 Node agent-loop 实时回调宿主。

## 2. 已确认的现有复用点

- `ManagedAgentDefinitionStore` 已有不可变 native revision 及幂等 `create`/回放路径。其 request/response `definitionJson` 包含非敏感 definition 字段；native ID 和版本仍归 MA。
- `ma_agent_definition` 已保存 `tenant_id/agent_id/revision/digest/definition_json/gmt_create`；预注册完整 `AgentDefinitionRequest` 的语义不变。
- `ExtensionArchiveStorage.Key(tenantId, workspaceId, digest)` 提供原子、共享的不可变坏归档存储。其 `putIfAbsent` 契约用于不可变包字节，不得重放未知写入。
- `ma_extension_package` 保存编译 package manifest 和 `source_json`，而不是将归档包保存为 DB BLOB。`ma_extension_settings` 是独立的加密 settings revision；编译不会生成它。
- `ma_request_receipt` 已保存 receipt scope、幂等 key/digest、request digest、state、native agent revision 和 `result_json`。Source preparation 采用独立的 operation namespace，不能借 `AGENT_DEFINITION` 注册来暗示 Session 准入，也不能改变旧 key 和回放行为。
- `RequestDigests` 使用配置好的 canonical `ObjectMapper` 与 `DigestUtils.sha256Hex`。直接复用，不再发明第二种摘要算法（`model/RequestDigests.java:13-17`）。
- `AgentDefinitionCompiler` 和 `AgentDefinitionExtensions` 继续负责支持的 definition/tool/skill 形状。
- `ManagedExtensionPackageService.importSource` 已有按块读取归档流到输出流、逐块检查 deadline 的实现，应沿用其流式/有界 staging 方式，不使用 `readAllBytes()`（`ManagedExtensionPackageService.java:246-290`）。
- 原生 Session 创建时，`QwenHostedHarnessConnector.agentDefinition` 在获得具体 sessionId 后发布 instructions/Skill refs。Node 通过 Resource Store 读取这些内容，不引入 Session 前的全局资源。

以下契约现已位于 `contracts/definitions`、`contracts/extensions` 和 `contracts/repository`。`ManagedAgentDefinitionPreparation` 已在 control-plane catalog 包实现，bootstrap 下载/存储位于 extensions 与 persistence 层。它们的职责仍限定在下述窄切片，不是完整宿主配置系统。

## 3. 生产改动前冻结的契约

### 3.1 `ManagedAgentDefinitionSource`

保留上级设计中的小型接口：

```java
Definition resolve(Context context, Selection selection);
```

输入及不变量：

- `Context` 包含 tenant/actor/workspace、`executionScope`、requestId 和 deadline。受信任的嵌入应用在认证后提供这些调用方字段；MA 校验 Workspace OPERATOR 权限，不为这条 Java 路径新增第二套登录门面，或直接信任任意 HTTP 身份请求头。
- `Selection` 是 `Current(agentKey)` 或 `Exact(sourceRef)`。
- `Current` 仅用于新的授权选择，返回完整精确 definition。
- `Exact` 必须返回原精确 revision/projection，否则明确失败；不能替换为当前发布中的版本。
- `Definition` 包含模型引用、instructions、tool policy、静态 Skill 或 Extension 引用，以及可选的 bootstrap BundleRef。公共 Definition 不包含任意 secret 或 signed URI。

生成的 native Definition 的 source projection metadata 中保存精确 SourceRef：

```text
providerId / agentKey / sourceRevision / projectionDigest / executionScope
```

它不是 native `agentId`，不是随机请求 UUID，也不是 nonce。base/policy/resource 选择不同，或未授权 scope 不同，都不能复用另一个 scope 已准备的投影。

### 3.2 `AgentBootstrapBundleSource`

`resolve(Context, BundleRef)` 返回 `Resolved`，包含：

- 精确的 `providerId/resourceId/sourceRevision`；
- 可选预期字节长度；
- 预期 source digest；
- `signedUri` 和 `expiresAt`：短期、限定作用域的下载 URI 及其签发方提供的过期时间；
- 受信任原始初始化包的 `application/zip` 或 `application/octet-stream`；不接受 URI userinfo，也不能用重定向替换内容。MA 不从原始 ZIP 推定可执行语义或 Extension catalog 语义。

MA 自己负责有界下载。URI 只代表一次明确的获取操作，不是持续授权，也不是后续查询 key。若字节流方式可避免一次 URL 往返，也可采用同源的有界 Stream 形式。普通 Extension 材料继续使用已有 `ManagedExtensionSource.resolve/open`。

本切片接受受信任的原始初始化包，并校验其身份与字节，不解析内部业务语义。不能因任意外部对象也叫 ZIP，就推定它拥有安全、可执行的语义，或自动将其转换为已注册 Extension package。Worker 后续如何使用仍是独立操作和责任。

### 3.3 `ManagedAgentDefinitionPreparation`

`prepare(Command)` 由 MA 实现，通过受信任的嵌入调用方接收 tenant/actor/workspace/execution scope、`Current`/`Exact`/`PreRegistered` 选择、精确 deadline 和稳定 operationKey。它不负责：

- 创建 Session；
- 应用 Extension 或独立 MCP 配置；
- 启动模型/工具 Turn；
- 写入 applied/active 配置状态。

`PrepareReceipt` 返回 native Definition/material plan 与 operation identity。原生 Session 准入及后续 application 是独立的 MA 应用操作，分别使用独立的 key 和 receipt。

## 4. 实施顺序

### Q1：契约与旧路径回归

1. 新增 Source/数据契约放在 `contracts` 的 catalog/extension API 附近；不引入宿主产品类型或 DTO 依赖。
2. 增加 provider 注册边界，接受嵌入式 Spring Source Provider，拒绝缺失/重复的 provider ID，并依据 MA 已认证的 Principal/Workspace 检查生成 Source Context。
3. 从现有无 Servlet 的 `ManagedAgentConfiguration` 暴露 `ManagedAgentDefinitionPreparation`，不新增默认 Controller/Web endpoint。
4. 选择 `PRE_REGISTERED` 时，公开 AgentDefinition create/update/get 以及直接使用 definition 的原生准入均保持原样，不把 Mode 混进原有方法，也不改变其 JSON 序列化。
5. 用现有 MA `RequestDigests` 对规范化原命令计算 `commandDigest`，包含 tenant、actor、Workspace、execution scope 和 selection。`projectionDigest` 是宿主给出的精确输入身份，不是 MA 对完整 native request 重新计算的摘要。native Definition digest 根据 MA 转换后的 native 内容计算。SPI native `agentId` 由 tenant 与完整精确 SourceRef 确定性派生；原公开 create API 继续使用随机 ID。

**退出证据：**无 provider 时预注册流程不变。显式选择 SPI、但缺 provider/必要配置时，在 Source 或 Runtime 副作用之前得到确定性拒绝。

### Q2：Source preparation 与准确 native 记录

按以下步骤实现 `ManagedAgentDefinitionPreparation`：

1. 接收受信任的嵌入调用方字段，并校验 MA 对目标执行范围的 Workspace OPERATOR 权限。
2. 查找已有匹配 native 投影。若已有 settled receipt 且投影相符，返回其 native refs，并在提交前核验 native Definition revision/digest，不重新评估 current。
3. 否则，在首次外部 Source I/O 之前，通过现有 receipt 边界登记 pending preparation。其 namespace 必须与旧 Definition create 以及后续 admission/apply 分离。
4. 调用所选 Source。在任何包 I/O 前先保存精确 SourceRef 与有效输入，从 tenant 和完整 SourceRef 派生 native 身份；再固化转换后的 native Definition，并在读回时核验 id/revision/digest。后续阶段只能基于这份精确投影继续。
5. 沿用现有 native definition 表示保存转换后的定义，形成不可变 native revision。通过非敏感 metadata/source-preparation 表示关联 SourceRef，不改变旧 metadata 的意义。
6. 若存在保存了精确投影的 pending 阶段，则恢复/协调该阶段。若没有持久化过已解析投影，不假装存在，也不选择一个新的 latest。
7. 沿用 Definition store 的原子写入/回放行为，提交 native Definition/material plan。如果宿主单独的 ProviderBinding 保存失败，则用原命令取回同一个 native receipt，再仅重试宿主本地保存。

**退出证据：**经协调并发的两个 Java 服务调用，在真实 MySQL 及生产 Definition store 事务语义下，收敛到同一个 native definition 身份和 receipt；这不等同于多个独立 OS 进程的证据。同 operationKey、不同输入被拒绝。重复调用可恢复原结果，不查 latest，也不要求重新查宿主。

必须遵守：

- `PREPARED` 仅表示不可变 Definition/material plan 已持久化，不表示 Runtime 配置已应用。
- 不为模仿日志形式新增 `ma_definition_preparation`/`ma_definition_material`。只有具体契约测试证明了无法表示的 native 恢复事实，才评估新 schema。
- 仍不能由所选 receipt 契约安全表达的准备阶段，应显式返回 `unsupported_feature` 或拒绝该路径，绝不把 pending 静默视为 committed。

### Q3：仅在 native 包缺失时下载初始化归档包

新增有界的下载/准备组件，执行：

1. `ManagedAgentBootstrapPreparationService` 接收已授权的 Definition context，最多接受 32 个不同 bundle ref。这条 preparation 路径必须提供精确 `expectedDigest`；预期长度可选，但提供时必须核对。
2. 与既有 Extension 路径一致，每次新的 `prepare` 都执行 `AgentBootstrapBundleSource.resolve` 对精确 ref 授权。外层 Definition preparation 已完成的回放只读原回执，不再回调 provider。缓存不能掩盖权限撤销。
3. 通过新增的 `stat` 查询 `ExtensionArchiveStorage.Key(tenantId, workspaceId, expectedDigest)`。已有合法制品直接复用，不进行 HTTP body 下载；只有缺失制品才进入下载器。原始 URL 过期不会让已保存制品失效，但新的 Source 授权失败仍然会拒绝本次 prepare。
4. 要求获批准的 HTTPS hostname 和未过期签名 URI，拒绝 URI userinfo 与重定向，把 HTTP 200 的 `application/zip` 或 `application/octet-stream` 响应写入私有临时文件。每次读取最多 64 KiB，增量计算摘要和长度，遇到超限、摘要不符、断流或超时立即失败并清理 staging。
5. 用 `putIfAbsent` 原子保存校验通过的原始字节。Definition preparation 结果及回执返回不可变 `PreparedBundle{source,digest,byteLength,reused}` 引用。相同内容摘要可以复用字节，不生成无界缓存键，也不产生额外 Definition revision。
6. 不创建第二条把 ZIP 读进 JVM 堆的路径，不新增 preparation/material 表，默认不把 URL 交给 Node。已保存归档是原始初始化制品，而不会自动成为已注册 Extension catalog entry、`settingsRevision` 或 applied/active Session 配置。Worker 物化/应用仍是独立操作，必须另有验收证据。

如果目标地址不允许、endpoint 非法、下载过期或字节损坏，初始化必须失败，不得执行包或悄悄使用旧 blob；不能无条件回退到 latest 数据。

MA 不读取内部业务语义进行审计。Worker 实际安装/执行包所需的已有校验/激活仍由相应路径负责。

### Q4：源码路径通过后再补验证与文档

在讨论宿主集成前，先实证最小真实路径：

```text
预注册输入 → 保持原流程（不变）
一条 Source definition → 不可变 native Definition → 精确 native 准入/读回
一个缺失初始化包 → 有界 HTTPS 下载 → 不可变原始制品/引用（与 apply 分离）
```

更广泛的宿主集成、动态配置切版、独立 MCP 私密刷新或完整进程恢复，必须分别实现并取得证据后才能宣称。后续状态更新必须引用真实测试/提交标识及实际检查。

## 5. 实际代码和测试位置

沿用现有模块，不新建平行工程/module。

- `contracts/definitions/`：`ManagedAgentDefinitionSource`、`ManagedAgentDefinitionPreparation`、精确 SourceRef 和选择类型；
- `contracts/extensions/`：`AgentBootstrapBundleSource`、`ManagedAgentBootstrapPreparation`、`ExtensionArchiveStorage.Info` 和共享不可变归档键；
- `control-plane/.../catalog/`：Definition preparation 组合、native 转换、receipt 组装与 Workspace 授权；
- `control-plane/.../extensions/`：bootstrap 配置、精确引用授权、有界下载/复用及 staging 清理；
- 既有 JDBC Definition/Extension repositories 与 `ExtensionArchiveStorage`：继续负责不可变 native 存储；
- `ManagedAgentConfiguration`：仅做可选 Spring provider 装配；
- `verification/src/test/java/.../catalog/`：source 和 preparation 测试；
- `verification/src/test/java/.../extensions/`：下载和复用/恢复测试；
- 既有 `ManagedAgentEmbeddingTest`、`ManagedAgentDefinitionAdmissionTest`、`HostedExtensionsIT`：共享回归，仅在实际行为影响相关 profile 时使用。嵌入式测试在没有 SPI provider 时直接取得 preparation 服务；本切片未运行 `HostedExtensionsIT`。

不要手改生成的公共 OpenAPI 类型。若后期单独批准公共 HTTP 面，必须在独立交付中同步 `managed-agent-public-api.openapi.json`、所有映射 route 和客户端生成。

## 6. 必要验收场景

### Definition 与兼容性

1. 完整预注册 JSON 与原来语义一致地注册/准入，不需要 SPI Bean。
2. 一个 fake Source 返回小型精确 Definition，携带两个依赖 refs；核验 native 内容及真实 `agentRevision/agentDigest`。不能让自由文本 source name 替代精确 SourceRef。
3. `Current` 重新授权；已受理的 settled 回放跳过 Source 并使用原 receipt/projection。`Exact` 的内容发生变化或不匹配时失败。
4. 同 scope 精确规范化输入在多个副本间收敛到相同 native ref，不同 scope/输入产生不同 source group 或幂等冲突。
5. Node 正常模型/工具轮次中不回调 Source，已保存投影可以跨重启使用。

### 下载与阶段隔离

1. fake 有界 OSS HTTP server 提供 short-lived URI。只在 native package 不存在时发生一次获取，且 ZIP 字节流不得形成完整的堆内存副本。
2. 核对 source digest/length/content type，原子保存原始制品并置计划为 prepared，但不得置为 applied。
3. 后续相同 preparation 可以再次 `resolve` 完成授权，但不下载原字节，也不产生另一个 native revision。它复用保存的原始制品，不重试过期的原 URL。该制品不是已应用的 Worker 配置；投递/应用使用独立操作和验证路径。
4. 下载中断、过大响应、短 body、digest 不符、目标重定向、超时和 URI 过期都不能影响最后一份有效包。signed URL/auth Header 和 ZIP 字节不得进入日志、Definition JSON、普通 ref 或 prompt。
5. 真正并发的竞争要么只返回一个不可变 artifact，要么使用 settled winner，不能形成两个独立获准的计划，也不能暗中改用别的 revision。

### 恢复边界

- 宿主本地 ProviderBinding 保存失败后，可以通过原 native receipt 回放并后补保存 binding。
- pending 初始化只能返回已持久化的阶段，不得生成虚构完成的 plan。
- 没有保存已解析的精确投影时必须明确失败，不能用更新发布的 Agent 顶替。
- 缺少私密材料/回执时明确返回不可用，而不是推断恢复成功。本切片不承诺通用 MCP secret 恢复或 Turn 中安全动态换版。

## 7. 验证入口

实现已按项目本地检查取得实际报告，而不是假定通过。请在 `packages/managed-agent-server/` 复现对应的聚焦检查，不能仅凭文档状态推断验收。

从 `packages/managed-agent-server/` 选择新增及受影响测试，不默认执行无差别全仓测试：

```bash
mvn -Dtest=ManagedDefinitionPreparationTest,ManagedAgentBootstrapPreparationTest,ExtensionArchiveStorageTest \
  test checkstyle:check
```

测试前确认 JDK 21/Maven 和与被测源码一致的隔离 sibling SDK。若需安装 SDK 制品，按该模块 `AGENTS.md` 使用任务专属本地 Maven repository，并在后续 Maven 命令中保持相同配置。

- SQL/persistence、receipt 和并发写入路径必须选取对应 `mysql-integration` 用例，在一次性 MySQL 8.4 环境执行，并遵守当前模块的环境与建库约束。
- 完整 unit/H2、Checkstyle/SpotBugs 和 Hosted profiles 留给 CI，不能豁免，也不能以 H2 或 mock 推定真实验收。
- 如果要修改 Core/CLI/native Harness 代码路径，须追加仓库既有 Node core/CLI 构建与聚焦测试。任何真实 hosted-processing 或恢复行为都必须另有适当的真实进程证据，不能用当前存在某个文件来代替证明。
- 若只改 Java/文档，使用 MA-local Maven 和文档检查，不扩展到无关的全仓 TypeScript/Vitest 门禁。新增或修改文档执行仓库的 Prettier。
- 该模块本地验证的预算默认为每次改动最多 10 分钟，除非另行明确授权。无法取得的真实 MySQL/Native process 路径必须列为待 CI 完成，不得以假设证据替代。

最终报告须包含：源码 commit、实际测试命令和结果、被测模式、真实 MySQL 证据等。部署、发布及宿主产品验收不因本计划完成而自动成立。

## 8. 已实现边界与剩余验收

已经确定并落地：Source 契约归属 `contracts/definitions` 与 `contracts/extensions`；原命令和 actor scope 进入 receipt 身份；新 preparation namespace 为 `SOURCE_DEFINITION_PREPARATION`；只有单一 provider 时才允许隐式 Current，多 provider 必须给出精确 ref。bootstrap 扩展沿用自己的 Source Context，不把宿主 executionScope 当成匿名凭据，也不要求 Node 自行访问签名 URL。

获得验证的范围仅限以上提交和实际执行的测试。没有完成整个 CI、完整 MySQL/Hosted profile、SpotBugs、真实宿主适配、真实 OSS 账号或 Node/Worker apply；不能把现有 Java/H2/mock 聚焦测试当成这些能力的生产验收。多次复制的内容相同并不意味着出现了多个 runtime 生效实例。部署、制品发布、宿主消费、业务更新与动态凭据刷新都需要各自独立的实现、版本和证据。

本切片不新增通用动态配置系统、MCP 私密刷新、第二套 Session/Turn 状态机，也不让 preparation claim Worker 已应用。完整 CI、原生进程路径与真实宿主接入仍是后续门禁，不能用文档状态替代。
