# Managed Agent 执行定义与初始化输入设计

[English](2026-11-25-managed-agent-execution-definition-spi.md) | [简体中文](2026-11-25-managed-agent-execution-definition-spi.zh-CN.md)

> 状态：首期 Java preparation 切片已实现并通过本地验证；精确边界与剩余验收见第 8 节。修订日期：2026-11-25。
>
> 跟踪：[QwenLM/qwen-code#18289](https://github.com/QwenLM/qwen-code/issues/18289)。宿主侧组合文档由宿主工作区维护；本文维护 MA 的通用输入契约，不涉及任何具体产品目录。
>
> 实施计划：[English](../plans/2026-11-25-managed-agent-definition-input-spi.md) · [简体中文](../plans/2026-11-25-managed-agent-definition-input-spi.zh-CN.md)。

## 1. 决策与兼容性

MA 支持两种获得可执行定义的方式：

| 输入模式         | 输入                                     | 结果               |
| ---------------- | ---------------------------------------- | ------------------ |
| `PRE_REGISTERED` | 现有公开 definition/API 与 JDBC store    | 行为不变           |
| `SPI`            | 通过宿主 SPI Bean 提供精确、已授权的输入 | 只新增输入准备路径 |

默认仍是 `PRE_REGISTERED`。预注册的完整 `AgentDefinitionRequest`（`model/instructions/tools/skills/mcp_servers/permission_policy/metadata`）、既有 create/update/get 行为以及原生 Session 准入都不变。已有预注册 JSON 不需要迁移或转换成 SPI loader。

SPI 模式由嵌入应用的配置及已注册 Source Provider 启用，而不是每个 Turn 临时选择，也不能在 operation 中途改变。缺少必需的 provider、规范化或 archive 配置时明确失败，不回退到不相关的 source 或全局 latest 对象。

**MA 始终保存它实际执行的 native Definition。** SPI 不意味着 Definition store 为空，也不意味着每个模型轮次回调宿主。最关键的映射是：

```text
sourceRef（精确的宿主输入身份）
  → native Definition 与材料引用（MA 实际执行与恢复的内容）
```

ZIP 初始化只是一种可选的来源材料优化：只有不存在匹配的不可变 native package 时才使用，不是每次 Worker 缺缓存或每个 Turn 都回源。

### 非目标

- 建立第二套宿主产品专属的业务配置权威；
- 提供万能 `Map<String,Object>` 配置体，或强制 loopback Java HTTP；
- 替换已有 stored-definition 实现；
- 把签名 URL 或一条日志当作原生执行证据；
- 允许 Provider 任意读取 secret 或 Worker 无界下载 ZIP。

## 2. Source 与 native 身份

Source key 不能只是业务 Agent 名称。每次有效输入必须有不可变、精确的投影身份：

```java
record SourceRef(
    String providerId,       // 选择哪一个宿主 SPI 实现
    String agentKey,         // 不透明的业务 Agent 引用，不等于 native agentId
    String sourceRevision,   // 宿主的精确不可变 revision，绝不能是 "latest"
    String projectionDigest, // 有效公共内容及精确材料身份的摘要
    String executionScope    // 用于授权和幂等的已认证范围
) {}
```

新选择（`Current(agentKey)`）时，宿主完成发布选择并返回这个精确 SourceRef 和有效 Definition。针对已选投影（`Exact`），Source 必须返回相同的 SourceRef/内容/digest，或者明确失败；不能替换为当前发布内容。

native 侧各有独立身份：

| 身份                                                  | 职责                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `nativeAgentId/nativeRevision/nativeDefinitionDigest` | Session 准入及读回所使用的不可变 native Definition            |
| `packageRevision/packageDigest/settingsRevision`      | 不可变安装包及独立保存的 settings                             |
| `commandDigest`                                       | 原始意图及回执查找，包含 caller scope 与 `Current/Exact` 选择 |
| `appliedConfigRevision`                               | 已由真实 Runtime operation 证明应用的配置代次                 |
| `secretRef/revision`                                  | 独立的精确私密凭据引用，不自行证明有效性或已应用              |

不能混用 `sourceRevision`、`projectionDigest` 和 native digest。base 组合、策略或资源的精确选择发生变化时，都可能需要不同的投影或 revision。单独的发布整数版本不一定能代表完整的有效投影。

MA 认证调用方，并从自身 Principal 和 Workspace 权限检查派生授权 scope。Source Context 不是由调用者提供的身份字符串集合。每次 Provider 的精确解析/读取也必须针对有效 Principal 授权；持有 SourceRef 本身不赋予访问权。

## 3. 核心接口

### 3.1 DefinitionSource

```java
public interface ManagedAgentDefinitionSource {
    Definition resolve(Context context, Selection selection);

    record Context(String tenantId, String actorId, String workspaceId,
            String executionScope, String requestId, Instant deadline) {}

    sealed interface Selection permits Current, Exact, PreRegistered {}
    record Current(String agentKey) implements Selection {}
    record Exact(SourceRef ref) implements Selection {}

    record Definition(SourceRef ref, String modelId,
            String instructions, ToolPolicy toolPolicy,
            List<SkillInput> skills, List<ExtensionUse> suites,
            List<BundleRef> bootstrapBundles) {}

    record ToolPolicy(String profile, String approvalMode) {}
}
```

`PreRegistered` 是 MA 应用入口的选择类型，携带既有完整 `AgentDefinitionRequest`，不会传给宿主 Source。SPI preparation 允许缺省 `modelId`，此时 native Definition 不包含 `model` 字段；它将 `modelId`、`instructions`、`toolPolicy` 和 inline Skill 映射到 native Definition 字段。Extension Skill 与 Suite 的选择作为非敏感来源/材料引用保存在 metadata；本切片不自动导入或应用它们。sealed Skill JSON 使用显式 `inline`/`extension` 类型标识，以便回放持久化回执。

新的 `Current` 在只有一个注册的 Definition provider 时可以隐式选择；存在多个 provider 时必须显式给出 `Exact` 引用。`projectionDigest` 是宿主提供的精确输入身份，MA 另行计算 command digest 和 native Definition digest。本切片没有独立的 MCP Source。

已完成的 operation 回放使用保存的投影，不重新选择 current。新 operation 会重新对精确 Source 输入授权。已有 Session 创建仍针对具体准入的 sessionId 发布 instructions/静态 Skill refs，而不是提前发布为无作用域全局资源；该应用操作不属于 preparation。

同一 `Current` operation key 的并发调用，以第一个持久化为 `RESOLVED` 的投影固定本次操作的版本；无论竞争方稍后读到的是 `RESOLVED` 还是 `PREPARED`，都收敛到该投影。更换发布必须使用新的 operation key。`Exact` 仍然拒绝同一精确引用下的不同内容。恢复 `RESOLVED` 时重新检查调用方截止时间；已受理的 `PREPARED` 回放则直接返回已存回执，不再执行 native 或 bundle preparation。

### 3.2 初始化包

```java
public interface AgentBootstrapBundleSource {
    Resolved resolve(Context context, BundleRef ref);

    record BundleRef(String providerId, String resourceId,
            String sourceRevision, String expectedDigest,
            Long expectedLength) {}

    record Resolved(BundleRef ref, Download download) {}

    // 本次授权、精确请求取得的私有下载定位符。
    record Download(URI signedUri, Instant expiresAt,
            String contentType) {}
}
```

`signedUri` 是短期、限定作用域的第三方下载位置，可由宿主从 OSS 等服务取得。MA 用受控下载器消费它，并由下载器限制允许的目标地址和重定向策略；URI 本身不授予任意外部路由权限。它不是长期授权，也不能写入公共 Definition JSON、日志或普通 resource reference。

如果流式获取比 URL 间接传递更便宜，也可以使用同源契约提供有界字节流。无需 URL 初始化时，现有 `ManagedExtensionSource.resolve/open` 仍是优选实现。

每次新的 prepare 都会对精确 ref 执行 Source 授权。随后 MA 通过 archive `stat` 按 `Key(tenantId, workspaceId, expectedDigest)` 查找原始不可变制品；只有缺失制品才从签名 URI 流式读取。缓存不会掩盖授权撤销：Source 拒绝仍然使本次 prepare 失败。命中缓存时不下载 body，也不消费 URI 的过期时间，因此旧 URL 过期不会让已保存制品失效。

这条准备路径要求提供 `expectedDigest`；如果提供 `expectedLength`，则必须与实际字节长度一致。MA 保存的是校验过的原始归档，不是签名 URL，也不是对业务配置解包/重新编译的结果。`stat` 是对 `ExtensionArchiveStorage` 新增的窄元数据读取接口；既有 `putIfAbsent/open` 行为不变。只有服务此输入路径的自定义存储才需要实现它。

preparation 最终返回不可变 Definition 和原始材料引用。bootstrap 保存不会注册 Extension catalog 行，也不会产生 settings revision。后续向 Runtime 的投递/应用应从这份 native 制品流式读取，属于独立操作，不由 preparation 自动推定完成。

### 3.3 Skill 与 suite

复用已有 `ManagedExtensionSource`：

- 独立 Skill → `kind="skill"`；
- suite 或带附件的 Skill → `kind="extension"`；
- resolve 返回精确来源引用与私有 locator，可带 expectedDigest；
- 只有需要新的不可变包时，才以有界流读取 open。

`settingsRevision` 是独立保存/应用的设置身份，绝不是 ZIP 编译的副产物。

### 3.4 独立 MCP 与凭据

以下为后续协议设计；本首期 Java 切片尚未实现这些 MCP/凭据接口。

```java
public interface ManagedMcpDefinitionSource {
    Definition resolve(ManagedAgentDefinitionSource.Context context, Ref ref);
    // Ref：providerId、serverId、sourceRevision、definitionDigest。
    // Definition：完整 transport recipe 及 includeTools，不含 secret 明文。
}

public interface ManagedMcpCredentialSource {
    Secret open(ManagedAgentDefinitionSource.Context context, SecretRef ref);

    interface Secret extends AutoCloseable {
        String revision();
        Instant expiresAt(); // 仅当签发方声明无到期时间时可以为 null。
        byte[] bytes();      // 私密数据；不记录日志，不进入公开投影。
        @Override void close();
    }
}
```

native server revision 是 MA 生成的 JavaScript 安全正整数及 native definition digest，不是宿主的文本 revision。凭据刷新使用新的精确 revision 和独立 operation，并指明 expected applied config revision；不能覆盖已有 operation 的内容，也不能悄悄改变正在执行的 Turn。

每次 credential open 都要对已授权精确 secret revision 做授权校验，返回的 handle 在 `try/finally` 中关闭，包括准备/投递失败。如果 MA 和 Runtime 都没有保留所需受保护的值，失败恢复不能凭 SecretRef 臆造值，结果应为 `recovery_unavailable/refresh_required`，而不是伪装成功。

### 3.5 MA 的应用入口

```java
public interface ManagedAgentDefinitionPreparation {
    PrepareReceipt prepare(Command command);

    record Command(String tenantId, String actorId, String workspaceId,
            String executionScope, String operationKey,
            Selection selection, Instant deadline) {}

    record PrepareReceipt(OperationRef operation, AgentDefinition definition,
            List<PreparedBundle> bundles) {}
}
```

宿主调用的是这个 MA 自有方法，不是实现它为宿主 SPI。

`prepare` 只准备不可变 Definition/材料计划。原生 Session 创建、settings apply、Extension application 和 MCP application 都是独立的 MA 操作，各自有独立 operation key、读取和实际 applied receipt。完成的 preparation 不代替后续任何准入步骤。

## 4. 持久化状态与诊断信息

### 保留的现有记录

| 记录                                                        | 仍负责什么                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ma_agent_definition`                                       | 按 tenant/id/revision/digest 保存不可变 native Definition 内容，不保存 ZIP blob |
| `ma_session`、`ma_turn`、`ma_session_record`、`ma_resource` | 实际 Session、Turn、journal 与不可变内容/引用证据                               |
| `ma_runtime_binding`                                        | Runtime placement 与 drain/ownership 事实                                       |
| `ma_extension_package` / archive storage                    | 已有 Extension 编译材料与不可变制品                                             |
| `ma_extension_settings`                                     | 独立保存的加密 settings revision                                                |
| `ma_request_receipt`                                        | 各自 operation namespace 内已受理的操作身份与可回放结果                         |

SPI 生成的 native Definition metadata 保存 `sourceProjection`、非敏感 Extension Skill/Suite 选择和初始化包引用。`SOURCE_DEFINITION_PREPARATION` 回执保存命令摘要、阶段、有效输入、native Definition ref 与不可变 bundle refs。既有 `ma_extension_package` catalog 保持独立；bootstrap 是 archive backend 中按内容摘要定位的原始字节，不会自动成为新的 catalog entry。公开表现中不保存签名定位符或私密 settings 值。

### 默认不强制新增两张表

第一版最小 SPI 初始化**不强制新增两张 preparation/material 表**。优先复用已有不可变 Definition、resource、package、settings 和 receipt 契约。日志额外记录 provider/ref、字节数、digest 校验、operation 身份、目标 Worker 和结果，以便审计及延迟分析。

若之后需要支持长耗时或未知 preparation 的恢复，必须在首次外部 Source I/O 前就将 command 持久化为 operation receipt 的 pending 状态，拿到精确投影时先保存该投影，再仅在真实 native refs 存在时标记 prepared。如果现有 receipt 和 native plan 不能表达所需状态，仅在有具体多副本恢复用例时新增最小的准备记录；不能只写日志后就声称它可恢复。

### ZIP 字节与签名细节

绝不可把大型 ZIP blob 写入 `ma_agent_definition.definition_json` 或 JVM 堆。规范化后的不可变 package 放在私有 archive backend，记录 digest、预期/实际长度及 native pin。持久化的是源摘要与 source-to-native 映射，不是短命 URL 或 Authorization 值。

## 5. 目标时序

```mermaid
sequenceDiagram
    autonumber
    participant Host as Host ExecutionProvider
    participant Prep as ManagedAgentDefinitionPreparation
    participant App as MA Session / Runtime applications
    participant Bind as Host ProviderBinding
    participant Def as ManagedAgentDefinitionSource
    participant Bundle as AgentBootstrapBundleSource
    participant Store as MA Definition / Material Store
    participant Harness as Node Hosted Harness
    participant Runtime as MA Broker / Runtime Worker

    Note over Host,Runtime: PRE_REGISTERED remains the default and keeps its existing API/store flows
    Host->>Prep: prepare(caller fields, Selection, operationKey, deadline)
    Prep->>Store: Require Workspace OPERATOR; find/admit the original operation receipt
    alt The same operation is settled
        Store-->>Prep: Original native Definition, bundle refs and receipt
        Note over Def,Bundle: No provider call and no latest lookup
        Prep-->>Host: PrepareReceipt(original)
    else Pending, or a saved RESOLVED stage to continue
        Prep->>Store: Admit PENDING before external Source I/O
        opt A projection still needs resolution
            Prep->>Def: resolve(MA-checked context, Current / Exact)
            Def-->>Prep: Exact SourceRef and effective Definition
            Prep->>Store: Save the exact input as RESOLVED
        end
        Prep->>Store: Create/reuse the deterministic native Definition and verify its pin
        opt The input names bootstrap bundles
            Prep->>Bundle: resolve(authorized Context, exact BundleRef)
            Bundle-->>Prep: Exact ref and private signed locator
            Prep->>Store: Look up the immutable archive by content digest
            opt The matching native artifact is missing
                Prep->>Bundle: Bounded HTTPS streaming
                Bundle-->>Prep: Actual bytes and digest verified in private staging
                Prep->>Store: putIfAbsent(raw verified archive)
                Note over Store: No signed URL, Authorization or ZIP bytes in Definition JSON
            else A matching native archive already exists
                Note over Bundle,Store: Reuse saved bytes without download, even if the old URL expired
            end
        end
        Prep->>Store: Mark the Definition and bundle refs PREPARED on the original receipt
        Prep-->>Host: PrepareReceipt(native definition, immutable bundle refs)
    else Same operationKey, different original command
        Store-->>Prep: idempotency conflict
        Prep-->>Host: Reject without selecting latest or inventing a new source identity
    end

    Note over Host,Runtime: Independent MA application operations with their own keys/receipts, not part of prepare
    Host->>App: admitNativeSession(newSessionOperationKey, exact native Definition pin)
    App->>Store: Persist admission/sessionId; publish Session instructions/Skill refs on create
    App->>Harness: Create/attach by native pin
    Harness->>Store: Read Session instructions/Skill refs with digest validation
    App->>Runtime: Apply exact saved package/settings and MCP recipe/private material
    Runtime-->>App: Native admission and applied/active receipts
    App-->>Host: Return independent admission and applied/active receipts
    Host->>Bind: Persist ProviderBinding plus exact prepared and applied references
    Note over Def,Bundle,Runtime: Normal Turns never call host SPI; saved material may be delivered to a new Worker without re-download
```

`Current` 需要新的宿主授权和选择。`Exact` 表示返回已知的不可变输入，而不是读取全局 latest。已受理的 settled 回放在重新计算 current 前返回。pending 初始化只能返回/协调已持久化的阶段，不能返回完成的计划。若尚无已解析投影，重启后也绝不能选择 latest 冒充原投影。

## 6. 流式处理、解析与安全边界

现有 Extension 导入是可复用的接收模式：按块读入私有临时文件，同时计算 hash 和字节数，限制并发准备数量，只有内容验证通过才继续。现有实现的示例是 64 KiB 块和最多四个并发准备操作（`ManagedExtensionPackageService.java:246-290`）。这只是实现模式，不承诺每个部署采用相同大小限制。

对已实现的初始化下载：

1. 配置最大包大小与并发下载数量；
2. 统计实际读取字节，而不是信任 `Content-Length`；
3. 使用有界 reader/writer、私有 staging、连接/读取/operation 截止时间，并在 `try/finally` 清理；
4. 只有长度和 digest 都匹配后，才原子发布 native artifact；
5. 后续向 Runtime 的投递也从不可变 artifact 流式读取，而不是分配整包 `byte[]`；
6. signed URL、签发方 Header 和原始 secret 在日志、回执、prompt 与公共引用中一律脱敏。

对于可信、规范明确的宿主包，MA 可以只是经过完整性校验的透传接收者，**不需要对内部内容做业务语义审计**。包解包的路径边界、条目数量/大小限制、manifest schema 兼容性与执行安全，应由可信的打包规范及消费该包的 Worker，在适用阶段负责。若 MA 要将其作为可执行输入，就不能把任意未知 vendor ZIP 静默当作已支持的可执行包。

签名校验、制品发布、Worker 解包和配置真正激活是不同证据。仅签名通过，不能证明执行或恢复成功。

## 7. 交付与验证计划

从最小纵切开始：

1. 保持既有预注册 Definition 与 Session 不变。
2. 通过 SPI 验证一个小 Definition：认证 scope、精确 SourceRef、native revision/digest、提交前真实读回，正常模型轮次不回调宿主。
3. 引入一个初始化 ZIP：只有缺少匹配 native 包时触发下载，按上述方式限流和流式处理，形成私有不可变 archive，后续 Worker 使用保存的 artifact。
4. 演练两次并发准备、ProviderBinding 本地保存失败、缺少 current 配置、URL 过期、包超限、native commit 后响应丢失。每种情况都必须收敛到原 native refs 或明确未决阶段，而不是新选择的 latest。
5. 之后才增加 native MCP 协议：完整 recipe、精确对外 capability/schema 中的 `includeTools`、native `serverRevision` 与受保护凭据的持久化/恢复。不得静默让封闭的 v1 base manifest 接受未知新字段。

必须观察并断言：

- 老的预注册输入不要求 SPI bean 且不改变行为；
- 相同精确投影生成同一 native 身份，不同 scope 不能复用同一授权结果；
- 新授权调用正确的 Source 方法，回放/恢复使用保存的精确引用；
- 向 Worker 投递不意味着再次 `open` 或编译原始源材料；
- secret 不可用或为空是恢复错误，不能回退到未指定的全局 latest；
- native admission、prepared 材料和真实 applied/active 回执保持分离，并在扩大范围前用真实 MySQL 与 Node/Worker 进程验证。

## 8. 当前状态与变更说明

首期 Java 切片已在 `feature/managed-agent-definition-input-spi` 实现：Q1 `97e4b6c2efc024e9eba26327352d87c2e5a7c4de`，Q2 `e07b74d2c5`，Q3 `d48bc5a036`。最初的源码阅读基线是 `dev/managed-agent@e8c189fb90a204ab8762f8c8fc8e66d0f833271c`；这些功能分支提交不等于已合并基线或发布制品。

本切片已实现的行为：

- 嵌入方通过部署配置选择 `PRE_REGISTERED` 或 `SPI`。受信任的 Java 调用方提供调用方字段，MA 在宿主 Source 解析前先检查 Workspace OPERATOR 权限并生成回执 scope；不新增 preparation 公共 HTTP 路由。
- 精确输入转换为确定性 native Definition，并在写回时核验 revision/digest。既有 receipt 表通过 `SOURCE_DEFINITION_PREPARATION` 保存来源引用、有效输入与材料引用，不新增 preparation/material 表。
- bootstrap 先对精确 ref 授权，再按内容摘要查找 native 制品；只在缺失时经 HTTPS 有界下载，成功后保存校验通过的原始字节。已完成回放直接使用保存引用，不再次调用 Source，新 operation 也不会通过缓存绕过授权。
- 原预注册 API/update/get、随机 ID 以及 stored-definition Session 准入保持可用。SPI preparation 不悄悄改写这些数据模型。

实际执行的验证：

- Q1：14 个聚焦测试及 Checkstyle。
- Q2：32 个聚焦测试，以及一个真实 MySQL 8.4 用例，协调两个 Java 服务并发调用收敛到同一 native 身份与 receipt。
- Q3：76 个聚焦测试、1 个真实 MySQL preparation 用例，以及随后 28 个授权/下载/回放检查；重叠用例不计作独立覆盖量。
- Q4 新增 20 个聚焦检查，其中 10 个真实 HTTPS bootstrap 用例覆盖复用、Source 授权撤销、摘要/长度/内容错误、超时、过期、重定向及协调后的缺包并发下载。另行 19 个检查包含同一 bootstrap 套件及 9 个嵌入式 Spring 用例，证明没有宿主 Source provider 时仍能创建 `ManagedAgentDefinitionPreparation`。嵌入环境特有的字符串到 Duration 转换问题已使用 Boot 3.5.16 的 `DurationStyle` 修复。这些代码路径的 Checkstyle 通过。

`feature/managed-agent-definition-input-spi-clean` 上的评审后续修复覆盖了重复及空白 allowed-host 项归一化、无模型 Definition、resolve 竞态后的已结算回放、`Current` 采纳最先持久化投影、恢复时重新检查截止时间、body 读取超时分类及 deadline worker 关闭。后续的 27 个聚焦测试及 Checkstyle 通过。针对 `Current` 竞态的真实 MySQL 用例已补充，但其选定用例运行未在本地完成，不宣称通过。

本切片未实现宿主产品适配、独立 MCP/凭据刷新、Extension Skill/Suite 引用自动导入/应用，以及 bootstrap 制品在 Runtime 生效。未执行真实 Node/Worker apply、真实 OSS 账号或生产宿主绑定；预注册 Session 准入回归不能冒充 SPI 的 Node 执行 E2E。完整 unit/H2、SpotBugs 及 hosted/OS-process profile 需在更广泛验收前由 CI 完成。支持本路径的自定义 archive backend 必须实现 `stat`。已有 Source 复用导入和 Session apply API 保留独立操作及回执，不新增第二套 Session/Turn 状态机。
