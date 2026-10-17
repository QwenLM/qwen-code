# K2 首次执行前出生证据与物理完成

[English](2026-10-16-k2-pre-exec-birth.md) | [简体中文](2026-10-16-k2-pre-exec-birth.zh-CN.md)

状态：实现进行中。常驻 Workspace 第一版独立维护。source/7 实现已将真实 shim 出生记录和安装字节观察接到 Java
读端。编译和普通数据测试不能证明已安装的首次执行前持续约束，不能授权物理释放。关联 #13395 和 Draft PR #13526。

## 问题

在 Start 后读取当前容器配置，不能证明运行时在第一条指令前实际消费了什么。
任务停止、cgroup 为空也不能补齐这个时间段。来源必须关联真实正常 Create、实际消费输入、
原始创建进程和正常 Start，随后才可以接受发布及停止证据。

## 真实任务边界

使用专用 `io.containerd.qwen-k2.v1` shim，其任务服务包装 containerd 的真实 runc
任务服务。仅接受原始 Kubernetes init 任务；拒绝 exec、checkpoint、update、pause、
resume 和终端操作。Create 先保留原始 ID、保护输入、取得持久化来源关联，随后仅重定位
Bundle 并委派完全相同的请求，最后绑定真实返回的 PID。Start 必须匹配同一 owner/PID
并取得来源许可，再委派正常 Start、报告真实结果。失败或结果不明的转换不能提供释放证据。

Delete 在清理输入前保存真实 native 响应。清理重试复用该响应，不再发第二次 Delete。
仅当每个已登记 owner 都完成清理，或在发起 native Create 之前准备失败时，才委派
Shutdown。native Create 结果不明时仍拒绝 shutdown。manager 的紧急清理仍是运行时维护
路径，不产生合格的正常停止回执。

shim 使用固定版本的 containerd SDK API，不另写任务引擎。SDK 模块要求的最低 Go
和依赖版本进入本模块锁文件。两个 Linux 架构都必须编译新 shim 命令及原 gateway/source
命令；构建成功仅证明编译通过。

## 实际消费输入与创建者通道

保留原始 Create protobuf 和 OCI 字节。另建私有 ext4 bundle，用 immutable 普通
文件保护原始/消费请求及配置。bundle 目录仍允许 runc 正常写入 PID、日志、rootfs 和
work 项。持续持有原始只读描述符和固定 runc 可执行文件。拒绝未知 protobuf 字段、请求
字段变化、超限输入、不安全路径及对象变化。不能用同一路径上两次相同的可变读取推断消费。

worker 保持已审阅的 OCI 原字节。sandbox 在 Create 前明确设置 no-new-privileges、
空 capability、AppArmor 和 cgroup namespace。两个角色都必须匹配覆盖命令、环境、挂载、
设备、seccomp 和保护路径的完整创建契约。解析契约属于数据校验，不提供部署资格。

使用私有 sequenced-packet Unix 创建者通道。认证真实 root peer、PID/start/pidfd、
immutable 可执行文件及 enforce 模式的 AppArmor label。传递持续持有的输入描述符，
不信调用者提交的文件 hash。每次回复都绑定序号、请求 hash、来源 incarnation 和原始关联。
通道丢失、peer 或输入对象变化会阻断活动关联。必须接通匹配的来源 handler 和日志读端后
才能安装该 shim；独立 producer 不等于可工作的来源。

## 持续持有服务输入

source 与 gateway 从启动起持续持有 immutable ext4 配置、CA、证书和私钥对象。
TLS 消费这些描述符读取的原字节；私钥必须为 0400。每个 control 操作在处理前、
返回缓冲响应前，重新核对原命名对象与持有的描述符。CSI 转发和 gateway RPC 在调用
两侧核对角色文件；输入改变或不可用时拒绝。每个角色文件仍限制为 32 KiB。

