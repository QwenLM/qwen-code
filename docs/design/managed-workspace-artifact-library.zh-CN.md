# Managed 工作区级产物库

[English](managed-workspace-artifact-library.md) | [简体中文](managed-workspace-artifact-library.zh-CN.md)

状态：随本次变更实现；已本地验证（H2 与真实 MySQL 8.4 集成、
surface/契约/准入/parity 门禁、web-shell 聚焦测试、build/typecheck/bundle）。
完整 CI 验收仍待进行。

## 问题与现状

Managed Agent Web UI 目前只在单个会话内展示产物：Outputs 面板通过会话级
WebShell 路由 `POST /api/agent/web-shell/v1/artifacts/query` 与
`/artifacts/get` 列出当前会话的产物，并经公开路由
`GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}/content`
下载字节。没有任何入口可以浏览一个工作区跨会话产出的全部产物。

本地 daemon 已提供工作区产物库
（`docs/design/workspace-artifact-library.md`），但 Managed 产品不与 daemon
通信：Managed-only shell（`ManagedAgentWebShell`）经
`createJavaManagedAgentProvider` 消费 Java 控制面。控制面完全没有工作区级
产物面；能力 parity 矩阵将 `workspace_artifact_library` 与
`workspace_artifact_library_stream` 记为 `NO_MANAGED_EQUIVALENT`
（`packages/cli/src/serve/capability-parity.ts`）。

产物是控制面的持久化行，而非转录投影：`ma_artifact` 每个已发布输出流存一条
descriptor，按 `scope_key = sha256(长度前缀 tenant, session)` 分区。表上没有
workspace 列；工作区归属在 JOIN 的 `ma_operation` 行
（`operation_kind = 'TOOL_RESULT_PROJECTION'`）与 `ma_session.workspace_id`
上。今天的列表序是会话内的 `creation_sequence`，跨会话不可比。

## 目标与范围

为 WebShell API 增加一个工作区级产物查询，为 Managed Web UI 增加一个产物库
面板：跨会话按最新优先列出工作区产物，每行标注来源会话，经既有会话级字节
路由预览与下载。

范围内：

- 一个 WebShell 路由 `POST /api/agent/web-shell/v1/workspaces/artifacts/query`，
  不透明游标分页，复用既有 `WebShellArtifactPage` 信封。
- 工作区读授权准入 + 逐会话可见性过滤、部署级产物开关、批量可用性判定、
  每行内容策略标志。
- 工作区查询响应上的页级能力标志、provider 能力、工作区分组入口按钮、
  复用 `ManagedArtifactContent` 的产物库对话框。
- `workspace_artifact_library` 的 parity 翻转、surface 孪生清单再生成，
  以及契约、surface、准入各门禁。

范围外：

- 删除。控制面没有产物删除原语；retention 以会话为根
  （`docs/design/managed-tool-output-retention.md`）。批量删除仍是 daemon
  独有能力；stream 标签的 parity 缺席理由保留。
- SSE 渐进读取。daemon 流式是因为冷读要重放转录；本查询每页一次索引 SQL
  读取，JSON 游标分页即可。`workspace_artifact_library_stream` 保持缺席。
- 公开孪生路由。只有 Web UI 消费此面；WebShell-only 的 workspace-files
  族是先例。
- schema 或索引变更、响应信封中的会话元数据、富 MIME 预览。会话标题在客户端
  用页面已加载的会话列表解析；产物字节仍是投影发布的原始 stdout/stderr 流。

## 协议

### 请求与响应

`POST /api/agent/web-shell/v1/workspaces/artifacts/query`

| 字段          | 形状                   | 校验                            |
| ------------- | ---------------------- | ------------------------------- |
| `workspaceId` | string，必填           | `@NotBlank`（workspace 族约定） |
| `cursor`      | string 或 null，可选   | 至多 2048 字符                  |
| `limit`       | integer，可选，默认 20 | 1–100，服务层强制               |

