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
- **无运行时*代码*改动；模型面向的 skill 内容确有改动。** 没有运行时模块 import managed-loop-skill.ts——其消费方只有 regenerator 与它自己的测试——分类器 helper 住在 E2E runner 的假模型，不在 shipped 代码里。但 `Nd` 修复改了 bundled `SKILL.md`，该文件随构建发布并由 `readBundledReference` 在运行时读取，故模型看到的本地 `/loop` 指引确实变了（这正是预期的正确性修复），Managed sidecar JSON（构建时拷贝到 Java classpath）亦然。本 PR 给 managed-loop-skill.ts 新增的两个 import（`LOOP_SENTINEL_DYNAMIC`、`AUTONOMOUS_SENTINEL_DYNAMIC`）是 allow-list 取源的哨兵常量，并不使生成器成为运行时模块。

## 涉及文件

| 文件                                                                                            | 变更                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.ts`                                   | MANAGED_LOOP_PROFILES + 派生类型；Nd 替换；assertSentinelsExpanded allow-list               |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.test.ts`                              | profile 单一来源；Parsing 库存；allow-list 测试；槽编译器派生 Nd caveat；Java 提供+路由集合 |
| `packages/core/src/skills/bundled/loop/SKILL.md`                                                | Nd 表行 + 月界 caveat                                                                       |
| `packages/core/src/managed-runtime/contracts/managed-loop-skill-{cron,union,bundled-body}.json` | 重生                                                                                        |
| `scripts/run-managed-agent-server-e2e.ts`                                                       | classifierBlockAnswer + mintedScheduleId helper；两个 fake 都用它们                         |
| `scripts/tests/managed-agent-server-e2e.test.js`                                                | fake createdId 钉；分类器 + minted-id 可执行测试；AST 分类器接线钉                          |

## 范围边界

仅六条点名延后项。其余约 64 条延后条目（文档陈旧声明、Java 死分支、child-catalog 缺口、其它探针）范围外，需各自对当前 code triage。无 Java 源码改动；无新 CI 臂。

## 验收标准

- core parity 套件绿（33 测试），含 bundled 与各 shell 的 Parsing 库存、allow-list 与调用点测试、sidecar 集合钉、Java 提供集合与 profile→key 路由映射、解析器派生的 caveat 子句、双求值器一致性，及重生 sidecar 逐字节 parity。
- scripts 元套件绿（183 测试），含 fake createdId 钉、可执行分类器收窄、可执行 minted-id 提取与被执行的分类器接线扫描器。
- 变异见证：additive-fallback 分类器变异使非 block 方向红；deny-list 哨兵回退使新哨兵方向红；伪造 fake createdId 使其钉红；删除 Parsing 规则使库存钉红；门后 sibling fallback（第二绑定、换 call id 或手搭 tool call）使分类器接线钉红；`let` 决策在门后重赋值为内联 allow 使构造点集合红；对决策的 `??=` 改写使重赋值集合红；伪造 schema-properties 初始化式使来源集合红；caveat 上界改 N ≤ 45 使派生断言红，调低 Managed 编译器日域上界同样红；删 Java `SHELL_V3` 路由分支使路由目标集合红。含绑定名、allow 字面量与工具名的注释保持绿。各字节级还原复绿。
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
- **Java 服务集合钉（R2-1）。** profile 单一来源跨过 TypeScript 边界：parity 断言读 `ManagedLoopSkill.java` 的 `sidecars()` 键，要求（去掉仅来源比对的 `bundled` 键）等于 `MANAGED_LOOP_PROFILES`。该 map 只*提供* body；某 workspace profile 能否到达由 `forProfile()` 手工路由链决定，round 3 一并钉住——原理由指错了机制（见 Round-3）。
- **可执行 minted-id helper（R2-2）。** fake 侧提取合并为顶层纯函数 `mintedScheduleId(messages, createCallId)`（返回 `undefined`，绝不编造 id），两臂共用并在元测试对敌意历史执行；仅源码拼写计数会漏掉伪造 `?? 'asch_' + '0'.repeat(32)` fallback 且挡住合并。调用点与显式失败 `?? 'missing-schedule-id'` fallback 上钉。
- **classifier 门钉（R2-3）。** 对 `if (blockAnswer !== undefined) {`（两臂）计数钉，堵住「门改宽」（`if (blockProperties !== undefined)` + `blockAnswer ?? {…}`）——该拼写在赋值计数仍为 2 时复活误答。
- **替换单元钉（R2-4）。** managed Nd 修复的 `sub()` 替换串上钉（`midnight UTC on days 1, 1+N, … of each month`、`not.toContain('every N days')`）加示例间隔，使回退替换串并重生不能在全绿下重新教「every N days」。

