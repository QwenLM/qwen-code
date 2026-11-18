# Managed Public API 形状补齐（切片 4a 批4）实施计划

[English](2026-11-15-managed-public-shape-enrichment.md) | [简体中文](2026-11-15-managed-public-shape-enrichment.zh-CN.md)

状态：计划中，未开始。日期：2026-11-15。基线：`main` 的 `7fb3668355`。分支：`feat/managed-agent-slice-4a-public-api-parity`（worktree `bright-oak-630bca`），其上已有四个本地未 push 提交：`ffec8d4571`（切片 4/5 双语设计）、`b0c4c8fe34` / `5596d351d7` / `66054808ae`（25 条纯增量 Public 路由，OpenAPI `1.120.0`，四门禁全绿）。[切片 4/5 设计](../design/2026-11-13-managed-agent-slices-4-5-convergence.zh-CN.md)是契约；本计划完成切片 4a 被搁置的另一半：补齐既有 Public 形状，使 `/v1/agents/**` 成为 WebShell 表面的真正超集。这是切片 4b（把 web-shell 客户端迁离 `/api/agent/web-shell/v1/**`）的硬前置。

## 1. 为什么有这一批

切片 4a 目前只加了 25 条新 Public 端点，没有补齐既有 Public 响应形状。web-shell 前端读取的 `WebShellSession` 字段，`PublicSession` 还没有：`title`、`environment`、`approvalMode`、`approvalRevision`、`initialApprovalMode`、`planMode`、`planModeSupported`、`modelContext`、`modelSelection`、`lifecycleOperation`；`SessionCapabilities` 同样缺交互标志。这些字段没上 Public 形状之前，前端无法在不丢数据的前提下迁到 `/v1/agents/sessions`。务必在任何消费方迁移之前完成本批。

范围约束：只增不改。保留每一个既有 Public 字段、标志、状态码与既有 Public 能力计算不变，新字段/标志并列添加。WebShell 路由与 record 不动。每个落地增量必须保持四门禁与 Checkstyle 全绿。

## 2. 核心难点：actor 作用域投影

`ManagedAgentService.publicSession` / `publicSessions` 目前不接收 `actorId`，能力只按可见性/retention 门计算。新字段与新标志是 actor 作用域的，由 `webShellSessions` / `webShellSession` 通过批量读产生。补齐必须把 `actorId` 引入 Public 投影并复刻这些读，且不回归既有 Public 标志。

先读要镜像的参考实现：`ManagedAgentService.webShellSessions`（约 1497 行）与 `webShellSession`（约 1602 行）。要在 `publicSessions` 复刻的批量读：

- `store.findLatestTurns(tenantId, ids)`（Public 现用 `findActiveTurns`；保留既有 active-turn 字段，仅当新字段需要时才加 latest-turn）。
- `store.findLatestEnvironmentEvents(tenantId, latestTurns)` → `environment`。
- `store.findApprovalOwners(tenantId, actorId, boundIds)` → lifecycle-owner 门。
- `store.findLatestLifecycleOperations(tenantId, ids)` → `lifecycle_operation`。
- `store.findApprovalSelections(tenantId, approvalIds)` → approval mode/revision/plan/rules。
- `store.findModelSelections(tenantId, boundIds)` 与 `store.findModelContexts(tenantId, boundIds)` → model 字段。
- `submitterGrants(tenantId, actorId, grantWorkspaces)` + `store.sessionsWithExecutionRegistryFacts(tenantId, candidateIds)` + `inputPolicy.maySubmitShape` / `mayChangeContextShape` / `mayCompressShape` 候选集 → 新能力标志所用的 `maySubmit` / `mayChangeContext` 合取项。

调用点改动：`getPublicSession` → `publicSession(session, actorId)`；`listPublicSessions` → `publicSessions(page.sessions(), actorId, page.worktrees())`。保留 `webShellSessions` 的零查询短路（空页、无 bound id、actor 为 null/空）。

## 3. 增量

作为一个一致批次一起落地（record、service、OpenAPI、测试必须相互一致，才能过 `recordsMatchTheirSchemas` 与路由门禁），然后验证。按依赖顺序列出。

### 3.1 新 Public record（`contracts/.../model/ApiModels.java`）

新增 snake_case record，逐字段镜像对应 WebShell 孪生（多词名一律 `@JsonProperty`）：

- `PublicModelContext` ← `WebShellModelContext`。
- `PublicLifecycleOperation` ← `WebShellLifecycleOperation`。
- `PublicModelSelection` 已存在（批3），复用。

因为它们位于 `ApiModels`，`recordsMatchTheirSchemas` 会自动扫描：须在同批为每个补 `RECORD_SCHEMAS` 条目与 OpenAPI schema。

### 3.2 `PublicSession` + `SessionCapabilities`

