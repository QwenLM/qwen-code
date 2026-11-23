# /verify-pr 的分信任等级 microVM 隔离

[English](2026-11-23-verify-pr-tiered-microvm.md) | [简体中文](2026-11-23-verify-pr-tiered-microvm.zh-CN.md)

**状态：提案，2026-11-23。** 本文是设计与 PoC 验收边界，不表示后端、门禁或性能目标已经实现或验证。

## 1. 最短阅读路径与决策摘要

先读本节、问题与威胁模型，然后读第 4 节的执行分档和第 6 节各设计决定的开头。后半部分是生命周期、实施和验收细节。

本地 `/verify-pr` 需要频繁运行 PR 控制的构建、测试及 agent 工具调用，其中还要防范主动恶意 PR 和针对宿主内核的攻击。Linux 容器、Bubblewrap、Landlock 和 macOS Seatbelt 与宿主共享内核，不能独自回答这个威胁模型；为所有 PR 一律运行完整虚拟机又会增加高频维护者的工作成本。

本提案采用 **microVM-first，而非 microVM-only**：

- 外部、未知、受赞助或不能证明来源的 head，以及触发强制升级条件的改动，在一次性硬件虚拟化边界中执行。
- 用户明确选择的本人本地工作树，以及通过权限复核的受信贡献者 PR，可以进入明确标注为较低保障等级的受信轻量档。
- 轻量档不是高保障边界的别名：它接受作者账户、内部人员与供应链残余风险，主要防止误操作和限制爆炸半径。
- 所有档位都禁用自动宿主回退；后端不可用时只能失败、使用另一条满足该保障等级的后端，或转远程隔离 worker。
- Linux 在可用 KVM 的主机上选择 Firecracker/KVM/jailer；未开放嵌套 KVM 的普通 ECS 使用每轮独立的 `provider-vm`。macOS 选择 vfkit/Apple Virtualization.framework，并将 vfkit 的宿主进程沙箱作为必须通过 PoC 的前置条件。
- 初版不做运行态快照克隆重用、不共享可写依赖缓存，也不同时新建多套原生轻量沙箱。

这项设计把两个问题分开：**信任分类决定是否接受共享内核残余风险，实际后端决定报告中可以声称的隔离等级。**

## 2. 当前状态与要躲避的故障

### 2.1 当前实现提供的基础

- `.qwen/skills/verify-pr/SKILL.md` 的本地 Docker 配方将真实模型 key 留在宿主代理，PR 只获得每轮 bearer token；脚本从可信检出运行，base 的 `.qwen` 固定为可信输入。
- 本地容器挂载 PR 独立克隆并允许写入，产物位于该树中；`scripts/verify-pr-prepare.mjs`、`scripts/verify-pr-check.mjs` 围绕容器标记、上下文摘要、symlink、产物完整性和容器 nonce 建立门禁。
- `.github/workflows/qwen-triage.yml` 已把不可信执行的 `verify` 与携带发布/OSS 凭据的 `publish-verify` 分开，并把报告定位为人工评审证据而非自动批准。
- authorize 已基于 collaborator permission 区分 `verify_trust=trusted` 与 `external`，external 路径固定 `SPONSORED_OID`，在执行前复核 head 和作者权限，并增加风险扫描与工作区清理。

### 2.2 共享内核不能覆盖新威胁

本地 Docker 与 CI 容器隔离了部分进程和文件系统效果，但没有把 PR 从宿主 Linux 内核隔开。macOS 的 `permissive-open` 默认 profile 不是凭据边界，即使 restrictive profile 也允许 `(allow file-read*)`；仓库的 bwrap 执行后端使用 `--ro-bind / /`，同样保留宿主文件可读性。因此这些机制不能直接改个名字就成为高保障后端。

CI 的 `verify` 作业固定使用 `self-hosted/ecs-qwen` 容器，发布作业才明确使用 `ubuntu-latest`。只有 runner 运营方证明每个作业拥有独立且销毁的外层 VM，才能把 CI 车道视为高保障；不能从 YAML 推断外层隔离。

### 2.3 共享工作区与凭据是另外两条独立风险线

当前 RW 工作区要求宿主在 PR 代码执行后读取、检查和清理 PR 可写路径，带来 symlink 和活进程竞态。只换 VMM 而不改变输入输出关系，会保留这条攻击面。

同样，容器没有模型 key 不等于网络能力受限。guest root 或取得 guest kernel 的攻击者可以绕过 guest 内的 `HTTP_PROXY`、Maven mirror 与防火墙，所以网络策略必须在 VM 外实施。

## 3. 威胁模型、目标与非目标

### 3.1 攻击者能力

高保障档假设 PR 能控制源码、构建脚本、依赖、测试、后台进程、网络客户端及输出，能取得 guest root，甚至利用 guest kernel 漏洞。攻击者可以攻击 VMM、VirtIO/vsock、宿主代理、collector 和报告格式，也可以伪造 guest 内的任何日志或测试结果。

### 3.2 要保护的资产

- 宿主文件、内核、内网与宿主服务，包括 SSH、云、GitHub、模型和 OSS 凭据。
- 其他项目、并行验证轮以及下一轮使用的 golden image 和可信脚本。
- 宿主和共享基础设施的 CPU、内存、磁盘、进程数、网络与模型额度。
- 报告的 head 身份、实际执行边界和发布凭据。

### 3.3 安全目标

- PR 控制的内核与宿主内核之间必须隔着硬件虚拟化及受限的 VMM 宿主进程。
- VM 销毁前不发布正常结论；无凭据的发布路径不能由 guest 自证。
- 不让宿主挂载、执行或按文件系统语义展开 PR 控制的数据。
- 轻量档可以牺牲对恶意内部代码的防御，但不能删除基本的凭据隔离、资源预算和轮次清理。

### 3.4 非目标与残余风险

