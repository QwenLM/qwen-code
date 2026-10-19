# K2 首个 systemd cold-init 软件切片

[English](2026-10-19-k2-first-systemd-cold-init.md) | [简体中文](2026-10-19-k2-first-systemd-cold-init.zh-CN.md)

## 状态与范围

这是 2026-10-19 供独立审查的软件实现草案，将已审 first-systemd 决策和强制 usermode-helper/module 减权落实到实现。不报告安装、policy load/lock、重启或 native 验收。代码及软件输出仅在 owned 隔离源码副本中准备，本切片不改动原工作树。

唯一首 lane 是 Ubuntu 24.04.5 amd64、kernel 6.8.0-139-generic 及实际 initramfs-tools 入口。生产调用链为：加固 `/init` → 原 `run-init` root switch → PID1 `/opt/qwen-k2/bin/k2-cold-init` → 同线程 on-exec 进入 `/usr/lib/systemd/systemd` → 固定空 `qwen-k2-cold.target`。不启动 bus、runtime、kubelet、CSI、source、gateway 或业务 actor。此终点不是可用 ACK 节点或完整 K2 producer。正常服务、selected CSI/admission、durable physical authority、RELEASED、history 和 reuse 是后续工作。

## Candidate 与接纳是分开的阶段

离线生成必须能在 native 测试前产出真正确定的 candidate。它检查 source/ELF/data pins、封闭形状和确定性加固输出，不要求先有成功 cold boot、accepted-node receipt、普通 staging files 的 immutable flags 或 build host 已加载 policy。因此受控 native 试验可使用该 candidate。candidate/generator 自报不授予 installation authority。

candidate 包含加固 initrd overlay/final image、rootfs payload、封闭 installation 图及外部字节 inventory；final image digest 不进入自身输入图。只有 owned 测试环境真实消费 boot image、建立 boot TCB/helper 边界、执行受限 systemd 终点并独立审计 cleanup 后，才能 native acceptance。未知/未支持 native 行为仍拒绝 lane，没有 force/skip/qualified 选项能接纳它。source/7、durable authority/release 语义不变。

## 已观察输入与真实入口

只读节点证据固定原 kernel `/boot/vmlinuz-6.8.0-139-generic`（15059336 bytes，SHA `0066409132868538bc0c9076f60131025775d5bbd8617df074d059f91b584918`）和 `/boot/initrd.img-6.8.0-139-generic`（62554950 bytes，SHA `898d873471a90fb4ce6cfb1c6161a9a67a44ba8a467a63ce651972910d58cf65`）。已知 15 个 initrd entries 为七份 script（`/init`、`/scripts/functions`、init-top/init-bottom 的 ORDER/udev、local-bottom ORDER）、四个 `/usr/bin/{busybox,env,run-init,switch_root}` 和四条 lexical loader/libc entries。四工具是同一 330000-byte 动态 BusyBox ELF，必须检查 interpreter/libc closure/声明 link chains，不称为静态 klibc。实际 systemd 有 24 条 dependency mappings，ldd 观察不覆盖将来全部 dynamic lookup。

生成器只用准确审核原 bytes/anchors 和固定替换模板，不做通用 init framework。删除替代 init、breakpoint、rescue/panic-hook/shell/reboot 和任意 argv/env/cmdline selectors，保留必要 root 挂载/虚拟文件系统移动。固定 `panic=0`、`systemd.import_credentials=no`，在动态 helpers/cold-init 启动前清除 runtime/LD/debug 环境。run_scripts 及每条可达 ORDER 调用/参数 source 显式向 PID1 传播失败，不依赖 set -e。固定 panic 输出有界字面诊断并 exit；实际 kernel fail-stop 仍是 native 测试义务。

udev shutdown 必须在请求退出之后真正 join/reap 已知可信 child；它并非最后一个 init-bottom helper。自可信创建起保留该 child 的明确 ownership，绝不杀未知 userspace 来让最终进程检查通过。完整 base digest 绑定继承 helper bytes，但不取代语义 TCB/native 审查。终止缺失或歧义阻止下一步。

## 强制 helper 闭合与 module capability 减权

