# K2 节点来源打包

[English](README.md) | [简体中文](README.zh-CN.md)

本目录打包经过审阅的 Linux source 可执行程序，尚未安装到 ACK。实际节点、
driver 接线、confinement 和完整 source chain 通过资格化前，物理释放保持关闭。
当前 ACK 集群为 `c679c4016ff0b4872aa43a2b6688343e8`，其共享系统节点不属于
实验安装范围。

在 `packages/k2-node-evidence` 使用经过审阅的 Go toolchain 与模块固定依赖构建：

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOTOOLCHAIN=local GOWORK=off \
  go build -trimpath -o /absolute/output/k2-node-evidence .
```

资格化 amd64 节点时使用 `amd64`。独立验收前记录实际 source files、toolchain、
完整依赖、可执行程序 digest 与命令。构建成功不能资格化可执行程序。

无需 base image 或 Docker daemon，即可打包该 exact executable：

```sh
python3 deploy/k2-evidence/package-oci.py \
  --binary /absolute/output/k2-node-evidence \
  --expected-sha256 REVIEWED_EXECUTABLE_SHA256 \
  --architecture arm64 \
  --output /absolute/output/new-oci-layout
```

输出遵循 [OCI image layout 1.1.1 规范](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-layout.md)。
仅含带固定文件 metadata 的静态可执行程序单个未压缩 layer，不含 shell、
package manager、凭据或内嵌部署配置。发布 layout 与安装是独立动作。
安装镜像必须固定输出的 manifest digest，tag 不能作为 artifact pin。

程序有 `gateway`、`source` 两个角色，各接受一个 absolute JSON configuration
path。runtime/CSI Unix peers、executable identities 与持续持有的 pidfds
需要 host-visible root 权限边界。source 不持有 containerd socket。配置、
CA 与角色专用 key 独立挂载，source journal 使用 worker 及其 PVC 之外的
私有磁盘。详细权限与来源顺序见
[节点来源设计](../../docs/design/2026-10-11-k2-node-evidence.zh-CN.md)。

节点安装必须提供 exclusive CSI frontend：kubelet、registrar 使用其 socket，
仅 driver 和 source 能访问 private backend。原 ACK addon 容忍任意节点 taint，
公开配置没有排除新 node pool 的入口，单凭 label 或 taint 不能建立该边界。
实际 addon 接线验证前，安装 manifest 不得宣称隔离；打包工具不会修改集群，
也不会建立该隔离。

[原 ACK 排除候选](ack-existing-cluster/README.zh-CN.md) 为新 Node 的已知 CSI
addon Pods 生成独立 validating admission policy，保留原 DaemonSet 与共享节点。
较早表达式经 cel-go 0.26.0 编译，20 个本地请求映射案例通过。2026-10-11 获准安装的 CSI 专用 policy/binding 完成实际 ACK typechecking 和四次 admission dry-run；正常删除只停止了新节点的默认 CSI Pod。worker CREATE/gate guards 与 collector 仍未安装或资格化。分阶段安装必须先建立持续排除和冷启动独占接线，
再进行首次 K2 ARM 与 worker CREATE；renderer 不访问或修改集群。

## 私有 worker image 候选

[worker 打包设计](../../docs/design/2026-10-12-k2-worker-packaging.zh-CN.md)提供新的bundle/image候选，因为原worker完整artifact记录已不可取得。使用 `node deploy/k2-evidence/build-worker.mjs /absolute/new-bundle-directory` 构建exact生产worker，记录实际完整module bytes并嵌入WASM；固定base command为 `/usr/local/bin/node /opt/qwen-k2/worker.mjs`，随后由provisioner追加private arguments。source renderer仍从原持久request取得image/command。local build成功不能资格化启动或ACK runtime。

独立验证选定官方Node22 Linux OCI base后，以绝对base layout、exact base manifest digest、exact bundle path/SHA-256、architecture和新绝对output directory调用 `package-worker.py`。composer核compressed blobs和解压后的diff IDs，仅新增root拥有、只读的JS layer，清除继承startup/environment defaults并设置固定非root worker command。不解压落地archive、执行image、发布或安装。native验收前须审阅实际Node/loader/library闭包及受限policy，保留原build失败，不能让历史ACK验收转移到替代品。

## Host service 部署候选

`host-services/` 提供两个 static systemd unit 和私有目录规则，供审阅使用，
尚未获准安装到 ACK。它们保留 host PID、user、cgroup namespace，并建立
私有 filesystem mount view，避免把 `hostPID` Pod 当成已经具有 host cgroup
hierarchy。source 仍必须证明 `/proc/<originalPID>/cgroup` 在其实际
`/sys/fs/cgroup` view 中解析到同一原目录。

经过审阅的 executable 安装路径为 `/opt/qwen-k2/bin/k2-node-evidence`。
两个角色均用持续持有的 `/etc/qwen-k2/shim.json` 校验实际 executable digest，
并由该配置取得专用 handler 输入。在私有 `/etc/qwen-k2` 下提供 root-owned configuration 与
certificate files。`gateway.json`、`source.json` 使用 Go entry point 声明的
exact fields；本目录不分发凭据或编造 node/process/image pins。gateway
持有的 runtime socket 仍是该可信 helper 的行政能力。
每个配置/PEM 对象必须为 root-owned、immutable、只读的 ext4 普通文件，限制
32 KiB；私钥必须为 0400。两个角色持续持有原描述符，在 control 处理前后核对
命名对象、identity 和原字节。source gateway RPC 与 CSI 转发也在调用两侧核对。
这些检查不建立完整安装权限。

选定 driver 的 private socket 位于 `/run/qwen-k2/backend`。
source configuration 使用 `/run/qwen-k2/source/csi.sock` 作为 frontend、
`/var/lib/qwen-k2/journal` 作为独立 journal root。只有原 driver 与 source
能接触 backend；只有固定的原 kubelet 与唯一 registrar 能接触 frontend。
worker 不挂载这两个 socket。按 gateway、选定 backend、source、frontend
registrar 的顺序启动，读取实际 source identity 后才启动 reviewed coordinator。
unit 不自动开机启用或 restart；丢失的 source 不能恢复原 custody。

unit 仅保留 `CAP_SYS_PTRACE`：当 caller 不具有真实 root daemon 的 permitted
capabilities 时，读取其 executable 可能需要该能力。它们拒绝 tracing、
process-memory access、pidfd signalling 和 namespace-changing syscalls，
同时保留 Go 内部 thread signals。这是权限边界候选；实际 kernel、systemd、
peer capability sets 与 LSM rules 必须验证。LSM profile 只允许所需 proc reads、
reviewed sockets、source journal 与 frontend，禁止 task-memory 和 worker-volume
writes。不能从 owned fixture 的结果推断 empty capability set 已可用。

两个角色均显式设置 `RestrictSUIDSGID=no`：systemd 的
[SUID/SGID filter](https://github.com/systemd/systemd/blob/v259.5/src/shared/seccomp-util.c)
让每个 `openat2` 调用返回 `ENOSYS`。实际 service trace 已在原 BIND target
检查复现该失败。两个角色均以 `openat2` 读取受保护角色文件；source 另以 beneath-root、no-symlink
方式解析 target，不回退到更弱的 resolver。`NoNewPrivileges`、capability bound 和声明的
writable paths 仍强制执行。经审阅的 LSM policy 还必须禁止创建或修改 set-ID
文件；这些 service unit 本身不建立该限制。gateway 现必须有专用 enforce AppArmor
profile，在处理及返回 control 响应前核对实际 root credentials、initial user
mapping、seccomp 以及仅 SYS_PTRACE 的 capability set。

Filesystem read-only 设置不能证明后续传播的 CSI submount 递归只读。
必须验证单向 mount visibility，并通过经过审阅的 LSM policy 禁止 source
写这些 mounts。host service configuration、CSI exclusivity、Pod/gate/exec/DELETE
admission 与 RBAC、addon exclusion、实际 artifact pins 和撤销步骤仍是部署
资格化要求。提出 privileged 安装动作前，需针对目标 systemd version 验证 unit syntax，
并在 owned Linux host 测试 service。实际 ACK 资格化在获准安装后进行。

在当前强制 source AppArmor profile 和 v2 reader 加入之前，较早的 exact units 已在自有 Ubuntu 26.04.1/aarch64 Linux 7.0 host，使用
systemd 259.5 完成功能测试。主 source chain 通过 333 项检查，使用真实 UID
1000 parent/descendant tasks、持续持有的 pidfd/cgroup descriptors 和挂载发布/
卸载。出生后 BIND 拒绝通过 46 项；registrar 死亡拒绝通过 223 项。实际 units、
processes、mounts、cgroups、临时路径和 VM 均已关闭。Runtime/CSI backends
明示为协议夹具，LSM 为 unconfined；这些结果不资格化实际 ACK runtime/plugin/
driver 接线、受限 LSM、admission、物理释放或卷复用，也不资格化改变后的当前 source unit 或 v2 reader。原 `openat2` 失败单独保留。

当前 source 强制要求 `workerPolicySha256`，代表包含固定 worker/source/sandbox/shim/gateway profiles 的经审阅完整 packed bundle。v6 ARM 保存实际加载策略测量和原镜像，BIND 保存实际 admitted gated-spec digest/resourceVersion；启动和持续操作在测量缺失或变化时 fail closed。强制 source confinement、节点实际 enforce/lock、source 专用 disconnected exporter prefix 和完整 birth confinement 仍需具体 native 资格化及安装批准。代码只读策略，这些交付物不会设置节点级锁。

## 首次执行前 shim 候选

用与 source 相同的 Go 1.26.3 或更新工具链及锁定模块构建专用 shim。记录两个入口的两个架构构建，不能用只构建 source 代替 shim 构建。

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOTOOLCHAIN=local GOWORK=off \
  go build -mod=readonly -trimpath -buildvcs=false \
  -o /absolute/output/containerd-shim-qwen-k2-v1 ./cmd/containerd-shim-qwen-k2-v1
```

