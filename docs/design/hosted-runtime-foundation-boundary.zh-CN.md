# Hosted Runtime 基础设施边界

[English](hosted-runtime-foundation-boundary.md) | [简体中文](hosted-runtime-foundation-boundary.zh-CN.md)

## 状态与问题

PR #12691 是从 #12358 提取的基础设施，不是可运行的 Hosted Harness。
评审发现缺少会话循环和 worker 路由接线、引用了 main 尚不存在的原生执行 API，
以及 Java 与 TypeScript 执行契约不兼容。本次约定范围是恢复构建并在能力不足时
明确拒绝操作，不引入预览分支的完整架构。

## 范围与决策

`qwen serve --profile hosted-harness` 在监听端口之前失败，即使凭据完整也不例外。
实验性 Managed Gateway、worker 和 auto-local 设置同样失败。默认 serve 保持可用；
显式 Broker 参数要求当前不可用的 hosted profile。默认模式下仅设置 Broker 环境
变量不会生效。帮助文本说明这一限制。

Bridge 的 managed-tool 方法是可选能力。本地 provider 在创建会话之前拒绝缺少
这些能力的 Bridge。这并未实现 ACP worker。尚未使用的持久化 session-store 和
continuation 元数据声明不能证明持久化或恢复已可用。

内置 managed 工厂只接纳源 registry 已允许的 ReadFile、WriteFile、Edit、
NotebookEdit、Glob、启用时的 LS 和 ZoomImage。在具备真实进程所有权和取消后
执行完成判定之前，排除 Shell 及两种 Grep 实现。原生工具的可选 undefined 参数
先投影为 JSON，再生成响应和完整性摘要；入站请求继续严格验证。编辑确认采用
独立于较小请求限额的有界响应预算。

ProcessRegistry 使用 ProcessExitError 区分已确认的非零退出码或信号退出与
无法证明进程树清理完成的错误。本地 worker 回收只接受前者。其他关闭流程的
消费者继续保留已有 Error 行为和错误消息。

Managed-tool 调用记录保留至当前轮次结束，以支持轮次内重试。开始新轮次前必须
等待此前所有工作完成，随后丢弃上一轮的调用记录及调用槽。因此 1,024 次调用的
上限针对单个轮次，而不是会话的整个生命周期。轮次推进后旧引用失效；已完成的
调用不能使用旧 prompt ID 再次 prepare。

## Broker 契约与所有权

所有 Broker HTTP 操作归属已解析的 Harness 会话及其 Runtime 会话；tenant 和
workspace 来自服务端 resolver。这些不是主 daemon 或进程全局的工作区路由。

Java 服务支持立即创建并执行。HTTP 适配器对延迟 prepare/start 和操作员手工
resolution 返回 501 runtime_broker_operation_unsupported，不产生执行或裁决
副作用。UNKNOWN 记录返回 409 runtime_broker_execution_unknown，不伪装成
executing。因此 TypeScript 两阶段客户端会在不支持的操作上失败，目前不能挂载
为生产闭环。

Java HTTP transport 仍支持 attestation 及其已有格式的 execute/status/cancel。
Acquire/control/release 明确拒绝。其引用与结果格式不同于 TypeScript 的
ManagedToolV2Client；本 PR 不宣称两端已经互通。

local-process provisioner 只认领自身持有的进程。未持有或不可达的进程是 UNKNOWN；
只有本地观测到 Process 已死亡才支持 NOT_FOUND。Broker 重启后的进程认领仍不可用，
避免临时 attestation 故障允许在存活 worker 旁创建替代 worker。

进程所有权以包含已证明 endpoint 的完整 lease 为键。binding ID 跨 generation
保持不变，即使重试同一 seed，也可能启动不同 worker。释放某次尝试不得删除、
终止、确认另一尝试的进程，也不得将另一进程的存活状态报告为自身的可用性。
已发放身份在 provisioner 的整个生命周期内保持保留，release 后也不删除。
若 worker 退出后重试复用了其 seed 与 endpoint，则销毁新的候选进程，并以
不可重试的身份冲突拒绝发放，避免延迟到达的旧 release 指向替代进程。

Broker 客户端允许重试失败的 acquire，在 release 时使已发放客户端失效，并在
并发 release 调用之间保留 terminal 意图。

## 验证与验收

对所有包执行 build 和 typecheck，并运行定向 Core、Bridge、CLI 和 Java 测试。
覆盖真实 ReadFile prepare、超过请求限额但仍在响应预算内的编辑确认、acquire
重试、已释放客户端拒绝、未实现 profile 启动拒绝、强制终止 worker，以及 Java
HTTP 的 unsupported、UNKNOWN 和认证边界。

另外验证跨轮次完成超过 1,024 次调用、当前轮次重试去重以及过期引用拒绝。
对同一 binding 分别使用不同 generation 和完全相同的 seed 启动两个 worker；
释放失败尝试的 lease 必须保留胜出的 worker，两份 lease 都释放后不得遗留孤儿
进程。每个 serve 参数必须由 fast path 解析，或明确回退到完整解析器。
覆盖 worker 崩溃和正常 release 后的 endpoint 复用。测试实际 serve 入口在监听
之前拒绝启动，并验证源工具 registry 即使注册了 Shell 及两种 Grep 实现，也
不会将它们纳入 managed 能力。

移除从预览带入、依赖不存在 worker 路由的测试；保留 provider 单测和传输 fixture
测试。在真正包含 worker 实现之前，被移除的测试无法证明 worker 覆盖率。

验收要求普通 serve 能加载、未实现模式不监听端口、prepare 不派发执行、未知结果
保持未知，且所有纳入代码可编译。不宣称已验证真实模型/工具往返和重启恢复。

## 后续要求

后续集成需要补充常驻会话循环、自有 ACP worker 路由、统一 wire 格式、持久化
reserve/start 与显式 resolution API、session-store/continuation 接线、
Shell/Grep 进程管控，以及真实冷启动 E2E 测试。启用 hosted profile 必须建立在
这些行为之上，不能仅依靠配置校验或 mock 传输测试。

挂载前，必须将文件历史中的相对路径及 `executionCwd` 绑定到已认证且已解析的
工作区，不能信任传入的 binding。统一 worker/client wire schema，并协调实验
客户端的 8 MiB 响应预算（含独立媒体例外）与自有路由契约的 1 MiB 工具结果上限。
Hosted 握手中间件在 capability digest 完成验证前不得挂载；普通 capabilities
不宣称该能力。明确并测试 Broker 服务端的 loopback/TLS 部署边界和有界请求并发，
通过未来实际集成的调用方验证 static provisioner。这些都是启用 profile 的
前置条件，不是本 PR 已提供的能力。