新只读事实确认 efivarfs 真实挂在 `/sys/firmware/efi/efivars`（type de5e81e4）、两条 SystemdOptions 均 ENOENT、kernel-config SHA `a5debe1362156decce8c37181c3bbed212fb6b976a7bce481bb22cadb1dee48d` 未变、`/sbin/modprobe` 指向 `/usr/bin/kmod`、已加载 78 个 modules、module/kexec disable 为 0、UMH capability masks 全位。当前 hotplug/uevent helper paths 为空，但 modprobe 已启用，core_pattern 调 apport，suid_dumpable 为 2。这是启动后观察，不证明未来 boot 区间；modprobe 配置甚至有 install/remove directives。空 target 或固定普通 service unit 都不能闭合该通路。

最后可信 initrd helper/module 工作及 real-root handoff 之后，policy loading/systemd 之前，cold-init 验证实际 initial namespace/process 边界，并以有界 no-symlink/type/owner、完整写入和回读检查直接关闭以下准确 kernel interfaces：

| 固定 interface                  | 必须得到的 bytes                                                 |
| ------------------------------- | ---------------------------------------------------------------- |
| `/proc/sys/kernel/modprobe`     | 准确写入一个 LF byte（`\n`），严格回读恰好一个 LF，表示空 path。 |
| `/proc/sys/kernel/hotplug`      | 准确写入一个 LF byte（`\n`），严格回读恰好一个 LF。              |
| `/sys/kernel/uevent_helper`     | 准确写入一个 LF byte（`\n`），严格回读恰好一个 LF。              |
| `/proc/sys/kernel/core_pattern` | `core\n`，绝不是 pipe 或 caller 指定 command。                   |
| `/proc/sys/fs/suid_dumpable`    | `0\n`。                                                          |

绝不发零字节 write 或将其视为成功禁用。每个 interface 都要求一次完整非空写入及独立有界回读；short write、对象变化、不同 readback 都停止 boot。

将 exec caller 的 soft/hard RLIMIT_CORE 都设为零。只从 permitted/effective/inheritable/ambient/bounding 五套集合永久删除 CAP_SYS_MODULE，并在 exec 前独立回读五套，使用已经锁定的原 PID1 thread。bounding/inheritable 删除阻止 root exec 恢复该 capability。已审 systemd v255 kmod_setup 检查真实 effective capability，缺失时直接返回；这是真正减权，不是 fake conditional、可选开关或替换其他 guard。Go runtime threads 仍属 pre-policy TCB，不成为已保护 host actors；exec 销毁其他线程，systemd 继承减权 caller。不允许 goroutine/callback/child 让另一个仍有权限的线程代做 module/exec 操作。

systemd v255 在 manager 配置前调用 initialize_coredump(false)，尝试将 RLIMIT_CORE 提高至 infinity，并写入 core_pattern=|/bin/false；DumpCore=no 无法控制此前路径。renderer 无条件向 systemd profile 追加针对上述五个固定接口的 literal deny-write 规则及 `deny capability sys_resource,`。AppArmor deny 覆盖 broad host-base allow。继承的 CORE hard/soft 均为0且 enforced profile 经 LSM 拒绝 CAP_SYS_RESOURCE 的使用，systemd 无法提高 hard limit；已核上游代码记录失败后继续，Ubuntu 实际构建仍须 native 验收。

在 on-exec 前独立、有界地枚举 `/proc/thread-self/fd`。仅继承准确的三个 console descriptor；其余 retained/runtime descriptor 必须逐项分类且 CLOEXEC。所有 kernel-interface descriptor 均使用 CLOEXEC，并在此 gate 前关闭。未知、继承的 writable、发生变化或非 CLOEXEC descriptor 一律 fail-stop，防止 unconfined 阶段已打开的 writable FD 绕过后续 pathname deny。没有配置或测试 seam 可关闭此 gate。

未经另行设计，不额外设置 modules_disabled/kexec_load_disabled 或改变全局 UMH capability masks。清 helper entrypoints/移除 caller capability 不会排空已排队 kernel 工作，不能接受任何已知 userspace snapshot/API 作为 pending UMH 为空的证明。可信创建/终止纪律和真实 native boot trace 仍强制，缺少就拒绝 native acceptance，新软件没有跳过选项。

## 封闭字节图与生产读者

