# Managed Agent Kubernetes 启动部署

[English](2026-10-24-managed-agent-kubernetes.md) | [简体中文](2026-10-24-managed-agent-kubernetes.zh-CN.md)

## 问题与现状

Java 控制面和 Qwen CLI 已有容器构建定义，但缺少完整的 Kubernetes 安装方案。
参考分发产物面向单台可信 Linux 主机。已有 K2 常驻 Workspace 配置描述已注册的
CSI 执行，而不负责安装应用。

## 部署方案

在 `deploy/kubernetes` 增加无外部依赖的 Helm chart。从同一 revision 构建并推送
Java 和 CLI 镜像后，一条 `helm upgrade --install` 安装以下资源：

| 资源                                      | 职责                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| 单副本 Deployment                         | 在同一 Pod 运行 Java 控制面和 Hosted Harness                 |
| ClusterIP Service                         | 在 8080 端口提供签名认证的 Java 公开 API                     |
| MySQL 8.4 StatefulSet 和 headless Service | 使用持久卷的应用数据库                                       |
| ConfigMap                                 | 显式的 OpenAI 兼容模型设置和 MySQL 初始化授权                |
| Secret                                    | 稳定的签名、Session Store、Harness、数据库凭据和模型 API key |

Harness 必须绑定 loopback，健康请求也要求 bearer 认证。同 Pod 部署保留该契约。
Java 独立内部监听在 loopback 8081 端口提供 Session Store。两个私有端口都不通过
Service 暴露。公开监听使用签名认证，应用与 Session Store 使用不同密钥。
应用不需要访问 Kubernetes API，也不需要 service-account token。

首次部署支持持久化的纯文本 Managed Session。Runtime Broker、Workspace files
和 Shell 保持关闭，避免将容器本地目录视为已注册的物理 Workspace，或假设 worker
能够在 Pod 替换后存活。不修改 K2 准入与恢复机制。

## 配置与凭据

要求显式提供 server、Harness 镜像，以及模型 ID 和 base URL。操作者从同一 revision
构建两个镜像，不假设存在尚未发布的镜像地址。通过 `QWEN_HOME/settings.json`
安装模型设置；凭据通过 Secret 环境变量传入 Harness，不进入命令参数或 ConfigMap。

首次安装由 chart 生成相互独立的随机凭据。后续安装和升级通过 Helm `lookup`
复用保留的 Secret。升级时缺少受管 Secret 必须失败，不能对已有数据库静默轮换密钥。
保留数据库 PVC 却缺少 Secret 时，重新安装也会拒绝。卸载时保留 Secret 和
StatefulSet 卷。操作者也可提供包含相同键的现有 Secret。
更新已有模型 API key 必须显式轮换 Secret 并重启 Pod；普通 Helm 升级不轮换它。

内置 MySQL 使用应用用户供 Java 连接，不使用 root。初始化授权包含 Flyway 启动所需的
`performance_schema.user_variables_by_thread` SELECT 权限。存储大小与 class、
镜像拉取凭据和容器资源是部署输入。不引入外部数据库抽象、Ingress 控制器、chart
依赖、自动 Workspace 注册或集群级 RBAC 安装。

## 启动、持久化与升级

应用固定单副本并使用 Recreate 策略。Java startup 与 liveness 检查应用存活状态；
readiness 额外检查数据库。Harness exec 探针通过 Node fetch 访问带认证的 loopback
健康接口。数据库 readiness 核验应用凭据和 Flyway 授权。数据库故障必须撤下 readiness，
不能使 Java liveness 失败。

MySQL 是 Session 和 journal 的持久化权威。Harness home、临时文件和纯文本工作目录
使用可写 emptyDir。应用容器以非 root 用户运行，根文件系统只读，不增加 capabilities。
MySQL 官方入口保留其既有初始化和权限处理方式。

升级前停止新准入、结算活动工作并备份数据库和凭据。保持 release 名、namespace、卷和
密钥稳定。数据库 migration 后不能自动 Helm rollback。升级失败需向前修复，或恢复
相匹配的数据库与应用备份。当前预发布版本可能原地更新 canonical V1 baseline；
不兼容的开发 catalog 需要新数据库，历史访问必须保留其匹配的应用版本。
空闲重启验证不等于任意在途恢复或 HA 验收。

## 影响文件

在 `deploy/kubernetes` 增加 chart、双语部署说明、渲染与契约测试及签名 API smoke
客户端。两个参考部署文档都添加新入口链接。应用代码、API、认证、数据库 schema 和
K2 runtime 行为保持不变。

## 验证与验收

1. Helm lint 与渲染必须生成有效对象，覆盖自定义 release、namespace、镜像拉取凭据
   和 storage class。
2. 缺少必要部署输入、升级时缺少凭据必须在修改资源前失败。使用已有 Secret 时不能再
   生成 Secret。凭据不得进入 ConfigMap 或命令参数。
3. 从渲染对象验证签名与 Store 密钥分离、Harness token/digest 引用一致、私有监听归属、
   应用非 root 运行、MySQL 授权与探针语义。
4. 条件允许时，用真实 Java/Harness 进程和受控模型验证签名 smoke 客户端：拒绝无签名
   请求、创建 Session、完成文本 Turn、读取历史并关闭。受控模型不等于真实 provider 验收。
5. 在可丢弃的真实集群安装并执行 smoke，保留空闲 Session，重建应用 Pod，验证历史和
   新 Turn。验证 Helm 升级保持凭据和数据库内容。分别记录真实集群、MySQL、镜像构建和
   provider 证据。

本地渲染不代表集群、CSI、ACK、生产或故障矩阵验收。环境缺失时，相应检查继续待完成。

## 开放问题

没有阻塞实现的决策。发布镜像、带认证的 WebShell 网关、外部数据库集成和经过资格验证的
K2 provisioning，可在本部署基线得到真实集群验证后分别跟进。
