# Managed 会话状态的有界保留

[English](2026-10-19-managed-session-bounded-retention.md) | [简体中文](2026-10-19-managed-session-bounded-retention.zh-CN.md)

## 问题与范围

Issue #13184 审计了 managed-agent 持久层与投影层在时间维度上的无界增长。本设计覆盖剩余的两个 Core 条目：

- **第 1 条**：会话 authority 把每个事件常驻进程内存，且每条读路径要么整份重放 journal（本地 JSONL），要么从 revision 0 分页（HTTP）。
- **第 2 条**：activation store 与 inbox journal 永不压缩，且 activation 续约在会话打开期间持续追加持久记录。

审计的第 4 条（资源店加固与发布上限）与 settled dispatch 条目的进程级 Map 上限已在同一系列的分支实现，尚未合入。续约停表同样在那里实现。此处引用仅为把保留模型放在一处。

## 现状

按 `origin/main` 的 `e584d4d197` 核实：

- `LocalManagedSessionAuthority` 把每个已提交事件 push 进 `events`，从不删除。`readEvents`、`eventsInSequenceRange` 与 `lastEventOfKind` 同步读该数组，且有一处以 `events[sequence - 1]` 索引，隐含数组仍从 sequence 1 开始。
- `LocalJsonlManagedSessionJournalStore.read` 每次 open 都用 `readFile` 读取整个 transcript 文件。
- `HttpManagedSessionStore.readJournal` 从 `afterRevision = 0` 起按每页 100 条分页 `/transactions`，把所有分块拼接后再扫描。`readOnlyManagedSessionSnapshot` 对 `compactedThroughRevision` 不为 0 的 head 报 `snapshot recovery or compaction is unsupported.`；`requireHeadMatchesGrant` 对同样的 head 报 `restore head is not readable by this writer.`
- Java 服务端已按事件流持久化 `last_sequence`、`covered_sequence`、`replay_floor_sequence` 与 `current_snapshot_id`，并有 replay-floor advancer。TypeScript 客户端没有消费其中任何一项。
- `FileManagedActivationStore.open` 与 `FileManagedSessionInbox.open` 重放每一行 JSONL，且都要求从 1 开始连续的 sequence。已释放的 activation 与已确认的消息留在内存 Map 中。每次租约续约按 `leaseDurationMs / 3` 追加一条记录。
- `origin/main` 上的续约循环每个间隔重试且永不停止；停表条件已在同一系列的分支实现（尚未合入）。

## 目标

1. 按配置的事件数量为每个打开的会话设定内存上限，与会话总长度无关。
2. 用快照加保留尾部为每份持久 journal 设定上限，不丢失读者仍可能被要求服务的任何已提交状态。
3. 让每个低于 replay floor 的读取显式失败，而不是返回被静默截断的区间。
4. 让 TypeScript 与 Java 存储遵循同一套保留契约。

## 非目标

- Web Shell 投影工作（issue 第 5 条）与无法解码事件行的服务端隔离（第 6 条尚未完成的那一半）。
- 回收孤儿资源；那需要引用闭包台账。
- 在新增 journal 快照记录与压缩会话读路径之外，改变公开事件或 checkpoint 格式。

## 方案

### 1. 统一保留边界：replay floor

floor 是快照已覆盖全部事件的最高 sequence 之下界。它按事件流持久化，且单调不减。低于 floor 的读取会收到携带 floor 的显式 expired-cursor 错误；现有事件回放设计已为游标定义了该错误。

authority 上已有的 `compactedThroughSequence` 是它在本地侧的对应物；本设计把它的推进与 floor 绑定。只有当覆盖同一区间的快照已持久化后，压缩才可推进它。

### 2. TypeScript HTTP 店：消费快照与 floor

1. 当 head 指名的快照可被客户端获取时，`requireHeadMatchesGrant` 接受 `compactedThroughRevision > 0`。
2. 打开压缩会话时获取该快照，由它重建 authority 的初始状态，然后从 `compactedThroughRevision + 1` 而非 0 开始分页 `/transactions`。
3. 指名了客户端无法获取的快照的 head 仍是硬失败；绝不回退到从 0 全量重放。
4. `readJournal` 随扫描结果返回 floor，使调用方能区分「没有更多事件」与「事件已被压缩掉」。

返回 `current_snapshot_id` 对应快照正文的服务端端点必须在该切片开始前确认；现有 head 字段是它必须满足的契约。

### 3. 本地 JSONL journal：快照加截断

1. 在新文件头部写入一条 `journal.snapshot` 记录。它携带格式版本、已覆盖 sequence、checkpoint 引用、activation epoch 与基准 commit proof。
2. 追加已覆盖 sequence 之后的事件，fsync，然后原子地把新文件 rename 覆盖旧文件并 fsync 目录。
3. 在 rename 持久化之前，把旧文件保留为 `transcript.jsonl.compacted-<sequence>`，使崩溃后只会留下旧 journal 或新 journal 之一。
4. 把 takeover commit proof 重基到快照基准上，并拒绝早于该基准的 takeover。
5. `open` 先读快照，再只重放尾部。

