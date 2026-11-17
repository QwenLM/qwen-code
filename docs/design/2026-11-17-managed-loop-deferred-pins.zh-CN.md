# Managed /loop 延后评审钉子

- 状态：提案
- 日期：2026-11-17
- 关联：[Managed loop skill 资产](2026-11-14-managed-loop-skill-asset.zh-CN.md)（#17272）、[skill E2E CI 接线](2026-11-14-managed-loop-skill-asset.zh-CN.md)（#17433、#17470）、[定时触发 E2E](2026-11-17-managed-loop-fire-e2e.zh-CN.md)（#17506）
- English version: [2026-11-17-managed-loop-deferred-pins.md](2026-11-17-managed-loop-deferred-pins.md)

## 问题陈述

已合入的 managed `/loop` 切片带有在收敛姿态下记为延后的评审发现——已确认、但当轮未修。其中六条在当前 main 上复验仍成立，且是小而自包含的加固修复。本 PR 恰好关闭这六条；其余延后 backlog（设计文档陈旧声明、Java 死分支、child-catalog 代码缺口、其它探针）留作单独跟进。

## 六项修复

1. **假模型 minted-id 提取钉子（#17470）。** 把 clear 腿钉子改指断言侧 `createdScheduleId` 后，假模型自身的 `createdId` 提取（delete 夹具的 id 来源）失去钉子。补元测试钉子：fake 侧 `const createdId = /asch_…/.exec(createResultText)` 及其结构化 `tool_call_id === 'loop-cron-create'` 过滤，使伪造或子串提取使快速套件红。
2. **分类器收窄可执行见证（#17470）。** block-schema 收窄仅以文本钉住（`'shouldBlock' in blockProperties`）；对任意 `respond_in_schema` 查询都答 `shouldBlock:false` 的 additive fallback 会重新造成对无关侧查询（title、tool-use summary、next speaker）的误答且保持绿。把判定提取为顶层纯函数 `classifierBlockAnswer(blockProperties)`（block schema 返回按阶段精确的答案，否则 `undefined`），skill 与 fire 两个 fake 都用它，并在元测试中对 block（阶段 1/2）与非 block schema 执行它。additive-fallback 变异使非 block 方向红。
3. **哨兵 allow-list（#17272）。** union/wakeup 哨兵守卫原是两个已知非展开形（`<<loop.md>>`、`<<autonomous-loop>>`）的 deny-list，新增哨兵会漏网。反转为 allow-list：body 只可携带 wakeup 展开的 `<<loop.md-dynamic>>` / `<<autonomous-loop-dynamic>>` 形（cron：无）。提取为纯函数 `assertSentinelsExpanded(body, profile)` 并对带全新哨兵的敌意 body 执行。
4. **`Nd` cron 语义（#17272）。** 间隔表声称 `0 0 */N * *` 意为「每 N 天」；实为月内日期步进（days 1, 1+N, … 每月月初重置），非滚动 N 天节奏。修正 bundled SKILL.md 表行并加月界重置 caveat；更新生成器的 managed 替换为准确 UTC 措辞；重生 sidecar。
5. **Parsing 规则库存钉子（#17272）。** drift guard 检查 source→body 覆盖，故从 bundled source 删除一条规则对它不可见。补 parity 测试钉住精确 Parsing 规则库存（`Empty input`、`Leading interval token`、`Trailing "every" clause`、`Prompt-only input`），使删除红。
6. **单一来源 profile 集合（#17272）。** profile 列表 `['union', 'cron', 'wakeup']` 在六个测试循环里手工维护。导出 `MANAGED_LOOP_PROFILES` 为单一来源，由其派生 `ManagedLoopProfile`，替换手工 full-list；`Record<ManagedLoopProfile, …>` 资产映射与 parity `it.each` 现强制覆盖每个 profile，增删 profile 不会漂移。

## 设计决策

