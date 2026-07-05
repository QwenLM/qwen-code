# Qwen Code Daemon Session Artifacts V2 持久化设计

本文延续 PR #5895 的 V1 session artifact API，设计 V2 持久化能力。V1 设计见同目录下的 [session-artifacts-daemon-api-implementation-design.md](./session-artifacts-daemon-api-implementation-design.md)。

V2 的目标是在不破坏 V1 live session 语义的前提下，让 artifact metadata 可以在 daemon 重启、session load/replay 后恢复，同时把内容持久化、权限、配额和清理策略收窄到可审计、可回滚的范围内。

## 1. 设计结论

V2 是一个完整设计 phase，但对外能力仍按 capability gate 暴露。PR #6259 的实现范围收敛为 metadata restore、artifact JSONL journal/snapshot/rebuild/fork remap、daemon restart/load/replay 后恢复 artifact metadata，以及 REST/ACP/SDK 的 metadata persistence 暴露。content retention（workspace content pin、session-scoped managed copy、hash/manifest、quota、TTL、session-scoped GC/fsck）已拆出到后续 PR。client 不应依赖“V2”这个阶段名推断功能，而应读取 capability。

两层能力：

1. Metadata restore：默认恢复 artifact 的结构化 metadata 和资源引用，不复制实际内容。
2. Content retention：只有用户或可信 publisher 显式 `pin/save` 时，才把可控内容复制或绑定进 daemon-managed artifact storage。

对应 capability：

- `session_artifacts_persistence`：支持 metadata 持久化与 session load/replay 恢复。
- `session_artifacts_content_retention`：后续 content-retention PR 才声明；它支持显式 workspace 内容保留、配额、hash、manifest 和 session-scoped GC/fsck。即使后续声明，也不承诺 project-wide cross-session GC、global artifact library、published file-root restore 或 sidecar cache。

核心原则：

- V1 的 `SessionArtifactStore` 仍是 live session 的权威内存索引。
- V2 增加 JSONL artifact journal/snapshot，用于在 daemon 侧创建 live store 时 seed 初始状态；JSONL append 必须由当前拥有 chat recording 的 core/ACP child 路径完成，daemon-side store 不能直接写 transcript。
- V2 默认 JSONL-only。sidecar cache 不进入 V2 发布门槛；只有实测 session load 成本不可接受时，才另行设计可删除缓存。
- 不把远端 URL 内容抓取到本地。
- 不默认复制 workspace 文件。
- 不把 client 传入的 `source`、`clientId`、`trustedPublisher` 当授权依据。
- 恢复时必须重新校验，不信任磁盘上的旧 metadata。

当前 PR 的重要收窄：

- Content retention public API、managed content store、pin/unpin、deleteContent、quota/hash/manifest/fsck/gc 和 `session_artifacts_content_retention` capability 不在 PR #6259 中交付；这些安全面拆到后续 PR。当前 PR 只保留对旧 `pinned` / `contentRef` journal payload 的 downgrade/strip 兼容路径，避免旧记录破坏 metadata restore。
- 当前 live view 与 persisted metadata 使用同一个 200 条可见集合。为了避免重启后 over-restore，超过上限时的 durable/restorable eviction 会写入 `reason: "eviction"` remove event；这等价于本实现的 metadata prune，不是纯 V1 live-only hiding。
- 显式 DELETE 当前采用 live-first：先从 live store 移除，tombstone 写入失败时返回 warning。这样可优先隐藏敏感项；失败窗口内 daemon 重启仍可能从旧 journal 恢复该 artifact，client 应把 warning 作为“删除未 durable”的信号。
- Fork 当前通过一次性 exclusive-create 写入目标 JSONL 文件；不会逐条 streaming fork artifact records，因此不需要 `session_artifact_fork_marker` 才能检测当前写入路径的 partial batch。若未来改成流式 fork，再引入 begin/complete marker。

## 2. 用户可见语义

### 2.1 页面刷新、切换和重启

V2 后的行为应是：

- 页面刷新：和 V1 一样，只要 daemon/session 还活着，前端重新 `GET /session/:id/artifacts` 即可。
- 切换 session：每个 live session 仍有独立 artifact store。
- 前端实例重启：daemon 还在时可 GET 当前 live store。
- daemon/bridge 重启：如果 session 被重新 load，V2 从持久化 metadata 恢复 artifact list。
- 历史 load/replay：如果该 session 有 V2 persistence records，恢复 artifact list；没有则返回空 list。

V1 到 V2 的 live upgrade 需要单独处理：已经在内存中的 V1 live artifacts 没有 JSONL journal。V2 首次触达这些 live sessions 时，应通过 chat recording owner 提供的 artifact persistence writer 写入一条初始 `session_artifact_snapshot`，然后再接受新的 restorable/pinned artifact mutation。backfill 不能把 live store 原样序列化；必须对每个 artifact 重新执行 ingest validation、privacy minimization 和 `retention` materialization。单条 artifact 不合格时跳过或降级该条，不能让一次坏记录拖垮整个 backfill。若 writer 不可用或 backfill 整体失败，该 session 继续保持 V1 live-only 行为，并记录 structured warning；不能让用户误以为已有 live artifacts 已经可恢复。

