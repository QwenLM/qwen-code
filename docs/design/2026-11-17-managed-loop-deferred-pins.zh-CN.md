# Managed /loop 延后评审钉子

- 状态：提案
- 日期：2026-11-17
- 关联：[Managed loop skill 资产](2026-11-14-managed-loop-skill-asset.zh-CN.md)（#17272）、[skill E2E CI 接线](2026-11-14-managed-loop-skill-asset.zh-CN.md)（#17433、#17470）、[定时触发 E2E](2026-11-17-managed-loop-fire-e2e.zh-CN.md)（#17506）
- English version: [2026-11-17-managed-loop-deferred-pins.md](2026-11-17-managed-loop-deferred-pins.md)

## 问题陈述

已合入的 managed `/loop` 切片带有在收敛姿态下记为延后的评审发现——已确认、但当轮未修。其中六条在当前 main 上复验仍成立，且是小而自包含的加固修复。本 PR 恰好关闭这六条；其余延后 backlog（设计文档陈旧声明、Java 死分支、child-catalog 代码缺口、其它探针）留作单独跟进。

## 六项修复

1. **假模型 minted-id 提取钉子（#17470）。** 把 clear 腿钉子改指断言侧 `createdScheduleId` 后，假模型自身的 id 提取（delete 夹具的 id 来源）失去钉子。该提取现为顶层纯函数 `mintedScheduleId(messages, createCallId)`——按结构化 `tool_call_id` 过滤 tool 结果，返回 `undefined` 而非编造 id——两个 fake 共用并在元测试对敌意历史执行，另钉两处调用点与显式失败 `?? 'missing-schedule-id'` fallback，使伪造 id、丢弃 call-id 过滤或子串匹配使快速套件红。（Round 2 把原先的内联正则＋过滤合并为该 helper；见 Round-2。）
2. **分类器收窄可执行见证（#17470）。** block-schema 收窄仅以文本钉住（`'shouldBlock' in blockProperties`）；对任意 `respond_in_schema` 查询都答 `shouldBlock:false` 的 additive fallback 会重新造成对无关侧查询（title、tool-use summary、next speaker）的误答且保持绿。把判定提取为顶层纯函数 `classifierBlockAnswer(blockProperties)`（block schema 返回按阶段精确的答案，否则 `undefined`），skill 与 fire 两个 fake 都用它，并在元测试中对 block（阶段 1/2）与非 block schema 执行它。additive-fallback 变异使非 block 方向红。
3. **哨兵 allow-list（#17272）。** union/wakeup 哨兵守卫原是两个已知非展开形（`<<loop.md>>`、`<<autonomous-loop>>`）的 deny-list，新增哨兵会漏网。反转为 allow-list：body 只可携带 wakeup 展开的 `<<loop.md-dynamic>>` / `<<autonomous-loop-dynamic>>` 形（cron：无）。提取为纯函数 `assertSentinelsExpanded(body, profile)` 并对带全新哨兵的敌意 body 执行。
4. **`Nd` cron 语义（#17272）。** 间隔表声称 `0 0 */N * *` 意为「每 N 天」；实为月内日期步进（days 1, 1+N, … 每月月初重置），非滚动 N 天节奏。修正 bundled SKILL.md 表行并加月界重置 caveat；更新生成器的 managed 替换为准确 UTC 措辞；重生 sidecar。
5. **Parsing 规则库存钉子（#17272）。** drift guard 检查 source→body 覆盖，故从 bundled source 删除一条规则对它不可见。补 parity 测试钉住精确 Parsing 规则库存（`Empty input`、`Leading interval token`、`Trailing "every" clause`、`Prompt-only input`），使删除红。
6. **单一来源 profile 集合（#17272）。** profile 列表 `['union', 'cron', 'wakeup']` 在六个测试循环里手工维护。导出 `MANAGED_LOOP_PROFILES` 为单一来源，由其派生 `ManagedLoopProfile`，替换手工 full-list；`Record<ManagedLoopProfile, …>` 资产映射与 parity `it.each` 现强制覆盖每个 profile，增删 profile 不会漂移。

## 设计决策

- **可执行守卫优于文本钉。** 修复 2、3 遵循既有模式（assertCallerImportReplaced、assertScheduledFireWitness）：顶层纯声明，元测试加载并执行，剪断或漂移守卫使断言红而非仅文本匹配失败。
- **allow-list 而非 deny-list。** 修复 3 对任何未知哨兵失败关闭；两个展开形是 Managed body 可教的封闭集合。
- **内容修复经生成器流转。** 修复 4 同时改 bundled source 与生成器替换并重生已提交 sidecar，使逐字节 parity 测试仍是 oracle；不手改 sidecar。
- **无运行时*代码*改动；模型面向的 skill 内容确有改动。** 没有运行时模块 import managed-loop-skill.ts——其消费方只有 regenerator 与它自己的测试——分类器 helper 住在 E2E runner 的假模型，不在 shipped 代码里。但 `Nd` 修复改了 bundled `SKILL.md`，该文件随构建发布并由 `SkillManager` 的 bundled 层在运行时发现并解析（`dist/bundled/loop/SKILL.md`，由 `copy_bundle_assets.js` 填充），故模型看到的本地 `/loop` 指引确实变了（这正是预期的正确性修复），Managed sidecar JSON（构建时拷贝到 Java classpath）亦然。本 PR 给 managed-loop-skill.ts 新增的两个 import（`LOOP_SENTINEL_DYNAMIC`、`AUTONOMOUS_SENTINEL_DYNAMIC`）是 allow-list 取源的哨兵常量，并不使生成器成为运行时模块。

## 涉及文件

| 文件                                                                                            | 变更                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.ts`                                   | MANAGED_LOOP_PROFILES + 派生类型；Nd 替换；assertSentinelsExpanded allow-list                                            |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.test.ts`                              | profile 单一来源；Parsing 库存；allow-list 测试；槽编译器派生 Nd caveat；Java 提供集合＋first-match profile→key 路由映射 |
| `packages/core/src/skills/bundled/loop/regenerate-managed-loop-assets.ts`                       | 目标从 MANAGED_LOOP_PROFILES 派生，替代手工 tuple                                                                        |
| `packages/core/src/skills/bundled/loop/SKILL.md`                                                | Nd 表行 + 月界 caveat                                                                                                    |
| `packages/core/src/managed-runtime/contracts/managed-loop-skill-{cron,union,bundled-body}.json` | 重生                                                                                                                     |
| `scripts/run-managed-agent-server-e2e.ts`                                                       | classifierBlockAnswer + mintedScheduleId helper；两个 fake 都用它们                                                      |
| `scripts/tests/managed-agent-server-e2e.test.js`                                                | fake createdId 钉；分类器 + minted-id 可执行测试；AST 分类器接线钉                                                       |

## 范围边界

仅六条点名延后项。其余约 64 条延后条目（文档陈旧声明、Java 死分支、child-catalog 缺口、其它探针）范围外，需各自对当前 code triage。无 Java 源码改动；无新 CI 臂。

## 验收标准