gateway 核对实际 root credentials、initial user mapping、仅 SYS_PTRACE 的
capability set、no-new-privileges、seccomp filter 及专用 enforce AppArmor
profile。两个 service unit 都声明各自必需的 profile，并允许所需 openat2 resolver。
unit 只执行经过审阅的 source 入口；可执行文件校验来自受保护 shim 配置，不再使用
独立 pre-start 程序。这些检查尚未完整测量已安装策略语义、实际 runtime handler、
admission actors 或独占 CSI 接线，不提供释放权限。

## 离线镜像输入

首次执行前 renderer 除三份 host 产物和创建契约原字节外，还必须取得真实 worker 与
sandbox OCI blob layout 及其具体 manifest digest。它核对每个有序 layer 的压缩字节
摘要、长度和未压缩 diff ID，在处理 whiteout 与 opaque directory 后生成最终文件清单。
不解压落地、执行、下载或安装镜像内容。JSON 字段必须唯一，采用 UTF-8，数值必须有限。
仅接受具体 OCI manifest、Linux amd64/arm64 配置和未压缩或 gzip OCI layer。
worker composer 将已验证的 gzip base blob 标记为 OCI gzip layer，即使 base 原来
使用 Docker layer descriptor，也不改变 blob 字节、digest 或 diff ID。

镜像命令必须通过有界 symlink 解析为与 host 产物同架构的可执行 ELF。每个 ELF
interpreter 必须解析到同镜像中的另一份可执行 ELF。其他可执行文件仍只是清单数据，
不成为额外获准入口。拒绝越过镜像根的链接、循环、非目录或隐式父项、不支持的文件
类型/xattr 和外部 blob descriptor。hardlink 仅支持同一 layer 中更早的普通文件，
并要求 inode metadata 一致；不支持跨 layer hardlink。每层压缩与展开字节分别限制为
1 GiB，整个镜像展开字节限制为 4 GiB，每层及最终树限制为 65,536 项。
manifest/configuration 合计限制为 64 KiB，每份输出清单限制为 16 MiB。

version-2 artifact manifest 绑定两份原始镜像 digest、完整清单字节及两个生成器文件。
候选输出独占且私有，所有输入校验先于目录创建。这接通了后续策略生成所需的离线镜像
输入路径；完整五角色策略、编译/加载、实际 actor 排除和下述安装权威仍待实现。

## 安装工件字节闭包

下一运行时前提是固定的 `/etc/qwen-k2/artifacts` 快照。离线组装器消费原工件/策略候选及成功编译记录，在创建新的私有输出前核对全部引用文件；仅复制闭集公开元数据、feature 字节和 packed policy，不打开配置引用的 TLS 或客户端凭据文件，不执行 parser、加载策略或安装文件。快照及清单仍是数据，不是安装证书或释放权限。

保留编译时准确的策略候选和 source 配置。为避免哈希循环，部署 source 配置只将其顶层 `workerPolicySha256` 的 JSON value token 替换为 packed 摘要，其余原字节全部不变；替换后不能重新生成编译候选。gateway 配置保持完整字节不变。

两个真实服务启动入口均须打开并持有固定快照，沿用 immutable ext4、名字及 descriptor 检查；持有私有不可变根及受保护祖先身份，经目录 FD 打开固定子名字，禁止符号链接和跨 mount。独立工件上限允许16 MiB目录/策略源码及8 MiB packed bundle，不扩大既有32 KiB出生/配置上限。将实际自身配置、固定自身 systemd unit、受保护 shim 配置与快照比较，保留既有受保护程序检查。对象持有到服务结束，并在既有 control、CSI、gateway、出生和后台观察边界持续复核；缺失或改变时拒绝启动或原操作。

source 还须将安装 packed hash、长度与实际 kernel policy 测量比较；gateway 保留自身 confinement 检查，不取得 source 的 kernel exporter 权限。两个角色均不读取另一个角色的真实配置或私钥，快照配置副本只含闭合配置中的路径和身份。

