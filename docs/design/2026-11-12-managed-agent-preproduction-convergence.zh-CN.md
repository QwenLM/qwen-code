# Managed Agent Server 投产前收敛

[English](2026-11-12-managed-agent-preproduction-convergence.md) | [简体中文](2026-11-12-managed-agent-preproduction-convergence.zh-CN.md)

- 状态：**提案** —— 待 maintainer 评审。已 rebase 到当前 main（tier-1 收敛合并后）：#17058（OSS 读路径去探针、object-storage 解耦、K1 删除、切片1 的 defaultCandidate 修复、统一池 strict mode）、#17064（单可执行 jar——取代下文「保留 classifier jar」的旧框定；运维工具以 admin 子命令形式保留）、#17047（pack-aware 读取方）、#17044（棘轮裁剪）。切片1 修复已经 #17058 落地，其嵌入回归断言在此保留；切片2（dead-tag 发布修复删除）在本 PR 实现（待评审）；切片3 已放弃（见下）；余切片 4–8。
- 日期：2026-11-12
- 范围：`packages/managed-agent-server/**`、其打包/发布脚本、web-shell 生成客户端，以及 Java SDK 表面。
- 关联：修订 [Managed Agent Server Maven modules](2026-10-29-managed-agent-maven-modules.md) 的模块矩阵；在 PR #17044 的 verification 棘轮裁剪基础上推进（其设计文档 `2026-11-12-managed-verification-ratchet-trim.md` 随该 PR 落地）。

## 问题与动机

一次七维过度设计评审（会话 `2667d1f1`，2026-11-12）发现：`managed-agent-server` 在 14 个 Maven 模块上承载约 41.2 万行 Java，测试约为生产代码的 1.8 倍。主要代价不是某个单独的坏决策，而是累积的结构性仪式：单实现接口镜像、零依赖隔离收益的微模块、两套 HTTP 服务器、平行的 API 表面、按迭代切分的 fat JAR，以及钉死注释与已删除表的源码文本棘轮。

评审的第 3 档建议（「中长期演进克制」）假设系统已在生产运行，因此把每项改动都框定为「在不破坏存量部署、数据或已发布产物的前提下止血」。**该前提已不成立。** maintainer 已确认：

1. 服务**未投入生产**，没有需要保护的活状态。
2. **已发布的 `managed-runtime` 产物（v0.26.x）无人使用。**
3. 宿主嵌入**是真实且承诺的用法**（见「已锁定决策」）。
4. 两套公共 API 表面中目前只应保留**一套**。

没有历史包袱后，正确的框架从「克制」切换为「重新设计收敛」：若干此前被判为承重的结构可以移除，而单一 V1 schema 基线正处于最便宜的编辑窗口。本文记录可移除项、必须存活项，以及一份让每步都可独立验证的分片计划。

## 现状（基于当前 main 核实）

以下数字来自全仓扫描；受 tier-1 合并（#17058 / #17064 / #17075）影响的数字已对合并树重测。