backfill 不能逐条向 JSONL streaming 写入 artifact event。实现必须先在内存中完成校验、最小化和降级，形成完整 candidate snapshot 后，再一次性 append `session_artifact_snapshot`。如果 candidate 构建或 snapshot append 失败，不能留下部分 durable artifact state。当前 PR 不实现 V1 live-store backfill；如果后续补齐，应把 candidate 条目数、跳过条目数和校验失败原因写入结构化 telemetry 或 snapshot metadata，便于 fsck 和 restore warning 区分“完整但有条目被校验跳过”和“部分写入/损坏”。

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
  persistenceWarning?:
    | 'persistence_unavailable'
    | 'content_missing'
    | 'content_expired'
    | 'content_hash_mismatch'
    | 'metadata_only_restore'
    | 'restore_validation_failed'
    | 'sticky_override_active';
  contentRef?: {
    kind: 'managed_copy';
    contentId: string;
    sha256: string;
    sizeBytes: number;
    createdAt: string;
  };
}
```

字段说明：

- `retention`：artifact 的持久化级别。解析顺序为：请求体显式值优先；系统内部 artifact 按 §2.2 的 daemon 默认策略；client POST 未指定时使用用户配置的 `defaultRetention`；无配置时回退为 `restorable`。只有 persistence capability 未声明或读取 V1-era 记录时，才按 V1 兼容的 live-only 处理。V2 writer 写 journal 时必须 materialize `retention`，不能依赖 optional 缺省。
- `persistedAt`：metadata 或 content retention 最近成功落盘时间。
- `expiresAt`：可被 GC 的时间。`pinned` 默认不设置，但 `ttlDays` pin 会转换成绝对 `expiresAt`。
- `restoreState`：恢复来源提示；不替代 `status`。
- `persistenceWarning`：非阻塞持久化/恢复风险，前端可用它提示“此 artifact 不会跨重启保留”等状态。当前 wire shape 是固定字符串，避免把 host 绝对路径、credential、token、内部 storage path 或 connection id 写入 response。更结构化的 `{ code, message }` 可作为后续兼容扩展。
- `contentRef`：当前只在 `mode: "content"` pin workspace regular file 成功后出现，不暴露宿主机绝对路径。published / workspace-reference contentRef 是后续增强，不属于本 PR 发布承诺。

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
- chat tree builder 和 renderer 必须把 `session_artifact_*` system records 视为 side-effect records：它们参与 parent/leaf 顺序和 replay，但不渲染成用户可见 conversation node。最低支持旧版本加载包含 V2 record 的 JSONL 时也必须把未知 system subtype 当作 opaque/ignored side effect，而不是让 session load 失败。
- session load/replay 只应用 active leaf chain 中的 artifact records。被 `/rewind` 丢到 abandoned branch 的 artifact upsert/remove 不再影响当前 artifact list。
- `/rewind` 或任何 leaf switch 发生时，daemon-side live `SessionArtifactStore` 必须重新对齐新的 active-chain artifact state：要么从 active-chain replay result reseed，要么在 rewind 操作中向 surviving chain 写一条当前 artifact snapshot top-up。V2 默认采用 branch-scoped 语义；off-branch mutation 不应继续留在 live flat map 中等待下次重启才消失。
- fork/branch 只复制 active chain 中的 artifact records；off-chain records 不参与目标 session 的恢复。
- 如果某个实现阶段还不能把 artifact system records 接到 active leaf chain，就不能声明 `session_artifacts_persistence` capability；否则 rewind 后会出现旧 upsert 或旧 tombstone 复活的问题。

这意味着 V2 不设计独立的 artifact log 文件，也不设计绕过 chat tree 的 side log。artifact persistence 的正确性来自同一条 active chat history，而不是 daemon 当前内存状态。

### 4.3 JSONL system record

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
  recordedAt: string;
  changes: Array<{
    action: 'created' | 'updated' | 'removed';
    artifactId: string;
    artifact?: PersistedSessionArtifact;
    reason?: 'explicit' | 'eviction' | 'unpin_to_ephemeral';
  }>;
}

interface SessionArtifactSnapshotRecordPayload {
  v: 2;
  sessionId: string;
  sequence: number;
  recordedAt: string;
  artifacts: PersistedSessionArtifact[];
  tombstonedIds?: string[];
  stickyEphemeralIds: string[];
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
  clientRetained: boolean;
  toolCallId?: string;
  toolName?: string;
  hookEventName?: string;
};
```

`sequence` 是每个 session artifact store 内的 durable mutation counter，用于 snapshot/event 排序和异常诊断。恢复时仍以 active JSONL chain 顺序为准；`sequence` 不作为跨 session 授权或全局 ordering source。

`PersistedSessionArtifact` 必须是正向 allowlist（显式 `Pick` 或独立 interface），不能用 `Omit<DaemonSessionArtifact, ...>` 负向排除。未来如果 `DaemonSessionArtifact` 增加新的 runtime-only 字段，编译时断言应要求维护者显式决定是否进入 persisted allowlist，避免 schema 污染。