cold-bootstrap/1 仍恰好 13 个 top-level members：format、entryKind、architecture、kernel、baseInitrd、initrdInputs、coldInit、systemd、systemdDependencies、linkPlan、bootState、rootfsPlan、generators。bootState/rootfsPlan 固定 helper 闭合、capability 减权、空终点和 EFI/manager lookup 要求，不接受任意 path/permission arrays。不加 qualification flag。candidate values 绑定 bytes，runtime 读取实际 objects/kernel state。

| 合同                                                 | 修改与读者                                                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| target/3                                             | 强制 coldBootstrapSha256 和 systemBus.executable 字面 path/SHA；Python/Go/generated policy 验证 linkage。保留原必填 fields，拒绝 old/unknown/missing/null。                                               |
| profile-candidate/3                                  | 恰好 16 child pins，原 15 加 cold-bootstrap.json；renderer/compiler/独立 readers 比较固定集合。                                                                                                           |
| installed-artifacts/3                                | 恰好 26 files/25 manifest children，mandatory cold-bootstrap.json，总计 ≤64MiB；source/gateway 和新 loader 保留/验证实际 installed objects。                                                              |
| pre-exec-artifacts/2、compile/2                      | 保留 source/shim/runc 三项和真实 no-load compilation；新 ELF 由实际消费 cold contract 绑定。                                                                                                              |
| source7/identity2/observation1、Java durable records | 保留 fact/独立期望及 SQL/authority/release 边界；Java 比较独立打包的固定 lane 资源及 mandatory leaf/version/pins，拒绝 nested null/missing；测试核资源字节与 Go lane 精确一致，不做自报 native verifier。 |

保留原 config bounds（适用处 32KiB）、cold-bootstrap 64KiB、packed 8MiB、profiles/catalogues 各16MiB、六个 host bases 各1MiB。完整 bundle 仍恰好五类 Qwen/六类不同 host profiles，全部 enforce，没有 ambient/nested extras。新 leaf 必须进入真实 source/gateway AppArmor read 白名单，不能只写 metadata FILES。无环顺序：compiled loader/templates → cold contract → target/profile candidate → no-load compilation → installation（只改原 source workerPolicySha token）→ final image/外部 inventory。

## 真实 PID1、受保护 exec 与 kernel 操作

command 不接受 args 或替代 root/path。destructive operations 前要求真实 host PID1/原 main thread、受支持 initial PID/user/mount namespace、完整 uid_map、真实 proc/sysfs 和准确 kernel/rootfs。在 command init 锁 startup OS thread 且永不 unlock。leader/task 遍历有界，只允许 loader 和正向分类 kernel threads；其他 userspace/zombie/歧义拒绝。两次遍历不证明 lifetime/pending UMH。只有真实预期 mountpoint/context 允许时，才挂固定 securityfs，foreign mount/stacked AppArmor namespace 拒绝。

复用 immutable regular-file/nlink1/root owner/no-write/ext4/mount/ancestor 守卫，保留实际 file/ancestor FDs 并重验 named/held 身份。role-specific retained executable holder 每 ELF 上限128MiB、systemd/dependencies合计64MiB，不放宽原 input bounds。在加载前和 exec 前将实际 `/proc/1/exe` 对象与保留 loader 对齐。pin actual no-symlink systemd path/全部24 dependencies和明确声明 alias nodes/search inputs；受支持 runtime lane 拒绝 cache/preload/hwcaps/未知 lookup。unix.Exec(path) 是 pathname exec，并非 retained FD exec；无并发 mutator/boot TCB 仍必需。不加未审 execveat fallback。

真实 producer 要求 enforce/hash/export enabled、未锁的空已审 root policy namespace。一次 load 完整 packed bundle，独立比较所有 profile mode/object、同组 raw-data bytes/hash/length、ABI/context/revision，再 lock/readback 并等效复查。不用要求 source label/已锁的 consumer 冒充 producer。完整 kernel/helper/state/retained-input 检查后，确认 `/proc/thread-self` 是 `1/task/1`，才在原 thread 写固定的 `/proc/1/task/1/attr/exec` 并同线程 Exec。next-exec 前后失败都停止 PID1，无替代 exec/retry/reconnect。软件测试只能通过狭窄 package-private test seam 注入 destructive operations，production constructor 始终构造 real operations。

