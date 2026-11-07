# CI 测试按实测耗时分片

[English](2026-11-07-ci-duration-sharding.md) | [简体中文](2026-11-07-ci-duration-sharding.zh-CN.md)

状态：已在本次改动中实现。前置文档：[缩短 Pull Request CI 的关键路径](2026-11-06-ci-pr-critical-path.zh-CN.md)。

## 问题

#16450 合入后，内部 PR 的 required 路径中位数从 28.5 分钟降到 21.4 分钟（2026-11-06 至 11-07，95 次 run），离 15 分钟的目标还差一截。这 95 次里，Linux 单测 lane 有 66 次最后完成，其余是 no-AK 集成测试 lane。

- **单测分片不均。** Vitest 的 `--shard` 按路径哈希排序，给每片分相同数量的文件，不看耗时。shard 1（CLI 589 s）和 shard 6（CLI 743 s）跑了 12–14 分钟，shard 4 的 CLI 文件 146 s 就跑完了。
- **单个文件决定分片下限。** 一个文件只能在一个 worker 上跑，所以怎么切都快不过最慢的那个文件。`Session.test.ts`（6.6 万行，约 556 s）、`hosted-harness-session.test.ts`（约 292 s）和 `hosted-workspace-tool-turn.test.ts`（PR run 里约 206 s，带 coverage 时约 650 s）落在哪一片，哪一片就慢。
- **集成测试分片也不均**（测试步骤中位数分别是 425 s、163 s、498 s）。`mods-tool-middleware.test.ts` 一个文件就约 430 s；shard 1 还要先做集成测试源码的类型检查（约 100 s）再跑测试。
- **构建有一半时间落在慢主机上。** x64 池里混着 ARM64 主机（hz）。`test_build` 在 hz 上要 435 s，在 x64 的 hk 主机上 206 s，而所有单测和集成测试分片都要等它。

## 设计

### 按耗时分片

- **数据。** `.github/scripts/ci/test-durations.json` 按 suite（`packages/cli`、`packages/core`、`integration-tests`）记录三项：ECS 上每片用的 worker 数、每个文件的固定开销（import 和 collect），以及耗时 ≥2 s 的文件的中位耗时（秒）。更快的文件只计固定开销。
- **分配。** `test-shard-plan.mjs` 从最慢的文件开始放。每片的完成时间估为"最大单文件"和"总耗时 ÷ worker 数"中较大的那个。每个文件放进能让最慢一片的完成时间保持最低的那一片；有几片持平时，选当前负载最小的。排序和平局只看路径和耗时，所以每一片在任何主机上算出的分配都一样。worker 数也写在数据里，而不是从主机读取，原因相同。
- **sequencer。** `vitest-duration-sequencer.mjs` 继承 Vitest 的 `BaseSequencer`。传了 `--shard` 时，它返回本片在分配中的那部分文件，并让最慢的文件先跑。数据里没有的 suite 沿用 Vitest 默认行为。cli、core 和集成测试的配置接入了它；其余 workspace 都很小，在 side lane 里跑。
- **刷新。** `update-test-durations.mjs` 读取最近几次成功的 PR run 的日志，取 Vitest 打印的每个文件耗时。push run 带 coverage，会更慢，所以不用；也只用跑在 ECS 池上的分片。由人手动运行并提交 diff。新增或改名的文件在下次刷新前只计固定开销。

### 拆分最慢的文件

测试原样搬到同目录的兄弟文件里，各自复制共用的 setup，沿用 `hosted-workspace-tool-turn.*.test.ts` 已有的做法。每组拆分前后的测试名称集合完全一致（用 `vitest list` 核对过）。

| 原文件                               | 拆分后                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `Session.test.ts`                    | `Session`、`Session.prompt`、`Session.prompt-queue`、`Session.tool-calls` |
| `hosted-harness-session.test.ts`     | 原文件、`.no-tool`、`.tools`                                              |
| `hosted-workspace-tool-turn.test.ts` | 原文件、`.approvals`、`.hooks`                                            |
| `mods-tool-middleware.test.ts`       | 原文件和 `.rest`，共用 `.suite.ts`                                        |

`Session.test.ts` 拆开后本身也更快：本地单独跑要 294 s，拆成 4 个文件后合计 128 s。在这个 6.6 万行的文件里，越靠后的测试越慢，因为前面积累的状态越来越多。

### 集成测试类型检查与测试并行

shard 1 在后台启动 `typecheck:integration`，然后跑测试，跑完再等类型检查结束并打印它的日志。两者任何一个失败，这一步都失败。

### 把构建固定到 x64 主机

`classify_pr` 新增输出 `build_runner`。默认等于 `ubuntu_runner`；只有设置了仓库变量 `BUILD_RUNNER_LABELS`、并且 `ubuntu_runner` 选的是 x64 池时，才改用这个变量里的标签。只有 `test_build` 读取它。hk 主机需要一个自己独有的标签，建议叫 `ecs-qwen-hk`：`runs-on` 要求所列标签全部匹配，没法排除某个标签，而两组主机现在挂的是同样的 4 个标签。在运维加上标签并设置变量之前，什么都不会变；清空变量即可回退。

## 决策

| 决策                                     | 理由                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| 耗时数据提交进仓库，不放 `actions/cache` | 可 review、结果确定；fork PR 和本地都能用；集成测试不在 push 上跑             |
| 从 job 日志取每个文件的耗时，不用 JUnit  | PR run 不带 coverage；集成测试 lane 不写 JUnit                                |
| worker 数固定写在数据里                  | 主机配置不同（`maxWorkers: '25%'`）；分配如果依赖主机，文件可能被漏跑或重复跑 |
| 拆文件放在同一个改动里                   | 不拆的话最慢文件就是下限：只改分配，每条 lane 只省约 1–1.5 分钟               |
| `build_runner` 由变量开关                | hk 标签还不存在；改动合入后先不生效，运维不发 PR 就能开关                     |

## 风险

- **耗时数据过期。** 新增或改名的文件在刷新前只计固定开销。基于过期数据的分配只会不均，不会出错：每个文件仍然只在一片里跑一次。
- **头几次 run 用的是估算值。** 拆出来的文件目前是估算耗时，用本改动自己的 run 刷新数据即可。
- **构建固定到 hk 后**，hk 忙时构建会排队。清空变量即可回到整个池。

## 验证

- `.github/scripts/ci/test-shard-plan.test.mjs`：1–60 片时每个文件都恰好落在一片里；输入顺序不影响结果；慢文件会被分散；耗时数据文件格式正确。
- 用真实文件列表（cli 1463 个、core 1015 个）验证：8 片的分配覆盖每个文件恰好一次；估算的最慢一片 cli 为 183 s，core 为 106 s。在 core 里实际跑 `vitest run --shard=1/8`，跑的正是分配给它的那个文件。
- `.github/scripts/ci-runner-routing.test.mjs`：变量为空时 `build_runner` 等于 `ubuntu_runner`；设置变量后只收窄 x64 池的路由，fork PR、紧急开关、托管和 ARM64 选项都不受影响；只有 `test_build` 读取它。
- `no-ak-integration-ci`：新增的集成测试文件已列入；gate 会等类型检查结束，并在它失败时失败。

## 验收标准

- 每个 PR 上，每个 Linux 单测文件和每个 no-AK 集成测试文件都仍然跑且只跑一次。
- 取 20 次 run，最慢的 Linux 单测分片测试步骤中位数低于 8 分钟。
- 取 20 次 run，required 路径中位数低于 17 分钟；设置 `BUILD_RUNNER_LABELS` 后低于 15 分钟。
