# 共享 Hosted Harness 池

[English](README.md)

本部署包通过显式开启的方式，将 Hosted Harness 运行成可水平扩展的私有池。Java 继续负责租户和用户准入、持久化 placement 与订阅。Session RPC 绑定选定的 EndpointSlice Pod 地址和确切 instance/boot；Service 用作发现锚点。现有本地进程部署不设置池环境变量，也不启用 Java 池配置。

所有权、隔离栅栏与验收矩阵见[设计文档](../../../../docs/design/2026-10-21-managed-harness-kubernetes.zh-CN.md)。这些文件是部署模板，新增这些文件并不意味着已经验证集群、证书签发、指标适配器或生产容量。

## 前提与输入

- Kubernetes 1.33+，支持原生 sidecar 并执行 NetworkPolicy；已有 Java 控制面、持久化 Session Store 和 Runtime Broker。Server/Broker 使用匹配构建及包含 placement 列的全新单 V1 catalog；旧开发库需要独立的全新数据库和状态目录，不提供升级。Harness Pod 不持有 Kubernetes API token，也不挂载租户工作目录。
- 构建并发布不可变 Harness 镜像，在 `harness-pool.yaml` 中将两个镜像都固定到已验证的 digest。示例 Envoy 版本为 1.39.4；上线前用实际选定镜像验证配置。
- 填写 `settings.example.yaml`：使用 Java 同样要求的 capability digest、HTTPS Broker URL 和批准的模型配置。设置由运维持有并共享；租户文件不得成为运维 HOME、设置文件或工作目录。
- 从文件创建 `qwen-harness-secrets` Secret，键名为 `harness-token`、`broker-token`、`model-api-key` 和 `outbound-ca.crt`。前三个文件分别只包含对应凭据。CA 文件信任真实 HTTPS Store、Broker、模型网关。启动器读取文件并通过子进程环境传递凭据；Deployment 参数不包含秘密。
- 创建 `qwen-harness-tls` Secret，提供 `tls.crt`、`tls.key` 和 `client-ca.crt`。Envoy 同时验证 Java 客户端 CA 和精确 URI SAN `spiffe://qwen.internal/managed-agent-server`；将白名单改成实际批准的身份。Java 必须提供该客户端身份，并信任 Harness 服务端 CA。
- **端点 TLS 身份是部署前提：** Java 连接具体 Pod IP，并保留正常 HTTPS 主机名验证。每个选中 Pod IP 都必须出现在该端点证书的 IP SAN 中。请提供每个 Pod 的证书投影/签发机制，或由运维维护覆盖所有实际端点 IP 及替换 IP 的共享证书。只有 Service DNS 的证书不能验证这些连接。模板的 Secret 挂载只是该机制的输入，不负责签发证书。不得关闭主机名验证来部署。
- 将 `discovery-rbac.yaml` 绑定到真实 Java service account 和 namespace。发现逻辑只在配置的 namespace 读取指定 Service 并列出 EndpointSlice，核验精确 Service UID、命名端口、Pod UID 和就绪状态。Harness 进程不持有集群发现权限。
- 入口 NetworkPolicy 假设 Java Pod 与 Harness 位于同一 namespace。如果 Java 位于独立 namespace，在同一个 ingress peer 中为 `podSelector` 加上获准的 `namespaceSelector`。出口目标和端口也须适配真实 HTTPS 网关。如果 Service 将 `443` 映射到目标端口 `8443`，CNI 可能按后端端口执行策略；仅为批准的 Store/Broker peer 放行该目标端口，并从实际 Harness Pod 验证连通性。本次实测的 Terway 部署需要这条显式后端端口规则。

## 构建与配置

在干净的源码 checkout 中从仓库根目录构建。Dockerfile 专用 ignore 文件排除本地设置、凭据、日志与构建产物：

```sh
docker build -f packages/managed-agent-server/distribution/kubernetes/Dockerfile -t YOUR_REGISTRY/qwen-harness:YOUR_VERSION .
```

通过部署系统发布镜像，用其不可变引用替换 `qwen-harness:replace-with-built-digest`。根据实测工作负载和实际端口调整资源及 HTTPS 出站目标；示例 CPU/内存 requests、limits、堆预算和 backlog 阈值是验收起点，不是实测生产容量。

从审核过的配置生成 Envoy ConfigMap，再通过正常部署流程在 Harness namespace 应用填好的设置、RBAC 与池清单：

每份清单只包含一个资源。应用 `harness-pool.yaml` 中的 Deployment 时，同时应用 `harness-service.yaml`、`harness-pdb.yaml` 和 `harness-network-policy.yaml`。Java 发现同时需要 `discovery-rbac.yaml` 与 `discovery-role-binding.yaml`。

```sh
kubectl create configmap qwen-harness-envoy --from-file=envoy.yaml=packages/managed-agent-server/distribution/kubernetes/envoy.yaml --dry-run=client -o yaml
```

该命令生成待审核 ConfigMap；模板有意保留必须填写的镜像、模型和身份输入。秘密应来自运维的秘密管理系统。

在已有 Java 服务中配置 `qwen.managed-agent.harness.enabled=true`、现有 Harness token/capability digest，以及以下池属性：

```yaml
qwen:
  managed-agent:
    harness:
      pool:
        enabled: true
        discovery: kubernetes
        namespace: YOUR_HARNESS_NAMESPACE
        service-name: qwen-harness
        service-uid: YOUR_ACTUAL_SERVICE_UID
        port-name: https
        key-store-file: /etc/java-tls/client.p12
        key-store-password-file: /etc/java-tls/client-password
        trust-store-file: /etc/java-tls/trust.p12
        trust-store-password-file: /etc/java-tls/trust-password
```