### 4. authority 内存：窗口加索引

1. 保留 `max(最近一次 checkpoint 的 covered sequence, floor)` 之后的事件，外加固定重叠区用于前驱校验。
2. 维护 `latestByKind` 与 `executionCallId` 索引，使 `lastEventOfKind` 与 receipt 查找不再扫描数组。
3. 用按 sequence 键控的查找替换 `events[sequence - 1]`，容忍窗口不从 1 开始。
4. `readEvents` 与 `eventsInSequenceRange` 从窗口服务。低于 floor 的请求抛 expired-range 错误；落在窗口内但早于保留起点的请求，通过调用方接受的异步变体从 journal 读取。
5. 窗口大小是配置上限，不基于时间，因此慢会话与快会话具有相同的内存包络。

### 5. activation 与 inbox journal

1. 给两种 JSONL 格式都加上同一套快照记录，携带下一个队列 sequence 与每个会话的下一个 epoch。
2. 从内存与快照中删除早于一个租期的已释放 activation；保留身份的时间足以覆盖现有 enqueue 去重窗口。
3. 在同样窗口之后从快照中删除已确认的 inbox 消息；待处理消息永不删除。
4. 除每个 activation 的最新租约外，快照不保留续约记录。

### 6. 续约

本系列已实现（尚未合入）：循环在写入停止或连续失败 3 次后停止。上述快照工作会用最新租约替换累积的续约记录，因此长寿命会话不再按每个租期三分之一追加一条记录。

## 设计决策

- **事件日志用 floor，不用 TTL。** 基于时间的截断可能丢弃慢读者仍需要的事件；floor 绑定持久快照，因此每次读取都可以安全执行。
- **快照加尾部，不逐行删除。** 删除单行会破坏连续性与 commit-proof 链；快照给出新基准并保持尾部连续。
- **窗口以事件计，不以字节计。** 事件数是每个存储都已校验的单位，也是内存索引需要的单位。
- **显式过期优于静默截断。** 把部分区间当作完整区间返回，比一次调用方可处理的失败更糟。

## 约束与风险

- 本地 journal 的 commit proof 是前缀哈希。截断必须重基；沿用旧 proof 的实现会拒绝每一次 takeover。
- 崩溃一致性要求旧 journal 在新 journal 持久化前保持可读。上述 rename 顺序是契约的一部分，不是优化。
- HTTP 快照格式与端点由服务端拥有。TypeScript 客户端不得另造第二套快照格式。
- 低于 floor 的读取目前是同步的。把所有调用方改成异步读取是面很广的改动；本设计允许先返回同步的显式错误，再按调用点补异步读穿。
- 快照内的资源引用在旧事件消失后仍必须可解析；快照必须保留被引用的 resource id。

## 验证计划

1. 重放等价：对脚本化会话，在每个 checkpoint 边界上，由 `snapshot + tail` 重建的状态等于由完整日志重建的状态。
2. 崩溃注入：在快照写入、rename 与目录 fsync 之间注入失败；每种结果都必须以旧 journal 或新 journal 打开。
3. floor 行为：低于 floor 的游标返回携带 floor 的 expired 错误；位于 floor 的游标返回尾部。
4. 内存上限：10 万事件的会话最多常驻配置窗口数量的事件。
5. 每个守卫的变异见证：floor off-by-one、快照覆盖、索引陈旧，以及早于快照的 takeover proof。

## 验收标准

- 无论有多少 checkpoint，会话在内存中最多保留配置的事件窗口，在磁盘上最多保留 `window + snapshot` 的事件。
- 没有读取会静默返回被截断的区间；每次低于 floor 的读取都抛出文档化的错误。
- 压缩后的 HTTP 会话打开时不从 revision 0 重放。
- activation 与 inbox journal 在保留窗口之后不再因已释放或已确认条目增长。
- TypeScript 与 Java 对 floor 与快照契约保持一致。

## 切片

1. TypeScript HTTP 店：快照感知的 open 与尾部分页（先确认服务端端点）。
2. 本地 JSONL journal：快照记录、截断与 proof 重基。
3. authority：索引、窗口化读取与显式过期。
4. activation 与 inbox：快照记录与已释放/已确认条目的保留。
5. Java 对齐检查与跨语言重放等价。

## 开放问题

- 哪个服务端端点返回快照正文？其载荷是否与恢复使用的 `current_snapshot_id` 正文相同？
- 同步的 expired-range 错误是否足以覆盖当前所有调用方，还是某个调用方必须在同一版本内读穿到 floor 以下？
- 多大的窗口能适配最大受支持的会话，同时不改变当前 checkpoint 节奏？
