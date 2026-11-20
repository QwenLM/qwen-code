# 不可信持久化 transcript 读取器

[English](untrusted-persisted-transcript.md) | [简体中文](untrusted-persisted-transcript.zh-CN.md)

## 背景

daemon 已为注册的不可信次级工作区暴露仅持久化的会话与分组目录。transcript 翻页仍不可用，因为 legacy `GET /session/:id/transcript` 路由通过 live bridge 状态解析会话归属，并把回放委托给 ACP 子进程。该路径可能启动进程、加载工作区设置与项目定义的能力，并创建或修复持久化游标签名密钥。

本设计新增一个独立的 workspace 限定 REST 契约，只读取 active 持久化 transcript。legacy 路由及其 ACP 后端行为保持不变。

## 契约

daemon 宣告无条件的 `workspace_persisted_transcript` 能力，并提供：

`GET /workspaces/:workspace/session/:id/transcript?cursor=<opaque>&limit=<1..500>`

workspace 选择器先精确匹配注册的 workspace id，再匹配 URL 解码后的可移植绝对 cwd。未知或未注册的选择器以 `workspace_mismatch` 失败关闭。可信主、次级工作区与不可信次级工作区可以读取。不可信主工作区仍被拒绝，以保持既有复数路由的安全模式边界。

只读取 active 持久化 JSONL。归档会话返回 `session_archived`；active/archive 冲突返回 `session_conflict`；缺失会话返回 404。响应复用 `DaemonSessionTranscriptPage`，包含由既有可见历史投影产生的无 id `session_update` 帧。原始 JSONL 与隐藏系统记录永不返回。

## 安全边界

该路由不得调用 bridge 方法、启动或预热 ACP、加载设置、解析 agents 或 skills、发现工具、运行外部命令、创建持久化游标密钥，或写入路由专属的 daemon/debug 日志。既有的 daemon 级 HTTP 访问日志与遥测不属于本路由专属的无写入保证。

直接持久化 transcript 读取在 debug 会话日志被抑制的状态下运行。归档协调器在位置检查、索引构建、记录读取、session-id 校验与回放全程持有共享会话锁。每条返回记录必须携带请求的 session id；不匹配以快照冲突失败关闭。

直接回放上下文只包含 session id、更新 sink、可选消息重写与可选累计用量。没有完整 `Config` 时，工具显示元数据回退到持久化的工具名与描述。不查询任何项目控制的工具注册表。

## 游标生命周期

core 读取器接受显式游标编解码器。既有调用方继续使用文件后端编解码器。daemon 每进程创建一个随机主密钥，从 workspace id 与规范化 cwd 派生独立的 32 字节 HMAC 密钥，并按注册运行时缓存内存编解码器。因此新路由的游标在 daemon 重启时过期，且不能跨工作区重放。

游标冻结文件身份、字节大小、active 叶子、回放位置与回放状态。第一页之后的追加不改变快照。删除、归档、截断、替换、等长原地改写（冻结大小仍匹配但 mtime 已前进）、叶子变化或 session-id 不匹配返回 `transcript_snapshot_unavailable`。

## 失败与竞态处理

第一页时，路由检查 active/archive 位置，但位置未知时仍尝试 active 读取器，以免损坏的 active 存储被静默报为缺失。游标页只校验冻结的 active 快照。`ENOENT` 时，游标页返回快照不可用；第一页重新检查位置，以在返回缺失前发现归档竞态。

回放在协议边界上是页事务的：回放转换失败前已发出的更新以 `partial: true`、通用回放错误且无 next cursor 返回。挂起工具调用与累计用量只在回放成功后才载入签名游标。

## 兼容性与限制

旧 singular 路由、持久化游标密钥与 ACP 错误映射保持完整。新路由保持既有默认请求窗口 100、最大请求窗口 500、256 MiB 快照上限、32 条目索引缓存（64 MiB 共享字节预算加独立 256 MiB 超大索引预算，最坏字节保留为两者之和 320 MiB）与五分钟缓存有效期。workspace 限定路由另对每页施加 4 MiB 持久化源记录、32 MiB 序列化响应 JSON 与 64 KiB 游标状态上限。`limit` 是前向页的记录数上限；后向页至多扩展到 `3 * limit` 条记录，以保持轮次与工具调用/结果边界。单条聚合记录超过源预算返回 `transcript_page_too_large`；超大回放游标把本来成功的页以 partial 终止，且不发出续页游标。首次索引扫描仍与冻结快照大小成线性。

类预算满时，准入较新快照会腾退同一文件的较旧快照；指向被腾退前缀的冻结游标按需重建，因此腾退只损失时延，不损失正确性。随缓存索引保留的 Managed 消息投影计入同一类预算；解码正文放不下时不予保留。

TypeScript SDK 在 `WorkspaceDaemonClient` 上暴露该方法。它强制原生 REST 传输，无 ACP 路由映射。旧 daemon 可通过新能力检测，对该路由继续返回 404。

## 延后工作

归档 transcript 读取、反向/尾部翻页、live 跟随、自动全量历史加载、worker 线程索引、跨重启游标与 Web Shell 查看器均为独立后续项。