只写经过 store validation/normalization 后的最小化 artifact shape。除 `clientRetained` 以及 tool/hook display hints 外，不写 V1 内部字段或运行时派生字段：

- 不写 `identityKey`
- 不写 `trustedPublisher`
- 不写绝对 `workspaceCwd`
- 不写 transport token / auth principal
- 不写 `restoreState`
- 不写 `persistenceWarning`
- 不写 `clientId` 或 live-process owner principal；`source` 只作为显示/审计 hint，不能用于授权

删除 artifact 或 unpin 到 `ephemeral` 必须写 tombstone change，避免历史 replay 后被旧 upsert 复活。tombstone 不是永久禁止同一 id 再出现：它只覆盖自己之前的 upsert，直到之后出现更高 sequence 的显式 upsert。`reason: "unpin_to_ephemeral"` 是 sticky override：后续同一 artifact id 的隐式/default upsert 仍按 live-only 处理，只有显式 upsert 才能 supersede。这里的“显式”只包括 UI action path、SDK `pin/save` helper、或经过认证的 REST/ACP mutate route 中显式传入 `retention: "restorable"` 的请求；tool/hook/background/default retention、restore backfill 和隐式 re-ingest 都不能 supersede sticky override。

sticky override 不能只存在于历史 tombstone event 中。snapshot writer 必须把尚未被显式 supersede 的 `unpin_to_ephemeral` 状态写入 `stickyEphemeralIds`；restore reader 先恢复 snapshot 中的 sticky set，再应用 snapshot 之后的 upsert/remove。否则 snapshot baseline advance 后旧 tombstone 不再需要 replay，sticky override 会丢失。

### 4.4 Snapshot 与 tombstone 不变量

artifact snapshot 只用于减少 replay 的 artifact event 应用量；它不会减少 JSONL 文件本身的读取量。

必须满足：

- snapshot generation 必须在同一个 artifact operation queue 中串行执行，并严格位于所有 preceding mutation 之后。
- snapshot 是 authoritative current state：它只包含 snapshot 生成时仍有效的 artifacts。
- `tombstonedIds` 只记录 snapshot 之后仍需要覆盖旧 upsert 的 tombstones；被 snapshot 覆盖的旧 tombstones 不再进入新 snapshot payload，避免数组随历史无限增长。
- `stickyEphemeralIds` 记录当前仍处于 sticky ephemeral override 的 artifact id，即使对应旧 tombstone 已经不需要 replay，也必须保留该 override 状态。
- `stickyEphemeralIds` 必须有界，默认和 persisted metadata 上限共享同一 `maxPersistedMetadata` 数量级，并计入 artifact journal working-set budget。unpin 到 `ephemeral` 若会超过 sticky set 上限，显式 API 必须返回错误并保持原 durable state；后台/restore prune 必须记录 warning 后稍后重试，不能静默增长、随机裁剪旧 sticky override，或让隐式 upsert 恢复持久化。
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

当前 PR 没有隐藏的 paged persisted metadata 视图；live list 就是恢复后暴露给 client 的 metadata 集合。因此上限处理采用一个收窄策略：

- `ephemeral` artifact 可以只从 live view 丢弃，不写 journal。
- `restorable` / `pinned` artifact 被上限裁剪时，写 `reason: "eviction"` remove event，避免下次 load/replay 把已裁剪条目全部复活。
- 如果 live list 全部是 `pinned` 且没有可裁剪项，显式/strict mutation 返回 validation error；非 strict 自动写入可以降级或丢弃新 artifact，并返回/记录 warning。

### 5.3 写入失败语义

区分两个入口：

- 普通 tool/hook artifact：持久化失败不应让工具调用失败；artifact 仍可进入 live store，但必须先把 live store 中的 `retention` 降级为 `ephemeral`，设置 `persistenceWarning`，再发布 `artifact_changed`。
- 显式 `pin/save` API：持久化失败必须返回错误，不能假装已经保存。

对会影响恢复结果的删除型 mutation，当前 PR 按原因区分：

- `eviction`：durable remove event，保证重启后仍遵守 200 条上限。
- unpin-to-`ephemeral`：durable remove event，并把 id 写入 bounded `stickyEphemeralIds`；后续隐式/default upsert 会保持 live-only，直到显式 `retention: "restorable"` 或 pin/save supersede。
- 显式 DELETE：live-first。先从 live store 移除并发布删除事件，再 best-effort 写 explicit remove tombstone。tombstone 写入失败时 response 返回 warning（当前为字符串 warning），表示删除没有 durable；如果 daemon 在补写成功前重启，旧 journal 仍可能恢复该 artifact。
- `deleteContent: true` 不属于 PR #6259 的 public API。content-retention follow-up 才会定义 content GC 与 warning contract；当前 PR 的显式 DELETE 只处理 metadata tombstone 和 live removal。

建议 warning：

