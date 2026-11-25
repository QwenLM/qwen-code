# `/review` 分层沙箱执行代码方案设计

[English](2026-11-24-review-tiered-sandbox.md) | [简体中文](2026-11-24-review-tiered-sandbox.zh-CN.md)

**状态：** Phase 1 与 Phase 2-B 已实现（信任分类与高风险强制升级、轻量容器硬化与可验证回收、分层 fail-closed 后端选路与启动计划器、`guest-exec-v1` UDS/vsock 本地微虚机实时执行桥接含纯内容打包与身份核验 VMM 回收、旁路子命令门禁、结构化边界披露）；CI workflow 切换（Phase 2-A）与云端 `provider-vm` HTTP/SDK 数据面作为后续阶段。
**日期：** 2026-11-24
**关联文档：** [`/verify-pr` 分信任等级 microVM 隔离设计](2026-11-23-verify-pr-tiered-microvm.zh-CN.md)、[Review CPU for Tokens](review-cpu-for-tokens.md)

## 1. 问题陈述

`/review` 会在多个机械验证子命令中执行被评审仓库的代码（`build-test`、`test-efficacy`、`test-delta`、`base-tree`，以及交互/脚本运行时探针 `drive`、`ab-drive`、`capture-tui`）。虽然 `packages/cli/src/commands/review/lib/sandboxed-exec.ts` 已为 `build-test`、`test-efficacy` 和 `test-delta` 引入了单层容器隔离（`off | auto | required`），但对照 `/verify-pr` 最近落地的分层微虚机沙箱优化（#18181），仍存在四个结构性缺口：

1. **缺少信任分级与高风险路径强制升级。** 对所有 PR 一视同仁，未区分作者信任级别（`local-owner`、`collaborator`、`external`、`unknown`）、是否来自 fork（`isCrossRepository`）或是否触及高风险路径（`package.json`、lockfile、`patches/`、`.github/workflows/`、`.qwen/`、可执行文件、符号链接、子模块）。
2. **仅支持单一共享内核容器且未做安全硬化与可验证回收。** `containerCommand()` 未启用 `--cap-drop=ALL`、`--security-opt=no-new-privileges:true` 与 `--pids-limit`；`killContainer()` 仅为 best-effort `rm -f`，不核验容器是否真正退出；缺乏面向硬件隔离后端（`firecracker`、`vfkit`、`provider-vm` / 阿里云 `fcsandbox`）的 fail-closed 适配层。
3. **存在宿主机直接执行旁路。** `drive`、`ab-drive` 与 `capture-tui` 直接在宿主机拉起 `tmux` 与 `bash -lc` 执行脚本，从未调用 `refuseUnsandboxedPhase()` 或读取 `review.sandbox`，即便策略为 `required` 或 `tiered` 仍会绕过沙箱边界。
4. **缺少结构化的执行边界披露。** `BuildTestReport`、`TestEfficacyReport`、`TestDeltaReport`、`DriveReport`、`AbDriveReport` 均未记录包含 `policy`、`prTrust`、`executionClass`、`backend`、`escalationReasons` 与 `teardownStatus` 的结构化 `executionBoundary` 字段。

## 2. 目标与非目标

### 目标

- 将 `/review` 对齐到 `/verify-pr`（#18181）确立的核心安全不变量：**不可信/高风险变更优先硬件隔离（microVM-first），受信低风险变更使用硬化共享内核容器，全链路 fail-closed，严禁静默降级到宿主机直接执行**。
- 100% 向后兼容现有 `review.sandbox` 三档（`off`、`auto`、`required`），新增 `tiered` 分档模式与操作者作用域开关（`QWEN_REVIEW_SANDBOX_BACKEND`、`QWEN_REVIEW_FORCE_HARDWARE`）。
- 硬化轻量容器档（最小权限 capability、禁止提权、PID 上限）并把超时回收升级为可核验状态的 `reapContainer()` / `killContainer()`。
- 建立统一的 fail-closed 后端选路与启动计划器接口，覆盖 `container`、`firecracker`（Linux KVM）、`vfkit`（macOS Apple Silicon + Seatbelt）与 `provider-vm`（阿里云 `fcsandbox` 自定义无公网/VPC 模板或一次性 ECS）。
- 为 `drive`、`ab-drive`、`capture-tui` 接入同一套 fail-closed 沙箱门禁，在 `required`、`tiered` 或 `QWEN_REVIEW_FORCE_HARDWARE=1` 下绝不静默在宿主机跑待审脚本。
- 在各执行子命令报告中附带结构化 `executionBoundary`，并在 `fetch-pr` 中以零额外 GitHub API 调用补齐 `authorAssociation` 与 `isCrossRepository` 供下游信任分类使用。

