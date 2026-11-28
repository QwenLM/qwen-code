# `/verify-pr` MicroVM 标准 Guest 入口与离线 Golden 镜像派生设计

[English version](2026-11-28-verify-pr-vm-guest-init-and-image.md)

**状态：已在 macOS arm64 与 Linux aarch64 KVM 实现并实测；PR 评审与远端 CI 仍为独立门槛。日期：2026-11-28。**

## 1. 背景与目标

PR #18552 合入后，`/verify-pr` microVM 宿主侧整条流水线（`probe` → `select --probe` → `stageLocalVmRound` → `runHardwareRound` → `reapOwnership` → `verify-pr-check`）已完全在仓库内闭环。但阶段 2 仍有两块关键能力停留在仓外临时 PoC 脚本中：

1. 标准 PID-1 guest 启动入口与零第三方依赖的 guest 生命周期编排器，用于串联 3 端口 guest vsock 通道（`fetch-inputs`、`model-bridge`、`upload-artifacts`）、熵注入、隔离自检、bundle 物化、剥离凭据的工作负载执行与干净关机。
2. 离线、只读 golden ext4 rootfs 派生工具，在不挂载 loop 设备、不修改只读 golden 源镜像的前提下注入上述受审 guest 脚本。

本次改动将这两块正式入库至 `scripts/`，彻底脱离仓外 PoC 胶水脚本，同时一并落盘 PR #18552 评审中记录的 2 条非阻断 follow-up（`ensureApprovedDirHierarchy` 接受目录本身等于规范化 `approvedRoot`，以及将 `createdDirs.push(nextDir)` 紧接 `mkdirSync` 置于 `chmodSync` 之前）。

## 2. 范围与硬约束

- **允许改动范围：**`scripts/verify-pr-vm-guest-init.sh`、`scripts/verify-pr-vm-guest-runner.py`、`scripts/verify-pr-vm-image.mjs`、`scripts/verify-pr-vm-host.mjs`、同目录 collocated 单测（`scripts/tests/verify-pr-vm-{guest-runner,image,host}.test.js`）以及本双语设计文档。
- **范围之外（不得触碰）：**`packages/`、`.github/`、`.qwen/skills/`、`/review`、云资源分配、外部模型调用与真实凭据。
- **向后兼容：**保留既有默认启动 `bootArgs`（`init=/opt/poc/init`）、手工 `stageAssets: false` 流程以及 legacy `container`、手动 `vm` 与 `waived` `/verify-pr` 流程。

## 3. 设计决策

### 3.1 极简 PID-1 Guest Init（`scripts/verify-pr-vm-guest-init.sh`）

- 纯 POSIX `#!/bin/sh`（`shellcheck -s sh` 零警告），同时兼容 BusyBox 与 Debian rootfs。
- 挂载 `/dev`（`devtmpfs`）、`/proc`、`/sys`、`/run`（`tmpfs`），按需加载 `virtio_vsock`，仅拉起回环接口 `lo`（无外网 NIC），导出无宿主凭据的干净环境，调用 `guest-runner.py --from-cmdline`，完成后 `sync` 并在 PID 1 下干净关机以避免内核 panic。

### 3.2 零依赖 Guest 生命周期编排器（`scripts/verify-pr-vm-guest-runner.py`）