- core parity 套件绿（35 测试），含 bundled 与各 shell 的 Parsing 库存、allow-list 与调用点测试、sidecar 集合钉、Java 提供集合与 profile→key 路由映射、解析器派生的 caveat 子句、双求值器一致性，及重生 sidecar 逐字节 parity。
- scripts 元套件绿（185 测试：改动的 `managed-agent-server-e2e.test.js` 89 条，加 `hosted-process-ci.test.js` 96 条），含 fake createdId 钉、可执行分类器收窄、可执行 minted-id 提取与被执行的分类器接线扫描器。
- 变异见证：additive-fallback 分类器变异使非 block 方向红；deny-list 哨兵回退使新哨兵方向红；伪造 fake createdId 使其钉红；删除 Parsing 规则使库存钉红；门后 sibling fallback（第二绑定、换 call id 或手搭 tool call）使分类器接线钉红；`let` 决策在门后重赋值为内联 allow 使构造点集合红；对决策的 `??=` 改写使重赋值集合红；伪造 schema-properties 初始化式使来源集合红；caveat 上界改 N ≤ 45 使派生断言红，调低 Managed 编译器日域上界同样红；删 Java `SHELL_V3` 路由分支使路由目标集合红。含绑定名、allow 字面量与工具名的注释保持绿。各字节级还原复绿。
- 真实打包栈 `--loop-skill` 与 `--loop-fire` 臂以重生 sidecar 绿（jar 重建）。
- 这些 sidecar 的 Java 消费方 `ManagedLoopSkillTest` 以重生 body 绿（19 测试），sibling SDK 从被测源码安装。
- 提到每个 fake 回调之外的 sibling——内联伪造自己的 schema 并以对外来 call id 返回整个响应——使 file-wide 伪造集合红。把 `schemaTool` 查找伪造在上一层已实测存活，随执行接缝残留留在后续。

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
- **Java 服务集合钉（R2-1）。** profile 单一来源跨过 TypeScript 边界：parity 断言读 `ManagedLoopSkill.java` 的 `sidecars()` 键，要求（去掉仅来源比对的 `bundled` 键）等于 `MANAGED_LOOP_PROFILES`。该 map 只*提供* body；某 workspace profile 能否到达由 `forProfile()` 手工路由链决定，round 3 一并钉住——原理由指错了机制（见 Round-3）。
- **可执行 minted-id helper（R2-2）。** fake 侧提取合并为顶层纯函数 `mintedScheduleId(messages, createCallId)`（返回 `undefined`，绝不编造 id），两臂共用并在元测试对敌意历史执行；仅源码拼写计数会漏掉伪造 `?? 'asch_' + '0'.repeat(32)` fallback 且挡住合并。调用点与显式失败 `?? 'missing-schedule-id'` fallback 上钉。
- **classifier 门钉（R2-3）。** 对 `if (blockAnswer !== undefined) {`（两臂）计数钉，堵住「门改宽」（`if (blockProperties !== undefined)` + `blockAnswer ?? {…}`）——该拼写在赋值计数仍为 2 时复活误答。
- **替换单元钉（R2-4）。** managed Nd 修复的 `sub()` 替换串上钉（`midnight UTC on days 1, 1+N, … of each month`、`not.toContain('every N days')`）加示例间隔，使回退替换串并重生不能在全绿下重新教「every N days」。

## 验证报告跟进

独立 `/verify-pr` 轮在首个精化 head 上报了两条发现与一条 nit，三者均在此关闭：

- **N ≤ 31 多算一档（low）。** 与第二轮评审抓到的 critical 同一缺陷；由上文 N ≤ 30 修正关闭。
- **调用点之后的 sibling fallback（覆盖缺口）。** 语句锚定计数钉看不到写在门*之后*的 fallback（`if (blockAnswer === undefined) return …allow…`）：两个计数仍为 2，而 fire fake 重新误答侧查询，只在打包臂可见。首次响应改为「数成分」——block allow 字面量与决策变量引用计数。round 3 随后证明：经 helper 在*第二个绑定*下重新推导 allow 的 sibling 两个成分都不新增，故那两条计数同样盲；且对原始源码文本计数会因注释仅提到绑定而以难定位的计数不匹配变红。两者均被 AST 接线钉取代（见 Round-3）；成分计数已移除，结构化钉不再需要为计数无歧义而改写注释。
- **parity 计数陈旧（nit）。** PR 正文与上文验收标准当时被改为该轮的套件规模（core 33、scripts 元 183）与最新真实栈 occurrence key；两者此后都已增长，验收标准承载当前规模。

## Round-3 评审精化

第三轮发了三条建议，都是同一根因的实例：钉子断言的是拼写，而非它声称守护的机制。三条均改为结构化断言并见证。

- **分类器接线钉结构而非 token（R2-3，修复引入）。** 成分计数看不到「经 `classifierBlockAnswer` 在第二个绑定下重推 allow」的门后 sibling（字面量计数与 `blockAnswer` 引用计数都不动），且计数跑在原始源码文本上，注释仅提到绑定就会以难定位的计数不匹配变红。改用 `loopClassifierWiring`——对两个 loop fake 的 AST 库存：由 helper 以 schema 自身 properties 初始化的 `blockAnswer` 绑定、`!== undefined` 门、每个 `respond_in_schema` `fakeToolCall` 的 answer 表达式（不论 call id 一律收集，使 sibling 无法藏在新 call id 后；每个 loop classifier call id 恰一个，且必须是该被门控的绑定本身），以及 `respond_in_schema` 字符串字面量计数（使绕过 `fakeToolCall` 手搭的 tool call 也可见）。扫描器对敌意 fake 执行，故不会空转：第二绑定的 sibling 被检出，散文提到绑定与工具名不改任何计数。见证：报告点名的 sibling 使 answer 站点集合红，而旧计数仍为 1 与 6；换 call id 的 sibling 使同一集合红；手搭 tool call 使字面量库存红；含 `blockAnswer`、`shouldBlock: false` 与 `respond_in_schema` 的注释保持绿；此前已覆盖的 usage 行 `?? { shouldBlock: false }` fallback 仍红，且报错直接点名该表达式而非计数。Round-4 在同一扫描器上补入 allow 构造点、决策重赋值与 schema-properties 来源。
- **caveat 算术由解析器派生（R3-1）。** 上界与示例原是手写散文钉——这正是 `Keep N ≤ 31` 穿过两轮的原因。测试改为派生「日集合仍收集多于一天的最大步长」（30），并由 `*/2` 日集合派生两个月界间隔（30 天月→2、31 天月→1），要求 cron 与 union body 含这些派生值。见证：caveat 改 `Keep N ≤ 45` 并重生 sidecar 使派生断言红。本轮用的是 `utils/cronParser`；Round-4 把 oracle 换成真正触发这些 body 的 Managed 槽编译器。
- **Java 钉覆盖路由而非仅提供（R3-2）。** `sidecars()` 只提供 body；`forProfile()` 手工链决定哪个 workspace profile 能到达，故往 tuple 追加 profile 时本 PR 新增的每道门都绿，却没有任何 profile 路由到其 body。parity 测试现同时要求 `key = "…";` 路由目标集合等于 `MANAGED_LOOP_PROFILES`。无 creator 的 profile 路由到 null 且不赋 key，故 `ManagedLoopSkillTest` 的 null 期望不受影响。见证：删 `SHELL_V3` → `wakeup` 分支使路由集合红，而 sidecar 键断言仍通过。

## Round-4 评审精化

第四轮发了三条建议，其中两条是 round-3 替换自身引入的。三条都在修本 PR 新增的守卫、而非扩大其范围，故在本 PR 落地；round-3 摘要声明的边界此后被取代：第 5–9 轮按维护者「评审意见在本 PR 一次解决、不拆 follow-up PR」的常设要求，把每条兄弟发现都落在本 PR。该后续边界现在只适用于 #17673 跟踪的结构重构，绝不适用于本 PR 所交付守卫自身的缺陷。

