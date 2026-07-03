# Qwen Code Daemon Session Artifacts V2 持久化设计

本文延续 PR #5895 的 V1 session artifact API，设计 V2 持久化能力。目标是在不破坏 V1 live session 语义的前提下，让 artifact metadata 可以在 daemon 重启、session load/replay 后恢复，同时把内容持久化、权限、配额和清理策略收窄到可审计、可回滚的范围内。

## 1. 设计结论

V2 建议作为一个完整 phase 交付，而不是拆成多个对外版本。这个 phase 内包含两层能力：

1. Metadata restore：默认恢复 artifact 的结构化 metadata 和资源引用，不复制实际内容。
2. Content retention：只有用户或可信 publisher 显式 `pin/save` 时，才把可控内容复制进 daemon artifact storage。

对应 capability：

- `session_artifacts_persistence`：支持 metadata 持久化与 session load/replay 恢复。
- `session_artifacts_content_retention`：支持显式内容保留、配额和 GC。它仍是同一个 V2 phase 的一部分；实现可以用 feature flag / setting 控制启用时机，但对外不再拆成单独版本。

核心原则：

- V1 的 `SessionArtifactStore` 仍是 live session 的权威内存索引。
- V2 增加持久化 journal/snapshot，用于在创建 live store 时 seed 初始状态。
- 不把远端 URL 内容抓取到本地。
- 不默认复制 workspace 文件。
- 不把 client 传入的 `source`、`clientId`、`trustedPublisher` 当授权依据。
- 恢复时必须重新校验，不信任磁盘上的旧 metadata。

## 2. 用户可见语义

### 2.1 页面刷新、切换和重启

V2 后的行为应是：

- 页面刷新：和 V1 一样，只要 daemon/session 还活着，前端重新 `GET /session/:id/artifacts` 即可。
- 切换 session：每个 live session 仍有独立 artifact store。
- 前端实例重启：daemon 还在时可 GET 当前 live store。
- daemon/bridge 重启：如果 session 被重新 load，V2 从持久化 metadata 恢复 artifact list。
- 历史 load/replay：如果该 session 有 V2 persistence records，恢复 artifact list；没有则返回空 list。

### 2.2 retention 分层

新增 optional field：

```ts
type ArtifactRetention = 'ephemeral' | 'restorable' | 'pinned';
```

含义：

- `ephemeral`：只存在于 live store。daemon/session 消失后不恢复。
- `restorable`：metadata 写入持久化 journal。session load/replay 后恢复为 artifact item，但不保证底层资源仍存在。
- `pinned`：metadata 持久化，并尽量保存可控内容或稳定 content reference；直到用户 unpin/delete 或 GC 策略命中。

建议默认：

- Tool result、`record_artifact`、hook artifact：默认 `restorable`，但只持久化 metadata。
- 用户在交互式前端手动注册的 Client POST artifact：默认 `restorable`，恢复后仍出现在 artifact list 中。
- 后台/自动化 client POST：如果只是临时 UI 状态，应显式请求 `retention: "ephemeral"`；SDK 应提供明确的 ephemeral helper，避免后台调用误用默认持久化语义。
- `published` artifact：默认 `restorable`；如果 publisher 提供可校验 managed content，则可升级为 `pinned`。

如果 chat recording 被禁用，metadata persistence 默认禁用，capability 不声明或只声明为 disabled 状态。

### 2.3 用户注册 artifact 恢复语义

用户手动注册的 artifact 在 V2 恢复后应该继续存在，但恢复的是“artifact metadata item”，不是无条件内容备份。

恢复后的结果按资源状态区分：

- `external_url`：恢复 title、description、url、metadata。daemon 不访问远端 URL；URL 是否仍可打开由 client 点击时决定。
- `workspace`：恢复 workspacePath 和 metadata；如果文件仍在 workspace 内且可访问，`status: "available"`；如果文件已删除、移动或 symlink 逃逸，`status: "missing"` 或 `restoreState: "blocked"`。
- `managed`：恢复 managedId；只有 managed storage manifest 仍能解析时才 `available`。
- `published`：恢复 published URL；只有仍满足 trusted publisher 校验时才保留 published trust。

