# Hosted Kubernetes Tool Runtime

[English](2026-10-01-managed-kubernetes-runtime.md) | [简体中文](2026-10-01-managed-kubernetes-runtime.zh-CN.md)

状态：draft PR #13289 的完整 K1/CSI 增量整合，基于 upstream
`691a374d2a8f2def439d6aba52a592a7bbc06fb0`，2026-10-03；关联 #12380。
包含实验性 SDK/container scratch Runtime，以及私有 CSI reservation、原 Pod 身份、
封口、原结果结算、checkpoint 证据和持久 ACK 组件。公开 Hosted CSI 选择、完整物理
退役和卷交接仍未开放。早期本地及 ACK 开发集群结果，包括整合前八组持久 ACK 验证，
属于各自源快照，不能代替本次主线整合后验证。最终整合测试与审查进行中。

## 问题与现状

Harness 必须独立于工具环境准备开始模型推理。Kubernetes 负责部署现有工具
worker，不承接模型循环、模型凭据、Session 权威或工具执行账本。

已合入的 Broker 持久保存 provision seed 和 resource handle，先完成 attestation
再开放本进程 gate，并在结果不确定时查询原工具身份。`RuntimeProvisioner` 是部署
接缝。Spring 目前拒绝 `provisioner=kubernetes`。Workspace resolver 和公开文件
profile 准入要求 `local-process`，resolver 在 Java 主机验证目录。worker 从 stdin
读取封闭 boot envelope，只监听 loopback 随机端口。

参考提交 `34ea187c` 中的历史 Kubernetes adapter 可供设计参考，不代表当前实现。
其 request/release 接口与 main 不同。尤其当前 `release(request, lease)` 也会在
操作输掉 CAS 或 attestation 失败时调用；它不是删除同 generation Pod 的持久授权，
因为另一 Broker 可能已经接管该 Pod。

## 归属与拓扑

Java 负责准入、Workspace 授权、Broker SQL 记录和资源部署。TypeScript Harness
负责模型上下文、工具编排和 checkpoint。Session 独占 Runtime Pod 承担已准入的
工具副作用。Kubernetes 负责 Pod 调度和观测，不决定执行结算或重放。

初始拓扑为一个 Java 服务及其 Hosted Harness sidecar，加按需 Runtime Pod。
Broker 调用 Kubernetes API 和 worker 私有 HTTP 协议。Pod 启动期间模型继续推理。
无工具 Turn 不需要 Pod 或卷。Runtime Pod 不持模型凭据、不挂 Kubernetes
service-account token。Harness 不持 Kubernetes 管理凭据，不挂载或旁读 Workspace。

## 交付切片

| 切片 | 交付物                                                                                       | 开放边界                                                                        |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| K1   | SDK provisioner、有界 Kubernetes HTTP 客户端、显式容器 worker 入口、私有文件工具及原身份测试 | 可信开发环境、Session 独占临时 scratch；不开放 Spring 选择或公开 Workspace 能力 |
| K2   | 可信 CSI 身份映射、持久挂载前预留、worker 准入隔离、正常 drain 和卷交接                      | 存储/身份/结果门禁通过后开放已注册 Workspace 文件工具；不自动接管分区节点       |
| K3   | 目标集群故障套件、部署身份/网络/安全控制及发布文档                                           | 只开放完整验收矩阵通过的能力                                                    |

K1 拒绝 managed-context 请求，完全不挂 PVC。`emptyDir` 明确定义为可丢弃 scratch，
不是已注册或可恢复 Workspace。这样基础设施可以实际运行，不会把单主机 W0e/W1
保证错误套用到 CSI。它尚未完成用户最终的 Workspace Hosted 部署目标，仍需 K2/K3。

## K1 部署与 worker 契约

每个持久 provision seed 对应一个 `restartPolicy: Never` 的 bare Pod。Pod 和
immutable Secret 的确定性名称由 provision request ID 派生。重试观测原对象；
冲突不会生成第二个名字。固定镜像 digest、命令、集群域、namespace、scope、Session
isolation key 和 boot identity 参与身份检查。resource handle 保存集群/namespace、
Pod/Secret UID 和 placement digest；不在 handle 或 label 保存凭据。