### 非目标（Phase 1 / 2-B）

- 不把整个 `/review` 编排器 LLM Agent 塞进 microVM（遵循 `/verify-pr` 设计 §3.5：保留现有 `working_dir`、fan-out、覆盖台账与 `--fix` 宿主机写入目标，仅隔离待审代码的执行适配器）。
- 本次不修改 `.github/workflows/qwen-code-pr-review.yml`，也不配置生产云端 VM 凭据（留待 Phase 2-A）。
- 本次不在 `packages/cli` 中内置云端 `provider-vm`（`fcsandbox` / `aliyun-ecs`）的 HTTP/SDK 数据面；本地微虚机后端（`firecracker`、`vfkit`）在硬件前提与 `QWEN_REVIEW_VM_BRIDGE_SOCKET` 就绪时已可通过 `guest-exec-v1` UDS/vsock 实时执行，其余情况继续严格 fail-closed 拒绝，绝不静默降级。

## 3. 架构与设计决策

### 3.1 策略档位与操作者作用域优先级

`review.sandbox` / `QWEN_REVIEW_SANDBOX` 支持四档有序策略：

| 策略       | 严格度序位 | 语义                                                                                                                                                                                                                                                                                        |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`      | 0          | 直接在宿主机执行被评审代码（默认值，完全向后兼容）。若操作者环境设置了 `QWEN_REVIEW_FORCE_HARDWARE=1`，仍强制升级接管。                                                                                                                                                                     |
| `auto`     | 1          | Docker 或 Podman 可用时走硬化容器；不可用时退回宿主机直接执行并显式披露。                                                                                                                                                                                                                   |
| `required` | 2          | 绝不无沙箱运行待审代码；要求可挂载的容器（或更强隔离）。不可用时 fail-closed 拒绝。                                                                                                                                                                                                         |
| `tiered`   | 3          | 基于 PR 信任级别与变更文件自动分档为 `trusted-shared-kernel` 或 `hardware-isolated`。受信低风险档允许使用硬化容器（禁止降级宿主机）；`hardware-isolated` 档必须使用硬件隔离后端（`firecracker`、`vfkit` 或 `provider-vm`），不可用时 fail-closed 拒绝，绝不静默降级为共享内核容器或宿主机。 |

**防仓库篡改规则：**

- `review.sandbox` 仅通过 `operatorReviewSettings()` 从 User / System / SystemDefaults 读取，忽略仓库 `.qwen/settings.json`。
- `QWEN_REVIEW_SANDBOX`、`QWEN_REVIEW_SANDBOX_BACKEND`、`QWEN_REVIEW_FORCE_HARDWARE` 与 `QWEN_REVIEW_SANDBOX_IMAGE` 全部加入 `packages/cli/src/config/shared-env-keys.ts` 的 `PROJECT_ENV_HARDCODED_EXCLUSIONS`，并在读取点额外校验 `isFileSourcedEnvKey()`，仓库 `.env` / `.qwen/.env` 无法注入或放宽边界。
- 操作者环境变量与操作者配置同时存在时，`sandboxPolicy()` 始终取更严格的一侧（`off < auto < required < tiered`）。

### 3.2 信任分类与高风险强制升级（`lib/sandbox-trust.ts`）

规则与 `scripts/verify-pr-prepare.mjs` 保持同构，输入直接适配 `/review` 的 `PlanReport`（`fetch-pr` / `capture-local` 产物）：

- **`prTrust`**：
  - `local-owner`：本地 diff / 文件评审（`isLocal: true`，无 PR 目标）。
  - `collaborator`：同仓 PR（`isCrossRepository: false`）且 `authorAssociation` 属于 `OWNER`、`MEMBER` 或 `COLLABORATOR`。
  - `external`：fork PR（`isCrossRepository: true`）或非协作者关联（`CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`FIRST_TIMER`、`NONE`、`MANNEQUIN`）。
  - `unknown`：PR 评审缺少 `isCrossRepository` 或 `authorAssociation`，或值无法识别。
