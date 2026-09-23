# Workspace 注册容量基线：1 / 25 / 256

关联 [#11386](https://github.com/QwenLM/qwen-code/issues/11386)。2026-09-08 在 `1a73f5bff6201473f237c5106367e944ba2d092b` 上完成；这是现有急切构建路径的容量实验，没有实现 LRU，也没有修改生产源码。可核对的逐轮摘要见 [JSON 数据](workspace-capacity-baseline-2026-09-08.json)，结果已同步至 [issue 实测记录](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5586177947)。

## 结论与对方案的调整

本机空 workspace 的成本不足以支持“必须先实现完整 LRU 才能扩容”的判断。启动注册从 25 增加到 256，daemon 的 GC 后堆中位数增加 **20.6 MiB**，RSS 中位数增加 **25.2 MiB**；256 个 workspace 完整就绪约 **1.38 秒**。固定一个已初始化 ACP child 时，该 child 自身 RSS 约 **192 MiB**，不是每条空注册记录都付出这个成本。

注册也不是纯元数据：256 个启动 workspace 有 256 个 cron 监听资源，查询每个 Git 仓库后共 512 个监听资源、277 个 FD。默认总 session 上限还会随启动数量从 800 放大到 8192。这些是扩容 PR 必须处理或在目标部署验证的独立事项。

建议先交付保持默认 25 的常量解耦，再单独处理注册扩容的兼容性。懒加载/LRU 暂作为后续独立优化，不作为当前扩容的硬前置；若目标主机的监听器预算、真实 workspace 初始化成本或启动延迟成为约束，再按 [生命周期设计](workspace-lru-eviction.md) 实施。真实 child 内存准入仍属于 #8182，本报告没有为 enforcement 提供工作负载校准。

## 环境与方法

- macOS 26.6.2 arm64，Apple M4 Pro，12 个逻辑 CPU，48 GiB 内存；Node v22.22.3，npm 10.9.8。
- 从上述 commit 执行 `npm run build`、`npm run bundle`。本地依赖最初缺少仓库已有 Ink 补丁；执行 `npm run postinstall` 后重新构建成功，未修改源码或锁文件。
- 复制整个 `dist` 为独立实验产物，只把编译后的 `MAX_REGISTERED_WORKSPACES = MAX_DAEMON_WORKSPACES` 改为 `MAX_REGISTERED_WORKSPACES = 256`。逐文件比较确认唯一差异是这一行；共享 `MAX_DAEMON_WORKSPACES = 25` 不变，所以 child model 和既有 channel timeout 常量没有随实验改大。原/实验 chunk SHA-256 分别为 `0298fc2d87007bb73ed663b3a10a698092362afa7f222f5fa0c046c7a4c9a229` / `3318c999515cacc7a004a1557cd3e6a8fa7db415d754444c46c0265660cace11`。
- 每轮新建互不嵌套的临时 workspace，隔离 QWEN_HOME、QWEN_RUNTIME_DIR、系统 settings、trust、缓存及测试 `os.homedir()`。只保留白名单环境变量。绑定 loopback，使用临时 bearer token，`--no-open --no-web`，没有浏览器客户端。
- 使用现有 `VITEST_WORKER_ID` 开关关闭 primary 默认 ACP 预热，得到受控的零 child 基线；这不是默认启动行为。测试 preload 在所有场景隔离 home；仅资源诊断、churn 和边界场景（含 Git 变体）启用 `async_hooks` 计数。
- “完整就绪”从 OS spawn 计时，到 `/health` 成功且完整 `/daemon/status` 报告全部注册 runtime；另核对实际 ACP mounts、trusted 数及 status issues。当前 bootstrap 状态不包含该 runtime 计数，且 registry 在启动 runtime 构建完成后创建。该判断不应直接推广为未来 dormant 模型的 readiness。轮询间隔 100 ms，未清空 OS 文件缓存。
- 主内存矩阵顺序为 `1/25/256`、`256/1/25`、`25/256/1`，每档三轮。就绪后稳定 10 秒，再每 5 秒采样，共 5 次、20 秒窗口。表中 RSS/自然堆先取轮内中位数，再取三轮中位数；GC 后堆在自然采样后强制 GC 单独读取。
- 内存/CPU 使用 loopback Node inspector 读取 `process.memoryUsage()` / `process.cpuUsage()`；所有对照同样带 inspector。CPU 为单逻辑核占比，100% 表示占满一个核。额外 idle 场景每档单轮，稳定 10 秒后连续采 80 秒，涵盖 60 秒 reaper/sweep 和 PR 首次扫描，但未覆盖默认 10 分钟 cron keepalive 周期。CPU 窗口内不强制 GC。
- 文件监听和 timer 用独立诊断轮的 Node `FSEVENTWRAP` / `Timeout` 活资源数，包含 unref 资源；FD 用 `lsof` 数字 descriptor 数。诊断轮开启 hooks 后的 RSS 不混入主内存表。资源计数只覆盖 daemon；child RSS 另用 OS 进程树读取，不代表 child 的 watcher 已被统计。
- 所有性能场景串行，期间没有并行构建或其他本任务压力测试；这是普通开发机，不是独占性能实验室。

## 零 child 的启动注册成本

以下均为启动时传入 N 个 `--workspace`，不是启动后动态添加。所有快照 session=0、active ACP child=0、OS 后代进程=0，完整 ACP mounts=N，status=ok 且 issues 为空。

| 启动 workspace 数 | 完整就绪中位数（范围） | daemon RSS | 自然 heapUsed | GC 后 heapUsed | 80 秒空闲 CPU | FD  |
| ----------------- | ---------------------- | ---------- | ------------- | -------------- | ------------- | --- |
| 1                 | 1.115 s（1.000–1.159） | 178.7 MiB  | 89.2 MiB      | 88.28 MiB      | 0.67%         | 21  |
| 25                | 1.054 s（0.754–1.144） | 188.9 MiB  | 99.1 MiB      | 98.29 MiB      | 0.87%         | 21  |
| 256               | 1.380 s（1.349–1.431） | 214.1 MiB  | 119.7 MiB     | 118.92 MiB     | 1.12%         | 21  |

25→256 的 GC 后堆增量摊到新增 workspace 约 91 KiB；这是本 fixture 的区间差值，不是适用于任何项目的固定成本。1→25 含多 workspace 路径的额外成本，三个点不能按统一线性函数外推。RSS 会随 V8 和 OS 回收变化；自然采样中的个别值明显低于轮内中位数，完整范围保存在 JSON。CPU 每档只有一次 80 秒窗口，不应把微小差值当作统计显著的性能回归。

未修改的原始 cap=25 bundle 另测 1/25，各一轮，GC 后堆为 88.19 / 98.19 MiB，与实验产物对应档接近。此对照用于确认实验放宽常量没有引入明显额外成本，不用于估计性能方差。

## 监听器和定时器

Git fixture 为每个目录执行隔离 Git 配置的 `git init` 和 empty commit，然后逐个请求 `GET /workspaces/{id}/git?wait=1`；没有工作文件、真实历史或文件修改事件风暴。

| 启动数 | 空目录 FSEVENTWRAP | 空目录 Timeout | 空目录 FD | Git 查询后 FSEVENTWRAP | Git 查询后 Timeout | Git 查询后 FD |
| ------ | ------------------ | -------------- | --------- | ---------------------- | ------------------ | ------------- |
| 1      | 1                  | 14             | 21        | 2                      | 14                 | 22            |
| 25     | 25                 | 85             | 21        | 50                     | 86                 | 46            |
| 256    | 256                | 779            | 21        | 512                    | 778                | 277           |

源码确认，当前每个受信任的启动 workspace 会带来三个常驻 interval：session reaper 60 秒、cron keepalive 默认 10 分钟、ACP HTTP connection sweep 60 秒。总 Timeout 还包含全局及暂态 timer，不能把整个计数归因于 workspace。cron keepalive 即使无任务也会创建目录 watcher；Git reflog watcher 在首次 Git 查询时懒创建。FD 数和 watcher 数不是同一指标，空目录 FD 不增长不代表没有监听开销。

相关代码： [session reaper](../../packages/acp-bridge/src/bridge.ts#L2730)、[keepalive interval](../../packages/cli/src/serve/scheduled-task-keepalive.ts#L430)、[cron watcher](../../packages/cli/src/serve/scheduled-task-keepalive.ts#L454)、[keepalive 默认周期](../../packages/cli/src/serve/server.ts#L738)、[ACP connection sweep](../../packages/cli/src/serve/acp-http/connection-registry.ts#L1495)、[启动 ACP mounts](../../packages/cli/src/serve/acp-http/index.ts#L1466)、[Git watcher](../../packages/core/src/utils/gitDirect.ts#L257)。

## 固定一个已初始化 ACP child

在每档独立 daemon 的零 child 观测之后，对 primary 调用 `POST /workspace/runtime/ensure`，再稳定和采样。使用仅指向 loopback 哨兵服务的 dummy provider 配置；全部场景哨兵服务收到的模型请求为 0。ensure 返回 runtimeLive=true，MCP/Skills ready；session 数仍为 0。

| 注册数 | ensure 延迟 | daemon GC 后堆 | 一个 ACP child 的 RSS |
| ------ | ----------- | -------------- | --------------------- |
| 1      | 1.169 s     | 88.9 MiB       | 193.5 MiB             |
| 25     | 1.186 s     | 98.9 MiB       | 190.9 MiB             |
| 256    | 1.128 s     | 119.8 MiB      | 192.2 MiB             |

每档一轮。这是 ACP 初始化延迟和空闲 child 的驻留成本，不是首个 prompt 延迟、正在执行的工作负载成本、7/25 个并发 child 成本或峰值 RSS。没有把 child RSS 与 daemon GC 后堆相加作为进程树 RSS。

## 动态注册边界和回收

全局 qwen 的有效 managed 版本 0.23.0 已独立复现：第 2–25 个动态注册均 HTTP 201，第 26 个 HTTP 409 `workspace_limit_reached`；此前及拒绝后均零 session、零 child，注册数仍为 25。全局入口的基础安装是 0.22.3，隔离 QWEN_HOME 会默认回退该版本，因此又经同一入口显式 pin 到已有 managed 0.23.0 重测；两个版本结果一致。不能将基础版本误写成当前有效版本。

实验产物从 primary=1 动态加到 256，255 次注册耗时合计约 1.245 秒，第 257 个 HTTP 409 `workspace_limit_reached`，拒绝后仍为 256。随后移除 255 个 secondary，回到 1；监听资源 256→1，Timeout 523→14，FD 保持 21，GC 后堆 111.46→89.93 MiB。该轮是诊断场景，没有用于主内存表。

动态注册后的 ACP mounts 实际只有 1；启动直接传入 256 个 workspace 时有 256 个 mounts。动态新增的 ACP mount 会在首次相应 ACP 访问时再创建，所以该动态场景少 255 个连接清理 interval；总 Timeout 差值中的额外 1 个属于全局/暂态波动。两条路径不能混算为“同样的 256 个完整 ACP mounts”。堆差异可能也受此影响，但未用 heap snapshot 定量归因。[动态注册发布](../../packages/cli/src/serve/routes/workspace-management.ts#L1160)、[ACP mount 懒创建](../../packages/cli/src/serve/acp-http/index.ts#L1509)。

另各执行五轮同一组 24 个 secondary 的注册/移除，primary 保留；Git 场景每轮先查询所有仓库 Git 状态，再移除。

| 移除后的轮次 | 空目录 GC 后堆 | 空目录 watcher / FD | Git 场景 GC 后堆 | Git 场景 watcher / FD |
| ------------ | -------------- | ------------------- | ---------------- | --------------------- |
| 1            | 90.11 MiB      | 1 / 21              | 90.22 MiB        | 2 / 22                |
| 2            | 90.14 MiB      | 1 / 21              | 90.38 MiB        | 2 / 22                |
| 3            | 90.42 MiB      | 1 / 21              | 90.53 MiB        | 2 / 22                |
| 4            | 90.31 MiB      | 1 / 21              | 90.77 MiB        | 2 / 22                |
| 5            | 90.41 MiB      | 1 / 21              | 90.72 MiB        | 2 / 22                |

移除后 Timeout 均为 13–14，session/child 均为 0。资源能够回落，没有出现按整组 runtime 成本持续累积的趋势；但未完全回到约 88 MiB 的初始堆。五轮小样本及不足 1 MiB 的后续变化不能证明“无内存泄漏”，也未覆盖持续使用不同 cwd 或长时运行。

## 已验证的副作用与未覆盖范围

启动 1/25/256 时，`maxTotalSessions` 分别为 null / 800 / 8192；child heap model 始终为 observe、maxConcurrentChildren=25，已计算 perChildCeilingMb=942 的模型值，但未执行 child 拒绝或将该模型值施加为 V8 heap ceiling。从 1 动态注册到 256 时，总 session 上限仍为 null。这说明 session admission 还依赖启动路径，注册扩容不能顺带默认放大运行容量。[默认推导](../../packages/cli/src/serve/run-qwen-serve.ts#L465)

扩容 PR 仍需处理 channel 事务最大规模与旧 SDK 超时、store 上限与旧版本降级读取、注册配置入口一致性，并在实际部署的 CPU/内存/FD/文件监听预算下验证。保留 25 的旧 timeout 常量只证明本实验没有改大它，不证明该超时足够覆盖未来 256 个 channel worker 的串行事务。

本次没有验证 Linux/Windows、低内存容器、真实大仓库、真实模型 prompt、MCP/extension 负载、enabled cron/channel、SSE/Web Terminal/UI 大列表、持久化 256 条后的重启/降级、完整 10 分钟 keepalive 周期或长期稳定性，也没有实现/验证 LRU 的收益。

27 次本地实验、43 个观测阶段均无异常退出、无模型请求；全部 HTTP 端口已释放。固定 child 场景在停止前记录后代 PID，退出后检查已知 PID 和进程组，均无残留；早期 smoke 的 child PID 另行复查已退出。构建、bundle、typecheck 通过；没有生产代码变更，不适用新增业务单测。

## 本地复现产物

实验脚本和原始完整 status/log 保存在本工作区的 git-ignored `.qwen/`，JSON 摘要保存各原始结果文件的 SHA-256。以下为从仓库根目录执行的入口；`cap256/dist` 须先按上述唯一变更生成，不能直接对生产 source 改共享常量。

```bash
python3 .qwen/scripts/11386-capacity-baseline.py --managed-active
node .qwen/scripts/11386-benchmark.mjs matrix
node .qwen/scripts/11386-benchmark.mjs warm
node .qwen/scripts/11386-benchmark.mjs idle
node .qwen/scripts/11386-benchmark.mjs diagnostic
node .qwen/scripts/11386-benchmark.mjs git-diagnostic
node .qwen/scripts/11386-benchmark.mjs churn
node .qwen/scripts/11386-benchmark.mjs git-churn
node .qwen/scripts/11386-benchmark.mjs boundary
node .qwen/scripts/11386-benchmark.mjs control
python3 .qwen/scripts/11386-summarize.py
```

本地脚本不是新 checkout 自动附带的公共 benchmark 工具。全局版本复现报告位于 `.qwen/issues/11386-capacity-baseline.md`；实验产物、manifest、逐轮 JSON/log 位于 `.qwen/experiments/11386/`。
