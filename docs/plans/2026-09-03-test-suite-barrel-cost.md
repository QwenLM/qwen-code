# 测试套件耗时根因：core barrel import

**日期**：2026-09-03
**状态**：根因已定位并实测验证；迁移写法已确定（见 6.1）；第一批 130 个模块已提交（#10917 提供解析映射，#10946 为迁移本身）。
**结论**：CI 测试慢的根因不是调度，是**每个测试文件为了跑几毫秒的断言，要先把 core 的整个 barrel（约 612 个模块）求值一遍**。过去一个月围绕超时、重试、分片、并发做的工作都是在给一个 90% 时间花在 import 上的负载做负载均衡，天花板固定。

---

## 1. 现状：时间去哪了

数据来自 release run `33713579913` 的三个 `Workspace Tests` 分片日志（`gh api /repos/QwenLM/qwen-code/actions/jobs/<id>/logs --allow-escape-sequences`）。

### 分片是均衡的

| 分片 | job 耗时 | vitest 墙钟 |
|---|---|---|
| 1/3 (success) | 44.0 min | 40.4 min |
| 2/3 (failure) | 42.9 min | 39.1 min |
| 3/3 (failure) | 43.4 min | 39.7 min |

三片几乎完全一致 → **分片策略本身没有问题，继续加分片只能线性摊薄，动不了单位成本。**

### 单个分片内部，cli 占七成

shard 1/3 的逐 workspace 拆解：

| workspace | 文件 | 测试 | 墙钟 | collect | 实际跑测试 | 占比 |
|---|---|---|---|---|---|---|
| `@qwen-code/qwen-code` (cli) | 334 | 8190 | 1671.2s | 2223.8s | 1372.6s | **68.9%** |
| `@qwen-code/qwen-code-core` | 212 | 6776 | 388.1s | 545.8s | 250.6s | 16.0% |
| `@qwen-code/web-shell` | 85 | 1617 | 147.9s | 108.0s | 94.1s | 6.1% |
| 其余 12 个 workspace | — | — | ~200s | — | — | ~5% |

（`collect` / `tests` 等是跨 worker 的累计值，会超过墙钟；关键是它们之间的比例。）

### 核心异常：collect > tests

- cli：`collect 2223.8s` vs `tests 1372.6s`
- core：`collect 545.8s` vs `tests 250.6s`

**导入模块的时间比跑断言的时间还长。** 这是整个诊断的入口。

---

## 2. 根因：barrel import

`packages/core/index.ts` → `export * from './src/index.js'`，传递闭包约 **612 个模块 / 27.5 万行**。

任何 `import { X } from '@qwen-code/qwen-code-core'` 都要把这 612 个模块完整求值一次，无论只用了其中一个 enum。

### 对照实验

同一个符号 `AuthType`，同一个断言，两种导入方式：

```
import { AuthType } from '../../../core/src/core/contentGenerator.js'
  →  Duration 1.38s   (collect  353ms, tests 4ms)

import { AuthType } from '@qwen-code/qwen-code-core'          ← barrel
  →  Duration 10.60s  (collect 9.56s,  tests 4ms)
```

**27 倍。**

### 套件里自带的天然对照组

`core/auth.test.ts` 和 `commands/channel/pidfile.test.ts` 用 `vi.mock('@qwen-code/qwen-code-core', factory)` 把整个 barrel 工厂替换掉了——真实模块从未被求值。它们的耗时是 **1.80s / 2.12s**，而同包同配置的其他文件是 ~11.5s。

同包、同 jsdom、同 setup files，唯一差别是 barrel 有没有真的被 evaluate。这条独立路径和上面的深路径改写收敛到同一个下界（~2s），因果链成立。

### 一个容易漏掉的分支：type-only 导入是免费的

`import type { X } from '@qwen-code/qwen-code-core'` 会被 esbuild 在转译期整体擦除，零运行时成本。统计影响面时必须区分值导入和类型导入，否则会高估约 20%。

---

## 3. 影响面

在 origin/main 上统计（**871 / 1242** 个 cli 源文件导入 barrel，70%）：

| 分类 | 模块数 |
|---|---|
| 有 barrel 值导入的 cli 源模块 | **453** |
| 其中可立即迁移（无 mock 耦合） | **142** |
| 需先搬 mock 才能迁移 | **311** |
| 涉及的 barrel mock 测试 | 138（纯替换型 32 / `...actual` 展开型 106） |