- **`executionClass`**：
  - `trusted-shared-kernel`：仅当 `prTrust` 为 `local-owner` 或 `collaborator`、`forceHardware` 为 false、PR 变更文件列表完整（非增量收窄或已降级回全量、`files.length === diffStat.files`、且 diff 捕获未崩溃/缺失）且零条强制升级规则命中时成立。
  - `hardware-isolated`：其余所有情况（`external`、`unknown`、`forceHardware`、PR 缺少或存在增量/不完整变更文件列表、畸形 plan JSON 或命中任意强制升级规则）。
- **强制升级触发器（`detectReviewMandatoryEscalations`）**：
  - 供应链与依赖清单：`package.json`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`bun.lock*`、`.npmrc`、`.yarnrc*`、`.pnpmfile.mjs`、`patches/**`、`pom.xml`、`.mvn/**`、`mvnw*`、`Cargo.toml`、`Cargo.lock`、`go.mod`、`go.sum`、`pyproject.toml`、`requirements*.txt`、`setup.py`、`Gemfile*`、`build.gradle*`、`settings.gradle*`、`gradlew*`。
  - CI / hooks / agent / git / review 配置：`.github/workflows/**`、`.github/actions/**`、`.husky/**`、`.qwen/**`、`.claude/**`、`.gitmodules`、`.gitattributes`。
  - 构建 / 沙箱 / 验证 / JS 执行型工具链配置：`**/scripts/**`、`build.{js,mjs,cjs,ts}`、`Dockerfile*`、`docker-compose*`、`(GNU)Makefile`、`*.mk`、`justfile`、`Taskfile.ya?ml`、`turbo.json`、`esbuild/vite/vitest/babel/webpack/rollup/jest/playwright/postcss/tailwind/next/prettier/eslint.config.*`、`tsconfig*.json`、`.eslintrc*`、`.prettierrc.{js,cjs,mjs}`。
  - 可执行文件、符号链接、子模块、二进制或路径遍历：git mode `100755`、`120000`、`160000`（从 unified diff 头部的 `new/deleted file mode`、`new/old mode` 与 `index <old>..<new> <mode>` 解析进入 `FileMetric.mode` 并由 `trustInputFromPlan` 透传）、`binary: true`、`..` 路径遍历段，或可执行脚本/二进制扩展名（`.sh`、`.bash`、`.zsh`、`.py`、`.rb`、`.pl`、`.ps1`、`.bat`、`.cmd`、`.exe`、`.dll`、`.so`、`.dylib`）。
  - 同时对 `file.path` 与 `file.renameFrom` 做路径归一化与检测，防止通过重命名或冗余斜杠绕过升级。

### 3.3 轻量容器档硬化（`lib/sandboxed-exec.ts`）

每次 `containerCommand()` 调用均强制附加以下硬化选项：

- `--cap-drop=ALL`：移除全部默认 Linux capability。
- `--security-opt=no-new-privileges:true`：阻断容器内通过 setuid/setgid 提权。
- `--pids-limit=512`：限制进程/线程数以防 fork bomb，同时兼容 Vitest / esbuild 合法并发 worker。
- 保留网络分权：`install` 允许联网，`build` 与 `test` 强制 `--network none`。
- 可验证回收（`reapContainer()` / `killContainer()`）：先执行 `<runtime> rm -f <name>`，再通过 `<runtime> inspect --format '{{.State.Running}}' <name>`（同时捕获 stderr）核验容器确已不存在（`No such container/object`）或已停止（`false`），返回 `'clean'` 或 `'failed'`（`ReviewTeardownStatus`），防止 daemon 断连或仍在运行的容器被误报为清理成功。

### 3.4 分层后端适配器与 fail-closed 选路（`lib/sandbox-backends.ts`）

定义与 `scripts/verify-pr-vm-runner.mjs` 对齐的后端抽象边界：

- 支持的硬件隔离后端：
  - `firecracker`（Linux KVM `/dev/kvm` + `firecracker` + `jailer` + 操作者配置的可读普通文件 kernel/rootfs 资产）。
  - `vfkit`（macOS Apple Silicon `arm64` + `vfkit` + 强制模式 Seatbelt `sandbox-exec` + 操作者配置的可读普通文件 kernel/rootfs 资产）。
  - `provider-vm`（阿里云 `fcsandbox` 显式自定义无公网/VPC 隔离模板——拒绝 `default`、`base`、`python`、`code-interpreter` 与含空白模板名——或一次性 `aliyun-ecs`，且要求合法 `https://` 端点 URL）。
