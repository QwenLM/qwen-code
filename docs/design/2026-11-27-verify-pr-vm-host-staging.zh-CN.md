# `/verify-pr` MicroVM 宿主能力活性探测与每轮 VMM Staging 设计

[English version](2026-11-27-verify-pr-vm-host-staging.md)

**状态：已在 macOS arm64 与 Linux aarch64 KVM 实现并实测；PR 评审与远端 CI 仍为独立门槛。日期：2026-11-27。**

## 1. 背景与目标

前序 `/verify-pr` microVM 里程碑已落地信任分级（`scripts/verify-pr-prepare.mjs`）、宿主记录门禁（`scripts/verify-pr-check.mjs`）、属主回收与定稿（`scripts/verify-pr-vm-lifecycle.mjs`）、有界产物收集器（`scripts/verify-pr-vm-collector.mjs`）、3 端口 guest vsock 通道（`scripts/verify-pr-vm-channel.mjs`、`scripts/verify-pr-vm-guest-vsock.py`）以及启动计划与编排器（`scripts/verify-pr-vm-runner.mjs`）。

在脱离手工 PoC 胶水脚本直接驱动真实本机 microVM 之前，仍存在两处操作缺口：

1. `select` 仅接受手工布尔旗标（`--kvm`、`--vfkit --seatbelt-enforcing`），缺少真实的宿主能力探测与 macOS Seatbelt enforcing 活性探针。
2. `runHardwareRound` 仍要求调用方手工创建 Firecracker `jailRoot`、手工独立拷贝只读 golden kernel/rootfs、手工写出并赋权 `<jailRoot>/config.json`，或手工编写 macOS deny-default Seatbelt `.sb` 并准备 `vfkit` 资产，且未在启动前将磁盘上的 `<jailRoot>/config.json` 与 `plan.vmConfig` 做一致性校验。

本次改动通过单一聚焦模块（`scripts/verify-pr-vm-host.mjs`）及 `scripts/verify-pr-vm-runner.mjs` 的最小向后兼容接线补齐上述阶段 2 宿主侧缺口。

## 2. 范围与硬约束

- **允许改动范围：**`scripts/verify-pr-vm-host.mjs`、`scripts/verify-pr-vm-runner.mjs`、`scripts/tests/verify-pr-vm-host.test.js`、本双语设计文档，以及 `#18400` R5 登记延期的 5 项测试/文档收尾（`scripts/tests/verify-pr-vm-channel.test.js` 与 `docs/design/2026-11-25-verify-pr-round-input-hardening.{md,zh-CN.md}`）。
- **范围之外（不得触碰）：**`packages/`、`.github/`、`.qwen/skills/`、`/review`、新建云资源、真实模型凭据及 guest 内部工作负载打包。
- **向后兼容：**保留既有手工 `select` 旗标、`run --config` 以及 legacy `container`、手动 `vm` 与 `waived` `/verify-pr` 流程。在默认 Firecracker 启动路径中若 `stageAssets: false` 且 `<jailRoot>/config.json` 缺失，仍兼容既有伪 jailer 夹具；但只要磁盘上存在手写 `<jailRoot>/config.json`，现强制要求其与已验证的 `plan.vmConfig` 深度严格相等（多余小节如 `logger`/`metrics` 或注入的 `network-interfaces` 将在启动前被拒绝）。

## 3. 设计决策

### 3.1 Fail-Closed 真实宿主能力探测（`probeHostCapabilities`）

