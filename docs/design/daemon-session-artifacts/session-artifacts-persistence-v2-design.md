# Qwen Code Daemon Session Artifacts V2 持久化设计

本文延续 PR #5895 的 V1 session artifact API，设计 V2 持久化能力。V1 设计见同目录下的 [session-artifacts-daemon-api-implementation-design.md](./session-artifacts-daemon-api-implementation-design.md)。

V2 的目标是在不破坏 V1 live session 语义的前提下，让 artifact metadata 可以在 daemon 重启、session load/replay 后恢复，同时把内容持久化、权限、配额和清理策略收窄到可审计、可回滚的范围内。

## 1. 设计结论

V2 是一个完整设计 phase，但对外能力仍按 capability gate 暴露。实现可以先交付 metadata restore，再在 quota、hash、manifest 和 GC 都具备后声明 content retention capability；client 不应依赖“V2”这个阶段名推断功能，而应读取 capability。

两层能力：

1. Metadata restore：默认恢复 artifact 的结构化 metadata 和资源引用，不复制实际内容。
2. Content retention：只有用户或可信 publisher 显式 `pin/save` 时，才把可控内容复制或绑定进 daemon-managed artifact storage。

对应 capability：

- `session_artifacts_persistence`：支持 metadata 持久化与 session load/replay 恢复。
- `session_artifacts_content_retention`：支持显式内容保留、配额、hash、manifest 和 GC。只有这一整套能力可用且当前配置启用时才声明。

核心原则：

- V1 的 `SessionArtifactStore` 仍是 live session 的权威内存索引。
- V2 增加 JSONL artifact journal/snapshot，用于在 daemon 侧创建 live store 时 seed 初始状态；JSONL append 必须由当前拥有 chat recording 的 core/ACP child 路径完成，daemon-side store 不能直接写 transcript。
- V2 默认 JSONL-only。sidecar cache 不进入 V2 发布门槛；只有实测 session load 成本不可接受时，才另行设计可删除缓存。
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

V1 到 V2 的 live upgrade 需要单独处理：已经在内存中的 V1 live artifacts 没有 JSONL journal。V2 首次触达这些 live sessions 时，应通过 chat recording owner 提供的 artifact persistence writer 写入一条初始 `session_artifact_snapshot`，然后再接受新的 restorable/pinned artifact mutation。backfill 不能把 live store 原样序列化；必须对每个 artifact 重新执行 ingest validation、privacy minimization 和 `retention` materialization。单条 artifact 不合格时跳过或降级该条，不能让一次坏记录拖垮整个 backfill。若 writer 不可用或 backfill 整体失败，该 session 继续保持 V1 live-only 行为，并记录 structured warning；不能让用户误以为已有 live artifacts 已经可恢复。

backfill 不能逐条向 JSONL streaming 写入 artifact event。实现必须先在内存中完成校验、最小化和降级，形成完整 candidate snapshot 后，再一次性 append `session_artifact_snapshot`。如果 candidate 构建或 snapshot append 失败，不能留下部分 durable artifact state。backfill snapshot 应记录 `expectedArtifactCount`，便于 fsck 和 restore warning 区分“完整但有条目被校验跳过”和“部分写入/损坏”。

### 2.2 retention 分层

新增 optional field：

```ts
type ArtifactRetention = 'ephemeral' | 'restorable' | 'pinned';
```

含义：

- `ephemeral`：只存在于 live store。daemon/session 消失后不恢复。
- `restorable`：metadata 写入持久化 journal。session load/replay 后恢复为 artifact item，但不保证底层资源仍存在。
- `pinned`：metadata 持久化，并保存可控内容或稳定 content reference；直到用户 unpin/delete、TTL 到期或 GC 策略命中。

默认规则：

- Tool result、`record_artifact`、hook artifact：默认 `restorable`，但只持久化 metadata。
- 用户在交互式前端手动注册的 Client POST artifact：默认 `restorable`，恢复后仍出现在 artifact list 中。
- 后台/自动化 client POST：如果只是临时 UI 状态，应显式请求 `retention: "ephemeral"`；SDK 应提供明确的 ephemeral helper。
- `published` artifact：默认 `restorable`；如果 publisher 提供可校验 daemon-managed content，则可升级为 `pinned`。

如果 chat recording 被禁用，metadata persistence 默认禁用，capability 不声明。

### 2.3 用户注册 artifact 恢复语义

用户手动注册的 artifact 在 V2 恢复后应该继续存在，但恢复的是“artifact metadata item”，不是无条件内容备份。

恢复后的结果按资源状态区分：

- `external_url`：恢复 title、description、url、metadata。daemon 不访问远端 URL；URL 是否仍可打开由 client 点击时决定。
- `workspace`：恢复 workspacePath 和 metadata；如果文件仍在 workspace 内且可访问，`status: "available"`；如果文件已删除、移动或 symlink 逃逸，`status: "missing"` 或 `restoreState: "blocked"`。
- `managed`：恢复 managedId；只有 managed storage manifest 仍能解析时才 `available`。
- `published`：恢复 published locator；只有仍满足 trusted publisher manifest 校验时才保留 published trust。

因此，“用户注册的 artifact 恢复后还存在吗？”的答案是：V2 中应该存在于列表里，除非用户 DELETE、metadata 被 GC/tombstone、恢复校验发现记录损坏到无法安全展示，或 chat recording / persistence 被禁用。是否还能打开底层内容，则取决于 storage 类型和是否做了 `pin/save content`。

