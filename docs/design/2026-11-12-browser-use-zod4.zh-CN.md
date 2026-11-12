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
- 不改动 command schema 与 dispatch。面向模型的错误载荷仍保持 `code`、`path`、
  `message` 三个键，但 `code` 的取值随 Zod 4 改名（见「风险」段），因此按
  `details.issues[].code` 分支的消费者需要相应适配。
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
新增一条断言：要求 manifest 声明 `^4.` 范围且其下界不低于 `4.6.6`（修复
GHSA-mrhx-c7xc-m3w5 的版本），并要求 lockfile 中该 importer 解析出的版本与之一致、
是 4.x 版本、存在于 lockfile 快照中，且解析结果不低于 `4.6.6`。

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

- Zod 4 改变了 issue 文案、新增了 issue 字段，并重命名了 issue code。
  `invalidArguments`（`src/core/errors.ts`）原样透传 `issue.code`、`issue.path`
  与 `issue.message`，因此载荷仍是三字段形状，但 `code` 的**取值**随库变化：
  `invalid_string` → `invalid_format`，`invalid_enum_value` 与
  `invalid_literal` → `invalid_value`，`invalid_union_discriminator` →
  `invalid_union`。本包的 command schema 能触达上述全部被改名的族：畸形的
  `dom_cua.*` snapshot ref 报 `invalid_format`，非法的 `button`/`modifiers` 选项报
  `invalid_value`，未知的 locator step `kind` 报 `invalid_union`——因此任何按
  `details.issues[].code` 分支的消费者都必须跟上新名字。本仓库没有这样的消费者：
  `invalidArguments` 只做字段映射，本包唯一的 code 字面量是 `errors.test.ts` 中对
  `invalid_type` 的断言，而 Zod 4 保留该 code。文案同样会变，这也是该测试改为从
  error 里读取句子、而不是复述的原因。
- 对非常宽的 plan，单节点开销会上升，这在任何校验器上都一样：8 层 × 8 子节点
  （2,097,152 个节点、约 131 MB JSON）的 plan 约 1 s 完成解析。开销随输入体积线性增长，
  并未被 schema 放大，且 32 层深度上限仍会直接拒绝更深的链。
- 打包后的运行时体积约增至三倍。同一棵源码树、同样的 esbuild 配置，只替换解析到的
  Zod，用 esbuild metafile 测量：

  | `dist/index.js` | Zod 3.25.76        | Zod 4.6.6           |
  | --------------- | ------------------ | ------------------- |
  | 总字节数        | 312,690            | 954,646             |
  | 其中 Zod 占比   | 120,808 / 9 个文件 | 751,128 / 95 个文件 |

  即增加 641,956 B（约 627 KB），其中 630,320 B 来自 Zod 本身。产出的运行时有一半是
  本包从不执行的代码：

  | 本包从不调用                   | 产物中的字节数 | 占比 |
  | ------------------------------ | -------------- | ---- |
  | 全部 64 个 `v4/locales/*` 翻译 | 366,095        | 38%  |
  | `compile` + JSON-Schema 转换   | 109,630        | 11%  |

  其中 locale 占主导，而它们之所以没被 tree-shaking 去掉，是因为
  `zod/v4/classic/external.js` 末尾有 `export * as locales from
"../locales/index.js"` —— namespace re-export 的成员无法被逐个剔除。同一个 barrel
  也无条件 re-export 了 `compile`、`toJSONSchema` 与 `fromJSONSchema`。Zod 3 只内联一份
  英文 locale，所以这整类开销是随该主版本新增的。

  在产出文件里搜索非英文文案会一无所获，而这个判据是误导性的：esbuild 把这些字符串写成
  `\uXXXX` 转义，因此文件里只有 5 个非 ASCII 字符，却携带了每一份翻译。真正能显示这项
  开销的是 metafile 中每个输入文件的 `bytesInOutput`。

  没有任何门禁约束该产物体积（资源拷贝路径没有字节上限，防护文件里也没有体积断言），
  因此代价是随打包 skill 运行时交付的下载与加载体积，而不是硬限制。裁剪不在本次范围内：
  换更窄的入口并不能去掉上述任一类；要去掉就得深导入内部路径或加 esbuild alias，那是用
  「钉住公开入口」换「依赖私有入口」。这是需要独立测量的另一个决策，而其替代方案是继续
  交付受公告影响的 Zod。

## 验证计划

