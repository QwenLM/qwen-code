# Kubernetes Workspace 准入与存储交接

[English](2026-10-01-managed-kubernetes-k2.md) | [简体中文](2026-10-01-managed-kubernetes-k2.zh-CN.md)

状态：完整 CSI 开发增量已并入 draft PR #13289 的本地工作树。私有 reservation、
创建前准入、可信 API 原 Pod 身份、封口、原结果结算、checkpoint 与持久 ACK 均有实现。
当前可信创建与 ACK 入口见[持久 ACK 设计](2026-10-03-csi-durable-worker-ack.zh-CN.md)；
下文早期关闭 CREATE 的描述属于各阶段历史快照，旧三参构造仍保持关闭。
公开 Kubernetes Workspace selector、完整物理退役和卷交接仍未开放。
各阶段历史结果不代替最新主线整合后的验收；本次整合验证和审查进行中。
本文延续 #12380 的 [K1](2026-10-01-managed-kubernetes-runtime.zh-CN.md)。

## 当前证据与缺口

K1 已在 ACK 上运行真实 Broker、Kubernetes HTTPS 客户端、scratch Pod 和完整
worker。两个正常顺序启动的 Java 进程接管了相同身份并保留原执行结果。数据库是同一
Pod 内的 H2，未测试持久 Workspace 或物理 retirement。

后续 ACK 只读预检发现 Kubernetes 1.36.2、Disk CSI 1.37.2 和 Terway 1.17.7。
四个现有云盘 StorageClass 包含使用 `WaitForFirstConsumer` 和 `Delete` 回收策略的
`alicloud-disk-topology-alltype`。Disk CSIDriver 要求 attach，支持 persistent 卷。
这些声明本身不证明 RWOP 支持。初始 Terway 组件配置为 `NetworkPolicy=false`，运行中的
`eni-config` 为 `disable_network_policy=true`。两个现有系统节点在 Terway Node
资源中均报告 `veth`。不能仅凭组件版本或 `network_policy_provider=ebpf` 配置推断
DataPath V2 已启用。

后续 native 全 namespace 查询发现零个 NetworkPolicy。控制台预览提示参数变更会
重新生成组件模板，可能覆盖对模板的直接修改。拟议的集群级变更前必须重新核对配置和
策略清单。10 月 2 日，已获准的组件变更仅设置 `NetworkPolicy=true`。组件返回 active，
运行配置报告 `disable_network_policy=false`。没有重启系统节点，清理临时探针后仍保留
启用状态。

临时 ACK 测试使用一个新业务节点和一个 20Gi RWOP ESSD 卷。scheduler 明确以 claim
已被占用为由拒绝同一 UID 的竞争 Pod。原非 root holder fsync 保存 alpha 文件，随后
正常停止，保留 stopped 日志、Succeeded phase 和 exit 0。CSI 插件记录该精确 Pod UID
和卷的 unpublish 成功，随后记录竞争 Pod 的 publish 成功。竞争 Pod 在相同 Node、
PVC UID、PV UID、driver 和 handle 上读取 alpha 并 fsync 保存 beta。它在原 holder
结束之后、原 holder 正常删除 Pod 之前启动。

固定标签的 ingress 通过 allow/deny/allow 对照。即时切换标签出现失败观测；加入 5 秒
等待后，同一客户端完成两轮 allow/deny，UID、IP 和 Node 均未改变。这支持新节点上的
selector 最终执行，不能证明即时隔离或 5 秒收敛上界。业务节点存在时，CNI 和 CSI 均
报告 3/3 Ready。这些是平台观测，不是持久 Broker reservation 或 retirement。

清理使用保存的 UID 检查和正常删除。native 查询确认 namespace、原 PV、
VolumeAttachment 和业务 Node 均不存在；成功 ACK/ECS 查询记录报告精确云盘与实例
均不存在，业务节点池回到零。原系统 Node UID 均保持 Ready，CNI/CSI 回到 2/2。
从分配到观测回收不足 22 分钟。小时价格报价支持已获准的增量测试预算，但不是最终
账单或费用硬上限。

10 月 2 日，第二次已获准的临时测试以 UID 1000 在 Node.js 22.23.2 上运行冻结的 CLI
归档 `f4a768d6f5fe623d70225d4079ea828efe7251f6ec187f3e33faed22d988013b`。
容器 boot-v3 envelope 使用新记录的原生 PVC/PV/Node UID，以及由 ECS API 独立取得的
磁盘 serial。经过认证的闭合 CSI receipt 与实际 mountinfo、独立解码的 Linux 设备号、
root inode 和 sysfs serial 一致，多次读取保持相同。错误认证/context 请求被拒绝，
原 alpha 文件在 holder 转换后保留，真实 worker 的 `write_file` 成功且精确内容已核对。
两个原容器正常 SIGTERM 后均保留 restart count 0、Succeeded 和 exit 0。下载的原生
CSI 日志保持相同的已观测插件 incarnation、逐字扩展此前内容，并记录各原 Pod target
成功 unpublish。正常清理回收 namespace、PV、attachment、磁盘、业务 Node 和 ECS
实例；两个原系统 Node 仍 Ready，CNI/CSI 回到 2/2，总计 16 分 25 秒。

