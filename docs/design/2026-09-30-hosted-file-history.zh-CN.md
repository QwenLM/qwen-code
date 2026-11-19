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

面向模型的原生 Write/Edit 工具说明明确披露 MCP profile 不提供文件备份或撤销。
Files/Shell 工具说明指出，同一 prompt 内已跟踪文件的内容或权限发生漂移，会拒绝后续
Write/Edit 和撤销；Shell 修改本身不备份。只有整批备份验证成功后，新 prompt 才能
采纳新的前像。撤销到较早 prompt 会跨越后续基线恢复其历史前像，包括后来保存在新
快照中的外部或其他 Session 修改。

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
同一 prompt 内，准备阶段拒绝已跟踪路径在上次工具副作用后的变化。新 prompt 是
重新建立基线的边界：先采样所有跟踪文件，创建并验证新快照，再复核采样，整批成功后
才接受新的预期状态。外部／Shell 修改的字节及权限因此成为该 prompt 的修改前备份，
旧快照继续保留。同 prompt 重试及撤销仍拒绝漂移。准备期间其他写入者必须暂停；
备份失败或采样变化不能刷新预期状态。准备被拒绝时恢复到上次成功的快照及 prompt 记账状态，
保留预期文件状态，允许同一 prompt 缩小路径范围后重试。
明确的准备拒绝会转为本批 Write/Edit 的持久化工具错误，
其他获准调用可以继续。新回合的 bind 明确拒绝在确认释放 runtime 后将回合结算为错误。
这两种情况不阻塞 Session，也不保留空闲 Workspace 租约；补回缺失备份后可重试。
响应未知或释放失败仍需恢复。恢复已保存的 Shell 续执行则不同：bind 拒绝时保留
原 runtime 及恢复状态，因为关闭该 runtime 会使未完成回合无法继续。
原生执行中尚未进入工具动作的拒绝也结算为工具错误；进入动作后发生历史错误则继续
视为未知结果，包括即时执行响应与同一调用的重试。

每批调用完成后，包括工具报错和取消，worker 记录受影响文件的当前字节摘要及权限。
Harness 在模型继续和释放 runtime 前持久化结果状态。明确的执行预留冲突转为持久化
工具拒绝，不创建 runtime binding，其他获准调用仍正常结算。没有预留项的批次跳过
runtime 等待 checkpoint，记录拒绝后完成历史结算并清除 pending。
执行未知或历史持久化失败时阻塞 Session。detach 后 load 仅在匹配的持久 checkpoint
包含非空且全部已结算的工具结果时恢复 pending turn；pendingMessageId 将证据绑定到
当前批次的 assistant 消息，不能用上一批结果清除新标记。Harness 获取原 runtime，
直接读取其已绑定历史，不重新绑定副作用前的状态。核对快照身份并持久化结算后，从
已有结果继续模型，不重新派发工具。原 runtime 缺失、执行未知、结果不完整、快照
变化、pending undo 或观察／持久化失败仍阻塞。超时及 finally 均不能清除标记。
历史已结算但模型尚未继续时的中断也可恢复。重试观察不派发新的文件修改。通过内容相等避免重复历史提交，不将
worker 内的 revision 计数器用作持久化身份。

Session Store 保存快照及预期文件状态，备份字节保留在 FileHistoryService 的
worker 存储中。备份缺失以及非法、越界、符号链接路径均拒绝继续。在修改、结算和
撤销前重新检查备份，包括 worker 持续运行期间。最多保留 100 个 prompt 快照，
达到上限后拒绝新的修改 prompt，避免删除持久历史仍引用的备份。
临时备份访问错误会拒绝本次操作，但不将备份永久标为失败。跟踪映射支持与原型属性
同名的合法文件，并在序列化与冷绑定后保留它们。经过验证的 Workspace reload 除
最新状态外，也校验文件历史记录及其 previous-record 资源。
每条历史记录也受现有 Store 的 64 KiB 内联限制约束。Write/Edit 与撤销前的容量
预检包含两份快照、已有回执、pending 标记、副作用后最大文件指纹，以及撤销时列出
全部跟踪文件的回执；另预留 1 KiB 给 authority 信封。容量不足在原生副作用前拒绝，
Session 保持可用；撤销在获取 runtime 前返回
`409 hosted_file_history_capacity_exceeded`。Read/Shell 仍可使用，但后续
Write/Edit 可能需要新 Session。重复撤销也可能耗尽相同预算；已完成回执仍可重放。
本片不裁剪历史，也不保证无限保留。真正的持久化失败仍保留 pending 恢复标记。

## 仅文件撤销

私有 Hosted API 增加 `GET /session/:id/files/history` 和
`POST /session/:id/files/rewind`，后者接收目标 `promptId` 和 UUID `requestId`。
两者均为 live-session-owner 范围，要求现有客户端身份；撤销还要求文件工具 Session
空闲、可写且未阻塞。请求获取独立 runtime Session，并恢复已保存状态。
所有者正在关闭、忙碌或恢复时，在获取 runtime 前拒绝撤销。
Workspace 忙或暂不可用时返回可重试的 409。明确的 bind 拒绝在写入 pending 前
释放已获取的 runtime，并返回 `409 hosted_file_history_refused`。已释放的请求
ID 不能再次获取：重试原 ID 返回 `409 runtime_session_not_acquirable`，不阻塞
Session；修复条件后需提交新的请求 ID。busy／容量拒绝可以复用原 ID；已完成的
回执始终按原 ID 重放。获取、绑定或释放结果未知时仍阻塞。