- **接口。** 136 个生产接口名（97 个顶层文件）；仅 9 个有多于一个生产实现。全部 41 个 `*Store`/`*Repository` 接口恰好只有一个生产 JDBC 实现（35 个直接实现，6 个经 `ManagedSessionStore` 角色接口继承）。生产中不存在 `InMemory*Repository`。`ToolPublicationObjectStore` 是真 SPI（8 个测试 fake，被 5 个子系统复用）。
- **Settings 镜像。** `ManagedAgentSettings`（20 个接口，252 行）加 `SshSettings`（3 个）= 23 个对 `ManagedAgentProperties`（1,076 行，21 个嵌套类）的只读镜像。62 个生产文件 import `ManagedAgentSettings`。`configuration-descriptions.json` 生成配置参考文档；`release-managed-agent-reference.yml` 以 `generate-managed-agent-configuration-reference.mjs --check` 作为两份已提交页面的漂移门禁。
- **结构性根源。** `ModuleArchitectureTest` 强制 `control-plane`/`persistence`/`runtime-*` 只依赖自身加 `contracts`；`ClassSizeRatchetTest` 强制拆分 `persistence`/`runtime-broker` 中 ≥800 行的类（全局上限 2,549，单调不升）。拆类后碎片需要跨模块可见，就制造出一个新的 `contracts` 接口。镜像是这两个门禁的产物，而非纪律问题。
- **API 表面。** `SurfaceRegistry` 在 Public、WebShell 与内部表面上共枚举 234 个路由常量。两套公共表面是能力分工，而非同构镜像：Public 偏读/管理（`PUBLIC_TURN_GET/LIST/EVENTS`、workspace list/get），WebShell 承载交互写侧。至少 24 个 WebShell 能力名没有 Public 对应（`TURN_SUBMIT`、`TURN_CANCEL`、`SESSION_APPROVAL`、`SESSION_MODEL_CHANGE`、`WORKSPACE_CREATE/REGISTER/FILES_*`、`TRANSCRIPT`、`EVENT_STREAM`……）。web-shell UI 消费生成客户端（`packages/web-shell/scripts/generate-managed-agent-api.mjs`）；Java SDK 暴露 Public 操作；README 在 `/v1/agents` 上文档化业务宿主流。
- **HTTP。** `RuntimeBrokerHttpServer`（1,063 行）是第三端口上的手写 JDK `HttpServer`；`csi-retirement:worker-authority` 同时注册在它和 Tomcat internal connector 上。
- **preflight。** 5 个文件共 4,393 行生产代码，加 6 个文件共 5,513 行测试（合计约 9,900 行），只服务 `--check`：`ServerEnvironment`（1,095，:229 处 `StackWalker` 格式嗅探）、`ManagedAgentPreflight`（2,486，:794 处 `YamlWalk` 注释 AST）、`HarnessBrokerUrl`（410，与 `packages/cli/src/serve/managed-runtime-broker-url.fixtures.json` 共享的 WHATWG 子集）、`ServiceAccount`（194，用户态 `namei`）。
- **打包。** 仅剩单个 `exec` repackage（#17064 删除了 6 个 classifier fat-JAR execution；运维工具以 admin 子命令形式保留）。maintenance 家族 13 个类 / 1,402 行，被 `scripts/package-managed-agent-reference.mjs`、e2e 测试与 README 引用。
- **棘轮。** `verification/pom.xml` 831 行、17 个 profile、约 435 行近乎重复的 Failsafe XML。v0.26.5 pom 钉死（`scripts/patches/managed-runtime-v0.26.5-verification.patch` 及其元测试）已被 dead-tag 发布修复清理删除，故 profile 去重不再被钉死阻塞。`ManagedSchemaCatalog`（630 行；`managedschema` 包共 1,198 行）在启动时用对缩进敏感的正则重解析规范 DDL。
- **是注册 provider，而非死代码。** 全部 5 个 `runtime-*` 模块都经 `META-INF/services` 注册 `RuntimeProviderFactory`，因此它们是 ServiceLoader 动态发现的 provider，而非静态接线的 bean。`runtime-kubernetes`（kind `kubernetes-workspace`）是 resident-workspace / CSI provisioner（`KubernetesRuntimeProviderFactory`），积极开发、承重；`runtime-external` 注册 `ExternalRuntimeProviderFactory`（`external-scratch` 功能完整，`external-workspace` 刻意 fail-closed）。早先的 K1 scratch provisioner（`KubernetesRuntimeProvisioner`）与 `JdbcRuntimeBrokerSchema` 别名确属死/冗余，已删除（#17058、#17075）。移除剩余 provider 是能力决策，而非清理。

## 目标

- 移除仅为过去的部署、发布或数据而存在的结构，以及唯一目的是内部仪式的结构。
- 把模块/接口表面收敛到承诺的嵌入契约与单一公共 API 实际所需。
- 把 `--check` 简化为对规范输入的 fail-fast 校验。
- 让每步都可独立评审与验证；按模块验证策略把完整门禁留在 CI。

## 非目标

- 不改动正确性不变量（见下）。
- 无基准不做性能驱动的存储改动（EVENT fact 台账与 OSS 热路径有读侧正当性；「无历史包袱」不等于「无需测量」）。
- 不加新功能，不加超出已锁定决策所需的新扩展点。
- 本文不做实施；它是供评审的计划。