- 不承诺消除 hypervisor 0day、VMM 侧信道或 CPU 微架构侧信道。高级定向攻击应使用与日常开发机隔离的专用可销毁验证节点。
- 不证明恶意 guest 产出的测试一定真实；VM 记录证明执行边界，不能证明 guest 没有欺骗自己的测试。
- 不自动合并任何报告，也不让 guest 生成的 `merge-ready` 变为审批。
- 不在第一版支持任意镜像、任意网络、Windows、跨架构等价性或真实生产数据库。
- 不用一次 PR 作者身份或维护者赞助替代当前 head 的安全分类。

### 3.5 与 `/review` 的兼容约束（只纳入考虑，当前不改）

`/review` 已把被评审代码的执行集中在 `build-test`、probe/mutation、base-tree 和 prose-exec 等阶段，而不是只包住整个评审 agent。后端须以执行适配器方式与这个边界兼容，保持 `working_dir`、fan-out、覆盖/结论台账、清理和报告原义不变；不把正在阅读 diff 与生成 findings 的 agent 一并移入不一定持有正确凭据和上下文的 VM。

- `scratch-tree` 消除跨轮文件残留，不等于安全沙箱。实际运行 PR 命令的阶段需要与这里相同的执行边界、真实 worker 销毁和不可用即未测证据。
- install、build、test 的网络能力分开授权，超时必须终止真实 worker 而不只是客户端。拒绝运行不能静默降级为宿主执行或变成“已经通过”。
- `--fix` 的允许落地目标仍是用户工作树；不能把改动写入一次性 VM 后销毁，却宣称已修复。PR target 上原本无效的 `--fix` 仍按现有契约保持无效。
- prose-exec 和其他不含构建步骤的只读分析分开受控：短文本结果也不能因来源可疑就自动改写为已经过运行验证。

这些是与 `/review` 共用低成本执行后端的前置条件，不是已经开始集成，也不要求本次修改其 skill、Agent 编排或 sandboxed-exec 实现。

## 4. 信任分类与执行分档

### 4.1 两个独立字段

每轮同时记录：

- `prTrust`：`local-owner`、`collaborator`、`external`、`unknown`。
- `executionClass`：`hardware-isolated` 或 `trusted-shared-kernel`。

`trusted` 标签不能单独决定安全声明；外部读者必须看到实际 `executionClass`、执行的 head、后端与定级原因。

### 4.2 定级规则

| 输入                                                                      | 默认执行档                        | 理由                                                            |
| ------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| 用户明确选择的本人本地工作树                                              | `trusted-shared-kernel`           | 与日常本地构建相同的开发信任；记录源码基线，不自动代表其远程 PR |
| 作者当前拥有 `write`、`maintain` 或 `admin`，且执行前复核和 head 固定通过 | `trusted-shared-kernel`           | 接受受信贡献者与共享内核的残余风险                              |
| fork、外部作者、成员身份不明、来源不能判断                                | `hardware-isolated`               | 恶意 PR 是设计内威胁                                            |
| 由维护者 `/verify` 赞助的外部 PR                                          | `hardware-isolated`               | 赞助授权花费资源执行，不是对代码无恶意的担保                    |
| 权限、head 或风险信息读取失败                                             | `hardware-isolated` 或启动前拒绝  | 绝不能因为分类服务故障降低隔离                                  |
| 第 4.3 节的强制升级条件                                                   | `hardware-isolated`，无论作者身份 | 新代码可能来自作者之外的供应链或控制提示                        |

本地开发档只适用于用户明确选择的本地内容；GitHub 上显示为“本人”的 PR 仍需经过当前 head 与权限分类。`head.repo == base` 也只是来源信息，因为其他有写权限的人可以向仓库分支提交代码。

信任判断使用执行时的 collaborator permission，而不是 commit author、email 或单独的 `author_association`。发起 `/verify` 者的权限继续负责模型和 runner 预算准入，不能与 PR 作者信任混为一个主体。

### 4.3 强制升级条件

下列变化至少包括：依赖清单、lockfile、依赖 URL、npm lifecycle、`.npmrc`、`.pnpmfile.mjs`、Maven POM/插件、`.github/workflows`、验证或沙箱脚本、`.qwen` 技能/命令/可执行提示、新增二进制、原生扩展和下载后执行的工具。既有 external 风险扫描中的混淆或无法完整审查条件继续适用。

这些只是强制升级信号，**不是对其他改动的安全证明**。受信档本来就是显式接受作者和内部代码风险后的选择。禁止以模型风险扫描返回 `clear` 将 external 降为共享内核。

### 4.4 信任授予和生命周期

- 所有执行档在开始时固定 `headRefOid`，不只 external 固定。排队后、代码注入前重新比对 head 并重新查询作者权限。
- head 变化就是新一轮，重新定级；不能继承旧 head 的轻量资格。权限撤销或不可读不能保留旧信任结果。
- 发布时将实际记录的 head 与最新评审状态按现有 moved-head 规则复核。
- 安全事件复盘期间，由 PR 代码之外的受信配置强制所有运行进入 `hardware-isolated`；复盘结束后才能重新开放信任例外。
- 轻量后端不可用时可以升级到高保障后端，不能自动降级到宿主 `waived`。

## 5. 目标架构

```text
可信宿主：prepare/权限与 head → VM 启动器 → 产物检查 → 独立发布器
                         │
           固定输入/output、model、dependency 能力端点
                         │
              每轮独立 VM、独立工作磁盘、scratch HOME
                         │
       发布版验证 agent + PR 源码 + 所有构建/测试/文件操作
```

高保障执行没有宿主 HOME、工作区、Docker socket 或 SSH agent 的共享目录。PR 的全部源码与验证 agent 位于 guest，宿主只处理元数据、受信输入、有限能力代理、VM 生命周期和输出字节。

Linux 使用一个 Firecracker 进程对应一个 microVM，生产路径经由匹配版本的 jailer。macOS 使用 vfkit 的 Linux bootloader 和 Apple Virtualization.framework；两个后端对上层提供同一份受信启动契约，而不是同一份平台 API。

现有 `packages/cli` 的 generic whole-CLI sandbox 和 `packages/core` 的工具级 execution sandbox 不是本方案的替代物，首版也不要求为它们扩展新的公共后端。

### 5.1 执行位置：KVM 主机与普通 ECS 都要支持