这是使用合成 context/reservation 输入的组件验收，不验证生产授权、持久 activation/
release、严格 drain 或已验证的 CSI collector。原生 Pod API 快照仍不能独立证明日志
字节所属的容器 incarnation。冻结归档也早于后续本地 executor-close 修复，因此此次
云端运行不验证该修复。该阶段持久 provider CREATE 与公开 selector 仍关闭；当前可信创建入口见上述持久 ACK 设计。

现有 Broker repository 契约已通过独立的 3/3 MySQL 基线。随后 K2a 在隔离的本机
MySQL 8.4.11 上通过十二组自定义集成验证：独立进程 alias 竞争与重启、V25 LOCAL
迁移、完整 seed/stale authority 守卫，以及 LOCAL/CSI 快照互斥。最初复现的外层
repeatable-read 事务缺陷已通过注册/claim 要求新事务修复，失败观测仍保留。
K2b 随后通过生产 Broker/adapter 的两组自定义 MySQL 验证：跨两个 JVM 的四次 busy
重试保留原绑定与他人 holder；provenance gate 在重启后保留 RECOVERY_BLOCKED 与
RESERVED。真实所有权行锁等待在 10.07 秒后超时，lease 仍有效，全部回滚。这些是私有
持久化/准入结果，不是已挂载 worker 或云数据库验收。全局 CLI 和本地 K1 worker
仍拒绝拟议的容器 managed-context 路径。

现有 Workspace 所有权在 worker READY 后的 transport acquire 阶段取得，此时
Kubernetes 已可能挂载 PVC。当前冲突键为 tenant/storage ID，alias 因而可以把同一
物理卷拆成不同锁。现有本地存储 guard 的 host/device/inode/marker 证据不能证明
CSI 卷身份。普通 release 不能证明 worker 后代已停止、输出已结算或卷已卸载。

## 目标平台验证

在实现可运行的持久 Pod 之前，使用现有 `WaitForFirstConsumer` class 创建一个
可丢弃的 ACK Disk PVC，访问模式为 `ReadWriteOncePod`、filesystem、20Gi。失败时
不得降级到 RWO。全部探针避开系统节点，使用一个业务节点，并把竞争 Pod 固定到首个
holder 实际所在的 hostname。竞争 Pod Pending 本身不足以证明独占：需证明 scheduler
或 CSI 拒绝确由原 live holder 引起，且剩余资源足够。正常停止首个 holder 后，验证
第二个 Pod 读到原 fsync 文件，核对相同 PVC UID、PV UID、CSI driver 和不透明
volumeHandle。这只验证正常平台路径，不证明节点分区或强删时的安全性。

网络验证要求对同一健康 endpoint 的多次拒绝请求，在前后都有成功的正向对照。在临时
namespace 内使用 Pod selector 验证 ingress。egress、跨节点隔离、TLS 和恶意租户
仍属于 K3 门禁。任何组件变更之前先保存原 Terway 配置。通过 ACK 组件管理修改，
不编辑生成的 CNI 文件。根据 ACK 的
[网络策略文档](https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/use-network-policies)，
未启用 DataPath V2 的现有节点可能需要重启。系统节点重启是需要单独评估影响的操作，
不属于本探针范围。在已获准的配置变更后验证新业务节点，明确记录通过的范围。

可丢弃测试范围为 `qwen-runtime-k2`：一个 20Gi PVC，最多四个探针 Pod，以及 namespace
quota、ConfigMap 和 ingress 策略。Pod 无 Kubernetes token，以 UID/GID 1000 运行，
drop 全部 capabilities，使用 RuntimeDefault seccomp 和 K1 已验证的 SHA 固定公共
Node 镜像。这些平台探针不需要 Broker RBAC、模型凭据、Service、公网 endpoint、
生产数据或源码归档。运行最多 30 分钟后清理。Pod deadline 和 namespace quota 不是
费用上限，也不会自动清理云盘。保留并检查实际云盘 ID，通过 ACK 和 ECS 观测确认
删除；清理失败仍须处理。

## 可信注册与挂载来源证明

持久保存不可变注册，把已授权 tenant/storage ID 映射到 cluster domain、namespace、
PVC name/UID、PV name/UID、CSI driver、不透明 volumeHandle、可信 backend domain、
可信磁盘 serial、mount root 和注册 revision。backend domain 是物理存储服务的 operator 配置，不能从
tenant 或显示名称推导。用有长度边界的 backend domain、driver 和 volumeHandle
编码生成物理键。同一物理卷的两个注册必须引用同一所有权行，包括跨 tenant/storage
alias。普通 Workspace 错误不能公开不透明 handle 或注册详情。

