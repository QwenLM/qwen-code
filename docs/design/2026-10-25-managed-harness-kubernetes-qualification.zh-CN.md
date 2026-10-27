# 共享 Harness Kubernetes 验收工具

[English](2026-10-25-managed-harness-kubernetes-qualification.md) | [简体中文](2026-10-25-managed-harness-kubernetes-qualification.zh-CN.md)

## 问题与现状

共享 Harness 池已经实现，但部署模板仍需人工修改镜像、身份、配置和调度条件。现有 Java 镜像只有 Server JAR，缺少 local-process Runtime worker 所需的 Node 和完整 CLI。现有进程故障测试会自行启动 Java 和数据库，不能验收外部 Kubernetes 池。这些测试通过不代表两 Pod 上的公开多用户授权、物理工具效果或事件重连通过。

首个目标没有业务节点。现有两台系统节点受 `CriticalAddonsOnly` 保留策略约束；提交不受限制的 Pending Pod 可能触发付费扩容。本实现必须在不授予该例外、不购买基础设施的条件下也可使用。

## 改动方案

| 组件         | 改动                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 镜像构建器   | 从同一不可变 Git archive 构建现有 Harness 和 Java 镜像，再派生携带同一完整 CLI 的 Java 加 worker 验收镜像。只有明确指定时才发布，已发布仓库 digest 与本地 image ID 分别记录。                                                        |
| 部署生成器   | 从不含秘密的配置填充现有 Harness 模板。生成两个副本、不可变镜像、namespace 归属，以及只匹配两个明确命名的既有业务节点的调度条件。使用 topology spread，使第三个滚动更新 Pod 仍能调度到这两个节点。不生成 HPA 或系统节点 toleration。 |
| 公开验收驱动 | 复用生产签名函数。为两个租户、每租户两个 actor 创建独立 Workspace 和 Session；通过公开接口检查重放、拒绝访问、文件效果、审批决定、取消和真实 SSE 恢复。限制请求、事件帧和等待。                                                      |
| 只读预检     | 将已有验收检查纳入版本控制。核对节点资格、rollout/controller 身份、镜像引用、探针和 EndpointSlice 目标后才能确认部署就绪。部署就绪与执行验收分别报告。                                                                               |

## 决策与范围

Java 及其内嵌 Broker 仍在 Java 容器中承载 local-process worker；两个 Harness Pod 不挂载租户 Workspace。派生镜像提供 Node、完整 CLI 包和普通命令依赖，并保持三个状态与 Workspace 目录互不重叠。不启用特权容器、hostPath、宿主机委托 cgroup 或可信重启恢复。后台 Shell、Monitor、Hook profile 仍需单独的 cgroup 验收。

生成与预检都不 apply 资源或修改节点池。部署前必须核验节点容量、由运维提供 Secret、真实 Pod IP SAN 证书、Java 客户端身份、受信任的 HTTPS Store/Broker/模型端点，以及全新单 V1 数据库。这些输入保持显式要求，生成的 YAML 不能替代它们。部署前需审核已发布镜像 digest 和源码来源。

生成包包含一个本轮专用的集群级 PriorityClass，优先级为 -1000，设置 `globalDefault: false` 与 `preemptionPolicy: Never`。Pod 引用它，使优先级准入获得匹配策略。应用需要集群权限；清理时先删除本轮 Pod，再移除此 class。必需的节点 affinity 使用两个 OR 条件，各自只含一个 `metadata.name` 值。预检核对精确 class、归属及两个单值条件，允许条件倒序，但拒绝重复、额外约束或其他节点。

公开驱动使用可丢弃 namespace 和专用 actor、Agent 定义、Workspace。不伪造 Session SQL 行、不分配 grant、不启用新 profile、不绕过鉴权，也不使用新幂等键自动重试失败写入。文件内容来自 Workspace 文件 API，不采用模型文本。Shell 权限决定必须属于实际提供的选项，并保留原始 revision。SSE ID 是 Session 内的数字 offset；隔离通过已认证 Session 和载荷归属检查。

驱动分别记录各组件结果和未完成门禁。不根据 Session 数量推断两 Pod 覆盖，不根据进程退出推断物理存储释放，不根据 readiness 推断 owner 接管安全。实际 placement/boot/writer/release 回执，以及忙碌 Pod、崩溃、未知效果和丢 ACK 矩阵仍属于运维验收输入。容量与 HPA 最后执行，自动缩容保持关闭。

前台 Shell 使用现有 Tool v3 发布协议、真实私有 OSS 后端及私有 HTTPS 发布路由。旧捕获回调绑定 Harness loopback，不能作为跨 Pod 传输。验收明确提供容量和截止时间、仅交给 Java 的临时 OSS 环境凭据、worker CA 信任及实际网络目标；不引入新发布协议，也不据此认定后台、Monitor、Hook 生命周期通过。

## 验证与验收

针对真实模板测试生成器，包括拒绝未固定 digest、拒绝系统节点、显式节点 affinity 和滚动更新 spread。通过签名 HTTP 协议 fixture 测试公开驱动，拆分 SSE 分片并检测重放或 scope 错误；注入错误 Session ID、重复终态和缺失物理效果时必须失败。这些 fixture 只验证工具本身，不是 Kubernetes 验收。

针对改动的 JavaScript 使用方完成仓库 build、typecheck 和相关脚本测试。不需要修改 Java 源码。复用仍适用的 Java CI 证据，本地 Java 共享预算继续视为耗尽。容器构建和真实集群场景需要远端 Docker builder 与已授权、可调度的目标。未执行的容器、真实执行和故障检查需明确保留。

## 待提供输入

真实部署前还需可用业务节点目标或明确的临时节点费用授权、远端 Docker 访问、仓库写权限、TLS 签发、私有服务端点、新数据库凭据及已启用的 Agent ID。工具不得附带购买资源或放宽系统节点策略。