- 运行本包的完整套件：`cd packages/browser-use && npx vitest run`。它会收集
  `src/core/schemas.test.ts`（含两个有界子进程探针，若第二次 parse 的缺陷回归会
  快速失败而不是挂起）与 `src/core/errors.test.ts`（面向模型的参数错误契约）。
- 运行 `npx vitest run --config ./scripts/tests/vitest.config.ts
scripts/tests/browser-use-assets.test.js` 验证新增的 pin 断言，并确认把 manifest 改回
  `^3.25.76` 时它会失败。
- 在 `packages/browser-use` 中运行 `npx tsc --noEmit`。
- 确认 `--frozen-lockfile` 安装成功，且该 importer 解析到 Zod 4。
- 若要复测「风险」段的体积代价，可用 `metafile: true` 以及与 `build.mjs` 相同的选项
  （`packages: 'bundle'`、`external: ['playwright-core', 'playwright-core/*']`、
  `target: 'node22'`、`format: 'esm'`）构建该入口，再对 metafile 中位于
  `node_modules/zod/` 下的输入累加 `bytesInOutput`。Zod 3 一侧同样要经由它的 ESM 入口
  （`zod/index.js`）解析：用 esbuild `alias` 指向包目录会绕过 `exports` 而选到 CommonJS
  构建，那不是对等口径的对照。

### 已验证结果

- `packages/browser-use` 套件（`npx vitest run`）：26 个文件、612 项通过（共 612），
  含两个子进程探针（`rejected`、`stable`）与 `errors.test.ts` 全部 9 项。
  CI 以两个 shard 运行同一套件；shard 2/2 为 13 个文件、302 项通过（共 302）。
- 未构建 `packages/node-repl` 与 `packages/browser-use` 的 worktree 会跳过 3 个
  `src/runtime-kernel.test.ts` 用例（609 项通过、3 项跳过，共 612）；CI 会构建这两个包，
  因此全部 612 项都会运行。
- `scripts/tests/browser-use-assets.test.js`：12 项通过。把 manifest 改回 `^3.25.76` 后，
  断言以 `expected '^3.25.76' to match /^\^4\./` 失败；声明 `^4.0.0` 且解析到 `4.0.0` 时
  在 `4.6.6` 下限上以 `expected false to be true` 失败；两者恢复后重新通过。
- `packages/browser-use` 中 `tsc --noEmit`：无报错。
- `pnpm install --filter @qwen-code/browser-use --frozen-lockfile`：成功；从本包
  `require.resolve('zod/package.json')` 解析到 4.6.6。
- 一份 106 条断言的行为验证脚本，由作者在本地运行、不在本仓库中，评审无法复跑。它覆盖
  深度、广度、strict、regex/`exact` 门禁、matcher flags、嵌套往返以及每个
  command-schema refinement，其「通过/拒绝」判定在 `zod@3.25.76` 与 `zod@4.6.6` 上
  一致。issue 映射并不一致：可触达的 `code` 取值按「风险」段所述已改名，这是已记录的
  契约变更，而非行为保持不变的证据。该脚本只作为它所覆盖的校验语义的支撑性证据，不应
  视为行为不变的笼统结论。
- `node build.mjs` 成功。在生成的 `dist/index.js` 中，Zod 3 的标记
  `invalid_union_discriminator`、`invalid_enum_value`、`ZodParsedType`、`arrayToEnum`
  均已消失，而 Zod 4 的 `$ZodString`、`ZodRealError` 以及该公告对应的 `capSize` 防护均
  存在 —— 发布产物不再内联受公告影响的 Zod。

## 验收标准

- `packages/browser-use` 声明 `zod: ^4.6.6`，且其 lockfile importer 解析到 4.x 版本。
- schema 测试通过，包含经由四个递归分支对 32 层 plan 的重复 parse。
- pin 断言在 Zod 3 的 manifest 下失败。
- typecheck 通过，且 `--frozen-lockfile` 安装成功。

## 待决问题

- 是否把 `z.lazy()` 第二次 parse 的行为上报给上游 `colinhacks/zod`。仓库内的缓解已经到位，
  本次改动不依赖上游修复。
- `shadcn` 开发路径是否也应移出 Zod 3。这与本次改动所解决的发布产物问题相互独立。
- 本包从不执行的那约 465 KB 打包 Zod（64 个 locale 以及 compile/JSON-Schema 路径）
  是否值得回收，以及用什么机制。任何方案都必须保留公开入口，而不是深导入 Zod 内部
  路径，且需要自己的测量。