通过可信 API 读取 PVC 和 PV，检查双向 claimRef 绑定、原 UID、filesystem、driver
allowlist 和 RWOP。Pod 创建与准入前再次核对。Kubernetes Pod 的卷引用只包含 PVC
名称，不包含 UID；GET 后 CREATE 无法消除替换竞争。部署必须在整个 reservation
期间保护已注册 PVC/PV 不被替换，并提供可独立验证的挂载来源证据链。声明的 Pod spec
或已挂载目录本身不够。

worker 的 Linux mount 信息和 dev/inode 观测可用于 incarnation 检查，但不能通用地
还原不透明 CSI volumeHandle。ACK Disk 必须在准入工具前，结合实际 CSI/device
信息确定具体的来源证明契约。若无法建立契约，则保持持久执行关闭。不以 privileged
worker、hostPath 或通用节点管理 agent 绕过这个要求。

独立的 `managed-csi/1` boot-v3 envelope 包含原封不动的 closed managed-context
boot-v2 record。容器文件入口只在真实 Linux observer 成功后接受它；stdin 入口
拒绝它。独立 attestation 路由校验原 lease 身份和完整 reservation 请求，再观测
挂载。closed reply 包含未扩展的 context attestation、精确 storage 身份、
downward API Pod 身份，以及固定的 mount ID、设备、来源、磁盘 serial 和根目录
dev/inode。两种语言都要求 root stat device 等于 Linux major/minor 编码，并与
可信 API 观测的 Pod 身份比较。boot、request 和 reply 共享 fixtures 覆盖额外字段、
数字编码和身份替换。既有 boot-v2 READY record 仅表示 context listener 身份，
不能替代 CSI receipt。私有 Broker adapter 在部署保护和持久 provenance 接入前仍
拒绝 CREATE。