未知字段被拒绝（`@JsonAnySetter`，与较新的 WebShell 请求 record 一致）。
响应复用 `WebShellArtifactPage`：`data: ArtifactResponse[]`、
`nextCursor: string | null`、`hasMore: boolean`。每个 `ArtifactResponse`
保持既有形状：注入 `availability` 的 `PublicArtifact` descriptor，加
`access.can_read_content`。`artifact.session_id` 标识来源会话；信封不新增
会话元数据。响应带 `Cache-Control: no-store`——workspace 族约定：
`TenantContextFilter` 对 `/workspaces/` 路径预设该值，会话路由的
`private, no-store` 会留下两个头值。

### 排序与游标

行按 `ma_artifact.id DESC` 排序——投影插入时分配的自增主键。它是跨会话的
严格全序，语义为"最新投影优先"；同一次投影的 stdout/stderr 对保持稳定顺序。
刻意不用会话内 `creation_sequence`：它来自各会话自己的事件流，跨会话不可比。

首页捕获同一可见集上的 `watermark = MAX(a.id)` 并冻结窗口，与会话页的
watermark 语义一致：首页之后投影的行不会移动或重复后续页。游标为 Base64url
JSON，恰六个字段：

```json
{
  "v": 1,
  "tenant": "...",
  "actor": "...",
  "workspace": "...",
  "watermark": 123,
  "before": 120
}
```

`before` 是最后返回行的 `a.id`。校验拒绝：长度超 2048、字段数不符、`v` 不符、
tenant/actor/workspace 与请求不符、数值字段不能转为 long、`watermark < 0`、
`before < 0`、`before > watermark`。失败回 `400 invalid_cursor`；limit 越界
回 `400 invalid_limit`。仅当存储取回 `limit + 1` 行时才发出下一游标。

### 准入与行可见性

准入先于校验，遵循产物族的顺序：

1. 可信 actor：缺失回 `401 actor_required`。
2. 工作区读授权：`registry.accessOf(tenant, actor, workspaceId)` 低于
   READER 或工作区未知，回 `404 workspace_not_found`。CHILD_GIT 工作区经
   registry 上溯到 root 授权，与所有工作区级读一致。
3. 部署级产物开关：`settings.isEnabled() && reader.supported()`，否则回
   `404 artifact_not_found`——与会话路由在产物读关闭时使用的码一致。

随后在 SQL 中过滤行：

- `r.operation_kind = 'TOOL_RESULT_PROJECTION'` 且 `r.state = 'READY'`；
- `r.tenant_id = ?`、`r.workspace_id = ?`、`s.workspace_id = ?`——操作的
  来源工作区与会话当前绑定必须都等于请求的工作区，重绑定会话的漂移产物
  在两个工作区下都不列出（字节路由本就拒绝漂移读）；
- `s.session_kind = 'PUBLIC'`——CONTROL 生命周期记录不列出；
- `s.status` 非 `DELETED`/`DELETING`；归档会话保持可见；
- `(s.owner_only = 0 OR COALESCE(s.owner_actor_key, s.creator_actor_key) = ?)`
  传入编码后的 actor key——与 worktree 列表相同的逐会话可见性谓词。

无工作区绑定的 legacy 会话无法匹配工作区过滤，永不列出。无 primary-runtime
回退，不加载会话，不解归档。

### 可用性与内容策略

`reader.availability(artifacts)` 每页执行一次；reader 内部已按来源会话 key
分组，跨会话页可正确批量。任一行不可用时，重检一次工作区读授权——会话页
`session()` 重检的工作区类比——授权丢失回 `404 workspace_not_found`，而非
静默返回该页。

`access.can_read_content` 为 `available && policy.readOriginal(tenant, actor,
workspaceId, sessionId)`，按页内去重后的会话各求值一次。默认策略是部署级，
但接口按会话定义，自定义策略可能不同；分组使调用次数以页大小为界。不可用
行仍以 `availability: "unavailable"`、`can_read_content: false` 列出——
retention 会收集已退役会话的字节而 descriptor 存活，产物库必须容忍该状态。

字节读不变：UI 经既有公开会话级 content 路由下载，固定 revision、ETag、
Range、周期重授权等守卫全部保留。