- 仅使用 Python 3 标准库，动态加载同目录 `verify-pr-vm-guest-vsock.py`（或镜像内的 `/opt/qwen/guest-vsock.py`）。
- 按 7 步 fail-closed 契约执行：
  1. 通过端口 53 拉取并校验 `manifest.json`、`round.bundle` 与 `entropy.hex` 的 SHA-256（支持 `--unix-input` 用于宿主侧离线测试）。
  2. 解码 64 位十六进制 `entropyHex` 并将 32 字节写入 `/dev/urandom`（支持 `--urandom-path` 单测）。
  3. 检查 `/sys/class/net` 与 `/proc/mounts`，核验仅含 `lo` 接口（`noNic`）且不存在宿主机共享目录挂载（`virtiofs`/`9p`/`vboxsf`/`vmhgfs`/`fuse.sshfs`）。
  4. 从 `round.bundle` 物化纯净 Git 工作区并验证 `baseRefOid` 与 `headRefOid` 提交；仅当针对无 `git` 的极简 BusyBox 镜像显式传入 `--skip-materialize` / `qwen.skip_materialize=1` 时，改为以纯 Python 校验 Git v2/v3 bundle 头部及其声明的两个 OID（`verify_bundle_header`）。
  5. 当 `manifest.modelProxy` 非空时，启动 `model-bridge` 监听 `127.0.0.1:0` 转发端口 54（测试用 `--unix-model`），在启动任何 workload 前调用 `GET /__health` 校验返回的裸 `nonce` 逐字节匹配；不匹配立即 fail-closed 并停止 bridge。
  6. 在剥离宿主凭据的环境中执行 `--workload`（或 `/opt/qwen/workload.sh`，仅暴露工作区/产物路径及本轮临时回环桥接地址/token/nonce 并设超时上限），或运行内置自检产出符合 `verify-pr-check` 契约的 `report.md`、`verdict.txt`、`assertions.json`、`comment.md` 与 `logs/guest-runtime.json`。
  7. 在 `finally` 中始终停止 `model-bridge`，随后通过端口 52 上传产物（测试用 `--unix-collector`）。
- 解析 `/proc/cmdline` 的 `qwen.*` 参数，对 `cid`、端口与 `workload_timeout` 拒绝非正整数。

### 3.3 离线只读 Golden ext4 镜像派生（`scripts/verify-pr-vm-image.mjs`）

- 通过 `debugfs -R "rdump / <tree>"` 只读解包 golden ext4 镜像，再以 `mkfs.ext4 -F -b 4096 -U random -d <tree>` 重建独立 ext4 输出镜像（零 loop 挂载，绝不以写模式打开 golden 源镜像）。
- 复用 `scripts/verify-pr-vm-host.mjs` 的 `normalizeApprovedRoots`、`canonicalizeVaultDir` 与 `canonicalizePreservingLeaf`，强制校验 `approvedRoots`、`vaultDir` 排除、单链接非 symlink 源、可选 `expectedBaseSha256` 锁定、禁止覆写输出，以及镜像内目标路径规范化（`normalizeImageTargetPath`）。
- 写入每个注入文件前核验 `realpathSync(dirname(dest))` 严格位于提取树内，防止恶意基础镜像内嵌符号链接 `/opt/qwen` 逃逸写到宿主机目录。
- 提升完成后复核 `baseImagePath` SHA-256 与构建前一致，并在 `finally` 中清理临时提取树和未提升临时镜像。
- 提供可选 `--bundle-host-python`，将宿主 Python 3 及经 `ldd` 解析的共享库打包至 `/opt/python` 以支持极简 BusyBox golden 镜像。

### 3.4 PR #18552 非阻断 Follow-Up（`scripts/verify-pr-vm-host.mjs`）

- `ensureApprovedDirHierarchy` 接受目录本身等于某个规范化 `approvedRoot`（例如 `copyIsolatedAsset(src, join(root, 'kernel'), { approvedRoots: [root] })`），同时对文件目标继续维持严格子路径约束。
- 将 `createdDirs.push(nextDir)` 移至 `mkdirSync(nextDir, { mode })` 之后、`chmodSync(nextDir, mode)` 之前，保证 `chmodSync` 异常时新建目录仍被回滚清理。

## 4. 验收标准