## 已锁定决策

| #   | 决策                                                                                                                                                                     | 后果                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| D1  | 宿主嵌入是真实的。上层代码使用 `@Configuration(proxyBeanMethods=false)` + `@Profile("qwen-embedded")` + `@Import(ManagedAgentConfiguration.class)`（该类位于宿主仓库）。 | `contracts` 作为纯净、无 Spring、可嵌入的 API 模块存活；SPI 留白与 bean 隔离保留。                              |
| D2  | 只保留一套公共 API 表面。                                                                                                                                                | 保留 **Public**；把交互能力集吸收进来；迁移生成的 web-shell 客户端；删除 WebShell 臂。                          |
| D3  | 已发布的 `managed-runtime` 产物无人使用。                                                                                                                                | v0.26.5 发布修复补丁及其 pom 钉死元测试可删，解锁 profile 去重。                                                |
| D4  | 宿主（`data-agent`）改动已获授权（「上层可以改」）。                                                                                                                     | 重构无需保留宿主 import 的全限定名；内部包/类可重命名或重组，宿主同步迁移。宿主耦合是协同迁移工作，而非硬约束。 |

### 为何留 Public 而非 WebShell（D2）

Public 已被 Java SDK、OpenAPI 契约与 README 业务流锚定。反之留 WebShell 需重写 OpenAPI 规范、改 Java SDK 指向。留 Public 的代价是把约 24 个交互能力设计进公共契约；投产前是做这件事唯一的便宜窗口。

### 宿主耦合（已对 data-agent release 分支核实）

核查上层仓库（`data-agent`，release 分支 `releases/20261112155816552_…`，提交 `6897e7fc5`）纠正了两个早先假设：

- **宿主不读 `ManagedAgentSettings`。** `managedagent.settings` 包零 import。23 个 Settings 镜像可删而不破坏宿主。
- **但宿主依赖广泛的内部表面，而非仅 contracts SPI 与 DTO。** 29 个宿主 main 源码文件 import `com.alibaba.qwen.code.*`，包括 `config.ManagedAgentProperties`（在 `ManagedRuntimeService` 与 workspace/business 配置中按类型注入）、control-plane 服务、`persistence.*` 与 `repository.*` 类、`runtimebroker.*` 内部类，以及 **Public 与 WebShell 两套 `ApiModels` 记录**（`ManagedRuntimeController`、`ManagedRuntimeService`）。

后果（有了 D4，这些是已授权的迁移任务，而非阻塞项）：

- **D2 / 切片 4：** WebShell 并非只被生成的 web-shell 客户端消费；宿主在进程内使用 WebShell 模型记录。删除 WebShell 臂需要在 Public 获得交互能力后，同时迁移宿主与 UI。宿主改动已获授权（D4），因此这是协同的跨仓迁移，而不是保留 WebShell 的理由。
- **切片 5：** 因为宿主可改（D4），模块合并可以自由重命名包、搬移类（含 `ManagedAgentProperties`），同步更新宿主 import。上面核实的 import 清单即迁移清单。唯一的时序规则是编译期：宿主依赖 qwen-code 构建，因此每个 qwen-code API 改动必须与对应的宿主更新一起落地。

## 必须存活的不变量（非历史包袱）

这些防止真实故障模式，或是文档化的模块评审规则；每个切片都保留：

- lease fencing、UNKNOWN 对账、runtime attestation（boot id / inode）。
- journal 摘要链、幂等回执、replay floor，以及 CHAR(64) 哈希键索引层（`session_scope_key` 前缀谓词承重；移除即全 lane 扫描）。
- 运行时锁序测试（`StoreLockTraceTest`、`*LockContractMySqlIT`）——行为，而非文本。
- 对 legacy、partial、foreign catalog 的拒绝；不用 Flyway repair/history 编辑绕过拒绝（模块 AGENTS.md）。
- 每条保留路由上的租户隔离、actor 校验、Workspace 授权与内部凭证；持久化 SQL 准入/恢复带 writer lease/generation 校验。
- 存活表面的 OpenAPI 契约、`SurfaceRegistry` 与契约测试（`ManagedAgentApiContractTest`、`SurfaceRegistryGateTest`）保持一致。
- 嵌入隔离：`defaultCandidate = false`、`@ConditionalOnMissingBean` 退让、`@Autowired(required=false)` SPI 点。

