# K2 原节点持续控制与 CSI 来源

[English](2026-10-11-k2-node-evidence.md) | [简体中文](2026-10-11-k2-node-evidence.zh-CN.md)

状态：正在实施的候选，尚未在 ACK 资格化。journal 与受限 runtime gateway 协议测试通过。此前 custody 候选通过实际 Linux pidfd/cgroup 测试，覆盖后代、迁移、descriptor 丢失、路径替换与 PID 复用。完整 source engine 与 CSI frontend 通过了自有 Linux 进程测试，使用真实任务、后代、cgroup descriptors 和挂载；其 runtime/CSI RPC backend 仍为协议夹具。Go、Java 21 与 guest OpenSSL 的严格 TLS 1.3 互操作通过。匹配 peer 权限、UID 1000 任务、只读 cgroup 视图及单向挂载传播通过了自有内核测试。这些结果不资格化实际 ACK artifacts 或正常 Pod 删除。Java source reader 与私有观测命令已通过实际自有 Linux source 的认证读取，以及 17 个独立 TLS/parser/失败窗口。普通重复 Maven package 也会更新全部五个 Boot artifact 的 broker，server classes/resources 不变。私有 pre-CREATE coordinator 接线已实现为新候选，完整 source-control/provisioning 验收待完成。部署与物理释放尚未完成。关联 #13395 和 Draft PR #13526。本文给退役交接设计 §6 提供具体来源，但不启用物理释放。现有 ACK 是目标环境；其两个共享系统节点不属于拟议安装范围。

## 问题与支持边界

应用 `DRAINED` 不能证明容器及其后代停止，也不能证明原 CSI target 已卸载。containerd events 缺少持久重放 cursor；CSI 空 target 重试成功不能重建此前 publication。诊断日志不能补足这些事实。

首个来源支持隔离 Linux 节点、cgroup v2、单个非特权且 `restartPolicy=Never` 的 bare Pod、经过审阅的仅文件 Runtime，以及持续观察的原容器。排除 cgroup delegation、进程逃逸或迁移、额外容器、exec、不支持的 admission 变更和 runtime/plugin/source 重启。资格化必须在实际固定 ACK artifacts 上验证这些属性。签名认证来源，不能证明 containment 或完整性。

## 两个来源角色

在 `packages/k2-node-evidence` 添加独立 Go 模块。一个 binary 有两个明确角色。`gateway` 持有 containerd socket，只投影固定原 task 与 CRI identity 读取；不提供通用 gRPC relay、shell、path、PID、kill、exec 或 create API。只读 socket mount 仍然具有 runtime 管理能力，因此这个小 helper 属于可信实现。

`source` 持有持续 cgroup 控制、CSI frontend 和持久 journal，不持有原 runtime socket。其 gateway 通道及 coordinator 控制/读取通道认证固定 certificate principals。控制只接受经过审阅的未来 Pod identity、后续 exact UID 关联和已持久的正常 stop intent。worker 和 tool 不具有来源控制权限。配置及 image/binary digest 由部署方管理，资格化前必须审阅。

Custody 需要实际 host PID namespace、受限 host /proc 观察，以及 host cgroup v2 固定根下持续持有的 descriptors。部署必须说明这些权限，以及 source 不能修改或委派原 cgroup 的限制。host namespace 访问属于可信边界；容器内 PID/cgroup 观察不能资格化原 task。gateway 保存首次完整 terminal observation，后续 exit status、timestamp 或 identity 发生变化均拒绝。

来源不持久 credential、environment、CSI secret、VolumeContext 或无限制 RPC payload，只记录固定 identity 投影和 operation result。不支持的 method 或 parser version 对已登记原 scope 失败闭合。

JSON 控制、配置及 gateway response 字段必须使用声明的精确拼写，拒绝未知字段、重复名称与大小写 alias，包括嵌套对象中的 alias。HTTP routes 属于 node-source scope：gateway 上仅 coordinator 可登记原 task，仅 source 可读取 runtime/original；source 上仅 coordinator 可进行 ARM、UID binding、stop intent 和 journal 读取。它们不选择用户 workspace，也不授予 worker runtime 权限。

## 持久 journal 与 incarnation

下一版 journal 格式 `qwen-k2-node-source/4` 补齐 saved stop 到 backend
卸载之间的观测区间。等待卸载期间，source 继续检查持续持有的原 pidfd、leaf、
Pod parent 与 events descriptor。转发 NodeUnpublishVolume 前及取得实际 backend
成功后，必须重新取得与 ORIGINAL_STOPPED 完全相同的 terminal、unpopulated
custody tuple。UNPUBLISH_BEGIN 和 UNPUBLISH_OK 持久保存这些 fresh observation
及未变化的 saved terminal runtime identity。观测失败、存活后代、对象替换或
descriptor 丢失均永久阻断 scope。Java reader 要求两次 observation 均与原 stop
相等；重新计算 hash 的替换观测或缺少这些字段的 journal 不能提供当前卸载证据。
旧 v1–v3 journal 保留为历史材料，v4 reader 拒绝它们。本改动仅补齐后续观测区间，
不建立首次执行前的 confinement，也不授权物理释放。

journal 位于 worker 及其 PVC 之外的独立来源磁盘，使用排他所有权、有界 length-delimited records、连续 sequence、predecessor hash，并在确认来源转换前执行 `fsync`。每条 record 绑定 format、source incarnation 和 exact original scope。reader 拒绝截断、缺口、重复 sequence、hash mismatch 和未知字段。write 或 sync 失败使当前来源失效，后续调用不能修复未知 append outcome。

reader 除 journal bytes 外，还要求独立保存的 durable head cursor；hash 有效的缩短 prefix 不能替代它。每个 CSI completion 必须绑定其持久 begin cursor 和 exact publish/stop dependencies，不能仅凭 record sequence 建立这些依赖。