```text
[artifacts] session=<id> action=persist_failed artifact=<id> reason=<code>
[artifacts] session=<id> action=remove_not_persisted artifact=<id>
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

`loadSession()` 必须是 read-only：它不能在解析过程中写 tombstone，也不能直接触发 content GC。若 restore 后发现当前 live cap 或 policy 比历史更严格，daemon-side store 在创建完成、persistence writer 可用后，再通过正常 operation queue 写 `eviction` remove event；writer 不可用时只在 live view 中隐藏超限 item，并记录 warning，下一次 load 仍可能重新看到这些待裁剪记录。

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
- fork copy 必须重新执行 ingest/restore validation、privacy minimization 和 redaction。workspace / url / metadata / contentRef 中无法在目标 session 安全表达的 locator 必须降级、strip 或丢弃，不能因为源 session 曾经通过校验就直接复制。
- `managedId` 不能从源 session 盲目复制。目标 session 中若能从目标 workspace / daemon-managed manifest 派生新的 `managedId`，必须重新计算；不能安全派生时必须移除 `managedId` 或丢弃该 artifact metadata。

fork remap 是发布门槛：如果某条路径不能安全重写 artifact id 和 tombstone，就必须在 fork 时丢弃 artifact persistence records，不能把源 session 的 artifact id 原样带入新 session。若现有 fork 实现有类似 `file_history_snapshot` 的 top-up 机制，artifact 也只能从 active-chain replay result 生成 top-up，不能从 daemon 当前 live store 原样补写，否则会把 rewind 后不再属于历史的 artifact 带入新 session。

当前 fork 实现不是逐条 append，而是先从 source active chain 生成完整目标 record 列表，再用 exclusive-create 写入目标 JSONL 文件；写入失败时目标 session 文件不会被当作成功 fork 使用。因此当前 PR 不写 `session_artifact_fork_marker`。如果未来 fork 改为 streaming append 或跨进程批量复制，再引入 begin/complete marker、count 校验和 `fork_incomplete` 恢复规则。

fork 的 rewind 语义是 branch-scoped：目标 session 只复制当前 active chain 的结果。如果用户 rewind 到显式 DELETE 之前再 fork，那个 DELETE tombstone 本来就不在 active chain 中，artifact 在新 branch 中重新出现是预期的历史分支行为。若产品需要“全局不可 rewind 删除”或隐私擦除语义，应作为单独的 policy 设计，不能混入 V2 默认 branch model。

metadata 的 fork amplification 在 V2 中作为有界 trade-off 接受：fork 需要 session mutate 权限，每个 fork 仍受 200 条 persisted metadata 上限，metadata 单条较小，且不会继承 pinned content bytes。V2 不引入 project-level metadata quota；实现必须记录 forked artifact count metric/log，若实际滥用再引入 project-level cap。content retention 仍受 session/project content quota 约束。

## 6. API 设计

### 6.1 Capability

`GET /capabilities` 增加：

```json
"session_artifacts_persistence"
```

内容保留拆分 PR 实现可用时，才同时声明：

```json
"session_artifacts_content_retention"
```

当前 `/capabilities` 是 string feature list，因此不能用 `enabled: false` 表达“实现存在但当前关闭”。规则是：

- 行为可用且当前配置启用时才声明对应 feature string。
- chat recording 禁用、metadata persistence 禁用或 writer 不可用时，不声明 `session_artifacts_persistence`。
- content retention 的显式 workspace `pin/save content`、quota、hash、manifest、session-scoped GC/fsck 都可用时，才声明 `session_artifacts_content_retention`。PR #6259 不声明该 capability；后续拆分 PR 必须保持 feature string 是 daemon build-level 能力。
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

本节是后续 content-retention PR 的 API 设计，不属于 PR #6259 的 wire contract。PR #6259 只允许 add/list/get/delete metadata artifacts，不暴露 pin/unpin endpoint。

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
- 对已经 `pinned` 的 artifact，空 body / 无显式选项的重复 pin 是幂等 no-op。带显式选项的重复 pin 视为用户更新操作：`mode: "metadata"` 可降级为 `restorable`，显式 `mode: "content"` 会刷新 managed content copy/hash，`ttlDays` 会更新 `expiresAt`，`clientRetained` 会更新保留 hint。调用方不应把带选项的 pin 当作无副作用重试。

### 6.4 Unpin

本节是后续 content-retention PR 的 API 设计，不属于 PR #6259 的 wire contract。

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
- `ephemeral`：删除 content retention，live store 中保留 artifact，但写 remove tombstone，确保下次 load 不复活。该 tombstone 对同一 artifact id 是 sticky override：后续隐式/default upsert 仍保持 live-only，直到 §4.3 定义的显式 `retention: "restorable"` 或 pin/save 写入 superseding upsert。
- 若要从列表移除，仍使用 V1 DELETE。

### 6.5 Delete artifact

V2 的 DELETE 仍保持 V1 幂等，并采用当前 PR 的 live-first 语义：

- 先从 live store 移除 artifact，保持用户可见删除即时生效。
- 随后 best-effort append `session_artifact_event` remove tombstone；tombstone 成功后，metadata restore 时不再复活。
- tombstone 失败时，返回成功 mutation result 但附带 warning；当前 daemon 生命周期内该 artifact 已被删除，但如果 daemon 在 tombstone 持久化前重启，旧 durable artifact 仍可能恢复。用户或上层 UI 可以在 storage 恢复后重试 DELETE。
- DELETE 对不存在的 artifact 保持幂等成功；如果已有 durable tombstone，重复 DELETE 不需要再写同一 tombstone。
- PR #6259 的 DELETE 不接受 `deleteContent`，也不触发 daemon-managed content GC；旧 `contentRef` metadata 只在 restore/serialization 时被降级或移除。内容删除与 GC 由后续 content-retention PR 定义。

### 6.6 Mutation responses

Pin、unpin 和 delete 必须使用一致的 mutation response，避免 client 猜测状态。PR #6259 只交付 DELETE response；Pin/Unpin response 是后续 content-retention PR 的 contract。

成功：

- Pin：`200 OK` 返回更新后的 `DaemonSessionArtifact`。
- Unpin：`200 OK` 返回更新后的 `DaemonSessionArtifact`；`retention: "restorable"` 时 `contentRef`/`expiresAt` 已移除，`retention: "ephemeral"` 时 response 可以返回当前 live-only artifact，并带 `persistenceWarning.code = "sticky_override_active"`。
- DELETE：`200 OK` 返回 `{ "deleted": true, "artifactId": string, "warnings"?: [...] }`。
- DELETE tombstone 持久化失败时仍返回 `200 OK` mutation result，并在 `warnings` 中包含持久化失败原因；当前实现使用字符串 warning，例如 `remove_not_persisted`。这表示 live delete 已生效但跨重启不保证，不能把它展示成 durable delete 成功。

失败：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "ttlDays is only valid with content pinning"
  }
}
```

