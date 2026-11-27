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
- **向后兼容：**保留既有手工 `select` 旗标、`runHardwareRound({ stageAssets: false })`、`run --config`，以及 legacy `container`、手动 `vm` 与 `waived` `/verify-pr` 流程。

## 3. 设计决策

### 3.1 Fail-Closed 真实宿主能力探测（`probeHostCapabilities`）

- **Linux KVM + Firecracker/jailer：**通过 `lstatSync`（拒绝 symlink 且要求字符设备）与真实 `openSync(O_RDWR | O_NOFOLLOW)` 验证 `/dev/kvm`，核验可读 cgroup v2 控制器（`/sys/fs/cgroup/cgroup.controllers`），要求非 root 正整数 `vmmUid`/`vmmGid`，并核验 `firecracker` 与 `jailer` 为非 symlink 普通可执行文件且 `--version` 退出 0 并输出非空版本行。
- **macOS ARM64 `vfkit` + Seatbelt（D7）：**要求 `darwin`/`arm64`，验证 `/usr/bin/sandbox-exec`，校验 `vfkit` 为非 symlink 普通可执行文件、其 `--version` 成功**且**真实 `/usr/bin/codesign -d --entitlements :-` 输出包含 `com.apple.security.virtualization`（拒绝空壳或未签名二进制），并执行 `probeSeatbeltEnforcement`。
- **真实 Seatbelt enforcing 活性探针（`probeSeatbeltEnforcement`）：**在纯净环境 `/usr/bin/env -i ... /usr/bin/sandbox-exec` 下以规范化（`realpathSync`）后的 `POC_DIR` 和 `POC_SOCKET_DIR` 执行子进程。仅当**两项正对照均成功**（`POC_DIR` 内读与写）**且两项负对照均被拒绝**（读 `POC_DIR` 外宿主 canary 与在外部创建文件均失败且无泄漏）时返回 `enforcing: true`。执行前拒绝 symlink 或多硬链外部 profile。

### 3.2 最小 Deny-Default macOS Seatbelt Profile（`renderVfkitSeatbeltProfile`）

- 以 `(version 1)`、`(deny default)`、`(import "system.sb")`（Apple 最小 dyld 与系统库底座，不含 `/Users`、`$HOME`、`/tmp` 或 IP 网络放行）开头，并显式叠加 `(deny network-inbound)` 与 `(deny network-outbound (remote ip))`。
- 仅放行 `POC_DIR` 与 `POC_SOCKET_DIR` 读写、`POC_SOCKET_DIR` 内的本地 Unix socket 绑定与连接、Virtualization.framework / Hypervisor 所需 Mach 与 IOKit 服务，以及校验后的安全绝对字面量执行路径（拒绝 `vfkitBin` 含引号、反斜杠、换行或 NUL 字节）。

### 3.3 每轮独立资产派生与磁盘配置校验

- **`copyIsolatedAsset`：**使用 `O_RDONLY | O_NOFOLLOW` 打开源文件，要求其为位于 `vaultDir` 外的单链接普通文件，拒绝覆写任意已存在目标，流式写入已规范化的 `realParent`（经 `approvedRoots` 校验）内 `O_CREAT | O_EXCL | O_NOFOLLOW` 临时文件并同步计算 SHA-256，核验目标 `(dev, ino)` 严格不同于源文件且 `nlink === 1`，应用权限与可选 `fchown`，再原子 `rename` 落盘到 `realParent`。
- **`stageLocalVmRound`：**
  - **Firecracker：**创建 `plan.jailRoot`，独立派生 `sourceKernelPath` 与 `sourceRootfsPath`，原子写出匹配 `plan.vmConfig` 的 `<jailRoot>/config.json` 与 `<jailRoot>/console.log`，并在 root 运行（或显式 `applyChown: true`）时赋权 `vmmUid:vmmGid`。
  - **`vfkit`：**在 `approvedRoots` 内创建 `0o700` 私有 `pocDir`/`socketDir`/`homeDir`/`tmpDir`，独立派生 `kernel`、`initramfs` 与 `rootfs`，若 `seatbeltProfile` 尚不存在则原子渲染写入（若已存在则以 `lstatSync` + 单链接读校验，拦截悬空符号链接）。
  - 任意步骤出错均自动回滚清理本次新建的全部文件与轮次目录；共享父目录仅在为空时以非递归 `rmdirSync` 尝试清理。
- **`verifyFirecrackerDiskConfig`：**校验 `<jailRoot>/config.json` 为单链接普通文件，且解析后的 JSON 与 `plan.vmConfig` 经 `util.isDeepStrictEqual` 深度严格相等（容忍合法键序重排，但拦截注入的 `network-interfaces` 或多余磁盘）。在 `stageAssets: true` 时强制校验存在且一致；在默认 Firecracker 启动路径中只要磁盘存在 `config.json` 亦强制校验。

### 3.4 Runner CLI 与编排器集成