daemon 不能只凭 request payload 判断“手动”还是“后台”。实现上应由连接 principal、SDK helper 或 UI action path 标识交互式注册来源；无法确认交互意图的 client 应按显式 `retention` 处理，缺省仍接受 `restorable`，但受 session metadata quota 和审计记录约束。

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
  persistenceWarning?: {
    code:
      | 'persist_failed'
      | 'journal_budget_exceeded'
      | 'metadata_quota_exceeded'
      | 'validation_downgraded'
      | 'restore_pruned'
      | 'content_unavailable'
      | 'delete_not_durable'
      | 'content_delete_preserved'
      | 'sticky_override_active';
    message: string;
  };
  contentRef?: {
    kind: 'managed_copy' | 'published' | 'workspace_reference';
    id?: string;
    sha256?: string;
    sizeBytes?: number;
  };
}
```

字段说明：

- `retention`：artifact 的持久化级别。解析顺序为：请求体显式值优先；系统内部 artifact 按 daemon policy；client POST 未指定时使用用户配置的 `defaultRetention`；无配置时回退为 `restorable`。只有 persistence capability 未声明或读取 V1-era 记录时，才按 V1 兼容的 live-only 处理。V2 writer 写 journal 时必须 materialize `retention`，不能依赖 optional 缺省。
- `persistedAt`：metadata 或 content retention 最近成功落盘时间。
- `expiresAt`：可被 GC 的时间。`pinned` 默认不设置，但 `ttlDays` pin 会转换成绝对 `expiresAt`。
- `restoreState`：恢复来源提示；不替代 `status`。
- `persistenceWarning`：非阻塞持久化/恢复风险，前端可用它提示“此 artifact 不会跨重启保留”等状态。warning code 必须覆盖实际降级原因，不能把 quota、budget、validation 和内容缺失都压成同一个模糊错误。`message` 必须来自 path-free 的固定模板或经过脱敏，不能包含 host 绝对路径、credential、token、内部 storage path 或 connection id。
- `contentRef`：仅在内容保留或可信 published storage 时出现，不暴露宿主机绝对路径。

### 3.2 Status 与 restoreState 的关系

V1 `status` 继续表示当前资源是否可用：

- `available`
- `missing`

V2 不把 `status` 扩成复杂状态，避免旧 client 误解。`blocked` 不是 `status`，只属于 `restoreState`：

- `restored`：从持久化 metadata 恢复。
- `unverified`：恢复了 metadata，但尚未完成 workspace/managed 校验。
- `blocked`：恢复时发现安全边界不满足，例如 workspace path 逃逸。
- `live`：当前进程内新产生或已刷新确认。

## 4. 持久化存储设计

### 4.1 JSONL-only source of truth

V2 默认只使用 Chat JSONL system records：

1. JSONL journal 是审计源、恢复源和跨版本迁移源。
2. `session_artifact_snapshot` 是 JSONL 内的恢复加速点，不是独立文件。
3. 不在 V2 中引入 sidecar cache。sidecar 会增加路径同步、陈旧校验、archive/unarchive/delete 联动、orphan GC 和缓存信任问题；当前 session load 已经读取 JSONL，artifact records 可以在同一轮 parse 中提取。

如果未来实测需要 sidecar，它必须作为单独设计进入，并满足两个约束：

- sidecar 只能是可删除缓存，不能承载协议正确性。
- 即使 sidecar 命中，也必须对每个 artifact 执行恢复校验，不能绕过 JSONL restore validation。

sidecar 对 V2 持久化不是 correctness requirement。当前 `loadSession()` 为恢复会读取完整 session JSONL 并重建对话树；artifact restore 在同一轮读取里提取 snapshot/event records 时，不会增加额外文件 I/O。因此，sidecar 在当前架构下只能节省 artifact records 的少量 parse/replay 成本，不能消除 session load 的主要读取成本。

把 sidecar 纳入当前 PR 会明显扩大实现面：

- JSONL 与 sidecar 的双写顺序、fsync 和 crash recovery。
- stale/corrupt sidecar 的校验、失效和 fallback。
- archive/unarchive/delete/fork/remap 时 sidecar 生命周期同步。
- sidecar 是否可信、是否可能绕过 restore validation 的安全边界。
- orphan sidecar/cache cleanup 和额外测试矩阵。

因此 V2 发布门槛保持 JSONL-only。sidecar 只在以下任一条件被 profiling 或产品需求证明后再进入独立设计：

- `loadSession()` 不再需要读取完整 JSONL，sidecar 可以避免一次 cold-start 全量扫描。
- artifact list 需要在不 load session history 的场景下冷启动展示。
- 实测 artifact restore，而不是对话历史重建，成为 session load 的主耗时。
- 需要跨 session/project 的 artifact 搜索或全局索引。

### 4.2 JSONL writer ownership and branch model

Artifact persistence records 是 chat transcript 的一部分，必须遵循现有 `ChatRecord` 的 parent/leaf 语义：

- JSONL append 只能通过拥有 `ChatRecordingService.appendRecord` 的进程或它暴露的明确 RPC 完成。daemon-side `SessionArtifactStore` 可以用 operation queue 协调 live state、SSE 和 persistence request 顺序，但不能自己打开并写 chat JSONL。
- 每条 `session_artifact_event` / `session_artifact_snapshot` 都必须作为普通 system `ChatRecord` 挂到当前 conversation leaf 上，并获得正常的 `uuid` / `parentUuid`。
- session load/replay 只应用 active leaf chain 中的 artifact records。被 `/rewind` 丢到 abandoned branch 的 artifact upsert/remove 不再影响当前 artifact list。
- `/rewind` 或任何 leaf switch 发生时，daemon-side live `SessionArtifactStore` 必须重新对齐新的 active-chain artifact state：要么从 active-chain replay result reseed，要么在 rewind 操作中向 surviving chain 写一条当前 artifact snapshot top-up。V2 默认采用 branch-scoped 语义；off-branch mutation 不应继续留在 live flat map 中等待下次重启才消失。
- fork/branch 只复制 active chain 中的 artifact records；off-chain records 不参与目标 session 的恢复。
- 如果某个实现阶段还不能把 artifact system records 接到 active leaf chain，就不能声明 `session_artifacts_persistence` capability；否则 rewind 后会出现旧 upsert 或旧 tombstone 复活的问题。

这意味着 V2 不设计独立的 artifact log 文件，也不设计绕过 chat tree 的 side log。artifact persistence 的正确性来自同一条 active chat history，而不是 daemon 当前内存状态。

### 4.3 JSONL system record

给 `ChatRecord.subtype` 增加：

```ts
'session_artifact_event' |
  'session_artifact_snapshot' |
  'session_artifact_fork_marker';
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
    artifact?: PersistedSessionArtifact;
    reason?:
      | 'explicit'
      | 'quota_pruned'
      | 'restore_pruned'
      | 'unpin_to_ephemeral'
      | 'ttl_expired';
  }>;
}

interface SessionArtifactSnapshotRecordPayload {
  v: 2;
  sessionId: string;
  sequence: number;
  generatedAt: string;
  artifacts: PersistedSessionArtifact[];
  tombstonedIds: string[];
  stickyEphemeralIds: string[];
  expectedArtifactCount?: number;
}

interface SessionArtifactForkMarkerRecordPayload {
  v: 2;
  sessionId: string;
  forkId: string;
  phase: 'begin' | 'complete';
  expectedArtifactCount: number;
  writtenArtifactCount?: number;
}

type PersistedSessionArtifact = Pick<
  DaemonSessionArtifact,
  | 'id'
  | 'kind'
  | 'storage'
  | 'source'
  | 'status'
  | 'title'
  | 'description'
  | 'workspacePath'
  | 'managedId'
  | 'url'
  | 'mimeType'
  | 'sizeBytes'
  | 'metadata'
  | 'createdAt'
  | 'updatedAt'