- **构造点与重赋值（R2-3，修复引入）。** 替换成分计数时丢掉了唯一断言「allow 在*何处*构造」的检查，而 AST 库存既不查对象字面量也不查重赋值：`let blockAnswer = …; if (blockAnswer === undefined) blockAnswer = { shouldBlock: false };` 使 round-3 全部断言保持绿，而非 block 侧查询又被答以非法 allow。扫描器现收集每个 `{ shouldBlock: false }` 构造点及其所在函数（恰一个，位于 `classifierBlockAnswer` 内），以及决策或其输入在任意赋值运算符下的每次重赋值（零次——`??=` 与 `||=` 恰在决策为 undefined 即非 block 情形时赋值，只查 `=` 会漏）。仍是结构化的，故恢复的保证不依赖原始文本计数、对注释免疫。见证：报告的 `let` + 重赋值变异使构造点集合红；`??=` 重赋值为经 helper 推导的 allow（不新增字面量、不新增 answer 站点）使重赋值集合红；round-3 的第二绑定 sibling 仍使 answer 站点集合红（连续性）。
- **schema properties 的来源（R4-1）。** declarations 库存只记录实参 token `blockProperties`，故伪造初始化式（`schemaTool ? { shouldBlock: { type: 'boolean' } } : undefined`）能通过，同时让每个侧查询看起来都是 block schema。扫描器现记录每个 `blockProperties` 初始化式文本，要求两臂都读 `schemaTool?.function?.parameters?.properties`。见证：伪造任一臂初始化式使来源集合红，其余库存仍绿。
- **Managed caveat 的正确 oracle（R3-1，修复引入）。** round-3 从 `utils/cronParser` 派生上界与间隔，而它服务本地 CLI 调度器；Managed body 由 Java `CronSlots` 扫描器触发，其 TS 镜像是 `managed-automation-slots.ts` 的 `compileCron`。用错解析器会让一次 Managed 槽语义改动之后，caveat 继续教一个 Managed 调度器已不再遵守的上界。测试改从 `compileCron` 派生（日域与 `CronSlots.java` 同为 `[1, 31]`）。见证：把 Managed 编译器日域上界调到 30 使派生断言红（`Keep N ≤ 29`）——旧 oracle 对该变异盲；模块字节级还原后套件复绿（该轮为 32/32；套件此后增至 34）。

被执行的扫描器正向控制一次覆盖以上全部形态（伪造来源、`let` 重赋值为内联 allow、对输入的 `??=` 改写、第二绑定 sibling），而提到绑定名、allow 字面量与工具名的散文不动任何库存。

## Round-5 验证与 Round-6 评审精化

第二轮独立验证测出 round-4 扫描器的四个存活缺口；第六轮评审未发 inline 发现，但记录了十一条延后项。十一条中的十条与全部四个存活缺口在此关闭，一条附理由转 #17673。

- **对决策输入的原地写入（H22，及 `Object.assign` 兄弟形态）。** 重赋值库存只记录 `Identifier` 左值，故 helper 调用前的 `blockProperties['shouldBlock'] = {…}` 能在全部库存绿的情况下重造误答。扫描器现记录对任一绑定的任何写入：所有赋值运算符、成员写入（`blockProperties.x` / `blockProperties['x']`）、`delete`，以及原地 `Object.assign` / `Object.defineProperty`。
- **模板字面量工具名（H23）。** `answers` 与工具名库存只匹配 `StringLiteral`，故经 ``fakeToolCall(`respond_in_schema`, …)`` 回答的 sibling 两者都逃过。工具名现同时接受无插值模板字面量；每次 helper 调用连同实参被库存（伪造 schema 即第三次调用）；工具名为计算值的 `fakeToolCall` 单独记录且必须为零。
- **按回调域计数。** 工具名库存原是 file-wide 精确计数，故一个合法的非 loop `respond_in_schema` 臂会红到 loop 钉。每个站点现携带其 `startFakeOpenAIServer` 回调，`loopClassifierScope` 把断言限定在回答 loop classifier call id 的回调：各一个 answer 站点、两个工具名站点，无关臂不动任何计数。
- **caveat 子句级配对（H21）。** 四个派生值原为分开断言，故对调 30 天月与 31 天月的 gap 仍满足每个 `toContain`。每个示例现作为一条组合子句断言（派生日、派生序数后缀、派生间隔），对调即红。
- **绑定两个求值器。** caveat 同时到达两个调度器，故测试现要求 `parseCron`（本地 `CronCreate` 用它校验）与 `compileCron` 对 1..31 每个步长展开出相同的日集合。
- **Java 路由按映射、且只刮代码（H19）。** 比较 target 集合看不到两个 profile 家族互换 body。测试现把每个 `forProfile` 分支解析为 profile→key 对并断言映射（`SHELL_V4→union`、`FILES_V4`/`INTERNAL_TEAM_LEAD_V2→cron`、`SHELL_V3→wakeup`），外加可达 key 集合。两处刮取都先剥离 Java 注释，故仅改注释不再红。
- **各 shell 的 Parsing 库存。** bundled 库存看不到 cron 与 wakeup shell 自写的 managed-only 规则。现以 `Record<ManagedLoopProfile, …>` 钉住每个 shell 的规则名，删 cron 的 `No interval` 或改 wakeup 的 `Interval requested` 即红。
- **记录纠正。** 设计记录与 PR Risk 段原称「无生产运行时改动 / 无运行时 import」。对代码核实：没有运行时模块 import 生成器，但 bundled `SKILL.md` 随构建发布并由 `SkillManager` 的 bundled 层在运行时发现并解析（`dist/bundled/loop/SKILL.md`，由 `copy_bundle_assets.js` 填充），故模型面向内容确有改动。两版文档与 PR 正文改为「无运行时*代码*改动；发布的 skill 内容有改动」。修复 #1 的描述仍指 round-2 之前的内联正则与过滤，现改为描述 `mintedScheduleId`。
- **转 #17673：把 caveat 的 oracle 绑定到 `CronSlots.java`。** 共享 `managed-automation-slots-v1` fixtures（30 案例）无月内日期步进案例，故 Java 求值器在 `*/N` 上未与 TS 镜像绑定。关闭它需新增同时被 `managed-automation-slots.test.ts` 与 `CronSlotsTest.java` 消费的 fixture 案例并跑 Java verification 套件——属跨语言契约改动，留在本 PR 之外。上文双求值器一致性只覆盖 JavaScript 侧。

见证（各字节级还原）：成员写入、`Object.assign`、计算工具名、模板字面量 sibling、gap 对调、路由 key 对调、删 cron 的 `No interval` 规则、令 `parseCron` 分歧，各使对应断言红；拼写 `key = "wakeup";` 的 Java 注释保持绿；此前形态（第二绑定、换 call id、手搭 tool call、`let` + 内联 allow、`??=`、伪造来源、usage 行 `??`、门改宽为 `blockProperties !== undefined`）全部仍红，提到绑定名的注释保持绿。扫描器返回的每份库存都至少有一条自己的见证。被执行的扫描器正向控制携带全部**扫描器侧**形态——伪造来源、成员写入、`Object.assign`、`delete`、`??=` 改写、内联 allow、计算工具名与模板字面量 sibling，故无库存空转——外加一个无关回调，其 `respond_in_schema` 回答被证明在域外。core 侧形态（gap 对调、路由 key 对调、shell 规则删除、解析器分歧）则如上所列，通过变异真实源并重生来见证。core 33/33、scripts 元 183/183、eslint/prettier/core typecheck 净。

## Round-7 评审

第七轮无 inline 发现、三条延后项。每条先实测再处置：

- **别名写入**——`const propsAlias = blockProperties; propsAlias['shouldBlock'] = …`——**存活**（88/88 绿）。在下一节的提交中通过「被跟踪绑定集随别名声明增长」关闭。
- **两参 `fakeToolCall('respond_in_schema', blockAnswer)`** 与**拼写工具名的手搭 tool call**——两者**本已红**（按回调域的工具名计数移动）。记为实测已闭，避免后续轮次重复上报。但两参且名字为*计算值*是另一回事，见下文 Round-8。
- **Java 刮取依赖形态**（对 `forProfile()` 做保持行为的 switch 重写会红到 `packages/core`）与 **Parsing 规则语法被抄三份**（bundled 库存测试、各 shell 库存测试、生产 drift guard）。两者属实且仍在 #17673 开放：它们是「钉子如何读 Java」与「语法住在哪」的重构，不是对本 PR 所交付内容的更正。

## 第三轮验证：剩余的写入与 tool-call 兄弟形状