> 早期版本的这一节用的是一份落后 main 约三周的本地快照（380 个模块 / 131 可迁移）。三周内涨了 73 个模块，和第 7 节「每周 +110 个测试文件」的增速一致，也说明这件事拖着只会更贵。

### hub 阻塞的真相

40% 看起来很糟，但查下去发现阻塞只来自 **76 条值引用、21 个符号**：

```
常量:   DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD / _LINES,
        MAX_SUBAGENT_DEPTH_LIMIT, DEFAULT_MAX_SUBAGENT_DEPTH,
        DEFAULT_TOOL_OUTPUT_BATCH_BUDGET, APPROVAL_MODE_INFO
纯函数: isGatedMcpScope, matchesAnyServerPattern, parseVisionModelSetting,
        mcpServerRequiresOAuth, getMCPDiscoveryState, createTransport
枚举:   MCPDiscoveryState, SettingScope, ExtensionUpdateState,
        AuthProviderType, MCPServerConfig, TrustGateError
真 hub: Config (5 处), ExtensionManager (14 处)   ← 只有这两个是真的
```

只有 3 个 core 模块本身是 hub（探针实测，其余 27 个高频模块都在地板上）：

| 模块 | 导入成本 |
|---|---|
| `config/config.ts` | 12.06s |
| `extension/extensionManager.ts` | 11.66s |
| `tools/mcp-client.ts` | 10.94s |
| 其余 27 个高频模块 | 1.67 – 3.20s |
| （空测试地板 / barrel 上界） | 1.97s / 12.34s |

**把那 19 个常量、枚举、纯函数抽成叶子模块**（机械活，约一天），可修复率从 25% 跳到 **58%**，剩下真正被 `Config` / `ExtensionManager` 挡住的只有 51 个文件（7%）。

---

## 4. 验证结果

对 15 个「单一污染点」文件做了改写前后实测（单 worker、关 coverage、取两轮最小值）：

| 文件 | 前 | 后 | 倍数 |
|---|---|---|---|
| `ui/utils/osc8.test.ts` | 13.20s | 1.93s | 6.8x |
| `serve/live/capture-screen-context.test.ts` | 12.29s | 2.44s | 5.0x |
| `acp-integration/generation.test.ts` | 11.57s | 1.80s | 6.4x |
| `serve/model-providers-edit.test.ts` | 11.53s | 2.06s | 5.6x |
| `ui/themes/detect-terminal-theme.test.ts` | 11.43s | 1.99s | 5.7x |
| `ui/hooks/session-mention-ref.test.ts` | 11.19s | 2.00s | 5.6x |
| `services/skill-args-file.test.ts` | 11.44s | 2.26s | 5.1x |
| `services/markdown-command-parser.test.ts` | 11.04s | 2.09s | 5.3x |
| `remoteInput/RemoteInputWatcher.test.ts` | 11.54s | 2.61s | 4.4x |
| `commands/review/lib/diff-plan.test.ts` | 11.12s | 2.19s | 5.1x |
| `config/extension-runtime-reload.test.ts` | 10.86s | 1.96s | 5.5x |
| `services/tips/tipHistory.test.ts` | 10.90s | 2.20s | 5.0x |
| `acp-integration/session/tasksSnapshot.test.ts` | 11.77s | 11.04s | 1.1x ← hub |
| `serve/env-snapshot.test.ts` | 11.54s | 11.25s | 1.0x ← hub |
| `config/mcpJson.test.ts` | 11.27s | 11.94s | 0.9x ← hub |

**12/15 改善 5.4 倍（11.51s → 2.13s），3 个被 hub 卡住，15 个测试全部通过。**

验证用的改写涉及 15 个源文件（34 增 54 删），仅改导入语句，未改任何测试断言。

> ⚠️ **这个改写用的是相对源码路径，只能用于隔离测量变量，不能作为迁移写法。** 正确写法见 6.1。

---

## 5. 分阶段收益预估

以 shard 1/3 为基准（cli 27.8 min，分片 40.4 min，job 44.0 min）：