在仓库根目录，以 exact source、shim、另外经过审阅的 runc 产物和创建契约原字节生成候选：

```sh
python3 deploy/k2-evidence/render-pre-exec.py \
  --source /absolute/output/k2-node-evidence \
  --shim /absolute/output/containerd-shim-qwen-k2-v1 \
  --runc /absolute/reviewed/runc \
  --worker-layout /absolute/reviewed/worker-oci \
  --worker-image-sha256 REVIEWED_WORKER_MANIFEST_SHA256 \
  --sandbox-layout /absolute/reviewed/sandbox-oci \
  --sandbox-image-sha256 REVIEWED_SANDBOX_MANIFEST_SHA256 \
  --creation-contract /absolute/reviewed/creation-contract.json \
  --output /absolute/output/new-pre-exec-candidate
```

工具对实际产物字节计算 hash，核对 ELF header 架构相同，保留契约原字节，拒绝重复 JSON 和已存在的输出，生成 root-private 候选文件。工具检查契约 envelope；shim 与 Java consumer 执行完整语义校验。这不建立 artifact 源码 provenance 或实际执行兼容性。

两个镜像 layout 必须包含选定 OCI manifest、configuration 和有序 layer 的准确 blob。`image-catalog.py` 核对压缩摘要/大小和未压缩 diff ID，处理 whiteout，在不解压落地或执行内容的前提下解析原 ELF 入口与 loader。version 2 artifact manifest 绑定两个镜像 digest 和完整 `worker-catalog.json` / `sandbox-catalog.json` 字节。当前支持子集要求显式目录父项与 metadata 不变的同 layer hardlink；跨 layer 链接、外部 blob、未知文件类型/xattr、架构不符和缺失 loader 都在创建输出前拒绝。具体上限见出生设计。这是离线输入产物，不是完整 AppArmor bundle 或已安装的保护证据。

