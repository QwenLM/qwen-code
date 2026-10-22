# 外部 Runtime provider

[English](2026-10-23-external-runtime-provider.md)

Issue：https://github.com/QwenLM/qwen-code/issues/15247

## 状态与目标

当前是开发中的增量，尚未验收或部署。目标是在中心运行 Managed Agent Server 与 Hosted Harness，通过独立适配服务动态创建远程沙箱工具 worker。厂商 SDK 和基础设施凭据放在适配服务中，不进入 qwen-code。

当前实现明确命名为 `external-scratch`：它支持 Session 隔离的 boot-v1 临时 worker，**不支持 Hosted Workspace 工具**。配置层拒绝 Workspace 功能，不能通过跳过存储身份和所有权验证来让演示运行。下文的 Workspace 扩展是待实现设计。

## Scratch HTTP 协议

Broker 在配置的 provider URL 下相对请求 `provision` 和 `observe`，使用 POST、provider Bearer 凭据、JSON 请求及响应头、`Cache-Control: no-store`。不跟随重定向，请求和响应各限制 64 KiB；成功必须返回 HTTP 200 和 `protocolVersion: 1`。网络错误、超时、408、429、5xx 可重试，但不证明资源消失，也不允许替换原 worker。错误消息不透出 provider 响应体。远程服务应使用 HTTPS，仅允许受信控制面访问。

`provision` 请求包含 `protocolVersion`、`provisionRequestId`、`identity`、`scope`、`boot` 和固定逻辑 `handle: {requestId: provisionRequestId}`。Broker 在首次 HTTP 请求之前先持久化该 handle：ensureResource 不进行远程操作，provision 才发出幂等请求。scope 包含租户、Workspace ID/generation、worker 内 cwd、隔离类型和隔离键。boot 原样使用现有封闭的 v1 协议，携带 Broker 生成的 runtime/incarnation、lease/epoch/token、capability digest 等字段，不得记录到日志。

适配服务必须持久化按 provisionRequestId 去重的结果，并绑定 identity；相同请求只能指向原物理资源，丢失响应或原 worker 消失后不能悄悄新建替代者。响应为 `{protocolVersion:1,handle:{requestId:provisionRequestId},endpoint?:"https://worker.example/"}`。实际 sandbox ID 只保存在适配器的不可变资源记录中，不作为公共 handle 返回。Broker 保存带 providerId、requestId、identity 的封装，拒绝返回不同逻辑 handle 的响应。identity 是 providerId、隔离键及去掉 token 的 boot 的规范 JSON SHA-256。这样首次 HTTP 响应丢失时 Broker 仍有已保存的 handle，可以重试同一幂等请求。

`observe` 请求包含版本、请求 ID、identity 和原 handle，必须只读。响应为 `RUNNING`（必须有 worker HTTP(S) origin）、`STARTING` 或 `UNKNOWN`。`GONE` 会阻止接管，不会触发自动替换。Broker 会独立向 worker 执行身份认证，provider 报告 RUNNING 不等于 worker 身份已验证。

**没有 release HTTP 接口。** Broker 在并发竞争失败或认证失败时也可能调用 release，因此它不能授权杀死另一持有者正在使用的 worker。自动关闭与恢复必须另行定义带所有权约束的停止协议和持久化停止证明。TTL 到期属于资源丢失，不属于干净停止证明。

## 配置

Runtime provisioner 设为 `external-scratch`，使用 session 隔离，明确设置远程 cwd 和 Workspace ID，并关闭 trusted local reboot recovery。新增环境变量：

- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_URL`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_TOKEN`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_ID`：稳定 provider 身份，默认 `external`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_REQUEST_TIMEOUT`：默认 `30s`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_STARTUP_TIMEOUT`：默认 `3m`

Preflight 仅验证配置，不证明网络连通、worker 身份或 Hosted 工具可用。适配服务重启后必须保留幂等记录。当前有界的进程内 placement 缓存沿用 scratch 模型，不代表已经实现完整资源回收机制。

## Hosted Workspace 必须补齐的扩展

增加明确的 `external-workspace` 能力，避免改变已保存 scratch handle 的含义。复用 `managed-context/1`、boot-v2 和现有 install/activate/tool 协议，不向封闭 boot 塞入 Aone 字段。

1. 独立注册远程存储：provider ID、稳定物理存储身份、注册 revision、租户/storage alias 和 worker mountRoot。提供只读连续性与规范 cwd 探测。一次性 sandbox ID 不能替代持久存储身份。
2. 为 `WorkspaceStorageGuard`、`WorkspaceExecutionStore` 和 `WorkspaceRuntimeResolver` 增加外部存储所有权与物理键映射，保留 SQL writer/generation 约束、跨租户授权和别名冲突保护。中心不能对 worker 内路径执行本地 Files 检查。
3. `WorkspaceRuntimeTransport` 在 claim 前验证外部存储，再安装 context 和激活；结果不确定时保留所有权。不能简单放开所有 provider 类型。
4. CLI worker 增加明确的远程 managed container 启动路径。当前 container 模式拒绝普通 boot-v2。worker 和控制面都必须验证预期存储身份，保留路径范围与进程所有权检查。
5. 前台 shell 需要 worker 可访问的中心 publication/capture 地址和相应控制限制。文件浏览、MCP、本地目录导入、子 Workspace、快照、迁移，未实现前继续拒绝。
6. 声称自动关闭或恢复前，必须定义针对原 worker 的 stopDrained 证明。release、探测失败、GONE 或沙箱过期均不足以释放存储持有者。
7. 完全动态创建 Workspace 还需要持久、幂等的存储分配与注册操作，然后创建 Workspace 和权限；provision 时创建沙箱本身不完成这个生命周期。

Aone SDK、分配、入口地址、挂载和进程监管留在独立适配服务。通用实现不要求 Kubernetes 或 SSH。

## 验证矩阵与现有证据

| 层级 | 所需证据 | 能证明什么 |
| --- | --- | --- |
| Provider 单测 | 重启保留原 handle、拒绝替换和 scope 漂移、超时归类 UNKNOWN | placement 转换和恢复判断 |
| HTTP 集成 | 实际鉴权 JSON、URL 前缀、重定向拒绝、错误脱敏、响应大小限制 | Java HTTP 协议行为 |
| Broker + 真实 worker | 身份验证和文件工具、重复或丢响应、重启接管 | 原进程身份及真实工具调用 |
| 公开 Hosted 远程 E2E | 文件读写编辑、前台 shell/审批/capture、租户与存储不匹配、资源丢失 | 用户使用中心服务调用远程工具的完整路径 |

早期生产类曾离线编译通过，但之后已修改配置并新增测试，不能代表当前工作树通过。新增生命周期与 HTTP 测试尚未执行。前一轮 Maven 依赖解析耗尽了模块统一的本地验证预算，聚焦测试和完整 CI 门禁仍待执行。本增量没有完成 Aone 适配器，也没有取得外部 Hosted Workspace 端到端证据。
