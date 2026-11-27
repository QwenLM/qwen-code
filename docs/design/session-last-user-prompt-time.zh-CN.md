# 会话摘要中的最近用户发问时间

[English](session-last-user-prompt-time.md)

## 产品需求

客户端需要最后一次真实用户提问的记录时间，用于显示“5 分钟前提问”，也用于按用户提问时间查看会话。创建时间不能提供这个事实；`updatedAt` 还会被助手输出、工具和后台活动推进。

例如：用户 10:00 问 A、10:05 问 B，A 在 10:10 继续输出。按最近活动排序应当 A 在前，按用户最后提问排序应当 B 在前。两种视图都合理，必须保留独立时间口径。

本 PR 为工作目录 session list、批量 catalog、SDK standalone 摘要和已加载会话 status 一致提供可选 `lastUserPromptAt`。本次也包括可选的服务端和 WebShell [提问时间排序](session-question-time-sort.zh-CN.md)，在分页前处理完整候选集。默认排序保持兼容。

## 时间口径

取有效主转录中最后一条真实人工输入的记录时间，统一为 UTC ISO 毫秒格式。纳入纯附件、语音、人工 mid-turn 和人工 agent mention；排除助手、工具、系统、通知、cron/Goal、外部 agent、继承 fork 历史和非活动分支。缺失表示未知或没有合格输入，不得代用创建、活动或当前时间。被拒绝、持久化前取消或写入失败的输入不能推进时间。

## 原实现的问题

原标量缓存把 JSONL 文件身份、size 和 mtime 作为键。助手追加也会改变缓存键，导致下一次 list/catalog/status 读取重建完整转录索引。`16435cd` 的合成复现中，完整索引构建次数依次是：冷读 1、未变化重读 1、助手追加后 2、再次追加后 3；用户提问时间始终没变。现有 catalog 的有限头尾元数据读取不等于已经完整扫描了转录。

## 冷恢复与热更新

- 冷元数据缺失时，使用规范 reader 从持久转录恢复。默认读取只补齐返回行；提问排序在分页前补全完整候选集，最多两个并发读取，并发调用共享初始化。标量缓存按完整作用域保留，最多 100,000 个条目和 64 个作用域，独立于 catalog TTL 和稠密索引缓存存活。
- 默认元数据热读取只检查文件身份、大小和 mtime，不读取转录内容；普通追加保留标量。文件替换、截断或同大小改写作为显式恢复条件。文件系统不提供可验证 inode 时，变化后的热快照省略该可选值且不重扫，等待人工输入通知或冷恢复重新建立。冷读取超过规范 256 MiB 索引上限的文件时省略字段，不扫描。
- 真实人工输入持久化成功后，recorder 通过已有的 owner 范围 ACP 通知通道发送该记录的实际时间。daemon 更新同一 runtime/workspace 的热标量，再推进 catalog version。此次更新不扫描历史；即使文件超过冷扫描上限，已知的热时间仍可返回。
- 助手、工具及自动活动不发送提问时间更新，追加也不使热标量失效。不增加 HTTP 端点、逐卡请求、轮询、后台定时器。
- rewind 和消息组删除持久化成功后清除标量，下次读取仅恢复一次有效分支。新 owner 注册时也清除旧内存，以恢复会话无 live owner 期间的变化。daemon 重启自然从冷状态开始。

该元数据表示本 daemon 观察到的写入事实。未加载会话若由外部进程追加、且没有被本 daemon 观察到，变化在冷恢复、owner 注册或缓存淘汰后可见；不会为检测此类外部追加而在每次 catalog 请求中重扫历史。这是明确采用的热内存合同。

## 冷路径加速、Sidecar 持久化与并发/取消边界

多工作区 daemon 的生产采样（`#17889`）表明，冷启动、作用域淘汰或 owner 重新注册时，几十个工作区的默认列表请求仍会并发扇出大量完整稠密索引构建。为在不改变 `lastUserPromptAt` 对外契约的前提下根除这一重建风暴：

