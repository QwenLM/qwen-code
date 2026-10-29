# Managed Agent 的 E2B Cloud 执行环境

[English](2026-10-28-e2b-managed-runtime.md) | [简体中文](2026-10-28-e2b-managed-runtime.zh-CN.md)

## 状态与目标

基于 `main@6ef3eaa2` 的本地实现，正在验证。Managed Agent Server、Hosted Harness、模型调用、审批与日志仍放在中央服务，Qwen 执行 worker 放在 E2B Cloud，通过 Volumes 保存文件。本文不代表 Cloud 部署或生产验收完成。

本实现面向具有现有持久 Volume 和显式登记 Workspace 的 E2B Cloud。其他 backend 兼容 Sandbox API，并不代表其存储、worker 或公共 Hosted 行为已经通过验收。

## 现状与缺口

已有 `external-scratch`、`external-workspace` 提供带鉴权的创建、不可变放置身份、观察和 worker 证明。后者关联登记后的 EXTERNAL 存储，但明确禁用 Hosted 工具和 Session 关闭。仅登记存储不会创建 Workspace 或访问授权。

这两个 profile 保留原意。新增 profile 把登记的远程存储接入已有 Hosted 工具协议，并支持可验证退休：

| Provisioner                | 工具                                         | 关闭                                            |
| -------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `external-scratch`         | 原有私有 scratch 契约                        | 不新增关闭能力                                  |
| `external-workspace`       | 原有存储创建前置能力                         | 不新增关闭能力                                  |
| `external-workspace-files` | Read/Write/Edit 与已有 managed 公网 WebFetch | 验证 worker 排空与原 sandbox 退休               |
| `external-workspace-tools` | files profile 加前台 Shell 和目录受限的 Glob | 同样的退休流程，并要求 Shell publication 已提交 |

已有 Hosted files profile 实际发送 raw Tool v2 和 raw file-history 的 bind/prepare/snapshot；prepared provider 是另一条消费者。两条链路都需要验证，prepared provider 单测不能证明公开 Hosted 路径已经可用。

## 职责与架构

| 组件                  | 职责                                                               |
| --------------------- | ------------------------------------------------------------------ |
| Managed Agent Server  | 租户/操作者鉴权、Workspace 授权、Session 生命周期与持久公共事件    |
| Hosted Harness        | Agent 循环、模型调用、审批决定和日志提交                           |
| Runtime Broker        | Runtime 身份、原绑定代次、租约、存储占用、结果 ACK 和停止验证      |
| E2B adapter           | E2B 凭据、持久创建/退休日志、sandbox 创建、Volume 验证和受保护入口 |
| Qwen worker           | Context/挂载检查、工具执行、文件历史、进程账本和持久排空证据       |
| 中央 publication 服务 | Shell 片段、seal、manifest 和 sandbox 退休后仍保留的产物           |

独立 adapter 位于 `integrations/e2b-runtime-provider/`，SDK 和 API key 不进入 Core 或 Harness。Broker 仍使用 Qwen worker 协议，不用 envd 命令代替。受保护的通配域名把每个 worker 已声明的接口转发至 43190/43191，并注入 E2B 流量凭据，保留 Broker 的 origin-only URL 契约。

## 持久存储与准入

操作员将稳定 E2B Volume ID 登记为 physical key。adapter 配置将一个 Volume 绑定到唯一 provider、租户别名和 revision；名称及 sandbox ID 均不能充当存储身份。由于 SDK 按 Volume 名称创建挂载，adapter 会先通过 Volume-ID API 写入新挑战值，再从 sandbox 挂载读取，验证成功后才安装 boot 身份。

已有仅限回环监听器的操作员登记 API 不变。新增 `workspaces:publish-external` 操作员接口选择已登记的 provider/alias/revision，在同一事务中创建 ACTIVE Workspace 和对应 actor 的 OWNER 授权，并保存幂等回执。公共客户端继续通过已有 Workspace 选择和 Session API 使用根目录 cwd `.`。