第三轮独立验证把第二轮的四个存活缺口全部复测为已闭、并逐个确认新钉承重，随后又测出三个同属「原地写入 / 手搭 tool call」家族的兄弟形状。三条连同 Round-7 的别名写入，全部在**本 PR**关闭，不转后续。

- **写入者集合不是全集。** helper 调用前的 `Reflect.set(blockProperties, 'shouldBlock', …)` 与 `Object.defineProperties(blockProperties, …)` 使两套套件全绿。调用型写入分支现按名集判定——`Object.assign` / `defineProperty` / `defineProperties` 与 `Reflect.set` / `defineProperty`——仍要求首参解析到决策或其输入。
- **别名携带同一个值。** `const propsAlias = blockProperties; propsAlias['shouldBlock'] = …` 不动任何库存，因为写入以两个绑定名为键。被跟踪集合现随别名声明增长，故经决策或其输入的别名写入都会入账，按源码顺序支持任意长度链。
- **计算名的手搭 tool call 不可见。** 手搭覆盖原依赖 `respond_in_schema` 字面量计数，故不经 `fakeToolCall`、且名字为计算值的元素不动任何库存。现记录 `toolCalls` 数组中每个非 `fakeToolCall` 元素及其回调，loop 钉要求为零。

写入者查找用 `Map` 而非对象字面量：普通对象会把名为 `constructor` 或 `toString` 的接收者解析到原型函数，并在可选 `.has` 调用上抛错。控制用例携带了这种接收者，回退为对象字面量即以 `IN_PLACE_WRITERS[...]?.has is not a function` 失败。

每种形态都进入被执行的敌意控制（故无库存空转），并注入真实 fire 回调实测：`Reflect.set`、`Object.defineProperties`、计算名手搭调用、别名写入各使钉红（1 失败 / 87 通过）；此前全部形态仍红——第二绑定、换 call id、拼写名字的手搭调用、`let` + 内联 allow、`??=`、伪造来源、usage 行 `??`、计算工具名、门改宽、成员写入、模板字面量 sibling、`Object.assign`、短 `fakeToolCall`——而提到绑定名的注释保持绿。全部字节级还原。

**为何反复出现、什么能终结它。** 这些兄弟形状都是「写同一个值或发同一个答案，但不按扫描器寻找的拼写来写」。扫描器是对内联判定的拼写级守卫，故 evasion 面无界。打包 `--loop-fire` 臂端到端驱动 fake 的真实回答，因而是行为级守卫，而这些结构钉是快速层的尽力近似；「该臂在每个具体兄弟形状下会失败」是从变异对 fake 的作用推断的，此处未单独实测。持久修复是把接缝画在整个判定之外——schema 查找、收窄、门、answer——每臂执行一个纯函数并退役库存。该重构、`CronSlots.java` fixture 绑定、与形态无关的 Java 路由断言、唯一导出的 Parsing 语法，以及派生退化阈值，均记于 #17673。

## Round-8 评审精化

第八轮无 inline 发现、六条延后项。六条都是对本 PR 已交付内容的更正——三条记录失实、三条守卫缺陷——故全部在此修掉而非延后。

- **域限定不完整。** `loopClassifierScope` 只把十份库存中的四份限定到 loop 回调；`definitions`、`declarations`、`gates`、`helperCalls`、`reassignments` 仍按 file-wide 断言，故无关 fake 回调复用 helper 或同名绑定就会红到 loop 钉。现每份库存都携带回调并被限定，唯 `allowSites` 有意保持 file-wide——唯一合法构造点在 `classifierBlockAnswer` 内，位于所有回调之外。
- **计算工具名只在三参时记录。** 两参 `fakeToolCall(computedName, answer)` 让名字逃过所有库存。计算名分支现按任意 arity 运行；answer 库存仍要求三参，因为它要读 call id。被执行的控制用例携带两种 arity。
- **路由钉建模为 last-wins，而 Java 是 first-match。** `Object.fromEntries(routing)` 会让靠后的重复分支覆盖靠前者，而 `forProfile()` 是 `if / else-if` 链：首个匹配生效，后面再点名同一 profile 的分支是死代码。钉子现以 first-match 解析进 `Map`，并由其派生可达 key 集合。
- **记录：core 套件规模自相矛盾。** 验证跟进的 nit 仍写「core 32」，而验收标准与后文记录写 33。双语均改为 33。
- **记录：声称已做却未做的 PR 正文更正。** 记录声称运行时内容的说法已处处更正，但正文「Why it's needed」段仍写「运行中 Session 读的唯一产物是 sidecar JSON」。该段双语已改为与 Risk 段一致：无运行时*代码*改动，但 bundled `SKILL.md` 随构建发布并在运行时读取，故模型面向内容确有改动。
- **记录：缺一个轮次。** 记录从合并的 Round-5/6 小节直接跳到 Round-8，没有 Round-7。已在上文补出，并逐条给出其实测处置。

三条守卫修复的见证（各字节级还原）：向真实 fire 回调注入**两参**计算名 `fakeToolCall` 使计算名库存红（1 失败 / 87 通过）；追加一个点名已匹配 profile 的**死 Java 分支**使 core 套件保持 **33/33 绿**（first-match 将其化解，last-wins 则会红），而对调两个路由 key 仍红；被执行控制用例的无关回调现复用 helper、绑定名与工具名，file-wide 库存显示其贡献（2 definitions、2 declarations、2 gates、3 helper calls、4 answer 站点、6 工具名站点），而每个 loop 域内库存不变。此前十八种变异形态全部仍红，注释形态保持绿。

## 合并后审计：提到回调外的 sibling 与 main 的继承红

第二次合入 main（合并提交 `383bdc690c`）。其上的每个提交都只改本记录与元测试——从不改 runner、core、cli 或 Java 源码——故下方臂证据承接到分支 head。incoming 提交未触碰本 PR 的十一个文件，且本 diff 在 `packages/managed-agent-server`、`packages/sdk-java`、`packages/web-shell` 与 `packages/web-templates` 上与 main 逐字节相同。main 也未触碰 `packages/core/src/managed-runtime`、`packages/core/src/skills`、`WorkspaceToolProfiles`、`CronSlots`、`cronParser` 与共享槽 fixtures，故这些守卫读取的每个 oracle 都未变；loop 注入路径上的 Java 变化是 #17703 的 `mergeInto`/`sessionSkills` 签名及其调用方，由两条真实臂覆盖。

**三条继承红，各以实测归属，均非本 diff 所致。**

- `ClassSizeRatchetTest` —— `AgentSessionPolicies` 在 merge base 与本 head 都是 779 行，在 main 的 `3d75b8ee60`（#17703）处是 795 行；`class-size-ratchet.properties` 的上限是 791，自 #17466 以来未被触碰。
- `ManagedStoreDecompositionTest.facadesKeepTheExistingEntryAndTransactionPopulation` —— 唯一的多余元素是 `creationToolProfile/5::REQUIRED:DEFAULT:false`，即 #17703 新增却未更新期望清单的 facade 入口。两者均在 #16346 跟踪，该处一位维护者的诊断点名同一提交与同两条修复。两者都不是必需检查。
- `web-templates` 导出体积预算 —— 本地构建逐字节复现 main 的 CI（`2146529 > 2146100`）。该常量最后由 #17515 设定，#17421 的繁中 locale 把 transcript 图推过线；无环境变量 override。已在 #17741 跟踪。这一条落在必需检查链上（`Build unit-test tree` → `Test (ubuntu-latest, Node 22.x)`），故推合并会把它带进来。这是刻意选择：保持分支最新并等上游修复，而不是守着陈旧 base。因此本地全量构建在该门处中止，尚未到达 `packages/cli`：core、acp-bridge、network-policy、web-shell 与 sdk-typescript 在其中重建绿，随后单独重建 cli、重建 bundle 并重跑两条臂，故此处没有任何证据依赖合并前的 cli。`web-templates` 不是 core 或 scripts 面的输入；cli 确实链接它的 dist，而其公开类型未被 main 改动（incoming 对它的唯一改动就是预算脚本本身），其生成资产来自上一次构建——它们供文档导出，不在 loop 路径上。