实际高频执行环境往往是没有无条件开放 `/dev/kvm` 的云 VM，因此高保障不能依赖单一嵌套虚拟化机制。

| 执行环境                                           | 支持角色                                               | 隔离声明的前提                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 有可用 KVM 的本机，例如 `orangepi6plus`            | 一等 `firecracker` 后端，通过嵌套 guest 硬件虚拟化执行 | Firecracker/jailer 提供 guest/host 分界，是正式部署路径，不是开发备用方案。                                                       |
| 支持 VZ 的 Apple Silicon/macOS                     | `vfkit` 后端，同时沙箱化宿主 VMM 进程                  | VZ 与宿主进程限制缺一不可；裸 vfkit 不够。                                                                                        |
| 未开放嵌套 KVM 的普通 ECS VM，例如 `47.97.172.207` | 受信控制面、凭据代理和/或受信轻量执行节点              | 不要求能启动 Firecracker。持久实例只能运行 `trusted-shared-kernel`；其实例类型或云厂商底层 hypervisor 不能自行推出高保障声明。    |
| 由云提供方为具体 head 新分配、轮次后销毁的完整 VM  | `provider-vm` 后端，`executionClass=hardware-isolated` | provider hypervisor 是外层边界，不是在 ECS guest 内再套一层 VM。必须固定新分配的实例、干净磁盘/镜像，以及 provider 方确认的销毁。 |

同一个 ECS 实例可以作为受信控制面或代理，而不在自己的长期复用内核里执行高风险 PR。如果运营者就是要把这个实例本身作为单次执行 VM 分配，那么销毁它是轮次的一部分；沿用固定 IP 或hostname 本身不构成信任信号。普通持久 ECS 不能通过清理 workspace、重启容器来满足高风险要求。

`provider-vm` 后端必须在 guest 之外执行 security group/VPC 策略，执行 VM 不设 IAM role 或环境可见的 metadata 凭据，云管理凭据和实际模型/GitHub/OSS 凭据只留在受信控制面，并把创建/销毁事件绑定固定 runId 和 head。任何 guest 内产生的属性都不能替代 provider 启动与终止证据。有 KVM 的本机与 provider 管理路径可以并存；两者全无可用时，高风险执行只能拒绝或报告 inconclusive，不能悄悄降低为共享内核。

对于必然带网卡的 provider VM，固定外部网关和 provider/VPC 控制替代本地后端的无网卡/vsock 传输，内容型 collector 与执行侧无长期凭据的要求不变。

**2026-11-23 阿里云 `provider-vm` 生命周期 PoC：**在用户明确授权下，于 0 既有实例的独立 VPC（`vpc-bp1htl5oix551ezrx2dgo`，`cn-hangzhou-b`）中创建了 1 台一次性 `ecs.e-c1m1.large` 实例（`i-bp1e1f9cxtmtff8gz03w`，`0.136 CNY/hour`，35 分钟 `AutoReleaseTime` 兜底）、新 20 GiB `cloud_essd` 系统盘（`d-bp1e1f9cxtmtff8moo87`，`DeleteWithInstance=true`）及临时安全组（`sg-bp18ywy63h6ned6z7jro`：0 入站放行，显式 Drop RFC1918 与 `0.0.0.0/0` 出站）。云侧 API 证实无公网 IP 且 RAM 角色为空；Cloud Assistant 探针（`t-hz073z9h7pctlvk`，退出 0）实测 IMDSv1 `403`、IMDSv2 RAM 凭据 `404`、公网与跨私网出站 `DENIED`、环境凭据命中 `0` 及双 OID A/B 夹具（`base=False`、`head=True`）。发布门在删除前强制 `BLOCK (isolationIncident=True)`，仅在云侧 API 确认实例、系统盘与临时安全组全部 `0` 残留且既有 8 台实例完好后返回 `ALLOW` 并写出 `boundary.json (mode:"vm", backend:"provider-vm")`。实测同时明确生产清理器须对 `IncorrectInstanceStatus.Initializing` 重试，且 Cloud Assistant 完成态须判断 `InvocationStatus=="Success"` / `InvokeRecordStatus=="Finished"`。见 P7 阿里云实测记录 (`.qwen/e2e-tests/2026-11-23-p7-provider-vm-aliyun.md`)。

**2026-11-23 阿里云 Agent Sandbox（`fcsandbox` / E2B 兼容）PoC：**在用户明确授权下，通过 `cn-hangzhou.sandbox.aliyuncs.com`（控制面 `aliyun fcsandbox 2026-05-09`，数据面 `e2b@2.31.0`）创建一次性沙箱（`sbx-f558b247-c11c-4274-a0ed-8a7ded7e4eec`），冷启动耗时 **2,438 ms**，销毁并列表确认消失仅 **276 ms**。沙箱内探针实证 KVM 硬件虚拟化（`FCSB_VIRT=kvm`，独立 `5.10.134-...kangaroo.al8.x86_64` 内核）、15 GiB 临时根盘、零环境凭据、`100.100.100.200` 元数据不可达、`169.254.169.254` 返回 `401` 及双 OID A/B 通过；同时直连生产 `verify-pr-vm-lifecycle.mjs` 与 `verify-pr-check.mjs` 验证销毁前强制 `BLOCK`、销毁确认后 `ALLOW` 并写出 `mode:"vm"`。关键安全发现：内置公共模板 `code-interpreter-v1` 默认公网 `OPEN`，因此高保障外部 PR 必须拒绝公共默认模板，改用 `runtimeConfig.internetAccess: false` + 隔离 VPC 安全组的自定义模板（已在 `buildAliyunAgentSandboxPlan()` 中与实测的 `UpdateApiKey(inactive) → DeleteApiKey` 两步撤销逻辑一并固化）。见 P7-B 阿里云 Agent Sandbox 实测 (`.qwen/e2e-tests/2026-11-23-p7-aliyun-agent-sandbox.md`)。

## 6. 设计决定：每一条在防什么故障

### D1：整个验证 agent 及其源码操作都放在一条边界内

**躲避的故障：**构建在 VM 中，但 Read/Write、Git、子 agent、LSP 或后台任务回到宿主，形成旁路。