Rewind 恢复到目标 prompt 开始时的状态，包括撤掉后续 prompt 的修改。快照继续
保留，因此先回退到较早目标，再选择较晚目标，可能将文件向前恢复。新建目录会保留。

撤销副作用前持久化 pending undo 记录。将每个跟踪文件与最后观察到的摘要及权限
比较，后续外部或 Shell 修改视为冲突。复用 `rewind(promptId, false)` 恢复已有
文件并删除新建文件，同时保留备份证据。释放及宣告完成前持久化新的预期文件状态。
部分恢复、响应未知或持久化失败时继续阻塞，reload 也不能绕过。此操作不是多文件
原子事务：撤销期间其他写入者必须暂停；恢复前发现冲突时不改动任何文件。
只读预检期间的路径类型变化或指纹读取失败也返回冲突，不修改预期状态。备份校验
失败及恢复开始后的错误仍保留现有失败语义。
已完成的撤销回执会保留在后续历史记录中，因此在另一次撤销、Write/Edit 或 reload
之后重试旧请求，仍返回原始结果，不重新获取已释放的 runtime。回执与快照共用有
大小上限的内联记录预算。

### 已存回执校验（#13124）

每次读取时，在调用方将数据用于历史查询、容量计算、工具获取期间的历史绑定、加载或
撤销回放前，校验所有已存回执。每条回执恰好包含 `requestId`、`promptId`、`filesChanged` 和
`conflict`：两个 ID 使用撤销 API 的 UUID 语法；prompt 必须属于仍保留的快照；
请求 ID 在累计回执列表内唯一。变更路径必须是唯一、规范化且已跟踪的路径，包括
合法的原型名称文件。冲突回执不能包含已变更路径。旧记录省略 `undoReceipts` 时
视为空列表；null、格式错误的条目和不支持的字段均拒绝。非法记录在副作用前进入
现有读取或恢复错误路径。
provider 边界也会在持久化回执前拒绝变更路径重复或未跟踪、缺失请求快照，以及冲突
却含变更路径的撤销结果。未知副作用仍保留可读的 pending 记录和现有恢复边界。
回执错误注明索引和失败规则；加载与历史读取失败在服务端记录原因，不改变客户端
错误码，也不向客户端暴露校验细节。

回执是不可变的历史结果，不描述当前文件内容。后续撤销及 Write/Edit 提交按顺序
保留它们，回放返回原结果，不再获取或派发 runtime。不能将旧回执与最新 prompt
或当前指纹比较。副作用后的记录可以同时包含相符的回执与 `pendingUndo`，直到
确认释放；pending 标记仍阻止回放和加载。如果该 pending 请求已有回执，两者的
prompt ID 必须一致。

当前 Hosted 快照和已跟踪路径不会缩减：达到 100 个快照时 prepare 拒绝新 prompt，
rewind 传入 `truncateHistory = false`。未来的保留或裁剪策略必须在同一次持久化提交中
移除引用已淘汰 prompt 或路径的回执，并保留其余回执的回放能力。

本后续只改变校验和说明。保留策略、裁剪、同 prompt 协调、撤销期间取消、I/O 优化，
以及未知或部分副作用的运维恢复仍是独立工作。不删除备份，也不因租约超时授权其他
写入者。

## 部署与升级

worker 备份位于 `$QWEN_HOME/file-history/<Harness Session ID>/`
（默认是 worker 所属 OS 用户的 `~/.qwen/file-history/`）。在 Broker 的 worker
环境中设置绝对路径 `QWEN_HOME`，挂载 worker 用户可写的持久存储。它需要与
Workspace 和 SQL Store 一起保留；仅持久化 Workspace 或数据库不会保存备份
字节。重启时保留仍被引用的备份文件。缺备份会明确拒绝，修复后可重试；未知或部分
副作用仍需运维恢复。

先升级 Broker 和 worker bundle，再升级 Hosted Harness。旧 Broker 会以
`400 runtime_control_operation_invalid` 拒绝 raw-history control；Harness
释放该次 bind 获取的 runtime，并将回合结算为错误，不派发工具，也不降级为无备份
写入。要恢复 files/Shell 工具回合，服务端与 worker 版本必须匹配。

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

#13124 增加非法回执及各 profile 工具说明断言，补强现有 HTTP 撤销测试中的回放键
不匹配、冲突回放与持久 pending 状态断言。复用已有的后续撤销、Write/Edit 及
重新加载后的回放测试。验证新回合 pending 历史守卫和派发前容量拒绝。定向计划及
实测结果保存在 `.qwen/e2e-tests/issue-13124.md`；若改变故障门禁的执行行为，
仍须运行真实 Java/MySQL 门禁。

本地验证已通过：build、typecheck、bundle、定向测试、打包 worker 故障探针及 Hosted
进程回归。Broker/HTTP Store E2E 使用 H2 的 MySQL 兼容模式，验证了 detach/load
及实际文件恢复，未验证生产 MySQL 或数据库进程重启。

## 风险与待定事项

备份可用性依赖持久化 worker 卷。未知修改及部分撤销需要运维恢复，自动恢复不在本片
范围内。公开 UI、保留窗口以外的备份垃圾回收、跨宿主备份迁移仍属独立工作。本片没有
待定的 API 选择。
