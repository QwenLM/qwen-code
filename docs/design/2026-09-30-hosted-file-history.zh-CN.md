# Hosted Workspace 文件历史

[English](2026-09-30-hosted-file-history.md) | [简体中文](2026-09-30-hosted-file-history.zh-CN.md)

状态：已在私有门禁后实现。跟踪 #13105，承接 #12831。

## 问题与范围

变更前，Hosted Write/Edit 保留工具消息，但禁用文件备份。现有
ManagedToolFileHistory 和 FileHistoryService 已提供按 prompt 的快照与恢复。
Hosted 在 worker 复用它们，保留 raw executor 及其原始调用日志，包括 Shell v3。
迁移到 provider 执行协议会不必要地改动 Shell 发布及恢复链路。

本片提供私有文件历史查询与仅文件撤销，不包含对话回退或公开 UI。Shell 修改不备份。
恢复要求相同的 Workspace 文件系统与持久化 worker 备份卷；不提供跨宿主备份迁移或
未知执行的自动恢复。

本片支持 files 和 Shell profile。MCP profile 保持原有行为，包括原生 Write/Edit，
并拒绝文件历史 API。其长生命周期 runtime 与活跃连接需要单独设计历史生命周期；
本次不宣称为该 profile 提供备份。

## 执行与持久化

现有 Broker control 路由增加 `raw-file-history` 操作，直接路由到 raw history，
不获取 provider session。其 `bind`、`prepare`、`snapshot`、`rewind` 动作属于
已获取的 live Session 所选 Workspace。检查 worker activation、解析后的目录、
Harness Session 身份和 runtime Session 身份。任何动作都不能回退到 Harness 目录
或其他 runtime。

Bind 从 Session Store 恢复最新完整历史状态，以稳定的 Harness Session ID 作为
备份所有者。Prepare 为每个 prompt 创建一个快照，在派发前备份所有获准的 Write/Edit
路径。调用现有尽力备份 API 后，显式核实所需备份存在且未标为 failed。Harness 在
启动文件副作用前，将此状态提交到现有 `file_history` domain。每次提交也携带现有
`file_history_snapshot` 读取记录，保持 transcript 投影对该 domain 的兼容。
被拒绝的调用不创建备份；同一 prompt 的多次修改保留首次修改前的内容。
准备阶段也会拒绝已跟踪路径在上次工具副作用后的变化；后续 Write/Edit 不能静默
接纳外部或 Shell 修改。

每批调用完成后，包括工具报错和取消，worker 记录受影响文件的当前字节摘要及权限。
Harness 在模型继续和释放 runtime 前持久化结果状态。执行未知或历史持久化失败时
阻塞 Session。重试观察不派发新的文件修改。通过内容相等避免重复历史提交，不将
worker 内的 revision 计数器用作持久化身份。

Session Store 保存快照及预期文件状态，备份字节保留在 FileHistoryService 的
worker 存储中。备份缺失以及非法、越界、符号链接路径均拒绝继续。在修改、结算和
撤销前重新检查备份，包括 worker 持续运行期间。最多保留 100 个 prompt 快照，
达到上限后拒绝新的修改 prompt，避免删除持久历史仍引用的备份。
每条历史记录也受现有 Store 的 64 KiB 内联限制约束；准备记录超限时在派发前拒绝，
结算记录无法持久化时保留 pending 恢复标记。

## 仅文件撤销

私有 Hosted API 增加 `GET /session/:id/files/history` 和
`POST /session/:id/files/rewind`，后者接收目标 `promptId` 和 UUID `requestId`。
两者均为 live-session-owner 范围，要求现有客户端身份；撤销还要求文件工具 Session
空闲、可写且未阻塞。请求获取独立 runtime Session，并恢复已保存状态。

撤销副作用前持久化 pending undo 记录。将每个跟踪文件与最后观察到的摘要及权限
比较，后续外部或 Shell 修改视为冲突。复用 `rewind(promptId, false)` 恢复已有
文件并删除新建文件，同时保留备份证据。释放及宣告完成前持久化新的预期文件状态。
部分恢复、响应未知或持久化失败时继续阻塞，reload 也不能绕过。此操作不是多文件
原子事务：撤销期间其他写入者必须暂停；恢复前发现冲突时不改动任何文件。
已完成的撤销回执会保留在后续历史记录中，因此在另一次撤销、Write/Edit 或 reload
之后重试旧请求，仍返回原始结果，不重新获取已释放的 runtime。回执与快照共用有
大小上限的内联记录预算。

## 实现边界

- CLI：历史状态校验与 worker 适配、raw executor 绑定、现有 provider-control
  派发、Hosted Broker 客户端、工具回合结算与私有 Session 路由。
- Java Broker：接纳并转发有大小限制的 raw-history control 操作，不获取 provider；
  保留现有所有权检查与 control 互斥。
- Core：复用现有文件历史服务，不更改传统 CLI 的尽力备份策略。备份内容按字节比较；
  UTF-8 解码结果相同或修改时间较早都不能证明文件未变。此共用比较用于快照继承及恢复。

## 验证与验收

定向测试覆盖解析、备份失败、同 prompt 幂等、多批写入、报错／取消后的历史、恢复、
冲突拒绝、备份缺失、所有者／路径隔离和 reload 后的 pending undo。使用打包 Hosted
CLI、真实 worker、Java Broker 和 HTTP Session Store 验证两个 Workspace。验证
已有文件恢复、新建文件删除，并回归默认无工具模式与 Shell。必须通过 build、
typecheck、bundle、定向测试和两轮干净自审。E2E 计划及实测结果保存在
`.qwen/e2e-tests/hosted-file-history.md`。

本地验证已通过：build、typecheck、bundle、定向测试、打包 worker 故障探针及 Hosted
进程回归。Broker/HTTP Store E2E 使用 H2 的 MySQL 兼容模式，验证了 detach/load
及实际文件恢复，未验证生产 MySQL 或数据库进程重启。

## 风险与待定事项

备份可用性依赖持久化 worker 卷。未知修改及部分撤销需要运维恢复，自动恢复不在本片
范围内。公开 UI、保留窗口以外的备份垃圾回收、跨宿主备份迁移仍属独立工作。本片没有
待定的 API 选择。