`shim.json` 对应拟安装的 `/etc/qwen-k2/shim.json`；`runtime-handler.toml` 是经审阅 containerd CRI runtime 配置的 fragment，明确使用 `runtime_path` 与 `io.containerd.qwen-k2.v1` runtime type。既有 RuntimeClass name/handler 仍为 `qwen-k2-runc-v1`。source 配置还必须加入生成的 `sandboxImageSha256`。tmpfiles fragment 提供固定私有目录。工具不会安装或 apply 这些文件。

安装前必须资格化实际 daemon 的 handler/bootstrap 兼容性、私有 ext4 消费输入挂载、immutable 安装文件及 ancestor、初始 namespaces、完整已加载并 locked 的 AppArmor bundle 和 actor/admission 边界。当前 service units 和历史 profiles 不继承本次改变后候选的资格。运行时目录必须允许正常 PID/log/rootfs/cleanup 写入，不能将整个消费 bundle 设为 immutable。用 exact reviewed source/shim 配置执行 `node-config`，生成 Java 必需的出生期待值；解析成功仍不代表安装资格或物理释放。详见[出生设计](../../docs/design/2026-10-16-k2-pre-exec-birth.zh-CN.md)。

## 离线五角色策略候选

用 `render-profiles.py` 消费上述准确工件目录。此阶段重新核对两份原镜像布局，将完整目录字节与第2版清单比较，同时核对原契约和固定 shim 配置。它读取实际 source/gateway JSON，不打开配置引用的密钥；以实际文件和 socket 路径生成规则，并让输出 unit 的 argv 使用同一部署配置路径。