- **持久化 `.prompt-time.json` sidecar**：`chats/<sessionId>.prompt-time.json`（归档后为 `chats/archive/<sessionId>.prompt-time.json`）保存经校验的 `{ version: 1, fileIdentity, snapshotSize, lastUpdated, lastUserPromptAt, leafUuid, anchorLeafUuid?, firstRecordOwner, prefixSha256?, prefixUuidBloom?, managed? }` 检查点。`prefixSha256` 为 `[0 .. snapshotSize)` 整段前缀的 SHA-256 摘要，`prefixUuidBloom` 为自适应 2 次幂 Bloom Filter（256 B 至 128 KiB、`k = 7`、规范 base64），记录 `[0 .. snapshotSize)` 内全部物理记录 UUID，保证零假阴性。在 120,000 条记录以内，当饱和超过约 8 bits/条时自动按 2 次幂扩容至最高 128 KiB；超过 120,000 条记录时有意省略 `prefixUuidBloom` 以将 sidecar 体积上限钉在 128 KiB，此时未改动文件仍走 O(1) `sidecar_exact`，追加场景回退至 `lightweight_scan`。recorder 在持久化真实用户提问时更新它（记录每次落盘后的精确 `(dev, ino, size, mtimeMs)`，当其他 legacy 录制器交替写入导致文件状态偏离时立即作废内存前缀状态以防写出遗漏 UUID 的 Bloom，恢复会话时若同身份旧 sidecar 与追加前文件精确匹配则延续其校验通过的 bloom 与前缀哈希，按 256 KiB 分块异步流式推进 `prefixSha256` 而非同步读盘阻塞事件循环，饱和时按目标记录数翻倍扩容至最高 128 KiB，当 writer 无内存前缀状态且在 `ino !== 0` 文件系统上磁盘已存在前缀哈希验证通过的 reader 自愈 sidecar 时流式补齐并延续（或尾部残缺时保留）该前缀状态，且跨 `rewind` 追加保持 bloom 与哈希不断链），在 rewind 或删除消息组时移除磁盘 sidecar，写失败记 `debugLogger.debug` 且绝不污染转录录制。会话注册/恢复（`setLastUserPromptAt(id, undefined)`）只清理内存元数据，不删除磁盘上健康的 sidecar。受信任的冷读取（以及不可信冷读取写入 `pendingSidecar` 之后命中的受信任温/缓存读取）在通过 `validateFirstRecord` 归属校验后自愈落盘（覆盖同一仓库下被项目认可的 worktree 会话，同时继续拒绝外部仓库 worktree；直接调用 reader 且未传 `validateFirstRecord` 时保留严格 `cwd === workspaceCwd`），且不会覆盖磁盘上更晚的检查点。归档、取消归档、冲突消解、工作目录迁移（`/cd`）与删除会话同步迁移或清理该 sidecar。daemon 中全部列表调用方均根据工作区信任态显式传递 `allowSidecarWrite`，确保不可信/只读工作区检查（`allowSidecarWrite: false`）与跨项目转录绝不写入 sidecar。
- **精确命中与尾部线性增量扫描**：进程内热标量未命中时，读取器先复用同快照已驻留的稠密索引，再读取 sidecar。`(dev, ino, snapshotSize, lastUpdated)` 完全匹配时以 O(1) 返回且不读 JSONL（即使未携带 `prefixSha256` 或 `prefixUuidBloom`）。当 `ino !== 0`、同文件增长（`stats.size > sidecar.snapshotSize`）、非 Managed、携带有效 `prefixSha256` 与 `prefixUuidBloom` 且 `sidecar.snapshotSize - 1` 为 `\n` 时，读取器先流式扫描尾部 `[sidecar.snapshotSize .. stats.size)`（上限 10,000 条新增对话记录）。由于历史 `recordCustomTitle`/`recordSessionSource` 写入会链式推进活动尾节点、而周期性 32 KiB 重锚以兄弟节点方式附加，冷扫描与 `index_cache` 命中路径均统一将尾部元数据重锚解析为 `{ leafUuid, anchorLeafUuid? }`（`leafUuid` 回退到非重锚对话尾节点，`anchorLeafUuid` 记录末尾元数据 UUID），尾部增量扫描通过 `allowedParents` 同时接受两类父指针，并在下一条常规对话记录落盘后清空 `anchorLeafUuid`。每条新增有效记录在推进 `leafUuid` 与 `lastUserPromptAt` 前均先查 `prefixUuidBloom`（并加入工作副本），非对话记录以及锚定在允许父节点上的元数据重锚记录（`custom_title`、`session_source`）仅将 UUID 加入 bloom，不推进 `leafUuid` 也不计入 10,000 条上限。一旦遇到任意失效条件（rewind、分支回跳、Bloom 命中、Managed 头或记录数超限），行回调立即返回 `false` 并销毁尾部 `ReadStream` 停止读盘，绝不继续读到 EOF。仅当尾部确认严格线性后，读取器才以协作让出方式对 `[0 .. sidecar.snapshotSize)` 校验完整 `prefixSha256`（拦截任意等长或非等长原地改写前缀），并将尾部字节续算进新摘要。任何校验失配或非线性追加均安全回退到从字节 0 开始的轻量冷扫描。
- **轻量冷扫描**：`lastUserPromptAt` 是活动分支敏感的而非文件物理顺序位置性的——持久化的 `rewind` 会放弃非活动分支上更新的用户提问，必须返回仍处于活动分支上的最近真实提问。必须冷扫描时，`getLastUserPromptAt` 走专用的最小信封扫描路径并沿 `leafUuid` 父链回溯活动分支，不再构造完整 `TranscriptIndex`——跳过 `validateTranscriptRecord` 对象拷贝、branch-point parts 投影、`resolveBranchPoints`、导航 turn 装配、执行引擎累加及稠密索引缓存写入，同时保持完全一致的 session-id 校验、环/缺口遍历、Managed 投影处理（在冷扫、仅物理索引命中及索引与正文投影同时命中三种路径下统一受 `maxBodyBytes = getMaxAllReplayBytes()` 上限保护，且不重复投影已完成的记录校验）、单行长度限制与堆增长护栏。
- **进程级并发闸与 `AbortSignal` 贯通**：冷扫描、完整稠密索引构建与增量扩展共用进程级信号量（默认并发 2），防止多工作区并发列表与转录分页在主线程堆积数十路全量解析。`AbortSignal` 从 `session-list` 补齐与 daemon HTTP 转录、轮次索引、turn-hooks 及 tool-calls 路由（`readPage`、`readTurnIndexPage`、`readTurnHooksPage`、`readSessionToolCalls`）——含工作区解析与刷盘屏障前的预中断检查以及 Managed 投影（`readManagedSessionRecordsAndTitle`）——一路透传到引用计数的共享在飞任务、信号量等待队列及 `forEachLineInSnapshot` 流读取：单个等待方取消立即脱离且不影响其余共享者；最后一个活跃等待方取消时立即中止底层流并清理在飞槽位。非 HTTP 的 `readRestoreProjection` 暂不在 `AbortSignal` 取消范围内，留待后续工作。

