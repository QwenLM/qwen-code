# Managed Agent Helm Harness 池

[English](2026-11-26-managed-agent-helm-harness-pool.md) | [简体中文](2026-11-26-managed-agent-helm-harness-pool.zh-CN.md)

## 当前部署

[Managed Agent Helm chart](../../deploy/kubernetes/README.zh-CN.md) 在一个应用 Pod 中运行 Java API、一个 Hosted Harness 和可选的 WebShell。私有 Session Store 与可选的嵌入式 Runtime Broker 监听 Pod 回环地址。Java 当前只访问一个 Harness。服务端已支持静态池，每个成员有稳定的实例 ID 和独立的源地址。

## 设计

在应用 Pod 中启用静态池。原有成员 `harness` 监听 `127.0.0.1:4170`，第二个成员 `harness-b` 监听 `127.0.0.1:4172`。每个成员公布自己的实例 ID，使用独立的可写 home 和临时卷。两者使用相同的镜像、能力摘要、bearer token、模型设置和可选的 Broker 连接。WebShell 监听 `4171` 端口。

Deployment 模板从同一份固定列表生成 Java 池成员地址、Harness 启动参数、探针和成员卷。Spring 从 `SPRING_APPLICATION_JSON` 读取成员列表。启用 SQL wake dispatch，让 Session Store 公告干净挂起时的 placement 释放能力。Java 按 MySQL 中记录的 owner 路由。成功获取 writer 的成员获得独立租约，Store 有释放或到期证据时，另一成员可以接管。

## 部署和升级

两个 Harness 进程共享应用 Pod 的网络命名空间，私有流量走回环地址。现有 Session Store 和嵌入式 LOCAL Broker 因此可以服务两个成员。Pod 为两个 Harness 容器申请资源。Kubernetes 按整个 Pod 计算 Service 就绪状态，单个成员不健康时，Service 可能临时摘除 API 端点。整 Pod 故障依靠 Pod 重建。要把 Harness 放在可独立调度的 Pod 中，需要单独设计寻址、mTLS 以及私有 Store 和 Broker 的访问。

升级前执行 chart 现有的 drain 和备份流程。会话进入池后，其 writer 凭据绑定成员与 epoch。若回退到使用非池连接器的版本，应同时恢复配套的升级前数据库与应用备份。

## 验证

- 渲染默认 chart，以及同时启用 Workspace 工具和 WebShell 的配置。校验 Java 池成员列表与两个 Harness 的身份和回环端口完全一致，探针指向正确成员，Service 未暴露私有端口，启用嵌入式 Broker 时第二个 Harness 也能访问它。
- 用渲染出的池设置运行真实 Managed Agent、两个 Hosted Harness 进程、临时 MySQL 和模拟模型。验证两个成员都能处理会话，且已释放的会话可在另一成员继续。
- 目标 Kubernetes 集群的部署验收需要构建镜像、安装、执行签名 smoke，并按启用的功能验证重启。