因此，“用户注册的 artifact 恢复后还存在吗？”的答案是：V2 中应该存在于列表里，除非用户 DELETE、metadata 被 GC/tombstone、恢复校验发现记录损坏到无法安全展示，或 chat recording / persistence 被禁用。是否还能打开底层内容，则取决于 storage 类型和是否做了 `pin/save content`。

daemon 不能只凭 request payload 判断“手动”还是“后台”。实现上应由连接 principal、SDK helper 或 UI action path 标识交互式注册来源；无法确认交互意图的 client 应按显式 `retention` 处理，缺省仍接受 `restorable` 但受 session metadata quota 和审计记录约束。

## 3. 数据模型

### 3.1 Public artifact 扩展

V2 在 V1 response artifact 上增加 optional fields：

```ts
interface DaemonSessionArtifact {
  // V1 fields...
  retention?: 'ephemeral' | 'restorable' | 'pinned';
  persistedAt?: string;
  expiresAt?: string;
  restoreState?: 'live' | 'restored' | 'unverified' | 'blocked';
  contentRef?: {
    kind: 'managed_copy' | 'published' | 'workspace_reference';
    id?: string;
    sha256?: string;
    sizeBytes?: number;
  };
}
```

字段说明：

- `retention`：artifact 的持久化级别。缺省按 V1 兼容处理为 live-only。
- `persistedAt`：metadata 或 content retention 最近成功落盘时间。
- `expiresAt`：可被 GC 的时间。`pinned` 默认不设置。
- `restoreState`：恢复来源提示；不替代 `status`。
- `contentRef`：仅在内容保留或可信 published storage 时出现，不暴露宿主机绝对路径。

### 3.2 Status 与 restoreState 的关系

V1 `status` 继续表示当前资源是否可用：

- `available`
- `missing`

V2 不建议直接把 `status` 扩成复杂状态来表达恢复来源，避免旧 client 误解。恢复后的不确定性放在 `restoreState`：

- `restored`：从持久化 metadata 恢复。
- `unverified`：恢复了 metadata，但尚未完成 workspace/managed 校验。
- `blocked`：恢复时发现安全边界不满足，例如 workspace path 逃逸。
- `live`：当前进程内新产生或已刷新确认。

## 4. 持久化存储设计

### 4.1 双存储：JSONL journal + sidecar snapshot

建议使用两层存储：

1. Chat JSONL system records：审计源与跨版本恢复源。
2. Session artifact sidecar：快速加载缓存。

JSONL 是 source of truth；sidecar 是可删除缓存。sidecar 损坏或版本不匹配时，从 JSONL 重建。

### 4.2 JSONL system record

给 `ChatRecord.subtype` 增加：

```ts
'session_artifact_event' | 'session_artifact_snapshot';
```

Payload：

```ts
interface SessionArtifactEventRecordPayload {
  v: 2;
  sessionId: string;
  sequence: number;
  changes: Array<{
    action: 'upsert' | 'remove';
    artifactId: string;
    artifact?: DaemonSessionArtifact;
    reason?: 'explicit' | 'eviction' | 'restore_pruned' | 'unpin';
  }>;
}

interface SessionArtifactSnapshotRecordPayload {
  v: 2;
  sessionId: string;
  sequence: number;
  generatedAt: string;
  artifacts: DaemonSessionArtifact[];
}
```

只写经过 store validation/normalization 后的 public artifact shape，不写内部字段：

- 不写 `identityKey`
- 不写 `trustedPublisher`
- 不写绝对 `workspaceCwd`
- 不写 transport token / auth principal

删除 artifact 必须写 tombstone change，避免历史 replay 后被旧 upsert 复活。