**评审无法运行的 Java 半边现已运行。** 在重装 sibling SDK（main 的 #17688 改过它）之后，`ManagedLoopSkillTest` 在合并后的树上以重生 sidecar 跑出 19/19 绿。真实打包臂在本 head 复绿：`--loop-skill` session `eabc028a-072f-452d-a7df-f199c760ba32`、modelRounds 6；`--loop-fire` session `335c0de1-bf37-4f6f-b45a-a0e14980b571`、schedule `asch_6346026ceb71bcc77c18db7723bd73f5`、occurrenceKey `schedule:2026-11-18T15:21:00Z`、`fireTrigger=scheduled`、`fireOutcome=fired`、`fireState=completed`、modelRounds 5。

**一个新的对抗形态，先实测再在此关闭。** 第一个假设——sibling 提到模块级函数但仍答 loop call id——被实测推翻：域由 loop call id 派生，故这样的答案会把回调外的位置拉进域并使回调计数红，而把它作为 `toolCalls` 元素调用也会被记为手搭。真正存活的变体答**外来** call id 并返回**整个响应**，于是 loop 回调里根本没有 `toolCalls` 数组：它伪造自己的 schema、经 helper 推导 allow，而每个 loop 域内库存都保持干净。这是 round-8 域限定引入的——它所替换的 file-wide helper 调用与来源库存本会抓住它，同一探针在 hoisted 答案点名 loop call id 时即显示这一点。

以两条 file-wide **集合**断言关闭：每次 `classifierBlockAnswer` 调用的实参都是那个被查找的绑定，且每个 `blockProperties` 初始化式都是该查找。用集合而非计数，故遵循同一查找的合法新臂不新增成员，round-8 的收益得以保留。被执行控制用例现携带该 hoisted 形态并证明两个方向——伪造到达 file-wide 库存，而 loop 域内库存不变。此次新增后它的 file-wide 计数是 5 个 answer 站点、7 个工具名站点、4 次 helper 调用（round 8 记的是 4、6、3）；round 9 把同一控制增至 6、10、4，round 12 再增至 7、13、5，即已提交的值。真实 runner 上的见证：hoisted sibling 使集合断言红并点名 `props`（1 失败 / 87 通过）；字节级还原回到 88/88。

这里关闭的是**直接**伪造路线，其限度是实测而非假设：若 hoisted 函数把 `schemaTool` 查找本身伪造在上一层，实参与初始化式仍都拼写为规范形，同一探针报告钉子对它**绿**。该变体属同一拼写家族——再往上伪造一层，任何拼写库存都会被满足——故记为 #17673 执行接缝的残留，不在此再加一份库存去追。

Java 侧见证是在合并后的 Java 文本上**重测**的，而非引用早先 head 的结论：对调两个路由 key 使映射红，删 `SHELL_V3` 分支使映射红，点名已匹配 profile 的死分支保持 **33/33 绿**（first-match），拼写 `key = "wakeup";` 的注释保持绿。每次还原都字节相等。

core 邻近面是整面跑而非抽样：`src/managed-runtime` 加 `src/skills/bundled/loop` 共 **87 文件 / 4167 测试绿**，覆盖 sidecar 消费方与 caveat 所派生的槽编译器。

一条本地假红属环境而非回归：`serve-ab-workflow` 的 `worktreeConfig` split-config 用例失败，因为本机设了系统级 `core.hooksPath`；以 `GIT_CONFIG_SYSTEM=/dev/null` 跑该文件是 24/24，且测试与 wipe 脚本都未改动。

残留在种类上不变。本轮在全文件范围关闭了直接伪造路线；它并未终结拼写 evasion 家族，后者的持久修复——每臂执行整个分类器判定——与其余四项一并留在 #17673。

## 第 9 轮评审：十六条延后项，逐条先实测再处置

第 9 轮无 inline 发现、十六条延后项，并因两条继承的 Java 红把自己的 Approve 降级为 Comment——同时独立确认了归属（本 diff 无 Java 文件；`AgentSessionPolicies` 在 merge base 与 head 都是 779 行）。下面每条都先实测再处置，十六条全部在此关闭，不再延后。

**记录纠正（五条）。**

- 涉及文件表仍把 Java 守卫描述为路由*目标集合*，即 round 5 已替换掉的形态。现改为 first-match profile→key 映射。
- 表里漏了一个被改动的生产文件 `regenerate-managed-loop-assets.ts`。已补行。
- R3-1 见证把还原后的套件记为 `32/32` 而未加限定。现写明那是该轮的规模；套件现为 34。
- **记录把 `readBundledReference` 说成 loop `SKILL.md` 的运行时读取者，而没有任何调用点这样做。** 实测：它的调用方只有 agent-delegation 与 workflow-authoring 两个 skill（以及泛型的 surface 解析器）。真实路径是 `SkillManager` 的 bundled 层，锚在 `dist/bundled/`、由 `copy_bundle_assets.js` 填充；已确认本轮 bundle 里 `dist/bundled/loop/SKILL.md` 在位且携带修正后的 `Nd` 措辞。两版文档与 PR 正文现改为点名该机制。结论——发布的模型面向内容有改动——是对的；点名的机制是错的。
- 记录对后续兄弟轮次保留了两条互不相容的范围政策（round 3 的「再有一条转后续 issue」对 round 4 的「这些落在本 PR」）。现记录适用哪条：第 5–9 轮按维护者常设要求把每条兄弟发现落在本 PR，后续边界只覆盖 #17673 的结构重构，绝不覆盖本 PR 所交付守卫自身的缺陷。

**守卫缺口关闭（九条），各带自己在真实 runner 或已提交夹具上的见证。**

- **解构写入。** `writtenBinding` 只解析标识符与成员访问，故 `[blockProperties] = [伪造]` 会隐形地重绑输入。另设 `assignmentTarget` 行走数组与对象模式（与 `writtenBinding` 分开，使原地写入者的首参永不被当作模式读）。见证：重赋值库存红。
- **非内联数组的 `toolCalls` 源。** `const calls = [ …手搭… ]; return { toolCalls: calls }` 藏住了每个元素。任何非内联源现按站点记录——但同一键的 shorthand 形态直到 round 13 才被关闭，此前仍能逃过。见证用计算名，使工具名计数不动、只有这份库存触发。
- **引号 allow 键。** `{ 'shouldBlock': false }` 对只匹配标识符的写法不可见。键匹配现接受字符串或模板字面量。见证把 allow 提到每个回调之外并答外来 call id，故只有 `allowSites` 触发。
- **门只证明了总数。** 两个门可以都在一个回调里，而另一个无门作答。钉子现要求每回调一个门。见证用 2/0 分布，使总数仍为 2。
- **minted-id 钉原是对整个 runner 的原文本匹配**，注释掉的或重复的副本即可满足。现改为 AST 库存：每个 `mintedScheduleId` 调用点连同它初始化的绑定与它过滤的 create-call id，外加 `?? 'missing-schedule-id'` fallback。见证注释掉一个真实调用点并替换为伪造 id。
- **没有负向夹具携带「有 block 阶段字段但无 shouldBlock」**，故对 `thinking`/`reason` 的 additive 收窄会存活。已补 thinking-only、reason-only 与两者兼具三个夹具，各断言 `undefined`。
- **`Object.defineProperty` 与 `Reflect.defineProperty` 在写入者集合里但不在敌意控制里。** 两者均已补入，故两个分支都不空转。
- **`reassignments`、`dynamicToolNames` 与 `handBuiltToolCalls` 的域限定未被见证。** 无关臂现携带这三种形态，断言证明每种都到达 file-wide 库存而无一到达 loop 域。
- **非 loop 回调里的伪造 schema** 实测已被本轮的 file-wide 伪造集合杀掉——记为已闭，不重复修。