Session 准入和 Runtime 解析读取登记信息，不检查 Broker 主机文件系统。物理执行占用必须找到原 EXTERNAL owner，并匹配租户、storage、physical key、mount root 和登记 revision，不会伪造 LOCAL owner。占用、持有验证、带代次约束的释放和排空检查使用同一个 key；不同 Runtime Session 的外部写入串行。

原 worker 在占用存储前重新证明挂载；Context 安装结果不确定时保留占用。登记/owner 冲突、外租户、缺失证据和旧代次均拒绝执行。provider 的 RUNNING 必须带匹配的存储连续性证据。

## Worker 与 Harness profile

新增 boot 显式携带 `externalFiles: external-files/1`；tools 模式再携带 `externalShell: true`。无标记的旧 boot 保持原行为。prepared provider 仅提供 Read/Write/Edit，在准备、确认、预检和执行前重新检查 Workspace 规范路径边界，并拒绝可更换已检查路径的输入替换。

raw worker 工具集与已有 Hosted profile 对齐：files 包含 managed 公网 WebFetch；tools 增加前台 Shell 和限制在 Session 目录内的 Glob。WebFetch 从 E2B 发出请求，复用 Core 的公网策略，不增加模型调用。

中央 connector 在外部 Session 创建、加载和恢复时传递并持久化 `foregroundOnly` 与 `fileRewindEnabled=false`，避免展示不支持的后台/编排工具，并在写入 pending undo 之前拒绝 rewind。原有 SSH rewind 行为保留。MCP、Hooks、原生扩展、子 Workspace、PTY、Monitor、后台 Shell、Context 修改和挂载移交均不开放。EXTERNAL 的 Workspace 文件浏览/query/read 仍不支持。

## 前台 Shell 输出发布

tools 模式复用已有 `/v3/publications:install` 和 `RemoteShellResultPublisher`。worker 只获得选定 execution 的 publication 授权，向中央 HTTPS publication 服务上传有上限的片段、seal 和 manifest，不获得 Session Store writer token 或模型凭据。

因此无需再实现一套 begin/read 输出消费者。已有 external begin/read 协议保留给原私有调用方，不能用来证明新增 tools profile 已完成退休。tools 模式要求中央 publication 服务和中央 Artifact 读取。退休同时检查 execution 的 committed ACK 和进程账本，只有 worker 返回 settled 不够。

## 持久生命周期与退休

adapter 在首次创建前持久化创建意图、请求摘要、不可变 boot 和 E2B 幂等 key。Cloud 幂等能力取决于账号，故禁用 SDK 创建重试；并发重复请求与重启复用同一日志，同一请求 ID 的不同内容产生冲突。

日志绑定 provider ID 和原 API key 的哈希。更换 key 会被拒绝，包括可能让原资源查询返回 404 的另一 E2B 团队的 key。自动轮换凭据不在本次范围内。

若创建回包丢失且流量凭据未保存，则保持 UNKNOWN。只读元数据查询不会授权第二个 sandbox、重新启动 worker 或调用可能恢复暂停 VM 的 `Sandbox.connect`。启动不确定也保留原意图。这些情况需要操作员排查，不宣称自动恢复可用性。

关闭按以下顺序完成：

1. Broker 排空原 Runtime Session，并重放持久 raw 结果 ACK。worker 关闭准入，要求 prepared Session 已释放、raw 调用已结束并得到确认、文件历史已排空、无活动扩展/后台工作且进程账本干净；清理失败持续阻止退休。
2. worker 持久发布 files/tools 排空字节。Broker 校验引用种类/schema/长度/hash 及完整租户、Workspace、storage revision、runtime、lease 和 provision 身份。
3. 带鉴权的 provider `retire` 在停止原不可变 sandbox ID 前，保存完整原始证明和 binding/generation 退休 key；通过 Cloud API 确认 sandbox 消失，保留 Volume。
4. provider 持久保存并重放原证明和物理停止回执。kill 或 SQL 回包丢失后，即使 worker 已消失，仍可通过只读确认恢复；若 sandbox 仍存在，RETIRING 返回已保存证明供 Broker 验证，再停止同一个资源，无需联系 worker；并发确认保留唯一回执。
5. Broker 重新验证该证明，再保存原代次的 drain receipt 并释放存储占用。

