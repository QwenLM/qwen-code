# 原 ACK 隔离节点 CSI 排除候选

[English](README.md) | [简体中文](README.zh-CN.md)

状态：2026-10-11 已获用户批准并安装审阅过的 CSI 排除 policy/binding，正常删除新节点默认 CSI Pod。尚未安装 collector。目标为原 ACK
`c679c4016ff0b4872aa43a2b6688343e8`。原共享节点 `cn-beijing.10.135.59.8`
与 `cn-beijing.10.135.59.9` 不属于实验范围，生成器拒绝这两个名称。本组件只
排除 addon，不构成完整 admission/confinement contract 或物理释放资格。

Kubernetes 文档说明，DaemonSet controller 将创建的 Pod 的 required node
affinity 替换为选定 Node 名称，因此可在 admission 拒绝新节点的 CSI Pod，
保留原 DaemonSet template。实际原 ACK admission dry-run 已拒绝新节点 direct/controller-affinity 请求，允许原两个节点 affinity 请求；正常删除后，真实 controller FailedCreate event 明确引用已安装 policy/binding。[DaemonSet 调度](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
ACK 文档说明 1.30 及以上版本集成 VAP；每次安装仍需在 live 环境验证 API discovery、权限、type checking 和实际拦截。本次带日期实验已完成 CSI 排除对象的这些检查。[ACK VAP 支持](https://www.alibabacloud.com/help/zh/ack/ack-managed-and-ack-dedicated/security-and-compliance/use-validating-admission-policy-as-a-security-policy-engine)

## 生成与审阅

只读取得新建自有 Node 的实际信息后，生成到新的本地文件：

```sh
python3 deploy/k2-evidence/ack-existing-cluster/render-csi-exclusion.py \
  --node ACTUAL_NEW_NODE_NAME --node-uid ACTUAL_NEW_NODE_UID \
  --policy-name qwen-k2-isolated-csi --binding-name qwen-k2-isolated-csi \
  --output /absolute/new/csi-exclusion.json
```

命令不访问集群、不覆盖文件。输出两个 native API objects，固定
`failurePolicy=Fail`、CREATE/core-v1/Pod matching 与 Deny binding。只选择
kube-system 中已知 `csi-plugin`、`csi-plugin-non-ecs` 的 app label 或
DaemonSet owner name。Predicate 覆盖直接 nodeName 及每个 required-affinity
OR term；只有 metadata.name In/NotIn 显式排除受保护节点的 term 才算排除，
label expression 不能提供外部 Node lookup。已选 addon Pod 没有约束 affinity
时保守拒绝；明确指向其他节点的 generated Pod 通过这一 predicate。

Node UID annotation 只供审阅固定身份，不是 admission-time Node lookup 或
authority。安装前及整个实验中核对 fresh 实际 name/UID。未知 addon label/
owner、其他 privileged workload、Pod binding、exec、ephemeral container、
static Pod、host administrator 与 runtime socket access 不在本组件覆盖范围。
VAP 无法保护它自己的 REST API policy/binding resources；实际修改权限和
持续 identity/spec 检查是另外的要求。[VAP 限制](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/)

## 拟议安装顺序

补齐下述输入后，这些具体原 ACK 资源与 host 软件动作需要批准。本顺序不改
原 CSI DaemonSet，也不重接共享系统节点 socket。

1. 建立一个自有实验 node pool，手动容量并设置调度隔离 taint。不创建 K2 ARM、
   worker 或 publication。取得新 Node name/UID/boot、所有已分配 Pod、driver
   process、socket、mount 和卷 publication。存在未知 selected CSI publication
   或 writer 时，不能开始冷安装。
2. 验证 live VAP API/RBAC 和实际 generated CSI requests。审阅 exact rendered
   objects，dry-run 创建，再仅安装这些新 policy/binding 名称。要求当前
   observedGeneration、无 expression warning，并实际拒绝新节点 CSI 请求、
   允许原节点请求。本次实验在正常删除前完成了这些 CSI 排除检查。
3. 使用实际 UID/RV 正常删除且仅删除新节点的 default CSI Pod。确认其 driver/
   registrars 和原 Unix connections 已终止，旧 endpoint 无法使用或重新注册，
   已安装 policy 拒绝 controller 重建。Pod NotFound 或有限时间无 Pod 的 watch
   本身不证明这个边界。不触碰原两个节点的 CSI Pod。
4. 在新节点冷安装经过审阅的 private driver backend、唯一 source frontend、
   registrar、runtime gateway 和 durable journal。固定实际 image/executable/
   configuration digests、peer identities、host systemd/LSM 限制和认证角色，
   确认无 public backend 或其他 registrar 路径。默认 addon tag 不是 artifact pin。
5. 资格化完整 Pod actors/RBAC/admission 与出生即 nondelegated confinement。
   然后才在首个 K2 worker Pod CREATE 前 ARM，关联 gated exact UID、打开
   scheduling gate，接纳实际 publication/custody。Node 创建及此前空 default
   plugin 启动与这个原 worker lifetime 不同。
6. 在同一 actual installation 完成 normal stop、causal unpublish、qualified
   atomic release 和 safe reuse。Exclusion policy、认证 journal 或本地协议
   fixture 均不能单独授予 release。

## 受限 worker 访问候选

`render-worker-access.py` 为一个专用 `qwen-k2-` namespace 输出五个独立的
Fail/Deny policy 及 binding。它不访问集群，拒绝覆盖输出、两个原 system
Node、默认或固定 worker 的 coordinator ServiceAccount，以及相同的 coordinator/scheduler
身份。发现环境后提供实际 namespace/Node UID 和认证用户名：

```sh
python3 deploy/k2-evidence/ack-existing-cluster/render-worker-access.py \
  --node ACTUAL_NEW_NODE_NAME --node-uid ACTUAL_NEW_NODE_UID \
  --namespace ACTUAL_QWEN_K2_NAMESPACE --namespace-uid ACTUAL_NAMESPACE_UID \
  --coordinator-user system:serviceaccount:ACTUAL_QWEN_K2_NAMESPACE:ACTUAL_COORDINATOR \
  --scheduler-user ACTUAL_SCHEDULER_USERNAME --name-prefix qwen-k2-worker-access \
  --worker-plan /absolute/reviewed/original-worker-plan.json \
  --output /absolute/new/worker-access.json
```

这些规则明确拒绝该 namespace 的 exec/attach/portforward/proxy CONNECT、
ephemeralcontainers/resize UPDATE 和 eviction CREATE。Pod binding 只允许审核过的
scheduler 指向唯一实验 Node。正常 Pod DELETE 要求独立 coordinator、非空名字、
原 UID/resourceVersion 匹配、30 秒宽限和 Background 传播；拒绝集合删除、
orphan 选项以及忽略存储错误的不安全删除。DELETE 比较 `oldObject` 和
`request.options`；CONNECT 与 Binding 分别处理各自输入结构。
[准入请求变量](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/#validation-expression)

必需的 worker plan 是 closed JSON：`schemaVersion: 1`、原 `provisionRequestId`、固定 `image`、原 base `command` 数组、注册 `pvcName`/`mountRoot` 与有序 `artifactConfigMaps` 数组，不包含 boot Secret data 或凭据。CREATE 前必须从原持久计划取得 exact 值；离线 renderer 不证明 SQL 来源。prospective Pod/Secret name 使用生产的 JSON-quoted request ID SHA-256 规则。缺失/重复/未知/大小写别名字段、不安全路径、非固定 image 及超限值均在输出前拒绝。plan 上限64KiB，command 上限32项/32KiB，chunks 上限48个唯一名；mountRoot 不得覆盖受保护 runtime 路径。

CREATE 只允许 coordinator 创建 exact 原 gated 模板，含固定 worker account/profile、唯一 runtime container、完整 command/volumes/resources/placement 及已记录 defaults。UPDATE 只允许同 coordinator 在未分配 Node 时一次移除原 sole gate，保持 UID、受控 metadata 和其余每个已支持 spec 字段的 presence/value。CREATE/gate 规则明确枚举固定 Kubernetes 1.36.2 schema 及嵌套字段；primary source digest 保存在 `worker-pod-schema-v1.36.json`，安装前须核对 target schema 与 native expression typechecking。每个 validation 都将 namespace UID 与实际 admission namespace object 比较；match 仍用 namespace name，避免 namespace 重建跳过验证。Binding/正常删除也要求原 exact derived Pod name。

这些对象不读 SQL ARM/BOUND/DRAINED、不保护 policy 配置免遭有权限主体修改、不控制直接 kubelet/runtime/static-Pod 入口、不证明 actual actor/RBAC、loaded AppArmor 或出生 confinement。现有 UID/RV/whole-spec gate patch 与 durable BOUND 检查仍必需。worker guards 尚未安装，Kubernetes schema/typechecking 和真实准入验收仍待完成；本地表达式夹具不能建立这些事实或授予释放许可。

## 必需输入与撤销

Evidence worker 现在在 gated 与已开 gate 的模板中选择固定 RuntimeClass
`qwen-k2-runc-v1`。CREATE/gate 守卫要求同一字段；Java node-evidence reader
要求真实 class 具有该 name/handler、canonical UID，且不存在删除、overhead 或
scheduling 字段。[runtime-class.json](runtime-class.json) 只提供此 class 对象。
任何获准安装前，仍须实现并核实实际专用 handler/shim、effective options、实际
消费的创建输入及 confinement。Class GET 或此 manifest 不会安装 handler，不
证明执行了哪个 executable，也不授 birth/physical-release 权限。Coordinator
RBAC 必须包含对这个唯一 `node.k8s.io` RuntimeClass 的 GET；runtime client 没有
新增 class 写接口。

已批准的实验节点 `cn-beijing.10.135.59.36` 于 2026-10-11 创建并设为不可调度。实际 Node UID 为 `8a55980c-65ba-4084-ab2b-083111ae39d9`，boot ID 为 `faf605a4-7552-43f2-bb15-524407ce9f2e`。经过认证的内网 API 与 host namespace 读取一致：Ubuntu 24.04.5、Linux 6.8.0-139、systemd 255、AppArmor 已启用、containerd 2.3.4。API 报告 `v1.36.2-aliyun.1`；原两个节点仍为 Ready 且可调度。这些是一次性实验节点的带日期观测，不能作为可移植部署 pin。

2026-10-11 北京时间22:14:59，已批准的正常30秒/Background DELETE 使用原 `kube-system/csi-plugin-sz7rn` UID `4887f01a-6353-418c-9cb3-57fbb9b5416c` 和 fresh resourceVersion。删除前实际 API/host 未见 worker、PVC/inline-CSI、VolumeAttachment 或 CSI publication mount。实际 policy `qwen-k2-lab-exclusion-9ff330b1` UID 为 `47e33014-b3a4-4f4c-9d10-60c10dedd63b`，generation/observedGeneration 均为1，typeChecking 已完成且无 warning；同名 Deny binding UID 为 `88943877-0c7d-4276-9b8e-baaa561f63f9`。四个真实 admission dry-run 全符合预期，测试 Pod 未持久化；实际 DaemonSet 重建也被这两个对象拒绝。

22:15:34 的完整 host 读取未见原 plugin/registrar 进程或原 Pod CRI container；disk/nas/oss 六个 plugin/registrar socket 路径均不存在且连接返回 ENOENT，无 CSI publication mount。原 Node/CSI Pod UID 未变且均 Ready，DaemonSet spec 的 canonical JSON 全值不变。这是有界冷安装准备观测，不建立原 worker 的持续 custody、所有绕过控制或物理释放资格。原 plugin image digest 为 `sha256:f3dde54782067d2441ed1c784db0432e25056d298536903a3067b026e32afbbf`，registrar image digest 为 `sha256:2c20e8022f88c8fed7e32445b78d4c3b7c879fd0d62fdf3b9c07192258c5a8d9`。

完整有界 host 读取还确认 kernel AppArmor binary export 可用、namespace revision 为106。一份已有 profile 的实际 raw bytes 摘要与 kernel `raw_sha256` 相等；这仅验证导出接口，不证明 `qwen-k2-worker-v1` 已安装。删除前观测到的 runtime、kubelet、plugin 和 registrar 均为 unconfined。真实进程 executable digest、namespace、选定 socket 身份及 kubelet 实际配置摘要已保留，供具体安装审阅使用。

23:38:26 的独立只读观察确认原 boot 未变，实际 AppArmor parser 为 4.0.1（`4.0.1really4.0.1-0ubuntu0.24.04.7`），可执行程序 SHA-256 为 `6bc852b37807961c14976be9a227ae96bd817f73b5189cb0e0ff5eca4448c01c`，内核支持 set-load 及 ABI v5 至 v9，实际模式为 enforce 且启用 binary/hash export。节点级 policy lock 仍为关闭。

23:49:10，同一实际 parser 使用 `--skip-kernel-load --skip-cache`、空 compiler config 和同一份完整目标 kernel/policy feature snapshot，对包含两个 profile 的语法夹具编译两次。两次均成功，完整 7107 字节产物相同，SHA-256 为 `c4d4e12f07cdf86722ca3b15985ea4017cfbea585a4ef617d946f762b6d88054`。实际 feature snapshot 为 2503 字节，SHA-256 为 `21b452bc7b0c19173f5348fdebdbe8c0f4da67ac80d0ddfac86fd3474fe4f631`。这验证了目标 compiler 对 source 专用 `attach_disconnected.path=/qwen-k2-apparmorfs` 语法的支持。空 worker 与仅 exporter 读取规则的 source 夹具不能运行生产 worker 或服务。没有加载 profile、写入 policy parameter 或安装 collector；专有临时文件已删除，lock 保持关闭。完整可运行 bundle、native set-load、alias 排除和实际 confinement 仍待完成。

2026-10-12，另行批准的 runtime 三键准备与一次普通 containerd restart 已仅在此实验节点完成。上海时间08:25:40，新 runtime 为 active/running，实际 CRI flags 为 `disableApparmor=false`、`enableCDI=false`，RuntimeReady/NetworkReady均true。保留原格式的磁盘配置禁用NRI，其有效状态仍未资格化。后续只读诊断仅确认 `io.containerd.deprecation/enable-cdi` 提示。6个系统Pod、原两个节点/CSI Pod、guard/DaemonSet spec及全部121个loaded profile entry前后保持；节点仍不可调度，policy lock关闭。没有安装collector或K2 profiles。[节点设计](../../../docs/design/2026-10-11-k2-node-evidence.zh-CN.md#实验-runtime-配置)记录本阶段范围及剩余证明要求，原清理截止与费用上限不变。

Namespace/actor identities、完整 executable/configuration/loaded-LSM 测量、独占 CSI 接线及 qualified release consumer 仍待完成。管理投影、image tag、example UUID 或 operator completion flag 不能代替这些事实。实验容量限定已批准的最多24小时/25元；已批准的策略/正常删除插件阶段已完成，collector 安装仍需具体批准。容量到期清理已补上这两个自有 guard，要求先确认 Node 消失。

撤销时停止新 scope，导出完整原 evidence，安全完成或保留每个现有 ownership，
关闭自有 worker/driver/source resources。停止并移除自有实验容量，使 kubelet
不能重新注册 Node；核实 processes/endpoints 已消失后，才使用已保存 UID/RV
preconditions 删除本次创建的 policy/binding。Node 仍活跃时移除 guard 会允许
addon 重建，可能与 source frontend 冲突。原 DaemonSet template/strategy
无需恢复；保留不相关的 cluster changes。
