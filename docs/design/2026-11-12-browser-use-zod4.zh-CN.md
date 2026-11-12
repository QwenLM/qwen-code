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

这个代价不只是「存在一个被公告标记的版本」。Zod 3 会在报告 `.max()` 失败之前先校验数组的
每一个元素，因此一个超限参数即使被 schema 拒绝，也已经做了与攻击者输入规模成正比的工作。
Zod 4.6.6 的 `capSize` 先让前置的 size 检查失败，不解析任何元素就返回。用本包自己的
schema 实测，同一棵树、只替换解析到的 Zod，且每个元素都非法：

| 超限参数                                | Zod 3.25.76                  | Zod 4.6.6        |
| --------------------------------------- | ---------------------------- | ---------------- |
| `cua.keypress`，200,000 个 keys         | 66 ms，200,001 条 issue      | 1 ms，1 条 issue |
| `locatorStepsSchema`，200,000 个 step   | 245 ms，200,001 条 issue     | 1 ms，1 条 issue |
| `cua.keypress`，3,000,000 个 keys       | 1,091 ms，3,000,001 条 issue | 1 ms，1 条 issue |
| `locatorStepsSchema`，3,000,000 个 step | 5,245 ms，3,000,001 条 issue | 1 ms，1 条 issue |

这些 schema 里的每个数组都有长度约束（`locatorStepsSchema` 与 `keyNames` 为 `.max(32)`，
`optionalKeyNames` 为 `.max(8)`，拖拽 `path` 为 `.max(512)`，`queries` 为 `.max(20)`），
这正是 `capSize` 生效的前提 —— 所以该修复覆盖这里每一个取数组的命令参数。两个版本都会拒绝
上述全部输入，而 `invalidArguments` 只保留前三条 issue，因此另外三百万条是被构造出来又丢掉
的。`PlaywrightRuntime.dispatch` 对拿到的任何输入调用 `schema.parse`，所以这条路径可由一个
畸形命令到达，而不只是合成基准测试。

关于公告本身要说清一点：GHSA-mrhx-c7xc-m3w5 描述的是**没有**长度约束的数组，而在 2,000,000
个元素时，无约束的 `z.array(z.string())` 在 4.6.6 上仍会累积 2,000,000 条 issue（577 ms，
RSS +631 MB），与 3.25.76 的表现相近（1,067 ms，+589 MB）。所以 4.6.6 并没有让无界数组变
安全，本包也不是仅靠版本就得到保护 —— 它得到保护是因为它接受的每个数组都有界。这里可测量的
收益，是本包实际使用的有界数组上的提前退出，外加从已发布产物中移除被标记的版本。

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
- 同时获得随之而来的前置 size 拒绝，让一个超限的数组型命令参数只付出一条 issue 的代价，
  而不是每个元素一条。
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
  | 总字节数        | 312,578            | 947,236             |
  | 其中 Zod 占比   | 120,808 / 9 个文件 | 751,128 / 95 个文件 |

  即增加 634,658 B（约 620 KB，3.03 倍），其中 630,320 B 来自 Zod 本身。产出的运行时有
  一半是本包从不执行的代码：

  | 本包从不调用                   | 产物中的字节数 | 占比 |
  | ------------------------------ | -------------- | ---- |
  | 全部 64 个 `v4/locales/*` 翻译 | 366,095        | 39%  |
  | `compile` + JSON-Schema 转换   | 129,361        | 14%  |

  转换这一行涵盖实现它的全部六个输入：`core/compile.js` 58,860、
  `core/json-schema-processors.js` 25,437、`classic/from-json-schema.js` 25,333、
  `core/to-json-schema.js` 17,389、`core/json-schema-generator.js` 2,312，以及
  `core/json-schema.js` 30。只统计前三个会少算 19,731 B。

  有三个测量细节决定这些数字能否复现。总字节数是 `build.mjs` 实际产出的产物，探针传入
  同一个 kernel banner，因此 metafile 自身的 `outputs[...].bytes` 等于磁盘上的文件大小；
  不加 banner 会让两侧各少报 138 B，而差值不变。上面的占比以该总数为分母。

  其次，要替换解析到的包，而不是让 esbuild 指向一个目录。`alias` 会绕过 `exports`，
  因此把 Zod 3 的包根目录作为 alias 会选中它的 CommonJS 构建，报出 343,689 B、其中 Zod
  为 150,830 B / 10 个文件 —— 那不是同源对照。把它的 ESM 入口（`zod/index.js`）作为 alias
  能拿到正确的 Zod 占比，但仍产出 312,882 B，因为 alias 同时改变了无关输入的解析方式。
  就地替换 `node_modules/zod` 是唯一只测量版本变化本身的路径：312,578 B 对 947,236 B。

  第三，构建必须在 `packages/browser-use/node_modules` 已安装的树中进行。缺少它时
  esbuild 对部分非 Zod 输入的解析不同，两侧都会多报约 7 KB —— 本节先前一版得到 954,646
  就是这个原因。两种情况下 Zod 自身的占比完全相同。

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

- 用 CI 所用的参数运行本包完整套件：`cd packages/browser-use &&
RUNNER_NAME=ecs-qwen-local npx vitest run --retry=2 --maxWorkers=2`。它会收集
  `src/core/schemas.test.ts`（含两个有界子进程探针，若第二次 parse 的缺陷回归会
  快速失败而不是挂起）与 `src/core/errors.test.ts`（面向模型的参数错误契约）。若希望那
  3 个 `runtime-kernel` 用例真正运行而不是跳过，请先构建 `packages/node-repl`。裸的
  `npx vitest run` 会让三个重度依赖子进程的文件停在 Vitest 的 5 s 默认值上，并报出与本次
  改动无关的失败；详见「已验证结果」。