- `hardware-isolated` 选路顺序：
  1. 若 `QWEN_REVIEW_SANDBOX_BACKEND` 显式指定硬件后端（`firecracker`、`vfkit`、`provider-vm`），仅校验该后端（不可用或为 `hardware-isolated` 指定了 `container` 均 fail-closed 拒绝）。
  2. 否则按宿主原生优先级探测：`firecracker`（Linux）→ `vfkit`（macOS arm64）→ `provider-vm`（云端兜底）。
- 每个硬件后端提供纯函数启动计划构造器（`buildReviewBackendPlan`），用于前置校验依赖而不直接执行不可信代码。
- **本地 microVM `guest-exec-v1` 实时桥接（`lib/guest-exec-bridge.ts`，Phase 2-B）：**
  - 当本地微虚机后端（`firecracker` 或 `vfkit`）满足全部宿主前提**且**操作者通过 `QWEN_REVIEW_VM_BRIDGE_SOCKET` 提供合法的非符号链接 Unix Domain Socket（经操作系统 `sun_path` 字节上限与 `lstatSync().isSocket()` 核验，且通过 `PROJECT_ENV_HARDCODED_EXCLUSIONS` 阻断仓库 `.env` 注入）时，`selectReviewSandboxBackend()` 返回 `kind: 'hardware-bridge'`，`sandboxVerdict()` 返回 `kind: 'microvm'`。
  - **零宿主 RW 挂载（对齐 D5）与会话连续性：** `packWorkspaceFiles()` 按纯内容上传普通文件（`F`/`D`/`V` 帧），通过 `realpathSync` 核验子目录严格位于工作区根目录内并用 `O_NOFOLLOW` 打开文件，强制文件数、单文件与总字节预算上限，拒绝 symlink、FIFO、socket、设备节点与路径遍历。多命令阶段（`build-test` 的 `install` → `build` → `test`、`test-delta` 的 lockfile 安装 → baseline 测试重跑，以及 `test-efficacy` 变异探针）传递经校验的 `workspaceSessionId` 与 `workspaceMode`（`replace` / `sync` / `overlay` / `reuse`），使 guest 内安装的 `node_modules` 与编译产物在同一次 guest 会话中连续复用而不触碰宿主工作树，并通过 guest 侧真实完整性标记探测（`test -f node_modules/<marker>`）核验安装完成（绝不查宿主目录），阶段结束时通过显式 `C` 帧清理。`closeGuestSessionSync()` 仅在收到完整、会话绑定的 ACK 时才承认清理完成，ACK 必须匹配 `runId`、`workspaceSessionId`、`sessionSha256` 和进程退出状态；仅有 exit 0、缺失/截断 ACK 或错误发送者一律记为 `'partial'`，绝不谎报为已清理。由于该 ACK 形状比最初的「裸 session id」契约更严格，清理握手使用独立协议令牌 `guest-exec-close-v2`（命令执行仍为 `guest-exec-v1`）：仍说旧契约的 peer 会在握手处失败，返回的 `reason` 明确点名协议版本偏差，并由 `executionBoundary.note` 透出，而不是给出无法解释的 `partial`。安装失败会记录 `installError`，后续探针返回 `not-run`，不会跳过或重复安装。三个阶段（含 `test-efficacy`）都会在安装退出 0 后探测 guest 侧完整性标记，因此「退出 0 但没有生成 `node_modules`」会被判为 `not-run`，而不是浪费 N 次探针后报 `no-output`。
  - **二进制帧协议与防截断：** 采用 `1B ASCII kind + 4B uint32 BE length + payload`（`H`/`A` 握手、`X` 命令请求并仅注入白名单 `guestCommandEnv()`、`C` 会话关闭、`O`/`E` 受限输出分片、`Z` 结束帧并由宿主独立重算 stdout/stderr SHA-256 比对、`R` 拒绝帧）。缺失 `Z` 帧、EOF 残留半帧、超帧长/总字节上限、非法 exitCode+signal 组合或摘要不匹配一律以 `EPROTO` fail-closed，绝不伪装成 exit 0。
  - **同步适配与身份核验回收：** `executeViaGuestBridgeSync()` 通过极简原始字节泵子进程配合 `spawnSync` 硬超时为同步调用方（`build-test`、`test-efficacy`、`test-delta`）提供微虚机执行，所有协议语义与摘要校验留在父进程单一实现。超时或协议异常时，若配置了 `QWEN_REVIEW_VM_PID_FILE`，`reapVmWorker()` 先拒绝 symlink PID 文件及宿主自身 PID，并严格仅核验可执行名（`comm`、`argv[0]`、Linux `/proc/<pid>/exe`，忽略二进制替换后的 `(deleted)` 后缀，绝不匹配任意 `argv[1..]` 参数子串），再依次 `SIGTERM` → `SIGKILL` → 确认进程退出，返回可审计的 `teardownStatus`（`'clean' | 'partial' | 'failed'`）。
  - **Fail-closed 兜底：** 若硬件前提缺失、`QWEN_REVIEW_VM_BRIDGE_SOCKET` 未配置或非法，或选定 `provider-vm` 尚无数据面连接，`sandboxVerdict()` / `refuseUnsandboxedPhase()` 仍严格 fail-closed 拒绝，绝不降级为共享内核容器或宿主机。

