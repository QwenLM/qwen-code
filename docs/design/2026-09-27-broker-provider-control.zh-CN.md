# Broker Provider 控制契约

[English](2026-09-27-broker-provider-control.md) | [简体中文](2026-09-27-broker-provider-control.zh-CN.md)

状态：已实现。跟踪 #12765；关联 #12380 和 #12831。

## 问题与范围

Broker provider 暴露 manifest、回合准备、工具准备、确认、preflight 和文件历史操作，
但生产 HTTP transport 拒绝全部控制操作。自有 worker 的 Tool v2 日志接受四字段
reference 和原始参数；provider 使用七字段的已准备调用 reference。把二者当成同一
协议会丢失审批、能力与调用身份。

本次为现有客户端、Broker 和自有 worker 提供显式 provider 协议，保留 Tool v2/v3
以及 Workspace 目录、激活和存储持有检查。公开 Hosted 准入、任意配置加载、Shell
输出发布和重启恢复仍单独推进。#12831 负责独立门控的 Workspace 模型/工具循环。

## 线上契约

经过认证且禁止缓存的 POST 路由
`/internal/managed-runtime/provider/v1/control` 使用封闭信封：
`protocolVersion: 1`、`providerProtocol: managed-runtime-provider/1`、`session`
和 `operation`。Session 包含 `harnessSessionId`、`runtimeSessionId` 及
`turnKind`（`bootstrap` 或 `continuation`）。两个 Session id 都按白名单校验：
长度为 1 到 512 个字符，每个字符只能是 ASCII 字母、数字、`.`、`_` 或 `-`；id 不能
是 `.` 或 `..`，任何位置也不能出现 `..`。worker 在信封处拒绝其他任何 id，早于它
成为 core 会话 id 或文件历史目录名。Broker 以 400
`runtime_broker_invalid_request` 拒绝同样的 id，Harness Session id 在 `warm` 时就会
被拒，两个 id 在 `acquire` 时都会被拒：每个 Runtime Session 都要经这个信封
释放，worker 拒绝的 id 会让 Session 卡在 RELEASING，并一直占用其存储。线上契约不要求
UUID 形式：携带身份的操作还会通过 core 的身份检查要求 UUID，而 acquire、release 和
manifest 对不透明 id 保持可用。成功响应重复版本、协议与 Session，并包含 `result`；
无返回值时为 null，`acquire`/`release` 的结果恰为 `true`。现有 bearer、lease 和 epoch
请求头隔离选中的物理 Runtime。

operation 是封闭的判别联合。公开 Broker 控制为 `manifest`、`begin-turn`、
`prepare`、`confirmation`、`confirm`、`preflight`、`bind-history`、`checkpoint`
和 `history`。仅 transport 使用 `acquire`、`release`、`execute`、`status` 和
`cancel`。execute 不能经公开 Broker control 路由绕过执行日志。身份、reference、
修改、媒体、确认和历史数据复用既有 Managed Tool 契约。本 provider profile 拒绝携带
`modification` 的 `prepare`，在记录任何调用之前返回 400 `managed_runtime_tool_invalid`：
core 只对 `notebook_edit` 应用内容修改，而本 profile 只暴露 `read_file`、`write_file`、
`edit` 和 `run_shell_command`。共享的 provider 语料仍把这种形状列为合法，因为语料固定的
是两端都接受的线上形状，而不是某个 profile 实际提供的能力。`directory` 位于 Session
工作区之外的 `run_shell_command` 同样以此拒绝，因为 core 的 shell 工具只会询问，而预先
批准的 Session 从不询问。调用执行前 worker 会再检查一次，按内核跟随链接的方式重新解析
路径；若链接已把它移出工作区，该调用以错误结算。`mediaContext` 只对
`read_file` 生效：它把该工具面向模型的描述绑定到 Harness 的模态上，而读取本身按本
worker 自己的 content-generator 模态决定是否交付媒体；本 worker 没有这些模态，所以
媒体文件仍以“不支持的类型”占位文本作答。经 worker 交付媒体留作后续工作。派发前拒绝外来 Session
reference 和未知字段。Broker 还会以 400 `runtime_control_operation_invalid` 拒绝任何键或
字符串中含未配对代理项的操作，否则 JSON 写入器会把它发成 `?`。
不支持的版本与操作明确失败，不回退到旧路由。

工具选择或构建失败返回 `400 managed_runtime_tool_invalid`；不支持的 provider profile
返回 `501 managed_runtime_provider_unsupported`。Broker 仅从封闭 JSON 错误响应中保留
已知 provider 状态码/错误码组合及最多 4096 字符的原因，并要求 no-store 响应头且无
Content-Encoding。TypeScript 客户端保留限长原因。这些诊断信息不能证明执行是否已开始。