> & {
  retention: ArtifactRetention;
  persistedAt: string;
  expiresAt?: string;
  contentRef?: DaemonSessionArtifact['contentRef'];
  clientRetained?: boolean;
  createdSequence: number;
};
```

`sequence` / `createdSequence` 必须来源于 JSONL record ordering，例如 line/order index 或 ChatRecord append order，不能使用 daemon 进程内会在重启后归零的 counter。读取时以 JSONL 顺序为准；字段仅用于检测异常、生成 snapshot、恢复稳定排序和 quota prune tie-break。

`PersistedSessionArtifact` 必须是正向 allowlist（显式 `Pick` 或独立 interface），不能用 `Omit<DaemonSessionArtifact, ...>` 负向排除。未来如果 `DaemonSessionArtifact` 增加新的 runtime-only 字段，编译时断言应要求维护者显式决定是否进入 persisted allowlist，避免 schema 污染。

只写经过 store validation/normalization 后的最小化 artifact shape。除 `clientRetained` 和 `createdSequence` 这两个恢复语义字段外，不写 V1 内部字段或运行时派生字段：

- 不写 `identityKey`
- 不写 `trustedPublisher`
- 不写绝对 `workspaceCwd`
- 不写 transport token / auth principal
- 不写 `restoreState`
- 不写 `persistenceWarning`
- 不写 `clientId` 或 live-process owner principal；`source` 只作为显示/审计 hint，不能用于授权

删除 artifact 或 unpin 到 `ephemeral` 必须写 tombstone change，避免历史 replay 后被旧 upsert 复活。tombstone 不是永久禁止同一 id 再出现：它只覆盖自己之前的 upsert，直到之后出现更高 sequence 的显式 upsert。`reason: "unpin_to_ephemeral"` 是 sticky override：后续同一 artifact id 的隐式/default upsert 仍按 live-only 处理，只有用户或可信 client 显式请求 `retention: "restorable"` 或 pin/save 才能写入 superseding upsert。

sticky override 不能只存在于历史 tombstone event 中。snapshot writer 必须把尚未被显式 supersede 的 `unpin_to_ephemeral` 状态写入 `stickyEphemeralIds`；restore reader 先恢复 snapshot 中的 sticky set，再应用 snapshot 之后的 upsert/remove。否则 snapshot baseline advance 后旧 tombstone 不再需要 replay，sticky override 会丢失。

### 4.4 Snapshot 与 tombstone 不变量

artifact snapshot 只用于减少 replay 的 artifact event 应用量；它不会减少 JSONL 文件本身的读取量。

必须满足：

- snapshot generation 必须在同一个 artifact operation queue 中串行执行，并严格位于所有 preceding mutation 之后。
- snapshot 是 authoritative current state：它只包含 snapshot 生成时仍有效的 artifacts。
- `tombstonedIds` 只记录 snapshot 之后仍需要覆盖旧 upsert 的 tombstones；被 snapshot 覆盖的旧 tombstones 不再进入新 snapshot payload，避免数组随历史无限增长。
- `stickyEphemeralIds` 记录当前仍处于 sticky ephemeral override 的 artifact id，即使对应旧 tombstone 已经不需要 replay，也必须保留该 override 状态。
- snapshot 可以包含曾经被 tombstone 的 artifact id，前提是该 tombstone 已被更高 sequence 的显式 upsert supersede。
- load 时从新到旧选择最新 valid snapshot，然后只应用该 snapshot 之后的 artifact events。
- 如果最新 snapshot 解析失败，记录 `snapshot_invalid` warning，继续尝试上一个 valid snapshot；不能因为一个 corrupt snapshot 丢失整个 session 的 artifact metadata。
- 如果没有任何 valid snapshot，允许对 active JSONL leaf chain 做一次顺序 artifact event replay。isolated corrupt artifact record 应跳过并记录 warning；只有 branch ordering、record envelope 或 tombstone 状态已经无法建立可信顺序时，才丢弃该 session 的 artifact persistence records。

这里的 snapshot baseline advance 不会重写或删除 JSONL 里的旧 record。旧 `session_artifact_snapshot`、event 和 tombstone 仍保留在 append-only chat transcript 中；artifact 子系统只是在最新 snapshot payload 内前移恢复基线并重置工作集计数。

### 4.5 存储消耗

V2 不双写 sidecar，因此没有 JSONL + sidecar 的 metadata 重复存储。存储消耗分为 metadata journal 和 content retention：

- Metadata 单条通常约 0.5 KB - 2 KB，取决于 title、description、url 和 metadata 大小。
- 每 session 有效 persisted metadata 上限默认与 live store 对齐为 200 条，单个 snapshot 约 100 KB - 400 KB。
- JSONL journal 会保存增量事件、snapshot 和 tombstone；append-only chat transcript 本身会增长。
- content retention 才是主要空间来源，例如单 artifact 50 MB、单 session 200 MB、单 project 1 GB。

控制策略：

- artifact event journal 达到固定阈值后写 `session_artifact_snapshot`，例如每 100 次 artifact mutation 或每 256 KB artifact journal 写一次。
- artifact persistence records 跟随 chat transcript 生命周期；不做独立文件 GC。
- 每 session 增加 artifact journal working-set byte budget，例如 4 MB。该 budget 衡量恢复必须读取和应用的 artifact 工作集，也就是最新 valid snapshot 加其后的 artifact events；不能把 chat transcript 中已经被 snapshot 覆盖的旧 artifact records 计入 budget，否则 append-only JSONL 会变成不可恢复的一次性上限。
- writer 必须显式跟踪 working-set bytes：每次写 snapshot 后记录该 snapshot 的 artifact byte size、JSONL append position 或 line index 作为 `postSnapshotBase`，之后每个 artifact event append 增加 `postSnapshotEventBytes`。预算检查使用 `snapshotBytes + postSnapshotEventBytes`，snapshot baseline advance 成功后重置 counter。若 writer 无法确认 base position 或 counter 状态，必须保守写新 snapshot；仍无法确认时降级或报错，不能无界追加。
- budget 接近上限时先尝试写新 snapshot。若最新 snapshot 加 post-snapshot events 仍超过 budget，则不再写新的 restorable metadata，普通 artifact 降级为 `ephemeral` 并带 `persistenceWarning.code = "journal_budget_exceeded"`；用户显式 pin/save 仍返回明确错误而不是静默降级。
- 不把 content bytes 写进 JSONL；content 只进入 daemon-managed artifact storage。

## 5. 写入与恢复流程

### 5.1 Ingest-time validation

任何 artifact 进入 live store 和 JSONL 之前都必须做 ingest-time validation，不能只在 restore 时校验：

- `workspacePath`：必须是相对路径；resolve/realpath 后不能逃逸当前 workspace。
- `url`：按 storage type 校验 scheme、userinfo、secret-like query/fragment。
- `managedId`：拒绝路径形态、`..`、绝对路径、分隔符。
- `published`：只能由 daemon 内部 trusted publisher 或 manifest-validated path 产生，不能由 client payload 自称。
- `contentRef`：如果存在，必须验证 `kind`/`id` shape，拒绝分隔符、绝对路径和 `..`，并只能通过 daemon-managed manifest 解析。
- `expiresAt`：daemon-only 字段；client payload 中出现时必须拒绝或 strip。只有 pin/save 的 `ttlDays` 可以由 daemon 转换成 `expiresAt`。
- `restoreState` / `persistenceWarning`：runtime-only response 字段；client payload 中出现时必须拒绝或 strip，不能写入 persisted artifact。
- `clientRetained`：只能是 boolean，表示用户保留意图和稳定排序 hint，不是授权信号。只有显式 REST/SDK/UI action 可以设置；后台自动 ingest 不能伪造为用户保留。
- `metadata`：执行 primitive-only、size limit、secret key/value 和 unsafe display payload checks。

验证失败时：

- 明确恶意或越界输入：拒绝请求。
- 可能包含敏感 locator 但用户仍想展示 live artifact：可降级为 `ephemeral`，并写 `persistenceWarning.code = "validation_downgraded"`；不能写入 JSONL。

### 5.2 Artifact 写入流程

V1 流程：

```text
ingest input -> normalize/validate -> upsert live store -> publish artifact_changed
```

V2 流程：

```text
ingest input
  -> normalize/validate
  -> in SessionArtifactStore operationQueue: compute effective mutation
  -> for restorable/pinned changes: request chat-recording writer append
     artifact journal/snapshot on the active leaf chain
  -> apply live-store mutation
  -> publish artifact_changed with effective retention/warning fields
