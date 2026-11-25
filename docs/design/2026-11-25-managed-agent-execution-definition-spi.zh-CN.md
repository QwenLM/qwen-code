# Managed Agent 执行定义输入 SPI

[English](2026-11-25-managed-agent-execution-definition-spi.md) | [简体中文](2026-11-25-managed-agent-execution-definition-spi.zh-CN.md)

> 状态：设计提案，未实施。创建日期：2026-11-25。
>
> 跟踪：[QwenLM/qwen-code#18289](https://github.com/QwenLM/qwen-code/issues/18289)。宿主侧组合设计由宿主工作区维护；本文维护 Managed Agent 的通用输入契约。

## 1. 问题与决策

嵌入方宿主拥有业务 Agent/Skill/MCP 的发布、授权和不可变制品。Managed Agent（MA）只需要有效执行输入，不需要另一份可独立编辑的业务目录。

| 契约                             | 定义方 | 实现方 | 职责                                          |
| -------------------------------- | ------ | ------ | --------------------------------------------- |
| `ManagedAgentDefinitionSource`   | MA     | 宿主   | 在新准备期间解析已授权且精确有效的 Agent 定义 |
| `ManagedMcpDefinitionSource`     | MA     | 宿主   | 提供精确的完整 MCP 配方及非敏感输入           |
| `ManagedMcpCredentialSource`     | MA     | 宿主   | 在受控物化路径读取精确、私密的凭据修订        |
| `ManagedExtensionSource`（现有） | MA     | 宿主   | 精确解析/读取 Skill 或 Extension 输入         |

MA 还提供 `ManagedAgentDefinitionPreparation`，由 **MA 实现**。它只准备 Definition/材料计划；不创建 Session、不应用配置，也不执行模型/工具 Turn。这些属于独立的 MA 应用操作，各自拥有独立 operation key 和回执。

Node 的 agent-loop 不调用宿主 SPI。Runtime Worker 使用 MA 保存的材料，或经认证的、可验证协议投递的材料。

### 非目标

- 第二套业务目录、宿主产品专属类型、万能配置 Map 或强制的 loopback Java HTTP 适配。
- 每个 Turn 都进行 AgentRun 式选版、每个模型轮次都回调 Definition，或在活跃 Turn 中自动轮换 token。
- 把 Definition 准备成功当作 Runtime 激活证明，或者在没有保留受保护材料时，把保存一个凭据引用当作充分恢复条件。

## 2. 本设计保留的现有行为

基线：`dev/managed-agent@e8c189fb90a204ab8762f8c8fc8e66d0f833271c`。

- 原生 AgentDefinition 是 tenant 级 append-only revision。原生 Session 准入时固定 `agentId/revision/digest`；definition 更新只影响新 Session。
- 在 Session 创建期间，`QwenHostedHarnessConnector.agentDefinition` 为已受理 Session 发布 instructions/Skill refs（`QwenHostedHarnessConnector.java:2585-2625`）。Node 通过 Resource Store 读取并校验字节和 digest，而不是回调宿主（`http-managed-session-store.ts:2665-2717`）。目前没有支持在 Session 之前发布全局 instructions 的入口。
- Hosted pin 是窄身份视图，不是完整配置（`packages/cli/src/serve/hosted-agent-definition.ts:16-90`）。
- 静态 Skill 正文不携带附件。Extension 编译会记录资产及其目录（`packages/core/src/extension/managed-package.ts:404-426`）。
- `ManagedExtensionSource` 为精确的 `skill|extension` 引用授权。包准备会计算/验证摘要并保存编译后的包（`ManagedExtensionPackageService.java:246-315`）。新的基于 source 的选择会执行授权性 `resolve`；已受理回放和符合条件的恢复使用保存的 pin。`resolvePin` 读取 MA 保存的 archive，不读原始宿主 Source。
- 包编译/导入与 Extension settings 创建相互独立。导入包可以使用 `settingsRevision=null`；真正的 settings revision 来自独立的 `saveSettings` operation，不是 ZIP 编译的副产物。
- 基础独立 MCP 定义目前来自 Runtime 私有 manifest（`QWEN_MANAGED_MCP_CONFIG`）。其 Version-1 封闭字段覆盖 transport recipe，但不接受任意的宿主 `includeTools` 字段，也不接受任意独立 Definition 导入（`packages/cli/src/serve/managed-context-worker.ts:436-464`、`managed-mcp-runtime.ts:179-196,259-342`）。Extension staging 已经展示了如何组装完整 manifest（`managed-extension-manifests.ts:40-56,192-238`）。
- Definition create 已有持久幂等回执。在 tenant/key/规范化原生 Definition 请求都相同时，并发输家重放赢家的回执，而不是保留另一个随机 native ID（`JdbcManagedAgentDefinitionStore.java:47-91,157-196`、`ManagedAgentDefinitionService.java:96-113`）。Update 需要独立的顺序语义，不等于回放。
- Personal MCP OAuth、带有效期的私有 revision 和透明刷新尚未由当前自助协议交付。

本文仅从既有协作引擎–宿主接入借鉴这些原则：服务端创建的可信身份、`current` 与 `exact` 的区分、材料 digest 校验、数据库事务外的 I/O，以及宿主与 native revision 的独立映射。MA 不继承其他协调器的 revision 格式、Manifest 或 Run 生命周期。

## 3. 接口归属与调用顺序

以下是目标时序，不是已实现端到端路径，也不承诺宿主与 MA 存储之间存在事务性。

```mermaid
sequenceDiagram
    autonumber
    participant Exec as Host ExecutionProvider
    participant Reader as Host definition reader
    participant Bind as Host ProviderBinding
    participant Prep as ManagedAgentDefinitionPreparation
    participant App as MA Session / Runtime applications
    box Host SPI implementations
        participant Def as ManagedAgentDefinitionSource
        participant Ext as ManagedExtensionSource
        participant McpDef as ManagedMcpDefinitionSource
        participant Cred as ManagedMcpCredentialSource
    end
    participant Store as MA Definition / Material Store
    participant Harness as Node Hosted Harness
    participant Runtime as MA Broker / Runtime Worker

    Note over Exec,Prep: Phase A: Definition/material preparation only
    Exec->>Prep: prepare(authenticated Principal, Selection, operationKey)
    Prep->>Store: Validate Principal; derive trusted scope; find by commandDigest(scope, operationKey, originalSelection)
    alt Existing committed preparation with the same commandDigest
        Store-->>Prep: Original projection and native refs
        Note over Def,Cred: No new Source call and no latest lookup
        Prep-->>Exec: PrepareReceipt(original prepared result)
        opt ProviderBinding was not saved locally
            Exec->>Bind: Save the original source-to-native mapping
        end
    else Existing pending preparation
        Store-->>Prep: Original saved stage and any already-resolved projection
        Prep-->>Exec: Continue/reconcile that pending operation; no completed receipt
        Note over Def,Cred: Do not reselect a newer projection to complete an older operation
    else New preparation or a normalized request-producing a committed winner
        Prep->>Store: Atomically admit pending command, or read existing committed receipt
        Prep->>Def: resolve(MA-derived Context, Current / Exact)
        Def->>Reader: Authorize selection and exact effective materials
        Reader-->>Def: sourceRevision, inputDigest and complete effective Definition
        Def-->>Prep: Definition(model / instructions / tools / skill / suite / MCP refs)
        Prep->>Store: Persist resolved projection and next preparation stage before further I/O
        opt Skill assets or suite present
            Prep->>Ext: resolve(Context, exact source reference)
            Ext-->>Prep: Private locator and expected digest
            opt No matching compiled native package exists
                Prep->>Ext: open(Context, exact source)
                Ext-->>Prep: Original archive stream
                Prep->>Harness: preparePackage(metadata, stream)
                Harness-->>Prep: Canonical package and packageDigest
                Prep->>Store: Save immutable package (settingsRevision remains null unless separately saved)
            end
        end
        opt Independent settings revision required
            Prep->>Store: Independently save/prepare exact settings with its own operation key
            Note over Store: This is not a by-product of package compilation
        end
        opt Independent MCP present
            Prep->>McpDef: resolve(Context, exact server reference)
            McpDef-->>Prep: Complete recipe, includeTools and exact SecretRefs
            Prep->>Cred: open(Context, exact secret revision)
            Cred-->>Prep: Protected material, secret revision and expiresAt
            Note over Cred: Secret handles close in try/finally after materialization or failure
        end
        Prep->>Store: Save compiled Definition/material plan and committed preparation receipt
        Prep-->>Exec: PrepareReceipt(operation, native definition/material plan)
        Exec->>Bind: Save the ProviderBinding mapping
    else Same operationKey with different originalSelection or caller scope

        Store-->>Prep: idempotency conflict
        Prep-->>Exec: Reject without replacing the original operation
    end

    Note over Exec,Runtime: Phase B: distinct native admission and apply operations, each with its own receipt
    Exec->>App: admit native Session(newSessionOperationKey, exact native Definition pin)
    App->>Store: Persist native Session admission and obtain sessionId before Harness calls
    App->>Store: Publish instruction/Skill refs on create; reuse exact saved refs on attach
    App->>Harness: Create/attach Session by exact native pin
    Harness->>Store: Read this Session's instruction/Skill refs
    Store-->>Harness: refs/resource bytes after digest verification
    App->>Store: Read actual Session agent_id, agent_revision and agent_digest
    Store-->>App: Actual pinned Definition identity
    App-->>Exec: AdmissionReceipt(sessionId, verified Definition identity)
    opt Extension apply required
        Exec->>App: applyExtensions(newApplyOperationKey, saved package/settings pins)
        App->>Runtime: Deliver exact saved archive, selected settings and manifest
        Runtime-->>App: applied/active configuration revision
        App-->>Exec: AppliedReceipt(target config revision, corresponding package/settings pins)
    end
    opt Independent MCP apply required
        Exec->>App: applyMcp(newMcpOperationKey, complete recipe and selected secret revisions)
        App->>Runtime: Deliver complete manifest and hydrate selected private material
        Runtime-->>App: Connection/discovery result and applied receipt
        App-->>Exec: AppliedReceipt(native server identity and applied configuration revision)
    end
    Exec->>Bind: Persist native admission and independently proven applied versions
    Note over Exec,Runtime: A normal model/tool Turn follows later; it uses saved refs/packages/catalogs and never calls a host Source
```

`DefinitionSource.Current` 只用于新业务选择；`Exact` 表示对已知来源引用的再次授权读取。二者都不是逐 Turn 回调。回放先查询持久化命令意图和阶段，不重新评估 `Current`，也不把 pending 当作已完成。

准备链在 Source I/O 前先原子受理原始命令为 pending，得到解析结果后立即保存精确投影及其阶段，只有材料计划和 native refs 都存在后才把 preparation 置为已提交。若并发副本已提交赢家结果，直接回放，不再调用 Source。若重启时尚未保存解析出的投影，不能选择重启后的 latest 冒充原投影。

Session 路径则先由 MA 持久化准入并得到明确 sessionId，在创建路径发布该 Session 的 instructions/Skill refs（附着路径复用已保存的 exact refs），之后才调用 Harness create/attach。该顺序与现有连接器一致，不会引入一个 Session 前的全局资源发布器。

这里有两个不同方向：

- **宿主 → MA**：调用 MA 的 Definition preparation，以及另外的原生 admission/application 操作。
- **MA → 宿主**：MA 调用 source SPI，并自己派生可信上下文。宿主的选择和授权不替代 MA 的 Workspace/Principal 检查。

## 4. DefinitionSource 契约

下面是用于讨论的 Java 形状，不是已有 ABI。契约评审时，只要保持下述语义，可以调整命名。

```java
public interface ManagedAgentDefinitionSource {
    Definition resolve(Context context, Selection selection);

    // 由 MA 从已认证 Principal 与已授权范围构造，
    // 从不把调用方直接填写的 tenant/actor 身份信息当作事实接收。
    record Context(String tenantId, String actorId, String workspaceId,
            String executionScope, String requestId, Instant deadline) {}

    sealed interface Selection permits Current, Exact {}
    record Current(String agentKey) implements Selection {}
    record Exact(DefinitionRef ref) implements Selection {}

    record DefinitionRef(String agentKey, String sourceRevision,
            String inputDigest) {}

    record Definition(DefinitionRef ref, String modelId,
            String instructions, ToolPolicy tools,
            List<SkillInput> skills, List<ExtensionUse> suites,
            List<ManagedMcpDefinitionSource.Ref> mcpServers) {}

    record ToolPolicy(String profile, String approvalMode) {}

    sealed interface SkillInput permits InlineSkill, ExtensionUse {}
    record InlineSkill(String name, String description, String body,
            String baseDirectory) implements SkillInput {}

    record ExtensionUse(ManagedExtensionSource.Reference source,
            ManagedExtensionPackages.Target target) implements SkillInput {}
}
```

### 语义

- `Current` 在新的宿主授权与选择后返回完整精确的结果。MA 不保留一个持续变化的 current 视图。
- `Exact` 必须返回原来的 `sourceRevision` 和 `inputDigest`，不得静默替换为更新发布版本。
- `agentKey` 是宿主 Agent 引用，不是授权令牌。`executionScope` 标识已授权的执行分区，本身不授予任何 secret 或资源访问权。
- native scope 从 MA 已认证 Principal 及其 Workspace 权限检查派生，不能信任调用方直接填写的 tenant/actor 字符串。
- `inputDigest` 覆盖规范化后的有效公共输入及精确材料身份。单独的 Agent 整数 revision 可能无法区分动态依赖、base 组合、允许的企业策略和所选制品。
- 有附件的 Skill 或 suite 使用 `ExtensionUse`，而不是一个 `baseDirectory` 指向宿主文件系统的 `InlineSkill`。宿主专属类型不进入 MA。
- 模型凭据位于配置的 Runtime 模型路由之后，不进入公共 Definition JSON。
- Definition 内容是有界文本。没有逐 Turn 的 `DefinitionSource.open`；大型制品通过现有 Extension source 提供。

### 与现有 Extension source 的 Context 兼容

原有 `ManagedExtensionSource.Context` 包含 tenant、actor、Workspace、requestId 和 deadline。复用这个 SPI 指的是复用 `resolve/open` 和私有定位语义，不能假装新的 source group 能原样通过每个旧 Context record 传递。

当 `executionScope` 仅用于稳定的宿主记账命名空间时，适配器可以确定性映射它而不改变材料权限。若它会改变某个 actor 可使用的材料，则 source 授权必须通过更新后的通用 Context/适配器保留同一个精确 scope。此类契约/Context 扩展必须在集成任何 Provider 前单独评审并版本化；既有 actor/Workspace 组合不能静默等价于任意新的授权 scope。`SecretRef` 也绝不能替代一次针对精确 revision 的重新授权。

## 5. Extension、MCP 和凭据

### 5.1 Skill 和 suite 材料

`Reference` 必须贯穿 `resolve`、`open` 及 resolved locator 保持精确不变。如提供预期摘要，MA 在读取字节时进行校验。native `packageDigest` 属于编译输出，不是原始输入。

```text
授权 resolve
  ├─ 没有匹配的 native 编译包：open → 编译 → 保存不可变 package
  └─ 存在匹配的 native 编译包：复用，不调宿主 open，也不重新编译
       → 向 Worker 投递时，始终读取 MA 保存的包，不读宿主 Source
```

包导入/编译不会自动产生 settings revision。若使用 null/empty 设置，必须显式表达。若需要非空 revision，应使用自己的 operation key 和独立保护的 value 流程进行保存/应用。

### 5.2 `ManagedMcpDefinitionSource`

```java
public interface ManagedMcpDefinitionSource {
    Definition resolve(ManagedAgentDefinitionSource.Context context,
            Ref ref);

    record Ref(String providerId, String serverId,
            String sourceRevision, String definitionDigest) {}

    record Definition(Ref ref, Recipe recipe,
            List<String> includeTools) {}

    sealed interface Recipe permits Stdio, Http {}
    record Stdio(String command, List<String> args,
            Map<String, String> environment,
            Map<String, SecretRef> secretEnvironment) implements Recipe {}

    record Http(URI endpoint, Mode mode, Map<String, String> headers,
            Map<String, SecretRef> secretHeaders) implements Recipe {}

    enum Mode { SSE, STREAMABLE_HTTP }

    record SecretRef(String credentialId, String revision) {}
}
```

source 级 revision 与 digest 绑定完整配方，而不是显示名称。私密 credential ref 指向精确材料，而不是明文 secret 字节。

MA 另行生成并持久化 **native `serverRevision`（正整数且是 JavaScript 安全整数）和 native `definitionDigest`**。宿主的文本 `sourceRevision` 只是映射键。native digest 描述完整已准入公共配方和目标私密引用身份；不应包含明文 secret 或对低熵 secret 计算可公开摘要。

这些完整连接配方**当前不能被 Node 的 `mcp-configure` pin 协议或 Version-1 基础 manifest 接受**。实现必须显式增加带版本的内部 Runtime apply/manifest 路径，覆盖：

- 独立来源的完整 recipe 与历史 native revision；
- 在 discovery/对外 tool input schema 中进行 `includeTools` 过滤，而不是静默给 v1 增加未知键；
- 精确私密引用的物化和私密投递；
- digest 校验、幂等应用、释放/重连和恢复。

Extension manifest staging 可作为参考，但独立 Definition 不得仅为了避免评审契约变化而伪装成 Extension contribution。只有未来增加公共 HTTP 面时，才修改 `managed-agent-public-api.openapi.json`。

### 5.3 `ManagedMcpCredentialSource`

```java
public interface ManagedMcpCredentialSource {
    Secret open(ManagedAgentDefinitionSource.Context context,
            ManagedMcpDefinitionSource.SecretRef ref);

    interface Secret extends AutoCloseable {
        String revision();
        Instant expiresAt(); // 仅当签发方声明无到期时间时可以为 null。
        byte[] bytes();      // 敏感数据：不记录日志，也不进入公开投影。
        @Override void close();
    }
}
```

每次 `open` 都对所请求的精确 revision 进行授权校验。Source 要么返回这个精确 revision，要么返回分类明确的失败。Secret handle 只在有界的私密物化过程中使用，并在 `try/finally` 中清理，包括准备或投递失败。实现不得把原值放入模型 prompt 或普通 resource reference。

刷新使用新的精确 secret revision 和独立 apply operation，不能改写已受理 operation，也不能改变正在执行的 Turn。如果刷新回执未知，只能查询或继续原 operation。

**私密恢复资格**：MA 或 Runtime 必须已按要求的保护和精确 revision 保留全部所需私密值。若仅存 `SecretRef`，恢复不能凭空得到丢失的敏感值，必须明确返回 `recovery_unavailable` / `refresh_required`，不能换成无关联的 latest 材料或虚构成功。在实现这套私密存储与物化语义前，独立 MCP 的私密恢复属于待定，不是已经闭合的已验收契约。

### 5.4 `ManagedAgentDefinitionPreparation`

```java
public interface ManagedAgentDefinitionPreparation {
    PrepareReceipt prepare(Command command);

    // Principal 由 MA 或其嵌入信任边界认证/签发。
    record Command(Principal principal,
            ManagedAgentDefinitionSource.Selection selection,
            String operationKey) {}

    record PrepareReceipt(OperationRef operation,
            NativeDefinitionRef definition, PlanRef materials) {}
}
```

`prepare` 由 MA 实现，仅处理 Definition/材料准备。`Principal` 不是调用方自报的租户信息，`operationKey` 也不是授权凭据。回执指向真实持久化的原生 definition/材料计划及 operation，不包含、也不伪造 applied 状态。

后续原生 Session 准入、Extension apply 和独立 MCP application 都作为各自独立的 MA 操作调用，使用各自的 operation key 并读取各自的回执。`getPublicSession` 核验实际准入 Session 的 native definition 身份。正常模型/工具 Turn 遵循自身准入和执行协议。

## 6. 身份、幂等与恢复规则

### 三个相关但不同的摘要

- **命令摘要**：规范化的已认证 caller 范围、operation key 和原始 Selection（包括 `Current(agentKey)` 或 `Exact(ref)`）。它标识原始应用意图和回执查找，不代表实际选定的发布。
- **有效投影摘要（`inputDigest`）**：规范化后解析出的 Definition 与精确非敏感材料身份。它区分不同解析后的发布/配置，是 source→native 映射的一部分。
- **原生 definition/package digest**：MA 针对实际编译后的 Definition 和 package 表示计算并保存的摘要。它们不能替代宿主的投影摘要，而 package digest 也不等于 settings revision。

后续的 `Current(agentKey)` 本身无法从记忆重建上一个投影。已受理回放因此读取已保存的投影、阶段和回执，不重新调用 Source 选择 latest。

### 独立的 operation 命名空间

Definition 准备、原生 Session 准入、Extension 导入、settings 保存/应用、MCP application 和刷新具有独立 operation key 与 receipt。某一个的回放不授权另一个，尤其不授权新 Session 或 application。

### 首期：每份有效投影使用 create-only

首次集成不在每次发布更新时修改同一个 native Agent，避免 native update 的 revision 顺序问题。

两个副本准备同一个精确有效投影时：

1. 两边派生相同的规范化请求和稳定 source group；
2. 赢家原子提交原生 definition/材料计划与回执；
3. 输掉并发的一方回滚重复尝试，重放该精确赢家的记录；
4. 双方读取同组 native refs，而不是查询 latest。

这里要求的是相同的规范化请求，而不只是相同业务 Agent 名称或原始 `Current(agentKey)` selector。不同原始命令使用同一个 key 必须冲突。新的有效投影使用新的 source-group/receipt 身份。

如果 MA 已提交，但宿主没有保存 ProviderBinding 或响应已丢失，宿主重试原始命令 operation，读取原结果后再保存 binding。实现这套持久回执模式，不需要额外带唯一性权威的映射表。

在同一个 native ID 下延续线性更新需要显式 expected-base/CAS 或按组串行化协议。没有提交回执的竞争失败命令不能称为回放该命令之前的成功响应。

### 准备、pending、回放和恢复

- `prepare` 只创建持久化 definition/材料计划，绝不执行模型/工具 Turn；其完成回执也不授权后续 admission/application。
- 已受理但尚未完成的 preparation 返回/协调当前保存的阶段，而不是完成回执。已经解析出的投影保持不变；如果尚未保存解析出的投影，恢复必须明确失败，不能选择新的候选冒充。
- 已受理回放使用原保存的投影；已证明失败的恢复继续原 operation 和保存的精确材料。只有新的准入/选择 operation 才做新业务授权。
- Worker 缺少缓存的 native package，不导致宿主 `open` 或重编译。投递从已保存包读取。只有在新授权选择后缺少 native 编译包时，才调用宿主 open/编译。
- 只有保留受保护的私密材料，secret 引用才有恢复意义。未保留时恢复明确不可用，需要新的授权操作提供材料。
- 应用代次/revision 与 source/secret revision 分开记录。applied receipt 把目标配置代次与精确 package/settings/server 身份和实际准入 operation 关联起来。

`executionScope` 同时参与幂等和授权选择。各副本不能根据进程 ID、随机请求 UUID 或时间戳派生分组，任何回放都不能扩大调用方范围。

## 7. 建议实现位置

以下为建议，不表示这些文件已经存在或已有兼容承诺。

- `contracts/.../catalog/`：通用 Definition source、可信上下文、值类型和编译器接入。
- `contracts/.../mcp/`：精确 MCP recipe、私密 credential source 和有界类型。
- `control-plane/.../catalog/`：Definition preparation 编排、阶段/回执持久化以及真实 native 身份核验。
- 现有 Extension 服务与 `ExtensionArchiveStorage`：继续承担 source/package 编译、已保存 archive 访问和独立的 settings 保存行为。
- Runtime/Broker/Worker 契约：接收显式版本化的 archive、manifest 和私密投递扩展。`HarnessConnector` 仍是操作接口，不是宿主材料 source SPI。
- Node `managed-context-worker.ts` 与 managed MCP 模块：接受经过评审的精确 manifest/scheme，只执行自身的 materialization/discovery/connection 路径。
- Node Hosted Session loaders：继续核验已保存的 native Session/ref 身份，而不是跟随实时的宿主 feed。

首次集成使用官方 `ManagedAgentConfiguration` 以 Java 嵌入方式实现，不要求增加公共 HTTP 面。未提供宿主 SPI 时，原有公共 Definition 注册保持现有行为。任何后续公开 HTTP 协议都必须显式更新 OpenAPI，并同步认证和客户端。

宿主拥有业务选择、ProviderBinding 和适配器。MA 不得依赖宿主产品的包或协议。

## 8. 交付阶段与验证

1. **仅 Definition 主链**：用通用 fake host 受理一个精确 definition；在 Session 创建时准备 instruction/Skill refs；在下一次提交前读回真实 native 身份。
2. **Extension 附件**：实际使用一个附属文件，校验 source/package digest、正确的 package/settings 身份和 reprepare。
3. **独立 MCP**：实现显式的内部 manifest/apply 版本、真实 discovery 与实际连接、受保护的物化和有限 secret 恢复。
4. **配置切换**：对已有 Session 的完整配置切换单独评审。在此之前，更换 native AgentDefinition pin 需要新建 native Session；model/approval/Extension/MCP 操作不自动构成原子发布流程。
5. **宿主验收**：真实 MySQL、多个副本、真实 Node/Worker 进程以及正常模型/工具副作用。分别证明源读取、prepared 计划、已受理 Session 和独立 applied 配置。

### 必要测试与证据

- **Principal 隔离**：调用方原始的 tenant/actor 字符串不能选择 source 或读取凭据；通用 fake host 和默认无 Provider 路径不依赖特定产品类型，不绕过权限。
- **命令与阶段恢复**：相同原始命令回放保存的精确结果；pending 不得报告已完成；未解析投影不能被静默重选；原生提交后响应丢失时，其后保存的是同一个宿主 binding。
- **并发注册**：相同精确规范化输入收敛到同一个 native ID 和 refs。不能只凭原始 `Current(agentKey)` 就证明不同的解析输入相同。
- **Source 与缓存**：新准入执行 `resolve`；只有缺少 native 编译包才 `open` + 编译；需要向 Worker 投递时读取保存的包，不执行这两个操作。
- **撤权**：源撤权/删除后，以相同 pin 发起新授权被拒绝；已受理回放沿用原回执；其他条件具备时，恢复只使用 MA 留存材料。
- **settings 与凭据**：编译/导入绝不静默产生自定义 settings revision；缺少受保护材料时明确恢复失败；刷新回执丢失继续原 operation；除非另有明确刷新协议，活跃 Turn 中拒绝 apply。
- **原生内容**：instruction resources、附件、Extension contributions、实际 discovery/tool schema 和正常模型/工具副作用均正确。敏感值不进入日志、公开 recipe、普通 catalog ref 或事件。

## 9. 实现评审点与验证状态

实现前还需要精确评审：

- 最终包名、具体已认证 `Principal` 类型，以及如何把已授权 execution scope 映射到既有 Extension source Context，而不削弱材料授权。
- 命令与投影摘要的规范化、native recipe 版本，以及回执记录的 scoped 唯一约束。
- 带版本的独立 MCP Runtime/Worker manifest 契约、私密受保护存储/物化和恢复行为；不能静默挪用 Extension settings 表。
- tool profile 兼容性、原生 Session 重建与后续完整 Definition 切换，以及扩大第一纵向路径前真实 MySQL/Node/Worker/多副本的证据预算。

本次文档更新的验证记录：

- 使用本地脚本检查相对链接和中英文互链。
- 对照中英文的章节结构、Java 声明与 Mermaid 时序。Java 注释属于解释性文字，在声明对比中被排除。
- `git diff --check` 及新增文件空白检查通过。
- 仓库 pre-commit 钩子已对两份 Markdown 文件成功执行 `prettier --write`。本机没有 `mmdc`，因此仅对 Mermaid 做文本结构校验，未验证渲染图。
- 未修改生产 Java/TypeScript，未运行构建、真实进程或端到端验收。本文仍是设计提案，不代表实现、恢复或验收已经完成。