## 提议方案：八个切片

按依赖与风险排序。每个切片是独立 PR（或小 PR 系列），各有聚焦验证；完整门禁归 CI。

### 切片 1 —— 嵌入隔离修复（棘轮裁剪另行跟踪）

- 修复 `sessionWorktreeScheduler` 漏标的 `defaultCandidate = false`（真实嵌入 bug：它会竞争宿主按类型注入的 `TaskScheduler`）。**已实施并本地验证**：`ManagedAgentEmbeddingTest` 8/8（含新增 `dedicatedSchedulersAreNotDefaultCandidates` 回归断言），全部 15 模块编译通过，Checkstyle（两个 execution）与 SpotBugs 绿。
- verification 棘轮裁剪（Javadoc pin、锁清单、旧表 TSV；−1,301 行）是已合并的 PR #17044；此处不重复。
- 原「死代码」删除目标已重新核实：K1 scratch provisioner（`KubernetesRuntimeProvisioner`）与 `JdbcRuntimeBrokerSchema` 别名确属死/冗余，已删除（#17058、#17075）；剩余 `runtime-kubernetes`（`kubernetes-workspace` CSI）与 `runtime-external` provider 是注册、承重能力，非死代码。移除剩余 provider 是独立的能力决策。

### 切片 2 —— 发布修复删除（需 D3）；打包重新归类

- **已完成 —— 旧 tag 发布修复删除。** 删除全部 3 个修复补丁（`v0.26.3-tests`、`v0.26.5-javadoc`、`v0.26.5-verification`）、两个条件 workflow 修复步骤（`RELEASE_TAG == v0.26.3 / v0.26.5`）及 `managed-runtime-release.test.js` 中对应元测试（−396 行）。它们仅在重发死 tag 时运行，删除不影响未来发布。此举放弃 v0.26.3 managed-runtime 回填（锁定决策 D3）；`managed-runtime-0263-test-repair` runbook 相应退役。禁止关闭 Javadoc 门禁的全流程守卫保留为独立测试。验证：发布元测试 48/49（唯一失败是临时 fixture 中 `semver` 解析的既有环境问题，与本改无关），Prettier + ESLint 绿。
- **推迟 —— profile 去重。** 删除 pom 钉死元测试已解锁 17 个 verification profile 共享 Failsafe XML 的去重，但那触及 CI lane 定义，留作独立的谨慎改动。
- **重新归类 —— 运维工具不是死代码。** 12 个离线操作员入口（recovery、migration、CSI 操作、lease recovery）被 `package-managed-agent-reference.mjs` 编目、被 `managed-agent-server-e2e.test.js` 与 `integration-tests/helpers/hosted-operator-recovery-driver.ts` 真实调用、并在 README 文档化。这些工具能力予以保留；#17064 已把它们的打包收敛为单一 exec jar 经 admin 子命令分发（删除冗余的 classifier fat JAR），工具本身不变。

### 切片 3 —— HTTP 统一：按原框定不可行（放弃）

调查表明独立的 `RuntimeBrokerHttpServer` 是刻意设计，而非冗余仪式：

- 它由 `EmbeddedRuntimeBroker`（宿主嵌入的 broker，独立于 internal Tomcat connector）与 `WorkspaceCsiRuntimeMain` 启动；后者是裸的独立 `main`，**没有 Spring 上下文、没有 Tomcat**。CSI runtime 进程无法「把路由挂到 internal Tomcat connector」，因为它根本没有 Tomcat。
- broker 面有自己的安全/生命周期：单一全局 Bearer token、默认仅 loopback、有界独立线程池、8MB 请求上限——不同于内部表面的 writer 凭证认证与 `InternalSurfaceConfiguration` 路由过滤器。
- `csi-retirement:worker-authority` 的「重复」是两个端口上的两套不同实现（Spring `WorkspaceCsiApplicationController` → `store.workerAuthority`；broker → 按会话注册的 readback），不是简单去重。