因此验证 agent、源码树、依赖树、A/B worktree、构建、测试、截图和临时文件全部位于同一执行边界。宿主不运行 PR 生命周期脚本。guest 内可以继续使用 bwrap/seccomp 作为纵深防御，但那只是第二层。

### D2：高保障档取消共享目录和宿主磁盘挂载

**躲避的故障：**PR 通过共享目录放置 symlink、特殊文件或维持后台写入，宿主收尾时再执行、解包或挂载这些内容。

Golden image 不直接提供给运行中的 VM；每轮创建工作磁盘副本，结束时销毁。Linux 优先 reflink，macOS 使用 APFS clonefile，缺少 CoW 时以完整复制作为安全回退。每轮副本可以被 guest 任意破坏，不能反向修改 golden image。

不使用 RW bind、virtio-fs 或 9p 共享 PR 工作区，也不在宿主挂载 guest 磁盘。被 guest kernel 控制的文件系统若由宿主解析，会将攻击重新带回宿主内核。

### D3：不给高保障 guest 默认网卡，外部能力由固定端点提供

**躲避的故障：**guest root/kernel 绕过代理设定或 guest 内防火墙，直接访问宿主、内网、云 metadata 或 exfiltration 目标。

初版不配置 NAT、TAP 或 bridged NIC。guest 的包管理器经 loopback 桥接至宿主 vsock 服务；攻击者可以绕过该桥接器，但宿主仍决定每个 vsock 端点的能力，不能因此获得任意 IP 访问。

宿主端点只有三类：

- `run-input/output`：输入清单、源码和受限报告流。
- `model-broker`：只允许受信配置指定的模型上游和精确 API 路径。
- `dependency-gateway`：仅允许受信 npm/Maven/浏览器镜像，拒绝任意上游代理。

dependency gateway 对每次连接检查端口、DNS 解析后的每个目标地址和重绑结果，拒绝 loopback、私网、link-local 和 metadata，并限制大小、连接数和时间。不能满足镜像限制的依赖要记录为未覆盖或 inconclusive，不能打开任意网络作为补救。

**本机 VMM 启动器的 PoC 约束：**监听 socket 的所有权及写权限必须与降权的 VMM 身份兼容，仅有父目录权限正确并不够。`poc-owner-denied` 中，root 所有、`v.sock_52` 的 mode 为 0755，UID 65534 的真实 syscall 是 `connect() = -1 EACCES`，Firecracker 将其转成 guest 的 `ECONNRESET`。只把 socket 所有权改成 65534 后，得到 `connect() = 0` 并且 greeting/ack 完整往返，未放宽 mode、目录、seccomp 或网络范围。生产配置必须明确每轮 uid/group 或受控分配规则，并把正反权限对照纳入启动门禁。原型还把建连恢复约束在总 15 秒截止和 50 次短退避内，且只对指定建连错误重试；错误载荷和错误凭据不重试，也不能把尚未解释的启动竞态悄悄重试为成功。

后续启动 PoC 发现，`collector-clean-linux-1` 生成了 108 bytes 的 Linux UDS 路径，在任何 guest/collector 用例运行前即失败。生产路径必须分配操作者拥有的短、私有 UDS 路径，在启动前检查字节长度、所有权和 mode；长仓库路径或 runId 不能悄悄变成“因为 listener 不存在而安全拒绝”的通过证据。随后 `csl1` 以 89 bytes 的路径，未放宽隔离，完成了真实 VM 矩阵。见 collector 专项实测 (`.qwen/e2e-tests/2026-11-23-collector-workload.md`)。

### D4：真实凭据与执行 VM 分离，每轮 token 也按可泄露处理

**躲避的故障：**guest root 从环境、`/proc`、崩溃转储或内核内存读取长期凭据。

GitHub 写权限、OSS 凭据和模型真实 key 绝不注入 guest。模型代理保留现有精确路径鉴权、每轮 bearer 和 idle watchdog 语义，在宿主将每轮 token 替换为真实 key。token 有单轮范围、预算和撤销点，VM 停止后不能使用。

发布器继续保持独立权限和可信代码来源。模型 token 泄露的最坏结果应限定为本轮有限调用，不能扩展成读取仓库、发布报告或访问对象存储。

### D5：collector 接收内容字节，不接收 guest 文件系统语义

**躲避的故障：**产物中的路径穿越、链接、设备节点、巨大文件、压缩炸弹或伪造门禁记录攻击宿主。

guest runner 与宿主 collector 使用带版本、长度和摘要的帧协议：`hello`、`file-begin`、`file-chunk`、`file-end`、`round-end`。宿主只接受契约中的文本、JSON、日志和证据图片；路径必须规范化为轮次私有 vault 内的相对名称。

宿主不接收 tar、symlink、权限位、设备节点或调用方给定的宿主路径。文件数、单文件、总量、帧和读取时间均有硬限制，并在分配内存前检查。未完成帧、超限或断流表示输出不完整，不能解释成“没有测试结果”。控制台中的终端控制序列按不可信文本处理。

guest 提交的 `boundary.json`、门禁记录或预期 head 始终没有宿主权威。

**2026-11-23 collector 后续 PoC：**移除临时高频诊断后，同一宿主协议修订版在 KVM/Firecracker（`csl1`，超时测试后 worker `257505` 消失）和 sandboxed vfkit（`collector-clean-mac-1`，vfkit `13248` 消失）的真实 vSock 路径上各完成 23 个固定用例。覆盖路径和权威性文件名拒绝、文件/总量/帧预算、摘要和重名错误、真正 full-close 的截断、常规文件正例、一次允许的假模型请求，以及仍存活 guest 的硬超时。不完整或被拒绝事务不留下 vault pending 产物。full-close 与半写关闭不能混淆：该传输下后者没有提供预期的及时 EOF，而真正的 full-close 产生了宿主可观测的截断。超限 frame 仍然拒绝；关闭连接前只对少量未读内容做 bounded drain，不收容无界 payload。