### 4.3 Sidecar snapshot

建议路径：

```text
~/.qwen/tmp/<project_hash>/chats/<sessionId>.artifacts.json
```

示例：

```json
{
  "v": 2,
  "sessionId": "session-123",
  "projectHash": "abc123",
  "sourceChatFile": "session-123.jsonl",
  "sourceSizeBytes": 20480,
  "sourceMtimeMs": 1783070000000,
  "sourceArtifactSequence": 42,
  "generatedAt": "2026-07-03T10:00:00.000Z",
  "sequence": 42,
  "artifacts": []
}
```

写入策略：

- temp file + fsync + atomic rename。
- 读取时同时校验 `sessionId`、`projectHash`、`sourceChatFile`、`sourceSizeBytes`、`sourceMtimeMs` 和 `sourceArtifactSequence`；任一不匹配都 fallback 到 JSONL。
- JSON parse 失败时丢弃 sidecar，重建。
- session archive/unarchive 时与 chat JSONL 一起移动。
- session delete 时一起删除。

`sequence` 表示 sidecar snapshot 自身对应的 artifact 序号；`sourceArtifactSequence` 表示源 JSONL 中最新 artifact record 序号。正常情况下两者相同；保留两个字段可以让 sidecar 重建或压缩后仍能校验缓存来源。

### 4.4 为什么不用 sidecar 作为唯一存储

只用 sidecar 会缺少审计链，也容易在 fork/branch/session copy 时漏掉 artifact 状态。JSONL system record 与现有 session 历史系统一致，天然支持：

- append-only crash safety
- branch/fork 复制 active record chain
- resume/load 时统一读取
- 版本迁移时 tolerant reader

sidecar 只解决性能，不承载协议正确性。

### 4.5 JSONL + sidecar 双存储的空间消耗

双存储会重复保存“当前 artifact snapshot metadata”，但重复的是小型 metadata，不是 artifact 内容。空间消耗应按 metadata 与 content retention 分开看：

- Metadata 单条通常约 0.5 KB - 2 KB，取决于 title、description、url 和 metadata 大小。
- 每 session 500 条 persisted metadata 时，当前 snapshot 约 250 KB - 1 MB。
- sidecar 保存一份当前 snapshot，因此额外增加约 250 KB - 1 MB。
- JSONL journal 还会保存增量事件和 tombstone；如果不做 snapshot compaction，长会话可能继续增长。
- content retention 才是主要空间来源，例如单 artifact 50 MB、单 session 200 MB、单 project 1 GB。

建议控制策略：

- artifact event journal 达到固定阈值后写 `session_artifact_snapshot`，例如每 100 次 artifact mutation 或每 256 KB artifact journal 写一次。
- load 时只需要读取最新 snapshot 之后的 artifact events。
- sidecar 只保留最新当前态，不保存历史事件。
- 不把 content bytes 写进 JSONL 或 sidecar；content 只进入 daemon managed artifact storage。
- metadata 超过每 session 上限时写 `restore_pruned` tombstone，避免历史 replay 复活被裁剪条目。

在这些限制下，典型 session 的 artifact metadata 持久化开销应保持在 MB 级以内；真正需要关注的容量风险是 pinned content storage，而不是 JSONL + sidecar metadata。

## 5. 写入与恢复流程

### 5.1 Artifact 写入流程

V1 流程：

```text
ingest input -> normalize/validate -> upsert live store -> publish artifact_changed
```

V2 流程：

```text
ingest input
  -> normalize/validate
  -> apply live-store mutation in operationQueue
  -> for restorable/pinned changes: append artifact journal
  -> update sidecar snapshot best-effort
  -> publish artifact_changed
```

持久化必须在同一个 store operation queue 内串行执行，避免 live store、journal、SSE 顺序错乱。

### 5.2 写入失败语义

区分两个入口：