## 固定 systemd 终点与 pre-target 输入

immutable 0700 `/etc/qwen-k2/cold-systemd` 只含 immutable 0700 units。两个固定名称 generators/environment-generators 必须不存在，在 loading 前/exec 前经 retained parent 检查。现存空目录仍不够，v255 manager.c existence 检查仍会 fork sd-gens。units 恰好含85-byte target（`[Unit]\nDescription=Qwen K2 cold boot endpoint\nDefaultDependencies=no\nAllowIsolate=no\n`，SHA `37f7d64500e1fab843ab15d981f1550929e1d6ea69e93c8503f14d9f000c06b6`）、default.target → 该 target、apparmor.service → /dev/null；不能发现正常 service/drop-in。

cold-init 入口环境恰好 LANG=C。exec actual systemd argv 为 `["/sbin/init","noibrs"]`，环境恰好六项：LANG=C、SYSTEMD_LOG_TARGET=console、SYSTEMD_LOG_LEVEL=info、SYSTEMD_UNIT_PATH=/etc/qwen-k2/cold-systemd/units、SYSTEMD_GENERATOR_PATH=/etc/qwen-k2/cold-systemd/generators、SYSTEMD_ENVIRONMENT_GENERATOR_PATH=/etc/qwen-k2/cold-systemd/environment-generators，禁止尾冒号。upstream v255 commit db11bab38ccf1ed257f310d29070843d4c58ea01 确实读取这些变量替换 path，Ubuntu build 仍需 native 验证。

pin 51-byte `/etc/systemd/system.conf`（`[Manager]\nDumpCore=no\nCrashShell=no\nCrashReboot=no\n`，SHA `71d282b87f39bbe1d3a9b209df8f78f5d543883da3b43738721c5c4593523ad1`）及 /etc、/run、/usr/local/lib、/usr/lib 四个 absent/empty system.conf.d roots。要求 /etc/initrd-release、/etc/ima/ima-policy 不存在；真实可见 efivarfs 上 `/sys/firmware/efi/efivars/SystemdOptions-8cf2644b-4b0b-428f-9387-6d876050dc67` 和 `/run/systemd/efivars/` 同名文件均 ENOENT，unknown/unmounted/EACCES不是absence。现有观察已满足该采样检查，runtime仍须检查新boot。不用 SYSTEMD_EFI_OPTIONS 测试override。准确cmdline/credential-env检查使实际source-backed systemd.import_credentials=no 在payload导入前返回。首个systemd前实际移除module capability；其余hostname/machine-id、IMA/其他LSM/kernel state、dynamic startup/helper、boot-loader selection/先前TCB仍是具体native gates。空target本身不证明这些完成。

## 文件、验证与限制

影响范围为固定Python boot generator/packager/templates、render-profiles/compile-profiles fixed sets和LSM真实leaf read、Go cold-init/coldboot/retained birth/artifact readers、Java WorkspaceCsiInstalledBytes/独立fixtures/tests、完整双语design/deployment说明和E2E/software fallback计划。不改durable SQL/release/source7。

经真实subprocess测试安全generation/packaging，并独立读fixture bytes；逐项拒绝missing/extra/version/pin/alias/input/bound/output复用，核Python/Go/Java同图及原guard不变。用test-only operations测destructive时序/全部失败，不让fake success或CLI/env/root/PID/kernel bypass进入production。编译静态Linux amd64/arm64（native lane仅amd64），低并行/只读依赖输入运行Python/Go/Java定向检查、规定Maven verify和隔离root build/typecheck/bundle。保留每个失败及终态hash，做两次自审并由独立测试/review。当前privileged限制下明确不跑native E2E/physical acceptance。

软件工作不含本机/远端policy load/lock、既有VM配置/服务/特权状态变更、云API/安装/重启或worker/model动作。获准的普通UID Linux runner只能在自有临时source/cache/output树运行package-private fake操作及显式no-load/no-cache parser语法检查，不能视为native验收。失败保留有界证据，不创建authority或静默回滚locked boot。out-of-band recovery另需授权及新boot/custody。installed artifacts/cold tree仍immutable，不将需要写入的runtime OCI bundles/lifecycle directories整体immutable。
