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
`turnKind`（`bootstrap` 或 `continuation`）。两个 Session id 都必须是可打印、
路径安全的文本（不含路径分隔符、`.`/`..` 片段、控制字符或未配对代理项）；
其他拼写在信封处即被拒绝，早于该 id 成为 core 会话 id 或文件历史目录名的任何
时机。线上契约不要求 UUID 形式：携带身份的操作本就通过身份检查要求 UUID，
而 acquire、release 和 manifest 对不透明 id 保持可用。成功响应重复版本、协议与
Session，并包含 `result`；无返回值时为 null。现有 bearer、lease 和 epoch 请求头隔离选中的
物理 Runtime。

operation 是封闭的判别联合。公开 Broker 控制为 `manifest`、`begin-turn`、
`prepare`、`confirmation`、`confirm`、`preflight`、`bind-history`、`checkpoint`
和 `history`。仅 transport 使用 `acquire`、`release`、`execute`、`status` 和
`cancel`。execute 不能经公开 Broker control 路由绕过执行日志。身份、reference、
修改、媒体、确认和历史数据复用既有 Managed Tool 契约。派发前拒绝外来 Session
reference 和未知字段。不支持的版本与操作明确失败，不回退到旧路由。

工具选择或构建失败返回 `400 managed_runtime_tool_invalid`；不支持的 provider profile
返回 `501 managed_runtime_provider_unsupported`。Broker 仅从封闭 JSON 错误响应中保留
已知 provider 状态码/错误码组合及最多 4096 字符的原因，并要求 no-store 响应头且无
Content-Encoding。TypeScript 客户端保留限长原因。这些诊断信息不能证明执行是否已开始。

历史控制请求与响应限制为 8 MiB，其他操作为 1 MiB。工具参数还受 core 既有的
256 KiB 规范化 JSON 限制；满足外层信封限制并不绕过参数限制。超出所属操作响应
预算的结果会被适配而非拒绝：worker 先淘汰最旧的 progress 事件（通过
`firstAvailableSeq`/`progressGap` 告知），再把大文本字段按首尾截断并内联标记，
shell 展示置 `truncated`，因此已结算的执行始终保有终态观察，释放也始终可应答。
Broker 自身无法编码的超大操作，在发送前即以确定且不可重试的 413 拒绝。相同完整
Session 身份的获取与释放幂等。同一 Runtime Session 换用 Harness 或 turn kind 会
产生冲突。释放拒绝
运行中的工作，取消尚未预留的准备调用，并永久关闭新操作准入，不清除当前回合的
状态/取消证据。开始新回合仍遵循 runtime 既有清理策略；较早已派发的调用仍保留在
Broker 持久日志中。Broker HTTP 可在 Session 非 READY 时读取归属已验证的终态执行回执；
实时观察与文件历史控制仍要求 READY。释放不删除持久证据。已持久化的 Broker 预留必须在
释放前显式取消。

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
ABANDONED：结果永久未知，可通过持久归属读取，但不能重放。现有即时 Tool v2 行为独立保留。

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

释放后，私有 worker 路由保留当前回合的状态/取消证据及已绑定的文件历史状态；较早回合的
调用条目仍可能被清理。释放后，Broker 执行检查可返回持久终态回执，无需重开 worker；
已关闭的 provider 工具客户端仍不提供私有历史和实时调用观察。worker 当前保留 Session 的
Config、工具与 runtime，直到 worker 关闭，因此
内存可能随已释放的 provider Session 数量增长。在保留私有观察语义的前提下减少这部分
保留是后续工作。