- 普通 tool/hook artifact：持久化失败不应让工具调用失败；artifact 仍可进入 live store，但必须先把 live store 中的 `retention` 降级为 `ephemeral`，再发布 `artifact_changed`，并记录 structured warning。
- 显式 `pin/save` API：持久化失败必须返回错误，不能假装已经保存。

建议 warning：

```text
[artifacts] session=<id> action=persist_failed artifact=<id> reason=<code>
```

### 5.3 恢复流程

session load/replay 时：

1. `SessionService.loadSession()` 读取 JSONL。
2. 提取 active branch 中的 `session_artifact_snapshot` 和之后的 `session_artifact_event`。
3. 重建 artifact snapshot，应用 tombstone。
4. 对每个 artifact 重新执行 V2 restore validation。
5. 把恢复结果放入 `ResumedSessionData.artifactSnapshot`。
6. `AcpAgent.createAndStoreSession()` 创建 `Session` 后，用 snapshot 初始化 `SessionArtifactStore`。
7. client 初次 GET 时看到恢复后的 artifact list。

如果 sidecar 可用且版本、projectHash、sessionId、source file metadata 和 artifact sequence 都匹配，可直接用 sidecar；否则 fallback 到 JSONL replay。

### 5.4 恢复时校验

恢复时必须重新校验：

- `workspacePath`：仍必须是相对路径，realpath/stat 后不能逃逸当前 workspace。
- `url`：重新校验 scheme，只允许 `http:` / `https:`；拒绝 username/password credential。
- `managedId`：拒绝路径形态、`..`、绝对路径、分隔符。
- `published`：必须能映射到受信任 publisher manifest，不能只因为历史里写了 `storage: "published"` 就恢复 trust。
- `metadata`：重新执行 primitive-only、size limit 和 unsafe display payload checks。

恢复失败时：

- 安全失败：保留条目但 `restoreState: "blocked"`，`status: "missing"`，不提供可打开 locator。
- 资源缺失：`status: "missing"`。
- 非安全型字段损坏：跳过该 artifact，并记录 warning。

### 5.5 Branch / fork 语义

现有 `/branch` 会复制 active JSONL record chain 并重写 `sessionId`。V2 artifact records 也会跟随复制，因此必须显式处理 artifact id：

- 同一个资源在新 session 中应得到新 artifact id，因为 V1 identity 包含 `sessionId`。
- fork 写入目标 session 时，应根据目标 `sessionId + locator` 重新计算 artifact id。
- tombstone 也要按目标 session 的新 id 重写，不能保留源 session 的 artifact id。
- `forkedFrom` 可以记录原 session id / 原 artifact id，作为审计信息，但不能参与新 session 的权限判断。
- `pinned` content 可以共享底层 contentRef，但必须用引用计数或 manifest 引用表管理 GC，避免删除一个 session 时误删另一个 fork 仍在引用的内容。

fork remap 是发布门槛：如果某条路径不能安全重写 artifact id 和 tombstone，就必须在 fork 时丢弃 artifact persistence records，不能把源 session 的 artifact id 原样带入新 session。

## 6. API 设计

### 6.1 Capability

`GET /capabilities` 增加：

```json
"session_artifacts_persistence"
```

内容保留实现可用时，同时声明：

```json
"session_artifacts_content_retention"
```

可选 details：

```json
{
  "session_artifacts_persistence": {
    "metadata": true,
    "defaultRetention": "restorable",
    "maxRestorableArtifacts": 500
  },
  "session_artifacts_content_retention": {
    "enabled": true,
    "maxPinnedArtifactBytes": 52428800,
    "maxPinnedSessionBytes": 209715200
  }
}
```

`enabled` 表示当前配置下是否允许使用 content retention。若实现已具备但用户设置关闭，details 可以返回 `enabled: false`；如果现有 capability 结构只支持 string feature，则只有 `pin/save content`、quota、hash、manifest 和 GC 都可用且当前启用时，才声明 `session_artifacts_content_retention`。

### 6.2 Add artifact