Store URL 使用 HTTPS，由 Java 提供池 writer grant。池拒绝显式放宽明文 Store 的开关及私有 CSI 根。Tool Runtime 仍由 Broker 提供。镜像携带 Harness 与 CA 证书，不包含用户工作目录或本地工具安装。

## 生命周期与运维

Node 进程只监听 `127.0.0.1:4170`。Envoy 在 `8443` 提供 mTLS，拒绝所有 `Origin`，只开放批准的私有路由，将上游 Host 改写为 `127.0.0.1:4170`，保留 bearer、protocol/boot、client、operation 和 SSE 头。代理不安装缓冲/缓存过滤器，并关闭上游重试。60 秒流空闲窗口容纳现有 15 秒事件 keepalive。现有应用执行请求体大小限制。

Exec startup/readiness 探针认证并核验 instance/boot 和池能力。Readiness 要求 `ACCEPTING`；liveness 使用轻量 `/health`，不检查 SQL、模型、Runtime 依赖。代理监听器也必须就绪。这些探针不能证明 mTLS 互通，仍须单独验证 Java 对具体端点的握手。

`preStop` 通过 loopback 调用认证后的 instance drain，并保留该 boot 的 operation ID。原生 Envoy sidecar 持续运行至 Harness 停止。Drain 立即拒绝新 Session、新 prompt、自主 wake 和冷恢复执行；已有前台 Turn 可以继续完成。Harness 自己通过 Store 对符合条件的驻留 owner 执行 quiesce 和释放，因此 Java 不可用不妨碍该尝试。

首个优雅迁移边界是无活跃资源的 Session，以及能到达该边界的前台工作。尚未尝试的持久化 wake backlog 保留排队状态。Hooks、MCP、活跃 publisher/后台 shell、child/monitor 资源、清理欠账、中断工作和未知副作用都会保留 owner。失败的初始化保持未决，直到同一 Session 成功附着或该 boot 过期；普通 writer seal 不是释放证明。释放在屏障下撤销空闲的活跃 activation，原子获取 Store 针对精确 placement、head 和 proof 的回执，再关闭流及本地计时器。它不 detach、不取消已接收输入、不发出 SessionEnd。只有 owner、初始化、变更请求、资源及 publication 全部为零时才是 `DRAINED`。

Drain helper 在 Pod 的 120 秒终止宽限内最多等待 90 秒。超时、Store 调用失败或不支持的工作均不构成释放证明：Kubernetes 最终进入崩溃路径，Java 必须等 writer/placement lease 隔离后才可在另一 boot 恢复。SIGTERM、Pod 消失、readiness 丢失或传输中丢失的 HTTP 释放响应都不是持久化释放证明。活跃流使用新事件 epoch 和已提交 cursor 在新 owner 重连。

滚动更新设置零不可用 Pod、一个额外 Pod，并使用至少一个可用 Pod 的 PDB。PDB 不会选择空闲 victim，也不保证优雅释放。启用超出首个边界的工作负载前，必须验证设计中的任意删除、驱逐和强制终止故障矩阵。

## 指标与可选扩容

认证后的 `GET /internal/hosted-harness/v1/metrics` 提供 Harness 自有 attached、active、opening、input、resource、publication、mutation 计数，以及 RSS、heap、event-loop utilization。端点要求与 instance 管理相同的 bearer 和精确 protocol/boot 头，不包含 tenant/session 标签。ACP 指标或缺失指标都不能表示 Hosted 空闲容量。`pendingInputs` 包含持久化等待，不能直接作为可运行 backlog 指标。

只有接入外部指标适配器 `qwen_harness_runnable_backlog{pool=qwen-harness}` 后才应用 `hpa.yaml`；指标必须依据 Java 真实可运行准入与 Hosted 计数构建。排除审批等待、未知结果及被外部配额阻塞的工作，缺失/未知样本保留为不可用指标。适配器是运维集成，本目录不提供实现。先实测每 Pod 目标再使用示例值 `4`。交由 HPA 管理副本时，从后续发布清单删除 Deployment 的声明式 `replicas` 字段。HPA 在 2..10 副本内每分钟最多新增一个 Pod，并配置 `scaleDown.selectPolicy: Disabled`。自动缩容需要独立的资源/故障验收，当前保持关闭；不增加其他副本控制器。

## 部署验收

上线前验证所选 Envoy 镜像配置、Kubernetes 服务端 schema 和 Secret 挂载。在隔离验收 namespace 证明两个 instance/boot 身份、Java 对每个具体端点的真实 mTLS、错误 CA/SAN/bearer/Origin/boot 拒绝、两个 Pod 间 Session placement 亲和，以及事件 cursor/epoch 的流式衔接。覆盖空闲释放、前台 Turn 加排队 wake、释放 ACK 丢失及重试、Store/Java 不可用、未知工具副作用、忙碌任意 victim 和有界崩溃恢复路径。单独验证本地单进程回归。监听器健康或 YAML 可解析都不能证明这些结果。

参考：[Kubernetes 原生 sidecar](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)、[Envoy TLS 验证](https://www.envoyproxy.io/docs/envoy/v1.39.4/api-v3/extensions/transport_sockets/tls/v3/common.proto)、[HPA 行为](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)。

首版 pool 不开放 MCP 管理 API 或公开子代理委派；现有单实例部署保留 main 中的这些能力。历史 placement V17 的 ACK 验收及后续 V18 的 CI 结果均早于当前单 V1 衔接；仍需全新基线、Java/MySQL/Hosted 及跨语言 CI 验收。需要历史访问时保留原产物及其独立状态，不得通过修复 Flyway 历史复用旧库。
