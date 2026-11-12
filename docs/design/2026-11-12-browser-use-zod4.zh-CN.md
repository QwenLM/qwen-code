# Browser Use 升级到 Zod 4

[English](2026-11-12-browser-use-zod4.md) | [简体中文](2026-11-12-browser-use-zod4.zh-CN.md)

状态：已实现。

## 问题

在 #16452 把仓库其余部分迁移到 Zod 4 之后，`packages/browser-use` 是最后一个仍停留
在 Zod 3 的 workspace 包。保留它是对 #16816 的临时缓解：在 `zod@4.6.6` 下，
`locatorStepsSchema` 对同一个深层 locator plan 的第二次 parse 永不返回，会卡死
Vitest worker，以及后续每一次校验 locator 命令的 `PlaywrightRuntime.dispatch` 调用。

这个保留是有代价的。`build.mjs` 会把依赖打包进 `dist/index.js`，因此已发布的
`@qwen-code/browser-use` 内联了一份 Zod 3.25.76。它声明的唯一运行时依赖是
`playwright-core`，所以使用者的依赖审计看不到这份副本；即使 #16434 已经清理了 SDK 与
Web Shell 的使用者依赖树，GHSA-mrhx-c7xc-m3w5（high，影响 `zod < 4.6.6`）仍然可以通过
已发布产物到达。

## 当前状态

在本次审查的 commit 上，挂起已无法复现。commit `7a38780c` 把 `z.lazy()` 递归边换成了
提前构造的深度链，消除挂起的是这一改动，而不是 schema 重写。

在 `zod@4.6.6` 下实测：通过 `tsx` 在限制为 1 GiB 的子进程中驱动真实的
`locatorStepSchema` 源码：

| 递归边                                            | 32 层 plan 的首次 parse | 第二次 parse            |
| ------------------------------------------------- | ----------------------- | ----------------------- |
| `z.lazy(() => locatorStepSchema(depth + 1))`      | 13 ms，成功             | 永不返回；30 s 时被杀死 |
| 提前构造的 `locatorStepSchema(depth + 1)`（当前） | 6 ms，成功              | 0 ms，成功              |

在当前的提前构造链下，四个递归分支（`and`、`or`、`filter.has`、`filter.hasNot`）均接受
32 层、拒绝 33 层与 1000 层，且重复 parse 返回完全相同的数据。深度在构造期即被限定，
因此超深 plan 会被拒绝而不会产生无界计算。

因此剩下的缺口是版本 pin 本身，以及没有任何结构性约束来固定它。

## 目标

- 把 `packages/browser-use` 迁移到 Zod 4，使打包产物不再内联受公告影响的 Zod。
- 保留所有既有校验行为：深度与广度上限、strict 叶子对象、regex/`exact` 门禁、matcher
  flag 限制，以及 `invalidArguments` 所消费的 `code`/`path`/`message` issue 形状。
- 防止将来根目录的版本变动把本包静默拖回一个递归 schema 会挂起的 Zod 主版本。

## 范围边界

- 不改动 locator schema 的结构。提前构造的深度链已经限定了计算量，上述实测表明递归
  形状本身不是缺陷。
- 不改动 command schema、dispatch 或面向模型的契约。
- 经由 `shadcn`（Web Shell 的 devDependency）及其 `@modelcontextprotocol/sdk` peer
  到达的 `zod@3.25.76` 副本保持原样。它属于开发工具路径而非发布产物，不在本次改动范围内。
- 仓库层的 `uuid` 问题仍由 #10850 / #10985 跟踪。

## 方案

把 `packages/browser-use` 的 `zod` devDependency 从 `^3.25.76` 升到 `^4.6.6`，与其他
已迁移包使用的范围一致，并相应更新 `pnpm-lock.yaml`。

该声明仍保留为 devDependency：`build.mjs` 以 `packages: 'bundle'` 运行 esbuild，Zod 被
内联进 `dist/index.js`，运行时不会从使用者的依赖树解析。把它提升为 `dependencies` 只会
增加一条无用的安装边，并不改变实际交付的内容。

在 `scripts/tests/browser-use-assets.test.js` 中，紧邻已有的 pinned-Playwright 断言处
新增一条断言：要求 manifest 声明 `^4.` 范围，并要求 lockfile 中该 importer 解析出的版本
与之一致、是 4.x 版本，且存在于 lockfile 快照中。

## 设计决策与理由

- **升级范围而非重写 schema。** #16816 建议用非递归或预校验的实现替换递归 schema。实测
  表明提前构造链已在个位数毫秒内完成，并会拒绝越界深度，因此重写只会增加代码而不消除
  任何缺陷。
- **在已有的 manifest/lockfile 测试中断言该 pin。** `nodeLinker` 为 `hoisted`，且 Zod 在
  仓库根目录也有声明，所以本包构建与测试所解析到的副本来自 hoisted 树。仅靠 manifest 里
  的范围无法固定解析出的主版本；该断言把 manifest、importer 解析结果与 lockfile 快照三者
  绑定在一起。这正是 #16816 分诊意见所要求的结构性约束。