- `node scripts/verify-pr-vm-runner.mjs probe [...]` 输出结构化 JSON 能力报告，至少一个硬件后端真实可用时退出 0，否则退出 1。
- `node scripts/verify-pr-vm-runner.mjs select --context <snapshot> --probe [...]` 将真实探测结果直接传入 `selectBackend`；混用 `--probe` 与手工 `--kvm`/`--vfkit`/`--seatbelt-enforcing` 或参数缺值均返回退出码 2。
- `runHardwareRound` 与 `run --config` 支持可选 `stageAssets: true`、`sourceInitramfsPath` 与 `applyChown`；启动前失败自动回滚清理已派生资产，运行结束后仅在 `reapOwnership` 证明 worker 消失后才在 `finally` 清理剩余每轮 staged 文件。

## 4. 验收标准

1. `renderVfkitSeatbeltProfile` 拒绝不安全 `vfkitBin` 字面量，生成策略可通过真实 macOS `sandbox-exec` 读写正/负对照，并阻止向本地 TCP canary 的出站连接（同时无沙箱正对照可连上该 canary）。
2. `probeSeatbeltEnforcement` 对宽松 `(allow default)`、symlink、hardlink profile 及非 darwin 平台均返回 `enforcing: false`。
3. `probeHostCapabilities` 通过真实 `codesign` 拒绝缺少 `com.apple.security.virtualization` 的空壳 `vfkit`，拒绝非字符设备/symlink `/dev/kvm`、symlink 或执行失败的 `firecracker`/`jailer`、缺失 cgroup v2 与 root `vmmUid`，并在真实 Linux KVM + Firecracker/jailer 宿主上返回 `kvmAvailable: true`。
4. `copyIsolatedAsset` 与 `stageLocalVmRound` 强制校验 `approvedRoots`、`vaultDir` 排除、单链接源、独立目标 inode、拒绝覆写、悬空 symlink 拦截以及失败完整回滚。
5. `verifyFirecrackerDiskConfig` 接受键序重排的等价配置，并在启动 Firecracker 前拦截被篡改的磁盘 `config.json`（如注入网卡）。
6. `runHardwareRound({ stageAssets: true })` 在零手工 staging 下跑通真实 Linux Firecracker/KVM 轮次：`outputStatus=complete`、`teardownStatus=destroyed`、产出 `boundary.json (mode:"microvm")`、`jailRoot` 与工作盘清零、只读 golden kernel/rootfs SHA-256 未变。

## 5. 实测证据与边界

基于最终精确字节测量（`verify-pr-vm-host.mjs` `f6ee7de2…`、`verify-pr-vm-runner.mjs` `159cc194…`、`verify-pr-vm-host.test.js` `8d9948fb…`）：

| 环境                                             | 实测结果                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS arm64、Node 24.18.1                        | 4 套聚焦单测（`verify-pr-vm-{host,runner,channel}` + `verify-pr-credential-scan`）：**76 项通过，0 失败**。真实 `/usr/bin/sandbox-exec` 正/负对照、宽松 profile 拒绝、本地 TCP canary 外连拒绝（含无沙箱正对照）与真实 `codesign` 空壳 `vfkit` 拒绝全部通过；仓库完整 `npm run lint` 与 Prettier 通过。                                                                                                                                                      |
| Linux aarch64、Node 22.23.5（`qa-host-staging`） | 全部 12 份 `scripts/tests/verify-pr*.test.js`：**549 项通过，9 项环境跳过**。                                                                                                                                                                                                                                                                                                                                                                                |
| Linux KVM 真实 CLI `probe` 与 `select --probe`   | 实测打开 `/dev/kvm` 字符设备、cgroup v2、`Firecracker v1.18.0`、`Jailer v1.18.0`；`select --probe` 自动选出 `backend: "firecracker"`。                                                                                                                                                                                                                                                                                                                       |
| 零手工 staging 真实 Firecracker/KVM 端到端       | `runHardwareRound({ stageAssets: true })`（guest `9cc5977f…`，派生镜像 `a719de5e…`）：`ok: true`、`outputStatus: "complete"`、`teardownStatus: "destroyed"`、`guestChecks: 15`、`guestNoNic: true`、`guestHasDirShare: false`、`upstreamAuthOk: true`、`upstreamHits: 1`、`jailRootCleaned: true`、`workDiskCleaned: true`、`boundaryMode: "microvm"`、`boundaryBackend: "firecracker"`。只读 golden kernel（`aee80c3a…`）与 rootfs（`1ba7902e…`）复核未变。 |
| 真实 Linux 磁盘 `config.json` 篡改负控制         | 向磁盘 `<jailRoot>/config.json` 注入 `network-interfaces` 在 `jailer` 启动前被 fail-closed 拦截（`firecracker disk config.json does not match validated plan.vmConfig`）。                                                                                                                                                                                                                                                                                   |

**明确未覆盖边界：**本机 macOS 未安装 `vfkit` 二进制，未运行真实 macOS `vfkit` microVM 启动（macOS 实测覆盖真实 Seatbelt enforcing、TCP 拒绝与真实 `codesign` 空壳拦截）；不覆盖云 `provider-vm` / Agent Sandbox 分配、外部模型端点、Windows IPC，也不替代远端 GitHub CI 与维护者审批。