- 运行 `npx vitest run --config ./scripts/tests/vitest.config.ts
scripts/tests/browser-use-assets.test.js` 验证新增的 pin 断言，并确认把 manifest 改回
  `^3.25.76` 时它会失败。
- 在 `packages/browser-use` 中运行 `npx tsc --noEmit`。
- 确认 `--frozen-lockfile` 安装成功，且该 importer 解析到 Zod 4。
- 若要复测「风险」段的体积代价，可用 `metafile: true` 以及与 `build.mjs` 相同的选项
  （`packages: 'bundle'`、`external: ['playwright-core', 'playwright-core/*']`、
  `target: 'node22'`、`format: 'esm'`，以及它的 kernel banner）构建该入口，且所在树的
  `packages/browser-use/node_modules` 已安装；再对 metafile 中位于 `node_modules/zod/`
  下的输入累加 `bytesInOutput`。Zod 3 一侧要把 `node_modules/zod` 替换成该版本后重新
  构建 —— 不要用 esbuild `alias`。alias 指向包目录会绕过 `exports` 而选到 CommonJS
  构建；alias 指向它的 ESM 入口能修正 Zod 占比，但仍会挪动无关输入。测完后要恢复
  4.6.6 那一份，因为本包套件与防护都会读取解析到的版本。

### 已验证结果

- 按 CI 自身参数运行 `packages/browser-use` 套件：26 个文件、612 项通过（共 612），
  含两个子进程探针（`rejected`、`stable`）、`errors.test.ts` 全部 9 项，以及通过真实
  node_repl kernel 加载产出的 `dist/index.js` 的 3 个 `runtime-kernel` 用例。CI 以两个
  shard 运行同一套件；shard 1/2 为 13 个文件、310 项通过（共 310），shard 2/2 为 13 个
  文件、302 项通过（共 302）—— 两者合计 612。
- **要复现它需要 CI 的参数，而不是那条裸命令。** 本套件会 spawn 子进程与 Unix socket
  服务端，其中三个文件的用量足以在高负载机器上超过 Vitest 的 5 s 默认值。本包的
  `vitest.config.ts` 只在 `RUNNER_NAME` 以 `ecs-qwen-` 开头时把 `testTimeout` 提到 60 s，
  而 CI 还额外传入 `--retry=2`，并把 side lane 的 worker 数限制为 4 的一半。因此可复现的
  调用方式是 `RUNNER_NAME=ecs-qwen-local npx vitest run --retry=2 --maxWorkers=2`。
  在同一棵树上跑裸的 `npx vitest run` 会得到 2 失败 / 607 通过 / 3 跳过，失败来自
  `scripts/smoke-checks.test.ts`（它自己的 `spawnSync` 预算是 20 s，是所在用例超时的
  四倍）、`src/bridge/native-host/index.test.ts` 与 `src/bridge/discovery.test.ts`。
  这三个文件都不引入 Zod，都与 `main` 无差异，且在上述调用方式下全部通过 —— 这是本套件
  在高负载机器上早已存在的性质，不是本次升级引入的。之所以记在这里：本 PR 第一轮把同样
  这些失败报为「主机负载」却没点明机制，让照着文档命令跑的评审拿到一个红套件而无从解释。
- 未构建 `packages/node-repl` 与 `packages/browser-use` 的 worktree 会跳过 3 个
  `src/runtime-kernel.test.ts` 用例（609 项通过、3 项跳过，共 612）；CI 会构建这两个包，
  因此全部 612 项都会运行。本地只构建 `packages/node-repl` 就足以让它们不再跳过，因为
  `packages/browser-use/dist` 由体积测量所用的同一个 `node build.mjs` 产出。
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
- 前置 size 拒绝是用本包自己的 schema 实测的，而不是合成 schema：`cua.keypress` 传入
  3,000,000 个非法 key、`locatorStepsSchema` 传入 3,000,000 个非法 step，在 Zod 4.6.6 上
  各自 1 ms 返回 1 条 issue；在 Zod 3.25.76 上则分别是 1,091 ms 与 5,245 ms、各
  3,000,001 条 issue。两者都拒绝该输入，差别在于拒绝之前做了多少工作。复现方式：就地替换
  `node_modules/zod`，通过 `tsx` 驱动 `commandSchemas` / `locatorStepsSchema`，测完后
  恢复 4.6.6。

## 验收标准

- `packages/browser-use` 声明 `zod: ^4.6.6`，且其 lockfile importer 解析到 4.x 版本。
- schema 测试通过，包含经由四个递归分支对 32 层 plan 的重复 parse。
- pin 断言在 Zod 3 的 manifest 下失败。
- typecheck 通过，且 `--frozen-lockfile` 安装成功。

## 待决问题

- 是否把 `z.lazy()` 第二次 parse 的行为上报给上游 `colinhacks/zod`。仓库内的缓解已经到位，
  本次改动不依赖上游修复。
- `shadcn` 开发路径是否也应移出 Zod 3。这与本次改动所解决的发布产物问题相互独立。
- 本包从不执行的那约 484 KB 打包 Zod（64 个 locale 以及 compile/JSON-Schema 路径）
  是否值得回收，以及用什么机制。任何方案都必须保留公开入口，而不是深导入 Zod 内部
  路径，且需要自己的测量。