- **可执行守卫优于文本钉。** 修复 2、3 遵循既有模式（assertCallerImportReplaced、assertScheduledFireWitness）：顶层纯声明，元测试加载并执行，剪断或漂移守卫使断言红而非仅文本匹配失败。
- **allow-list 而非 deny-list。** 修复 3 对任何未知哨兵失败关闭；两个展开形是 Managed body 可教的封闭集合。
- **内容修复经生成器流转。** 修复 4 同时改 bundled source 与生成器替换并重生已提交 sidecar，使逐字节 parity 测试仍是 oracle；不手改 sidecar。
- **无生产运行时改动。** managed-loop-skill.ts 仅 generator/test（无运行时 import）；运行中 Session 读的唯一产物是 sidecar JSON，构建时拷贝到 Java classpath。分类器 helper 住在 E2E runner 的假模型，不在 shipped CLI。

## 涉及文件

| 文件                                                                                            | 变更                                                                          |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.ts`                                   | MANAGED_LOOP_PROFILES + 派生类型；Nd 替换；assertSentinelsExpanded allow-list |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.test.ts`                              | profile 单一来源；Parsing 库存钉；哨兵 allow-list 可执行测试                  |
| `packages/core/src/skills/bundled/loop/SKILL.md`                                                | Nd 表行 + 月界 caveat                                                         |
| `packages/core/src/managed-runtime/contracts/managed-loop-skill-{cron,union,bundled-body}.json` | 重生                                                                          |
| `scripts/run-managed-agent-server-e2e.ts`                                                       | classifierBlockAnswer + mintedScheduleId helper；两个 fake 都用它们           |
| `scripts/tests/managed-agent-server-e2e.test.js`                                                | fake createdId 钉；分类器 + minted-id 可执行测试；answer/标识符库存钉         |

## 范围边界

仅六条点名延后项。其余约 64 条延后条目（文档陈旧声明、Java 死分支、child-catalog 缺口、其它探针）范围外，需各自对当前 code triage。无 Java 源码改动；无新 CI 臂。

## 验收标准

- core parity 套件绿（32 测试），含库存、allow-list、调用点、sidecar 集合、Java 服务集合与 caveat 钉及重生 sidecar 逐字节 parity。
- scripts 元套件绿（182 测试），含 fake createdId 钉、可执行分类器收窄与可执行 minted-id 提取。
- 变异见证：additive-fallback 分类器变异使非 block 方向红；deny-list 哨兵回退使新哨兵方向红；伪造 fake createdId 使其钉红；删除 Parsing 规则使库存钉红；调用点之后的 sibling fallback 使 answer 字面量库存钉红。各字节级还原复绿。
- 真实打包栈 `--loop-skill` 与 `--loop-fire` 臂以重生 sidecar 绿（jar 重建）。

## Round-1 评审精化

首轮评审对六项修复做了二阶漂移加固（各以「使新断言红、还原复绿」的变异见证）：

- **caveat 准确 + 钉（R1-1）。** 月界间隔是*至多* N 天（月长为 N 整数倍时恰为 N），非严格更短；caveat 改为「至多 N 天且常常更短」并写明 N ≤ 30 上限（步长 31 已只收集 day 1，因 1+31 超过日期字段最大值）。parity 钉要求 cron 与 union body 含修正措辞，删除或改写 caveat 即红。
- **生成器单一来源（R1-2）。** regenerator 从 `MANAGED_LOOP_PROFILES` 派生目标（文件名 `managed-loop-skill-<profile>.json`），parity 断言要求已提交 sidecar 集合（排除 `bundled-body`）等于声明 profile 集合——多余或孤儿 sidecar 即红。
- **守卫取 runtime 常量（R1-3）。** `EXPANDING_SENTINELS` 由 `LOOP_SENTINEL_DYNAMIC` / `AUTONOMOUS_SENTINEL_DYNAMIC`（wakeup fire 实际展开的常量）构造，runtime 改名使 parity 构建红，而非静默放行没人展开的 token。body 模板与 SKILL.md 散文保留字面量；守卫对任何偏离常量的漂移失败关闭。
- **调用点钉（R1-4）。** build 级测试向 Input 节（逐字进入每个 profile）注入全新哨兵，要求 `buildManagedLoopSkill` 拒绝，使「内联 deny-list 回 build 但保留导出」红。
- **语句锚定计数钉（R1-5、R1-6）。** classifier 与 fake-createdId 调用点钉计数两臂（`toHaveLength(2)`），锚定完整语句（尾 `;` / `?.[0];`），使任一臂追加 `?? { shouldBlock: false }` fallback 或伪造 id 破坏匹配；两臂各自的 create-call 过滤（`loop-cron-create` / `loop-fire-create`）分别钉住。