```

`SessionArtifactStore` 的 operation queue 负责串行化同一 session 的 live mutation、persistence request 和 SSE 顺序；真正的 JSONL append 仍由 chat recording owner 完成。普通 tool/hook artifact 如果 persistence writer 不可用，可以降级为 live-only `ephemeral` 后进入 live store；显式 `pin/save` 不能降级，必须返回错误。

如果 sticky ephemeral override 抑制了隐式/default upsert 的持久化，live artifact 必须带 `persistenceWarning.code = "sticky_override_active"`，并记录 structured log `action=sticky_override_suppressed` 和 counter metric。否则排障时会看到合法 upsert input 却找不到对应 durable record。

live store eviction 和 persisted metadata prune 必须分开：

- live store 上限只影响当前内存 view，不写 durable tombstone。V2 live eviction 必须 retention-aware，优先丢弃 ephemeral/unretained item；不能因为 V1 live cap 就让 `restorable` / `pinned` metadata 永久丢失。
- persisted metadata quota prune 才写 `quota_pruned` / `restore_pruned` remove change，并且必须和触发它的新 upsert 在同一次 durable journal append 中完成。append 成功后再更新 live store；append 失败时不裁剪已持久化 metadata。

### 5.3 写入失败语义

区分两个入口：

- 普通 tool/hook artifact：持久化失败不应让工具调用失败；artifact 仍可进入 live store，但必须先把 live store 中的 `retention` 降级为 `ephemeral`，设置 `persistenceWarning`，再发布 `artifact_changed`。
- 显式 `pin/save` API：持久化失败必须返回错误，不能假装已经保存。

对会影响恢复结果的删除型 mutation，按原因区分：

- V1/当前 live cap eviction：只影响 live view，不写 tombstone，不改变持久化 metadata。
- `quota_pruned` / `restore_pruned` / unpin-to-`ephemeral`：必须 durable-first 或 rollback。tombstone append 失败时保持 persisted state 不变；后台 prune 记录 structured warning 并稍后重试，显式 unpin API 返回错误。
- 显式 DELETE：必须先从 live store 移除，避免磁盘满或 transcript 写失败时阻止用户隐藏敏感 artifact。随后 best-effort 写 tombstone；如果 append 失败，daemon 在当前进程内保留 pending tombstone 并重试，同时通过 API warning / structured log 表明“本次删除尚未 durable，daemon crash 后可能从历史恢复”。不能把这种状态报告成已持久删除。retry 必须有边界：默认指数退避从 1s 开始、上限 60s，总重试窗口 10 分钟或 10 次尝试，以先到者为准；全部失败后停止自动重试，保留 live warning / metric，要求用户在 storage 恢复后重新发起 DELETE。V2 不引入单独的 durable pending-delete queue，因为这会变成第二套持久化 source of truth。
- 显式 DELETE 携带 `deleteContent: true` 时，content 删除必须等待 tombstone durable 后才能执行。live view 仍可先移除，但如果 tombstone append 失败，daemon 不得删除 managed/pinned content，response 必须同时暴露 `delete_not_durable` 和 `content_delete_preserved` warning。tombstone durable 后，content 删除仍需通过引用集合确认和 §7.1 授权；共享 contentRef 只能释放当前 artifact 引用，不能强删。

建议 warning：

```text
[artifacts] session=<id> action=persist_failed artifact=<id> reason=<code>
[artifacts] session=<id> action=delete_not_durable artifact=<id>
[artifacts] session=<id> action=content_delete_preserved artifact=<id> reason=tombstone_not_durable
[artifacts] session=<id> action=sticky_override_suppressed artifact=<id> prior_reason=unpin_to_ephemeral
```

### 5.4 恢复流程

session load/replay 时：

1. `SessionService.loadSession()` 读取 JSONL，并在同一轮 parse 中提取 artifact snapshot/event records。
2. 基于 active leaf chain 提取最新 valid `session_artifact_snapshot` 和之后的 `session_artifact_event`。abandoned branch 上的 artifact records 必须忽略。
3. 重建 artifact snapshot，应用 tombstone。
4. 对每个 artifact 重新执行 V2 restore validation。
5. load result 携带 `artifactSnapshot` 回到 daemon-side bridge。
6. daemon bridge 在 `createSessionEntry` / restore completion 时用 snapshot 初始化 daemon 侧 `SessionArtifactStore`。
7. `GET /session/:id/artifacts` 读取的就是这个 daemon-side store。

不要在 ACP child process 的 agent/session 对象里 seed `SessionArtifactStore`：生产 HTTP API 可见的 store 在 daemon-side bridge 中创建。

`loadSession()` 必须是 read-only：它不能在解析过程中写 `restore_pruned` tombstone，也不能直接触发 content GC。若 restore 后发现当前 live cap 或 policy 比历史更严格，daemon-side store 在创建完成、persistence writer 可用后，再通过正常 operation queue 写 `restore_pruned` tombstone；writer 不可用时只在 live view 中隐藏超限 item，并记录 warning，下一次 load 仍可能重新看到这些待裁剪记录。

rewind/replay 中的 live store 处理必须和 load 一致：一旦 active leaf 改变，flat live store 不能继续保留 off-branch artifact mutation。若当前实现没有 active-chain replay result 可直接 reseed，必须在 rewind 完成时写入 artifact snapshot top-up，否则不能启用 persistence capability。

具体集成点必须是显式 hook，而不是靠下一次 GET 懒修复。建议由 rewind/leaf-switch 实现调用 daemon bridge 的 `onActiveLeafChanged(sessionId, artifactSnapshot)`，或在现有 session load/replay result 中携带同等事件；artifact store 收到后在同一 session operation queue 中 reseed 或写 top-up snapshot。

### 5.5 恢复时校验

恢复时必须重新校验：

- `workspacePath`：仍必须是相对路径，按 restore 时的 workspace root 重新 resolve/realpath/stat，不能逃逸当前 workspace。workspace 重定位后，如果相同相对路径仍存在则可恢复为 `available`；如果文件缺失或新 workspace layout 不一致，则恢复为 `missing`。V2 不做自动 path remapping。
- `external_url`：只允许 `http:` / `https:`；拒绝 username/password credential；secret-like query/fragment 必须 redacted、降级为 non-openable locator，或整条 artifact 降级/阻断。
- `published`：可以恢复 `file:` locator，但只能在 trusted publisher manifest 重新校验通过、且目标属于 daemon-managed published storage 时允许。普通 `external_url` 永远不能通过 `file:`。
- `managedId`：拒绝路径形态、`..`、绝对路径、分隔符。
- `contentRef`：验证 `kind`/`id` shape，拒绝分隔符、绝对路径和 `..`；只能通过 daemon-managed manifest 在当前 session/artifact scope 内解析；暴露前必须校验 stored size/hash metadata。
- `metadata`：重新执行 primitive-only、size limit、secret key/value 和 unsafe display payload checks。

恢复失败时：

- 安全失败：保留条目但 `restoreState: "blocked"`，`status: "missing"`，不提供可打开 locator。
- 资源缺失：`status: "missing"`。
- 非安全型字段损坏：跳过该 artifact，并记录 warning。

### 5.6 Branch / fork 语义

现有 `/branch` 会复制 active JSONL record chain 并重写 `sessionId`。V2 artifact records 只从 active leaf chain 复制；rewind 后落在 abandoned branch 上的 artifact records 不会进入 fork。复制时必须显式处理 artifact id：

- 同一个资源在新 session 中应得到新 artifact id，因为 V1 identity 包含 `sessionId`。
- fork 写入目标 session 时，应根据目标 `sessionId + locator` 重新计算 artifact id。
- tombstone 也要按目标 session 的新 id 重写。只要 tombstone 的 artifact id 可以安全 remap，就应保留到目标 session，即使目标 active chain 中暂时找不到对应 upsert；orphan tombstone 没有匹配 upsert 时是无害的，但丢弃它可能让后续同 id upsert 丢失 suppression。
- `forkedFrom` 可以记录原 session id / 原 artifact id，作为审计信息，但不能参与新 session 的权限判断。
- fork 继承 artifact metadata 时，`pinned` 必须降级为 `restorable`。fork 不继承 pinned contentRef，用户需要在 forked session 中显式 re-pin，避免通过 fork 绕过 session/project quota。

fork remap 是发布门槛：如果某条路径不能安全重写 artifact id 和 tombstone，就必须在 fork 时丢弃 artifact persistence records，不能把源 session 的 artifact id 原样带入新 session。若现有 fork 实现有类似 `file_history_snapshot` 的 top-up 机制，artifact 也只能从 active-chain replay result 生成 top-up，不能从 daemon 当前 live store 原样补写，否则会把 rewind 后不再属于历史的 artifact 带入新 session。

fork 写入目标 session 必须可检测部分失败。remap 开始前向目标 active chain 写 `session_artifact_fork_marker`，`phase: "begin"`，并带 `expectedArtifactCount`；所有 remapped artifact records 写完后再写 `phase: "complete"` 和 `writtenArtifactCount`。session load 如果看到 begin 但没有 complete，或 count 不匹配，必须记录 `fork_incomplete`，并把本次 fork 写入的 artifacts 标记为 `restoreState: "unverified"` 或丢弃该 fork batch；不能把部分 fork 当完整恢复结果。

metadata 的 fork amplification 在 V2 中作为有界 trade-off 接受：fork 需要 session mutate 权限，每个 fork 仍受 200 条 persisted metadata 上限，metadata 单条较小，且不会继承 pinned content bytes。V2 不引入 project-level metadata quota；实现必须记录 forked artifact count metric/log，若实际滥用再引入 project-level cap。content retention 仍受 session/project content quota 约束。

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

当前 `/capabilities` 是 string feature list，因此不能用 `enabled: false` 表达“实现存在但当前关闭”。规则是：

- 行为可用且当前配置启用时才声明对应 feature string。
- chat recording 禁用、metadata persistence 禁用或 writer 不可用时，不声明 `session_artifacts_persistence`。
- content retention 的 `pin/save content`、quota、hash、manifest 和 GC 都可用且当前启用时，才声明 `session_artifacts_content_retention`。
- 如果 client 需要读取 limits/default retention，应另设计 config endpoint 或 SDK config query；不要把结构化 details 混入现有 string-only capability contract。

### 6.2 Add artifact

`POST /session/:id/artifacts` 允许 optional：

```json
{
  "title": "Report",
  "kind": "html",
  "storage": "workspace",
  "workspacePath": "reports/run.html",
  "retention": "restorable",
  "clientRetained": true
}
```

限制：

- client 可以请求 `ephemeral` 或 `restorable`。
- client 不能请求 `pinned`。
- `clientRetained` 可选，仅表示用户保留意图和排序 hint；服务端必须按 §5.1 校验来源，不能把它当授权。
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
  "ttlDays": 90,
  "clientRetained": true
}
```

语义：

- `mode: "metadata"`：升级为 `restorable`。
- `mode: "content"`：复制或绑定可控内容，升级为 `pinned`。
- pin 一个仍为 `ephemeral` 的 live artifact 时，必须创建新的 journal upsert event；它不是修改既有 persisted record。
- pin/save 是显式保留意图，成功后应把 `clientRetained` materialize 为 `true`，除非 request 明确设置为 `false`。
- `ttlDays` 只允许和 `mode: "content"` 一起使用，由 daemon 在 pin 时转换为绝对 `expiresAt = now + ttlDays`。如果提供，必须是正整数，并受默认最大值 365 天约束；超过上限返回 `INVALID_ARGUMENT`。`mode: "metadata"` 携带 `ttlDays` 返回 `INVALID_ARGUMENT`，不能静默忽略。
- 成功按 §6.6 返回更新后的 artifact，并发布 `artifact_changed` / `updated`。
- 失败返回明确错误，不改变 artifact retention。
- 对已经 `pinned` 的 artifact，V2 pin API 默认是幂等 no-op：返回当前 artifact，不重新复制内容、不重新计算 hash、不延长 TTL。若未来需要刷新内容或延长 TTL，应设计显式 refresh/extend API；不能让重试请求隐式改变已保存内容或无限延长保留期。