- **Linux KVM + Firecracker/jailer：**通过 `lstatSync`（拒绝 symlink 且要求字符设备）与真实 `openSync(O_RDWR | O_NOFOLLOW)` 验证 `/dev/kvm`，核验可读 cgroup v2 控制器（`/sys/fs/cgroup/cgroup.controllers`），要求非 root 正整数 `vmmUid`/`vmmGid`，并核验 `firecracker` 与 `jailer`（无论通过显式旗标传入还是经 `PATH` 发现）为非 symlink 普通可执行文件且 `--version` 退出 0 并输出非空版本行。
- **macOS ARM64 `vfkit` + Seatbelt（D7）：**要求 `darwin`/`arm64`，验证 `/usr/bin/sandbox-exec`，校验 `vfkit`（显式传入或经 `PATH` 发现）为非 symlink 普通可执行文件、其 `--version` 成功**且**真实 `/usr/bin/codesign -d --entitlements :-` 输出包含 `com.apple.security.virtualization`（拒绝空壳或未签名二进制），并执行 `probeSeatbeltEnforcement`。
- **真实 Seatbelt enforcing 活性探针（`probeSeatbeltEnforcement`）：**在纯净环境 `/usr/bin/env -i ... /usr/bin/sandbox-exec` 下以规范化（`realpathSync`）后的 `POC_DIR` 和 `POC_SOCKET_DIR` 执行子进程。仅当**两项正对照均成功**（`POC_DIR` 内读与写）**且两项负对照均被拒绝**（读 `POC_DIR` 外宿主 canary 与在外部创建文件均失败且无泄漏）时返回 `enforcing: true`。外部 profile 以 `O_NOFOLLOW | O_NONBLOCK` 打开（拒绝 symlink、多硬链与 FIFO），且非法 `vfkitBin` 字面量会 fail-closed 返回 `enforcing: false` 而非抛出未捕获异常。

### 3.2 最小 Deny-Default macOS Seatbelt Profile（`renderVfkitSeatbeltProfile`）

- 以 `(version 1)`、`(deny default)`、`(import "system.sb")`（Apple 最小 dyld 与系统库底座，不含 `/Users`、`$HOME`、`/tmp` 或 IP 网络放行）开头，并显式叠加 `(deny network-inbound)` 与 `(deny network-outbound (remote ip))`。
- 显式授权范围包括：
  - 进程自身管理：`process-fork`、`signal (target self)`、`process-info* (target self)`。
  - `/bin/sh` 活性探针与 `vfkit` 所需的执行与读取：`/bin`、`/usr/bin` 以及经校验的安全绝对 `vfkitBin` 字面量（拒绝引号、反斜杠、换行或 NUL 字节）上的 `process-exec`、`file-read*` 与 `file-map-executable`。
  - 每轮存储与 vsock UDS：`POC_DIR` 与 `POC_SOCKET_DIR` 下的 `file-read*` / `file-write*`，以及仅限 `POC_SOCKET_DIR` 内的 Unix socket `network-bind` / `network-outbound`。
  - Apple Virtualization 服务：`mach-lookup`（`com.apple.Virtualization.VirtualMachine`、`com.apple.SecurityServer`、`com.apple.CoreServices.coreservicesd`）与 `iokit-open`（`AppleHVClient`、`RootDomainUserClient`）。

### 3.3 每轮独立资产派生与磁盘配置校验

- **`copyIsolatedAsset`：**使用 `O_RDONLY | O_NOFOLLOW` 打开源文件，要求其为位于规范化 `vaultDir`（对符号链接 `vaultDir` 执行 `realpathSync`）外的单链接普通文件，规范化 `approvedRoots` 条目（对尚不存在的根经最深已存在祖先解析，使 macOS `/tmp/qc-vm` 等符号链接前缀与规范化目标拼写一致），在校验前保留末级规范化目标前缀（并在创建父目录后对 `safeDest` 再次复查），拒绝覆写任意已存在目标，流式写入 `realParent` 内 `O_CREAT | O_EXCL | O_NOFOLLOW` 临时文件并同步计算 SHA-256，核验目标 `(dev, ino)` 严格不同于源文件且 `nlink === 1`，应用权限与可选 `fchown`，再原子 `rename` 落盘到 `realParent`。
- **`stageLocalVmRound`：**
  - **Firecracker：**创建 `plan.jailRoot`，独立派生 `sourceKernelPath` 与 `sourceRootfsPath`，原子写出匹配 `plan.vmConfig` 的 `<jailRoot>/config.json` 与 `<jailRoot>/console.log`，并在 root 运行（或显式 `applyChown: true`）时赋权 `vmmUid:vmmGid`。
  - **`vfkit`：**在 `approvedRoots` 内创建 `0o700` 私有 `pocDir`/`socketDir`/`homeDir`/`tmpDir`（拒绝任何允许组/其他用户访问的既有目标目录），独立派生 `kernel`、`initramfs` 与 `rootfs`，若 `seatbeltProfile` 尚不存在则以只读 `0o400` 原子渲染写入；若计划的 `-f` 路径上已存在 profile，必须位于 `approvedRoots` 内（且在 `vaultDir` 外）、通过非阻塞单链接读校验、与 `renderVfkitSeatbeltProfile({ vfkitBin })` 逐字节一致，并在 `darwin` 上通过实时 `probeSeatbeltEnforcement`。
  - 精确记录本次调用实际创建的每一级目录（包括资产与文件写入助手创建的父目录）；回滚时删除已创建文件，仅对本次新建的每轮运行时目录（新建 Firecracker `jailRoot` 与新建 `vfkit` 的 `pocDir`/`socketDir`/`homeDir`/`tmpDir`）执行递归清理，其余所有新建目录由深到浅通过非递归 `rmdirSync` 剪枝，绝不删除调用方预创建的父目录。