**core 钉（两条）。**

- first-match 解析此前没有已提交的见证（只有对真实 Java 文件的本地变异）。现为顶层纯函数 `resolveJavaRouting`，由一个已提交的合成链测试执行，链上带死重复分支与两种注释形态。见证：把解析改回 last-wins 即红。
- 两个 `Nd` 钉原迭代硬编码的 `['cron','union']`。现迭代 `FIXED_INTERVAL_PROFILES`，由携带 `CronCreate` 的已发布 body 派生，且成员本身被断言，故某个 body 失去其 creator 不会静默缩小集合。见证：把派生谓词换成 `LoopWakeup` 即红。

该轮的套件规模为 core 34、scripts 元 183（改动文件 88）。残留在种类上不变：拼写 evasion 家族仍无界——把 `schemaTool` 查找伪造在上一层仍存活——其持久修复留在 #17673。

## 第三次合并：继承的必需检查红已被上游修好

第三次合入 main（合并提交 `fecbb312e0`，与本 PR 文件零重叠）。`164bb1eb58`（#17746）把文档渲染器预算从 2,146,100 抬到 2,148,200 字节，故此前打红必需检查链的导出体积门现在通过：本地全量构建绿，包含上一次构建从未到达的 `packages/cli`。两条 Java 棘轮红在 main 上仍未修（`AgentSessionPolicies` 795 行对 791 上限），且仍非必需检查。

该合并还改了 cli 与 core 的 serve 源码，故 harness 是重建而非复用：core 与 cli 的 dist 按构建起点时间戳断言已刷新，bundle 重建并断言已刷新，两条臂重跑。incoming 提交未触碰 Java，故 jar 及其逐字节相等的 sidecar 承接有效。

本 head 的臂：`--loop-skill` success（session `1202cce3-c272-406b-8d29-e59d3062f85b`、modelRounds 6、cron create/list/delete 均见证）；`--loop-fire` success（session `79e11be7-0ed5-4bb2-9dee-f355f5e5e5bb`、schedule `asch_7b67f54fde2eb587c9b7bddc2474dc98`、fireTrigger=scheduled、fireOutcome=fired、fireState=completed、occurrenceKey `schedule:2026-11-18T16:06:00Z`、modelRounds 5）。

## 第 10 轮评审：五条延后项，以及继承的 Java 红已被上游修好

第 10 轮无 inline 发现、五条延后项。每条先实测再处置，五条全部在此关闭。

- **「comment-blind」见证其实没见证剥注释。** 实测：两个已提交变体——尾随的 `// key = "cron";` 与前置的 `/* key = "wakeup"; */`——在剥与不剥下解析结果完全相同，因为分支正则要求赋值前有 profile 条件，而裸赋值注释永不匹配。它们什么都没证明。两者均替换为拼出**整条分支**的注释（行与块两种形态）；不剥时这样的注释会赢得 first-match 并把 cron body 交给 `SHELL_V4`，故去掉任一剥注释步骤现在都会红。
- **记录说验收标准承载 core 33，而它们写的是 34。** 该 nit 是那一轮规模的历史记录；现已如此限定，验收标准承载当前规模。
- **控制计数记为 5/7/4，而已提交断言是 6/10/4。** round 9 在该句写下之后又扩充了同一控制。该句现陈述演进（round 8：4/6/3 → 合并后审计：5/7/4 → round 9：6/10/4）并点名该轮当时已提交的值；round 12 又扩充了一次，上面那句给出的是当前值。
- **`assignmentTarget` 的对象模式臂没有见证。** 控制此前只带数组模式。已补两种对象形态——属性目标（`{ x: blockProperties.shouldBlock } = …`）与 shorthand 重绑（`{ blockProperties } = …`）——两者都被重赋值库存记录。
- **未被路由的 profile 常量未被分类。** 映射无法区分「无 creator 的 profile」与「链忘记路由的 loop-bearing profile」。Java 没有机读的 creator 声明——该事实只存在于每个常量上方的 Javadoc——故 `loopBearingProfiles` 从该散文派生 loop-bearing 集合，钉子要求它等于被路由集合，并为派生本身配合成见证。这是漂移守卫而非机制钉：改写文档可绕过它，#17673 里与形态无关的路由断言仍是持久修复。

分支在本会话之外被合入 main（合并提交 `00f24627d4`）；本地树已快进到它，且该合并未改动本 PR 的任何文件。incoming 的 `7171fc776e`（#17753）恢复了 class-size 与 facade-population 两道门：`AgentSessionPolicies` 回到 779 行对 791 上限，分解清单已含 `creationToolProfile`，故**两条继承的 Java 红均已由上游解决**。在该合并提交上测得的所有 CI 车道均通过，含 `SDK Java (fast) / ubuntu-latest / Java 21` 与 `Managed Agent fast tier`，以及四项必需检查。

真实环境验证在本 head 重跑而非承接，因为第四次合并改了 12 个 Java 文件与 13 个 cli/core 文件：全量构建绿且 core 与 cli 的 dist 按构建起点时间戳断言已刷新，jar 重建，`ManagedLoopSkillTest` 以重生 sidecar 跑出 19/19，bundle 重建并断言已刷新，重建 jar 内四个 sidecar 与已提交契约逐字节相等。臂：`--loop-skill` success（session `6a36196e-b6d6-4aac-a37a-fff0b8a10795`、modelRounds 6、cron create/list/delete 均见证）；`--loop-fire` success（session `01b1b51c-cc4d-4f9b-be6c-81019be0afe6`、schedule `asch_ebf79227b1238167ff6217b3d0e052bb`、fireTrigger=scheduled、fireOutcome=fired、fireState=completed、occurrenceKey `schedule:2026-11-19T01:15:00Z`、modelRounds 5）。

该轮套件规模：core 35、scripts 元 183（改动文件 88）。

## 第 11 轮评审：哨兵诊断断言了守卫从未核实的事实

第 11 轮无 inline 发现、一条延后项，并因其边界上 CI 仍在跑而把自己的 Approve 降级为 Comment。它还披露其边界无 JDK，故重生 sidecar 的 Java 消费方 `ManagedLoopSkillTest` 未在那里运行；本 PR 在本地跑它并发布结果。

**该发现属实，并在此修复。** `assertSentinelsExpanded` 对*任何*不在 allow-list 的哨兵都抛 `teaches a non-expanding sentinel: X`。对两个已知字面形这是准确的，但对未知 token，守卫确立的只是**成员资格**而非是否展开：新增哨兵完全可能在别处展开，而该消息在未核实的情况下断言了相反的事。诊断现按两个分支只报告已确立的事实：

- cron —— `Managed cron loop body teaches a sentinel, but cron fires expand none: X.` cron 触发根本不展开任何哨兵，故无论成员资格如何，任何哨兵在此都是错的。
- union/wakeup —— `Managed <profile> loop body teaches a sentinel outside the expanding allow-list: X.`

拒绝行为不变：同样的 body 被拒、同样的 profile、对未知 token 仍失败关闭。只有措辞变了，而编码旧措辞的七处断言现按 profile 断言新措辞，故每个方向都保有自己的见证。生成的 sidecar 未触碰——parity 测试重生并逐字节比对且保持绿——故这是生成器里的诊断改动，不是发布的模型面向内容的改动。

见证：把两条消息都回退为旧的 `non-expanding sentinel` 措辞会使 **4 个用例红**，各自点名它期望的措辞；字节级还原回到 35/35。core `tsc --build`、eslint 与 prettier 净。