ACK 探针的精确 filesystem mount 对应一个 NVMe 设备；只读 kernel sysfs serial 与
可信 ECS `DescribeDisks.SerialNumber`、CSI 插件按 serial 查找云盘的记录均一致。
阿里云的[云盘序列号文档](https://help.aliyun.com/en/ecs/user-guide/query-the-serial-number-of-a-disk)
说明了磁盘身份识别方式。由此得到一个具体候选契约：解析实际 mount 的设备，将其
serial 与可信注册磁盘身份比较。不能仅凭设备名推断通用 CSI 映射，也不能未经可信
backend 验证就去掉 handle 前缀。已观测的 CSI 日志还需要受限、版本化的 reader，以及
绑定原 node/plugin/Pod incarnation 的持久 receipt；诊断日志文本本身不是生产交接实现。

对已验证 ACK profile，正常交接要求卸载原 Pod 的 publication target，不要求仅供
CSI 使用的 staging mount 或 VolumeAttachment 消失。
[CSI 规范](https://github.com/container-storage-interface/spec/blob/e6fc13ea4d529db12e211ef79c924ee3186c39d5/spec.md)
定义了逐 target 的操作。采集前后均固定可信插件 Pod UID、containerID、imageID、
restart count 和 Node UID。从 Pod 创建前开始采集，识别原成功 publication 及其后
普通 unpublish，持久保存完整来源与顺序 receipt。日志缺失、幂等空 target 分支、
截断记录、来源替换或不确定断流恢复均不能升级为退休成功。profile/parser 必须针对
不可变插件镜像验证，仅有版本 tag 不够。

私有原生日志 reader 现通过可信 API 获取带 timestamp 的当前可读取日志段，不设置服务端
tail 或字节截断。拒绝重定向、无效 UTF-8 和超过一 MiB 的回复。每个 snapshot 在读取
前后核对原 kube-system CSI 插件 Pod、DaemonSet、Node、container 和 image 身份，要求
零重启与 Node Ready。后续追加 snapshot 必须逐字节保留原完整前缀；空日志、不完整行、
终端折行或前缀替换均拒绝。这些本地检查仅提供 qualification 输入，尚未实现持久的
创建前 collector，也未验证插件事件 parser、证明普通 unpublish 或授权物理释放。
collector 重启后不得用新 baseline 替换原 reservation 保存的日志历史。
Kubernetes 日志 API 不返回已轮转文件，并可能跳过无法解析的 CRI 记录。它按 kubelet
本地状态选择容器，而此状态异步同步到 API server；因此前后 API 观测一致也不能证明
日志字节属于固定 container ID。合格 collector 必须先补足这一来源绑定，其 receipt
才可授权交接。原生 RFC3339 timestamp 包括 ACK 已观测的 `+08:00` offset，均接受且
不改写原字节。

已注册对象保护是独立部署前提。最小方案之一为 native ValidatingAdmissionPolicy
和 Deny binding，针对固定 PVC/PV 名称及不可变身份字段和 namespace 删除限制非可信
principal，同时通过独立审计的 RBAC 边界保护 policy 与 binding。API 创建的 VAP
无法保护 admission 配置对象：Kubernetes 为避免循环依赖，明确将这些资源排除在
API policy 求值之外。
[v1.36.2 admission plugin](https://github.com/kubernetes/kubernetes/blob/v1.36.2/staging/src/k8s.io/apiserver/pkg/admission/plugin/policy/generic/plugin.go)
及[官方 policy 文档](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/#api-kinds-exempt-from-admission-validation)
均记录此规则。不能生成声称能保护自身的 VAP 并将其视为生效。完整审计过的等效
授权边界也可满足要求；不能假设托管 ACK 可使用静态 control-plane manifest。必须先安装
保护，再进行可信 UID 注册与 runtime reservation；全部 alias 和 holder 安全释放后
才能解除保护。K2a 持久化本身既不安装也不证明此边界。

具体 native renderer 冻结已注册 PVC/PV 的整个 spec 和全部 Namespace labels，并拒绝
删除。保护存续期间不允许扩容、重新绑定、修改回收策略或维护 labels。按实际
`oldObject.metadata.name` 匹配目标，包括 admission request name 为空的
DELETECOLLECTION。明确覆盖 Namespace `status` 和 `finalize` 更新：v1.36.2 的这些
子资源可以修改 metadata。PVC/PV status 更新的 strategy 会恢复旧 spec，因此保留
这些正常状态更新。

受限客户端只允许明确的 core/admission v1 读取以及 Pod/Secret CREATE。私有资源
guard 在双向 Bound PVC/PV 读取前后核对 policy/binding UID、generation、精确 spec
和已观测 type-check status，同时检查 RWOP、Filesystem、ext4、driver/handle、
Namespace UID 和固定的 restricted PSA labels。这些观测不能证明 admission 持续
生效、PodSecurity 无豁免或有效授权闭包。10 月 2 日，ACK 通过 server dry-run 接受
生成的 VAP 与 binding；随后的 GET 均报告不存在。未安装保护策略，也未创建新资源。

API 创建的动态 webhook 同样跳过 admission 配置对象，不能替代独立授权保护。
Runtime namespace 的工作负载仅由可信 provisioner 创建。worker SA 无权限、不挂载
token；operator 身份与凭据置于不能创建 Runtime 工作负载的其他 namespace。审查
既有和外部授权、bind/escalate/impersonate、SA token 和工作负载取得凭据的路径。
RBAC 权限累加，窄 Role 不能抵消其他授权。启用持久 CREATE 前，须用正向对照验证
实际请求被拒绝。

## 挂载前持久所有权

扩展现有 Workspace registry 和 execution repository。复用现有 execution/result/
history store，不创建竞争的执行 ledger。注册元数据可有独立表，alias 必须解析到一个
物理所有权行。本地 Linux 存储恢复路径与 CSI 证据保持独立。

所有权行保存注册 revision、原 provision request、binding/generation、reservation
ID、CAS revision、phase 和证据引用。phase 为 `RESERVED`、`ACTIVE`、`DRAINING`、
`RELEASED`。效果不确定时保留 holder 并记录阻塞原因；coordinator lease 过期只改变
调查责任，绝不改变物理所有权。

| 转换                | 必需事实                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| RELEASED → RESERVED | 已授权注册、相同物理键、原 provisioning 身份、与 released revision 原子比较                         |
| RESERVED → ACTIVE   | 原 Pod/Secret 与注册身份完全匹配、可信 mount 证据、worker 准入成功及原 holder CAS                   |
| RESERVED → DRAINING | reservation revision 1 的精确原 holder 及持久派发 seal；原 Pod 创建或挂载可能已发生，继续保留所有权 |
| ACTIVE → DRAINING   | 对该 generation 持久封闭派发；在审批、结果、history 和 checkpoint 结算期间保留所有权                |
| DRAINING → RELEASED | 原执行结算、worker/后代停止、可信 unmount 证据、全部 receipt 持久化、精确 holder CAS                |

在任何 Pod 或 init container 可能挂载或读取卷之前提交 RESERVED。SQL 事务不能跨
Kubernetes API 或 worker RPC。创建应答丢失时保留 reservation，只观测确定性的原资源。
资源变更/消失或 journal 不确定均不能授权新 generation 或执行重放。

当前 managed-context provisioning 会对任何 `ensureResource` 失败阻塞恢复。因此
同卷 busy 必须在创建资源前分类，并明确证明本次尝试未发起 create；它应是基于原
provisioning 身份的可重试等待。不能制造 UNKNOWN execution、释放别人的 holder，
或永久阻塞尚未被触碰的 binding。可能已经生效的 create 之后，全部失败保留原有保守
blocked 语义。需要在 Broker 边界验证这个区别，不能只测 reservation repository。

## worker 准入与正常交接

引入版本化容器 control envelope 和成对 Java/TypeScript fixtures；不能静默向严格的
boot-v2 或 tool-v3 记录追加字段。placement 与准入检查纳入不可变 ContextBinding、
存储注册/revision 和 reservation 身份。worker 只有在核验 mount incarnation/来源与
当前 holder 后才能开放工具 prepare。审批不能超过 holder 的有效范围。身份改变必须
永久关闭本地 gate，保留未决结果供原身份 reconciliation。

新的 `managed-csi/1` boot-v3 envelope 内嵌未改变的封闭 boot-v2 context，以及封闭
存储身份：cluster/backend domain、Namespace、PVC/PV UID、driver/不透明 handle、
serial、physical key、注册 revision 和 reservation UUID/revision。共享 Java/TS
fixtures 包含独立计算的长度分界 SHA-256、Unicode 和格式错误/stale 身份。ACK Disk
mount observer 受限读取 Linux mountinfo 和 sysfs serial，要求完整可写 ext4 NVMe
挂载，不能有子挂载覆盖或子目录 bind；固定 mount ID/device/source 与 root dev/inode。
身份丢失会永久封闭该 observer。parser 一致性与保留 kernel 文本不是新的 Linux worker
验收。容器文件入口已接入 envelope、observer 和独立的认证 CSI receipt 路由，但
公开 CSI selector 仍关闭；可信 Broker 创建入口由上述持久 ACK 设计实现。

显式持久 retirement operation 负责正常交接。通用 `release(request, lease)` 回调
仍无权删除资源，因为失败的 Broker operation 可以与胜者共享 Pod。retirement 封闭
新派发，等待运行工具和审批，结算 output/history/checkpoint，取得 worker 及后代成功
停止和物理卸载证明后才 CAS release。按保存的原资源身份执行带 UID 条件的删除；清理
错误保留持久 holder。

派发封口必须与每次新 Tool dispatch 授权共用 parent binding 锁。在 `claimDispatch`
之前检查一次 READY 或仅将 binding 改为 DRAINING 都会留下竞争窗口。PREPARED
调用不发送 RPC，直接取消；已获授权的调用保留原 dispatch 身份，只能观测、取消和
结算。退休 inventory 除 executing、UNKNOWN 和 terminal receipts 外，也覆盖
PREPARED 和 DISPATCHING；ABANDONED 属于不确定，不能证明正常交接。重启通过
保存的 generation 恢复仅供结算的 context，不能走普通 acquire 或重新 activation。

Broker 现在通过 binding repository 的原子准入操作授权 DISPATCHING-to-EXECUTING。
JDBC 在同一连接中依次锁 binding、Session 和 execution；内存实现使用同一 parent
锁。原取消与结果 reconciliation 仍可使用。自定义 binding repositories 必须实现
此操作；默认实现拒绝派发，不能在 execution CAS 之外单独检查 readiness。这封闭
了新的执行授权，但尚未实现持久 CSI retirement coordinator。

execution repository 现在提供限定 exact binding/generation 的有界 inventory，
覆盖所有 Session 和全部七种执行状态，包括 PREPARED、DISPATCHING、SETTLED 和
ABANDONED。排他的 execution-hash cursor 在此前记录结算后仍有效。不支持该接口的
repository 明确拒绝扫描，不能返回空库存。此接口只是读取组件，不是一致的结算快照
或释放条件；retirement coordinator 必须先封闭准入，再枚举并核实原执行结果。

worker 封口还要等待未进入 execution journal 的 tool lookup 和 capture preparation。
executor 关闭流程现在跟踪并等待原工具、capture preparation 和文件历史入口 promise。
异步 lookup 后再次检查 closing，防止恢复的 V3 lookup 新建 capture，以及恢复的 MCP
lookup 新建 invocation。既有尽力而为的 `close()`、排除 UNKNOWN 的
`hasActiveSession()`、provider disposal
和父进程退出均不能证明严格 drain 或后代停止。应用 drain receipt 只覆盖准入与原
preparation/execution/publication 工作。独立可信 Pod/container termination 与
逐 target unpublish receipt 才能为该 bare-Pod profile 证明物理停止。

严格 CSI 封口仍独立于关闭流程：拒绝新准入时，必须保留原 status/cancel/ack、history
snapshot 和 MCP release。promise 成功完成不能掩盖 UNKNOWN、失败或 partial capture、
未提交 publication。Shell history backup 的取消与异步 PR metadata 写入，也必须
明确纳入跟踪或从已验证的 CSI 执行 profile 排除；invocation promise 不覆盖这些尾部
任务。

复用权威 publication、Session journal/checkpoint 和 MCP extension ledgers。
FINISHED publication 或 Broker SETTLED 本身不够：必须有完整原 capture、匹配的
committed REFERENCED receipt，以及覆盖结算边界的持久 checkpoint。continuation
helper 返回 null 不能作为 checkpoint 证据。复用原 MCP operation reconciliation
和 `active → releasing → drained` generation 转换；未知应答与 close 失败保留
holder。CSI retirement journal 仅保存原身份、phase 与不可变证据引用。最终
binding/slot 和物理 holder release 必须使用同一数据库连接和事务；调用另开事务的
repository 方法不能提供这种原子性。

Pod 消失、NodeNotReady、VolumeAttachment 消失、SQL epoch 改变、lease 过期、强删
或 HTTP release 成功本身均不是物理停止证明。停止或结算不确定时阻塞交接。自动
fencing、跨故障域接管、UNKNOWN 重放及通用 operator/CRD 不属于 K2。

### K2c 第一片：持久意图与派发封口

私有 `beginRetirement` 操作接收精确注册、原 binding/generation、reservation
UUID/revision 和 retirement UUID。新事务依次锁 placement domain、active slot、
binding、alias、物理 reservation 和 journal。核对完整原 seed、handle、lease 与有效
operation claim 后，原子记录意图并封闭派发。RESERVED 转为 DRAINING，清除旧
coordinator claim，保留 slot 和物理所有权。允许 PROVISIONING、READY 与
RECOVERY_BLOCKED；LOST 继续阻塞。

journal 固定原身份、binding version、可选 scheduler handle/lease，不保存凭据。
handle 缺失表示未记录 scheduler 身份，绝不能证明从未挂载。精确重试返回原 journal；
冲突 UUID、过期身份或变化的资源 pin 均拒绝。即使取得新 operation claim，通用 CAS
也不能清除 CSI seal、改变 handle/lease/attestation 或离开 DRAINING。原结果/cancel
和 Session release 仍可使用。事务失败同时回滚 journal 与 seal。私有离线命令不新增
listener 或云操作。

10 月 5 日整合主线时逐字保留上游 V27–V40，包括 Java V29 Hook backfill、V35
Session tool profile、V36–V39 查询优化及 V40 Session creator。未合入的 CSI
reservation 顺延为 V41、retirement journal 为 V42、dispatch authorization 为 V43、
持久 worker ACK 为 V44。此前 CSI V26→V27 和 V27→V28/V29 的检查仅为旧快照历史证据；
新整合须另验真实 V40→V44 升级，不能重写已应用数据库的 Flyway 历史。
验证覆盖 V27 数据保留、独立 MySQL JVM 派发竞争、重启精确重试、alias 冲突、损坏、
回滚与 LOCAL 回归。本片不授权 ACTIVE、worker drain、物理 stop/unpublish、RELEASED
或持久 CREATE/selector。

第一片于 2026-10-02 通过 27 个聚焦 Java 测试和 17 组独立真实 MySQL 8.4
验证。MySQL 验证观察了派发/封口两种顺序的实际 RECORD 锁等待，并在独立 JVM
中运行真实离线命令。已复现并修复两个缺陷：JDBC lease 必须按值比较，journal 的
UTC 时间必须从数据库 epoch 数值生成，不能转换 session 墙上时间。最终验证保留
数据库 CST 与 JVM Asia/Shanghai 时区，用独立数值 epoch 区间核验已提交时间，
并正常停止和删除隔离数据库。此证据只覆盖意图/封口；此前冻结的 ACK worker
仍属于另一项组件资格验证。

### K2c worker 片：准入封口与观察

此私有端点属于原 boot-v3 worker generation。它接受 `seal` 或 `status`、
规范 retirement UUID、原闭合 CSI attestation pin、runtime instance/incarnation
及原 Pod UID。沿用 bearer、lease ID/epoch、no-store 和 body 大小限制。同步封口
在启动工作前拒绝新 context installation、activation、工具、provider control、
MCP configure/discover/invoke 和 publisher installation。worker 管理的异步准备路径
都在最终变更/启动边界再次检查准入。已进入 core 的 provider control 可以完成原
continuation；其待完成工作和永久生命周期阻断，防止本片证明严格完成。
原 status、cancel、result、acknowledgement、
history snapshot 和 release 保留；listener 与原 mount identity 保持可用。

此片保留当前 capability 合约，不静默替换成更小的文件档位，也不从 lease epoch
推导 binding generation。端点识别应用 worker，不独立证明 durable binding。
后续 retirement caller 必须把该精确 worker identity 与已提交 journal 和可信
原 scheduler handle 匹配；当前 boot 没有独立 bindingId/runtimeGeneration。
后续若增加 file-only profile 或扩展身份 envelope，必须先明确 Java/TypeScript
合约并完成资格验证，再允许激活。

executor 复用 invocation journal 和待完成 preparation。preparation 或原 invocation
未结束时返回 PENDING；UNKNOWN、不完整/未提交 capture、已进入的 capture preparation、
已安装的 publication/MCP grant、失败的变更型 history control，以及尚未完成严格
生命周期资格验证的 provider/MCP/Shell 活动返回 BLOCKED；只有已观察到的普通工作
完成时才返回 QUIESCENT。Promise fulfilled 或 generic close 都不能证明结算；
开始 shutdown 本身也是永久阻断。此应用观察
不返回 DRAINED、不改变 journal、不释放存储，也不证明后代/container/unmount 完成。
后续结算阶段仍须独立核实 Broker execution inventory、publication receipt 与
Session checkpoint 等原权威记录。

此 worker 片于 2026-10-02 通过十个文件共 1,982 个聚焦测试（三次聚焦运行）、
根目录 build/typecheck/bundle 与变化 TypeScript 文件的 lint。
独立验证通过八组和两组补充，覆盖本地真实 read/write、原 V3 result/ACK、
stdio MCP 和完整 profile 的 provider/context/publisher caller。
boot-v3 route 测试明确替换 mount 观察与解析，不证明 Linux/ACK 存储行为。
两轮干净自审和限定范围的独立只读审查未发现已确认的问题。正式 medium-effort
审查在 15 分钟后超时，没有结论，不构成批准。冻结 ACK archive 未变化，
不覆盖新端点。[持久派发授权](2026-10-02-csi-dispatch-authorization.zh-CN.md) 已通过
308 个聚焦 Java 测试和 18 项独立断言/组的本地验证；限定范围审查未发现已确认的问题，
正式审查超时无结论。
[仅允许原任务的 publication 结算 consumer](2026-10-02-csi-original-publication-settlement.zh-CN.md)，
现已在本地通过 275 个聚焦 Java 测试和 41 组独立验证，包括实际 MySQL 锁等待、
回滚、reload 和晚到 quarantine 拒绝；holder 保留在 DRAINING。其正式审查同样
超时无结论。下一片必须核对原 publication receipt、覆盖结算的 Session checkpoint、
worker ACK 和 MCP 持久结算，之后才能推进物理退役。

验收覆盖 HTTP 认证与 scope/UUID 冲突、await 后竞争、原 result/cancel/release、
真实文本 read/write、UNKNOWN/capture 阻断、provider/MCP/Shell 的保守阻断以及
LOCAL 回归。冻结的云端 worker archive 保持不变；该端点必须经新 worker 资格
验证后，才能用于生产 handoff。

## 实施顺序与受影响层

| 步骤 | 变更                                                                                       | 完成证据                                                                                             |
| ---- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 平台 | 只读探针，然后获准的 RWOP/网络探针与清理                                                   | 实际拒绝与持久化观测、保留 UID/device 证据、记录范围和局限                                           |
| K2a  | 可信 CSI 注册、物理键解析、Workspace 持久 reservation                                      | MySQL 独立连接/进程并发、alias 冲突、重启和 stale CAS 测试                                           |
| K2b  | Broker 创建前准入、受限 PVC/PV API 读取、Pod placement 身份、容器 envelope 和 worker fence | reservation 前零 create；busy 可重试；不确定 create 保留 holder；Java/TS fixtures 与实际 worker 测试 |
| K2c  | 持久 retirement、派发封闭、结算和可信 stop/unmount 证明                                    | 正常交接成功；每个不确定阶段保留原 holder；不在替代资源上重放                                        |
| K2d  | Spring resolver/selector 和已注册 Workspace 文件 profile                                   | 两个独立卷并行；同卷跨 Session 串行；实际 MySQL 与 ACK 验收通过                                      |

主要集成点为 `KubernetesRuntimeProvisioner`、`KubernetesHttpRuntimeClient`、
`RuntimeBrokerService`、`WorkspaceRuntimeResolver`、`WorkspaceExecutionStore`、
`WorkspaceStorageGuard`、`WorkspaceRuntimeTransport`、`EmbeddedRuntimeBroker`、
Spring migration/properties，以及 container 和 managed-context worker。runtime-broker
保持独立于 Spring，`managedworkspace` 包保持仅依赖 JDK。最终公开准入还须同步修改
Workspace input 和 execution-profile 守卫。Shell v3 capture、MCP、restore 和
local-process recovery 保留现有门禁。

K2a 是私有持久化阶段。仅 operator 使用的注册命令接受已审查的注册数据，不授权
mount，也不创建 Kubernetes 资源。用有长度边界的 tenant/storage alias key 保存
不可变 JSON 注册，每次读取均核对解码值、physical key 和 revision。为现有执行
所有权表增加 CSI phase、reservation 和 revision 列，默认 `LOCAL` 保留 V25 行。
所有 alias 插入或锁定同一物理所有权行。CSI 注册与 LOCAL claim/mount 注册通过现有
tenant placement guard 串行，并要求新事务；拒绝外层事务，防止其旧 repeatable-read
快照隐藏已提交的注册。CSI 注册拒绝任何现存 legacy LOCAL 行，包括已释放的行；LOCAL
消费者拒绝 CSI alias，并将所有权读写限定为 `LOCAL`。K2a 不支持转换存储 profile。

实现已对齐上游 `a7deb01bc`。上游 V26 用于公开工具结果 projection，未提交的 CSI
migration 当时为 V27（此次整合为 V41，见上文）。新的独立 MySQL 8.4.11 验证确认 V26 升级 V27 后，原 LOCAL holder、
binding/session、projection 样本、表与索引均保持不变，并通过当前 CSI 竞争与派发回归。
此前 V25 升级 CSI V26 的测试记录继续作为历史证据；对已应用的 migration 改名不能证明
升级有效。交付前须再次核对下一个可用版本号。

reserve 只接受当前 PROVISIONING binding。使用配置中的 JDBC repository，在同一已锁定
事务连接中完整解码持久 seed；比较完整请求、seed、binding generation、resource/lease
身份、PROVISIONING 状态、drain 标志和 coordinator owner/operation generation。
同一 operation 的合法续期可在调用者快照与锁内读取之间改变 record version 和 operation
截止时间；reservation 准入不要求这两个字段相等。权威截止时间必须非空，并在取得
物理行锁后读取的新鲜数据库时间上仍存活，幂等重试也必须如此。
CSI 事务与权威记录的锁定读取使用十秒 SQL timeout；timeout 不是成功 reservation，
也不是已证明的 busy。
同一原 reservation 重试幂等；stale caller 或另一个物理 holder 均不改变任何行。
K2a 没有 activate、release、超时接管或公开 selector。私有创建前 adapter 通过独立
`reserveResource` 步骤消费 reservation，该步骤在 Broker 启动 renewal 或进入
`ensureResource` 之前执行。其 reservation UUID 对原注册 revision 与 provision request
保持稳定。仅此步骤的明确 physical busy 才保留 PROVISIONING，允许重试原身份；Broker
释放 coordinator claim，不释放物理存储。准入成功后，在进入现有资源流程前重新续租
原 operation。进入 ensure 后的失败继续使用原有 fail-closed recovery 语义，即使其
错误恰好使用同名 busy code。

旧三参 adapter 仍在任何 Pod 或 Secret CREATE 之前拒绝 ensure。后续显式受信构造器
按持久 ACK 设计增加资源保护、PVC/PV、Pod/node/container/image 与挂载核验。
完整物理退役仍未实现。

私有 CSI Pod 校验拒绝未知的 spec、container 和 security-context 字段，同时允许
明确支持的 API 默认字段省略。内置 ServiceAccount 和 Priority 准入可以添加
`imagePullSecrets` 和 `priorityClassName`，创建及原 Pod 恢复均接受这两个字段；
其他未支持的准入变更仍被拒绝。特别是 container 不能覆盖 Pod 的 non-root 用户策略。
操作失败仅失效与原 request、seed 和 handle 匹配的缓存 placement；其他 seed 或伪造
handle 不能撤销存活原 worker。ConfigMap GET 的响应预算独立设为一 MiB 加 64 KiB，
为最大一 MiB 的 base64 chunk 提供 JSON envelope 空间。原生 CSI 日志仍保持严格的
一 MiB 字节上限。这些校验不实现物理 retirement。

## 验收与未定契约

实现后运行现有 build/typecheck/bundle、相关 Java/TS 测试和 MySQL 契约。新目标集群
矩阵仅使用已获准的可丢弃测试范围。对整合后完整源码完成两次无问题自审和独立审查。
此前限定范围的审查结果及没有 verdict 的正式执行均不批准此次整合。

实现门禁仍包括实际 RWOP 支持、已注册对象的替换边界、ACK Disk 挂载来源和可信正常
stop/unmount 证据。开放相应执行 gate 前，必须基于目标平台观测定义每个契约。本文
记录完整目标及各阶段实现；局部证据不等于已适合生产。

## 主线整合：Hook 封口与迁移

主线新增的同一 ManagedHookRuntime 现在接收 CSI seal，目录解析和 native dispatch
前的 await 返回后复核准入。原 operation replay、status、cancel 保留；新的 Hook
入口拒绝。聚合 inspection 包含 pending start、未结算 operation，任何已开始的
Hook lifecycle 永久保留 `hook_lifecycle_unqualified`，普通 close 不清除它。
这不是 Hook 物理排空证明。整合后的 Hook 竞争测试与真实 worker 验证另行执行。