`POST /session/:id/artifacts` 允许 optional：

```json
{
  "title": "Report",
  "kind": "html",
  "storage": "workspace",
  "workspacePath": "reports/run.html",
  "retention": "restorable"
}
```

限制：

- client 不能请求 `pinned`，只能请求 `restorable`。
- `pinned` 必须走 pin/save API，因为可能涉及内容复制、配额、确认和失败回滚。

### 6.3 Pin/save artifact

新增：

```http
POST /session/:id/artifacts/:artifactId/pin
Content-Type: application/json
```

Body：

```json
{
  "mode": "metadata"
}
```

或在 content retention capability 开启后：

```json
{
  "mode": "content",
  "ttlDays": 90
}
```

语义：

- `mode: "metadata"`：升级为 `restorable`。
- `mode: "content"`：复制或绑定可控内容，升级为 `pinned`。
- 成功返回 mutation result，并发布 `artifact_changed` / `updated`。
- 失败返回明确错误，不改变 artifact retention。

### 6.4 Unpin

```http
DELETE /session/:id/artifacts/:artifactId/pin
```

语义：

- `pinned` 降级为 `restorable` 或 `ephemeral`，由请求参数决定。
- 默认只删除 content retention，不删除 metadata。
- 若要从列表移除，仍使用 V1 DELETE。

### 6.5 Delete artifact

V2 的 DELETE 仍保持 V1 幂等，但要追加 tombstone：

- 从 live store 移除。
- 写 `session_artifact_event` remove tombstone。
- metadata restore 时不再复活。
- 默认不立即同步删除 managed/pinned content，但会释放该 artifact 对 contentRef 的引用；GC 默认清理无其它 session 引用的 daemon-managed content。

可选 body 或独立 endpoint 支持内容删除：

```json
{
  "deleteContent": true
}
```

`deleteContent` 表示请求立即删除可删除内容，必须经过更严格授权或用户确认；共享 contentRef 只能在引用计数归零后删除。

## 7. 安全设计

### 7.1 授权原则

不要把 public `clientId` 当授权边界。V2 应引入 daemon 内部 mutation principal：

```ts
type ArtifactPrincipal =
  | { kind: 'session_owner' }
  | { kind: 'client_connection'; id: string }
  | { kind: 'trusted_publisher'; id: string }
  | { kind: 'hook'; extensionId: string };
```

授权规则：

- list：需要 session read 权限。
- add restorable：需要 session mutate 权限。
- pin/save content：需要 session owner 或用户确认。
- delete metadata：需要 session mutate 权限；如果要保留 per-client ownership，则必须用内部 principal，不用 payload clientId。
- delete content：需要 session owner 或创建该 contentRef 的 principal。

### 7.2 持久化内容边界

默认不复制：

- external URL 内容
- 任意 workspace 文件
- 普通 assistant link

允许内容 retention 的来源：

- trusted `ArtifactTool` / publisher 生成的 `published` artifact。
- 用户显式 pin 的 workspace artifact，且文件在 workspace 内、类型/大小可控。
- client 上传或登记的 managed artifact，前提是通过 daemon API 接收并校验。

内容复制要求：

- workspace containment 校验通过。
- 文件大小低于默认 cap，例如 50 MB。
- 保存 sha256、size、mimeType。
- 打开/下载前重新校验 hash。
- 不 follow symlink escape。

### 7.3 隐私和敏感信息

持久化前要做最小化：

- 不保存 host 绝对路径。
- 不保存 URL username/password。
- metadata 仍限制 4 KB。
- title/description/metadata 继续执行 unsafe display payload checks。
- 对看起来像 secret 的 metadata key 可拒绝或 redacted，例如 `token`、`password`、`secret`。

建议新增设置：

```json
{
  "sessionArtifacts": {
    "persistence": {
      "enabled": true,
      "defaultRetention": "restorable",
      "contentRetention": {
        "enabled": false,
        "maxArtifactBytes": 52428800,
        "maxTotalBytes": 1073741824
      }
    }
  }
}
```

