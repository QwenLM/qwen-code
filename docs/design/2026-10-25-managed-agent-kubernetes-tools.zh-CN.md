# Managed Agent Kubernetes Workspace 工具与 WebShell

[English](2026-10-25-managed-agent-kubernetes-tools.md) | [简体中文](2026-10-25-managed-agent-kubernetes-tools.zh-CN.md)

## 问题与现状

[基础 Chart](2026-10-24-managed-agent-kubernetes.zh-CN.md) 部署的是纯文本
Managed Session。文件和 Shell 需要注册过的物理 Workspace 与 Runtime owner。
浏览器还需要认证网关：Java API 使用签名请求，不能把签名密钥交给浏览器代码。

K2 resident CSI 当前拒绝 Shell，kind 的 hostpath 卷也不满足其阿里云 CSI 磁盘身份
和 RWOP 契约。本次增加显式启用的可信单节点 LOCAL Runtime 和独立 WebShell
网关，不修改 K2 的准入或恢复契约。

## 拟议变更

默认保留纯文本部署。启用 LOCAL 模式必须指定固定可信节点、Workspace PVC 和
Runtime state PVC。服务端镜像组合 JRE 21、Node 22、同 revision 的 bundled CLI
及 Linux 文件系统工具。只读挂入所选节点的真实 machine identity，禁止制造
machine ID 来绕过准入。复用 Workspace creation API 准备目录、注册物理存储，
并授予固定调用者 OWNER 权限。

两种模式的 legacy cwd `/workspace` 都使用其规范路径 SHA-256 十六进制摘要的前
16 位作为 Workspace ID，满足 Runtime Broker 准入，并在启用工具时保持该身份稳定。

Workspace creation root、legacy cwd、私有 Runtime state 和 Runtime home 必须
彼此分离。Runtime 记录保持精确的 owner-private 权限；state 放在卷内私有子目录，
不直接使用 PVC 根目录。开启 durable LOCAL Session isolation、verified recovery、
文件和默认审批的前台 Shell。关闭 publication 和 child agents。本次不实现后台
Shell、Monitor、command Hooks 或 cgroup 委派。

新增 `qwen serve --managed-web-config <file>`，进入独立网关 runner。配置仅包含
`apiUrl`、`tenantId`、`actorId`、`signingKeyFile`。上游必须是 loopback HTTP
origin，签名密钥按精确 UTF-8 字节读取，并要求独立的浏览器 bearer token。复用
当前签名代理、静态资源与 Host/Origin/认证中间件，仅暴露 Managed 代理、artifact
内容、boot 数据、认证探针及静态 UI；普通 daemon 路由、ACP 和 WebSocket 入口
全部不可用。网关不初始化 daemon Runtime，也不放宽现有本地 runner。

网关使用已有的 Managed-only `ManagedAgentWebShell` UI，不创建 daemon
Workspace/Session context。同 Pod 的 web 容器仅获得浏览器 token 和签名密钥。
网关通过 loopback 访问 Java，以独立 ClusterIP Service 发布浏览器端口。tenant
和 actor 是固定部署参数，浏览器 header 不可选择身份。这是单一可信操作者身份，
不承担多用户身份提供方职责。本地通过 HTTP port-forward 进入；TLS ingress 需要
使用已有的显式 allowed origin。

## 持久化与生命周期

持久化 SQL、密钥、Workspace 数据及私有 Runtime 记录。LOCAL worker 属于原始
主机和 PID/time namespace。替换后的 Pod 不能仅凭节点或 PVC 相同就接管旧的
存活 worker。计划 rollout 前必须关闭全部工具 Session，确认物理 holder 已清空。
替换后通过新 Session 复用保留的 Workspace。中断 effect 保持原有不确定性，禁止
重放或伪造关闭结果。这不提供 HA 或跨 Pod 的存活 Session 恢复。

可选组件的自动凭据彼此独立，并在升级时保留。首次启用可选组件时允许补充缺失
键，但禁止旋转已有数据库、签名、Store 和 Harness 密钥。外部 Secret 必须提供
全部已启用组件需要的键。provider key 不进入浏览器配置、ConfigMap、命令参数
或日志。

## 涉及组件

更新 `deploy/kubernetes` 下的 Helm Chart、部署镜像、中英文说明和 smoke 客户端。
增加网关命令、runner、定向 CLI 测试以及 Managed-only 浏览器启动分支和定向 UI
测试。复用现有 Java Workspace creation 与 Runtime provisioning API，不增加
数据库 schema 或公共 API 变更。

## 验证与验收

1. 构建匹配的 Linux arm64 镜像，在隔离 kind 中安装默认 Chart。验证数据库迁移、
   未签名拒绝、受控模型完成 Turn、历史、空闲重启、保留密钥的升级和数据库/Secret
   保留行为，并记录镜像和集群 revision。
2. 开启 LOCAL 模式，通过签名 API 创建 Workspace，检查物理注册和 OWNER grant，
   由模型写入、读取、编辑文件。独立核对 PVC 精确字节，不能仅依赖模型回复。
3. 请求前台 Shell 测试命令，观察审批、批准并验证结果及只执行一次；验证拒绝、
   取消和重复请求处理。没有委派 cgroup 时，后台任务不能启动。
4. 关闭工具 Session，核验 worker、receipt、journal 和 holder；替换 Pod 后用新
   Session 读取原文件。worker 故障不能触发重放或虚构清理成功。
5. 拒绝缺失或相同的浏览器/签名凭据。有效浏览器 token 访问普通 daemon 的文件、
   Workspace/trust、Session/Shell、settings、MCP、ACP 和 WebSocket 路由也必须
   拒绝，包括带 HTML Accept 的请求。浏览器应能认证、创建/选择 Workspace、修改
   项目文件、批准测试命令，并仅通过 Managed API 展示结果。

受控模型的 kind 验证仅证明本地 Linux/容器行为，不证明真实 provider、ACK/CSI、
多节点隔离、任意执行中恢复或生产验收。必需 CI 检查是独立门槛。

## 待定问题

没有需要用户决策的实现问题。合格的 CSI 执行路径、跨 Pod 替换的存活 worker 恢复、
公共镜像和多用户 SSO 留作后续工作。