PR #6259 的 HTTP mapping：

- `400 VALIDATION_FAILED`：非法 body、client 请求 `pinned`、artifact 不存在、metadata quota 已满且没有可裁剪 candidate，或 writer 不可用但 mutation 必须严格 durable 完成。
- `403 FORBIDDEN`：缺少 session mutate 权限。
- DELETE 保持幂等；不存在的 artifact 返回空 mutation result 而不是错误。
- DELETE tombstone 持久化失败返回 `200 OK` + warning，因为当前 live delete 已生效但跨重启不保证。

更细粒度的 `INVALID_ARGUMENT`、`NOT_FOUND`、`CONFLICT`、`METADATA_QUOTA_EXCEEDED`、`QUOTA_EXCEEDED` 或 `PERSISTENCE_UNAVAILABLE` HTTP error code 是后续 API polish，不属于当前 PR 的 wire contract。

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
- delete content：后续 content-retention PR 才启用；需要 session mutate 权限、`session_artifacts_content_retention` capability 启用、显式 REST/SDK call，以及当前进程可验证的 creator-principal match 或显式 override/admin policy；background session/hook 不能直接发起 `deleteContent`。restore 后如果没有 durable owner proof，默认只能释放当前 artifact 引用并交给 GC，不能立即强删共享 content。若 contentRef 被多个 session 引用，也只能释放当前 artifact 引用，不能强删共享内容。

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

后续可新增设置：

```json
{
  "sessionArtifacts": {
    "persistence": {
      "enabled": true,
      "defaultRetention": "restorable",
      "maxLiveArtifacts": 200,
      "maxPersistedMetadata": 200,
      "snapshotThresholdMutations": 100,
      "snapshotThresholdBytes": 262144,
      "contentRetention": {
        "enabled": false,
        "maxArtifactBytes": 52428800,
        "maxTotalBytes": 268435456,
        "maxTtlDays": 365,
        "ttlScanIntervalSeconds": 900
      }
    }
  }
}
```

当前 PR 不新增 operator 配置 schema；上述值以代码常量形式发布，并通过 capability 表达行为是否可用。把这些值暴露为 operator tunables 是后续增强，不能让 client 从 capability string 推断配置细节。

## 8. 配额、GC 与稳定性

### 8.1 Metadata quota

建议默认：

- live store 上限仍为 200。
- persisted metadata 上限每 session 200，与 live store 对齐。
- snapshot record 最多保留 200 个当前有效 artifacts。

live store 上限在当前实现中也是 restore 可见集合的上限：

- V2 live eviction 必须优先淘汰 `ephemeral` artifact。
- 如果必须在 durable artifacts 中选择 live view，当前实现按 source reservation、source、status、retention、clientRetained 和 insertion order 做确定性选择。
- durable artifact 被 live cap 淘汰时，当前实现会写 `reason: "eviction"` 的 remove event，确保下一次 restore 不反复复活已被 daemon 淘汰的 item。
- `clientRetained` 是用户保留意图，进入 `PersistedSessionArtifact`，用于 restore 后稳定排序和 live cap 选择；它是排序保护，不是绝对保护。

超过 persisted metadata 上限：