| 阶段 | 工作量 | 覆盖 | cli | job |
|---|---|---|---|---|
| 现状 | — | — | 27.8 min | **44.0 min** |
| ① 补 vitest 通配 alias → codemod 改导入 → lint 规则 | 脚本批改 | 25% 文件 | 22.5 min | **~39 min** (−11%) |
| ② + 抽 19 个符号出 hub | ~1 天 | 58% 文件 | 15.0 min | **~31 min** (−30%) |
| ③ + jsdom 按需 | ~半天 | — | 12.9 min | **~29 min** (−34%) |
| ④ + workspace 并行 | 改 CI 调度 | — | — | **~20 min** (−55%) |

**②③ 是甜点区**：约 1.5 天换 job 44 → 29 分钟，45 分钟的超时从「擦线过」变成有 1.5 倍余量。

④ 的空间来自 `test:release:workspaces` 用的是 `npm run test:ci --workspaces`——18 个 workspace **串行**跑，`--shard` 还是在每个 workspace 内部各自切 3 份。并行后是 max 不是 sum，但依赖 ECS 实际核数，不确定性最大。

### 附带的两个小发现

- **jsdom 全量开着**：`packages/cli/vitest.config.ts` 对全部 1002 个测试文件设了 `environment: 'jsdom'`，但只有约 113 个碰 DOM，103 个用 ink-testing-library（ink 渲染成字符串，不需要 DOM）。地板成本实测 1.3s/文件（2.28s → 1.00s）。
- **`poolOptions.threads` 的配置是有效的**：vitest 3.2.4 的默认 pool 是 `threads`（`resolved.pool ??= "threads"`），且 `VITEST_MAX_THREADS` 环境变量会**覆盖**配置里硬编码的 `maxThreads: 16`。CI 里那个并发旋钮是生效的，不用改。

---

## 6. 迁移写法与风险

### 6.1 迁移写法（已确定）

cli 的产物是 esbuild 单文件 bundle（`bundle: true, packages: 'bundle'`，入口 `packages/cli/src/cli.ts`，发布物只有 `dist/`）。**运行时没有模块解析，全部内联**，所以 barrel vs 深路径纯粹是构建期问题，对 npm 安装后的执行没有直接影响。

解析链已经查清：

| 环节 | 机制 | 落点 |
|---|---|---|
| 构建（esbuild） | `packages/cli/tsconfig.json` 的 `paths`（esbuild 会读） | `packages/core/src/*.ts` |
| 测试（vitest） | `packages/cli/vitest.config.ts` 的手写 `alias` | `packages/core/src/*.ts` |
| `package.json` 的 `exports` | **两条链都不会咨询它** —— paths / alias 先命中 | — |

两条链都落在 core 的 **TypeScript 源码**上，从来不碰 `dist/`。所以正确的迁移写法是包说明符 + core/src 下的相对路径：

```ts
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
```

三处配置的现状：

- **tsconfig**：`"@qwen-code/qwen-code-core/*": ["../core/src/*"]` —— **已经存在，不用改**
- **vitest alias**：目前只有 4 个具名 subpath（`/goalWire`、`/transcriptRecords`、`/memoryScopes`、`/userPromptSubmitContext`）加一个 barrel，**没有通配**。深路径导入今天在测试里会解析失败，**必须先补一条通配 alias**，这是 phase ① 的第一步。
- **`package.json` 的 `exports`**：只有 `"./dist/*"` 和 `"./src/*"`，没有 `"./*"` 兜底。构建和测试都不经过它，所以不阻塞迁移；但为了包的外部消费者（vscode-ide-companion 21 个文件、acp-bridge 9 个）行为一致，建议补一条 `"./*": "./dist/src/*"`。

### 6.2 模块重复 —— 只要写法统一就不会发生

如果同一个 core 模块通过两条不同的解析路径进入 bundle，会出现**两份副本**：singleton 失效、`instanceof` 失败、模块级缓存分裂。这不是假设，esbuild `metafile.inputs` 实测：

```
barrel + '@qwen-code/qwen-code-core/dist/src/utils/debugLogger.js':
  debugLogger 副本数: 2
    - packages/core/src/utils/debugLogger.ts     ← barrel 经 tsconfig paths 命中源码
    - packages/core/dist/src/utils/debugLogger.js ← /dist/ 说明符不匹配 paths，回落到 node 解析
```