## 归属与消费者

元数据属于已解析的 workspace/runtime。先解析 owner，使用其存储根和工作目录；冷读取验证实际快照的首记录归属。缓存键包含转录实际路径和 workspace。默认读取检测文件替换；热提问排序使用已观测写入缓存，直到显式恢复。ACP 只接受发送通道实际拥有会话的通知，未知或外部 owner 不能更新内存。不得回落 primary。

session list 和批量 catalog 复用同一补齐路径；status 使用实际 live owner 和同一缓存。SDK 的 list/catalog/standalone/status 保留可选字段。memory-only live-state 保持原有形状，不读取转录。native CLI 列/JSON 和 ACP listing 不变。

## 验证

E2E 计划位于忽略目录 `.qwen/e2e-tests/pr14654-hot-prompt-time.md`。同时验证时间真值和扫描计数：一次冷扫描；重读、稠密索引淘汰、助手/自动活动追加、收到真实持久化输入通知后都不新增完整扫描；失败写入不通知。另验证 list/catalog/status 一致性、observer 清理、外部 owner 拒绝、归档隔离、拓扑恢复和重启。使用隔离合成数据与 loopback daemon，不使用生产历史或模型凭证。

最终结果写入 PR 验证评论；本地 source-level 结果不等于生产性能保证。