初始进程创建新 incarnation，并在接受 ARM 前记录实际 node boot、runtime 和 plugin identity。source 重启不得继续旧 live scope。coordinator 重启可以读取未变化且已验证的原 journal，包括已提交的 unpublish outcome。retention 不得移除尚未释放退役需要的 prefix。仅验证 journal 不授予 `OriginalStopped` 或 `OriginalUnpublished` 资格。

runtime 和 plugin identity 包含实际 Unix peer PID、进程 start time 与 executable digest；source 同时绑定 gateway incarnation。frontend 持有首次 kubelet 与 registrar 进程 identity，CSI begin records 绑定实际 kubelet caller。backend 重连、daemon 退出或 executable 替换使 live chain 失效。gateway 和 plugin backend 各使用一个持续连接，不得静默重连到替换进程。

## Java 来源观测

私有 Runtime operator 接受 `source-status <reviewed-source-client-json>`。封闭请求包含 `sourceOrigin`、`sourcePrincipal`、`coordinatorPrincipal`、`clientStore`、`passwordFile` 与 `caFile`。文件是部署方管理的绝对路径，client store 为仅含一个客户端身份的 PKCS12。命令在 SQL 事务外仅读取经过认证的 node-source `/v1/journal` route，不选择 Workspace，不执行集群、worker、来源控制或数据库变更。输出解析后的 source/scope identity 和 cursor，不输出凭据或物理释放许可。

客户端要求 TLS 1.3、配置的 CA、HTTPS hostname 校验，以及客户端身份和实际 server peer 各自唯一且精确匹配的 certificate URI principal。拒绝 redirect、超限 body、缺失或重复的 cache/content-type headers，以及停滞超过十秒的 body。journal reader 保留 Go 的有序 body 编码，包括 HTML 与 Unicode 分隔符转义，不对排序后的 Java 表示求 hash。验证精确字段、无符号 kernel identity、canonical frame、连续 sequence/hash/incarnation、独立 durable head、不可变原关联，以及每个显式 begin/publication/stop cursor。即使输入 chain 已正确重新求 hash，替换 cgroup/runtime image 的 stop 或替换 kubelet caller 的 unpublish 仍被拒绝。

保留的 v1 协议 fixture 包含自有 Linux source 进程的 exact bytes，source ELF digest 为 `ac051c616ee1900256da8ac6c70f449f187912c7245ccf0fdc008feb8891f14f`。任务、后代和挂载是真实的，runtime/CSI RPC provider 为夹具。它仍是历史证据，当前 v2 reader 会拒绝。新增 v2 fixture 使用合成 policy/process 值及实际 Go canonical encoding。独立 v2 验收通过 83 个 Go cases、同一组 83 个 Java parser/association cases 和 16 个 inert client/BIND cases，包括错误 digest/resourceVersion 在 mutation 前拒绝，以及 mock save 先于 gate。这覆盖本地协议与调用顺序，不建立成功 SQL 持久化、真实 TLS/gate PATCH、native policy 或 ACK 资格。观测命令不能绕过 pre-CREATE 关联、正常 UID-precondition 删除、部署资格化或未来原子释放事务。

## pre-CREATE ARM 与 containment

私有显式命令是 `serve-evidence <reviewed-runtime-json> <port> <reviewed-node-json>`，将节点依赖接入现有仅文件 provisioner。普通 `serve`、`serve-retained`、Spring 与公开 selector 不默认接入该依赖。首个候选只支持一个隔离节点和一个未释放活动 scope，不加入尚未实现的多节点 unused ARM abandonment 协议。

Evidence Pod 显式声明且只接受 `qwen-code.io/k2-evidence=isolated:NoSchedule`，以及两个标准 `node.kubernetes.io/not-ready` / `node.kubernetes.io/unreachable`、300 秒的 `Exists:NoExecute` 容忍。显式声明标准默认项，避免 API 注入后的列表长度改变预期。Provisioner 在 CREATE 及后续观察中要求 admitted list 精确相等；缺失、改变、重复或额外容忍均拒绝 handle。普通 provisioning 保留原默认准入行为。匹配容忍只允许调度到选定节点，不能建立所需的 Pod/host 隔离。

私有 evidence Pod 使用固定 `qwen-k2-worker` ServiceAccount 和 Pod AppArmor Localhost profile `qwen-k2-worker-v1`。Readback 要求精确 account，deprecated account alias 若存在也须一致，完整 profile object 保持相等。拒绝 container override、冲突的旧 AppArmor annotation、static-Pod annotation 和非空 image-pull secrets；专用 account 创建时不能继承 pull secrets。这些字段进入 admitted gated/running spec digest。字段存在不能证明 profile 已加载、account 没有其他权限或出生 confinement 已资格化；仍需完成 installation consumer 和实际 ACK 验证。

node request 是有界 16 KiB 的 closed JSON，含 `node`、`coordinatorPrincipal`、`clientStore`、`passwordFile`、`caFile`。`node` 含 `name`、`incarnation`、`identity`、`sourceOrigin`、`sourcePrincipal`、`gatewayOrigin`、`gatewayPrincipal`，以及必需的 `workerPolicySha256`。`identity` 是经过认证的 exact SOURCE_START 投影：node UID、boot ID、runtime executable digest/start/PID、gateway incarnation 和 plugin executable digest/start/PID。证书与 password file 使用部署方拥有的绝对路径，不进入 SQL 或 worker。实际节点的 source-status 输出提供这些 pins；示例或历史 fixture identity 不能资格化部署。source/gateway 使用不同固定 peer principal 和同一经审阅的 coordinator client identity。