这是小型本机协议夹具，不是生产 collector，也不是完整网络、生命周期或 oracle 验收。使用操作者控制的短 socket 路径和每轮 rootfs 副本；VZ 的 initramfs 直接调用 `/opt/poc/init`，因此使用独立、同样校验过的专用 rootfs，并分别记录镜像和可执行输入摘要。真实 PR、正式 `/verify-pr` agent 与 execution-record/checker/publisher、真实模型 token 的预算与撤销、DNS 重绑定/改道、fork bomb、launcher crash、provider VM 生命周期和生产专用 UID/Seatbelt 审查仍未通过验收。主证据和遗留限制见 collector 专项实测 (`.qwen/e2e-tests/2026-11-23-collector-workload.md`)。

### D6：Linux 保护 KVM 之后的 VMM 进程

**躲避的故障：**恶意 guest kernel 利用 VMM/设备漏洞后，直接获得维护者用户的宿主权限。

Firecracker 默认 seccomp 不是完整启动配方。生产路径还必须有匹配版本的 jailer、每轮非登录 UID/GID、chroot、mount namespace、必要的 cgroup 和 rlimit。只把本轮磁盘、kernel、API socket 和 vsock 所需资源显式交给 VMM。

首版无网卡也减少 TAP 配置和相关攻击面。CPU、VMM 开销、实际磁盘、宿主进程和墙钟时间必须在宿主侧限制；guest 内限制只是辅助。

启动器及路径属于 TCB，不提供接受任意镜像路径、netns、UID 或命令行的通用特权接口。kernel、rootfs、jailer/Firecracker 的版本和摘要进入执行记录。

### D7：macOS 同时约束 guest 与 vfkit 宿主进程

**躲避的故障：**将“用了 VZ”误当成“VMM 被攻陷后仍无法读取日常用户文件”。

vfkit 使用 Linux bootloader，不配置 `virtio-net`、`virtio-fs`、Rosetta、GPU、USB/NBD 等非必要设备。每轮 vsock 使用私有 Unix socket。REST 默认关闭，启动器持有进程生命周期并证明 vfkit 实际退出。只有证明确实需要额外控制 API 时才允许启用 REST，并使用单独的每轮私有 Unix socket 及经过验证的最小授权；不给通用 inbound 网络豁免。REST bind 失败不能被放宽成放行所有 listener。

vfkit 宿主进程运行在独立普通用户、私有 HOME 和受限文件视图中。专门的 deny-default Seatbelt profile 只开放 VZ 必需的 Mach 服务、本轮镜像和 socket，禁止一般网络和其他用户目录，不授予 Full Disk Access。

这是高保障 macOS 路径的 **go/no-go PoC**。若目标系统上无法同时保证 VZ 正常工作和宿主进程沙箱确实 enforcing，高风险 PR 必须转远程 Linux microVM worker。vfkit 的有限进程策略和直接运行任意 PR 工具的 Seatbelt 策略是两个问题，不能互相借用安全结论。首版只计划在受支持的 Apple Silicon/macOS 组合上提供 Linux ARM64 guest。

**2026-11-23 最小 PoC 结果：**原 Firecracker CI ARM64 kernel 含 `# CONFIG_PCI is not set`，它在 MMIO 下的成功不能直接转为 VZ PCI 驱动支持。已用同版上游源码构建同时保留 MMIO、加入 PCI host/virtio-PCI 的候选 kernel。`vfkit-vz-pci-2` 与 `vfkit-vz-sandbox-2` 随后均提供了真实 initrd/rootfs/guest init 证据、guest 网卡只有 `lo`，以及完整的 guest→host greeting/ack 和进程清理。sandboxed 轮范围文件正对照及外部 canary 拒绝均通过，结束时 `live_vfkit_processes=[]`。专用生产 UID 与定制 Seatbelt 的独立复核仍待完成，不是已完成的维护者部署配置。详细字节、摘要与对照见 PoC 实测记录 (`.qwen/e2e-tests/2026-11-23-verify-pr-tiered-microvm-results.md`)。

### D8：每轮只运行一个 PR，初版不复用运行态快照

**躲避的故障：**PR 留置进程、内核状态、token、伪造 agent 或恶意磁盘内容进入下一轮，以及快照克隆复制熵和身份。

VM、工作磁盘、HOME 和 token 都只属于一个 runId。已运行 PR 的 VM 永不进入热池；可以提前准备尚未运行 PR 的干净磁盘或 VM，每项只分配一次。

**Firecracker PoC 的生命周期纠正：**supervisor 不一定是实际 VMM worker。只等待 supervisor 后，本轮发现 `31063`、`38868` 两个 orphaned worker，仍在执行 `/firecracker-v1.18.0-aarch64`，具有对应的 host/namespace PID 对。它们通过 jailer PID 文件定位并按明确身份停止，最终确认均消失。生产必须从启动器自有的 PID 记录解析真正的 worker，核验其可执行文件，再针对该 worker 进行受限跟踪与终止；在有上限的等待后必须证明该 worker 不再存活。没有追踪或仍存活的 worker 都使清理失败，不能只写一个形式上的 teardown 完成字段。修正后的 `poc-owner-allowed` 观察到 worker `44980` 消失，并且最终 Firecracker 进程快照为空。

Firecracker 官方快照文档要求处理 guest 标识、熵、随机数、token、网络和 vsock 唯一性。初版冷启动并使用每轮新身份；golden 构建删除持久机器标识、guest host key 和保存的随机种子，每轮首次启动由宿主随机源重新生成身份并注入熵。仅仅冷启动不能证明磁盘克隆的唯一性；如实测必须恢复运行态快照，另行完成唯一性、重新注入熵、CID/端口隔离和磁盘配额的专项设计。