### 3.5 执行面覆盖与旁路封堵

| 子命令          | 执行待审代码方式               | 策略门禁行为                                                                                                                                                                                                             |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build-test`    | `npm ci`、build、test          | 调用 `refuseUnsandboxedPhase(root, ..., trustContext)`；在 `BuildTestReport` 中记录 `executionBoundary` 与 `teardownStatus`。                                                                                            |
| `test-efficacy` | mutation 与 revert Vitest 探针 | 调用 `refuseUnsandboxedPhase(probeWorktree, ..., trustContext)`；在 `TestEfficacyReport` 中记录 `executionBoundary` 与 `teardownStatus`。                                                                                |
| `test-delta`    | 基线侧失败测试重跑             | 调用 `refuseUnsandboxedPhase(baseline, ..., trustContext)`；在 `TestDeltaReport` 中记录 `executionBoundary`。`tiered` 下必须传入 `--plan`；缺失时信任上下文未知，基线重跑会 fail-closed 拒绝并在 note 中给出可操作提示。 |
| `base-tree`     | 委托 `build-test` 构建         | 自动继承 `build-test` 的门禁与拒绝语义。                                                                                                                                                                                 |
| `drive`         | 宿主机 `tmux` + `bash -lc`     | 调用 `refuseHostExecutionPhase()`；在 `required`、`tiered` 或 `QWEN_REVIEW_FORCE_HARDWARE=1` 下不启动 `tmux`，直接返回 `outcome: 'unavailable', observed: false` 及 `executionBoundary`。                                |
| `ab-drive`      | 双臂宿主机 `tmux` + `bash -lc` | 调用 `refuseHostExecutionPhase()`；在 `required`、`tiered` 或 `QWEN_REVIEW_FORCE_HARDWARE=1` 下不启动 `tmux`，直接返回 `observed: false` 及 `executionBoundary`。                                                        |
| `capture-tui`   | 宿主机 `tmux` + TUI 截屏       | 调用 `refuseHostExecutionPhase()`；在 `required`、`tiered` 或 `QWEN_REVIEW_FORCE_HARDWARE=1` 下在启动 `tmux` 与写 `--out` 前直接 `refuse(...)`（exit 3）。                                                               |

### 3.6 零额外 API 信任透传（`fetch-pr.ts` & `lib/platform/github.ts`）

`githubReader.getFetchMeta()` 本身已调用 `gh pr view --json ...`。只需在字段列表中追加 `authorAssociation`，即可将其填入 `FetchMeta.authorAssociation` 并随 `isCrossRepository` 和 `files` 一同落盘到 `fetch-pr` 的 plan JSON。下游 `build-test`、`test-efficacy`、`test-delta` 在有 `--plan` 时直接推导 `ReviewTrustInput`（缺少 PR 元数据时在 `tiered` 下按 `unknown` fail-closed 处理）。

**执行前读取信任上下文。** plan 位于容器可读写的评审临时目录内，被审代码在一次受信运行期间可以改写它。因此每个阶段都只在执行第一条命令前读取一次 `ReviewTrustInput`，报告使用这份已捕获的值；`build-test` 不再在构建结束后重读 plan 来生成 `executionBoundary`。这不影响门禁不变量：`hardware-isolated` 的 plan 在任何被审代码执行前就被拒绝，因而其代码没有机会改写 plan；受信运行的后续阶段可能看到被改写的 plan，但这个 PR 本来就已经被允许执行，且被改写的 plan 无法让 `hardware-isolated` 运行获得执行许可。完全没有信任上下文的执行会如实标记为 `executionClass: 'unclassified'`，而不是误标为 `hardware-isolated`。

## 4. 风险与缓解

| 风险                                                                                                     | 缓解措施                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 破坏现有本地或 CI 的 `off`/`auto`/`required` 用法                                                        | `off`/`auto`/`required` 保持既有默认行为不变；`tiered` 与 `QWEN_REVIEW_FORCE_HARDWARE` 为显式 opt-in。                                                  |
| `--pids-limit` 误杀合法并行构建/测试                                                                     | 默认设为 `512`，远高于常规 Node/Vitest/esbuild 并发需求，同时阻断 fork bomb。                                                                           |
| 恶意 PR 通过 `.qwen/.env` 篡改 `QWEN_REVIEW_SANDBOX_BACKEND=container` 或 `QWEN_REVIEW_FORCE_HARDWARE=0` | 所有 review 沙箱环境变量全部加入 `PROJECT_ENV_HARDCODED_EXCLUSIONS` 并做 `isFileSourcedEnvKey()` 校验。                                                 |
| 宿主机设置了 `review.sandbox` 影响 `drive`/`ab-drive`/`capture-tui` 单测                                 | 既有单测在默认 `off` 或隔离操作者配置下运行；新增单测显式覆盖 `off`/`auto` 放行与 `required`/`tiered`/`QWEN_REVIEW_FORCE_HARDWARE=1` fail-closed 拒绝。 |

## 5. 验证计划与验收标准

1. **单元测试**：
   - `sandbox-trust.test.ts`：覆盖 `local-owner` / `collaborator` / `external` / `unknown`、全部强制升级触发规则（依赖、lockfile、patches、workflows、`.qwen`、脚本、可执行权限、symlink、submodule、重命名）、缺少文件列表的 fail-closed 行为以及 `QWEN_REVIEW_FORCE_HARDWARE=1`。
   - `sandbox-backends.test.ts`：覆盖各平台后端选路顺序、`QWEN_REVIEW_SANDBOX_BACKEND` 显式覆盖、`hardware-isolated` 拒绝 `container`、前提缺失时 fail-closed 以及 `firecracker`/`vfkit`/`provider-vm`（`fcsandbox`/`aliyun-ecs`）启动计划校验。
   - `sandboxed-exec.test.ts`：覆盖 `tiered` 策略严格度优先级、仓库 `.env` 对新增变量的拦截、容器硬化参数（`--cap-drop=ALL`、`--security-opt=no-new-privileges:true`、`--pids-limit=512`）、`reapContainer()` 干净/失败校验以及 `refuseHostExecutionPhase()`。
   - `build-test` / `test-efficacy` / `test-delta` / `drive` / `ab-drive` / `capture-tui` 单测：验证 `executionBoundary` 字段、基于 plan 的信任分档执行与旁路子命令的 fail-closed 拒绝。
   - `guest-exec-bridge.test.ts`：覆盖 `guest-exec-v1` 帧编解码、UDS 路径上限与 symlink socket 拒绝、纯内容工作区打包（拒绝 symlink、非普通文件与超预算）、截断/伪造摘要拦截、按身份核验的 `reapVmWorker()`（拒绝不匹配 PID、强杀抗 `SIGTERM` 存活目标并保留无辜 canary 进程），以及真实 Unix Domain Socket 独立子进程 guest-agent 在 `tiered` + 外部 fork PR 下驱动 `runBuildTest` 与 `runTestDelta` 的端到端闭环。
2. **构建与静态检查**：`npm run build && npm run typecheck` 及 `packages/cli` 中所有受影响单测全部通过。

## 6. 后续工作

- 更新 `.github/workflows/qwen-code-pr-review.yml`（及 workflow meta-tests），移除外部 PR 在容器/VM 不可用时回退到 `policy=off` 的降级逻辑，将 CI 切换为 `QWEN_REVIEW_SANDBOX=tiered`（Phase 2-A）。
- 接入云端 `provider-vm`（`fcsandbox` / `aliyun-ecs`）的 HTTP/SDK 数据面，以及可选的微虚机化 `drive` 执行。