- `ephemeral` 本来不写 journal，不计入 persisted metadata quota，只受 live store 上限约束。
- `restorable` 必须按确定性顺序裁剪并写 `eviction` remove event：先裁剪未 `clientRetained` 的 `restorable` artifact；如果仍无空间，再裁剪 `clientRetained` 的 `restorable` artifact。`clientRetained` 是排序保护，不是绝对保护；用户需要真正保护内容时应使用 pin/save。
- `pinned` metadata 不因 metadata quota 被裁剪，但 content retention 仍受 content quota 约束。
- 如果 200 个 persisted slots 全部被 `pinned` 占用，没有可裁剪的 `restorable` candidate：
  - 自动/tool artifact 降级为 live-only `ephemeral`，带 `persistenceWarning.code = "metadata_quota_exceeded"`。
  - 显式请求 restorable/pin/save 的 API 返回 `METADATA_QUOTA_EXCEEDED`，提示用户删除、unpin 或让 pinned TTL 到期。
  - daemon 不能为了接收新 artifact 自动裁剪 pinned metadata；这会违背用户显式保存语义。

restore seed 不能超过 live store 上限；若历史里有效 persisted artifact 超过当前 live cap，daemon-side store 按同一确定性规则 seed 可见 subset，并通过 operation queue 为被裁剪的 durable item 写 `eviction` remove event。`loadSession()` parse 过程本身保持 read-only，不能直接写 durable prune。

### 8.2 Content quota

本节是后续 content-retention PR 的实现范围；PR #6259 不引入 content store quota。

后续拆分 PR 的建议默认：

- 单 artifact：50 MB。
- content store total：256 MB。

达到上限时：

- 新 pin/save 返回 `QUOTA_EXCEEDED`。
- 不自动删除仍被当前 session live artifact 引用的 pinned content。
- fork 不继承 pinned contentRef，避免 fork 绕过 quota。

### 8.3 GC

本节是后续 content-retention PR 的实现范围。GC 只处理 daemon 管理的 session-scoped managed copy：

- content manifest 保存 `sessionId` 和 `artifactId`；GC 只删除 manifest 属于当前 session 且不在当前 live `contentRefs()` 引用集合中的 content。
- `pinWorkspaceFile()`、GC、tmp cleanup 通过同一个 write queue 串行化，并用 in-flight lease 避免并发 pin/GC 删除刚复制但尚未 journal 的 content。
- `expiresAt` 到期通过 `GET /artifacts` 前的 lightweight prune 把 pinned artifact 降级为 `restorable`，移除 `contentRef` 后再触发 GC。
- close / explicit delete / unpin / explicit GC endpoint 都会 best-effort sweep；GC 失败不阻塞 prompt/tool flow。

GC trigger：

- artifact delete、unpin、TTL 到期检查、session close 或 explicit `POST /session/:id/artifacts/gc`。
- stale `.tmp` entries are cleaned during GC.

Project-scoped reference rebuild、incomplete-scan tracking、orphan grace period 和 global artifact library 都是后续增强。当前实现的 safety 边界来自“不跨 session 继承 contentRef”和“只删除当前 session manifest 且当前 live refs 未引用的 content”。

### 8.4 Crash consistency

要求：

- artifact store mutation 串行。
- JSONL journal append 失败不会破坏 live store。
- explicit `pin/save metadata` 必须等待 journal 落盘。
- explicit `pin/save content` 必须等待 content manifest 和 journal 都落盘。
- explicit DELETE live-first：live store removal must not be blocked by journal failure; response warning tells clients when the tombstone was not durable.
- explicit DELETE with `deleteContent: true` is only available in the content-retention follow-up; that PR must run best-effort session-scoped content GC after live removal and surface content delete warnings.
- live cap eviction for durable artifacts writes an `eviction` remove event so restore respects the cap.
- reader 容忍半截 JSONL 和 corrupt artifact record。
- tombstone / snapshot 顺序异常时选择不恢复，而不是猜测。

`pin/save content` 写入顺序：

1. 复制内容到 staging path，hash exactly copied bytes，并 fsync bytes。
2. atomically move 到 daemon-managed content root，写入并 fsync content manifest。
3. append artifact journal event，引用该 contentRef，并 fsync JSONL。
4. 更新 live store 并发布 `artifact_changed`。

如果第 2 步成功但第 3 步前 crash，会留下没有 journal 引用的 orphan content；这是允许的，当前 session-scoped GC 在确认 manifest 不被当前 live refs 引用后 best-effort 删除。如果第 3 步成功，restore 必须能通过 manifest 找到内容。显式 API 只有在第 3 步成功后才能返回成功。

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
- `remove_not_persisted`
- `eviction`
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
- 默认只读；修复模式只能做可验证的安全动作，例如重新生成 snapshot、清除 stale cache marker、标记 orphan content 等待 GC。当前 PR 的自动删除只限于当前 session manifest 且当前 live refs 未引用的 managed content；跨 session 引用重建和延迟删除策略是后续增强。
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
- `remove()` 区分 explicit DELETE、unpin-to-ephemeral 和 eviction；explicit DELETE live-first 并 best-effort 写 tombstone，unpin-to-ephemeral 和 durable eviction 写 journal。
- V1 live session 首次启用 V2 的 backfill snapshot 不在当前 PR 实现范围内；当前实现从新写入的 V2 journal/snapshot 恢复。
- 保持 V1 `artifact_changed` event shape 不变，只增加 optional fields。