```sh
python3 deploy/k2-evidence/render-profiles.py \
  --candidate /absolute/output/new-pre-exec-candidate \
  --artifact-manifest-sha256 REVIEWED_ARTIFACT_MANIFEST_SHA256 \
  --target /absolute/reviewed/profile-target.json \
  --target-sha256 REVIEWED_TARGET_SHA256 \
  --runtime /absolute/reviewed/private-runtime.json \
  --runtime-sha256 REVIEWED_RUNTIME_SHA256 \
  --source-config /absolute/reviewed/source.json \
  --source-config-sha256 REVIEWED_SOURCE_CONFIG_SHA256 \
  --gateway-config /absolute/reviewed/gateway.json \
  --gateway-config-sha256 REVIEWED_GATEWAY_CONFIG_SHA256 \
  --worker-layout /absolute/reviewed/worker-oci \
  --sandbox-layout /absolute/reviewed/sandbox-oci \
  --output /absolute/output/new-profile-candidate
```

闭合的 `qwen-k2-profile-target/2` 对象要求以下字段。这些是已审部署输入，不是观察结果或安装证书。

| 字段                            | 支持的输入                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`、`architecture`        | 上述准确版本；`amd64` 或 `arm64`，与两镜像及三个宿主产物一致                                                                                             |
| `hostExecutables`               | 准确的 `runtime`、`kubelet`、`registrar`、`plugin`、`systemd` 对象，各含 literal `path`、`sha256` 和不同的受限 `label`；四个 peer 摘要必须与服务配置一致 |
| `snapshotRoot`                  | `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots`                                                                                   |
| `podSlicePrefix`                | 实际 systemd kubepods Pod slice 前缀，可在 burstable 或 besteffort 层级                                                                                  |
| `apparmorExportRoot`            | `/qwen-k2-disconnected/source` 下准确测量的 exporter 路径，只读叶子模式由生成器拥有                                                                      |
| `systemBus`                     | 闭合的 `socket`、`privateSocket`、`label`；系统 bus socket、`/run/systemd/private` 和实际受限 bus label                                                  |
| `volumeSerialPath`              | 实际最终 `/sys/devices/.../serial` 对象                                                                                                                  |
| `roleConfigPaths`               | `/etc/qwen-k2` 直接子文件中的准确 `source`、`gateway` JSON 部署路径，同样进入输出 unit                                                                   |
| `sandboxNetworkNamespaceSource` | `/run/netns/` 下包含唯一 `${SANDBOX_ID}`（64位十六进制）或 `${NETWORK_NAMESPACE_ID}`（UUID）的组件模板，不接受调用者模式                                 |
| `rootfsMounts`                  | 准确的 `worker`、`sandbox` 数组，目前各一个外层 `overlay` mount，包含 `type`、`source`、完整 `options` 及 lowerdir 数据；与内层 OCI 挂载分开             |
| `oldRootPath`                   | `/qwen-k2-disconnected/shim` 下准确测量的旧根名字，不提供全局 unmount 回退                                                                               |
| `hugepageSizes`                 | 最多128个实际且不同的大小，如 `2MB`、`1GB`，只用于原 leaf 的只读规则                                                                                     |

两份服务配置必须准确包含 Go 入口消费的字段。配置及 TLS 路径留在 `/etc/qwen-k2` 直接子文件，声明的私钥路径不能与其他角色或公开输入别名。宿主程序路径不能进入角色文件、journal、socket、kubelet 数据、proc/sys/dev、临时或 worker 可写根，防止程序身份字段形成第二条密钥/数据读取路径；实际 inode/密钥字节隔离仍需安装资格化。journal 根及 runtime socket 固定；frontend/backend socket basename 可在既有私有目录内变化。gateway URL 必须指向实际 IP listener；DNS 及未指定监听地址不在此离线支持范围。完整已保存 Runtime command/image、worker mount root 必须与契约及镜像一致，可写根不能覆盖受保护目录或镜像文件。

输出包含单一 `qwen-k2-profiles` 源码、两份调整后的 unit、原服务/目标/Runtime/契约字节，以及绑定所有输出和生成器的 `profile-candidate.json`。不接受权限数组、调用者 AARE 或 include。完整 mount data 保留在原契约，规则只生成 AppArmor 可表达的类型、flags、source 和 destination；首个支持范围拒绝未知挂载选项、idmapped mount、相对 bind source 和宽泛设备许可。

挂载规则区分外层 snapshot 与内层 OCI mount，并拆分初挂、propagation、bind remount、切根后的只读 finalize 及 masked paths。只读 remount 仅覆盖支持的继承安全 flags 的有限组合。镜像父链接先解析，再生成 mount/boot 路径；新 mountpoint 的父目录可尚未存在于镜像，普通镜像目录解析仍要求父项存在，解析结果超出 literal path 子集则拒绝。规则不能证明 source 类型、继承的 VFS flags、namespace 归属或实际 disconnected 名字，仍需已审目标和原生验收。source 仍不能写 cgroup controller；shim 新增 root-controller/statistics 权限只读，正常状态临时文件限定在原 CID 状态目录。

此阶段不会运行 parser、加载或锁定策略、执行镜像或安装服务。清单记录仍待验证的语义边界，包括数字 proc 的仅自身修改检查、SDK parent/child OOM 关系、disconnected 对象命名及外部宿主策略/CSI 隔离；这些依赖实际内核和固定可信实现，策略源码及摘要不能证明。`workerPolicySha256` 最终必须使用实际 packed bundle hash；编译后以最终配置重新生成候选，并确认策略源码不变，临时摘要不能成为安装证据。真实正常生命周期、完整 actor 排除及最终物理释放权限仍待完成。

## 显式策略编译阶段

`compile-profiles.py` 消费已审 `profile-candidate.json` 及其中每份 pinned 文件。仅接受生成器的平铺、有序五角色布局，不接受 ambient include、alias、ABI 选择或嵌套 profile；布局检查不是通用策略 parser 或权限审查。提供准确目标 parser ELF 及目标 feature 字节：

```sh
python3 deploy/k2-evidence/compile-profiles.py \
  --candidate /absolute/output/new-profile-candidate \
  --profile-candidate-sha256 REVIEWED_PROFILE_CANDIDATE_SHA256 \
  --parser /absolute/reviewed/apparmor_parser \
  --parser-sha256 REVIEWED_PARSER_SHA256 \
  --features /absolute/reviewed/kernel-features \
  --features-sha256 REVIEWED_FEATURES_SHA256 \
  --output /absolute/output/new-policy-compilation
```

工具将准确 parser/source/features 复制到新的私有目录，使用显式空 parser 配置及两份显式 features 参数，关闭 kernel load 和 cache，记录实际 argv；未强制规则警告按错误处理。失败或超时保留 attempt、stderr 和部分输出，成功输出受 source reader 的8 MiB上限约束并记录长度及摘要。Parser 依赖、目标 feature 正确性及工具链来源仍需独立资格化；编译不会加载或锁定策略，也不能认证语义或安装。当前普通测试仅执行准备、布局拒绝和 argv 构造，并阻止 parser 执行；本候选未运行任何真实或模拟 parser。