## Surface、契约与 parity 门禁

- `SurfaceRegistry`：新增一条
  `WEBSHELL_WORKSPACE_ARTIFACT_LIST(POST, "/api/agent/web-shell/v1/workspaces/artifacts/query", Surface.WEBSHELL, RuleClass.WORKSPACE_ARTIFACT, EnumSet.of(Capability.WORKSPACE_ARTIFACT_LIST))`。
  新 `RuleClass.WORKSPACE_ARTIFACT` 文档化上述规则：可信 actor、工作区
  READER 授权（低于回 `404 workspace_not_found`）、逐会话 owner-only 过滤、
  部署级产物开关（关闭回 `404 artifact_not_found`）、无 legacy 臂。
  `SurfaceRegistryGateTest` 的精确双射与能力孪生规则类检查原样适用。
- `SurfaceAdmissionAcceptanceTest`：新 switch 臂探测匿名
  （`401 actor_required`）、陌生人（`404 workspace_not_found`）、reader
  （准入，返回种子产物行，而另一 actor 的 owner-only 会话的行保持不可见）。
  `bodyFor` 增加该能力的最小 body；夹具在被探测工作区种一条可见产物与一条
  owner-only 隐藏产物。
- OpenAPI：新路径条目为 `implemented`、tag `WebShell`、
  `x-qwen-admission-rule: workspace_artifact`；请求 schema
  `WebShellWorkspaceArtifactQueryRequest` 封闭
  （`additionalProperties: false`）；响应引用既有 `WebShellArtifactPage`。
  `WebShellWorkspacePage.capabilities` 增加可选布尔 `workspaceArtifactLibrary`
  （"缺失即不支持"，该族既有约定）。
- `ApiModels`：`WebShellWorkspaceArtifactQueryRequest(@NotBlank String
workspaceId, String cursor, Integer limit)` 带 `rejectUnknown`；
  `ManagedAgentApiContractTest.RECORD_SCHEMAS` 建立映射，路由交换探针覆盖
  匿名拒绝与准入页。
- `WorkspaceDiscoveryController`：`WebShellCapabilities` 增加
  `workspaceArtifactLibrary`，计算为
  `settings.getArtifacts().isEnabled() && reader.supported()`；伸缩构造器
  保持旧形状。控制器注入 `ManagedAgentSettings` 与 `ManagedArtifactReader`。
- Parity：`workspace_artifact_library` 翻转为
  `{ standing: 'managed', evidence: 'surface:WORKSPACE_ARTIFACT_LIST' }`。
  daemon 标签还覆盖批量删除，仍缺席；矩阵已将 `session_artifact_library`
  映射到只读的 `ARTIFACT_GET` 面，只读 standing 是既定约定。
  `workspace_artifact_library_stream` 保持缺席并更新理由，点名仅 JSON 查询。
  提交孪生清单
  `verification/src/test/resources/capability-parity/managed-surface.txt`
  用 `mvn -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true test`
  再生成，`capability-parity.test.ts` 校验证据与摘要。`web_terminal` 行已在
  设计文档证据旁引用 terminal ticket surface；本变更不动它。

## 存储与服务

`ManagedToolResultStore` 增加一个方法：

```java
WorkspaceArtifactPage listWorkspaceArtifacts(String tenant, byte[] actorKey,
        String workspaceId, Long watermark, Long beforeId, int limit);
```

存储返回新 `WorkspaceArtifactPage(artifacts, watermark, hasMore, lastId)`
record：共享 `Artifact` record 不带行 id，会话路径保持不动。`lastId` 是
截断后页的末行 id（空页为 0）；游标由它发出，绝不用为 `hasMore` 多取的
探测行。JDBC 实现选取 `a.id` 加
`ManagedSchemaProjection.ARTIFACT.columns("a")` 与 `r.request_json`，JOIN
`ma_operation r`（`r.operation_kind = 'TOOL_RESULT_PROJECTION' AND
r.operation_id = a.result_id`）与 `ma_session s`（`s.tenant_id = r.tenant_id
AND s.session_id = r.session_id`），带上上述可见性谓词、`a.id <= watermark`、
可选 `a.id < beforeId` keyset、`ORDER BY a.id DESC LIMIT ?`（取 `limit + 1`）。
watermark 查询为同一 JOIN 与过滤上的 `SELECT COALESCE(MAX(a.id), 0)`。
行映射器复用既有 artifact 映射器，额外读 `id` 列用于游标。