根因就是 6.1 那张表：`@qwen-code/qwen-code-core/*` 这条 paths 规则匹配不到 `dist/...` 前缀（会拼成不存在的 `../core/src/dist/...`），于是回落到 `exports` 的 `"./dist/*"`，落到编译产物上，和走源码的 barrel 撞成两份。

**规则很简单：只用 `@qwen-code/qwen-code-core/<core/src 下的路径>`，绝不用 `/dist/...`，绝不用相对路径。** 只要统一这一种写法，barrel 和深路径都落在 `core/src/` 同一批文件上，不会重复。

> 早先的验证补丁用的是相对源码路径（`../../../core/src/...`），那只是为了隔离测量变量，**不能作为迁移写法** —— 它在 bundle 里同样会和别处的 barrel 撞成两份。

### 6.3 `vi.mock` 会静默失效 —— 迁移的真正成本所在

main 上有 **138 个** cli 测试写了 `vi.mock('@qwen-code/qwen-code-core', factory)`。一旦被测代码改成 subpath 导入，mock 就不再拦截——**测试仍然是绿的，但测的东西变了**。

但这 138 个不是同一回事，风险差别很大：

| 类型 | 数量 | 行为 | 迁移影响 |
|---|---|---|---|
| **纯替换型**（无 `importOriginal`） | 32 | barrel 从不求值（这也是它们只要 ~1.9s 的原因） | 被测代码一改就**真的会坏** |
| **`...actual` 展开型** | 106 | 加载真实 barrel，只覆盖少数符号 | 只有当被覆盖的符号正是该文件所导入的才有影响 |

据此可以逐模块判定「迁移是否会改变任何测试的行为」，得到第 3 节那个 142 / 311 的划分。

**阻塞高度集中**：2 个纯替换型测试（`authPreflight.test.ts`、`acpAgent.worktree.test.ts`）各自卡住 217 个模块；符号覆盖型里 `createDebugLogger` 一个名字就占 173 次阻塞。修复范围与解锁量：

| 修复范围 | 可迁移模块 |
|---|---|
| 不动 mock | 142 |
| + 搬 32 个纯替换型 | ~260 |
| + 再搬 `createDebugLogger` 覆盖 | ~310 |
| + 长尾 85 个符号 | 453 |

**所以分批应该按 mock 拓扑，不是按目录。**

### 6.4 bundle 体积（可能是意外收益）

`sideEffects` 字段三个 package.json 里都没声明，esbuild 只能保守处理。单符号实验：

| 导入方式 | bundle | 模块数 |
|---|---|---|
| barrel | 15,785 KB | 2336 |
| 深路径 | 41 KB | 55 |

真实 cli 入口本来就用到 core 的大部分，实际收缩幅度**远小于**这个比值，需要在另一台机器上跑完整 `npm run bundle` 前后对比。但方向是好的：bundle 变小 = npm 启动变快。

### 6.5 大规模 diff 的运营成本

改动会和 200 个 open PR 大面积冲突，必须分批。**按 mock 拓扑分批**（见 6.3），不要按目录——同一目录下的文件 mock 耦合情况完全不同，按目录切会把「必须连同测试一起改」的文件和「纯改导入」的文件混进同一个 PR。

### 6.6 codemod 本身的两个坑（已踩过）

1. **符号表必须验证「目标模块确实导出该符号」**。沿 barrel 的 re-export 链建表时，若符号是被再导出而非本地声明，容易指向再导出方而不是声明方。实测 492 个 (符号,模块) 组合里出了 1 个这样的错（`ProviderModelConfig` 被指到 `models/types`，实际在 `providers/types`），直接导致 `tsc --build` 失败。**必须有一道独立校验**，逐条确认目标模块的导出集合（含其自身 re-export）包含该符号。

2. **Prettier 从仓库外的路径调用会静默空转**。以仓库根为 cwd、对 cwd 之外的绝对路径调用 `prettier --write`，文件会被跳过，且 `--check` 依然报告成功。必须让 cwd 落在被格式化文件所在的树内，并用绝对路径指向仓库锁定的那个 prettier 二进制（否则可能解析到全局的其它版本，会连无关代码一起重排）。

### 6.7 esbuild 的 chunk 分割 —— 已排除