gateway、CSI frontend、其真实 kubelet/registrar peers 和 journal 必须先于 ARM 就绪。核对实际 Node 的 exact name/UID、`status.nodeInfo.bootID` 与认证 source identity 精确相等、非删除状态及唯一 Ready=True condition，再为原 binding/reservation 取得 durable ARM。boot identity 缺失或改变，在 source control 和 SQL 前拒绝。解除 gate、接受 publication 以及确认 live original 前重复这项校验。arm ID 用 `qwen-csi-source-arm/1` domain，由原 binding ID 和 reservation UUID 确定性派生。任何 Pod CREATE 前保存经过认证的完整 prefix 和独立 head。原 scope 的 namespace、未来 Pod name、driver、volume、PV/PVC UID 来自受保护原 seed/registration；UID、container、target、retirement 保持空白。worker image digest 独立固定。

CREATE 原 bare Pod，带唯一 gate `qwen-code.io/k2-source-ready`，required node affinity 仅有 `metadata.name In [reviewedNodeName]`，不设置 `nodeName`。实际 CREATE 响应后，coordinator 使用自己的证书向 gateway 登记原 canonical UID/image，再让 source BIND 同一 UID 与 target `/var/lib/kubelet/pods/<UID>/volumes/kubernetes.io~csi/<originalPVName>/mount`。该 source 的 PV path component 仅允许小写字母、数字、连字符；不支持的 PV 名在 ARM 前拒绝。BIND 要求 target 不存在，原 gateway observation 为 pending，且 sandbox/container/PID 均未出现。

gate 打开前持久保存 BOUND。再次核对 reviewed Node，再提交固定四个 JSONPatch operation：test 原 UID、test 不透明 resourceVersion、test 完整 admitted gated spec、remove `/spec/schedulingGates`。响应必须保持该 UID 和只移除 gate 的 exact spec。之后正常 scheduler binding 设置原 nodeName；完整 running-spec digest 和原 attestation 仍必需。接受 handle 前，仅当同一连续 source 同时报告原 publication 和 retained custody，且 Pod/container/image/source/node 全部匹配时，保存 PUBLISHED。后续 live observation 要求认证 journal 逐字扩展保存的 prefix，不能替换原字节。

`managed_workspace_csi_source`（V68）有十九个 typed column，只支持 ARMED/v1、BOUND/v2、PUBLISHED/v3。保存原 binding/generation/physical/reservation、无 secret 的 reviewed configuration、完整 ARM/BIND/publication prefix 及独立 head、原 Pod UID/gated-spec digest。每个 prefix 限制 1 MiB。写入使用同 DataSource 的十秒事务，拒绝 ambient composition，先取得共同原 binding-control prefix，再取 registration/holder/source，重查原 operation owner/generation 与 DB-time lease。正常续租可推进 binding version、改变 operation expiry；其他原 binding 值必须逐项保持相等，包括 request、seed、state、drain flag、runtime lease/handle、attestation generation、activity timestamps 及保存的 evidence。即使 owner 相同，replacement claim 仍拒绝。所有 source/Kubernetes 外部操作都在 SQL locks 外。PUBLISHED 不再修改，并加入显式应用库存；它本身不授予物理 stop/release。

每个 source 操作都必须接收原 provisioning grant 与调用方单调截止时间的检查。外部响应返回后、后续变更之前重新检查，包括解除 scheduling gate 前刚返回的 Node 查询。准入还在 SQL 返回后重新检查截止时间。可见 async timeout 不会中断待返回的查询；晚到响应不能授权新的变更。检查不能撤回已发送的 HTTP 请求。已保存 handle 的观察仅检查截止时间，不重新取得 provisioning grant。

Secret/Pod CREATE、source reply、gate result 未知或后续 pre-handle 失败时保留 holder，并沿用 RECOVERY_BLOCKED。没有新增 null-handle startup recovery 或按同名 GET adoption。store 可在 coordinator restart 后读取保存的阶段，但本候选不自动恢复未完成创建。source/gateway/runtime/plugin/node incarnation 变化均拒绝旧 live chain。

响应后的校验不能证明 admission 从出生保留 gate，或其它 actor 不能 exec、bind、移除 gate。现有 storage ResourceGuard 只保护 PVC/PV/namespace。经审阅的 Pod admission/RBAC、实际 scheduler 行为和持续 containment 仍属部署资格化要求。stop-intent control 与窄 normal UID/resourceVersion DELETE 已有持久私有 coordinator consumer；完整部署资格化与 release outcome 尚未完成。

gateway 通过经过审阅的 runtime/CRI identity 发现原 task。source 固定 PID start time 和 pidfd，在固定根下无 symlink 遍历地打开原 leaf、不同的 Pod-parent cgroup directory 及 parent 的 `cgroup.events`，并持续持有这些 exact descriptors，不得通过重开替换 path 恢复控制。出生即满足的 qualified confinement、terminal task/pidfd 观察、同一原 parent subtree 的 `populated=0`、exact normal Pod delete intent，以及未变化的 source/runtime/boot identity 共同建立 stop。task 缺失、空 PID 列表、目录消失、lease 过期或 API NotFound 均不足够。观察错误阻断原 scope。

此前 retained-proc custody 候选还持续持有 exact 原 `/proc/<PID>` directory，核 procfs 类型及 device/inode，通过 `openat2` 相对该 descriptor 打开有界 `stat`/`cgroup` entry。观察原 live task 时不重开 numeric PID path。pidfd terminal 通知之后仍持有并核原 proc directory 身份；terminal 观察使用原 cgroup/events，不重开死亡或复用 PID。丢失使 custody 永久失败，每个错误/close 路径关闭全部四个原 descriptors。该 retained-proc revision 的 Common Go tests、两个 Linux 架构 build 和独立自有 Linux 验收通过：14 个 top-level cases / 28 个 leaves 覆盖实际 PID reuse、四 FD 丢失/复用、descendants、migration、path replacement 及八个 constructor capacity windows。自有 processes、cgroups、guest directories 和 VM 已关闭，完整输入/证据读回一致。仅 descriptor 绑定不提供完整 current kernel security context 或出生 confinement。