投影枚举不动：`ManagedSchemaProjectionTest` 将每个投影钉为表的非 `id` 列、
按 DDL 顺序。本查询在 select 列与 keyset 中引用 `a.id`，遵循既有实践——
where/join 子句可引用投影之外的 joined 表列；不做 schema 或索引变更。
预期计划经 `idx_ma_operation_claim (operation_kind, state)` 收窄
`ma_operation`，按主键探测 `ma_session`，经
`uk_managed_artifact_stream (result_id, stream_id)` 探测 `ma_artifact`，
再对匹配行按 `a.id` 排序。若数据量需要，专用工作区索引可作为后续。

`ManagedArtifactService` 增加 `workspacePage(TenantContext, workspaceId,
cursor, limit)`，实现上述准入、校验、可用性、策略分组与游标发出，并注入
`ManagedWorkspaceRegistry` 做授权检查与 `ManagedWorkspaceRegistry.actorKey`
编码。会话级方法不变。`ManagedArtifactController` 增加一个 WebShell 端点
委托给它。

## Web UI

类型从契约再生成：
`npm run generate:managed-agent-api --workspace=@qwen-code/web-shell`；
`managed-agent-api.test.ts` 的逐字节相等钉子守卫漂移。

- `java-managed-agent-client.ts`：`listWorkspaceArtifacts(workspaceId,
options)` 经共享 JSON RPC 路径 POST `/workspaces/artifacts/query`，body
  `{ workspaceId, cursor?, limit? }`，返回 `ManagedArtifactPage`。
- `managed-agent-provider.ts`：新可选能力
  `workspaceArtifacts?: ManagedWorkspaceArtifactReader`，含
  `listArtifacts(workspaceId, options & { cursor?, limit? })`。Java provider
  无条件接线，与 `toolResults` 一致；无此面的宿主直接省略。
  `workspaceBinding.list` 将页级 `workspaceArtifactLibrary` 标志映射为
  `artifactLibrary: boolean`（缺失为 false）。
- `ManagedWorkspaceNavigation`：工作区分组头在既有 new-task 按钮旁增加产物库
  按钮，当工作区页声明 `artifactLibrary` 且 provider 暴露 `workspaceArtifacts`
  与 `toolResults` 时显示，调用新 prop `onOpenArtifactLibrary(workspaceId)`。
- `ManagedSessionsPage`：新增状态 `artifactLibraryWorkspace`，随 provider/
  会话身份变化清空，与 `outputTarget` 一致；导航回调设置它，面板区在其置位
  期间渲染产物库对话框。Managed-only shell 与混合 App 都经共享页面到达，
  无需改 `App.tsx` 面板联合。
- `ManagedArtifactLibraryPage.tsx`：shadcn 对话框，列出工作区产物。每行显示
  流角色、字节长度、投影时间、可用性徽标、来源会话标题（从页面已持有的会话
  summary 解析；回退为缩短的会话 id——已删除或子会话可能不在列表中）。选中
  行渲染既有 `ManagedArtifactContent`（`reader = provider.toolResults`），
  它按 `artifact.session_id` 重取产物元数据，用既有 64 KiB 读取器分页字节，
  预览与下载门控（`reader.canDownload`）不变。加载更多追加下一游标页；
  空、加载、错误状态显式，`404` 回产物库不可用消息而非空列表。文案在新
  `managed-artifact-library-messages.ts`（EN/ZH），注册进 `i18n.tsx`。

对话框不使用 `useArtifactWorkspaceTarget` 或 `ArtifactPanel`：它们依赖
Managed-only shell 不提供的 daemon 工作区上下文。

## 涉及文件