**2026-11-23 双轮并发与双 OID 冷启动 PoC：**在 KVM/Firecracker（起止并发重叠 `306761` & `306768`）与 sandboxed vfkit（起止并发重叠 `25546` & `25549`）上从同一份 256 MiB 源 rootfs 同时冷启动两台 microVM（`cca1` 与 `ccb1`），实测得到每轮不同的 `/etc/machine-id` 与 32-byte 随机熵样本、零跨轮 canary/OID 串轮、不共享宿主 `.git` 经 vsock 注入双 OID 后的真实 Node v22.23.5 A/B 结果（`base` 退出 `1`、`head` 退出 `0`）、每轮模型 token 三态隔离（跨轮错 token `403:invalid-token`、本轮合法 token `200` 且假上游密钥不进入 guest/报告、销毁后回放 `403:token-revoked`），以及销毁后由宿主写出的 `boundary.json (mode:"microvm")`。完整 `qwen` CLI 运行、10 次冷启动性能基准、依赖网关与密码学熵审计仍不在本夹具覆盖范围内。见 双轮并发与双 OID 专项实测 (`.qwen/e2e-tests/2026-11-23-p56-concurrent-two-oid-workload.md`)。

### D9：宿主执行记录取代 guest 自证

**躲避的故障：**guest 伪造 boundary、在宿主运行旧测试后复制 nonce，或 VM 仍存活时发布结果。

受信启动器在 guest 无法写入的位置维护 `execution-record.json`，记录 runId、repo、PR、base/head、上下文摘要、backend/version、平台、kernel/golden image 摘要、可信输入摘要、CLI/skill 版本、启动策略摘要、开始/结束/销毁时间、teardown 和输出状态。本机后端必须区分 supervisor/worker 的标识，并记录 worker 身份以及观测到的退出或 provider 确认的销毁证据。`teardownStatus=destroyed` 必须建立在这些证明之上，而不是 supervisor 退出或一个自我声明的启动记录。

本机嵌套执行的报告使用 `boundary.json mode:"microvm"`，只能由宿主在停止并销毁 VM 后生成。provider 管理的完整 VM 使用 `mode:"vm"` 并明确 `backend:"provider-vm"`，受信控制面必须记录分配身份、干净镜像/磁盘身份、绑定的 runId 和 head，以及 provider 方确认的终止状态。没有 provider 生命周期证据的现存或复用 VM，不属于 provider 轮，不能套用该等价关系。

checker 通过显式宿主路径读取 execution record；不能从 PR 可写产物目录或一个自选的 argv 声明推导可信边界。该记录是受信操作者记录，不冒充 TPM、SEV 或其他远程证明。

### D10：安全门禁失败时停止发布，而不是换一个更弱的解释

**躲避的故障：**把 VM 未销毁、输出截断或策略降级写成“带警告通过”。

清理、输出协议或执行记录不完整时不能正常 `merge-ready`。生命周期清理失败留下明确的隔离故障，要求人工清理孤立资源。缺少 KVM/VZ 时拒绝本地高保障运行或转远程隔离 worker，不能自动回退 Docker、bwrap、Seatbelt 或宿主。

**2026-11-23 执行记录与 fail-closed 发布门 PoC：**独立的 PoC 发布门在 macOS（Python 3.9）和 Linux（Python 3.11）均通过 20 项单变量放行/阻断契约用例，覆盖输出截断/超时、销毁失败、活 worker PID 探测、硬链接/符号链接/vault 内执行记录拒绝、SHA-256 篡改、head 移动、信任与后端不匹配、`provider-vm` 生命周期证据校验（仅契约层，未调云 API），以及明确保留 `trusted-shared-kernel` 低保障标注。在 KVM/Firecracker 与 sandboxed vfkit 两端执行的 4 组真实 microVM 场景（`ok`、`trunc`、`alive`、`forge`）证明：只有输出完整、真实 worker 已确认 absent 且工作盘已删除的轮次才会由宿主写出 `boundary.json (mode:"microvm")`；输出截断、guest 伪造 `boundary.json` 以及 VM 仍存活（包括在 Linux worker `279874` / macOS vfkit `21406` 真实存活时提供谎称 `teardownStatus="destroyed"` 的对抗记录）均被 fail-closed 阻断并标记 `isolationIncident=true`，绝不生成 `boundary.json`。对应宿主门禁现已落地至 `scripts/verify-pr-check.mjs`、`scripts/verify-pr-prepare.mjs` 与 `scripts/verify-pr-vm-{collector,lifecycle,runner}.mjs`；CI workflow 与 `/review` 仍未修改。见 发布门专项实测 (`.qwen/e2e-tests/2026-11-23-publish-gate-workload.md`)。

## 7. 生命周期、输入与产物

### 7.1 一轮的顺序

1. 可信宿主沿用 prepare 解析 repo/base/head、评审快照及 context digest，并决定信任档。
2. 宿主创建包含两个 OID 可达历史的 Git pack/bundle、base 固定 `.qwen`、可信脚本和输入摘要；不执行生命周期脚本。
3. 分配私有 run 目录、每轮磁盘、资源限额、固定 vsock 端点、模型 token、collector 和总超时。
4. 验证 digest 与最小设备清单后，从 golden image 的工作副本启动干净 VM。
5. guest 接收输入、物化两个 OID 的源码，并使用每轮 scratch HOME 运行发布版验证 agent。
6. collector 按受限帧协议接收报告；PR 后台进程不能无限延长输出阶段。
7. 硬停止 VM，确认 VMM 退出，撤销 token，关闭端点并删除工作磁盘。
8. 宿主持有 execution record 后运行可信 checker 和 publish guard，再由独立发布器处理报告。

### 7.2 目录信任关系

宿主至少区分：

- **launcher-owned：**执行记录、上下文、输入清单、密钥代理坐标和清理状态，guest 不可写。
- **output vault：**collector 按内容写入的唯一报告接收位置，不位于 PR git 工作区。
- **guest-owned：**PR 源码、`.git`、依赖、构建和 guest 轮次产物；随工作磁盘销毁。

Checker 的新 microVM 路径不依赖旧容器路径中“产物必须位于 `--context-root` 之下”的约束。旧容器报告继续兼容，但不能把新产物的外部 vault 反向套成 PR 可写根。

### 7.3 清理的崩溃恢复

启动器按 runId 建立进程、cgroup/scope、磁盘、socket 和 token 的所有权记录，清理幂等。宿主启动器崩溃后，恢复器仅按该记录清理对应资源，禁止按 `node`、`qwen` 或 `firecracker` 名称做宽泛进程清理。