### Milestone C: load/replay 集成

- `SessionService.loadSession()` 从 active leaf chain 提取 artifact snapshot/event records，忽略 abandoned branches。
- load result 把 snapshot 交给 daemon bridge，而不是在 ACP child process 中 seed store。
- restore over-cap prune 写入只能在 daemon-side store 创建并且 writer 可用后执行；load parse 过程保持 read-only。
- rewind/leaf switch 后，daemon-side live store 重新对齐 active-chain replay result，或通过 artifact snapshot top-up 固化 surviving chain 的当前状态。
- rewind/leaf-switch 必须调用明确 hook，例如 `onActiveLeafChanged(sessionId, artifactSnapshot)`，让 daemon-side store 在 operation queue 中完成 reseed/top-up。
- replay 历史时同 identity artifact 不重复创建。
- `/branch` 从 active chain 复制 artifact records 并 remap session id/artifact id；当前 full-file exclusive-create 写入路径不需要 fork marker。

### Milestone D: REST/SDK

- SDK type 增加 optional fields。
- `POST /session/:id/artifacts` 支持 `retention: "ephemeral" | "restorable"`。
- `POST /session/:id/artifacts` 支持 `clientRetained` boolean hint，并拒绝 client 传入 daemon-only runtime fields。
- 新增 `pinArtifact()` / `unpinArtifact()` SDK 方法。
- capability gate UI。

### Milestone E: content retention

- 增加 daemon-managed workspace content manifest 和 session-scoped GC/fsck。
- 实现 race-safe content copy、hash 校验、quota、write-queue/lease-protected GC。
- published artifact 绑定 trusted contentRef 是后续增强。

## 10. 测试计划

必须覆盖：