## 验证报告跟进

独立 `/verify-pr` 轮在首个精化 head 上报了两条发现与一条 nit，三者均在此关闭：

- **N ≤ 31 多算一档（low）。** 与第二轮评审抓到的 critical 同一缺陷；由上文 N ≤ 30 修正关闭。
- **调用点之后的 sibling fallback（覆盖缺口）。** 语句锚定计数钉看不到写在门*之后*的 fallback（`if (blockAnswer === undefined) return …allow…`）：两个计数仍为 2，而 fire fake 重新误答侧查询，只在打包臂可见。首次响应改为「数成分」——block allow 字面量与决策变量引用计数。round 3 随后证明：经 helper 在*第二个绑定*下重新推导 allow 的 sibling 两个成分都不新增，故那两条计数同样盲；且对原始源码文本计数会因注释仅提到绑定而以难定位的计数不匹配变红。两者均被 AST 接线钉取代（见 Round-3）；成分计数已移除，结构化钉不再需要为计数无歧义而改写注释。
- **parity 计数陈旧（nit）。** PR 正文与上文验收标准改为当前套件规模（core 32、scripts 元 183）与最新真实栈 occurrence key。

## Round-3 评审精化

第三轮发了三条建议，都是同一根因的实例：钉子断言的是拼写，而非它声称守护的机制。三条均改为结构化断言并见证。

- **分类器接线钉结构而非 token（R2-3，修复引入）。** 成分计数看不到「经 `classifierBlockAnswer` 在第二个绑定下重推 allow」的门后 sibling（字面量计数与 `blockAnswer` 引用计数都不动），且计数跑在原始源码文本上，注释仅提到绑定就会以难定位的计数不匹配变红。改用 `loopClassifierWiring`——对两个 loop fake 的 AST 库存：由 helper 以 schema 自身 properties 初始化的 `blockAnswer` 绑定、`!== undefined` 门、每个 `respond_in_schema` `fakeToolCall` 的 answer 表达式（不论 call id 一律收集，使 sibling 无法藏在新 call id 后；每个 loop classifier call id 恰一个，且必须是该被门控的绑定本身），以及 `respond_in_schema` 字符串字面量计数（使绕过 `fakeToolCall` 手搭的 tool call 也可见）。扫描器对敌意 fake 执行，故不会空转：第二绑定的 sibling 被检出，散文提到绑定与工具名不改任何计数。见证：报告点名的 sibling 使 answer 站点集合红，而旧计数仍为 1 与 6；换 call id 的 sibling 使同一集合红；手搭 tool call 使字面量库存红；含 `blockAnswer`、`shouldBlock: false` 与 `respond_in_schema` 的注释保持绿；此前已覆盖的 usage 行 `?? { shouldBlock: false }` fallback 仍红，且报错直接点名该表达式而非计数。Round-4 在同一扫描器上补入 allow 构造点、决策重赋值与 schema-properties 来源。
- **caveat 算术由解析器派生（R3-1）。** 上界与示例原是手写散文钉——这正是 `Keep N ≤ 31` 穿过两轮的原因。测试改为派生「日集合仍收集多于一天的最大步长」（30），并由 `*/2` 日集合派生两个月界间隔（30 天月→2、31 天月→1），要求 cron 与 union body 含这些派生值。见证：caveat 改 `Keep N ≤ 45` 并重生 sidecar 使派生断言红。本轮用的是 `utils/cronParser`；Round-4 把 oracle 换成真正触发这些 body 的 Managed 槽编译器。
- **Java 钉覆盖路由而非仅提供（R3-2）。** `sidecars()` 只提供 body；`forProfile()` 手工链决定哪个 workspace profile 能到达，故往 tuple 追加 profile 时本 PR 新增的每道门都绿，却没有任何 profile 路由到其 body。parity 测试现同时要求 `key = "…";` 路由目标集合等于 `MANAGED_LOOP_PROFILES`。无 creator 的 profile 路由到 null 且不赋 key，故 `ManagedLoopSkillTest` 的 null 期望不受影响。见证：删 `SHELL_V3` → `wakeup` 分支使路由集合红，而 sidecar 键断言仍通过。

