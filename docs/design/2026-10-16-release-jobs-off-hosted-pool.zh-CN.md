# Release 任务迁出 GitHub 托管池

[English](2026-10-16-release-jobs-off-hosted-pool.md) | [简体中文](2026-10-16-release-jobs-off-hosted-pool.zh-CN.md)

> 后续方案见[发布排队优化](2026-10-28-release-queue-optimization.zh-CN.md)：最终 npm OIDC 发布保留在 GitHub-hosted runner，启用后的隔离 ECS runner 负责构建和产物交接；音频预构建可复用经过验证的历史产物。启用前仍须完成主机隔离。

## 问题与范围

2026-10-15，两个 v0.25.2 release 工作流完成验证后在 GitHub 托管 runner
队列里干等：`Publish Release` 等了 64 分钟（14:21 变为可运行，15:25 才被
派发——还是在运维手工批量取消约 300 个排队 run 之后），`Quality Checks`
汇总门等了 53 分钟，`Audio Capture Prebuilds / collect prebuilds` 等了 49
分钟。托管池 20 个并发额度被约 146 个排队的自动化 job（`Qwen Pull Request
Review`、`Qwen Code CI`、`Qwen Triage` 等）占满，而 GitHub Actions 对托管
runner 是 FIFO 派发、没有按工作流加急的机制，release 只能排队或让运维手工
批量取消。

本变更把 release 链路上滞留托管池的 job 重新路由到 ECS runner，同时不削弱
当初让 `publish` 走托管机的凭据隔离。

范围之外：按平台的 `prebuild` 矩阵（其 ubuntu-latest x64 lane 当天也排了约
46 分钟，但矩阵的 `runner:` 是纯字面量，交叉编译的迁移值得单独一个变更）、
`notify_failure`（刻意留在托管池——它必须能在"被报告的池"故障时仍然工作）、
以及排队自动化任务本身的行为。

## 现状

`release.yml` 有八个 job 跑在 `ecs-qwen-hk4-host` 池（prepare、各 quality
lane、workspace tests、两个 integration lane）——这些机器是双标签的：同一批
`ecs-qwen-hk4-*` 实例在 `ecs-qwen` 标签下也承接 PR CI。三个 job 留在
`ubuntu-latest`：

- `publish` —— 注释写着 "Keep release credentials off the shared pool that
  runs PR code"。它持有 `secrets.CI_BOT_PAT` 和 npm OIDC trusted
  publishing。
- `quality` —— 不碰工作区的门控 job，只汇总五个检查的结果。
- `notify_failure` —— 失败上报，刻意留在托管池。

`audio-capture-prebuilds.yml` 的 `collect` job（只做制品合并，无凭据）也跑
在 `ubuntu-latest`。

## 目标

- release 的 job 不再排在 PR 自动化任务后面等托管池。
- `publish` 绝不落到任何执行 PR 代码的机器上。
- 仅合并本变更不在运行时产生任何变化，直到运维准备好专用 runner 并打开
  opt-in 变量。

## 方案

- `quality` 改用与它聚合的五个检查相同的条件 `runs-on` 表达式，迁入
  `ecs-qwen-hk4-host` 池。它补上 `restore_release_workspace` wipe 锚点
  （池卫生不变量：所有池路由 job 必须先 wipe），但因从不 checkout、没有重
  步骤，仍然豁免磁盘水位门。合入即生效——`quality` 运行时这些机器已空闲。
- `publish` 与 `collect` 迁到新的、只服务 release 的 runner 标签
  `ecs-qwen-release-host`，由新的 opt-in 仓库变量
  `ECS_RELEASE_HOST_RUNNER_ENABLED` 控制：
  `${{ (github.repository == 'QwenLM/qwen-code' && vars.ECS_RELEASE_HOST_RUNNER_ENABLED == 'true') && fromJSON('["self-hosted", "linux", "ecs-qwen-release-host"]') || fromJSON('["ubuntu-latest"]') }}`
  音频复用后续改动从两个表达式中都移除了 `x64`，以匹配 release-host
  runner。这不代表该通道已经可以启用。
  变量未设置（默认）时两个 job 与本变更之前完全一样派发到
  `ubuntu-latest`。保持变量未设置，直到主机隔离得到确认，且 #15832 完成
  构建通道与 hosted npm 发布的拆分。
- `publish` 补上 `release_disk_floor_gate` 锚点（在它的 checkout 之后、安装
  之前），纳入与其他池路由 job 相同的 ENOSPC 快速失败机制（#10035）。