第五次合入 main（合并提交 `50a39ddbc8`，以 merge base 判定与本 PR 文件零重叠），改了 217 个 Java/cli/core 文件，故整栈重建而非复用：全量构建 rc=0 且 core 与 cli 的 dist 断言已刷新，jar 重建，`ManagedLoopSkillTest` **19/19**，bundle 重建并断言已刷新，重建 jar 内四个 sidecar 与已提交契约逐字节相等。臂：`--loop-skill` success（session `4b05a9ad-2f7a-4323-9154-6e63895b5caf`、modelRounds 6、cron create/list/delete 均见证）；`--loop-fire` success（session `229ac023-e0fe-4b59-9593-19848279e71f`、schedule `asch_5d9999101c86d3d0578238c5e0faa8e9`、fireTrigger=scheduled、fireOutcome=fired、fireState=completed、occurrenceKey `schedule:2026-11-19T05:53:00Z`、modelRounds 5）。

第六次合并（`114ebcc1a1`）随后带入 `c5247e9727`（#17733），它只碰 web-shell 客户端文件与 docs——未碰 cli、core、Java 或 scripts——故上面的 harness、jar 与臂证据原样承接；在该 head 复跑了快速套件与 core `tsc --build`，均绿（core 35/35、scripts 元 184/184）。 scripts 元计数从 183 增至 **184**，因为 main 给 `hosted-process-ci.test.js` 新增了一条用例（95 → 96）；改动文件仍是 88。本 head 上 core 35/35、core `tsc --build` 净。

## 第 12 轮评审：LGTM 附四条延后，三条已修、一条早已披露

第 12 轮给出 **「No blocking issues. LGTM!」** 附四条延后项。三条是本 PR 所交付守卫的缺陷，已在此修复；第四条是上文早已记录的限制。

- **引号 `toolCalls` 键逃过手搭库存。** 实测：`return { 'toolCalls': [ …手搭… ] }` 使该库存 file-wide 为零，与 round 9 修复前的引号 allow 键完全同类。键匹配现接受标识符、字符串或无插值模板，被执行控制携带引号形态。见证：回退为只匹配标识符即打红手搭计数。
- **file-wide 伪造判定按绑定名拼写键控，会误红合法臂。** 实测：第三个臂做同样查找与同样门控、但把绑定命名为 `schemaProps`，被报为伪造。判定现**穿过绑定**解析实参到它被赋予的初始化式，并要求该初始化式就是那个查找。收集器保留一个名字曾被绑定的**每一个**初始化式，因为它对作用域不敏感：不同作用域的同名绑定于是失败关闭，而不是静默解析到最后收集的那个。内联对象代表自身、未绑定名字解析为标记，故两者仍会红。控制现携带一个合法的改名臂并断言它不新增成员。见证：把并集改按绑定文本键控即列出 `schemaProps` 并打红。
- **两个 AST 扫描器各自定义了自己的字面量文本提取器。** 已提为一个模块级 `literalText` 供两者共用；`mintedIdWiring` 里的重复副本已删除。见证：把共享提取器收窄为只认字符串字面量即打红模板字面量答案站点。
- **core parity 测试用正则刮 Java 源码与 Javadoc 来分类路由与 loop-bearing profile。** 早已披露：round-10 记录明说这是漂移守卫而非机制钉，#17673 承载与形态无关的路由断言作为持久修复。无新工作；在此记录以免该条被静默丢弃。

门与声明库存仍按规范决策名键控，故改名臂的门不被计数；它的 helper 调用会被计数，而这正是伪造解析所检验的部分。这是扫描器既有设计，不是本轮的改动。

第七次合入 main（合并提交 `9750c4a696`，以 merge base 判定与本 PR 文件零重叠），改了 68 个 cli/core/Java/scripts 文件。首次构建**失败**：main 新增 `packages/channels/msteams` 并改了 `pnpm-lock.yaml`，故 `@microsoft/agents-hosting` 与 `@microsoft/agents-activity` 未安装，该包报 TS2307。这是依赖漂移、不是本 diff 的回归；`corepack pnpm install --frozen-lockfile`（rc=0）解决后重跑构建，而不是把失败当通过承接下去。

本 head：全量构建 rc=0 且 core 与 cli 的 dist 按构建起点时间戳断言已刷新，jar 重建，`ManagedLoopSkillTest` **19/19**，bundle 重建并断言已刷新，重建 jar 内四个 sidecar 与已提交契约逐字节相等。臂：`--loop-skill` success（session `7a23c06a-5fe7-4a0c-8f84-3b78794d10f1`、modelRounds 6、cron create/list/delete 均见证）；`--loop-fire` success（session `ec5bc39a-2fb2-45e5-95c5-91e3264b2528`、schedule `asch_916ccb2d42000efe6c0fdc9ca225506d`、fireTrigger=scheduled、fireOutcome=fired、fireState=completed、occurrenceKey `schedule:2026-11-19T08:41:00Z`、modelRounds 5）。快速套件：core **35/35**、scripts 元 **184/184**；core `tsc --build`、eslint 与 prettier 净。

第八次合并（`42be95703d`）带入 `457656e0ab`（#17799），纯文档（两份用户指南）、不碰任何代码，故上面全部证据原样承接；在该 head 复跑了快速套件，均绿。

## 第 13 轮评审：三条延后项，以及本轮对抗审计查出的第四条缺口

第 13 轮在其收敛姿态下未发内联发现，给了三条延后项。三条都先实测再处置。其中两条是本 PR 所交付内容的缺陷，在此修复；第三条是早已披露的 prose oracle，现把它的**两个**失效方向都实测记录，而不是只记一个。随后对同一扫描器排查刚修复的 shorthand 缺口的同族兄弟，又查出第四条缺陷，同样在此修复。

该轮披露了自身边界的两处缺口，本 PR 在本地把两处都补上。它的 build-test 车道从未进入测试阶段（`packages/cli` workspace 构建耗尽调用预算），故改由四个评审 agent 跑受影响套件——core 35/35、该 head 上 scripts 88/88、core `tsc` 净。且 `SDK Java (fast) / Runtime Broker and Managed Agent MySQL / Java 21` 在该提交被跳过，`ManagedLoopSkillTest` 也因缺 JDK/Maven 未在那里运行，使重新生成的 sidecar 的 Java 消费方在该 head 未经验证。本 PR 在每个影响代码的 head 都本地跑它并公布结果。