早期担心：改变导入粒度会让模块在 chunk 之间移动，可能破坏靠 `import.meta.url` 找同级资源的代码。查证后**不成立**。`resolveBundleDir` 的实现对 chunk 形状免疫：

```ts
return path.basename(moduleDir) === BUNDLE_CHUNK_DIR
  ? path.dirname(moduleDir)   // dist/chunks -> dist
  : moduleDir;                // dist -> dist（no-op）
```

`chunkNames: 'chunks/[name]-[hash]'` 只有一层，模块只可能落在 `dist/` 或 `dist/chunks/`，两者都解析到 `dist/`。裸用 `__dirname` 的只有 3 处，且注入的 shim 被所有文件引用、必然进共享 chunk，位置稳定。

---

## 7. 为什么这次不会像分片那样被吃掉

测试文件数的增长：

| 版本 | 日期 | 测试文件 |
|---|---|---|
| v0.18.0 | 2026-06-12 | 1278 |
| v0.19.0 | 2026-06-23 | 1406 |
| v0.20.0 | 2026-07-19 | 1872 |
| v0.21.0 | 2026-07-24 | 1953 |
| v0.22.0 | 2026-08-22 | 2390 |

**10 周 +87%，约 +110 个/周。**

分片买的是常数因子（3 片 = 3x），按这个增速约 15 周就被吃完——这和过去 30 天里 timeout / retry / runner / shard / concurrency 类 PR 合并了约 69 个的观感完全吻合。

barrel 修法降的是**单位成本**。再配一条 lint 规则（禁止从 `@qwen-code/qwen-code-core` 值导入，强制走 subpath），新增测试就不可能把成本加回来。增长仍会推高总时长，但斜率降到原来的约 1/5。

---

## 附录：超时参数的来历

| 时间 | PR | `workspace_tests` timeout |
|---|---|---|
| 2026-08-29 之前 | — | **未设**（吃 GitHub 默认 360 min） |
| 2026-08-29 | #10036 路由到 ECS 池 | 首次加显式上限 **120** |
| 2026-09-01 | #10619 把 quality 拆成 5 个 job | **45**（`quality_build` 也是 45） |
| 进行中 | #10805 | 参数化为 repo variable，默认仍 45 |
| 进行中 | #10886 | 提到 **90** |

45 是照着拆分前那个整块 job 的实际耗时（近 55 次 run 里 p50 33.7 / p90 41.7 min）取的，但拆完后被贴到了**单个分片**上。分片正常只跑 16 分钟，余量本该很大；问题是 ECS 争抢时会涨到 34–44 分钟（p90 35.1，9 月 3 日 1/3 分片实测 44.0 擦线过），余量就没了。

顺带：拆分前的 120 分钟上限也被撞过三次（08-30 121.1min cancelled、08-31 120.7min cancelled、09-01 98.3min failure）。

---

## 数据来源与可信度

| 来源 | 结论 | 可信度 |
|---|---|---|
| CI job 日志（run 33713579913） | 逐 workspace 耗时、collect/tests 比例 | 高 |
| GitHub API（55 次 release run、5 个 tag 的 tree） | job 时长分布、测试文件增长 | 高 |
| `git grep` / AST 无关的正则统计 | barrel 导入文件数、符号频次 | 中高（正则，非 AST） |
| 本地 vitest 实测 | 单文件前后对比、逐模块探针 | 数据有效，但**比值可迁移、绝对时间不可迁移**（本机 4 核 / 7.4G） |
| 本地 esbuild 实验 | 模块重复、bundle 体积 | 机制成立，绝对数值不代表真实构建 |
| 静态闭包分析 | — | **不可靠，已弃用**：正则把 `await import()` 动态导入也算进去了，而动态导入在加载时不求值。文中所有闭包相关结论以实测为准 |

第 5 节的分阶段预估基于单次 CI run 的组件耗时模型，误差估计 **±20%**。

> **注**：第 3、4 节的实测数据来自一台 4 核 / 7.4 GB 的开发机，单 worker、关 coverage。这个规格跑不了完整 build，也承受不住并发测量，因此**倍数关系可用，绝对耗时不可外推**。后续验证建议直接在 CI 上做——给一条分支加一个只跑目标文件的 workflow，比在本地复现这套测量更省事也更可信。