## Round-4 评审精化

第四轮发了三条建议，其中两条是 round-3 替换自身引入的。三条都在修本 PR 新增的守卫、而非扩大其范围，故在本 PR 落地；round-3 摘要声明的边界仍然有效——若再有一轮在这两个测试文件再生兄弟发现，转后续 issue。

- **构造点与重赋值（R2-3，修复引入）。** 替换成分计数时丢掉了唯一断言「allow 在*何处*构造」的检查，而 AST 库存既不查对象字面量也不查重赋值：`let blockAnswer = …; if (blockAnswer === undefined) blockAnswer = { shouldBlock: false };` 使 round-3 全部断言保持绿，而非 block 侧查询又被答以非法 allow。扫描器现收集每个 `{ shouldBlock: false }` 构造点及其所在函数（恰一个，位于 `classifierBlockAnswer` 内），以及决策或其输入在任意赋值运算符下的每次重赋值（零次——`??=` 与 `||=` 恰在决策为 undefined 即非 block 情形时赋值，只查 `=` 会漏）。仍是结构化的，故恢复的保证不依赖原始文本计数、对注释免疫。见证：报告的 `let` + 重赋值变异使构造点集合红；`??=` 重赋值为经 helper 推导的 allow（不新增字面量、不新增 answer 站点）使重赋值集合红；round-3 的第二绑定 sibling 仍使 answer 站点集合红（连续性）。
- **schema properties 的来源（R4-1）。** declarations 库存只记录实参 token `blockProperties`，故伪造初始化式（`schemaTool ? { shouldBlock: { type: 'boolean' } } : undefined`）能通过，同时让每个侧查询看起来都是 block schema。扫描器现记录每个 `blockProperties` 初始化式文本，要求两臂都读 `schemaTool?.function?.parameters?.properties`。见证：伪造任一臂初始化式使来源集合红，其余库存仍绿。
- **Managed caveat 的正确 oracle（R3-1，修复引入）。** round-3 从 `utils/cronParser` 派生上界与间隔，而它服务本地 CLI 调度器；Managed body 由 Java `CronSlots` 扫描器触发，其 TS 镜像是 `managed-automation-slots.ts` 的 `compileCron`。用错解析器会让一次 Managed 槽语义改动之后，caveat 继续教一个 Managed 调度器已不再遵守的上界。测试改从 `compileCron` 派生（日域与 `CronSlots.java` 同为 `[1, 31]`）。见证：把 Managed 编译器日域上界调到 30 使派生断言红（`Keep N ≤ 29`）——旧 oracle 对该变异盲；模块字节级还原后回到 32/32。

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
- **记录纠正。** 设计记录与 PR Risk 段原称「无生产运行时改动 / 无运行时 import」。对代码核实：没有运行时模块 import 生成器，但 bundled `SKILL.md` 随构建发布并由 `readBundledReference` 在运行时读取，故模型面向内容确有改动。两版文档与 PR 正文改为「无运行时*代码*改动；发布的 skill 内容有改动」。修复 #1 的描述仍指 round-2 之前的内联正则与过滤，现改为描述 `mintedScheduleId`。
- **转 #17673：把 caveat 的 oracle 绑定到 `CronSlots.java`。** 共享 `managed-automation-slots-v1` fixtures（30 案例）无月内日期步进案例，故 Java 求值器在 `*/N` 上未与 TS 镜像绑定。关闭它需新增同时被 `managed-automation-slots.test.ts` 与 `CronSlotsTest.java` 消费的 fixture 案例并跑 Java verification 套件——属跨语言契约改动，留在本 PR 之外。上文双求值器一致性只覆盖 JavaScript 侧。

见证（各字节级还原）：成员写入、`Object.assign`、模板字面量 sibling、gap 对调、路由 key 对调、删 cron 的 `No interval` 规则、令 `parseCron` 分歧，各使对应断言红；拼写 `key = "wakeup";` 的 Java 注释保持绿；此前形态（第二绑定、换 call id、手搭 tool call、`let` + 内联 allow、`??=`、伪造来源、usage 行 `??`）全部仍红，提到绑定名的注释保持绿。core 33/33、scripts 元 183/183、eslint/prettier/core typecheck 净。

## 开放问题

无阻塞项。
