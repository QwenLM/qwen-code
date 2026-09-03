# 测试套件耗时根因：core barrel import

**日期**：2026-09-03
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

以本地分支（比 main 落后约 3 周，cli 有 781 个测试文件）统计：

| 分类 | 文件数 | 占比 |
|---|---|---|
| 本来就干净（无 barrel 值导入） | 161 | 21% |
| 已 `vi.mock` barrel（本来就快） | 113 | 14% |
| **可直接修复** | **197** | **25%** |
| **受 hub 阻塞** | **310** | **40%** |

origin/main 上：**871 / 1242** 个 cli 源文件导入 barrel（70%），322 / 1002 个测试文件直接导入。

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

> ⚠️ **这个补丁用的是相对源码路径（`../../../core/src/...`），只能用于测量，不能作为迁移写法。** 原因见第 6 节。

---

## 5. 分阶段收益预估

以 shard 1/3 为基准（cli 27.8 min，分片 40.4 min，job 44.0 min）：

| 阶段 | 工作量 | 覆盖 | cli | job |
|---|---|---|---|---|
| 现状 | — | — | 27.8 min | **44.0 min** |
| ① 改 barrel 导入 + lint 规则 | 脚本批改 | 25% 文件 | 22.5 min | **~39 min** (−11%) |
| ② + 抽 19 个符号出 hub | ~1 天 | 58% 文件 | 15.0 min | **~31 min** (−30%) |
| ③ + jsdom 按需 | ~半天 | — | 12.9 min | **~29 min** (−34%) |
| ④ + workspace 并行 | 改 CI 调度 | — | — | **~20 min** (−55%) |

**②③ 是甜点区**：约 1.5 天换 job 44 → 29 分钟，45 分钟的超时从「擦线过」变成有 1.5 倍余量。

④ 的空间来自 `test:release:workspaces` 用的是 `npm run test:ci --workspaces`——18 个 workspace **串行**跑，`--shard` 还是在每个 workspace 内部各自切 3 份。并行后是 max 不是 sum，但依赖 ECS 实际核数，不确定性最大。

### 附带的两个小发现

- **jsdom 全量开着**：`packages/cli/vitest.config.ts` 对全部 1002 个测试文件设了 `environment: 'jsdom'`，但只有约 113 个碰 DOM，103 个用 ink-testing-library（ink 渲染成字符串，不需要 DOM）。地板成本实测 1.3s/文件（2.28s → 1.00s）。
- **`poolOptions.threads` 的配置是有效的**：vitest 3.2.4 的默认 pool 是 `threads`（`resolved.pool ??= "threads"`），且 `VITEST_MAX_THREADS` 环境变量会**覆盖**配置里硬编码的 `maxThreads: 16`。CI 里那个并发旋钮是生效的，不用改。

---

## 6. 风险与未决项

### 6.1 模块同一性 —— 最高风险

cli 的产物是 esbuild 单文件 bundle（`bundle: true, packages: 'bundle'`，入口 `packages/cli/src/cli.ts`，发布物只有 `dist/`）。**运行时没有模块解析，全部内联。**

这意味着 barrel vs 深路径是**构建期**问题，但有一个致命陷阱：如果同一个 core 模块通过两种解析路径进入 bundle，会出现**两份副本** —— singleton 失效、`instanceof` 失败、模块级缓存分裂。

esbuild 实测（`metafile.inputs`）：

```
混用 dist 深路径 + 相对源码路径:
  debugLogger 副本数: 2
    - packages/core/dist/src/utils/debugLogger.js
    - packages/core/src/utils/debugLogger.ts
```

**所以迁移必须统一走包说明符**（`@qwen-code/qwen-code-core/<subpath>`），配 vitest alias，**绝不能用相对路径**。core 的 `package.json` 已有 `"./dist/*"` 和 `"./src/*"` 通配 exports，加具名 subpath 也有先例（`/goalWire`、`/memoryScopes` 等 4 个，且 `memoryScopes` 已在生产代码 `serve/run-qwen-serve.ts:62` 用着）。

### 6.2 ⚠️ 未验证：barrel 在 bundle 里解析到了源码而不是 dist

esbuild 实测：`import { createDebugLogger } from '@qwen-code/qwen-code-core'` 拉进 **612 个 `packages/core/src/*.ts`，0 个 `dist/`**。

这与 `package.json` 的 `exports: { ".": { "import": "./dist/index.js" } }` 预期不符（`dist/index.js` 和 `dist/src/index.js` 都确实存在，1210 个 js 文件）。根 tsconfig 里没有 `paths`，esbuild 配置里也没有 core 的 alias。

**原因未查明，但它直接决定迁移写法**：如果 barrel 实际解析到 `src/`，那深路径也必须指向 `src/`，否则就是 6.1 描述的重复。**这一条必须在动手前查清。**

### 6.3 `vi.mock` 会静默失效

main 上有 **135 个** cli 测试文件写了 `vi.mock('@qwen-code/qwen-code-core', factory)`。一旦被测代码改成深路径导入，这些 mock 就拦不住了——**测试仍然是绿的，但测的东西变了**。

这是整个迁移最大的正确性风险。codemod 必须同步改写这些 mock 的目标，且 lint 规则要一并覆盖。

### 6.4 bundle 体积（可能是意外收益）

`sideEffects` 字段三个 package.json 里都没声明，esbuild 只能保守处理。单符号实验：

| 导入方式 | bundle | 模块数 |
|---|---|---|
| barrel | 15,785 KB | 2336 |
| 深路径 | 41 KB | 55 |

真实 cli 入口本来就用到 core 的大部分，实际收缩幅度**远小于**这个比值，需要在另一台机器上跑完整 `npm run bundle` 前后对比。但方向是好的：bundle 变小 = npm 启动变快。

### 6.5 大规模 diff 的运营成本

871 个源文件的改动会和 200 个 open PR 大面积冲突。建议**按目录分批**（`services/` → `config/` → `ui/` → `serve/` → `acp-integration/`），每批一个 PR，而不是一次性大改。

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