Java（managed-agent-server）：

- `contracts`：`ApiModels.java`、`ManagedToolResultStore.java`、OpenAPI
  契约 JSON。
- `control-plane`：`ManagedArtifactService.java`。
- `persistence`：`JdbcManagedToolResultStore.java`。
- `server`：`ManagedArtifactController.java`、
  `WorkspaceDiscoveryController.java`。
- `verification`：`SurfaceRegistry.java`、`SurfaceAdmissionAcceptanceTest.java`、
  `ManagedAgentApiContractTest.java`、再生成的
  `capability-parity/managed-surface.txt`，以及聚焦的存储/服务测试
  （H2 加选定的 MySQL 集成用例）。

TypeScript：

- `packages/cli/src/serve/capability-parity.ts`（parity 翻转；除非有钉子
  引用旧理由，测试文件不变）。
- `packages/web-shell`：生成 API 类型、`java-managed-agent-client.ts`、
  `java-managed-agent-provider.ts`、`managed-agent-provider.ts`、
  `managed-tool-result-types.ts`、`ManagedWorkspaceNavigation.tsx`、
  `ManagedSessionsPage.tsx`、新 `ManagedArtifactLibraryPage.tsx` 与文案
  模块、`i18n.tsx`，及同址测试。

文档：本设计双语文档与 E2E 计划
`.qwen/e2e-tests/managed-workspace-artifact-library.md`。

## 验证计划

- Java 聚焦门禁：`ManagedAgentApiContractTest`、`SurfaceRegistryGateTest`、
  `SurfaceRegistryGateNegativeTest`、`SurfaceAdmissionAcceptanceTest`、
  `ManagedSurfaceCaptureTest`（capture 模式再生成孪生清单）、新存储/服务
  测试、Checkstyle。新 SQL 属 SQL 变更：在模块本地预算内对一次性 MySQL 8.4
  跑受影响的 `mysql-integration` 用例，完整 profile 留给 CI。
- TypeScript：每个改动 web-shell 文件的聚焦 vitest（客户端传输、provider
  接线与标志映射、导航门控、产物库对话框 DOM 行为、会话页集成）、生成类型
  漂移测试、`packages/cli` 的 `capability-parity.test.ts`，然后根 build、
  typecheck、bundle。
- E2E：测试计划在隔离控制面上用种子投影演练——可见与 owner-only 隐藏会话、
  归档与删除中会话、漂移绑定、不可用字节、并发投影下游标稳定性、UI
  入口/预览/下载路径。基线 dry-run 记录缺失的路由与缺席的 UI 入口。

## 验收标准

- 工作区 reader 按最新优先列出其会话的产物，用稳定游标分页，看到每行可用性
  与内容访问标志。
- 陌生人见 `404 workspace_not_found`；匿名见 `401 actor_required`；产物读
  关闭的部署见 `404 artifact_not_found`；他人 owner-only 会话、CONTROL、
  DELETED/DELETING、legacy 无绑定、漂移行永不列出。
- 产物库入口仅在工作区页声明能力且 provider 暴露读取器时出现；对话框经既有
  字节路由预览与下载，守卫不变。
- surface、契约、准入、parity、生成类型各门禁全过；会话级产物路由契约逐字节
  不变。

## 决策与限制

- 只读切片：删除与 SSE 仍是 daemon 独有；parity 矩阵报告缺口而非关闭它。
- `a.id` 序是投影序，不是工具执行序；投影滞后于 receipt 时两者可能不同。
  watermark 按查询冻结窗口，不跨查询。
- 会话标题客户端解析；不在已加载列表中的会话以缩短 id 标注其行。信封保持
  既有 `WebShellArtifactPage`，会话路由不受响应 schema 漂移影响。
- 结果是查询时过滤的逐页快照；分页中途的授权或绑定变化由游标的
  tenant/actor/workspace 绑定与不可用行授权重检捕获，而非事务性工作区快照。
- 不加新索引：计划复用既有索引并对匹配集排序。预发布数据量下可接受；若
  实测需要，工作区级索引是点名的后续项。