- **`verifyFirecrackerDiskConfig` 与 `verifyVfkitSeatbeltProfile`：**以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开 `<jailRoot>/config.json` 与 `vfkit` `-f` Seatbelt 配置（拒绝 symlink、FIFO 与多硬链），分别校验与 `plan.vmConfig` 深度一致（`util.isDeepStrictEqual`）以及与 `renderVfkitSeatbeltProfile({ vfkitBin })` 逐字节一致（且位于 `approvedRoots` 内、`vaultDir` 外）。默认启动路径会在 token/collector 准备前及紧邻 `spawn()` 前执行双重校验（`stageAssets: true` 时无条件强制存在且匹配，`stageAssets: false` 时只要磁盘文件存在即强制匹配）。

### 3.4 Runner CLI 与编排器集成

- `node scripts/verify-pr-vm-runner.mjs probe [...]` 输出结构化 JSON 能力报告，至少一个硬件后端真实可用时退出 0，否则退出 1。
- `node scripts/verify-pr-vm-runner.mjs select --context <snapshot> --probe [...]` 将真实探测结果直接传入 `selectBackend`；混用 `--probe` 与手工 `--kvm`/`--vfkit`/`--seatbelt-enforcing`、未传 `--probe` 时传入仅探针参数、参数缺值（含紧随其后的 `--` 标志）或非法 uid/gid 均返回退出码 2。
- `runHardwareRound` 与 `run --config` 支持可选 `stageAssets: true`、`sourceInitramfsPath` 与 `applyChown`；启动前失败自动回滚清理已派生资产，运行结束后仅在 `reapOwnership` 证明 worker 消失后才在 `finally` 清理剩余每轮 staged 文件。

## 4. 验收标准

1. `renderVfkitSeatbeltProfile` 拒绝不安全 `vfkitBin` 字面量，生成策略可通过真实 macOS `sandbox-exec` 读写正/负对照，并阻止向本地 TCP canary 的出站连接（同时无沙箱正对照可连上该 canary）。
2. `probeSeatbeltEnforcement` 对宽松 `(allow default)`、symlink、hardlink profile 及非 darwin 平台均返回 `enforcing: false`。
3. `probeHostCapabilities` 通过真实 `codesign` 拒绝缺少 `com.apple.security.virtualization` 的空壳 `vfkit`，拒绝非字符设备/symlink `/dev/kvm`、symlink 或执行失败的 `firecracker`/`jailer`、缺失 cgroup v2 与 root `vmmUid`，并在真实 Linux KVM + Firecracker/jailer 宿主上返回 `kvmAvailable: true`。
4. `copyIsolatedAsset` 与 `stageLocalVmRound` 强制校验 `approvedRoots`、`vaultDir` 排除、单链接源、独立目标 inode、拒绝覆写、悬空 symlink 拦截以及失败完整回滚。
5. `verifyFirecrackerDiskConfig` 接受键序重排的等价配置，并在启动 Firecracker 前拦截被篡改的磁盘 `config.json`（如注入网卡）。
6. `runHardwareRound({ stageAssets: true })` 在零手工 staging 下跑通真实 Linux Firecracker/KVM 轮次：`outputStatus=complete`、`teardownStatus=destroyed`、产出 `boundary.json (mode:"microvm")`、`jailRoot` 与工作盘清零、只读 golden kernel/rootfs SHA-256 未变。