`ensureResource` 先创建或观测 Secret，再创建或观测 Pod，验证身份并返回 handle。
传入 handle 时只观察：UID 缺失或变化不允许重建。创建冲突和创建应答丢失只通过
GET 原确定性名称并完整核验来解决。已存在 Secret 而 Pod 缺失属于不确定状态，
保持阻塞，不能猜测是否允许重建一个曾执行过工具的 Pod。

`provision(request, seed)` 只能使用当前进程中由 `ensureResource` 建立的 handle，
使用有界 readiness 轮询窗口及有界 API 调用，依据精确 Pod 观测生成 lease。`reconcile` 不写 Kubernetes
资源。API 不可用保持 UNKNOWN，Pod 未就绪保持 STARTING，身份变化、worker 终止
或缺失保持 CONFLICT。K1 不用 NOT_FOUND 在丢失执行账本后授权新 generation。
失败或未就绪观测撤销本地 lease 可用状态；endpoint 改变使旧 lease 失效。
UNKNOWN 确认错误保留可重试的 503 诊断；Broker 仍按既有默认策略关闭确认 gate，
失败确认后的自动重试/接管留待后续。
Pod readiness 仅表示传输就绪，Broker 仍需 attest、完整比较 boot identity 并提交 CAS。

每个 provisioner 最多保留 1024 个 seed，包括进行中或含糊的 placement。在 Kubernetes
写入之前预占 slot；满额时以可重试的 `runtime_kubernetes_capacity` 拒绝新 seed，既有
seed 仍可被观测。Broker 在创建前准入阶段检查容量，保留原 binding 的 PROVISIONING
状态并释放 operation claim 以便重试；进入 ensure 后的同名错误仍失败关闭。传入的
持久原 handle 始终优先于空 pending 本地条目。租约查询按完整不可变 lease 身份直接索引，并核对 endpoint，不遍历
seed map。`release` 不淘汰条目；UNKNOWN 撤销本地 endpoint 可用性，但保留所有权。
只有经过校验、针对该条目自身原资源的 reconciliation conflict 才移除 slot；其他
seed 的冲突不能淘汰活跃原 worker。`close` 清空两个本地索引，不删除 Kubernetes
资源；进程重启也不授权替换或退休原资源。

Pod IP 是观测 endpoint，不是身份。只接受可信 Kubernetes API 返回的 IPv4 字面量，
拒绝无效、loopback、未指定、link-local 和 multicast 地址。worker 固定使用 43190
端口（避开 Node fetch 的禁止端口列表）；K1 不支持纯 IPv6 集群。禁止自动重启容器，观测发现非零 restart count 即拒绝，防止清空账本后的容器
冒充原 incarnation。K1 仅在可信测试网络使用现有 bearer/lease HTTP 协议；生产
TLS/workload identity 属于 K3 门禁。

隐藏 worker 命令增加 `--container-boot <path>`，从 Secret 文件读取现有有界 boot-v1
JSON envelope，并显式监听 `0.0.0.0:43190`。普通 stdin 启动继续使用 loopback 和
现有 ready record。非 CSI 的 boot-v1 容器模式仅接受 Session isolation，拒绝 managed-context boot。私有 CSI boot-v3 增量则在监听前校验内嵌 workspace context 和原挂载。
容器 cwd 按 POSIX 词法校验，不依赖 Broker 主机操作系统。
不扩展私有协议 schema，不打印 boot 内容或 bearer。镜像须提供 Node.js 22+、已构建
CLI 及运行依赖。K1 Pod 使用 non-root、drop capabilities、禁止提权、RuntimeDefault
seccomp、只读 rootfs、有界 scratch/tmp 可写卷和资源上限。K1 拒绝未知 container 安全
字段；显式 container 用户、组和 non-root 设置必须匹配 Pod 策略，省略的继承设置
仍可接受。这些配置不代表恶意多租户
隔离认证；同 UID 可信工具仍是本切片边界。

Kubernetes API 客户端使用 HTTPS、配置的 CA 信任、每次请求重读 token 文件、
禁止重定向、有界响应和超时。区分 GET 不存在、POST 冲突与传输/授权错误，不输出
服务端错误正文或凭据，并有 fake API 契约测试。供 loopback API 测试使用的 HTTP 客户端注入构造保持 package-private。