## 8. 配额、GC 与稳定性

### 8.1 Metadata quota

建议默认：

- live store 上限仍为 200。
- persisted metadata 上限每 session 500。
- snapshot record 最多保留 500 个当前有效 artifacts。

超过 persisted metadata 上限：

- `ephemeral` 本来不写 journal，不计入 persisted metadata quota，只受 live store 上限约束。
- `restorable` 可按最旧未 pinned 裁剪，并写 `restore_pruned` tombstone。
- `pinned` 不因 metadata quota 被裁剪，但可被 global content quota 约束。

### 8.2 Content quota

建议默认：

- 单 artifact：50 MB。
- 单 session pinned content：200 MB。
- 单 project pinned content：1 GB。

达到上限时：

- 新 pin/save 返回 `QUOTA_EXCEEDED`。
- 不自动删除 pinned content，除非用户设置 TTL 或 explicit GC policy。

### 8.3 GC

GC 只处理 daemon 管理的 content storage 和过期 metadata cache：

- 删除已被 tombstone 且无其它 session 引用的 managed copy。
- 删除超过 `expiresAt` 的 non-pinned content。
- 清理 orphan sidecar。
- session delete 时删除 sidecar，并对 pinned content 做引用计数递减；默认删除无其它 session 引用的 content。只有用户显式开启“保留已 pin 内容”或导出到全局 artifact library 时，才在 session 删除后继续保留。

GC 必须 best-effort，不阻塞 prompt/tool flow。

### 8.4 Crash consistency

要求：

- artifact store mutation 串行。
- JSONL journal append 失败不会破坏 live store。
- explicit `pin/save metadata` 必须等待 journal 落盘；sidecar 仍是 best-effort cache。
- explicit `pin/save content` 必须等待 content manifest 和 journal 都落盘；sidecar 仍是 best-effort cache。
- sidecar 原子写。
- reader 容忍半截 JSONL 和 corrupt sidecar。

### 8.5 文件读取、CPU 与 I/O 成本

V2 要避免把 artifact 恢复变成 session load 的新瓶颈。

读取路径建议：

1. 优先读 sidecar：一次小 JSON 文件读取和 parse，成本约 O(当前 artifact 数量)。
2. sidecar 缺失、损坏、版本不匹配或 source metadata 不匹配时，fallback 到 JSONL。
3. JSONL fallback 时在已有 session JSONL 读取过程中找到最新 `session_artifact_snapshot`，只 replay 之后的 artifact events；没有独立索引时允许一次顺序扫描，但不能在 load 流程里反复扫同一文件。
4. 如果现有 `SessionService.loadSession()` 已经完整读取 JSONL，可在同一轮 parse 中顺手提取 artifact records，避免二次扫文件。

CPU 成本边界：

- Metadata restore 只 parse JSON 和做字段校验，复杂度 O(artifact 数量 + 最新 snapshot 后事件数)。
- `external_url` 恢复不发网络请求。
- `workspace` 恢复只做 path normalization、realpath/stat 等元数据检查，不读取文件内容。
- `managed` / `published` 恢复只查 manifest，不读取大文件内容。
- content hash 校验只在显式 `pin/save content` 或打开 retained content 时触发，不在每次 session load 时全量 hash。

I/O 成本边界：

- 每次 session load 最多读 sidecar 一次；fallback 才读 JSONL artifact records。
- workspace 状态校验复用 V1 的 TTL/batch 策略，不在 GET 热路径对所有 artifact 做无限制 stat。
- 对大 workspace 文件，不在恢复阶段读内容；只有用户显式 pin/save 时才读取并 hash。

推荐默认：

- sidecar artifact snapshot 上限 500 条。
- workspace status restore batch size 20，与 V1 保持一致。
- artifact journal snapshot 阈值 100 mutations 或 256 KB。
- content hash 在 pin/save 时同步完成；恢复时 lazy verify 或后台 best-effort verify。