## 5. 实测证据与边界

基于最终精确字节测量（`verify-pr-vm-host.mjs` `5e678418…`、`verify-pr-vm-runner.mjs` `dfafd09e…`、`verify-pr-vm-host.test.js` `44a3afb5…`）：

| 环境                                             | 实测结果                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64、Node 24.18.1                        | 4 套聚焦单测（`verify-pr-vm-{host,runner,channel}` + `verify-pr-credential-scan`）：**76 项通过，1 项 root 门控跳过，0 失败**。真实 `/usr/bin/sandbox-exec` 正/负对照、宽松 profile `reasons` 精确校验、差分 TCP 拒绝（`SANDBOX_EXEC_OK` + `nc: connectx … Operation not permitted` + 无沙箱正对照）、真实 `codesign` 空壳 `vfkit` 拒绝、符号链接 `vaultDir` 与未创建符号链接 `approvedRoots`、`vfkit` 启动前复查、`0o700` 私有目录校验与 CLI staging 均通过。   |
| Linux aarch64、Node 22.23.5（`qa-host-staging`） | 全部 12 份 `scripts/tests/verify-pr*.test.js`（以 root 运行，含默认 `applyChown` uid/gid/mode 实测）：**550 项通过，9 项环境跳过**。                                                                                                                                                                                                                                                                                                                             |
| 删守卫负控制矩阵（Linux）                        | **24/24 全部击杀**：R1 **11/11**（`R1-1`、`R1-2`、`R1-3` FIFO 阻塞、`R1-4`、`R1-7`～`R1-13`）加 R2 **13/13**（`R2-1` 启动前 `vfkit` profile 复查、`R2-2` 未创建批准根规范化、`R2-3` 符号链接 `vaultDir`、`R2-4` `vfkit` 运行目录清理、`R2-5` `0o700` 权限校验、`R2-7` 反斜杠/NUL 守卫、`R2-8` 禁 `(allow default)`、`R2-9` `vfkit` `PATH` 发现、`R2-10` root 默认 `fchownSync` 与 `R2-11a`～`R2-11d` 全部 4 项镜像身份守卫）。                                   |
| Linux KVM 真实 CLI `probe` 与 `select --probe`   | 实测打开 `/dev/kvm` 字符设备、cgroup v2、`Firecracker v1.18.0`、`Jailer v1.18.0`；`select --probe` 自动选出 `backend: "firecracker"`。                                                                                                                                                                                                                                                                                                                           |
| 零手工 staging 真实 Firecracker/KVM 端到端       | `runHardwareRound({ stageAssets: true })`（guest `9cc5977f…`）：`ok: true`、`outputStatus: "complete"`、`teardownStatus: "destroyed"`、`guestChecks: 15`、`guestNoNic: true`、`guestHasDirShare: false`、`upstreamAuthOk: true`、`upstreamHits: 1`、`jailRootCleaned: true`、`execDirCleaned: true`、`jailBasePreserved: true`、`boundaryMode: "microvm"`、`boundaryBackend: "firecracker"`。只读 golden kernel（`aee80c3a…`）与 rootfs（`1ba7902e…`）复核未变。 |
| 真实 Linux 磁盘 `config.json` 篡改负控制         | 向磁盘 `<jailRoot>/config.json` 注入 `network-interfaces` 或多余 `logger` 在 `jailer` 启动前被 fail-closed 拦截（`firecracker disk config.json does not match validated plan.vmConfig`）。                                                                                                                                                                                                                                                                       |

**明确未覆盖边界：**本机 macOS 未安装 `vfkit` 二进制，未运行真实 macOS `vfkit` microVM 启动（macOS 实测覆盖真实 Seatbelt enforcing、TCP 拒绝与真实 `codesign` 空壳拦截）；不覆盖云 `provider-vm` / Agent Sandbox 分配、外部模型端点、Windows IPC，也不替代远端 GitHub CI 与维护者审批。