`release` 是空操作；`close` 清理本地记账，不删除 Pod/Secret，也不证明取消、retirement、
物理停止或输出交付。K1 因而不自动回收 idle 资源，运维须考虑保留资源的容量。
保留证据的删除需要后续显式 retirement 操作，携带原 UID、结算屏障及 UID 条件删除。

K1 Pod 丢失后，LOST binding 会使同一 tenant 的新 placement 被不可重试的
`runtime_placement_recovery_required` 拒绝。共享 repository 时，新 local-process
和其他 provisioner kind 也会被拦截；已有健康 binding 和其他 tenant 不受影响。
K1 不返回带停止 writer 证据的 NOT_FOUND，因而重复 recovery、外部删除 Pod 或重启
进程都不能清除这个持久拦截。运维必须停止受影响 tenant 的新准入，保留原 binding、
seed、资源 UID 和 execution 清单，并升级处理以获得保留证据的恢复方案或经过明确
评审的 placement 策略变更。本增量没有原地恢复路径；删除数据库记录、伪造 RELEASED
或停止证据均不安全。这个 K1 可用性门禁在 #13395 跟踪，不解除 retirement 或 CSI 复用门禁。

## K2 Workspace 存储与交接

[K2 详细设计](2026-10-01-managed-kubernetes-k2.zh-CN.md)记录目标预检、实施顺序、
平台验证及未定的挂载来源/retirement 契约。其只读和 MySQL 基线结果不会升级 K2/K3
验收状态。

持久保存可信 tenant/storage ID 到 cluster、namespace、PVC UID、PV UID、CSI
driver、backend domain 和不透明 volumeHandle 的映射。在目标 CSI 部署核验
PVC/PV 绑定和 RWOP 支持。物理冲突键为 backend domain + CSI driver + volumeHandle；
alias、目录、Workspace 名称和 tenant 不能把同卷拆成不同锁。路径或 PVC 名称不足以
证明身份。RWO 允许同一节点多个 Pod，不能替代 RWOP。

在任何 Pod 或初始化可能挂载/读取卷之前取得持久 reservation。现有 acquire 阶段的
Workspace lease 对 Kubernetes 挂载而言太晚。扩展现有 Workspace/Broker repository，
显式记录 reserved、active、draining、released，原 operation/generation、CAS revision
与证据引用。协调者 lease 赋予调查责任，不代表过期后可以挂卷。SQL 事务不跨 API/RPC。

worker 在 prepare 之前验证真实挂载、不可变 ContextBinding 和 holder generation。
新增控制 envelope 必须版本化，并有成对 Java/TypeScript fixtures；严格 v2/v3
记录不能静默增加字段。holder 覆盖 prepare/审批、执行、结果和必要 history/checkpoint
结算。等待忙卷不能制造假的 UNKNOWN 执行。不同物理卷允许并行。

正常跨 Session 交接必须封闭派发，确认 worker 及后代停止，完成持久结果/history，
核验卸载后才 CAS 释放。idle Pod 仍热挂载时继续持卷。Node NotReady、Pod 删除、
强删、VolumeAttachment 消失、lease 过期和数据库 epoch 增加均不是物理停止证据。
未知执行只按原身份查询/取消，不能在新 Pod 重放。写者或结果不确定时 K2 保持阻塞。
自动节点/存储 fencing 和跨故障域接管需要单独验收的平台契约，不是首版开放的前提。

## 集成与范围

K1 修改 SDK runtime-broker 包、隐藏 CLI worker 入口及测试，保留 Spring 对
Kubernetes 的拒绝和公开 Workspace 守卫。K2 必须同时修改 Workspace 解析、持久
reservation 和 worker 准入；仅开启 Spring selector 不足以交付。复用现有输出发布、
结果 receipt 和 history 工作，不创建第二套 store。公开 Shell、审批、文件 history、
G1/G3 接管、O3/O4 和 H 扩展继续遵循已有 tracker 归属与验收门槛。

普通本地 Managed engine 完成、完整 operator/CRD、warm pool、每工具 Job、多集群
调度、Workspace 创建、RWX/hostPath、自动重放 UNKNOWN 和恶意租户认证不在初始
范围。K1 私有 v1 工具路径保留现有可信工具集，不因此在公开 Hosted 准入开放这些工具。