- `PublicSession`：加 `title`、`environment`（`Map<String,Object>`）、`approval_mode`、`approval_revision`、`initial_approval_mode`、`plan_mode`、`plan_mode_supported`、`model_context`（`PublicModelContext`）、`model_selection`（`PublicModelSelection`）、`lifecycle_operation`（`PublicLifecycleOperation`）。保留 `@JsonInclude(NON_NULL)`；更新 `withRecovery` / `withWorktree`。
- `SessionCapabilities`：加 `workspace_turns`、`cwd_change`、`model_change`、`approval_mode_change`、`input_attachments`、`rename`、`client_files`。
- 在 `publicSession` 里完全按 `webShellSession` 的方式填充：`environment` 复用 `webShellEnvironment(event)` 映射；catalog Session（无 workspace 且无 agent-definition digest）的 approval/initial-approval 为 null；`plan_mode_supported` = `visible && approvalSupported && mayChangeContext && harness.supportsPlanMode() && store.supportsPlanMode(session)`；新能力标志照抄 `webShellSession` 的合取项（含 `approvalExecutable` 守卫与 `publicChild` 抑制）。不要改动既有 Public 标志。

### 3.3 `CreateSessionRequest`

加可选 `title`、`approval_mode`、`plan_mode`、`model_id`，并按 `WebShellCreateRequest` 的处理方式在 `createSession` / `createWorkspaceSession` 接线。四者全为 null 时，行为必须与当前 Public create 逐字节一致。

### 3.4 任务列表与 workspace 形状

- `PublicTaskList`：暴露 `active_child_count`（镜像 `WebShellTaskPage`）；核对 `ManagedTaskService.listPublicTasks` 与 Public tasks 路由返回类型。
- `WorkspaceDiscoveryController.PublicItem`：加 `default_cwd_relative`、`can_select_directory`；`PublicCapabilities`：加 `workspace_creation`、`approval_mode_selection`、`directory_selection`、`local_directory_import`（镜像 WebShell list/get 形状）。这也会补齐既有 Public workspace list/get 响应。勘误：早期稿写作 `workspace_listing`，WebShell 并无此标志；其孪生是 `approvalModeSelection`（前端据此决定是否展示创建时的审批模式选择），故按镜像目标定名 `approval_mode_selection`。

### 3.5 OpenAPI + 契约同步

- 更新 `PublicSession`、`SessionCapabilities`、`CreateSessionRequest`、`PublicWorkspace` / `PublicWorkspaceList` schema；新增 `PublicModelContext` / `PublicLifecycleOperation` schema 及任务列表/workspace 字段。递增 `info.version`（`1.120.0` → `1.121.0`）。
- 遵守 NON_NULL 规则：`@JsonInclude(NON_NULL)` record 会省略 null 字段，故 schema 的 `required` 数组不能列可空字段（批3 在 `PublicModelSelection.model_id` 与 `PublicTranscript.older_cursor` 上踩过）。镜像对应 WebShell schema 的 `required` 集合。
- `bothSurfacesReportTheSameSession` 及任何钉形状的断言可能需要纳入新 Public 字段；把它们更新为断言两侧一致，而不是删检查。

## 4. 验证（四门禁 + Checkstyle）

用隔离 Maven 仓库（SDK 已装）并跳过 GPG。在 `packages/managed-agent-server` 下：

```
export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home
MVN=~/apache-maven-3.9.12/bin/mvn; REPO=/tmp/tier1-pr1-m2
# 先重生成表面 capture，再跑门禁
$MVN -pl verification -am -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true \
  -DfailIfNoTests=false -Dcheckstyle.skip -Dspotbugs.skip -Dgpg.skip=true -Dmaven.repo.local=$REPO test
$MVN -pl verification -am -Dtest='SurfaceRegistryGateTest,ManagedAgentApiContractTest,SurfaceAdmissionAcceptanceTest,ManagedSurfaceCaptureTest' \
  -DfailIfNoTests=false -Dcheckstyle.skip -Dspotbugs.skip -Dgpg.skip=true -Dmaven.repo.local=$REPO test
$MVN -pl contracts,control-plane,server,verification checkstyle:check -Dmaven.repo.local=$REPO
```

若 `/tmp/tier1-pr1-m2` 不存在，用 APFS `cp -Rc` 克隆 `~/.m2/repository`，并从 `packages/sdk-java/qwencode` 以 `-DskipTests -Dgpg.skip=true` 安装 sibling SDK。增量运行约 30–60s。CLI `capability-parity.test.ts` 需要已构建的 TS workspace dist（`npm run build`）；若不可用，记为 CI 待定（Java capture 门禁已校验表面一致，且本批不新增 Capability 枚举）。

验收：四门禁全绿、Checkstyle 0 violations、既有 Public 字段/标志/状态码不变、WebShell 不动、一个干净本地提交。完整 MySQL/Hosted lane 仍留 CI 待定。

## 5. 本批之后（切片 4b，此处不启动）

web-shell 客户端 `JavaManagedAgentClient` 是单一 HTTP 边界（`API_PREFIX = '/api/agent/web-shell/v1'`）；下游 80+ 组件用的 `JavaAgent*` 别名等于 camelCase `WebShell*` 形状。生成器 `generate-managed-agent-api.mjs` 按 `tags.includes('WebShell')` 过滤。Public 形状成为超集后，二选一：(a) 客户端改调 `/v1/agents/**` 并在边界做 snake_case→camelCase 适配（下游不动，但生成器仍产 WebShell 类型，须在 4c 解决）；(b) 生成器切 Public 并改下游（更大）。批4 落地后再定。