独立 Linux GC 观察使用此前 leaf-only custody 实现，真实 helper/descendant 正常退出后 Rmdir 空 child。同一原 events FD 随后返回 ENODEV，cgroup/proc Fstat 身份仍相等，原 observe 永久失败。从 helper 出生前打开的不同 parent 仍 populated0，未替换 custody。一个有界 native case、30 facts及13项完整性/关闭检查只资格化本地失败行为。runtime cleanup 可在下一次100ms poll前删除leaf，held FD或提前Wait均不保证empty观察窗口。原失败记录保留，不能通过替换events descriptor修复。

retained-parent 实现在打开原 leaf、proc-directory 与 pidfd 时，显式打开不同的原 Pod-parent directory 及其 events 文件。canonical Pod UID/container ID 必须精确匹配支持的 cgroupfs 或 systemd kubelet layout；未知布局、路径穿越或身份错配拒绝 custody。首次绑定时，还必须从已保留 leaf descriptor 相对打开 `..`，核对它实际指向同一原 parent 内核对象；仅路径名称和 filesystem device 相同不够。临时 ancestry descriptor 随后关闭。五个 descriptor 持续归来源所有。每次 observation 验证原 leaf identity、不同的同 filesystem parent identity、kernel 类型及剩余目录 link，然后只读取同一个 retained parent events descriptor。`populated` 现在表示整个原 Pod-parent subtree。parent 丢失或读取失败永久 poison custody；不从 leaf 回退，不按名称重开。v3 wire 显式固定 `coverage=retained-pod-parent/1`、`parentDevice` 和 `parentInode`；ORIGINAL_STOPPED 必须与 leaf/PID/start tuple 一起保持它们。当前打开仍发生在 publication 后首次 created/running observation，不是首次执行前的创建回执。common tests 与 Linux cross build 仅覆盖协议和路径规则；实际 native parent lifetime 验收及 immutable birth confinement 仍须完成。