- metadata journal append 后 daemon restart/load 恢复 artifact list。
- artifact journal append 通过 chat recording owner 写入 active leaf chain；daemon-side store 不能直接写 JSONL。
- `/rewind` 后 abandoned branch 上的 artifact upsert/remove 不参与恢复，也不会在 fork 中复制。
- `/rewind` 后 live store 立即与 active-chain artifact state 对齐；不会等到 daemon 重启才改变 artifact list。
- V1 live session 升级到 V2 时的 backfill snapshot 是后续增强；当前 PR 测试应确认未写入 V2 journal 的旧 live artifacts 不被误报为可恢复。
- DELETE tombstone 后 load 不复活 artifact。
- unpin 到 `ephemeral` 后 load 不复活 artifact。
- unpin 到 `ephemeral` 后，同一 artifact id 的隐式/default re-upsert 仍保持 live-only；显式 restorable/pin 可以 supersede sticky override。
- snapshot baseline advance 后 `stickyEphemeralIds` 仍能让隐式/default re-upsert 保持 live-only，并产生 `sticky_override_suppressed` log/metric/warning。
- `stickyEphemeralIds` 达到上限时，unpin-to-ephemeral 返回错误或延后重试，且不会静默丢失旧 sticky override。
- explicit DELETE live-first：live view 立即移除；tombstone 写入失败时 response 带 warning，测试覆盖 live removal 不被 persistence failure 阻断。
- content-retention follow-up 覆盖 `deleteContent: true` 在 tombstone/content GC 有风险时暴露 `content_delete_preserved` warning。
- durable artifact eviction 写 `eviction` remove event；restore 后不会超过 live cap。
- snapshot baseline advance：periodic snapshot 压缩当前 artifact list，explicit tombstone 在 snapshot 成功后不再无界增长，`stickyEphemeralIds` 保留 sticky state。
- workspace artifact ingest 和 restore 时文件存在/缺失/symlink escape 三种状态。
- workspace root 重定位：相同相对路径存在时恢复为 available；缺失或 layout 不一致时恢复为 missing；不做 path remap。
- content-retention follow-up 覆盖 pin/save content 时拒绝 symlink、special file、oversized stream、hardlink 异常和 TOCTOU swap。
- external URL 只恢复 metadata，不发网络请求。
- secret-bearing URL query/fragment 与 metadata key/value 不写入 JSONL。
- published local `file:` 只有 trusted manifest revalidation 通过时恢复。
- content-retention follow-up 覆盖 stale/tampered `contentRef` 无法绕过 daemon-managed manifest、size 和 hash 校验。
- `managedId` 在 ingest、restore 和 fork remap 时拒绝分隔符、`..`、绝对路径和路径形态；fork 不能盲目复制源 session 的 `managedId`。
- corrupt JSONL record 被跳过且不影响其它 artifacts。
- chat recording / persistence disabled 时不声明或不启用 metadata restore。
- pin/save 显式写失败时返回错误。
- tool artifact 持久化失败时降级为 live-only，并通过 `persistenceWarning` 让 client 可见。
- branch/fork 时 artifact records 的 sessionId/id 处理，且只使用 active-chain replay result。
- fork full-file write：active-chain remap 后 exclusive-create 写入目标 JSONL，失败不产生成功 fork；如果未来改为 streaming fork，再补 begin/complete marker 测试。
- fork 继承 pinned artifact 时降级为 restorable，不继承 contentRef。
- orphan tombstone 在 fork remap 时被保留并安全 remap；无法安全 remap 的 tombstone 才丢弃。
- fork remap 重新执行 validation、privacy minimization 和 redaction；unsafe locator 被 strip、降级或丢弃。
- restore seed 与 concurrent POST 串行，不丢写、不重复。
- quota 边界：200 条、201 条 prune、pinned metadata、clientRetained/non-clientRetained 两层排序、全部 clientRetained restorable 仍可按确定性规则裁剪。
- clientRetained setter：Add artifact request 和 pin/save request 都能设置 boolean hint；后台自动 ingest 不能伪造用户保留。
- content-retention follow-up 覆盖 GC：unpin、delete、close、explicit GC endpoint 都只删除当前 session manifest 且当前 live refs 未引用的 content。
- content-retention follow-up 覆盖 GC concurrency：并发 pin/GC 通过 content-store write queue 和 leased content ids 串行/保护。
- content-retention follow-up 覆盖 TTL scan：`GET /artifacts` 会降级过期 pinned content 并触发 best-effort session-scoped GC。
- authorization：token-holder/principal 审计路径允许和拒绝情况；V1 live same-principal guard 仅作为 live UX/audit hint，不作为 durable security boundary。
- content-retention follow-up 覆盖 restored artifact ownership_unverified fallback；deleteContent 在无 durable owner proof 时只释放引用，不立即强删共享 content。
- content-retention follow-up 覆盖 partial writes：journal 成功但 warning、content manifest 成功但 journal 失败、journal 成功后 restore 能找到 content。
- JSONL snapshot baseline advance：threshold 触发、post-snapshot replay 有界、snapshot payload 不再携带已被覆盖的 explicit tombstones、superseded sticky tombstone 允许显式同 id 重新出现、`stickyEphemeralIds` 保留 sticky state；JSONL 文件本身不被 artifact 子系统重写。
- corrupt latest snapshot fallback：回退到较旧 valid snapshot 或一次顺序 artifact replay。
- repin idempotency：已 pinned artifact 的空重复 pin 不刷新内容、不延长 TTL；显式 `mode` / `ttlDays` / `clientRetained` 会按 §6.3 更新对应状态。
- retention defaults：tool artifact 无显式 retention、client POST `pinned` 被拒绝。
- capability：string list 只在行为当前可用时声明；不依赖 `enabled:false` details。
- replay idempotency：同一 session history replay 两次不会重复 artifact。
- SDK 旧 client 忽略 optional fields 后仍能展示 V1 artifacts。
- V2 -> V1 rollback compatibility：旧 daemon 必须能解析或忽略 unknown `system` subtype，不得导致 session load 崩溃；回滚后 artifact persistence 不恢复是可接受降级。如果当前最低支持版本不能保证这一点，V2 writer 必须 capability-gate 到支持 unknown system record 的版本之后。
- rollback preflight：最低支持旧 daemon 版本加载包含 V2 event/snapshot 的 JSONL；如果未来加入 fork marker，再扩展 rollback fixture。
- content-retention follow-up 覆盖 artifact fsck dry-run：dangling contentRef、orphan content、snapshot invalid 和 repair-safe actions。
- metadata-only fsck dry-run：corrupt record、snapshot fallback、orphan tombstone、restore validation failure。
- PR #6259 覆盖 metadata API response contract：delete success body、metadata quota validation failure、`remove_not_persisted` / `persistence_unavailable` / `sticky_override_active` warning、current 400/403/200+warning mapping。content-retention follow-up 覆盖 pin/unpin、content quota、`content_delete_preserved` / `content_expired` warning。

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
- daemon-managed content storage 不属于 PR #6259；后续 content-retention PR 需要单独定义 rollback 后 retained bytes 的清理流程。
- 如果当前最低支持旧版本不能安全忽略 V2 system records，writer 必须 capability-gate 到安全版本之后，或者在升级前提供 migration guard，阻止写入 V2 records。
- 发布前 CI 必须用最低支持旧 daemon 版本加载包含 `session_artifact_event` 和 `session_artifact_snapshot` 的 JSONL，断言 session load 成功且 unknown subtype 被忽略。V2 writer 首次初始化前也要检查版本/feature gate；失败时拒绝写 V2 records，记录 `v2_writer_version_gate_failed`，保持 V1 行为。如果未来加入 fork marker，再把该 subtype 纳入 rollback fixture。
- rollback 后 client 不能依赖 `session_artifacts_persistence` / `session_artifacts_content_retention`，因为旧 daemon 不声明这些 capability。

这样可以讲清楚 V2 的完整语义：默认恢复列表，显式保存内容，所有长期存储都受权限、配额、hash 和 GC 约束。