统一需要给独立 CSI runtime 加 Spring/Tomcat、强制每个嵌入者启用 internal connector、调和两套认证模型、迁移跨语言 worker broker URL——是重大重设计，而非删 1,063 行。**按原框定放弃。** 若仍想要单一内部监听器，需独立设计；否则双服务器保留。

### 切片 4 —— 单一公共 API 契约（需 D2；最大设计任务）

- 把交互能力集（turn 提交/取消、审批、模型切换、workspace 创建/注册/文件、transcript、事件流……）设计进 Public OpenAPI 契约。
- 更新 `SurfaceRegistry` 与 `managed-surface.txt`；运行 `ManagedAgentApiContractTest` 与 `SurfaceRegistryGateTest`。
- 重生成 web-shell 客户端（`npm run generate:managed-agent-api --workspace=packages/web-shell`），迁移 UI 消费者，**并迁移宿主进程内的 WebShell 模型使用**（data-agent 的 `ManagedRuntimeController` / `ManagedRuntimeService`），然后删除 WebShell 的 record、控制器与平行编排臂。删除以两个消费者都脱离 WebShell 为前提（见「宿主耦合」）。
- 验证：契约 + surface 门禁；受影响 web-shell 消费者测试；跨语言改动的根 build/typecheck。

### 切片 5 —— 模块合并（修订 Maven-modules 设计）

- 合并 `control-plane` + `persistence`；把零隔离的 `runtime-*` 微模块归并进 `runtime-broker`/`adapters`。`contracts`（纯净）与 `server`（装配，暴露 `ManagedAgentConfiguration`）保持独立。
- 当接缝变为模块内部时删除约 33 个纯 JDBC 镜像接口；通过把 `ManagedAgentProperties` 搬入合并后的 core 模块消除 23 个 Settings 镜像（core 可用 Spring；contracts 保持纯净）。把 `ModuleArchitectureTest` 更新到新矩阵，并修订 `2026-10-29-managed-agent-maven-modules.md`。
- 宿主耦合（已核实；D4 授权宿主改动）：上层不读 `ManagedAgentSettings`，故镜像可删；它按类型注入 `ManagedAgentProperties` 并 import 许多内部包。有了 D4，合并可自由重命名包、搬移类，同步更新宿主 import（迁移清单见「宿主耦合」）。
- 验证：完整反应堆构建；`ModuleArchitectureTest`；聚焦消费者测试；嵌入冒烟（宿主 `@Import` 仍能装配）。

### 切片 6 —— preflight 简化

- 在配置入口要求规范 `http(s)://host:port`；删除 WHATWG 子集与共享 URL fixture（或把校验挪到 Node 侧）。用 Spring ConfigData API 替换 `StackWalker` 格式嗅探；保留按值秘密检测（URL userinfo 口令与任意键下的 `?password=`/`?token=` 参数），只删除 YAML/注释 AST 与路径机器——仅按键名扫描会漏掉如 `spring.datasource.url` 中的凭据、丢失 `chmod 600` 告警；以服务身份实测 `ServiceAccount` 访问，而非 root 用户态 `namei`。
- 理由：URL parity 契约只在接受任意 URL 写法时才需要；投产前可以拒绝它们。
- 验证：对规范输入重写的 preflight 测试；`--check` 冒烟。

### 切片 7 —— schema 重设计（时效敏感）

- 利用单一 V1 原地编辑窗口（模块 AGENTS.md：首次正式发布前原地编辑 V1；不加 V2+）。在有益处重设计表。
- 用健壮解析器或 Flyway 原生元数据比对替换对缩进敏感的正则 catalog，**同时保留对 legacy、partial、foreign catalog 的拒绝**。
- 保留全部 C 类不变量（摘要链、哈希键索引层、fencing）。
- 验证：对改动的 SQL/事务/恢复行为跑真实 MySQL `mysql-integration` 用例；catalog 拒绝测试；基线变更后重建开发 catalog。

### 切片 8 —— 协议代际裁剪：并非死膨胀（按原框定放弃）

v2/v3/v4 三代不是冗余演进层，各服务一个不同的活跃子系统，且 TS worker 三代都说：