Parent 包含原 sandbox 和全部 descendant，只有 worker 退出不足以使其为空。在固定的 Kubernetes v1.36.0 参考实现中，[正常清理先等卸载和 volume path 移除，再销毁 Pod cgroup](https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/kubelet.go#L2293)，[后台 orphan 清理同样在 Pod volume 仍存在时拒绝销毁](https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/kubelet_pods.go#L2658)。由此可推断，独占 CSI frontend 的 durable-stop-before-unpublish 屏障可以保留观察窗口。资格化必须在实际原 kubelet 中验证该顺序，包括后台清理和失败场景。仅 directory FD 不能阻止 Rmdir；在已验证 empty observation 之前 parent 被删除，仍须 fail closed。

## 创建输入保护边界

当前 Containers.Get 是 metadata，不是原 PID 创建时实际消费输入的回执。固定 normal runc create/start 合同提供有条件的 pre-exec 关联窗口，但必须控制实际输入对象、hook、rootfs/options、FIFO/start actor 与完整 kernel context。source 不能在正在创建的 task 尚未登记时同步要求 Tasks.Get 成功，也不能假定 start 路径持有 process lock 时可重入读取。parent 需要独立 retained object 和显式 pre-start 关联；旧 leaf 消失不能授予 parent 资格。

独立 Linux 7.0/aarch64 原型建立 private mount propagation 和全部四项 memfd seal，但首次将该 memfd 绑定到 config.json 返回 EINVAL。写入和扩容返回 EPERM；改名、rootfs 与实际 runtime-consumption 窗口均未进入。原型使用广泛 root capabilities、NNP 0、seccomp 0，不代表受限 source unit 可执行。自有 helper、mount 和 VM 已关闭。随后不同的 whole-tmpfs-bundle 原生假设在写入原型或启动 VM 之前收到潜在网络安全风险拒绝通知；它仍未验证，也未换路径执行。这些结果均不资格化 immutable creator、出生 containment、parent custody 或 release。

2026-10-13 在原 ACK 新建短时节点完成只读核实，没有安装 collector 或修改宿主配置。实际 PID 1 mount namespace 暴露 Linux 6.8.0-139-generic/x86_64、AppArmor enabled；运行时二进制、配置及 /var/lib/containerd 位于 rw ext4，/run/containerd 位于 rw tmpfs。观察到的固定二进制和配置没有 immutable 属性，保存的磁盘配置声明 CDI enabled、NRI 未禁用。这些 metadata 不证明 filesystem 保护能力、运行中 runtime 实际消费的输入、受限 loaded profiles 或首次执行前约束。核实后正常释放唯一节点、实例、系统盘和密钥，原节点与 CSI 服务健康。本阶段不授予 installation、stop、unpublish 或复用资格。

## 原 task lifetime Wait

完整 preterminal 原 CRI/task tuple 建立一个私有 background Tasks.Wait，使用同一已固定 runtime connection、固定 k8s.io namespace 和空 ExecID。context 属于 gateway lifetime，不受五秒 HTTP observation 限制。最多一个 Wait 活动，immutable registry 仍限定4096个 originals。启动 goroutine 不等于 armed acknowledgment。late NotFound、cancellation、connection unavailable、畸形响应或不能往返为正 signed nanosecond 的 timestamp 均永久 block 原 task。gateway close 取消活动 Wait，关闭已固定 connection，取得 observation lock 后在五秒内 join watch。goroutine 只写有界私有 result channel，不修改 source/registry state。全部读取后再次检查 observation deadline 和 gateway lifetime，再保存 association 或启动 watch。

仅 native Wait 成功才能在预期 task/CRI cleanup 后保存原 exact PID/CID/SID/UID/image 和 exit status/time。每次 observation 仍复核全部存在的 identity（sandbox listing 按原 SID 或 UID 任一匹配，然后要求两者同时相等），发现 replacement sandbox 或额外 container，并拒绝任意 RPC error 或已保存 terminal 后仍存在的 live task。task STOPPED 但 CRI 仍 RUNNING 是正常退出过渡；CRI EXITED 时必须匹配 exit code 和 FinishedAt。存在的 Tasks.Get terminal fields 也必须匹配保存的 native result。不从 metadata 缺失推断 outcome，不补 PID0、timestamp 或 exit status。source 原有联合要求不变：实际先前 RUNNING security 检查、原 pidfd terminal 和原 cgroup populated0、连续 policy/runtime/boot、原 publication 及正常 delete intent 满足后才可 OriginalStopped。新的retained-parent候选尚未继承native lifetime资格。

独立旧 generated-client fixture 复现 late-Wait consumer 四个失败，同时两个 controls 通过。独立验收通过这些退出窗口，但发现矛盾 sandbox-list UID 及读取途中 cancellation guard 遗漏。精确修后76候选使用相同observer bytes/payloads/expectations，通过全部59个实际generated-client lifecycle leaves及original common tests；13项完整性/清理检查通过。覆盖native errors/time bounds、identity/metadata conflicts、一个活动watch及lifetime closing。fixture真正阻塞preterminal Wait并提供exact CRI FinishedAt，旧失败输入原样保留。这不提供实际CRI/Tasks、mTLS、birth、ACK runtime或physical资格。

## 当前进程 credentials 检查

Gateway 现在还在同一已固定 runtime connection、固定 `k8s.io` 中调用真实 typed `Containers.Get`，仅查询为已登记 original 发现的 CID。在建立 lifetime Wait 前，核匹配的 Pod/container/kind labels、runtime name、OCI Spec type、image/snapshot 身份及有界完整 metadata object。只保存 deterministic protobuf bytes 的 SHA-256，排除可变 bookkeeping `UpdatedAt`；Spec、runtime options、extensions、labels、creation timestamp 及其余所有字段保持固定。后续每次 original observation 复核该 digest。缺失、变化或畸形身份、超限 metadata 及任何 RPC error 永久 block 原对象。只有已建立的 native Wait 得到同一完整 terminal tuple，且此前存在 metadata pin 时，才接受 metadata NotFound。不返回或记录 raw metadata、Env、Args。

这仍是当前 metadata observation，包括首次看到原 CREATED task 时，不能识别原 runc input object，也不能证明此前未发生 mutation。Birth 资格仍需要完整 consumed-input producer，以及 retained running namespace/root 检查。Common protocol tests 与 Linux cross build 覆盖新增读取；实际 generated-client 和原目标兼容性是单独验收边界。Gateway 仍不暴露通用 containerd relay 或 task mutation method。

候选在原 pidfd/start/cgroup 检查成功之间，通过已持有 proc-directory descriptor 读取原 running task 的 `status` 和 `attr/apparmor/current`。要求四项 UID/GID 及唯一 supplementary group 全为1000、五项 capability set全0、NoNewPrivs=1、Seccomp=2且filter count为正、TracerPid=0及exact worker enforce label。首次观察后这些security值必须保持相等。畸形、重复、缺少必需status字段或label变化永久失败，不暴露raw status。不相关kernel status字段，包括x86 thread features，不提供security evidence。

CREATED observation可能先于worker on-exec profile切换，不能视为本项running检查成功。原stop必须已有一次成功running检查；未观察到就终止的task拒绝。source还分别核其当前locked OS thread的四项root UID/GID、唯一root group、effective/permitted/bounding set仅SYS_PTRACE、inheritable/ambient为空、NoNewPrivs=1、filtered seccomp及无tracer，并保留已有enforce-label/namespace检查。unit文本不能代替这些实际kernel值。

这些检查仍为implementation candidate。独立验收通过77个语义用例和4个实际Linux worker拒绝用例，包括所有必需数字security字段正确但label为unconfined的task；实际locked source thread也被拒绝。自有资源全部关闭。未安装或资格化受限enforce-profile正向；合成parser验收及cross build不能资格化这些LSM权限。完整confinement仍需namespace/root descriptors、解释后的mount/cgroup写权限限制、完整OCI seccomp/options及immutable birth provenance；这些process检查没有将实际消费的creation input或完整context加入journal。物理释放保持关闭。

## 已加载 worker policy 与 admitted BIND 候选

当前来源候选使用 `qwen-k2-node-source/4`，包含上述显式 retained-parent custody tuple。ARM 保留 v2 的原 image digest，以及内核中固定 `qwen-k2-worker-v1` profile 的实际测量。source 配置与经审阅 Java node 配置必需 `workerPolicySha256`，其值为经审阅 packed policy artifact 在内核导出后的 digest。profile 名称、磁盘文件或 operator 断言不能代替该测量。旧 v1/v2/v3 journal 保留为早期有界测试的历史证据，当前 reader 拒绝它们；改标签或补合成 parent 字段不能建立 v4 evidence。v3/v4 contract fixture 明确是合成协议输入，不是实际 parent 测量或 birth record。

固定 Linux reader 通过内核明确的 magic link 进入 `/sys/kernel/security/apparmor/policy`，随后持续持有实际 AppArmor filesystem root。普通 profile entry 在该根下打开，不跟随任意 symlink。读取并验证 profile 明确的 `raw_data` link，仅接受指向同一根 `raw_data` 子树的相对引用。同一经审阅 packed bundle 同时包含固定 worker/source profile，两者唯一当前 entry 必须指向同一导出 raw object；source 实际 label 必须为 `qwen-k2-source-v1 (enforce)`，避免仅 source profile 名称代替其实际 policy bytes。持续持有导出字节 descriptor，对完整有界解压 blob 求 hash，并在读取前后核对两者当前 profile link、mode、namespace/load revision 和 object identity。重读已持有旧 blob 不能建立当前 policy。内核 signed-long revision 使用 `Long.MAX_VALUE` 内的 canonical decimal string，load revision 不得大于 namespace revision，ABI 限制为 v5 至 v9；kernel device/inode 保留完整无符号范围。固定 proc/sys anchors 与当前线程 namespace descriptors 均核对实际内核 filesystem 类型。打开内核 raw snapshot 前先核导出尺寸；完整 snapshot 和 kernel raw SHA 均须等于经审阅 artifact。持续持有的 revision stream 只读一次，后续必须返回 EAGAIN，不能重新打开来恢复 custody。

本候选要求 source 使用 initial user namespace、root AppArmor namespace 和固定 source enforce label，实际 global mode 为 enforce，且实际 `lock_policy=Y`。所有必需 profile 必须先于 lock 加载。之后，包含不推进 namespace revision 的 global-mode 修改在内，普通 AppArmor policy 修改须由内核 locked-policy 边界阻止。source 只读取这些值。设置全节点 lock 是独立安装动作，须另行取得具体明确批准；现有 CSI guard 批准不授权它。提出该动作前，仍需验证实际 ACK vendor 语义、必需 runtime/sandbox profile 和 source 的受限 policy。AppArmor 会对内部 policy filesystem 的 disconnected path 进行路径介入，因此受限 source 需要经过审阅的 source 专用连接行为、固定独立 prefix 和实际 exporter 子树的窄只读权限；普通 `/sys/kernel/security/apparmor/policy/**` 规则不能提供该访问。目标 parser 支持、一次完整 binary set-load 同时加载两个 profile、alias 排除和真实 LSM 权限仍是 native 安装要求。worker 不继承 source 的连接行为，source 也不能回退到 unconfined。

2026-10-11 23:49:10（当地时间），实际 ACK 实验节点的 AppArmor parser 4.0.1 对 source 专用 disconnected prefix 语法夹具编译两次，没有加载。完整 7107 字节产物相同，SHA-256 为 `c4d4e12f07cdf86722ca3b15985ea4017cfbea585a4ef617d946f762b6d88054`，使用同一份完整目标 feature snapshot 和空 compiler config。这提供了目标语法证据。空 worker 与仅 exporter 规则的 source profile 均为语法夹具；可运行经审阅 bundle、一次完整 binary set-load、实际 exporter 权限和 alias 排除仍须完成。policy lock 保持关闭，专有编译文件已删除。

BIND 增加经过认证 coordinator 提供的实际 admitted gated-spec digest 和不透明 Pod resourceVersion。client 将返回 record 与同一次实际 CREATE 值核对，SQL store 将保存的 BIND record 与 gated-spec 列核对；之后现有 UID/RV/whole-spec JSONPatch 才可移除 gate。source 记录只认证 coordinator input，其含义仍依赖实际 API readback、admission 和 actor 边界。

每次 live ARM、BIND、stop-intent、poll 和原 publish/stage/unpublish pre/post call 都复核原 policy measurement，包括 durable stop 后到 unpublish 前。durable 原 publication 之前发现原 task 会拒绝；当前 parser 同样要求依次 BIND、PUBLISH_OK、CUSTODY_OPEN。已完成 unpublish 的重放和后续普通 unstage 不创建新 source evidence。ARM 后、BIND 前的丢失也必须持久 `CONFINEMENT_LOST`，永久阻断原 scope。未知 append outcome 使 source poisoned。已完成的原 unpublish history 可继续读取，但下次 ARM 不能继承旧测量。本阶段尚不提供 immutable OCI birth provenance、实际内核 task confinement、迁移/逃逸排除或 qualified release writer；仍需完成这些 consumer 和实际部署验收。

## 实验 runtime 配置

准备阶段先观测到实验节点禁用 AppArmor、启用 CDI/NRI。原 version 3 文件无 imports，SHA-256 为 `7be63dc11bf1ddce602ea7dd6605b26cc2df20aa2b2eaa33a8c0eb87a5dafff5`。用户另行明确批准只将 `disable_apparmor` 改为 false、`enable_cdi` 改为 false、NRI `disable` 改为 true，随后进行一次普通 containerd restart。原准备工具保留其他所有字节和值，核实际 executable/unit/已加载重启边界及 exact owned revision，先保存 private fsynced 原 backup，再原子替换。同一 62 个 inert 恢复用例已独立通过；实际没有需要执行的 rollback，也不资格化真实恢复。

2026-10-12 08:24:33.384332（上海时间），批准动作 enqueue 一次普通 restart。08:25:40.432115，即 67.047783 秒之后、位于 120 秒观察窗口内，实际 runtime 为 active/running，新 PID 494348、startTicks 4183750，boot 未变。磁盘 config SHA 为 `b5c2d85fc93f55b1b1aebc0dcbd49d6287e14f894c5e2d6ce2c18b051c8e4237`；root-private backup 为0600、SHA等于原文件，节点内部重新验证 exact rewrite 关系。实际 binary 解析 version 3 输入并输出 version 4 dump，磁盘文件没有迁移。没有提交 rollback 或 recovery restart。enqueue 和两次快照不能证明期间不存在其他自动 restart。

正在服务的 daemon 实际 CRI Status verbose 返回 `disableApparmor=false`、`enableCDI=false`、RuntimeReady=true、NetworkReady=true。NRI 磁盘设置已禁用，但其有效状态不在已审阅公共 API 中。08:37:06.997604 的只读诊断确认唯一弃用提示为 `io.containerd.deprecation/enable-cdi`；无弃用提示条件为 false 不表示两个 Ready 条件失败。完整有界 reply 仅在内存解析，保留安全字段及摘要。这些 endpoint 读取及前后进程核对不提供同连接 FD peer 证明或 runtime 缓存的 AppArmor HostSupports 值。

前后认证 API 与 host 检查确认节点 exact UID、boot、cordon/隔离 taint、6个系统 Pod身份/状态、原两个 Ready 节点/CSI Pod，以及 CSI guard/DaemonSet 身份和完整 spec 保持。121个 loaded profile entry 和完整摘要相同，policy lock 仍关闭。没有 K2 worker、CSI publication 或默认 plugin 替代；已有系统卷和一条非CSI subpath仍存在。独立本地 artifact audit 通过56项一致性检查。本批准阶段没有安装 collector、K2 profile、backend 或 registrar，也没有写 policy lock。原24小时/25元上限和2026-10-12 20:46:55上海时间清理截止不变。未来普通容器 CREATE 仍可能触发 runtime 默认 profile 加载。

实际 containerd/shim revision `4eddfe81d0f9aaaa4363faf25c473a874ce2ee2e` 和 runc 1.4.3 revision `bb14dab` 与已读 upstream reference 不同，不能从版本字符串转移源码语义或出生资格。当前 `Containers.Get` metadata pinning 已实现为 observation 检查。Retained running-task namespace/root context 和 consumed-input producer 仍须实现；合法 metadata/resource 更新可替换 Spec，当前 metadata 不能重建 birth。实际消费的OCI/runtime/task/rootfs inputs必须在untrusted execution之前由原creation boundary记录，前后相同hash不能提供该证据。固定upstream使用API1.11.1，本gateway为API1.9读模型，仅Containers proto作静态对比；Tasks存在较新creation fields，完整兼容未资格化。CREATED task的AppArmor on-exec设置不是实际running label。物理释放前须验证Any/Options/spec字段、runtime执行边界和完整child confinement。

## CSI frontend 与因果 stop barrier

在隔离节点上，registrar 和 kubelet 使用 frontend socket；原 driver 使用仅 driver 和 source 可访问的 private backend socket。部署必须排除同 driver 的直连 registrar；重连或绕过 frontend 使原 scope 失效。

对于已登记的 exact driver/volume/target/Pod/node/plugin chain，forward 前持久 `PUBLISH_BEGIN`。实际 backend 成功后核对原 target identity，持久 `PUBLISH_OK`，再返回成功。未知已有 mount 不能开启 qualified chain。未登记请求保留普通 CSI forwarding 语义，不得生成 K2 receipt。

target 固定为绑定 Pod UID 的 kubelet path。kernel `statx` 观察 device、inode 和 mount ID，不持续持有会固定 mount 的 target descriptor。publication 成功要求 target mount ID 与 parent 不同；unpublish 成功要求 target 不存在或回到 parent mount。已保存 publication 的 retry 必须匹配原完整内存 CSI request 及实际 target identity。secret 只保留为临时 request data，不序列化到 journal。

调用 exact original `NodeUnpublishVolume` 前，必须已有同 incarnation/publication chain 的持久 `ORIGINAL_STOPPED` cursor。持久带显式 publish/stop dependencies 的 `UNPUBLISH_BEGIN`，调用实际 backend，再持久 `UNPUBLISH_OK` 后返回成功。backend 失败或未知 outcome 保留记录。同 chain 重试可复用已完整持久的成功；无原 chain 的空 target 成功、无关 target、unstage 或 detach 均不能替代。wall-clock 顺序仅供诊断。

## coordinator、释放与复用

私有 pre-CREATE ARM/UID/gate 和正常 UID/RV-precondition DELETE 已实现为候选。在接受原 Runtime 前持久不可变 ARM/publication 关联。[私有物理进度设计](2026-10-11-k2-physical-completion.zh-CN.md) 定义独立六列 companion catalog、完整 same-Connection DRAINED 验证、durable plan/intent/attempt/outcome 与 exact source-prefix extensions。SQL locks 外导入认证 source bytes；当前命令只记录到 UNPUBLISHED，保留 DRAINING ownership。完整当前 Hosted-to-physical SQL 验收待完成。

物理完成在同 Connection 持久独立 qualified outcome，仅将原 binding 置为 terminal，仅清除其占用 slot，仅释放其 physical holder。保留不可变 DRAINING intent、cut 和 receipt。holder 使用实际且检查 overflow 的 revision：0→1→2→3→4→5→6。新 Session 创建 fresh request slot 与 binding，其 numeric runtime generation 可以再次为 1；这个计数与 shared holder revision、原 native writer/activation epoch 不同。历史 retry 在另一个 owner 预留该卷后仍返回原已提交 receipt。

实际来源资格化与 release 验收通过前，public selection 和物理释放保持关闭。operator 提供的 completion boolean 或伪造 source record 均不能启用它们。

## 打包与验收

[Host service 候选](../../deploy/k2-evidence/README.zh-CN.md#host-service-部署候选) 提供两个 static unit、私有目录规则和 executable-digest startup check。它们保留 host PID/user/cgroup namespace、建立私有 mount view，仅保留候选 proc-read capability，并拒绝 tracing、process-memory、pidfd signalling 和 namespace-changing syscalls，不自动开机启用或 restart。较早的 units 通过了下述有界自有 Linux 功能测试。当前 source unit 新增强制 `AppArmorProfile=qwen-k2-source-v1`，改变后的 unit 与新 policy reader 不继承旧结果；它们的 native 验收与 ACK 资格化待完成。安装前需验证目标 systemd version、实际 peer capability sets、LSM 限制及所需 proc/cgroup/socket 操作。[systemd execution 文档](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml) 区分 host cgroup read-only 设置与 private cgroup namespace，并说明 incoming mount propagation；新 CSI submount 仍需强制只读边界。原 Pod actor/admission 边界和独占的选定 driver/registrar 是另外的前置条件。

涉及独立 Go 模块的 gateway、custody、CSI proxy 和 journal；isolated-node deployment artifacts；私有 Kubernetes client/provisioner；physical source/outcome persistence 和窄 release consumer；holder revision readers 及后续 qualified public selector。固定依赖，可复现构建 Linux binaries/images，记录实际 digest。server jar plugin 强制在 Boot repackage 前生成普通 jar，避免 incremental package 留下旧 nested broker。自有两次 package 实验验证仅 broker 变化时，四个 classified jar 和主 Boot jar 均更新。安装申请前准备可审阅 deployment；本文不是安装 privileged 软件的授权。

本地验收覆盖真实 journal 磁盘 I/O 与失败恢复、证明 method allowlist 的 owned Unix-socket runtime fixture，以及证明 forwarding、持久顺序和 exact retry/error 行为的 owned CSI backend。fixture 仅资格化协议行为。Linux 验收必须使用实际持续持有的 pidfd/cgroup descriptors、已终止后代，以及迁移/restart/gap 失败闭合案例。ACK 验收必须建立 pre-CREATE ARM、原 publication、真实正常 stop、实际 unpublish 和原子 release，随后跨 tenant 复用同 volume 且不能继承旧 evidence。仍需两次完整 clean audit 和 maintainer review。

[原 ACK 排除组件](../../deploy/k2-evidence/ack-existing-cluster/README.zh-CN.md) 为一个新 Node 的已知 addon Pod 生成持久独立 VAP，保留原 CSI DaemonSet 和共享节点。2026-10-11 用户批准的实验已安装 exact policy/binding，取得匹配 generation、完成且无告警的 typeChecking；新节点 direct/controller-affinity dry-run 被拒绝，原两个节点的 dry-run 获准。使用原 UID/RV 正常删除新节点默认 CSI Pod 后，真实 controller FailedCreate event 明确引用该 guard；有界 host closing 未见原 plugin/registrar 进程、原 CRI container、六个 socket 路径或 CSI publication mount。原 Node/CSI Pod UID、Ready 状态及 DaemonSet spec 未变。未安装 collector/private backend/新 registrar。这些带日期冷安装准备观测不资格化原 worker lifetime 的持续 custody、所有在途/绕过排除或 release。guard 保留到自有 Node 消失，到期清理已纳入两个 actual owned UID。Binding、static/host workload、其他交付路径、policy 修改权限及完整 confinement 仍需资格化。授权目标仍为原 ACK，不得转移不同 binary/configuration 的资格。

## 精确 worker CREATE 与 gate-only UPDATE 候选

扩展现有离线 worker-access renderer，增加两个独立 Fail/Deny policy，分别保护主资源 `pods CREATE` 与 `pods UPDATE`，保留现有 exec/binding/正常删除规则。必需的有界 closed worker-plan 只含原 `provisionRequestId`、固定 image digest、base command、注册 PVC/mountRoot 和有序 artifact ConfigMap 名称。按生产 canonical JSON SHA-256 规则派生 exact prospective Pod/Secret name。缺失、未知、重复/大小写别名字段、不安全路径、非固定 image 或超限值均拒绝渲染。输入必须在 CREATE 前从原持久 provisioning plan 导出并审阅；renderer 自身不读 SQL 或证明该来源。

CREATE 要求固定 namespace 内独立 coordinator、原 exact name、唯一固定 runtime container、固定 worker ServiceAccount/AppArmor、原 volumes/command/resources/placement 与唯一 source gate。按固定生产模板和已记录 native defaults（含复制的 ephemeral-storage requests）关闭所有支持的 Kubernetes 1.36 PodSpec 及嵌套字段；其余已知字段必须不存在。字段清单固定 primary API source，安装前须核 target API schema/typechecking；新增或 vendor 差异 schema 不继承本候选资格。Namespace UID 与实际 admission namespace object 比较，不作为 opt-in annotation match。

UPDATE 仅允许同 coordinator 在尚未分配 Node 时一次移除原 sole gate。要求原 UID 与受控 metadata 不变，重核 exact ungated template，并将其余每个已支持 PodSpec 字段的 presence/full value 与 oldObject 比较。不使用不存在的 CEL removeKey 或 recursive-subset equality。现生产 UID/RV/whole-spec JSONPatch tests 和 durable BOUND 检查仍必需。renderer 不保护其 policy 免遭有权限主体修改，也不授 loaded AppArmor、实际 actor/RBAC、host bypass 或出生 confinement 资格；安装验收前仍需 native API typechecking 与真实正负准入测试。这些对象不授予释放许可。

原 host-service 候选通过 systemd syntax 检查，但实际 BIND 失败：`RestrictSUIDSGID=yes` 让必需的 `openat2` 返回 `ENOSYS`。更新的 source unit 关闭这一特定 filter，保留其他限制；gateway 仍保留该 filter。source 不替换为更弱的 path resolver，经审阅的 LSM policy 必须覆盖 set-ID 文件创建与修改。在当前强制 source AppArmor profile 和 v2 policy reader 加入之前，较早的 exact unit 候选在自有 Ubuntu 26.04.1/aarch64 Linux 7.0/systemd 259.5 通过 333 项主链检查、46 项出生后 BIND 拒绝和 223 项 registrar 死亡拒绝。真实 UID 1000 tasks/descendants、持续持有的原 pidfd/cgroup FDs 和 mount transitions 与十条 source journal 独立绑定。所有自有 units、processes、mounts、cgroups、临时路径和 VM 已关闭。Runtime/CSI RPC backends 明示为夹具，LSM 为 unconfined；这些结果不资格化 ACK artifacts、受限 LSM、admission、release 或 reuse。原 trace 与失败仍保留。