## Round-2 评审精化

第二轮抓到一个修复引入的 critical 与四个二阶缺口（各见证）：

- **N ≤ 30 而非 N ≤ 31（round-2 critical）。** `0 0 */31 * *` 本就只匹配 day 1（步长从 day 1 起，1+31 超字段最大值），故 N = 31 正是退化本身而非最后安全值；仍匹配多天的最后一步是 `*/30`（`{1,31}`）。caveat、parity 钉与两版设计文档均改 N ≤ 30；改回 N ≤ 31 使钉红。
- **Java 服务集合钉（R2-1）。** profile 单一来源跨过 TypeScript 边界：parity 断言读 `ManagedLoopSkill.java` 的 `sidecars()` 键，要求（去掉仅来源比对的 `bundled` 键）等于 `MANAGED_LOOP_PROFILES`，使「加进 tuple 但 Java map 缺失」（会静默不提供 /loop skill）红。
- **可执行 minted-id helper（R2-2）。** fake 侧提取合并为顶层纯函数 `mintedScheduleId(messages, createCallId)`（返回 `undefined`，绝不编造 id），两臂共用并在元测试对敌意历史执行；仅源码拼写计数会漏掉伪造 `?? 'asch_' + '0'.repeat(32)` fallback 且挡住合并。调用点与显式失败 `?? 'missing-schedule-id'` fallback 上钉。
- **classifier 门钉（R2-3）。** 对 `if (blockAnswer !== undefined) {`（两臂）计数钉，堵住「门改宽」（`if (blockProperties !== undefined)` + `blockAnswer ?? {…}`）——该拼写在赋值计数仍为 2 时复活误答。
- **替换单元钉（R2-4）。** managed Nd 修复的 `sub()` 替换串上钉（`midnight UTC on days 1, 1+N, … of each month`、`not.toContain('every N days')`）加示例间隔，使回退替换串并重生不能在全绿下重新教「every N days」。

## 验证报告跟进

独立 `/verify-pr` 轮在首个精化 head 上报了两条发现与一条 nit，三者均在此关闭：

- **N ≤ 31 多算一档（low）。** 与第二轮评审抓到的 critical 同一缺陷；由上文 N ≤ 30 修正关闭。
- **调用点之后的 sibling fallback（覆盖缺口）。** 语句锚定计数钉看不到写在门*之后*的 fallback（`if (blockAnswer === undefined) return …allow…`）：两个计数仍为 2，而 fire fake 重新误答侧查询，只在打包臂可见。改用两条「数成分而非数语句」的库存钉关闭——block allow 字面量 `shouldBlock: false` 只在 `classifierBlockAnswer` 内构造（计数 1），每臂恰好引用 `blockAnswer` 三次：声明 / 门 / answer（计数 6）。三路见证：报告点名的门后 sibling 与 usage 行 `?? { shouldBlock: false }` fallback 各使字面量库存红；经 helper 重新推导 allow（不新增字面量）的 sibling 只使标识符库存红，故两条钉都不空转。helper 前置注释不再拼写该字面量，使库存计数无歧义。
- **parity 计数陈旧（nit）。** PR 正文与上文验收标准改为当前套件规模（core 32、scripts 元 182）与最新真实栈 occurrence key。

## 开放问题

无阻塞项。