### 6.4 Unpin

```http
DELETE /session/:id/artifacts/:artifactId/pin
Content-Type: application/json
```

Body：

```json
{
  "retention": "restorable"
}
```

语义：

- `retention` 可为 `restorable` 或 `ephemeral`，默认 `restorable`。
- `restorable`：删除 content retention，保留 metadata restore，并写 upsert event。该 upsert payload 必须移除 `contentRef` 和 `expiresAt`，避免恢复时引用已可被 GC 的旧 content。
- `ephemeral`：删除 content retention，live store 中保留 artifact，但写 remove tombstone，确保下次 load 不复活。该 tombstone 对同一 artifact id 是 sticky override：后续隐式/default upsert 仍保持 live-only，直到显式 `retention: "restorable"` 或 pin/save 写入 superseding upsert。
- 若要从列表移除，仍使用 V1 DELETE。

### 6.5 Delete artifact

V2 的 DELETE 仍保持 V1 幂等，但要追加 tombstone：

- 从 live store 移除。
- best-effort 写 `session_artifact_event` remove tombstone。
- tombstone 成功后，metadata restore 时不再复活。
- tombstone 失败时，当前 live view 仍删除成功，但 response/log 必须暴露 `delete_not_durable` warning；daemon 在当前进程内继续重试 pending tombstone。若 daemon crash 前仍未落盘，历史 load 可能恢复该 artifact。
- 默认不立即同步删除 managed/pinned content，但会释放该 artifact 对 contentRef 的引用；GC 默认清理无其它 session 引用的 daemon-managed content。

可选 body 或独立 endpoint 支持内容删除：

```json
{
  "deleteContent": true
}
```

`deleteContent` 表示请求立即删除可删除内容，授权要求见 §7.1 的 delete content 规则：必须是显式 REST/SDK call、有 session mutate 权限、content retention capability 启用，并满足可验证 creator-principal match 或 admin override。共享 contentRef 只能在后台引用集合确认没有其它 session 仍引用后删除。

`deleteContent: true` 不改变默认 DELETE 的 live-first UX，但会改变不可逆 content 删除的顺序：content bytes 只有在 tombstone durable 且引用集合确认无其它 session 仍引用后才能删除。如果 tombstone 未 durable，API 只能报告当前 live view 已删除、content preserved，不能报告 content delete 成功。

### 6.6 Mutation responses

Pin、unpin 和 delete 必须使用一致的 mutation response，避免 client 猜测状态：

成功：

- Pin：`200 OK` 返回更新后的 `DaemonSessionArtifact`。
- Unpin：`200 OK` 返回更新后的 `DaemonSessionArtifact`；`retention: "restorable"` 时 `contentRef`/`expiresAt` 已移除，`retention: "ephemeral"` 时 response 可以返回当前 live-only artifact，并带 `persistenceWarning.code = "sticky_override_active"`。
- DELETE：`200 OK` 返回 `{ "deleted": true, "artifactId": string, "warnings"?: [...] }`。
- `202 Accepted`：仅用于 DELETE live view 已移除但 tombstone 尚未 durable 的情况，body 必须包含 `warnings[].code = "delete_not_durable"`。如果 request 包含 `deleteContent: true`，还必须包含 `warnings[].code = "content_delete_preserved"`，说明 content 未删除且仍等待 durable tombstone / GC 引用确认。

失败：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "ttlDays is only valid with content pinning"
  }
}
```

建议状态码：

- `400 INVALID_ARGUMENT`：非法 body、`ttlDays` 与 `mode` 不匹配、client 请求 `pinned`。
- `403 FORBIDDEN`：缺少 session mutate 权限或 `deleteContent` 授权不足。
- `404 NOT_FOUND`：artifact 不存在；DELETE 仍可保持幂等成功，但 pin/unpin 应返回 404。
- `409 CONFLICT`：当前 artifact 状态不能完成请求，例如 content source 已不可用。
- `429 METADATA_QUOTA_EXCEEDED`：metadata slots 已满且没有可裁剪 candidate，阻止显式 restorable/pin/save。
- `429 QUOTA_EXCEEDED`：content quota 阻止显式 `mode: "content"` pin/save。
- `503 PERSISTENCE_UNAVAILABLE`：writer 或 content storage 不可用，显式 pin/save/unpin 不能 durable 完成。

## 7. 安全设计

### 7.1 授权原则

不要把 public `clientId` 当授权边界。V2 的实际 HTTP 信任边界仍是 daemon bearer token + route-level read/mutate permission；在现有 auth 模型下，`session_owner` 不能被安全 mint 或跨 daemon restart 持久化。因此 V2 不引入强于 token-holder 的 owner tier。

内部 principal 只用于审计、默认策略和防止 payload spoofing；不是 durable authorization source：

```ts
type ArtifactPrincipal =
  | { kind: 'token_holder' }
  | { kind: 'client_connection'; id: string }
  | { kind: 'trusted_publisher'; id: string }
  | { kind: 'hook'; extensionId: string };