`bind-history`、`checkpoint` 和 `history` 的控制请求与响应限制为 8 MiB，其他操作为
1 MiB。工具参数还受 core 既有的 256 KiB 规范化 JSON 限制；满足外层信封限制并不绕过
参数限制。`execute`、`status` 或 `cancel` 的结果超出所属操作响应预算时会被适配而非
拒绝：worker 先淘汰最旧的 progress 事件（通过 `firstAvailableSeq`/`progressGap`
告知），再把大文本字段按首尾截断并内联标记，shell 展示置 `truncated`；若大文本
全部截到最短，仍放不下截断够不到的部分，则在截断任何文本之前，先丢弃结构化的展示
（例如 edit 的文件 diff，它只供界面使用），再丢弃同样只供客户端界面使用的 artifacts，
最后丢弃 hook 结果；截断完全够不到的内容
（内联媒体）会让模型内容变为明确的占位存根。截断按 JSON
编码后的 UTF-8 字节计量，与线上限制的单位一致；删除时以完整码点为单位，因此不会拆开
代理对；标记注明省略了多少个字符（按码点计）。多个字段同时超长时，截到同一个大小，
不会出现一个字段被清空、另一个字段仍保留大部分文本的情况。因此已结算的执行始终保有终态观察，
释放也始终可应答。Broker 自身无法编码的超大操作，在发送前即以确定且不可重试的 413
拒绝。相同完整 Session 身份的获取与释放幂等。同一 Runtime Session 换用 Harness 或
turn kind 会产生冲突。释放拒绝运行中的工作，取消尚未预留的准备调用，并永久关闭新操作
准入，不清除当前回合的状态/取消证据（保留到该 Session 被退役为止，见下文）。释放还会
删除 core 以该 Runtime Session id 为键保存的进程级记录（项目目录、模型与模型标识）；
worker 关闭时同样删除。开始新回合仍
遵循 runtime 既有清理策略；较早已派发的调用仍保留在 Broker 持久日志中。Broker HTTP
可在 Session 非 READY 时读取归属已验证的终态执行回执；实时观察与文件历史控制仍要求
READY。对已结算的准备调用重复取消时，若 Session 已非 READY，或该调用准备时所在的
binding 代次已无法应答，则直接以回执作答。只要该代次仍可能持有这次准备，没有其活
Session 的 Broker 进程就返回可重试的 503 `runtime_reconciliation_required`（与对账
一致）：调用方重新获取 Session，待 worker 确认后才确认这次取消。本进程中若同一 id
下是另一个 Harness 的 Session，则是冲突（409 `runtime_session_conflict`）。worker
会在下一回合忘掉已结算的调用；它对重复取消回答 `unknown` 时，与首次取消一样以不可
重试的 409 `runtime_execution_cancel_unconfirmed` 拒绝，回执仍可读取。释放不删除持久证据。
已持久化的 Broker 预留必须在释放前显式取消。

## Runtime 与持久化

worker 为每个已获取的 provider Session 持有一个 Managed Tool runtime，复用其
manifest、准备、审批和 preflight 语义。参数保留在 worker 已准备的调用中。Broker
仅保存已准备 reference，执行时将其交给原 worker。准备状态缺失不能重建或重放
调用。新操作重新检查解析出的 Workspace 和激活状态；清理与观察使用原状态。
旧原始工具调用保留独立协议，不能进入由 provider 协议持有的 Session。获取被拒时撤销
临时 provider 登记，保留原始工具准入；显式释放仍永久关闭准入。worker 不再保留某个
调用时，状态与取消只返回 `{ state: 'unknown' }`。仍保留的调用若引用被改动，继续返回
冲突；执行状态缺失始终不允许重放。

为兼容原始 Tool v2，Broker Session 获取仍为本地操作。在首次通用控制前，transport
显式获取 worker provider Session；重复获取幂等。历史观察、状态与取消不会获取或
重开 Session。释放需要真实 worker 回执，包括仅使用原始工具的 Session。Workspace
释放先关闭 provider 准入，再停用激活并释放存储持有。

Boot v1 使用 worker 固定四工具配置与 DEFAULT 审批。调用方必须在执行前落实确认决策；
DEFAULT 不代表私有 worker 会拒绝跳过确认的执行。Boot v2 provider 控制必须满足
既有精确 Workspace capability 和配置 profile、上下文已安装及激活条件，并保留其
预批准策略。其他不透明上下文配置引用不能启用 provider 控制。显式文件历史绑定为
这个协议启用历史跟踪；既有原始工具 profile 保持原行为。