- **v2**（`/internal/managed-runtime/v2/*`）：external-runtime 发布（`managed-external-publication.ts`）。
- **v3**（`/internal/managed-runtime/v3/*`）：hosted-harness 的 bootstrap、activation、shell、extensions、context 控制（7 个 TS 文件）。
- **v4**（`/internal/managed-runtime/v4/*`）：最新工具执行（`managed-runtime-tool-v4-routes.ts`，CSI workspace 工具）。

裁剪任何一代都会破坏一个活子系统。把它们合并为单一协议是跨多个 runtime 类型的重大跨语言重设计，而非删除。**按原框定放弃。** 统一协议若要做是独立设计；多版本表面是功能多样性（external / hosted / CSI），不是仪式。

## 设计决策与理由

- **保持 `contracts` 纯净且独立。** 它是让 D1 安全的宿主编译边界；其 ArchUnit 纯净规则保留而非移除。
- **镜像经搬家消亡，而非一纸命令。** Settings 镜像存在是因为 `control-plane` 看不到 `server` 的 Spring properties。合并模块并搬走 properties 类，诚实地消除该接缝。
- **类大小棘轮可放宽。** 它是历史 store 拆分的产物，也是接口增殖的结构源；没有生产时可移除或放宽（决策推迟到切片 5）。
- **一套表面，能力完备。** 存活的 Public 表面必须是今日两套表面能力的超集，而非子集。

## 约束

- 遵循模块验证策略：JDK 21 / Maven ≥3.8.9，共享 10 分钟预算内的聚焦本地测试，完整门禁归 CI，SQL/事务/恢复改动用真实 MySQL，跨语言改动用根 build/typecheck。
- 保留模块 AGENTS.md 的库复用、租户隔离、持久化 SQL、lease/generation 评审规则。
- 同一改动内更新本设计与被修订 Maven-modules 设计的两个语言版本。

## 风险

- **切片 4 范围蔓延。** 设计完备的交互公共契约是最大任务；把它限定在实测能力缺口内，抵制加投机端点。
- **切片 5 波及面。** 模块合并触及大量文件与嵌入装配；必须在表面稳定（切片 4）之后，并保留嵌入冒烟检查。
- **切片 7 不变量侵蚀。** schema 重设计不得弱化 catalog 拒绝或丢掉哈希键索引层；拒绝与锁序测试是守卫。
- **隐藏宿主耦合。** 上层可能读 Settings 接口，或依赖本仓不可见的 WebShell 路由；切片 4/5 前先确认。

## 验证计划

- 每切片：受影响消费者的聚焦测试加上述命名门禁；记录命令、被测状态与结果。
- 跨语言切片（4、8）：根 build/typecheck 与受影响消费者测试；CI 保留完整跨语言门禁。
- SQL/恢复切片（3、7）：预算内本地真实 MySQL 证据；完整 `mysql-integration` / Hosted / fault profile 归 CI。
- 在所需 CI 门关于被接受修订通过前，验收为待定；分别报告本地通过、失败、跳过与 CI 缺口。

## 验收标准

- 存活结构与已锁定决策一致：一套公共表面、一个纯净可嵌入的 `contracts`、无已发布产物修复路径、无无服务对象的迁移/恢复工具。
- 全部 C 类不变量及其测试保持绿。
- 嵌入（`@Import(ManagedAgentConfiguration.class)`）仍能装配并隔离 bean；`sessionWorktreeScheduler` 隔离 bug 已修。
- 每个切片带聚焦证据与通过的 CI 门禁落地；本设计与被修订 Maven-modules 设计的两个语言版本保持对齐。

## 开放问题

- 精确的 Public/WebShell 能力映射（按名比对标记 ≥24 个 WebShell 独有名；部分可能有不同命名的 Public 孪生）。切片 4 删除前必须产出逐路由映射。
- 放宽还是删除 `ClassSizeRatchetTest`（推迟到切片 5）。
- 是否作为能力决策移除 external runtime provider。`runtime-kubernetes` 是 `kubernetes-workspace` CSI / resident-workspace provisioner（正在积极开发），承重而非移除候选。`runtime-external` 提供 `external-scratch`（可用）与 `external-workspace`（有意 fail-closed，待 step 3b/3c）；移除它等于放弃 external-runtime 能力。两者均非死代码。