1. `verify-pr-vm-guest-init.sh` 通过 `sh -n` 与 `shellcheck -s sh` 且零警告。
2. `verify-pr-vm-guest-runner.py` 经真实 3 端口 Unix socket 通过 `runHardwareRound` 完成 7 步闭环（input 53 + model proxy 54 + collector 52 + `verify-pr-check` 退出 0），精确写入 32 字节熵，从 workload 环境中剥离宿主秘密，将非回环 NIC / `virtiofs` 挂载标记为 `needs-changes`，在 workload 启动前拦截错误 `/__health` nonce，拒绝非法 `qwen.*` 整数，并在显式 `--skip-materialize` 下校验 Git v2/v3 bundle 头部。
3. `deriveExt4GuestImage` 及其 `derive` CLI 强制校验 `expectedBaseSha256`、`approvedRoots`、`vaultDir`（含符号链接金库）、单链接非 symlink 输入、禁止覆写、镜像内路径穿越拒绝、提取树符号链接逃逸拦截、`mkfs` 失败临时文件清理以及事后 golden SHA 一致性。
4. 在真实 Linux aarch64 KVM 上，100% 仓内脚本全链路（`verify-pr-vm-image.mjs derive` → `runHardwareRound({ stageAssets: true, runChecker: true })` → PID-1 `verify-pr-vm-guest-init.sh` → `verify-pr-vm-guest-runner.py`）以 `ok: true`、`checkExitCode: 0`、`boundary.json (mode: "microvm")`、`guestEntropyWritten: true`、`noNic: true`、`hasDirectoryShare: false`、`modelProbeStatus: 200`、零残留 `jailRoot` 与 golden kernel/rootfs 哈希不变完成。
5. `copyIsolatedAsset(src, join(root, 'kernel'), { approvedRoots: [root] })` 通过，而 `copyIsolatedAsset(src, root, { approvedRoots: [root] })` 仍被拒绝。

## 5. 实测证据与边界

基于最终精确字节测量（`verify-pr-vm-host.mjs` `672f642e…`、`verify-pr-vm-image.mjs` `097f1340…`、`verify-pr-vm-guest-init.sh` `0a97cd63…`、`verify-pr-vm-guest-runner.py` `212f9f86…`）：

| 环境                                                 | 实测结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64、Node 24.18.1                            | 6 套聚焦单测（`verify-pr-vm-{guest-runner,image,host,runner,channel}` + `verify-pr-credential-scan`）：**81 项通过，1 项 root 门控跳过，0 失败**。`python3 -m py_compile`、`sh -n`、`shellcheck -s sh`（0 警告）、Prettier、ESLint 与仓库完整 `npm run lint` 全部通过。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Linux aarch64、Node 22.23.5（`qa-guest-init-image`） | 全部 14 份 `scripts/tests/verify-pr*.test.js`：**555 项通过，9 项环境跳过**。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 100% 零仓外 PoC 真实 Firecracker/KVM 端到端          | 通过 `verify-pr-vm-image.mjs derive --bundle-host-python`（真实 `debugfs` + `mkfs.ext4`）派生镜像 `c1ef5982…`，再经 `runHardwareRound({ stageAssets: true, runChecker: true })` 启动 PID-1 `verify-pr-vm-guest-init.sh` + `verify-pr-vm-guest-runner.py`（针对无 `git` 的极简 BusyBox golden rootfs 传 `qwen.skip_materialize=1`）：`ok: true`、`checkExitCode: 0`、`outputStatus: "complete"`、`teardownStatus: "destroyed"`、`boundaryMode: "microvm"`、`guestEntropyWritten: true`、`interfaces: ["lo"]`、`noNic: true`、`hasDirectoryShare: false`、`headerVerified: true`、`guestModelProbeStatus: 200`、`upstreamAuthOk: true`、`jailRootCleaned: true`、`execDirCleaned: true`。只读 golden kernel（`aee80c3a…`）与 rootfs（`1ba7902e…`）复核未变。 |

**明确未覆盖边界：**带 `git` 的 guest rootfs 真实 Firecracker/KVM 启动尚未运行（完整 `git bundle unbundle` + `git checkout` 物化与剥离凭据自定义 workload 已在 `verify-pr-vm-guest-runner.test.js` 中经真实 3 端口 Unix socket 端到端验证，而 KVM 主机上的极简 BusyBox golden rootfs 未安装 `git` 故使用了 `qwen.skip_materialize=1`）；不覆盖真实 macOS `vfkit` VM 启动、云端 `provider-vm` / Agent Sandbox 分配、外部模型端点、Windows IPC，也不替代远端 GitHub CI 与维护者审批。