## 验证与验收

baseline dry-run 使用全局 `qwen` worker 命令；拒绝容器参数是预期缺口。本地验证使用
构建后的 bundle 和 Maven tests。fake Kubernetes client 启动真实 worker，完成私有
read/write/edit、重复调用和原 status 闭环；这是协议集成证据，不是调度器/CSI 证据。
本地测试证明存活 worker 接管和已结算调用去重，不证明 Broker UNKNOWN 恢复、
Pod 丢失后的持久账本恢复或 JVM 崩溃恢复。

K1 覆盖确定性创建/复用、应答丢失、Pod/Secret UID 和 boot 冲突、镜像/placement 变化、
启动时限、API 拒绝/超限/重定向、token 轮换、容器重启和删除观测、迟到 release、
lease 缓存失效、
缺少本地 handle，以及 loopback/stdin 回归。证明 reconcile 不创建资源，不确定丢失
不重建，release 不删除。

2026-10-01，通过已认证的 Workbench kubectl，在 Kubernetes 1.36.2-aliyun.1
的 ACK 托管开发集群完成 K1 smoke。生产 HTTPS Kubernetes 客户端、provisioner、
Broker 和完整打包 worker 创建了一个 Pod 与一个 boot Secret，完成 READY attestation
及远端 write/edit/read。Broker 和 worker 两条重复调用路径均保留编辑后的文件。
两个独立 JVM 顺序执行，在同一 runner Pod 内共享 file-backed H2 状态；第二进程
恢复相同 binding/generation、Pod/Secret UID、endpoint、execution ID 与结果，
且没有新建资源。匿名 401、错误 lease 409、篡改保存 UID 后拒绝，以及 Broker close
后保留资源均通过。两个阶段最终输出均为 `pass`，runner 以 `Succeeded`、退出码 0
结束。测试工程师独立对照 runner 和验收包核验了终端结果。证据记录在
本地验证制品（不提交）。

本次 smoke 使用 digest 固定的 ECR 官方 Node/Java 基础镜像和 SHA-256 校验的临时
程序配送，不是生产 worker 镜像验收。Docker Hub 拉取超时，官方 ECR 分发成功。
原节点存在未容忍的 taint，ACK 因而自动扩容了工作节点。冷容量与镜像启动仍是部署
约束，namespace quota 不代表测试零费用。本次结果不证明 MySQL 验收、JVM 强杀
崩溃恢复、Pod/PVC 恢复、物理 Pod 替换、网络拒绝实际生效或生产 worker TLS。

验收后已撤销获准的 namespace Broker RBAC。核对资源身份后删除测试 namespace
及 Workbench 文件，真实 API 返回 namespace NotFound 且测试资源列表为空。最终
检查时 ACK 自动扩出的工作节点仍为 Ready，其回收尚未验证。

K2/K3 还须在真实 MySQL 和目标 Kubernetes/CNI/CSI 验收：两个独立卷、两个 Session
共享一卷、alias、旧/迟到 grant、Java 重启、Pod 替换、延迟 readiness、API 中断、
节点/网络分区、含后代的物理取消、输出存储失败、正常卸载与交接。既验证成功推进也
验证拒绝，要求无重复物理副作用、holder 不提前释放，并在工具环境故意延迟 15 秒时
先产生模型输出。部署必需控制包括最小 RBAC、Runtime 凭据隔离、实际生效的网络
策略、TLS/workload identity 和已准入 profile 的资源配额。

## 待决事项与证据

ACK 开发目标及官方基础镜像 digest 已通过 K1 验证。K2/K3 开放前仍须选定 CSI、
生产 worker 镜像/仓库、Runtime workload identity，以及可信停止/卸载证据来源。
在此期间默认按可移植 Kubernetes 契约开发。真实集群通过已认证的 Workbench 访问；
本机仍缺少 Docker、kubectl 和 kind。测试结果和未执行门禁必须分别记录。

来源：[proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380)、
[参考 Hosted 物理卷设计](https://github.com/doudouOUC/qwen-code/blob/c7abb13f79f35b7bd2dfbca277624cbf36054616/docs/design/2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md#hosted-runtime-profile)、
[Kubernetes Pod 生命周期](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)、
[卷访问模式](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)。
