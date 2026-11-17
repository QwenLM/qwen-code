# 外部 Runtime provider

[English](2026-10-23-external-runtime-provider.md)

Issue：https://github.com/QwenLM/qwen-code/issues/15247

## 状态与目标

当前是开发中的增量，尚未验收或部署。目标是在中心运行 Managed Agent Server 与 Hosted Harness，通过独立适配服务动态创建远程沙箱工具 worker。厂商 SDK 和基础设施凭据放在适配服务中，不进入 qwen-code。

当前实现明确命名为 `external-scratch`：它支持 Session 隔离的 boot-v1 临时 worker，**不支持 Hosted Workspace 工具**。配置层拒绝 Workspace 功能，不能通过跳过存储身份和所有权验证来让演示运行。下文的 Workspace 扩展是待实现设计。

在 Spring 服务中，本增量只完成 worker 的分配、身份认证和恢复，尚无工具调用方。未绑定 Workspace 的 Session 没有 Hosted 工具 profile，Hosted Harness 不向模型声明任何工具；但每个被接纳的 Turn 仍会预热该 Session 的 Runtime。因此每个这样的 Session 都会占用一个收不到任何工具调用的远程 worker，直到 provider 自身的 TTL 结束它。远程工具执行依赖下文的 Workspace 扩展；不要为了工具调用在生产环境启用 `external-scratch`。

`RuntimeBrokerService` 的 Runtime Session 活性属于进程内状态，与持久化的 Session 身份分开。Broker 重建后，`warm()` 可以接管原 worker binding 并验证身份，但不会恢复进程内 Session。创建新执行前，调用方必须重新 `acquire()` 该 Session，否则 `requireSession()` 返回 `runtime_session_not_found`。只有完整 Session 身份（Harness/Runtime Session ID、turn kind、scope、binding ID 和 generation）一致且已有记录为 `READY` 时，重新获取才会复用仓库记录而不调用 `transport.acquire`；这不允许复活已释放或失败的 Session。重放已终结执行的回执属于独立的持久化查询，不能证明 Session 活性。

## Scratch HTTP 协议

Broker 在配置的 provider URL 下相对请求 `provision` 和 `observe`，使用 POST、provider Bearer 凭据、JSON 请求及响应头、`Cache-Control: no-store`。不跟随重定向，请求和响应各限制 64 KiB；成功必须返回 HTTP 200 和 `protocolVersion: 1`。网络错误、超时、408、429、5xx 可重试，但不证明资源消失，也不允许替换原 worker。错误消息不透出 provider 响应体。远程服务应使用 HTTPS，仅允许受信控制面访问。

`provision` 请求包含 `protocolVersion`、`provisionRequestId`、`identity`、`scope`、`boot` 和固定逻辑 `handle: {requestId: provisionRequestId}`。Broker 在首次 HTTP 请求之前先持久化该 handle：ensureResource 不进行远程操作，provision 才发出幂等请求。scope 包含租户、Workspace ID/generation、worker 内 cwd、隔离类型和隔离键。boot 原样使用现有封闭的 v1 协议，携带 Broker 生成的 runtime/incarnation、lease/epoch/token、capability digest 等字段，不得记录到日志。

适配服务必须持久化按 provisionRequestId 去重的结果，并绑定 identity；请求 ID 相同但 identity 不一致时必须拒绝（不能返回原资源）。相同请求只能指向原物理资源，丢失响应或原 worker 消失后不能悄悄新建替代者。响应为 `{protocolVersion:1,handle:{requestId:provisionRequestId},endpoint?:"https://worker.example/"}`。实际 sandbox ID 只保存在适配器的不可变资源记录中；物理 ID 和凭据都不作为 handle 返回。Broker 保存带 providerId、requestId、identity 的封装，拒绝返回不同逻辑 handle 的响应。identity 是 providerId、隔离键及去掉 token 的 boot 的规范 JSON SHA-256。这样首次 HTTP 响应丢失时 Broker 仍有已保存的 handle，可以重试同一幂等请求。

`observe` 请求包含版本、请求 ID、identity 和原 handle，必须只读，且必须校验原物理 handle 完全一致。响应为 `RUNNING`（必须有 worker HTTP(S) origin）、`STARTING` 或 `UNKNOWN`。`GONE` 会阻止接管，不会触发自动替换。Broker 会独立向 worker 执行身份认证，provider 报告 RUNNING 不等于 worker 身份已验证。

**没有 release HTTP 接口。** Broker 在并发竞争失败或认证失败时也可能调用 release，因此它不能授权杀死另一持有者正在使用的 worker。自动关闭与恢复必须另行定义带所有权约束的停止协议和持久化停止证明。TTL 到期属于资源丢失，不属于干净停止证明。

## 配置

Runtime provisioner 设为 `external-scratch`，使用 session 隔离，明确设置远程 cwd 和 Workspace ID，并关闭 trusted local reboot recovery。新增环境变量：

- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_URL`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_TOKEN`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_ID`：稳定 provider 身份，默认 `external`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_REQUEST_TIMEOUT`：默认 `30s`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_STARTUP_TIMEOUT`：默认 `2m`；Broker 的首次尝试受当前四倍 operation lease 截止时间约束，超过该栅栏的配置可能需要一次重试才能收养原 worker

Preflight 仅验证配置，不证明网络连通、worker 身份或 Hosted 工具可用。适配服务重启后必须保留幂等记录。当前有界的进程内 placement 缓存沿用 scratch 模型，不代表已经实现完整资源回收机制。

## Hosted Workspace 必须补齐的扩展

增加明确的 `external-workspace` 能力，避免改变已保存 scratch handle 的含义。复用 `managed-context/1`、boot-v2 和现有 install/activate/tool 协议，不向封闭的 worker boot 文档塞入任何 provider 专有字段。

1. 独立注册远程存储：provider ID、稳定物理存储身份、注册 revision、租户/storage alias 和 worker mountRoot。提供只读连续性与规范 cwd 探测。一次性 sandbox ID 不能替代持久存储身份。
2. 为 `WorkspaceStorageGuard`、`WorkspaceExecutionStore` 和 `WorkspaceRuntimeResolver` 增加外部存储所有权与物理键映射，保留 SQL writer/generation 约束、跨租户授权和别名冲突保护。中心不能对 worker 内路径执行本地 Files 检查。
3. `WorkspaceRuntimeTransport` 在 claim 前验证外部存储，再安装 context 和激活；结果不确定时保留所有权。不能大范围绕过现有的 local/SSH/CSI 分支。
4. CLI worker 增加明确的远程 managed container 启动路径。当前 container 模式拒绝普通 boot-v2。worker 和控制面都必须验证预期存储身份，保留路径范围与进程所有权检查。
5. 前台 shell 需要 worker 可访问的中心 publication/capture 地址和相应控制限制。文件浏览、MCP、本地目录导入、子 Workspace、快照、迁移，未实现前继续拒绝。
6. 声称自动关闭或恢复前，必须定义针对原 worker 的 stopDrained 证明。release、探测失败、GONE 或沙箱过期均不足以释放存储持有者。
7. 完全动态创建 Workspace 还需要持久、幂等的存储分配与注册操作，然后创建 Workspace 和权限；provision 时创建沙箱本身不完成这个生命周期。

Aone SDK、分配、入口地址、挂载和进程监管留在独立适配服务。通用实现不要求 Kubernetes 或 SSH。

## 验证矩阵与现有证据

调用方源码检查只能确认更窄的边界：Spring 的 `HarnessCoordinator.warmRuntime` 经 `EmbeddedRuntimeBroker.warm` 仅预热 binding。`RuntimeBrokerHttpServer` 将显式 acquire/create 请求转交 `RuntimeBrokerService`，不会插入重新 acquire。现有 Hosted Workspace 调用方在 `HostedWorkspaceToolTurn` 和 `hosted-runtime-recovery.ts` 中通过 `HostedWorkspaceBroker.acquire` 显式获取 Session，执行使用 prepare/start 路径。这些源码路径不能证明所有调用方均已自动适配重启，也不能证明没有 Spring 工具调用方的 `external-scratch` 已完成此适配。`ExternalRuntimeWorkerFaultGateTest` 在 warm 接管后显式重新 acquire，并在 Broker 实例间共享内存仓库；它覆盖的是这一 Broker/worker 序列，不是 Spring/Hosted 重启 E2E，也不是持久化数据库重启。远程工具调用方的重启适配仍属于尚未实现的 Workspace 扩展集成工作。

| 层级                 | 所需证据                                                          | 能证明什么                             |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| Provider 单测        | 重启保留原 handle、拒绝替换和 scope 漂移、超时归类 UNKNOWN        | placement 转换和恢复判断               |
| HTTP 集成            | 实际鉴权 JSON、URL 前缀、重定向拒绝、错误脱敏、响应大小限制       | Java HTTP 协议行为                     |
| Broker + 真实 worker | 身份验证和文件工具、重复或丢响应、重启接管                        | 原进程身份及真实工具调用               |
| 公开 Hosted 远程 E2E | 文件读写编辑、前台 shell/审批/capture、租户与存储不匹配、资源丢失 | 用户使用中心服务调用远程工具的完整路径 |

该矩阵区分已实现行为与已执行验收证据。Provider 单测与 HTTP 集成覆盖分配、分类和协议边界；仓库 full-tier workflow 负责 MySQL、Hosted 和 process fault gates。`ExternalRuntimeWorkerFaultGateTest` 通过受控 operator fixture 串联真实 Broker、HTTP client 和 CLI worker，但不能证明厂商沙箱或 Hosted Workspace 集成。当前 revision 的 CI 是验收依据；任何历史本地或私有适配器运行都不是 exact-head 验收证据。