旧 release 仍为 no-op。没有先前合格退休意图的 TTL 到期或 GONE 不算正常关闭。暂停、恢复和 fork 不授权复用 Qwen 租约或复制 worker 身份。

## 涉及代码

| 区域                                | 改动                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| 独立 E2B 集成                       | SDK client、私有 SQLite 日志、网关、模板构建与操作说明          |
| Java 登记/持久层                    | 操作员发布、Session 准入和精确 EXTERNAL owner 占用              |
| Java resolver/transport/provisioner | 登记信息解析 scope、挂载证明、工具限制、持久 ACK 和物理退休验证 |
| Java Hosted connector 与 SDK        | 所有 attachment 副本中的前台 profile 和不可变 rewind 限制       |
| CLI worker/provider/executor        | 显式 profile、路径检查、严格排空和中央 Shell 输出发布           |
| Hosted Harness                      | undo 准入前持久化并检查 rewind 限制                             |

## 验证与验收

验证分层进行：定向 worker/adapter 测试；prepared/raw 文件与 Shell publication/ACK/drain 的真实 worker HTTP 测试；选定 Java 测试；选定真实 MySQL 用例；最后验证公共 Hosted 和真实 Cloud 路径。

本地夹具与 worker HTTP 证据覆盖持久请求重放、受限文件执行、中央 Shell 输出发布、committed ACK 和持久排空证明。验收仍需覆盖受影响的 Java/SDK 契约、真实 MySQL 事务与恢复、公共 Hosted 进程链路、匹配的 Linux 镜像、真实 E2B Volume 身份/挂载验证，以及 Cloud 丢失/退休场景。本地 macOS 或注入 Cloud client 的结果不能代替这些检查。

## AgentSandbox 兼容性核验

本 provider 面向 E2B Cloud 及其 Volume-ID API。阿里云[兼容清单](https://help.aliyun.com/zh/agent-sandbox/e2b-sdk-compatible-api-list)支持 Sandbox 和模板操作，但明确将 E2B Volume API 列为不兼容。仅修改 `E2B_API_URL`、`E2B_DOMAIN` 不能适配这里使用的 `Volume.connect` 和 Volume-ID 文件挑战。

AgentSandbox 的 [AgenticFS Volume](https://help.aliyun.com/zh/agent-sandbox/create-an-agenticfs-volume) 是已有 Access Point 的原生控制面记录。[挂载接口](https://help.aliyun.com/zh/agent-sandbox/mount-agenticfs-volume-1)使用同一 Team 下的 Volume 名称、挂载角色和完整且网络可达的 VPC 配置。后续 backend 必须保留不可变物理存储身份和连续性证明；一次 sandbox 文件读写成功或可变挂载名称都不能单独作为该证明。原生存储管理、兼容 worker 镜像和 AgentSandbox 端到端验收不在本实现范围内。

## 待提供的部署输入

- 已开通 Volumes 的 E2B Cloud API 凭据，以及供 Workspace 登记的现有 Volume ID。
- 匹配的 Linux worker image/template 和受保护的 worker 通配域名入口。
- tools 模式所需、worker 可访问的中央 HTTPS publication 服务及 Artifact 配置。
- 持久且私有的 adapter 状态与凭据，以及生产验收前所需的 Java、MySQL、公共 Hosted、CI 和真实 Cloud 创建/挂载/重启/丢失/关闭检查。