- **shorthand 形式的 `toolCalls` 键逃过了手搭库存。** 在按字节抽取出的扫描器上实测：`return { toolCalls }` 使该库存在 file-wide 与 loop 域内都为零，与 round 12 修复前的引号键完全一样——shorthand 是 `ShorthandPropertyAssignment`，故按 `isPropertyAssignment` 键控的分支根本看不到它。该分支现同时接受两种节点，且 shorthand 被记为一个站点，因为它的值是绑定引用、无法内联枚举。被执行控制用例携带该 shorthand 形态。三个见证，每次还原都字节相等：把**两个**新析取项都还原（即修复前的原码）打红手搭计数（`expected … to have a length of 4 but got 3`）；只还原外层析取项打红同一计数；只还原内层则以 `TypeError: Cannot read properties of undefined (reading 'kind')` 崩溃，因为 shorthand 不带 `initializer`，数组判定不可对它执行。故内层析取项是承重的、并非冗余——「它冗余」这一假设被该实测否掉。下面那条 allow 站点用例使套件增长后，三个见证都在最终树重跑：1 失败 / 88 通过，干净基线 **89/89**。
- **记录与控制用例自己的注释仍带着上一版计数。** 在 round-12 的 head 实测：已提交断言是 7 个 answer 站点、13 个工具名站点、5 次 helper 调用，而记录的演进句停在 round 9 的 6/10/4，控制注释写着「Six answer sites」。两处都在两种语言里改正。该增长归属 round 12（改名臂与引号键元素），不是本轮：这三个库存在此不变，而 round 13 把手搭库存扩到 loop 域内 4、file-wide 5，并把 allow 站点库存由 2 扩到 4。round-10 那条点名演进的 nit 现限定为该轮当时的值。
- **Javadoc prose oracle 在两个方向都会失效，现两个都已实测。** Java 不带机器可读的 creator 声明：`WorkspaceToolProfiles` 的全部八个公开 helper（`isPublicShell`、`isInternalTeamLead`、`isShellOrMcp`、两个 `lifecycleProtocol` 重载、`supportsApprovalMode`、`supportsApprovalSelection`、`requiresApproval`）分类的是 shell/team-lead/MCP 归属、生命周期协议或审批模式，没有一个枚举哪些 profile 带 /loop creator——该事实只存在于四个已路由常量上方的 Javadoc 里。在真实 Java 文件上实测，每次还原字节相等：把已路由的 `SHELL_V3` 的 doc 改写为不含关键词、路由一字未动，即打红本套件（`expected [ 'FILES_V4', …(2) ] to deeply equal [ 'FILES_V4', …(3) ]`，1 失败 / 34 跳过）——一次**纯文档**的 Java 改动打红 `packages/core`；而新增一个未路由的 `SHELL_V5`、其 doc 写作 "Autonomous scheduled revision"，则保持**绿**（1 通过）——守卫对链路遗忘的 loop-bearing profile 是盲的。守卫自己的注释曾无条件断言第二个方向会红；现改为陈述两个已实测的方向。这是漂移守卫已披露的代价，保留它是因为替代方案是完全没有漂移检测。#17673 中与形态无关的路由断言仍是持久修复；此处不改 Java 契约。
- **自查发现、非评审项：allow 构造库存对同一 allow 的另两种拼写也是盲的。** `allowSites` 分支要求 `shouldBlock` 属性处出现字面量 `false`。在真实 runner 源码上经按字节抽取的扫描器实测，并带负向控制：提到模块级的 `return { shouldBlock: false }` 会把 `hoistedAllowSite` 加进库存，故钉子会红；但 `const shouldBlock = false; return { shouldBlock }` 与 `const flag = false; return { 'shouldBlock': flag }` 都使库存停在 `['classifierBlockAnswer']`——**绿**，尽管 allow 是在 helper 之外构造的。该分支现记录每一个 shorthand `shouldBlock` 站点，以及每一个显式键、其值为 `false` 或曾被初始化为 `false` 的绑定，复用 round 12 建起的对作用域不敏感的初始化式映射。shorthand 规则按设计是无条件的：shorthand 的值是绑定引用，故库存无法区分 shorthand 的 allow 与 shorthand 的 schema，而钉子要求那唯一构造点位于 helper 内——未来若把 schema 夹具写成 shorthand 就会红，改为显式拼写即可。修复后四臂全部正确：基线仍是 `['classifierBlockAnswer']`，三个注入站点都被记录。同样这三个注入随后**经 vitest 在真实 runner 上**跑过，而不只经抽取出的扫描器：每个都使钉子红，报 `expected [ 'classifierBlockAnswer', …(1) ] to deeply equal [ 'classifierBlockAnswer' ]`（1 失败 / 88 跳过），未变异的 runner 在前后都通过，每次还原字节相等。控制上的子句级见证，各字节级还原：还原整个加宽打红 2 个用例；只删 shorthand 规则打红那个隔离用例（`expected [] to deeply equal [ 'allow' ]`）；只删绑定解析规则打红大控制（3 个站点对 4 个）。隔离 shorthand 规则的第一次尝试**存活**了：放进大控制的参数绑定 `{ shouldBlock }` 会经该控制自己的 `const shouldBlock = false` 解析到，因为初始化式映射对作用域不敏感。故该规则现有一份自己的源、其中任何地方都没有 `false` 初始化式，另加一条负向控制断言对象值的 `shouldBlock`（那是 schema、不是 allow）不被记录。套件由 88 增至 89。这一族现在是枚举而非抽样：扫描器恰好有三处按 property 键控的分支——`assignmentTarget`（round 10 已教会它两种形态）、`toolCalls` 键与 `shouldBlock` 键——三者都接受 shorthand。残留属同一无界家族、但在**值**这一维：以 `!true` 或 `Boolean(false)` 算出的值仍不拼写 `false`，随执行接缝留在 #17673。

第九次合入 main（合并提交 `26ada0b6cd`，23 个 incoming 提交，以 merge base `457656e0ab` 判定零文件重叠；本 PR 的 delta 仍恰好 11 个文件）。incoming 提交没有一个碰到这些守卫读取的 oracle，且 `pnpm-lock.yaml` 未变——根 `package.json` 的唯一改动是往一个脚本清单里加了一个集成测试文件——故这次没有依赖漂移。由于 84 个 incoming 文件属 cli/core/scripts，整栈重建而非复用：全量构建 **rc=0** 且 core 与 cli 的 dist 按构建起点时间戳断言已刷新（`web-templates` 体积门在此 base 通过），jar 重建，重建 jar 内**四个** sidecar 与已提交契约逐字节相等，`ManagedLoopSkillTest` **19/19**（`Tests run: 19, Failures: 0, Errors: 0, Skipped: 0`），bundle 重建并断言已刷新。臂：`--loop-skill` success（session `8fd6030e-4f2b-4f7f-b9cc-d3ccc8103d2d`、modelRounds 6、cronToolResults 3、create/list/delete 均见证）；`--loop-fire` success（session `55d866f6-37c7-4b6b-98d8-a5f6e9d82cf8`、schedule `asch_4af32a5b77188e883ba652d269dd912e`、fireTrigger=scheduled、fireOutcome=fired、fireState=completed、occurrenceKey `schedule:2026-11-19T15:11:00Z`、modelRounds 5）。本 head 快速套件：core **35/35**、scripts 元 **185/185**（改动文件 89 条加 96 条）；core `tsc --build`、eslint 与 prettier 净。

关于这次运行的两点精确说明。链运行期间唯一的未提交改动是元测试文件，它不是构建、jar、bundle 或任一条臂的输入——allow 站点修复只动测试，故臂证据覆盖它。而上面那些真实 runner 注入是在链**结束之后**做的、并字节级还原，故没有任一条臂跑在被变异的 runner 上。

core 邻近面在本 head 整面跑而非抽样：`src/managed-runtime` 加 `src/skills/bundled/loop` 为 **88 文件 / 4187 测试全绿**。合并还按消费方而非仅按文件重叠核查过：76 个 incoming 测试文件中无一引用本 PR 所改的面——`package.json` 的唯一命中是未改动的 `test:e2e:managed-loop-skill` 脚本定义——故合并不引入 base/head 测试交互。delta 中每个生产与资产文件都 prettier 净。

**本 head 的 CI：必需检查链上一条继承红，已按实测归因。** 落定为 28 通过 / 2 失败 / 40 跳过，两条失败是同一根因——`Linux unit tests (shard 1/2)` 与由它派生的汇总 job `Test (ubuntu-latest, Node 22.x)`（后者是必需检查）。其余三项必需检查通过。失败是 `packages/cli/src/i18n/mustTranslateKeys.test.ts › covers every English locale key in ru`，`AssertionError: expected [ …(7) ] to deeply equal []`，缺的七个键全是 vision-bridge-timeout 文案。它来自 main 的 `ed8a4045ba`（#17830），该提交经第九次合并成为本 head 的祖先且在 `origin/main` 上；本 delta 触碰 i18n 或 vision 文件 0 个；`packages/cli/src/i18n/locales/ru.js` 与整个 `packages/cli/src/i18n` 目录在本 head 与 `origin/main` 之间逐字节相同；这些键在 `ru.js` 中不存在（0 命中）、在 `en.js` 中存在（2 命中）；且在本 head 本地复现（`1 failed | 21 passed (22)`）。它在 CI 两次重试与本地运行中确定性失败，故按 deflake 约定属真 bug 而非非确定性——不重跑、不稳化。两个开放的上游 PR 恰好改该文件（#17857、#17858），均 MERGEABLE 且在等评审，故此处不重复修复：姿态是等任一落地、合并 main 并复跑，与继承的 `web-templates` 预算红（main 在 #17746 修好）一致。归因评论 `issuecomment-7015384854`。

## 开放问题

无阻塞项。
