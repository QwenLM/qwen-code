# Managed 工具结果 Hosted 交付（O2）

[English](2026-09-27-managed-tool-result-hosted-delivery.md) | [简体中文](2026-09-27-managed-tool-result-hosted-delivery.zh-CN.md)

## 1. 状态与建议

O2 作为一个交付，内部按阶段提交。[O2a 契约与归属基础](2026-09-27-managed-tool-publication-ownership.zh-CN.md) 和 O2b–O2d 代码已在基于 main `302e7d88e` 的分支上本地实现，包含 Hosted 文件工具轮次 #12831；仍待 Draft PR 评审及下述环境依赖证据。2026-09-28 的调研从 `e4f3a2351` 开始；随后观察到的主线 `c3e880b8` 只修改 Web Shell。最终集成前重新核对主线。

建议在现有 Java Managed Session Store 中增加私有 OSS 发布服务，catalog 与 Session journal 使用同一 SQL 数据库。复用 O1a 不可变分段、manifest 与 Tool v3，并按第 5 节显式澄清 call ID 语义；复用 O1c 捕获和背压。新增持久发布归属、经过校验的完整引用关系、有界容量准入，以及原始 Session 回执对账。

首个后端确定为专用私有 OSS bucket。共享持久卷属于另一种持久性配置，不能证明 Runtime 宿主丢失后结果仍可用。私有 Shell profile 默认关闭。若真实 OSS 或替代宿主证据暂不可得，统一实现先提交 Draft PR，补齐验证后再转 Ready for review。通用孤立 worker 接管不属于 O2。

发布过期分类和按字节量固定的扫描窗口见 [R15-1 恢复设计](2026-09-30-managed-tool-publication-expiry-recovery.zh-CN.md)。该后续修复保持 O2 默认关闭，要求部署显式配置校验预算。

## 2. 调研发现与依赖