**2026-11-23 P4 资源耗尽与崩溃恢复 PoC：**独立的 `poc-reaper.py` 在 macOS 和 Linux 均通过 4 项安全单测（精准清理目标 PID 并保留并发无辜对照进程、可执行文件身份不匹配时拒绝误杀、拒绝删除批准 PoC 前缀外的宿主路径、拒绝符号链接 token 文件；并修复了单靠 `kill(pid, 0)` 将僵尸 `Z`/`X` 态误判为存活的缺陷）。在 KVM/Firecracker 与 sandboxed vfkit 两端执行的 3 组真实 microVM 场景均通过：(1) `fork-bomb` 在 guest 内真实派生 3,810（Linux）/ 3,786（macOS）个子进程直至 `EAGAIN`，宿主进程表未膨胀（Linux `386→388`，`vmm_threads=3`；macOS `849→851`）；(2) `disk-fill` 写满 256 MiB 工作盘剩余 16 MiB 命中 `ENOSPC`，源 rootfs 摘要未变且下轮启动无残留；(3) `launcher-crash` 对运行中启动器发真实 `SIGKILL`，先确认孤儿 VMM worker（Linux `296393` / macOS `23635`）、工作盘与未撤销 token 仍存活，再由独立 `poc-reaper.py`（`SIGTERM` 升级 `SIGKILL`）精准回收，同时并行无辜对照进程（Linux `296352` / macOS `23617`）完好存活且二次运行幂等。串口日志洪泛、多阶段崩溃注入与双轮并发争抢仍未验证。见 P4 专项实测 (`.qwen/e2e-tests/2026-11-23-p4-resource-reaper-workload.md`)。

## 8. 失败语义与应急开关

| 情况                                        | 结果                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| KVM/VZ、jailer 或 vfkit 宿主沙箱不可用      | 高保障运行拒绝或转远程 worker；不执行 PR                |
| 镜像、输入或启动策略 digest 不匹配          | 注入 PR 数据前拒绝                                      |
| 网络目的地超出 allowlist                    | 拒绝该请求并记录；必需能力缺失列为未覆盖或 inconclusive |
| fork bomb、磁盘耗尽、过量日志、模型预算耗尽 | 限制或停止本轮，不影响其他轮                            |
| 截断帧、异常路径、伪 boundary、摘要错误     | 不接受该输出为正常完整报告                              |
| VMM 不能停止、token 无法撤销或磁盘清理失败  | 禁止正常发布并标记隔离故障                              |
| head 或执行时信任分类变化                   | 不得把原轻量授予沿用到新 head；重新定级                 |
| 轻量后端不可用                              | 可升级高保障，不自动降级宿主                            |
| 安全事件正在进行或攻击路径未知              | 受信外部开关强制 `hardware-isolated`，关闭信任例外      |

输出不完整可以保留为隔离的取证材料，但不能把未运行或不确定的项目计成通过。安全违规事件不自动等同作者恶意，因为正常依赖也可能触发；报告应准确记录策略事件。

## 9. 镜像、资源与性能策略

Golden image 只能由受信流水线构建和发布，按 digest 选择。基础工具链接近当前 `node:22-bookworm` 验证环境，加入必要的 Git、shell、证书与构建工具；Java 档位增加受信版本的 JDK/Maven。发布的 CLI 版本和 skill 摘要进入记录。

首轮最小实现没有任意 PR 镜像字段、共享可写 Maven/npm 缓存、运行态快照或动态设备配置。浏览器下载限于受信镜像；无法提供时沿用现有文本报告降级。

CPU、内存、磁盘、日志、模型调用和并行 VM 数量以宿主资源档位控制，PR 不可修改。具体数值由真实 JS 与 Java 验证测量决定，不在 PoC 前凭经验承诺。

性能报告分别记录 VM 启动、输入物化、依赖安装、验证、输出和销毁，而不是只报告一个端到端时长。真实对照覆盖当前 Docker 路径和至少一个 TypeScript 验证场景。总时长仍需适应当前 agent/job 时间预算；性能数据决定后续是否需要干净磁盘池、可信只读包镜像或干净 VM 预热。

**2026-11-23 10 次冷启动基准 PoC（256 MiB 小夹具，N=10，仅报中位数，不宣称 p95）：**Linux Firecracker/jailer 在无 CoW 的 `ext4` 上测得 `diskCopy` 中位 285.6 ms、`bootToInput` 294.0 ms、`workload` 256.3 ms、`destroy` 1070.8 ms（其中约 1s 来自 PoC Python bridge 退出时的两个 0.5s 轮询间隔），同夹具 Linux `docker run --rm --network=none`（`trusted-shared-kernel`）中位 749.2 ms。macOS sandboxed `vfkit` 在 APFS 上测得 `diskCopy` 中位 4.8 ms（`cp -c`）、`bootToInput` 506.1 ms、`workload` 155.3 ms（完整保留 `bm08` 的 2271.0 ms 单次离群值）、`destroy` 1061.5 ms，同夹具运行在常驻 Ubuntu 24.04 Linux VM 内的 macOS Docker 中位 331.1 ms。干净冷启动本身仅 0.3–0.5 秒，证实初版完全无需运行态快照克隆；Linux 更大镜像场景的优先收益点是 CoW reflink 文件系统或干净未运行过的磁盘预复制池。见 P6 冷启动性能基准 (`.qwen/e2e-tests/2026-11-23-p6-cold-start-benchmark.md`)。

## 10. 实施阶段与影响面

### 阶段 0：信任规则与运行证据冻结

落盘本设计和 PoC 契约，确认实际安全事件复盘状态以及 ECS 外层 runner 的一次性 VM 证据。期间默认关闭信任例外。

### 阶段 1：最小平台 PoC

先证明 macOS vfkit 宿主进程 enforcing，再实现 Linux Firecracker/jailer 的最小冷启动。只使用专门构造的无真实凭据对抗夹具；无网卡、无目录共享、无运行态快照。

### 阶段 2：执行底座与宿主记录

实现统一输入/输出、vsock 能力端点、collector、执行记录、资源限制与清理恢复。先支持标准 TypeScript 工作和现有模型代理语义。

### 阶段 3：信任路由和报告门禁