```

授权规则：

- list：需要 session read 权限。
- add ephemeral/restorable：需要 session mutate 权限。
- pin/save content：需要 session mutate 权限，并且必须是显式 REST/SDK call；“用户确认”在 V2 中不表示 agent permission-vote，而是 UI 或 headless client 主动调用 pin/save endpoint。
- delete metadata：需要 session mutate 权限。V1 same-principal delete guard 只能作为 live-process UX guard 和 audit hint；它依赖当前连接上下文，不能跨 daemon restart 证明 artifact owner。restore 后不能从 public `clientId` 伪造 ownership，删除授权退化为 session-level mutate 权限并记录 `ownership_unverified` audit。
- delete content：需要 session mutate 权限、`session_artifacts_content_retention` capability 启用、显式 REST/SDK call，以及当前进程可验证的 creator-principal match 或显式 override/admin policy；background session/hook 不能直接发起 `deleteContent`。restore 后如果没有 durable owner proof，默认只能释放当前 artifact 引用并交给 GC，不能立即强删共享 content。若 contentRef 被多个 session 引用，也只能释放当前 artifact 引用，不能强删共享内容。

如果未来需要真正的 `session_owner`，必须先设计 durable per-session capability 或 ACL，不能在本 V2 文档中隐式假设。

### 7.2 持久化内容边界

默认不复制：

- external URL 内容
- 任意 workspace 文件
- 普通 assistant link

允许 content retention 的来源：

- trusted `ArtifactTool` / publisher 生成的 `published` artifact。
- 用户显式 pin 的 workspace artifact，且文件在 workspace 内、类型/大小可控。
- client 上传或登记的 managed artifact，前提是通过 daemon API 接收并校验。

daemon-managed artifact storage 必须有明确 root：

- `managed_copy` content root 位于 daemon 数据目录下的 artifact content 区域，例如 `<daemonDataDir>/artifacts/content/`。
- `published` file root 位于 daemon 数据目录下的 published artifact 区域，例如 `<daemonDataDir>/artifacts/published/`，或位于配置声明的等价 daemon-owned root；root id 必须写入 publisher manifest。
- JSONL 里不能保存可直接信任的宿主机绝对路径。restore 时只能读取 manifest 中的 root id 和相对 locator，resolve/realpath 后必须仍位于对应 root 内，并拒绝 symlink/path escape。
- trusted publisher manifest 至少记录 publisher id、artifact id、storage root id、relative path 或 content id、sha256、sizeBytes 和 createdAt。`file:` locator 只能由该 manifest 重新生成，不能来自 client payload 或旧 JSONL 字段。

内容复制必须 race-safe：

- workspace containment 校验通过。
- 只允许 regular file；拒绝目录、FIFO、device、socket 和其它特殊文件。
- 打开文件时使用 no-follow 语义；Linux 可用 `openat2(RESOLVE_NO_SYMLINKS)`，其它平台用可用的 no-follow/open-handle revalidation 组合。
- 打开后对 file handle 执行 fstat/revalidate，确认仍是 regular file、仍在 workspace containment 内。
- 拒绝 link count 异常的 hardlink，除非后续有明确 allowlist。
- 读取时按 stream 强制 max bytes，不能先信任 stat size。
- hash exactly the bytes copied，并保存 sha256、size、mimeType。
- 打开/下载 retained content 前重新校验 manifest/hash。

### 7.3 隐私和敏感信息

持久化前必须做最小化：

- 不保存 host 绝对路径。
- 不保存 URL username/password。
- external URL 的 secret-like query/fragment 必须拒绝、redact，或将 artifact 降级为 `ephemeral` / non-openable locator；不能原样写入 JSONL。
- metadata 使用 allowlist 或 secret-key denylist；`token`、`password`、`secret`、`cookie`、`authorization` 等 key/value 必须拒绝、redact，或降级为 `ephemeral`。
- metadata 仍限制 4 KB。
- title/description/metadata 继续执行 unsafe display payload checks。
- `persistenceWarning.message` 即使只作为 live response 字段，也必须使用 path-free 模板或脱敏文本；不能把 host path、credential、token、content root、connection id 写入 warning。

建议新增设置：

```json
{
  "sessionArtifacts": {
    "persistence": {
      "enabled": true,
      "defaultRetention": "restorable",
      "maxLiveArtifacts": 200,
      "maxPersistedMetadata": 200,
      "journalBudgetBytes": 4194304,
      "snapshotThresholdMutations": 100,
      "snapshotThresholdBytes": 262144,
      "contentRetention": {
        "enabled": false,
        "maxArtifactBytes": 52428800,
        "maxTotalBytes": 1073741824,
        "maxTtlDays": 365,
        "ttlScanIntervalSeconds": 900,
        "gcSweepIntervalSeconds": 3600,
        "gcGracePeriodSeconds": 3600
      }
    }
  }
}
```

这些字段是 operator tunables；如果实现选择硬编码某些值，也必须在配置 schema/文档中明确标注为不可配置常量。文档其它 section 引用的默认值应统一来自这里，避免实现方猜测哪些值可以调整。

## 8. 配额、GC 与稳定性

### 8.1 Metadata quota

建议默认：

- live store 上限仍为 200。
- persisted metadata 上限每 session 200，与 live store 对齐。
- snapshot record 最多保留 200 个当前有效 artifacts。

live store 上限是内存展示约束，不是 durable deletion policy：

- V2 live eviction 必须优先淘汰 `ephemeral` artifact。
- 如果必须在 restorable artifacts 中选择 live view，应按 `clientRetained`、`retention`、`createdSequence` 和 `artifactId` 做确定性排序，只隐藏当前 live view 中优先级最低的 item；不能写 tombstone。
- `clientRetained` 是用户保留意图，必须进入 `PersistedSessionArtifact`，用于 restore 后稳定排序和 live cap 选择。V1 的进程内 `insertSeq` 不直接持久化，但必须转换成 durable `createdSequence`。

超过 persisted metadata 上限：

- `ephemeral` 本来不写 journal，不计入 persisted metadata quota，只受 live store 上限约束。
- `restorable` 必须按确定性顺序裁剪并写 `quota_pruned` tombstone：先裁剪未 `clientRetained` 的 `restorable` artifact；如果仍无空间，再裁剪 `clientRetained` 的 `restorable` artifact。每一层内按 `persistedAt` 升序，缺失时按 `createdSequence` 升序，最后按 `artifactId` 字典序打破平局。`clientRetained` 是排序保护，不是绝对保护；用户需要真正保护内容时应使用 pin/save。
- `pinned` metadata 不因 metadata quota 被裁剪，但 content retention 仍受 content quota 约束。
- 如果 200 个 persisted slots 全部被 `pinned` 占用，没有可裁剪的 `restorable` candidate：
  - 自动/tool artifact 降级为 live-only `ephemeral`，带 `persistenceWarning.code = "metadata_quota_exceeded"`。
  - 显式请求 restorable/pin/save 的 API 返回 `METADATA_QUOTA_EXCEEDED`，提示用户删除、unpin 或让 pinned TTL 到期。
  - daemon 不能为了接收新 artifact 自动裁剪 pinned metadata；这会违背用户显式保存语义。

restore seed 不能超过 live store 上限；若历史里有效 persisted artifact 超过当前 live cap，daemon 可以按同一确定性规则只 seed 可见 subset，并对隐藏 item 标记 warning/metrics。只有在 metadata quota policy 确认这些 item 不应再恢复时，才通过 daemon-side operation queue 写 `restore_pruned` tombstone；`loadSession()` 本身不能写 durable prune。

### 8.2 Content quota

建议默认：

- 单 artifact：50 MB。
- 单 session pinned content：200 MB。
- 单 project pinned content：1 GB。

达到上限时：

- 新 pin/save 返回 `QUOTA_EXCEEDED`。
- 不自动删除 pinned content，除非用户设置 TTL 或 explicit GC policy。
- fork 不继承 pinned contentRef，避免 fork 绕过 quota。

### 8.3 GC

GC 只处理 daemon 管理的 content storage 和过期 metadata cache：

- 删除已被 tombstone 且无其它 session 引用的 managed copy。
- 删除超过 `expiresAt` 的 non-pinned content。
- 删除超过 `expiresAt` 的 pinned content，并把对应 artifact 降级为 `restorable` 或 `missing`。该降级必须先写 durable artifact event：`action: "upsert"`、`reason: "ttl_expired"`，payload 移除 `contentRef` 和 `expiresAt`；append 成功后才能更新 live store 并让 content 进入可删除集合。append 失败时保守保留 content。
- session delete 后该 session 的 artifact journal 不再贡献 content 引用；默认删除无其它 session 引用的 content。只有用户显式导出到全局 artifact library 时，才在 session 删除后继续保留。

GC trigger：

- daemon startup 后延迟触发一次 project-scoped sweep。
- session delete、artifact delete、unpin、TTL 到期检查或 content quota pressure 后 enqueue sweep。
- 周期性 timer 可作为兜底，例如每小时一次；实现必须用单实例 lease/lock 避免并发 sweep。
- TTL 到期检测必须有独立、可观测路径：session load 后对该 session 做一次 lightweight TTL scan；后台 timer 默认每 15 分钟扫描一次 pinned `expiresAt` index；project GC sweep 作为兜底。每次 TTL scan 即使没有过期项也要记录 `ttl_scan_checked`，并导出 expired pending bytes，避免配额耗尽时根因不可见。

V2 不把 mutable reference-count table 当 source of truth。content reference set 应从 project 内 session artifact journals 的最新 valid snapshot/events 派生；content manifest 只保存 content metadata 和可选的 lastKnownReferenceCount/cache。GC sweep 在后台按 project 扫描并重建引用集合，crash 后下一次 sweep 重新计算。引用未知或扫描失败时必须保守保留 content，不能删除。

每次 GC sweep 必须跟踪 per-session scan status，例如 `{ sessionId, status: 'scanned' | 'corrupt' | 'timeout', lastScannedAt }`。只要任一相关 session 不是 `scanned`，GC 就不能删除可能只由未扫描 session 引用的 content；这些 content 必须保守保留到下一次完整扫描。corrupt journal 不能通过“跳过该 session”变成静默数据丢失。记录 action `gc_incomplete_scan`，并导出 `artifact_gc_sessions_unscanned`。

orphan content 删除必须有 grace period。默认 grace period 为 1 小时，从 GC sweep 首次确认某个 contentRef 没有任何 journal 引用并在 manifest/cache 中写入 `orphanedAt` 开始计算；下一次 sweep 只有在仍无引用且已超过 grace period 时才删除。新的 journal 引用会清除 `orphanedAt`。该值可以配置，但不能短于一次正常 pin/save 操作和 journal flush 的最长预期窗口。

GC 必须 best-effort，不阻塞 prompt/tool flow。

### 8.4 Crash consistency

要求：

- artifact store mutation 串行。
- JSONL journal append 失败不会破坏 live store。
- explicit `pin/save metadata` 必须等待 journal 落盘。
- explicit `pin/save content` 必须等待 content manifest 和 journal 都落盘。
- explicit DELETE 的 live removal 不等待 journal；tombstone append 失败时必须暴露 `delete_not_durable` 并按 §5.3 的 bounded retry 在当前进程内重试。
- explicit DELETE with `deleteContent: true` 的 content 删除必须在 tombstone durable 之后执行；tombstone append 失败时 content 必须保留，并暴露 `content_delete_preserved`。
- live cap eviction 不写 tombstone；metadata quota prune 必须 durable-first。
- reader 容忍半截 JSONL 和 corrupt artifact record。
- tombstone / snapshot 顺序异常时选择不恢复，而不是猜测。

`pin/save content` 写入顺序：

1. 复制内容到 staging path，hash exactly copied bytes，并 fsync bytes。
2. atomically move 到 daemon-managed content root，写入并 fsync content manifest。
3. append artifact journal event，引用该 contentRef，并 fsync JSONL。
4. 更新 live store 并发布 `artifact_changed`。

如果第 2 步成功但第 3 步前 crash，会留下没有 journal 引用的 orphan content；这是允许的，GC 在 grace period 后删除。如果第 3 步成功，restore 必须能通过 manifest 找到内容。显式 API 只有在第 3 步成功后才能返回成功。

### 8.5 文件读取、CPU 与 I/O 成本

V2 要避免把 artifact 恢复变成 session load 的新瓶颈。

读取路径建议：

1. `SessionService.loadSession()` 已经读取 JSONL 时，在同一轮 parse 中提取 artifact records。
2. 找到最新 valid `session_artifact_snapshot`，只 replay 之后的 artifact events。
3. 没有 valid snapshot 时允许一次顺序扫描 artifact records，但不能在 load 流程里反复扫同一文件。

CPU 成本边界：

- Metadata restore 只 parse JSON 和做字段校验，复杂度 O(artifact 数量 + 最新 snapshot 后事件数)。
- `external_url` 恢复不发网络请求。
- `workspace` 恢复只做 path normalization、realpath/stat 等元数据检查，不读取文件内容。
- `managed` / `published` 恢复只查 manifest，不读取大文件内容。
- content hash 校验只在显式 `pin/save content` 或打开 retained content 时触发，不在每次 session load 时全量 hash。

I/O 成本边界：

- V2 不额外读 sidecar 文件。
- workspace 状态校验复用 V1 的 TTL/batch 策略，不在 GET 热路径对所有 artifact 做无限制 stat。
- 对大 workspace 文件，不在恢复阶段读内容；只有用户显式 pin/save 时才读取并 hash。

推荐默认：

- artifact snapshot 上限 200 条。
- workspace status restore batch size 20，与 V1 保持一致。
- artifact journal snapshot 阈值 100 mutations 或 256 KB。
- content hash 在 pin/save 时同步完成；恢复时 lazy verify 或后台 best-effort verify。

### 8.6 Observability

V2 新增的失败路径必须有 structured logs，格式沿用：

```text
[artifacts] session=<id> action=<action> key=value
```

建议 action：

- `persist_failed`
- `retention_downgraded`
- `restore_skipped`
- `restore_blocked`
- `restore_pruned`
- `delete_not_durable`
- `quota_pruned`
- `fork_artifact_discarded`
- `fork_incomplete`
- `gc_content_deleted`
- `gc_incomplete_scan`
- `gc_reference_rebuilt`
- `snapshot_invalid`
- `sticky_override_suppressed`
- `ttl_scan_checked`
- `tombstone_conflict`
- `content_copy_rejected`
- `metadata_fsck_failed`
- `v2_writer_version_gate_failed`

这些日志不替代 API/SSE 中的 `persistenceWarning`，而是用于生产排障。

建议 metrics：

- counter: `artifact_journal_append_total{result,reason}`
- counter: `artifact_restore_total{result,restore_state}`
- gauge: `artifact_pending_tombstone_count`
- gauge: `artifact_metadata_quota_used{session}`
- gauge: `artifact_content_quota_used_bytes{scope}`
- gauge: `artifact_gc_sessions_unscanned`
- gauge: `artifact_content_expired_pending_bytes`
- counter: `artifact_sticky_override_suppressed_total`
- histogram: `artifact_gc_sweep_duration_seconds`
- counter: `artifact_gc_deleted_content_total{reason}`
- counter: `artifact_fsck_findings_total{kind}`

导出方式沿用 daemon 现有 telemetry/metrics 机制；如果当前没有 Prometheus endpoint，至少要进入 structured telemetry sink，并能按 session/project 聚合。

诊断工具分两层。metadata-only `fsck` 是 metadata restore 发布门槛，必须在 content retention 前可用，用于扫描 artifact journal/snapshot/tombstone 与 restore validation failure。full `fsck` 是 content retention 发布门槛，额外扫描 content manifests 和 daemon-managed storage。实现必须提供 CLI 或 daemon-internal API，例如 `qwen artifact fsck`，用于 dry-run 扫描 project/session artifact journals、content manifests 和 daemon-managed storage：

- 报告 dangling `contentRef`、manifest 缺失、orphan content、snapshot/tombstone 不一致和 restore validation failure。
- 默认只读；修复模式只能做可验证的安全动作，例如重新生成 snapshot、清除 stale cache marker、标记 orphan content 等待 GC。不能在没有引用集合确认和 grace period 的情况下直接删除内容。
- 输出结构化结果并计数，至少包含 `fsck_dangling_content_ref`、`fsck_orphan_content`、`fsck_snapshot_invalid`；持续出现的 dangling contentRef 或 snapshot invalid 应触发告警。

## 9. 实现方案

以下是同一个 V2 design phase 内的实现里程碑。工程上可以按 PR 拆开；对外以 capability 声明实际可用能力。

### Milestone A: 类型和 persistence service

- 新增 artifact persistence reader/writer：
  - writer 位于 chat recording owner 一侧，或者由该侧暴露明确 RPC；它负责 append event/snapshot record 到 active leaf chain。
  - reader 位于 `SessionService.loadSession()` parse/replay 路径，负责从 active leaf chain rebuild artifact snapshot。
  - 共享 restore validation、snapshot/tombstone consistency checks 和 persisted shape normalization。
- 扩展 `ChatRecord.subtype` 与 `systemPayload` union。
- 增加 load result 中的 `artifactSnapshot?`。
- 增加 metadata-only `fsck` / checker，可 dry-run 检测 corrupt artifact records、snapshot/tombstone 不一致和 restore validation failure。

### Milestone B: daemon-side store 集成

- daemon bridge `createSessionEntry` 支持 seed artifacts。
- `SessionArtifactStore` 支持 seed artifacts。
- `upsertMany()` 在 operation queue 中计算 effective `retention`、quota prune 和 live view，再通过 writer append durable records。
- `remove()` 区分 explicit DELETE、unpin-to-ephemeral、quota prune 和 live eviction；只有前三者写 tombstone，explicit DELETE 允许 live-first + pending tombstone retry。
- V1 live session 首次启用 V2 时执行 backfill snapshot；backfill 逐条 validation/minimization/materialization，坏记录跳过或降级，writer 不可用时保持 V1 live-only 并记录 warning。
- 保持 V1 `artifact_changed` event shape 不变，只增加 optional fields。

### Milestone C: load/replay 集成

- `SessionService.loadSession()` 从 active leaf chain 提取 artifact snapshot/event records，忽略 abandoned branches。
- load result 把 snapshot 交给 daemon bridge，而不是在 ACP child process 中 seed store。
- restore-prune 写入只能在 daemon-side store 创建并且 writer 可用后执行；load parse 过程保持 read-only。
- rewind/leaf switch 后，daemon-side live store 重新对齐 active-chain replay result，或通过 artifact snapshot top-up 固化 surviving chain 的当前状态。
- rewind/leaf-switch 必须调用明确 hook，例如 `onActiveLeafChanged(sessionId, artifactSnapshot)`，让 daemon-side store 在 operation queue 中完成 reseed/top-up。
- replay 历史时同 identity artifact 不重复创建。

### Milestone D: REST/SDK

- SDK type 增加 optional fields。
- `POST /session/:id/artifacts` 支持 `retention: "ephemeral" | "restorable"`。
- `POST /session/:id/artifacts` 支持 `clientRetained` boolean hint，并拒绝 client 传入 daemon-only runtime fields。
- 新增 `pinArtifact()` / `unpinArtifact()` SDK 方法。
- capability gate UI。

### Milestone E: content retention

- 增加 daemon-managed artifact storage manifest 和 project-scoped GC sweep。
- 实现 race-safe content copy、hash 校验、quota、GC。
- 支持 published artifact 绑定 trusted contentRef。

## 10. 测试计划

必须覆盖：

- metadata journal append 后 daemon restart/load 恢复 artifact list。
- artifact journal append 通过 chat recording owner 写入 active leaf chain；daemon-side store 不能直接写 JSONL。
- `/rewind` 后 abandoned branch 上的 artifact upsert/remove 不参与恢复，也不会在 fork 中复制。
- `/rewind` 后 live store 立即与 active-chain artifact state 对齐；不会等到 daemon 重启才改变 artifact list。
- V1 live session 升级到 V2 时 backfill snapshot 成功/失败两种路径；backfill 对单条 artifact 执行 validation/minimization，坏记录只影响自身。
- DELETE tombstone 后 load 不复活 artifact。
- unpin 到 `ephemeral` 后 load 不复活 artifact。
- unpin 到 `ephemeral` 后，同一 artifact id 的隐式/default re-upsert 仍保持 live-only；显式 restorable/pin 可以 supersede sticky override。
- snapshot baseline advance 后 `stickyEphemeralIds` 仍能让隐式/default re-upsert 保持 live-only，并产生 `sticky_override_suppressed` log/metric/warning。
- explicit DELETE 在 tombstone append 失败时仍先从 live view 移除，并暴露 `delete_not_durable`；daemon 重启前 tombstone retry 成功后 load 不复活。
- `deleteContent: true` 在 tombstone append 失败时不删除 content，response 同时包含 `delete_not_durable` 和 `content_delete_preserved`。
- live cap eviction 不写 tombstone；quota prune、unpin-to-ephemeral、`restore_pruned` tombstone append 失败时不会改变 persisted metadata state。
- workspace artifact ingest 和 restore 时文件存在/缺失/symlink escape 三种状态。
- workspace root 重定位：相同相对路径存在时恢复为 available；缺失或 layout 不一致时恢复为 missing；不做 path remap。
- pin/save content 时拒绝 symlink、special file、oversized stream、hardlink 异常和 TOCTOU swap。
- external URL 只恢复 metadata，不发网络请求。
- secret-bearing URL query/fragment 与 metadata key/value 不写入 JSONL。
- published local `file:` 只有 trusted manifest revalidation 通过时恢复。
- stale/tampered `contentRef` 无法绕过 daemon-managed manifest、size 和 hash 校验。
- corrupt JSONL record 被跳过且不影响其它 artifacts。
- chat recording / persistence disabled 时不声明或不启用 metadata restore。
- pin/save 显式写失败时返回错误。
- tool artifact 持久化失败时降级为 live-only，并通过 `persistenceWarning` 让 client 可见。
- branch/fork 时 artifact records 的 sessionId/id 处理，且只使用 active-chain replay result。
- fork begin/complete marker：partial fork crash、count mismatch 和 successful fork 三种路径。
- fork 继承 pinned artifact 时降级为 restorable，不继承 contentRef。
- orphan tombstone 在 fork remap 时被保留并安全 remap；无法安全 remap 的 tombstone 才丢弃。
- restore seed 与 concurrent POST 串行，不丢写、不重复。
- quota 边界：200 条、201 条 prune、pinned metadata、clientRetained/non-clientRetained 两层排序、全部 clientRetained restorable 仍可按确定性规则裁剪。
- clientRetained setter：Add artifact request 和 pin/save request 都能设置 boolean hint；后台自动 ingest 不能伪造用户保留。
- GC：tombstoned content 有/无跨 session 引用、TTL 过期、session delete 后引用重建、orphan content grace cleanup。
- GC incomplete scan：某 session journal corrupt/timeout 时不删除可能仅由该 session 引用的 content，并记录 `gc_incomplete_scan`。
- GC concurrency：并发 sweep trigger 被 lease 阻止；持有 lease 的 sweep crash 后 lease 到期可恢复；daemon shutdown 中断 sweep 后下次启动继续保守扫描。
- TTL scan：session load 和周期 timer 都能发现过期 pinned content，记录 `ttl_scan_checked` 和 `artifact_content_expired_pending_bytes`。
- TTL 过期导致 pinned 降级时写 `ttl_expired` event，payload 移除 `contentRef` / `expiresAt`，append 失败时不删除 content。
- authorization：token-holder/principal 审计路径允许和拒绝情况；V1 live same-principal guard 仅作为 live UX/audit hint，不作为 durable security boundary。
- restored artifact ownership_unverified fallback；deleteContent 在无 durable owner proof 时只释放引用，不立即强删共享 content。
- partial writes：journal 成功但 warning、content manifest 成功但 journal 失败、journal 成功后 restore 能找到 content。
- JSONL snapshot baseline advance：threshold 触发、post-snapshot replay 有界、snapshot payload 不再携带已被覆盖的 tombstones、superseded tombstone 允许同 id 重新出现、`stickyEphemeralIds` 保留 sticky state；JSONL 文件本身不被 artifact 子系统重写。
- corrupt latest snapshot fallback：回退到较旧 valid snapshot 或一次顺序 artifact replay。
- repin idempotency：已 pinned artifact 的重复 pin 不刷新内容、不延长 TTL。
- retention defaults：tool artifact 无显式 retention、client POST `pinned` 被拒绝。
- capability：string list 只在行为当前可用时声明；不依赖 `enabled:false` details。
- replay idempotency：同一 session history replay 两次不会重复 artifact。
- SDK 旧 client 忽略 optional fields 后仍能展示 V1 artifacts。
- V2 -> V1 rollback compatibility：旧 daemon 必须能解析或忽略 unknown `system` subtype，不得导致 session load 崩溃；回滚后 artifact persistence 不恢复是可接受降级。如果当前最低支持版本不能保证这一点，V2 writer 必须 capability-gate 到支持 unknown system record 的版本之后。
- rollback preflight：最低支持旧 daemon 版本加载包含 V2 event/snapshot/fork marker 的 JSONL，writer version gate 失败时拒绝写入并记录 `v2_writer_version_gate_failed`。
- artifact fsck dry-run：dangling contentRef、orphan content、snapshot invalid 和 repair-safe actions。
- metadata-only fsck dry-run：corrupt record、snapshot fallback、orphan tombstone、restore validation failure。
- API response contract：pin/unpin/delete success body、`METADATA_QUOTA_EXCEEDED` 与 `QUOTA_EXCEEDED` error code、`delete_not_durable` / `content_delete_preserved` warning、400/403/404/409/429/503 error mapping。

## 11. 不建议在 V2 做的事

- 自动抓取普通 markdown link。
- 自动扫描 workspace 文件变更。
- 默认复制所有 workspace artifact 内容。
- 对 external URL 做 reachability poll。
- 把 `clientId` 作为删除或 pin/save 的授权凭证。
- 对重定位 workspace 做自动 path remapping。
- 在 GET 热路径里做大量 fs/network 校验。
- 把持久化失败变成普通 tool turn 失败。
- 在没有测量证明需要时引入 sidecar cache。

## 12. 推荐发布口径

V2 建议作为一个完整 design phase 发布，但能力按 capability 暴露：

- `session_artifacts_persistence` 可先发布 metadata restore。
- `session_artifacts_content_retention` 只有 quota、hash、manifest、race-safe copy 和 GC 都具备时才声明。
- 默认恢复显式登记的 artifact metadata。
- 用户手动注册的 artifact 默认 `restorable`，session load/replay 后继续出现在列表中。
- 显式 `pin/save` 才做 content retention。
- 用户文档明确：metadata restore 恢复的是“产物索引”，不是“产物内容备份”；content retention 才是受配额和 GC 约束的内容保存。

Rollback procedure：

- V2 records 保留在 chat JSONL 中，不在 rollback 时删除；旧 daemon 能忽略 unknown `system` subtype 时，session load 应继续工作但不恢复 artifact persistence。
- daemon-managed content storage 不由旧 daemon 读取；rollback 后 pinned content 只是未被引用的 retained bytes。再次升级到 V2 后可恢复引用；若决定永久回滚，管理员运行 full `fsck --cleanup-orphans` dry-run/confirm 流程清理。
- 如果当前最低支持旧版本不能安全忽略 V2 system records，writer 必须 capability-gate 到安全版本之后，或者在升级前提供 migration guard，阻止写入 V2 records。
- 发布前 CI 必须用最低支持旧 daemon 版本加载包含 `session_artifact_event`、`session_artifact_snapshot` 和 `session_artifact_fork_marker` 的 JSONL，断言 session load 成功且 unknown subtype 被忽略。V2 writer 首次初始化前也要检查版本/feature gate；失败时拒绝写 V2 records，记录 `v2_writer_version_gate_failed`，保持 V1 行为。
- rollback 后 client 不能依赖 `session_artifacts_persistence` / `session_artifacts_content_retention`，因为旧 daemon 不声明这些 capability。

这样可以讲清楚 V2 的完整语义：默认恢复列表，显式保存内容，所有长期存储都受权限、配额、hash 和 GC 约束。