这样 session load 的常规成本是读取一个小 sidecar；只有 sidecar 不可用时才退化为 JSONL replay，而 replay 也被 snapshot 阈值限制在较小范围内。

## 9. 实现方案

以下是同一个 V2 phase 内的实现里程碑。工程上可以按 PR 拆开，但对外发布口径仍是一项完整的持久化能力。

### Milestone A: 类型和 persistence service

- 新增 `ArtifactPersistenceService`，职责：
  - append event/snapshot record
  - write sidecar atomically
  - rebuild from JSONL
  - restore validation
- 扩展 `ChatRecord.subtype` 与 `systemPayload` union。
- 增加 `ResumedSessionData.artifactSnapshot?`。

### Milestone B: store 集成

- `SessionArtifactStore` 支持 seed artifacts。
- `upsertMany()` 根据 `retention` 决定是否调用 persistence。
- `remove()` 写 tombstone。
- 保持 V1 `artifact_changed` event shape 不变，只增加 optional fields。

### Milestone C: load/replay 集成

- `SessionService.loadSession()` 提取 artifact snapshot。
- `AcpAgent.createAndStoreSession()` 创建 session 后 seed store。
- replay 历史时同 identity artifact 不重复创建。

### Milestone D: REST/SDK

- SDK type 增加 optional fields。
- `POST /session/:id/artifacts` 支持 `retention: "restorable"`。
- 新增 `pinArtifact()` / `unpinArtifact()` SDK 方法。
- capability gate UI。

### Milestone E: content retention

- 增加 daemon managed artifact storage manifest。
- 实现 pin content、hash 校验、quota、GC。
- 支持 published artifact 绑定 trusted contentRef。

## 10. 测试计划

必须覆盖：

- metadata journal append 后 daemon restart/load 恢复 artifact list。
- DELETE tombstone 后 load 不复活 artifact。
- sidecar source metadata 过期时 fallback 到 JSONL，不能读取陈旧 snapshot。
- workspace artifact 恢复时文件存在/缺失/ symlink escape 三种状态。
- external URL 只恢复 metadata，不发网络请求。
- corrupt sidecar fallback 到 JSONL。
- corrupt JSONL record 被跳过且不影响其它 artifacts。
- chat recording / persistence disabled 时不声明或不启用 metadata restore。
- pin/save 显式写失败时返回错误。
- tool artifact 持久化失败时降级为 live-only，不影响 tool turn。
- branch/fork 时 artifact records 的 sessionId/id 处理。
- archive/unarchive/delete session 时 sidecar、content refcount 和 GC 行为。
- SDK 旧 client 忽略 optional fields 后仍能展示 V1 artifacts。

## 11. 不建议在 V2 做的事

- 自动抓取普通 markdown link。
- 自动扫描 workspace 文件变更。
- 默认复制所有 workspace artifact 内容。
- 对 external URL 做 reachability poll。
- 把 `clientId` 作为删除或 pin/save 的授权凭证。
- 在 GET 热路径里做大量 fs/network 校验。
- 把持久化失败变成普通 tool turn 失败。

## 12. 推荐发布口径

V2 建议作为一个完整 phase 发布：

- capability：`session_artifacts_persistence`
- capability：`session_artifacts_content_retention`
- 默认恢复显式登记的 artifact metadata。
- 用户手动注册的 artifact 默认 `restorable`，session load/replay 后继续出现在列表中。
- 显式 `pin/save` 才做 content retention。
- quota、hash、manifest、GC 必须和 `pin/save` 同期具备，不能只暴露保存入口。
- 用户文档明确：metadata restore 恢复的是“产物索引”，不是“产物内容备份”；content retention 才是受配额和 GC 约束的内容保存。

这样可以一次性讲清楚 V2 的完整语义：默认恢复列表，显式保存内容，所有长期存储都受权限、配额、hash 和 GC 约束。