在现有 authorize/prepare/checker 中显式命名 `prTrust` 与 `executionClass`，新增 microVM 边界路径，保持旧报告兼容。轻量档首版继续使用经审计的现有容器路线，不并行引入新的通用 bwrap 或 Seatbelt agent 后端。

### 阶段 4：功能与 CI 对齐

补齐 Java、Maven 和浏览器能力。CI 需要把 PR 的 install/build/agent 全部移入 disposable VM；不能只把最后的 agent 移入 VM 而继续在共享宿主容器中构建。额外补跑所有受影响 workflow 的 meta-tests。

### 阶段 5：基于测量优化和切换默认

通过安全验收和独立安全审查后再开放信任例外和默认选路。仅根据实际瓶颈增加缓存或干净预热；不为追求启动数字复用已运行 PR 的状态。

可能涉及：`.qwen/skills/verify-pr/SKILL.md`、`scripts/verify-pr-{prepare,check,guard,watch-gate,model-proxy}.mjs`、新的受信 runner/guest 与镜像构建代码、上述脚本的 collocated tests、`.github/workflows/qwen-triage.yml` 及 `scripts/tests/` 中所有引用它的元测试、以及本设计和 `.qwen/e2e-tests/` 计划。确切新增模块在 PoC 后定稿，不提前创造通用框架。

## 11. 验证策略

详细 PoC 计划见 `.qwen/e2e-tests/2026-11-23-verify-pr-tiered-microvm.md`。

验证顺序必须是：平台能力活性检查、正对照证明探针能发现风险、负向拒绝检查、生命周期和跨轮证据、最后才是真实小型验证与性能。不得只检查宿主上不存在某路径，或把一个未实际执行的测试数当作安全证明。

原型先在无真实密钥、无真实 PR、无生产网络的环境运行。它不实际利用内核 CVE；因此配置验收不能替代对 VMM/jailer/vfkit、网络目的地校验和 collector 的独立安全审查。

后续实现还必须按仓库规范执行单元测试、构建、typecheck、lint、workflow meta-tests 和真实端到端验证。本文新增不代表任何这些检查已经完成。

## 12. 验收标准

1. external、unknown、sponsored 或强制升级输入只能进入硬件边界；unknown 不能被静默归类为受信。
2. collaborator、head、执行档及升级原因被记录，head 变化后不得沿用旧轻量资格。
3. guest 非 root/root 都无法读取宿主 canary、连接宿主 canary 服务或改写 golden image；正对照证明这些探针有效。
4. 模型与依赖网关不接受任意目的地，私网、loopback、link-local、metadata 和 DNS 重绑定均在 VM 外被拒绝。
5. guest 无法在本地环境、输入或输出中发现真实模型/GitHub/OSS 凭据；每轮 token 销毁后失效。
6. 路径穿越、链接、伪门禁、巨大输出及异常帧不会越出 vault 或变为虚假完整报告。
7. fork bomb、磁盘填满和资源超限不会耗尽显式保留的宿主余量，也不会清理其他轮进程。
8. 各阶段中断后恢复器可以按 runId 清理；VM 未销毁或输出不完整不能发布正常 verdict。
9. 两个并行 PR 的磁盘、源码、凭据、报告及运行记录不互相可见。
10. macOS 上证明 vfkit 宿主沙箱实际 enforcing；否则本机高保障后端保持不可用并路由远程。
11. 受信轻量报告明确标注 `trusted-shared-kernel`，不能冒充高保障结果。
12. 典型验证有足够功能覆盖，并附有分阶段性能数据后才决定缓存或快照优化。

## 13. 备选方案与代价

- **全部使用容器或原生 bwrap/Seatbelt。** 最轻，但不能回答恶意 PR 针对宿主内核的问题，否决作为唯一方案。
- **全部使用 microVM。** 安全规则最简单，但中断了本地本人及受信贡献者的成本优化；保留为可配置最严格模式。
- **只靠作者权限自动宿主运行。** 账户可被接管、分支可包含他人代码，且 sponsor 不等于内容背书，否决。
- **risk screen 返回 clear 后降级。** 风险扫描不是恶意代码完整性证明，否决。
- **Docker 外再套 VM 作为长期形态。** 迁移较快但保留双层复杂度，可作临时过渡，不作为目标架构。
- **gVisor 或仅 rootless Podman。** 可作深度防御或受信档后端，不能代替高保障硬件边界。
- **Mac 裸 vfkit。** 具有 guest/host 第一层边界，但 VMM 被攻陷后仍暴露维护者权限，必须先解决宿主进程沙箱。

## 14. 待决问题

- 已发生安全事件的类型、爆炸半径和复盘何时允许重新开放信任例外。
- ECS runner 能否证明每个执行 VM 独占、无跨轮复用且无宿主凭据进入；该证据由 runner 运营方提供。
- Mac 目标版本上 vfkit + Seatbelt 是否可用且确实 enforcing；不成立时远程 Linux worker 是最初的指定退路。
- 支持镜像与依赖网关的最小目的地集合，尤其是 Maven、npm tarball、Playwright/Chromium。
- 不支持硬件虚拟化或 macOS PoC 失败的机器使用哪一个远程 worker，以及其调度、审计和模型成本归属。
- 资源档位的具体数值与性能门槛，待冷启动和真实工作负载测量后决定，不预先写死。
- 事件后受信贡献者是否默认可选轻量档。本文建议复盘后才开放，安全策略始终保留全局强制高保障开关。

## 15. 依据

- 当前验证契约：`.qwen/skills/verify-pr/SKILL.md`、`scripts/verify-pr-prepare.mjs`、`scripts/verify-pr-check.mjs`、`scripts/verify-pr-model-proxy.mjs`。
- CI 信任、执行与发布分离：`.github/workflows/qwen-triage.yml` 的 `authorize`、`verify`、`publish-verify`。
- [Firecracker design and threat model](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)。
- [Firecracker jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)。
- [Firecracker vsock](https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md)。
- [Firecracker snapshot uniqueness and limitations](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)。
- [vfkit Linux boot、raw disk、vsock、REST and device options](https://github.com/crc-org/vfkit/blob/main/doc/usage.md)。