文件历史绑定固定 owner 与解析出的执行目录。客户端路径不能替代放置权威。绑定重试
必须一致；依赖历史的工作开始前必须先绑定。snapshot 与 checkpoint 返回既有版本化
文件历史状态。不支持的配置/profile 组合明确拒绝，不静默应用。

provider 的 reserve/start 路径需要 Broker 持久预留。预留创建 PREPARED 执行而不
派发；start 驱动现有派发租约与同 reference 幂等性。开始前取消必须无工具副作用地
结算。worker 取消可能先返回 `cancel_requested`；Broker 在操作截止时间内等待原调用的
`not_started` 或 `cancelled` 结果，再确认已准备调用的取消。UNKNOWN 只能观察，不能
变成重放许可。这包括继承的派发期间 HTTP 拒绝保守处理：没有权威执行证据时，即使
worker 的原因描述为拒绝，仍保持 UNKNOWN。该状态阻止释放，并可能继续持有 Workspace
存储。仅凭错误码不能证明执行从未开始。Broker 的 Runtime 丢失恢复可将不确定执行封存为
ABANDONED：结果永久未知，可通过持久归属读取，但不能重放。Broker HTTP 的 start、读取与
取消会像对 tool v3 一样，就停留在 UNKNOWN 的 provider 执行询问原 worker，由其保留的结果
结算执行，不会再次派发；取消也会送达 worker 上仍在运行的调用。询问是尽力而为的：无论
因为什么原因无法再询问原 Runtime 或无法得到应答，记录都保留自己的
`runtime_broker_execution_unknown` 应答，而不是这次尝试的错误。现有即时 Tool v2 行为
独立保留。

#12831 的原始 reserve/start 路径继续使用同一组 Broker 路由：预留四字段 reference，
仅在 start 时提供精确的 `payloadJson`。provider 预留使用七字段 reference 并拒绝
start 载荷；原始预留必须提供载荷。由保存的 reference 决定协议，重试不能切换执行契约。

## 归属与消费者

所有新增 worker 操作归选中的 Runtime 与精确的 live Session owner 所有。Broker
HTTP 操作解析持久化 Harness Session。消费者为 `BrokerManagedRuntimeProvider`、
`ManagedRuntimeBrokerClient`、`RuntimeBrokerHttpServer`、`RuntimeBrokerService`、
`HttpRuntimeTransport`、`WorkspaceRuntimeTransport` 与自有 worker。任何操作都不
回退到主 daemon、全局目录或其他 Runtime 代际。

## 验证与验收

- 两端验证封闭操作形状、版本、身份与大小限制。
- 经真实 HTTP 覆盖九种控制，包括不可变审批、更改参数、外来 reference 与历史归属。
- 真实 worker 覆盖获取、准备、预留、启动、观察、取消和释放；启动前无副作用，保存的
  reference 不含载荷。
- 拒绝过期 lease/epoch、不可用上下文、冲突的重复获取、活跃释放与混用旧/provider 准入。
- 保持现有 worker、transport、Broker 和 Workspace 测试通过。运行 build、typecheck、
  bundle、定向单测、Java Checkstyle 与独立 E2E。
- 完整 diff 自查两轮，并进行独立代码评审。

## 开放边界

worker 日志仅属于当前代际。重启 worker 不能从 Broker reference 行恢复准备参数或
审批。恢复保持失败关闭。私有契约测试成功不代表公开 Workspace 回合启用，也不宣称
完整 Hosted 产品已就绪。

immediate `POST /executions` 路由仍从已保存的 reference 读取 `toolName`/`input`，
其调用方必须把工具参数保存在 `reference_json` 中——这正是工具契约 §4.1 禁止写入
持久状态的形态。deferred reserve/start 路径与本协议才是负载分离的路由；把同样的
分离扩展到 immediate 路由是后续工作。

释放后、该 Session 被退役之前，私有 worker 路由保留当前回合的状态/取消证据及已绑定的
文件历史状态；较早回合的调用条目仍可能被清理。释放后，Broker 执行检查可返回持久终态
回执，无需重开 worker；已关闭的 provider 工具客户端仍不提供私有历史和实时调用观察。
释放会删除 core 以该 Runtime Session id 为键保存的进程级记录。worker 最多为八个已释放
的 Session 保留其 Config、工具、runtime 与文件历史，释放后的状态、取消与历史查询仍能
作答；再有 Session 释放时，其中最早的、当前没有查询在进行的那个会被退役（处置
runtime、排空文件历史、关闭 Config），只留下一条已关闭记录，其调用查询回答
`unknown`；未经获取就释放的 Session 留下的也是这种记录。这条记录使重复释放保持幂等，
并拒绝再次获取；与 executor 的已关闭 Session 集合一样，每个已释放的 Session 仍会留下
一条很小的记录。
