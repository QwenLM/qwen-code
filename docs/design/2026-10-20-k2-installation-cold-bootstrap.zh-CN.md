# K2 安装物与冷启动软件

[English](2026-10-20-k2-installation-cold-bootstrap.md) | [简体中文](2026-10-20-k2-installation-cold-bootstrap.zh-CN.md)

## 状态与问题

这是 [#13526](https://github.com/QwenLM/qwen-code/pull/13526) 的第四个软件拆分，来源固定为 `af312254483a350d5655a40c84591c9e5512aaa9`。前一个节点证据拆分提供严格的安装字节读取器、共享冷启动通道契约及受控创建。这些读取器有意不授予安装权限。本拆分提供使用同一契约的离线生产工具与 Linux PID1 实现。在节点证据拆分合入 `main` 前，本 PR 堆叠于其上。

软件验证与原生验收分开。本改动不报告真实安装、策略加载或锁定、重启、节点验收、worker 执行、物理释放或复用。终点是空 systemd target，不是可用的 ACK 节点。编译器来源与实际宿主策略集仍须独立审查和原生认证。

## 范围与组件

| 组件               | 职责                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 离线输入与策略生成 | 绑定经过审查的可执行文件、镜像及配置字节；生成五个 Qwen 和六个不同宿主 profile，不使用环境 include 或隐藏输入。               |
| 不加载的编译       | 使用固定特性、空配置、不读缓存且不加载内核的显式固定 parser；保留失败尝试。                                                   |
| 安装物组装         | 校验闭合的 pre-exec、profile 和 compile 图；输出新的只读安装目录。                                                            |
| 冷启动候选与打包   | 加固精确审查过的 initramfs 入口，绑定真实 loader ELF 和 systemd 依赖，生成确定性的 initrd/rootfs 输出及外部清单。             |
| Linux cold-init    | 校验真实原始 PID1、线程、namespace 和持有对象，关闭 helper 接口、降低权限、加载校验并锁定策略，最后在原线程执行真实 systemd。 |

实现涉及 `deploy/k2-evidence`、`packages/k2-node-evidence/cmd/{k2-assemble-artifacts,k2-cold-init}` 及 `internal/{birth,coldboot}` 中的冷启动辅助代码。共享安装物读取器及独立 Java 通道继续使用前一个拆分的协议；不得为提取复制第二套定义或放宽校验。不新增持久 SQL、退役协调器、Pod 删除、历史或复用实现。

## 闭合图与顺序

共享协议保持 `pre-exec-artifacts/2`、`profile-target/3`、`profile-candidate/3`、`profile-compile/2`、`installed-artifacts/3` 及 `cold-bootstrap/1`。profile candidate 恰有 16 个固定子项。安装物恰有 26 个文件，包括清单自身和必选 cold-bootstrap 叶，总大小不超过 64 MiB。保留现有限制：冷启动契约 64 KiB、packed policy 8 MiB、profile/目录清单各 16 MiB、宿主 base 各 1 MiB，以及原有更小的配置限制。

无环顺序为 loader/模板 → 冷启动契约 → target 和 profile candidate → 不加载的编译 → 安装物 → 最终镜像及外部清单。组装只替换原始 source 配置的 worker-policy digest token，其余原始字节继续绑定。最终镜像摘要不进入自身输入图。Python 生产工具与 Go/Java 读取器必须接受同一个受支持图，并拒绝缺失、多余、null、旧版本、改动 pin 及不支持通道的输入。

输出均为候选。`nativeAcceptance: NOT_RUN` 表明这个边界，不是可以授予安装权限的开关。全新输出目录与独占文件创建避免静默复用输出；编译器、冷启动工具和组装器还要求绝对输出路径。生产 PID1 入口没有替代 root、PID、内核、宽松模式或测试环境开关。

## 固定首通道与 PID1 交接

唯一受支持的首启动通道为 Ubuntu 24.04.5 amd64、内核 `6.8.0-139-generic`。校验链为加固 `/init` → 原始 `run-init` 根切换 → 原始 PID1 的 `/opt/qwen-k2/bin/k2-cold-init` → 真实 `/usr/lib/systemd/systemd` → `qwen-k2-cold.target`。arm64 交叉构建只提供编译证据。

加固精确审查过的脚本字节和锚点，保留必要根挂载及文件系统移动。移除救援 shell、替代 init、断点/panic hook、调用者可选参数、环境及命令行选择器。每个可达 helper 和 ORDER 调用均传播失败。受信任的 udev 子进程有明确所有者，收到退出请求后被 join 并回收。未知进程直接拒绝，绝不为了通过扫描而杀死它们。此前 helper 和 Go runtime 线程仍属于启动 TCB。进程快照无法证明排队的 usermode-helper 工作为空。

策略加载前，对 `/proc/sys/kernel/modprobe`、`/proc/sys/kernel/hotplug` 和 `/sys/kernel/uevent_helper` 写入并独立回读精确的 `\n`，对 `/proc/sys/kernel/core_pattern` 写入 `core\n`，对 `/proc/sys/fs/suid_dumpable` 写入 `0\n`。零字节或短写绝不算成功禁用。在继承检查前关闭所有这些描述符。把 RLIMIT_CORE 软硬限制设为零，并在锁定的原线程上永久移除 permitted、effective、inheritable、ambient、bounding 五个集合中的 CAP_SYS_MODULE。在 exec 前立即独立验证五个集合。

systemd profile 无条件拒绝写入这五个接口并拒绝 `sys_resource`，即使宿主 base 广泛允许这些能力。这阻止早期 systemd 初始化提高继承的 core 硬限制或恢复 helper 设置。本拆分不额外修改 module/kexec 禁用开关或全局 usermode-helper capability mask。

持有并重新校验真实 immutable 文件、祖先及身份，包括正在运行的 loader、systemd、24 个固定依赖、内核与配置。检查初始 namespace、真实 proc/sysfs、预期 ext4/挂载状态、loader 所有权及有界进程/任务集合。只有三个精确 console 描述符允许跨 exec 保留，其余已分类描述符必须 CLOEXEC。未知或可写继承描述符终止启动。按路径 exec 仍依赖经过校验的启动 TCB 以及没有并发修改者。

只在经过审查、未锁定且为空的 AppArmor root namespace 加载一个完整 packed bundle。独立校验模式、导出原始字节、hash、大小、ABI/context/revision；锁定后再次回读。所有检查通过后才设置原始线程的 next-exec label，并在该线程 exec。任何失败都停止 PID1；没有替代 exec、重试或 fallback。破坏性软件测试仅使用包私有 fake，不增加生产旁路。

## 空 systemd 终点

immutable cold-systemd 树只包含 `units`。两个 generator 目录必须不存在；空目录仍会使 systemd 创建 generator 子进程。unit 目录包含固定 85 字节 target、指向该 target 的 `default.target` 以及指向 `/dev/null` 的 `apparmor.service`。不会启动普通 runtime、kubelet、CSI、source、gateway、bus 或业务服务。

cold-init 入口环境精确为 `LANG=C`。systemd 收到固定 argv 和六个固定环境项，其中 unit/generator 路径替换默认值且没有尾部冒号。固定 51 字节 manager 配置，拒绝环境 manager drop-in、initrd-release 及 IMA policy，要求可见 efivarfs 和两个 SystemdOptions 路径都不存在，并检查包括关闭凭证导入在内的精确命令行。这些防护不替代真实 Ubuntu systemd、动态查找、hostname/machine-id、其他 LSM、固件输入、待执行 helper 及更早启动 TCB 的原生测试。

## 验证与验收

先使用全局 `qwen` CLI 尝试基线。这些私有离线工具与 PID1 路径无法通过普通 CLI 调用到达；记录限制后采用软件测试脚本 fallback。执行 Python 生成器/打包器测试、Go 安装物组装及顺序/失败测试、Linux 包私有 fake 测试，以及 Linux amd64/arm64 静态构建。验证确定性输出与跨语言图消费；保留失败尝试，并将合成字节明确标为合成。

执行必需的根 build、typecheck、bundle、受影响消费者定向测试、格式/引用检查、两轮干净自审和独立审查。如果提取修改 Java 或其打包资源，再执行 Maven 检查。验证必须注明精确固定基线及最终候选。绿色软件测试不代表安装或原生验收。

第四部分的增量包含闭合的生产工具和消费者、通过上述检查、保留前一个拆分的严格契约及拒绝路径且可以独立评审时，软件提取才算完成。原生策略加载、锁定/回读、immutable 安装、bootloader 选择、真实 PID1 交接和清理仍是明确的后续门槛。不得在开发宿主上执行这些操作来验证本次提取。

## 待定问题与后续

本 PR 按节点证据分支发布前，该依赖必须先固定；其合并后再 rebase 并改目标为 `main`。原生宿主策略来源和受支持内核/systemd 行为需要独立证据。物理退役协调与持久进度属于第五部分。不得通过放宽检查或将生成的回执视为权限来消除待定问题。