runtime 身份协议升级为第2版。gateway 字节观察包含完整原 installation manifest 摘要、架构、packed 摘要及长度、角色、实际自身配置路径/摘要、shim 摘要，以及固定自身 unit 路径/摘要；只有实际保留输入匹配后才能构造。source 在创建 journal 前，将全部字段与自己独立验证快照中的 gateway 角色比较。既有请求守卫随后比较完整原 gateway 身份，包括这些可比较的标量字段。角色、manifest 任一字节或输入不同即拒绝，不回退第1版。这是服务通道字节关联；[source/7](2026-10-17-k2-installed-byte-journal.zh-CN.md) 进一步持久保存配对观察及 ARM 原 frontend 身份，并接通 Java 独立已审元数据期待值。这些仍是已记录事实，不是已资格化安装身份。

此步将真实保留运行时输入与生成工件图关联，不证明 daemon 有效 handler、实际加载 unit 配置、外部 actor 排除、宿主反向策略、CSI 独占接线或无间隙生命周期；不创建安装 authority，不授予最终释放或放宽复用门。source/7 记录这些字节事实；其他真实 live 安装事实及外部信任根仍待补齐。

## 来源与释放依赖

离线策略阶段消费准确的第2版工件清单、两份镜像目录及 shim 配置，以及已审目标事实、原私有 Runtime 请求和两份实际服务配置。生成器输出单一五角色策略源码及服务 unit，unit 的 argv 使用同一配置路径。权限语法由生成器拥有，不接受调用者规则、include 或 AppArmor 模式。配置及密钥路径不能落入可写的 inputs、journal、socket 或 worker 根，不同角色私钥不能别名；宿主 peer 哈希必须与实际 source/gateway 配置一致。

策略源码仍是候选。AppArmor 能限定挂载类型、flags、source 和 destination，不能比较任意 mount data、设备编号或 DBus 消息正文；完整原契约继续由可信创建者及消费端比较。数字 proc 名还依赖实际内核只允许修改自身属性的语义，UID 相同不代表进程相同。SDK 子进程 OOM 调整及 disconnected namespace/root 命名需要明确的安装资格。生成五个命名 profile 不能补出既存宿主主体的反向权限，也不代表安装合格。

外层 snapshot 挂载输入与内层 OCI mount 分开；规则拆分正常挂载阶段，将原数据保留在已审目标及契约中。实际 source 类型、VFS flags 和 disconnected 别名仍需原生资格化。后续编译阶段消费完整 pinned 候选，以准确 parser/features、空配置、无 kernel load/cache 的方式执行，并保留失败记录。普通测试仅准备数据及检查 argv，绝不执行 parser；两个阶段均不授予释放权限。

当前 source/7 格式保留配对 sandbox/worker 出生、实际镜像及 snapshot 祖先链、原始消费
输入、创建进程 custody，以及明确的发布/停止/卸载依赖。Go producer 与 Java 读端一起
更新。decoder、签名、hash 链或自报摘要都不能资格化安装结果。读端必须通过绑定原始 SQL
连接的私有 authority 比较实际安装及已审阅 shim/runc/sandbox/角色输入，包含创建契约。

仅完整 authority 可以在同一连接提交最终回执和四个 compare-and-set 写入：物理结果、
原 binding、原占用 request slot 和原 holder。保留其他全部列及凭据原始值；任一计数
不符、溢出、到期或写后像不符，都回滚四项。后续 owner 保留该卷后，历史读取仍须返回
原始已保存结果。新 owner 必须使用新 Session/request/slot/binding 和实际单调递增
的共享 holder revision。整条路径接通前，不放宽当前复用闸门。

## 验证与验收

旧候选仅作只读参考，逐个选择已审阅文件，不整包恢复旧树、依赖或旧测试资格。当前候选
使用编译和允许的普通数据/Java 检查。此前被拒绝的 native/source/custody/Main-F2
组仍不执行；换目录或 runner 不改变该限制。

验收必须覆盖真实安装的 Create 到 Start 链、配对出生 custody、原始正常停止与 CSI
卸载、含回滚用例的四项原子写、历史凭据重放，以及后续不同 owner 使用同一卷。当前
元数据 fixture、编译产物和常驻 Workspace 验收都不能替代这些结果。任一前提缺失时，
物理释放和公开选择保持关闭。