- **保留 `z.ZodTypeAny` 与 `z.ZodIssueCode`。** Zod 4 仍通过其兼容层导出两者
  （`ZodTypeAny` 为类型，`ZodIssueCode` 为值），且在 Zod 4 下 `tsc --noEmit` 无需修改源码
  即可通过。改写它们只会扩大 diff 而没有行为收益。

## 约束

- lockfile 必须与各 manifest 保持一致：所有 CI 安装都使用 `--frozen-lockfile`。
- `@agentclientprotocol/sdk>zod` override 已是 `4.6.6`，因此最初阻塞 #16434 的 ACP peer
  锁定不会约束本包。
- 深度上限保持 32 层，每层广度上限保持 32 项。

## 风险

- Zod 4 改变了 issue 文案并新增了 issue 字段。`invalidArguments` 只读取 `code`、`path`
  与 `message`，三者都保留，因此运行时错误载荷保持原有形状，个别文案可能不同。
  因此测试必须断言这个形状，而不是 Zod 的文案：面向模型的参数错误测试原本固定了 Zod 3
  的 `Expected array, received string`，而 Zod 4 输出的是
  `Invalid input: expected array, received string`。该断言现在只校验字段名与期望类型，
  文案交给 Zod。
- 对非常宽的 plan，单节点开销会上升，这在任何校验器上都一样：8 层 × 8 子节点
  （2,097,152 个节点、约 131 MB JSON）的 plan 约 1 s 完成解析。开销随输入体积线性增长，
  并未被 schema 放大，且 32 层深度上限仍会直接拒绝更深的链。

## 验证计划

- 运行本包的完整测试套件：`cd packages/browser-use && npx vitest run`。版本升级会波及
  每一个 schema 使用方，只跑 schema 文件不够：`src/core/errors.test.ts` 断言面向模型的
  错误文本，Zod 主版本差异最先在这里暴露。schema 文件中的两个有界子进程探针，在第二次
  parse 缺陷回归时会快速失败而不是挂起。
- 运行 `npx vitest run --config ./scripts/tests/vitest.config.ts
scripts/tests/browser-use-assets.test.js` 验证新增的 pin 断言，并确认把 manifest 改回
  `^3.25.76` 时它会失败。
- 在 `packages/browser-use` 中运行 `npx tsc --noEmit`。
- 确认 `--frozen-lockfile` 安装成功，且该 importer 解析到 Zod 4。

### 已验证结果

- `packages/browser-use` 完整套件：所有 schema 与 error 文件通过，含 schema 测试中的两个
  子进程探针（`rejected`、`stable`）。重度依赖子进程的 `scripts/smoke-checks.test.ts` 与
  `src/bridge/native-host/index.test.ts` 在高负载的 macOS 本机上会偶发超时（派生嵌套 Node
  时报 `spawnSync ... ETIMEDOUT`），在 Linux CI 通道上通过；两者都不引入 Zod。
- `scripts/tests/browser-use-assets.test.js`：12 项通过。把 manifest 改回 `^3.25.76` 后，
  新断言以 `expected '^3.25.76' to match /^\^4\./` 失败；恢复后重新通过。
- `packages/browser-use` 中 `tsc --noEmit`：无报错。
- `pnpm install --filter @qwen-code/browser-use --frozen-lockfile`：成功；从本包
  `require.resolve('zod/package.json')` 解析到 4.6.6。
- 一份作者本地的行为验证脚本（未提交入库），覆盖深度、广度、strict、regex/`exact` 门禁、
  matcher flags、嵌套往返、每个 command-schema refinement 以及 issue 映射，在
  `zod@3.25.76` 与 `zod@4.6.6` 上结果完全一致。它只是辅助证据；行为不变这一结论可复现的
  依据是本包测试套件，它以入库测试校验同一批契约。
- `node build.mjs` 成功。在生成的 `dist/index.js` 中，Zod 3 的标记
  `invalid_union_discriminator`、`invalid_enum_value`、`ZodParsedType`、`arrayToEnum`
  均已消失，而 Zod 4 的 `$ZodString`、`ZodRealError` 以及该公告对应的 `capSize` 防护均
  存在 —— 发布产物不再内联受公告影响的 Zod。

## 验收标准

- `packages/browser-use` 声明 `zod: ^4.6.6`，且其 lockfile importer 解析到 4.x 版本。
- 本包完整测试套件通过，包含经由四个递归分支对 32 层 plan 的重复 parse。
- pin 断言在 Zod 3 的 manifest 下失败。
- typecheck 通过，且 `--frozen-lockfile` 安装成功。

## 待决问题

- 是否把 `z.lazy()` 第二次 parse 的行为上报给上游 `colinhacks/zod`。仓库内的缓解已经到位，
  本次改动不依赖上游修复。
- `shadcn` 开发路径是否也应移出 Zod 3。这与本次改动所解决的发布产物问题相互独立。