- `collect` 和 release workflow 的清理锚点都在 checkout 或合并制品前调用
  共享的 `prepare-release-runner` action。在持久工作区上，
  `download-artifact` 会合并进已存在的路径，因此必须先经过工作区边界检查
  再删除残留文件。清理失败会让 job 停止，而不是发布脏制品。
- `.github/actionlint.yaml` 登记新标签。

## 设计决策与理由

- **用 opt-in 变量而不是现有的 `MAINTAINER_ECS_RUNNER_DISABLED` 逃生口。**
  逃生口是对"已存在的池"的 opt-OUT；`ecs-qwen-release-host` 的机器尚不存在，
  默认打开会让 `publish` 永远卡在一个零 runner 的标签上。opt-in 保证合并安
  全，激活只是运维的一行动作。
- **新建标签而不是复用 `ecs-qwen-hk4-host`。** 工作流文件能选择的是 runner
  标签而非 runner group，而 2026-10-15 的调查表明 `ecs-qwen-hk4-host` 机器
  就是 `ecs-qwen` 标签下跑 PR CI 的同一批实例（当天 release job 和 PR CI
  job 都落在 `ecs-qwen-hk4-2/-23/-26/-28` 上）。把 `publish` 的凭据放上这些
  机器，恰恰破坏旧注释要求的隔离。
- **`quality` 立即迁入共享池。** 它没有密钥、不碰工作区：被攻破的邻居最多
  能影响一个 3 秒的结果检查，而 publish 侧仍通过 `needs.*.result` 接线复核。
  如果等专用硬件，每次 release 的关键路径上都会留着 53 分钟的托管排队。
- **更新测试契约而不是削弱它。** `release-workflow.test.js` 的池路由标记同
  时识别两个标签，因此"先 wipe"和"磁盘水位门"两条不变量自动延伸到新池。
  `publish` 新增被门控（它有 checkout 和安装步骤）；`quality` 按结构豁免
  （没有 checkout，水位门无从搭载），而不是按名字豁免。

## 约束与风险

- **风险：专用机器是串行化的单点。** 启用后 `collect`（约 5 秒）和
  `publish`（约 16 分钟）共享同一台机器；但 release 本来就必须先收集制品
  才能发布，串行关系与现有依赖链一致。再加一台同标签机器即可消除该风险，
  无需改工作流。
- **风险：运维在注册 runner 之前拨开变量。** `publish` 会一直排队。
  `timeout-minutes: 90` 会把这种误配变成一次失败（且被上报）的 run，而不是
  永久卡死。
- **fork 触发 `audio-capture-prebuilds.yml` 不受影响**：表达式中的仓库条件
  让 `QwenLM/qwen-code` 之外回落到 `ubuntu-latest`。

## 验证计划

- `npx vitest run scripts/tests/release-workflow.test.js` —— 覆盖 wipe 顺
  序、水位门位置、行数棘轮、聚合契约与新路由断言。
- `node scripts/lint.js --actionlint` 与 alias 告警增量核对：唯一的新告警是
  两个与现有七十一个完全同形的别名引用（本地 actionlint 解析不了 YAML 锚
  点，CI 版本可以——基线与变更行为一致）。
- 其余四个解析 `release.yml` 的套件（`ai-release-notes`、`install-script`、
  `package-scripts`、`workflow-size`）与 `classify-release-notes.test.mjs`
  全部通过且无需改动断言。
- #15854 保持 `ECS_RELEASE_HOST_RUNNER_ENABLED` 未设置，在 PR head 上执行
  release dry-run。启用验证留给 #15832，前提是完成主机隔离和 hosted npm
  发布边界；下面保留的原始路由验收标准不代表可以启用当前通道。

## 验收标准

- `ECS_RELEASE_HOST_RUNNER_ENABLED` 未设置时，所有 release job 的派发与本
  变更之前完全一致。
- 设置后，`publish` 与 `collect` 只跑在 `ecs-qwen-release-host` 机器上，
  `quality` 跑在 `ecs-qwen-hk4-host`，`notify_failure` 留在托管池，且池有
  容量时 release 不再排在 PR 自动化后面。
- `publish` 的 `runs-on` 无法选中任何与 PR CI 共享的标签——由更新后的元测
  试钉死。

## 待定问题

- `ecs-qwen-release-host` 机器开几台（一台即可解锁；两台消除串行），复用哪
  个 ECS 实例规格。
- ubuntu-latest x64 的 `prebuild` 矩阵 lane 是否在后续变更中迁入共享池。