| 固定基线中的来源                                                                                                                                                                                                                    | 已观察行为                                                                                                                         | 设计影响                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [O1a](2026-09-26-managed-tool-result-contract.zh-CN.md)、[O1b](2026-09-26-managed-tool-result-local-store.zh-CN.md)、[O1c](2026-09-27-managed-tool-result-shell-capture.zh-CN.md)                                                   | 执行、捕获、交付分离；不可变分段回执；固定版本读取；本地捕获和回执闭环                                                             | 复用契约与回归测试；本地存活不代表 Hosted 持久性             |
| [HTTP Session Store](https://github.com/QwenLM/qwen-code/blob/e0b8bea9e0ba369a0661bc51cbbb9a27555aff48/packages/core/src/managed-runtime/http-managed-session-store.ts#L162)                                                        | `publish()` 将字节暂存在内存，上限 64 KiB；`commitResources()` 遍历暂存的 checkpoint，不遍历 outcome → manifest → pages → segments | 返回资源引用不等于远端发布回执                               |
| [Java Session Store](https://github.com/QwenLM/qwen-code/blob/e0b8bea9e0ba369a0661bc51cbbb9a27555aff48/packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/ManagedSessionStore.java#L273) | journal、列出的资源引用和 writer fencing 共用 SQL 事务；资源目前使用 `MYSQL_INLINE` 和 `REFERENCED`                                | 复用该事务附着 catalog；持有 journal head 锁时不执行 OSS I/O |
| [SQL catalog](https://github.com/QwenLM/qwen-code/blob/e0b8bea9e0ba369a0661bc51cbbb9a27555aff48/packages/sdk-java/managed-agent-server/src/main/resources/db/migration/V4__managed_session_store.sql#L55)                           | 已有 object key/version/encryption 列，但没有实现 OSS 发布协议或分段完整引用关系                                                   | 使用新增迁移；不能把未使用的列视为可用后端                   |
| [本地 Session 接纳](https://github.com/QwenLM/qwen-code/blob/e0b8bea9e0ba369a0661bc51cbbb9a27555aff48/packages/core/src/managed-runtime/local-shell-result-session.ts#L75)                                                          | 要求本地资源 store 和 `SessionWriterLease`；准备身份保存在内存                                                                     | Hosted owner 需要显式适配器和持久绑定，不能强制转换为本地类  |
| [worker executor](https://github.com/QwenLM/qwen-code/blob/e0b8bea9e0ba369a0661bc51cbbb9a27555aff48/packages/cli/src/serve/managed-runtime-tool-executor.ts#L557)                                                                   | 在报告 settled 前调用注入的本地 `accept()`                                                                                         | Hosted 路径必须分离物理结束与远端 Session 接纳               |
| [Hosted 工具轮次](https://github.com/QwenLM/qwen-code/blob/25749df40093bcb4b971db8b3fbd2d8b21fffb7e/docs/design/2026-09-27-hosted-workspace-tool-turn.md)                                                                           | 私有 Read/Write/Edit 循环、延迟 prepare/start、副作用前持久 wait；Shell 仍关闭                                                     | 接入该循环，复用调度、历史和 Workspace 归属                  |

现有 Java 事务上限保持为：单个 inline 资源 64 KiB、1024 个资源引用、单事务 8 MiB、256 个事件。合法 O1a page 可达 256 KiB。O1c 当前每 512 段发布一页，契约允许 1024 段。保存的 outcome 也可能超过 64 KiB。因此，仅将原始 stdout/stderr 搬到 OSS 会留下元数据持久化缺口。

上层 [artifact 设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-tool-result-artifacts.md) 定义了 hold/receipt 边界。本提议针对现有 HTTP Session Store 细化：publication catalog 与物理 journal 位于同一数据库，TypeScript authority 仍决定是否接纳结果。未来若采用分离数据库，需要另行设计对账。

## 3. 范围与不变量

首个生产方继续限定为前台 Shell、`process_pipes`、`complete_required`、独立 stdout/stderr，以及一个最终 `revision=1`。本阶段覆盖私有上传、持久最终执行结果、Session 接纳、内部固定版本读取、配额与背压，以及真实替代宿主验证。公开预览分组、下载授权和 UI 归 O3。PTY、后台任务、任意附件、自动 GC、跨 Session 共享、去重和通用 W0e 恢复独立推进。

所有边界均遵循以下不变量：

- 允许 Shell 副作用前，提交原始 intent 和 `await_runtime`，预留容量并绑定 publication。准入失败时副作用为零。
- 已发布 ordinal 的字节不可变。重试返回原回执和引用。调用方提供的摘要、HTTP 成功、object listing 或 Broker `SETTLED` 都不能证明 Session 接纳。
- complete-required 结果只有在原始 `tool.receipt` 为 `committed`，且完整保留关系已校验后，才能推进 `results_ready`。
- 物理结果、捕获完整性、交付决定独立。副作用后的持久化失败不能触发重执行，也不能改写真实退出结果。
- 已发布字节和归属元数据不依赖 worker/Harness 内存存活。ACK 不删除 Session 所有的结果数据。
- 未知执行结果保持未知。字节流结束不能单独证明命令成功、停止或释放了 Workspace owner。

## 4. 组件、传输与归属

```mermaid
sequenceDiagram
    participant H as Hosted Session owner
    participant J as Java Store and SQL catalog
    participant B as Broker
    participant R as Runtime worker
    participant O as Private OSS
    H->>B: Prepare original execution
    H->>J: Commit intent and await_runtime
    H->>J: Reserve publication and capacity
    H->>B: Start with immutable publication binding
    B->>R: Bind restricted grant, then Tool v3 execute
    R->>J: Publish bounded segments and metadata
    J->>O: Create immutable object; read back and verify
    J-->>R: Original durable receipt
    R->>J: Seal and finish original outcome
    R-->>B: Settled, delivery pending
    H->>J: Verify finished publication; commit tool.receipt
    J->>J: Atomically attach retained closure and journal
    H->>B: Send exact original ACK
    B->>R: Tool v3 acknowledge
    H->>J: Advance committed result checkpoint
```

图中从原始执行准备开始，依次提交 wait、绑定授权、发布分段、持久封存结果、提交回执，再交付 ACK 并推进 checkpoint。回执提交后，checkpoint 推进和 ACK 可以独立重试；两者都不能早于该提交。即使 ACK 暂不可达，模型继续也必须读取已提交决定。

采用 worker 主动连接 Java 的私有 HTTPS 上传通道。这明确新增一项部署要求：worker 能访问配置的 publication ingress。执行/status/cancel/ACK 仍由现有 Broker 主动访问 worker。上传 URL 来自部署配置，不来自工具参数。若网络出口或所需能力不可用，必须在执行前拒绝捕获准入，不能降级 v2 或持久性更弱的本地路径。

worker 不接收 Session writer token、本地 lease 或 OSS 凭证。Session owner 使用已有认证 Store 连接预留 publication；owner 在预留前生成 256-bit 随机、仅限本次 capture 的 bearer token；Java 只保存其 hash，并绑定下节完整身份。预留响应丢失时重试同一个 token。见 [O2a 实施细化](2026-09-27-managed-tool-publication-ownership.zh-CN.md)。Broker 在 v3 execute 前，通过认证且属于 selected-Runtime 的控制操作传递 grant。grant 不加入闭合的 Tool v3 请求体、boot JSON、持久 invocation reference、日志或公开事件。控制操作使用已有 worker bearer/lease 认证，上限 64 KiB，不能执行工具。缺少绑定时 execute 在副作用前拒绝。O2a 提供闭合的不可变 binding/request/grant schema；selected-Runtime grant-install 操作及 HTTP 接线属于 O2d。

grant 仅允许本 publication 的 segment/resource 写入、seal、finish 和 status；不允许 journal 修改、任意资源读取、object listing 或自定义 object key。其有效期不超过当前 owner 授权。原 Shell 执行前及运行期间定期续期，且仅在同一 Session writer generation、activation 和 Runtime binding 仍有效时进行；调用结束或 turn 退出时停止续期。入口及最终 catalog 提交都重新校验这些 fence。fencing 后完成的上传可能留下需保留的候选对象，但不能返回成功发布回执。刷新授权不改变执行身份，也不重执行调用。

| 提议的操作族                                                               | 归属与认证                                                      | 消费方                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| 预留/续期/fence publication；关闭已证明未启动的调用；读取 finished outcome | live Session owner、完整 Session key、当前 Store writer 授权    | Hosted authority 适配器、显式恢复宿主 |
| Publish/seal/finish/status                                                 | 原始 capture 和 Runtime generation、受限 grant                  | 远端捕获适配器                        |
| worker 绑定 grant                                                          | selected Runtime、已有 bearer 和 lease 身份；核对保存的执行映射 | Broker 调度、worker executor          |
| 固定 manifest 范围读取                                                     | persisted Session resource、已授权 owner；核对完整预期执行身份  | Session validator、替代宿主测试       |
| publication 附着到 journal 事务                                            | live Session owner、冻结 catalog root、SQL writer fencing       | 现有 HTTP Session 事务消费者          |

首版内部 reader 可继续要求已有 owner 授权，不形成公开下载 API。tenant/Workspace/Session 范围来自服务端认证状态，并与每个传入标识比较。未知、撤销或 draining 的绑定都不能回落到 primary Runtime 或 Harness 目录。

## 5. 持久身份绑定

在一条不可变 publication binding 中保留下列不同身份：

| 身份                                                                  | 确定含义                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tenantId`、`workspaceId`、Managed `sessionId`                        | 完整 Session 归属；manifest 无 workspace 字段，catalog 和授权必须保留它                               |
| `turnId`、`modelCallId`、`executionCallId`                            | 原始 Session intent 和 function response 配对                                                         |
| Runtime Session ID、`promptId`、Runtime `callId`、`bindingGeneration` | 原始 Broker/worker reference 与目标，可以不同于 Managed/模型标识                                      |
| 原始 `payloadJson` 及其 `requestDigest`                               | #12831 调度重放对 `{toolName,input}` 原始 UTF-8 字节计算摘要，不重新序列化 JSON                       |
| 规范化 input digest                                                   | O1c 的 `managedToolDigest(input)`，用于 Runtime `reference.argsDigest` 和 manifest `invocationDigest` |
| `captureId`、`revision=1`、protocol/capture policy                    | 稳定捕获身份和准入条件；协议或 capture 改变即冲突                                                     |
| 创建方 writer generation、activation ID/epoch、publication ID         | 授权 fence 与保留归属，不能代替 Runtime generation                                                    |

binding 引用已经提交的参数资源，不在 SQL 身份行中复制大型 payload。调度前验证两种摘要。Java 校验精确 payload 字节，TypeScript worker 校验规范化 input digest；两个摘要分字段保存。

O1a 原先将 `manifest.callId` 定义为模型 ID，同时要求它重复 `reference.callId`。本地两者相同，但 #12831 给 Runtime reference 分配独立 UUID。O2a 澄清文档含义并保留 wire 层相等关系：`manifest.callId` 使用原始 Runtime `reference.callId`；`modelCallId` 保存在持久 binding 和 Session checkpoint 中，用于 function response 配对。保持 worker 现有 call ID 冲突保护和独立 Broker UUID；不改写模型历史，不给闭合 v3 请求体加字段。

这会显式调整 O1a 文档中 Hosted 调用的 call ID 含义。O2a 已先更新中英文契约并添加 TS/Java binding fixture，再让实现依赖该语义。现有分段 fixture 仍须原样通过，但不能用来证明此语义修改。Hosted validator 通过不可变映射核对，任一方向替换身份都拒绝；本地保持 ID 相同的行为。该澄清获得 maintainer 认可属于 O2a 退出门禁，不能隐式假定兼容。

现有本地接纳直接比较 `checkpoint.functionCallId` 与 `reference.callId`，并从 `argsRef` 读取原始参数。#12831 保存的参数资源则包裹 `harnessSessionId`、`runtimeSessionId` 和 `payloadJson`。通过范围明确的 Hosted 适配器复用校验规则，不放宽本地 validator 让它隐式接受两种格式。

## 6. Publication catalog 与不可变存储

### 6.1 SQL 记录与状态

新增 publication 记录，按完整 Session 范围和原始 execution/capture 身份唯一。保存身份绑定、当前 grant fence、容量预留、不可变最终 envelope 引用/摘要、精确 manifest 引用、完整引用关系校验结果，以及 receipt 来源映射。确认 ID 前先持久分配，重试保持稳定。

segment 记录按 `(publicationId, streamId, ordinal)` 唯一，保存接收方计算的长度/SHA-256 和物理 object 位置。元数据使用稳定逻辑位置：page `(streamId, firstOrdinal)`、manifest `revision`、最终 envelope、接纳 outcome。同一位置换字节即冲突。保持现有 `ManagedSessionDurableRef`，不添加 provider URL 或凭证。

保留 O2a 的授权 `grant.state`（`OPEN`、`FENCED`、`NOT_STARTED`），另在 publication 状态中增加 `producerPhase`（`OPEN → FINISHING → FINISHED → REFERENCED`），不修改闭合的 grant 结构。`FINISHED` 表示原始最终 envelope 及其声明的完整资源关系已经持久并冻结；可以描述 complete、partial 或 unavailable capture。`REFERENCED` 表示 Session receipt 保留该完整关系，包括 blocked receipt 的诊断 outcome，本身不表示模型可以接纳。`FENCED` 可与 `FINISHED` 或 `REFERENCED` 并存：替代 owner 可读取和接纳冻结结果，但不能恢复旧生产方 grant。`NOT_STARTED` 要求权威未启动证据，且不存在矛盾的已接纳生产操作。

在 segment/resource catalog 行中逐步记录引用成员，finish 时冻结。Session 事务附着一个已校验 publication root；不把所有原始段展开到 `resources[]`，也不上调现有事务限制。blocked 结果保留 publication 已校验的全部数据，包括 partial manifest 没有引用的数据。完整引用关系不能跨 Session/publication，也不能隐式选择最新 revision。

### 6.2 OSS 配置与发布回执

使用从未启用 versioning 的专用私有 bucket、服务端生成的不可变 key，并在每次创建时设置 `x-oss-forbid-overwrite: true`。拒绝 versioning 已启用或已暂停的部署：OSS 文档明确该 header 在这两种状态均不生效。未来支持 versioned 后端时，必须在每次读取中固定 `versionId`，并单独核算重试产生的版本；不能隐式切换配置。参见 [OSS PutObject](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)。

每段使用一次有界 PUT，不使用 multipart 或 append。先在 SQL 预留 catalog 位置与 object key。接收最多 16 MiB，计算长度/SHA-256，上传前拒绝同一位置的内容冲突。读取请求体前先获取服务级并发准入。首版可为每个获准请求保留一段有界内存，但不能保存整条流。

PUT 后重新读取该精确 key，校验长度/SHA-256，再标记 verified 并返回回执。PUT 响应丢失后的重试使用同一 key；已有 object 必须读取校验，绝不覆盖。catalog 响应丢失后返回原 verified 记录。provider checksum 只是补充证明，ETag 或调用方 metadata 均不充分。参见 [OSS 数据校验](https://www.alibabacloud.com/help/en/oss/user-guide/data-verification/)。

所有 OSS 调用都在 journal/catalog 行锁之外执行。短 SQL 事务重新核对身份、状态和 fence，再安装 verified 记录。PUT 成功后的对象可见性不代表 OSS 与 SQL 原子提交；预分配 candidate 记录使该窗口可发现，无需列举 bucket。参见 [OSS 一致性](https://www.alibabacloud.com/help/en/oss/user-guide/what-is-oss)。

未校验或损坏 candidate 继续计费占额并隔离。冲突调用方不能替换或污染正确 verified 段。已发布字节损坏时读取失败，并写入持久隔离标记；后续 publish 不能自动修复该身份。对冲突仅拒绝或保存有界诊断元数据，不无限存储攻击者提供的候选正文。

bucket policy 将读写限制为服务身份，禁止其他 writer 和对仍保留对象的自动生命周期删除，采用部署选定的服务端加密。catalog 保存必要的 key identity。启动检查校验 bucket 配置和私有 endpoint。不复用 `tools/artifact/oss-publisher.ts`：它发布公开 HTML 并覆盖 key，归属与完整性语义不同。

### 6.3 元数据、seal 与 finish

pages、manifests 和 outcomes 使用同一持久 publication 服务。字节不超过 64 KiB 可用 SQL inline，更大的合法资源使用不可变 OSS object。按实际序列化字节应用各 kind 的上限：O1a manifest 64 KiB、page 256 KiB；保留 Tool v3 响应 1 MiB 上限，并提议私有包裹后的最终/接纳记录上限 2 MiB。wrapper 上限不放大 Tool v3 响应。冻结最终 envelope 前完成 preview 限制。

远端适配器提供 `ToolResultSegmentStore` 和 publication 专属元数据 `publish/read` 适配器。不要求所有消费者扩展 `ManagedSessionResourceStore`，也不把现有暂存型 HTTP `publish()` 返回值冒充持久回执。普通 HTTP reader 增加按 catalog 有界读取这些已保留元数据资源的能力。

seal 按顺序扫描不可变 verified 段，核对精确数量/长度及 SHA-256，保存原结果。prefix 在第一个缺口停止。不能从单段摘要推导拼接流的 SHA-256。finish 校验 page 位置、seal、manifest 身份/状态和原始物理结果，再冻结声明的完整关系。格式错误或相互矛盾的声明被拒绝；合法 partial/unavailable capture 可 finish，但不能在 `complete_required` 下被接纳。

seal/finish 可能超过普通 HTTP 请求时限。每个 publication 同时仅接纳一个生产操作；其他调用得到可重试 busy，不分配对象或队列项。持久保存操作 ID、请求摘要、对象 key、绝对 deadline、claim owner 和 epoch。接管只增加 epoch。GET status 不启动工作。最终安装在短事务内检查当前 claim、grant fence、phase 和 deadline；迟到 claim 只能留下计费的候选对象。内存正文丢失后，重试必须提交相同请求字节，除非原 key 已通过校验。被拒绝的 seal 不固化 seal：补齐缺段后，新 attempt 可成功。prefix 新查询从 ordinal 0 重新扫描；只保留有界的当前/最近 attempt 状态。不引入 SHA checkpoint。

普通重放不会恢复已过期 attempt。生产方通过认证后的 `POST /publications/{publicationId}/operations/{operationId}/recover` 显式为原候选、seal 或冻结 finish 开始新的有界验证 attempt。路由归属于原 capture，不归属于 live Session owner 或其他 Runtime。短授权事务递增 epoch 来隔离旧 claim，保留首次绝对 deadline，另外记录恢复 deadline，并清除 claim 以便精确请求重放。当前 attempt 仍有效时，重复恢复不延长期限。slot、请求摘要、对象 key、资源引用、冻结 envelope、前置操作及配额占用均不改变；迟到的旧 PUT 无法安装回执。恢复检查 phase、隔离标记及原 grant；已 fenced publication 不能继续生产。过期 prefix 查询仍保持过期，必须使用新查询 ID。worker 在最初固定观察期限内最多恢复三次；GET status 只读。恢复不重新执行 Shell，也不升级 partial/unavailable 结果。

同一 publication 的 publish/seal/prefix 保持 O1a 顺序。finish 持久保存固定 envelope 和唯一的前置操作，关闭新增写入；允许该操作以原 claim 完成或恢复，然后校验并冻结结果，等待及 OSS I/O 期间不持有 SQL 锁。建立 barrier 前拒绝非法 finish；之后的故障重试原 finalization，不能升级最终 capture。busy、超时、失权和 I/O 故障属于操作失败，不伪装成 O1a 校验拒绝码。操作 deadline 和重试预算有限。HTTP 响应丢失不触发 Shell 重执行。

## 7. 容量与背压

保持 O1c 默认 1 MiB 分段、每条流最多一个 publish 在途、总计 64 KiB 原始预览。保留每流写入队列，包括 Node 在进程退出时恢复 pipe 的情况。worker 还会将同一 publication 的双流生产操作串行化，包括 seal、元数据和 finish，避免正常并发 pipe 撞上 catalog 的单一活跃槽位。可重试 busy 在固定客户端期限内复用原 operation ID 和字节；存储慢时不继续排队新的 chunk Promise。

副作用前预留明确的最大捕获容量，以及独立的生产方 finalization 和 Session admission 额度。O2a 原分配保持不变用于重放比较，另行核算实际保留字节、不确定候选和剩余预留。进入 `FINISHED` 时，只释放已证明未使用的捕获/生产方额度与活跃生产槽位；admission 容量保留到 `REFERENCED`。执行、Session、tenant、活跃 capture 与 gateway 限制均使用必填部署策略值。上线配置须容纳 100 MiB 验收；1 GiB 测试使用单独显式配额。

预留覆盖待完成上传、verified object、inline 元数据和隔离 candidate。PUT 开始前计入预留；重复回执不重复占额。最终冻结且全部在途 candidate 核算完成后，只释放确定未用的 capture/producer 额度。admission 额度保留到 `REFERENCED`，或已证明最终取消且没有待处理 admission/candidate 工作；否则 tenant 满额时可能已完成捕获，却无法保存回执。被 fence 的未完成 publication 保留已用/不确定占额；释放其未用容量前，必须证明后续 publication 或原提交都不可能再到达。lease 到期或 status 查询失败均不是该证明。本阶段不引入自动对象删除或 GC。

调度前配额拒绝不产生副作用。执行中耗尽容量时，停止新增捕获持久化，记录 `quota_exhausted`，以有界内存排空输出，并保留真实执行结果；接纳决定为 blocked。传输/存储失败使用各自分类，不能把 quota 统一改成 `storage_failed`。O1c 当前需要显式扩展该失败原因。如果最终记录也无法持久化，保持 unknown/recovery-blocked，不能伪造回执。

重试有限，复用原操作身份和字节。认证/fencing、schema、conflict 和 digest 失败不按临时故障重试。临时网络/服务错误可在获准 deadline 内重试；失败一旦锁定，最终 partial/unavailable capture 不可升级。持久化暂停时间继续不计入 Shell 退出后排空时限，同时使用独立持久化 deadline 防止无限等待。

## 8. Session 回执、checkpoint 与 ACK

Hosted worker finalize 并持久 finish 原始 envelope，然后报告 Tool v3 `settled`，其中 `deliveryStatus: pending`。worker 不能提交 Session receipt。本地同进程路径可保留注入式接纳；使用显式适配器，不通过方法缺失推断模式。Broker 状态分别记录物理结束和 Session 接纳。只有准入捕获的调用才在生产 transport 接口中增加明确 v3 选择/status/cancel/ACK。

Broker prepare 持久保存显式 v3 选择，并返回原 Runtime binding ID/generation。原执行 reference 保留精确 payload 摘要；v3 请求使用已验证 O2a binding 中的规范化 reference。grant 安装是 start 前独立、已认证的 selected Runtime 操作。缺少或不匹配的预留一律拒绝。现有 dispatch 任务在一次异步 v3 execute 和有界 status 查询期间保持原 claim 与续租。execute 回应丢失只查询 status，不再执行一次；超时或失去 claim 保持 `UNKNOWN`。旧 worker 不能回答时，原身份匹配的持久 `FINISHED` publication 可用于对账 Broker 记录。已 claim 但 HTTP dispatch 前取消的调用持久记录为 `not_started`；worker 仍处于 prepared 时取消也如此，之后不得再启动。安装新 grant 和新执行要求当前 Workspace 授权；已绑定原调用的 status、cancel 与 ACK 在实时 Workspace 授权或 mount 不可用时可使用保存的 binding 和精确原 Runtime lease，不选择其他 Runtime。

Session owner 首先查询已有原始 `tool.receipt`。若不存在，则加载 durable finished publication，验证原 intent/checkpoint/参数绑定、完整身份、物理 envelope、所有元数据摘要和完整 verified 引用关系。不能把 `isToolResultEnvelopeOf()` 的部分状态比较当作完整接纳校验。存储独立验证字节，TypeScript authority 继续负责完整性策略决定。

通过幂等 admission slot 发布版本化 `toolOutcomeRef`，内容保存原 envelope、精确 manifest 引用与 `committed/blocked` 决定。其规范化内容摘要和 admission command identity 在重试间保持稳定。复用现有 `tool.receipt` 事件。在一个 SQL 事务内：核对当前 writer 和 finished root、确认 receipt 与该 root/决定一致、附着完整保留关系、追加 journal、保存原 receipt event sequence。普通小引用仍遵守原限制。决定 wrapper 是 admission attachment，不修改冻结的生产方 envelope/manifest。

`committed` 的 `historyRevision` 是该正数事件 sequence，`resultRef` 指向精确 manifest。`blocked` 的 `resultRef` 与 ACK `historyRevision` 为 null，但 ACK 仍携带原 capture manifest，saved outcome 保留可能存在的 partial manifest。blocked 事件本身仍有正数 Session sequence。不能仅凭回执存在推断接纳。回执附着事务先锁 tenant 容量，再锁 Session head 和 publication，与 O2a 一致；OSS 验证均在事务外，事务内复核冻结根。

Hosted Shell 在接纳原 outcome 的同时冻结有界模型历史投影，包括稳定的 message ID、时间、模型与 function response。按完整 ChatRecord 序列化后的 UTF-8 字节数核对 64 KiB 上限，逐步缩短预览，必要时退化为固定短摘要。回执 committed 后，追加前先查原历史 message，再推进 checkpoint。恢复时重用投影，不重建原执行、manifest 或旧 writer 的不确定事务。本地 O1c 接纳行为保持不变。

私有 Hosted Shell load 仅在一个已接纳 turn 尚未结算、最新 checkpoint 中该批工具全部结算且处于 results_ready，并且当前 turn 以原始冻结的工具结果消息结束、其后没有 assistant 消息时，才可继续模型推理。若最终 assistant 消息已持久保存而只缺 turn 结算，则只补结算，不再调用模型。检查任一边界前先根据回执补齐缺失历史；只有该 turn 尚未结算且原 Runtime 仍可用时，才重试原 ACK。turn 结算后的重开不向可能已释放的 Runtime 发送 ACK，已提交的 Session 回执仍是权威记录。其他未完成状态继续阻断恢复。

未启动调用的 capture 为空，由 owner 幂等关闭其 publication 预留为 `NOT_STARTED`。该路径还写入持久 `tool.receipt`，保存 blocked capture 决定与稳定的工具错误历史，然后解析已证实未启动的工具结果；恢复使用该回执补齐响应丢失的历史写入。要求原执行的权威证据，fence grant，核算已接收操作，再释放未用额度和活跃 capture 槽位。存在矛盾的 start/publication 证据时拒绝关闭。prepared cancellation 和明确的调度前拒绝可以提供证据；超时、lease 到期或查不到 status 均不能提供。该路径不能发送 Tool v3 capture ACK。

批次中后续预留失败时，先停止 grant 续约，取消所有已 prepare 的 Broker 调用，再请求 owner 关闭每个已确认但未使用的预留。关闭仍须通过服务端权威未启动证明；状态未知的执行保留容量，并使该轮保持恢复阻断。

append 异常后，当前 TypeScript authority 已进入 write-failed。通过受支持的归属路径关闭/重开并读取原 journal，不在同一对象上盲目追加。替代 writer 不能用新 token 重放旧事务：当前 Java duplicate-commit 规则要求原 writer 和 record identity。先读取并使用已有 receipt；仍需新增 receipt 时，由新的合法 owner 对同一 durable finished publication 做新的 fenced admission，通过唯一性约束避免重复回执。

当前 cold-load 入口尚不会执行这次新接纳。如第 10 节所述，在实现并验证专门的恢复入口之前，Session 继续保持恢复阻断。

只依据保存的 committed 决定推进 `results_ready`。重放原 manifest、outcome reference 和 receipt sequence，不能恢复时生成新 UUID 资源。相同 ACK 仅发送给原来的活跃 Runtime generation。替代 generation 从 Session 读取结果，不接收或重执行旧调用。取消、进程排空与 Workspace release 条件独立于回执交付。仍运行孤立进程的通用接管不属于本轮 O2。

W0e 将 Broker 执行标记为 `ABANDONED` 后，其 ledger 保持终态，不伪造物理结果。若原 publication 独立达到 `FINISHED`，Hosted 可在当前 Session writer 授权下读取它，逐项对比完整的原预留 binding，然后沿现有 Session 接纳与回执路径推进。完成数据缺失、损坏或身份不符时继续阻断。此路径不重新启动执行、不向替代 Runtime generation 发送 ACK，也不释放 W0e 的物理 writer pin。

## 9. 固定版本读取

内部 reader 接收不可变 `manifestRef`、完整 expected identity、`streamId`、`offset` 和 `length`，在完整 Session 授权下解析原 catalog binding。返回最多 16 MiB 精确字节；非法边界直接拒绝，不截断。只有合法边界允许零长度读取。

校验 manifest/page 序列化摘要、身份、page 位置与 segment catalog 关系。每个涉及的段均流式读取并校验整个不可变 object，只保留请求交集；全部校验通过后才返回 Buffer。元数据遍历受 O1a page/manifest 上限约束。对于已准入的 `body.ref`，流式校验整个引用 object，只保留请求范围；首个 Shell 生产方仍使用 pages。普通整份 Buffer 元数据 reader 不能用于大型 body。

原始二进制读取不做文本解码或透明内容变换。不能假设 Range 响应正确：OSS 对非法范围可能返回完整 object。首版适配器对涉及的每个 segment/body 使用完整 object 流式读取，并在本地约束预期长度；后续 range 优化必须提供等价完整性证明。参见 [OSS GetObject](https://www.alibabacloud.com/help/en/oss/developer-reference/getobject)。

接纳后 object 缺失或改变时读取失败，不回退 Runtime 本地文件、最新 manifest 或其他版本。之前提交的历史仍是事实，但资源不可读时阻止使用该结果；检测到损坏不允许改写原结果。

## 10. 恢复与生命周期

| 故障窗口                                    | 必须行为                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| start 前 intent 或 publication 预留失败     | 无工具副作用；只保留/取消原 prepared reservation；已分配 publication 容量只有在证明 not-started 后才关闭 |
| object PUT 成功，catalog 校验/响应前失败    | 根据预分配 candidate 定位，校验精确字节并返回原回执；不确定存储继续占额                                  |
| worker 在 EOF/seal 前死亡                   | 保留 verified prefix；没有独立证明时执行仍未知，不能把字节推断为 settled success                         |
| 有 manifest，没有 durable finished envelope | 保持 unknown/blocked；object 扫描或 manifest 状态不能补足缺失的物理结果                                  |
| finish 已提交，响应或 worker 丢失           | 读取原 finished envelope/ref，按原 intent 重新核对；不创建新执行                                         |
| receipt commit 响应丢失                     | 重开 authority 并读取原 journal；已经提交则复用原 outcome/ref/sequence                                   |
| receipt 已提交，checkpoint 前失败           | 使用 committed receipt 推进；partial/unavailable capture 仍阻断，已证实未启动的调用按保存的工具错误结算  |
| checkpoint 已提交，ACK 前失败               | 向原 generation 重发相同 ACK；该 generation 已不存在则保留 Session 结果                                  |
| PUT 期间 writer/activation fence 改变       | 停止新 publication；迟到 candidate 继续 hold，catalog 安装失败；owner 改变不能证明 Shell 已停止          |
| object 损坏/缺失，或 Java/OSS 不可用        | 读取/接纳失败；保留已知物理结果、归属与容量不确定性；不降级执行                                          |

替代宿主使用全新文件系统，只依赖持久 SQL/OSS 和受支持的 Session writer 获取流程。恢复测试必须区分正常 writer seal 与 lease 到期/fenced takeover，单纯杀进程不能证明合法接管。合法新 owner 可接纳 finished publication，但不会自动接管或续期旧 generation 的未完成上传。公开 cold-load 拒绝行为保持，直到专门恢复入口被实现并验证。

加载已提交结果时，在挂载 Hosted Session 或返回成功之前确认 Workspace acquisition。确定性的 `workspace_busy` 或 `workspace_unavailable` HTTP 409 仅关闭临时挂载，并返回该可重试拒绝。后续 load 继续使用同一持久回执、history 和 checkpoint，不产生新执行。回执对账及 ACK 可能已经在 acquisition 前完成；这些事实保持权威且幂等。未知 acquisition 失败仍需恢复，不允许新 prompt 绕过原 continuation。

正常关闭按顺序停止新执行、排空执行/finalization、关闭远端适配器、停止续期、依据已有停止证据释放 Workspace activation/ownership，最后 seal Session writer。失去归属不允许继续 catalog 写入。不需要后台 watcher 或无限 retry job：操作工作有界、状态持久可观察，只在授权有效时恢复。

## 11. 实施切片与消费者

| 切片                    | 具体交付                                                                                           | 退出门禁                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| O2a：契约与归属         | Publication/grant schema、经评审的 O1a call ID 澄清及映射、新 SQL 迁移、容量预留、闭合内部操作契约 | 错误 tenant/Workspace/generation、摘要变化在副作用前拒绝；v2/本地行为不变；Hosted 新语义经评审 |
| O2b：远端持久化         | 私有 OSS 适配器、幂等 segment/metadata 回执、seal/finish、冻结完整关系和内部范围读取               | O1a 序列及真实 OSS 持久性、限制、响应丢失、损坏、进程替换测试                                  |
| O2c：Session 接纳与对账 | Hosted authority 适配器、原子附着完整关系、原回执查询/checkpoint/ACK 恢复                          | complete-required 决策矩阵与全部 commit 窗口在真实 SQL 通过；不重复副作用或引用                |
| O2d：独立进程接线       | Broker v3/grant binding、远端 worker publisher、接入届时 Hosted 工具轮次                           | 真实 worker 和不同宿主读取证明；100 MiB/1 GiB、故障/归属回归；仅私有门禁                       |

各切片按阶段 commit 提交到同一个 Draft PR。O2a 不开放 Shell。复用已合并 #12831 的 Hosted 文件工具循环和 O1c publisher/receipt 接点，不创建第二套 Hosted 循环。公开能力启用仍须在上述验收门禁通过后单独决定。

| 预计修改区域                                   | 直接消费者与回归边界                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/managed-runtime/`           | 远端 segment/resource 适配器、共享接纳校验、HTTP Session commit/reader；保持本地 O1b/O1c 和通用资源调用方可用              |
| `packages/cli/src/serve/`                      | worker publisher 注入、grant binding、v3 pending result、Hosted owner 接线；默认 no-tool 与 file-only profile 不变         |
| `packages/sdk-java/managed-agent-server/`      | Store/controller/catalog/OSS 适配器、迁移和 Workspace transport；兼容现有 inline Session 事务/恢复                         |
| `packages/sdk-java/runtime-broker/`            | transport 接口、延迟调度携带原始 v3 binding 与 ACK；普通 v2 调度不变                                                       |
| `packages/core/src/managed-runtime/contracts/` | 新私有 publication/binding fixture 及现有 O1a conformance fixture；TS/Java 的 call ID 映射、闭合字段、限制和错误优先级一致 |

这些切片不涉及 WebShell 修改。这是跨 package 的 core 功能工作，遵循仓库 maintainer 知会/评审门禁。本设计不授权合并或绕过门禁。

## 12. 验证与证据

### 12.1 实施后必须完成的验收

使用真实 Shell 子进程、独立 worker/owner/service 进程、真实 SQL 和专用私有 OSS 测试 bucket。本地可注入故障的 object-store double 用于快速测试，不能证明 OSS 语义。每个故障记录原始完整身份、字节、副作用次数及保留状态。使用独立 Session/Workspace key 和 prefix，不删除生产对象。

| 分组       | 必须证明                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约       | O1a 的 28 组/136 步分段序列原样运行异步适配器；错误 tenant/Workspace、各身份字段、两种不同摘要、不同模型/Runtime call ID；v2/v3 冲突在副作用前拒绝                                                                                     |
| 元数据     | 最大合法 page、超过 64 KiB 的 outcome、实际序列化溢出、短而稳定的 resource ID、缺失/错位 page 及引用关系；不依赖 staged 内存                                                                                                           |
| 字节与内存 | 增量 100 MiB 与 1 GiB、二进制/NUL/非法/跨 chunk UTF-8、双流和尾部范围；独立流式 hash oracle；固定并发和慢存储下客户端/服务端队列及 RSS 有界                                                                                            |
| 进程语义   | EOF 与 exit、继承 pipe、取消、Node 退出时恢复写入、未 EOF 的 finish、finish 后释放 buffer；quota/I/O 失败保留物理结果                                                                                                                  |
| 配额与上传 | 预留失败零副作用；启动前拒绝/取消恢复未用额度并拒绝旧 grant；finish 后仍保留 admission 配额；产生一次副作用标记后执行中耗尽额度；同 ordinal 冲突、PUT/readback/catalog 响应丢失、损坏、bucket 模式改变、并发容量竞争、fence 后迟到写入 |
| 接纳与恢复 | 合法 complete 提交；partial/unavailable/无 manifest/未 seal/错身份/错摘要阻断；已证实未启动的调用按回执结算；重读摘要校验、receipt 响应/checkpoint/ACK 丢失、改变 ACK 拒绝；精确复用 refs/sequence                                     |
| 宿主替换   | 原 Runtime 磁盘不可访问，合法 writer 交接后在另一宿主重开，读取准确 100 MiB 尾部；异常丢失保持 unknown，不假定孤立进程可接管                                                                                                           |
| 兼容性     | TS/Java 真实 v3 互通，原 v2/禁用门禁/W0c activation，HTTP inline 事务，本地 O1b/O1c，Hosted no-tool/file-only profile                                                                                                                  |

### 12.2 已完成验证与待补证据

固定基线上的两项现有 core 定向测试确认了 HTTP 暂存的 64 KiB 限制。实现后的 core 与 CLI 定向测试已经通过，其中原 O1a 的 28 组、136 步通过异步 HTTP 适配器及以 ledger 为后端的测试入口运行；Java H2 catalog 测试覆盖不可变对象、接纳、固定范围、故障注入，以及增量生成的 100 MiB 和 1 GiB 数据。Broker 模块验证、Server 定向验证、仓库 build/typecheck/bundle 与本地 MySQL 8.4.11 迁移/集成运行记载于配套 E2E 报告。最终 Server 全量测试仍遇到一个与本分支无关的主线同毫秒 Turn 排序失败，不能将该次全量运行计为通过。这些测试不能替代真实 OSS bucket 或第二宿主证据。

完整验收矩阵仍缺真实 OSS 的禁止覆盖/versioning 行为、独立 worker/owner/service 进程故障、O2 专属 MySQL 并发竞争，以及原 Runtime 磁盘不可达时的合法跨宿主恢复。PR 可以进入 Ready 状态接受维护者评审，但在这些检查和部署决定完成前不得启用私有 Shell profile。mock、本机进程、真实 SQL、真实 OSS 和不同宿主证据分别报告；普通 CLI 对话不能验证此私有服务。

### 12.3 评审反馈加固

producer 在状态查询显示原操作未知后，使用相同 operation ID 和字节重试；明确的存储 `AccessDenied` 或配额拒绝立即失败。服务端对终态请求的原始字节计算摘要，并拒绝非整数或溢出的范围坐标。admission 与回执响应丢失时均有界重放完全相同的请求；Hosted admission 的历史 ID 和时间取自原始持久 intent，使重复接纳具有稳定内容。显式 fence 及后续 reserve 对过期 grant 的扫描只释放未用的 capture 与 producer 额度，已用和不确定的候选字节继续计费，已完成 publication 的 admission 额度仍保留。私有 Shell 预览有界保留开头与末尾；首次收到 stderr 时，从默认 64 KiB 预算中预留 8 KiB 保存最近的 stderr，并修正截断 UTF-8 尾部的字符边界。共享预览中已出现的错误行也可能在最近 stderr 区块中重复。写入模型历史前仍移除 worker 本地 spill 文件指令。如第 10 节所述，本切片仍不包括“admission 已准备、receipt 尚未提交”后的自动 cold-load 续跑；该 Session 保持恢复阻断，不能伪造回执。

## 13. 启用前的部署决定

- 确认私有 OSS region、endpoint、从未启用 versioning 的 bucket 和加密身份。若环境要求 bucket versioning 或禁止 worker 访问 Java，启用前修改存储/传输配置，不隐式降低保证。
- 提供测量后的字节/并发限制、publication/verification deadline 和保留运维方式。没有 GC 时已用及隔离字节继续占额，运维必须能观察容量；自动回收后续设计。
- 启用前确认 Hosted file/Shell bridge 依赖及其 payload/reference schema。通用 W0e 接管和自动 cold-load continuation 保持独立门禁。
- 启用私有 Shell profile 前，对传给 `read_file` 的 Workspace 绝对路径返回有界函数错误，或在验证归属后映射成 Workspace 相对路径；沿用的文件工具 profile 目前会因该输入终止整个回合。

这些部署选择未满足前，不能宣称已部署跨宿主保证或开放公开 Shell 能力。
