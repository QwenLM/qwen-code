# verify-pr：加固 #17371 剩余可操作残余

语言：中文 | [English](verify-pr-deferred-residual-hardening.md)

跟踪 issue：#17371。最高优先残余已闭合——R17-1（核心信任边界）由 #17375；
R16-1/R16-2/R16-4 与 D17-1/2/3 由 #17440；R17-2（提前注册活性）由 #17550。
本增量处理剩余**可操作的 below-Critical** 残余（簇 E/F、R5-2 文档 sweep、
第 7/8/12/14 轮延后细化）。**刻意不**触碰已接受的 fail-closed 预算（RS-1/RS-2）
与三条静默丢弃活性窗口，它们仍由 #17371 跟踪。

## 按当前 main 重新枚举

按跟踪纪律，每条残余在动手前都对当前 head 复核；若干已被覆盖或不可复现：

- **D17-11（`--context-root` 无 `--context` 也接受）——已由 #17375 闭合。**
  `verify-pr-check.mjs` 只要供给了 `--context-root` 就校验（「而非仅伴随
  `--context`」），且即便无 `--context` 也拒绝文件系统根（R2-2）。无需改动。
- **D17-10（`evidence/` 符号链接被跟随）——已被 #17440 扫描重写覆盖。**
  nonce 遍历用 `readdirSync(..., { withFileTypes: true })`，仅对
  `entry.isDirectory()` 递归、对 `entry.isFile()` 读取；符号链接两者皆非，
  故被跳过、绝不跟随。补一条见证钉住。
- **第 8 轮 #3（遗留 `--release` 写空列表且无 `seqCounter`）——按所述不可复现。**
  成功的 `--release` 总把被释放 head 追加进 `releasedHeads`，那是承载状态条目，
  故释放后的正文下次读被接纳（实测：遗留无 `seqCounter` 态 → `--release` →
  下一次 `--start` exit 0）。「空列表」前提不可达。仍把文档所述不变量对每个
  写者成立（见下）作为廉价加固，并补见证。
- **D17-14（活性门控的死轮恢复）——即已接受的死轮 `--release`→重启静默丢弃
  窗口**；仍跟踪，不在此改动。
- **第 8 轮 #1（resting-view 准入边界）——本轮不处理。** `readState` 会接纳
  对象值的遗留 head 标记（实测：`{pr: 1, inFlightHead: {}}` 读作 resting），
  阶梯消费不了它，故下一次 `--start` 用空列表重写该文件。被接纳的形状不含
  去重历史，守卫保护的东西没有被抹掉；若要收窄准入，必须继续接纳
  `inFlightHead: null` / `verifiedHead: null` 的遗留 resting 正文（R7-1）。
  仍由 #17371 跟踪。

## 拟议改动

### A. watch-state 助手（`scripts/verify-pr-watch-state.mjs`）

- **A1 —— 每个写者都产出 `seqCounter`。** `releaseRound` 用
  `deriveView({ ...existing, ... })` 构态、不补 `seqCounter`，是唯一可能产出
  带列表却无 `seqCounter` 正文的写者（遗留前列态无可继承）。读守卫的文档不变量
  「`*Heads` 列表蕴含 `seqCounter`」因此并非对每个写者成立。`releaseRound` 现
  设 `seqCounter: Math.max(existing?.seqCounter ?? 0, entry.seq ?? 0)`，与
  `startRound`/`completeRound` 一致。准入、去重与排序对每个形状都不变，且
  写者产出的每个形状写出的计数器逐字节相同（本就 `entry.seq ≤ seqCounter`，
  遗留前列标记不带 seq）。对手改的「标记 seq 高于计数器」或「带 seq 列表却
  无计数器」形状，折叠刻意把持久计数器提到被释放的 seq，使下一次铸号保持
  在其之上（`nextSeq` 从不读 `releasedHeads`）。见证释放一个遗留无
  `seqCounter` 态，断言写出的正文带整数 `seqCounter`；第二条见证种一个低于
  标记 `seq` 的计数器并钉住折叠，仅 `?? 0` 回退即红；第三条种一个高于标记
  seq 的计数器并钉住保留较高值分支，仅 `entry.seq ?? 0` 即红。
- **A2 —— 移除死字段 `sandboxRuntime`（D17-8）。** `verify-pr-prepare.mjs` 的
  `detectIsolation` 返回 `sandboxRuntime`，但无生产消费者读它（调用方用
  `isolated`/`signals`/`seatbelt`）。移除该字段及钉它的 prepare 测试断言。

### B. 检查器（`scripts/verify-pr-check.mjs`）+ 测试

- **B1 —— 上限拒绝文案（第 7 轮 #6）。** 资源上限拒绝建议「把 nonce echo 进
  早日志」，但遍历无序，「早」不控制读取顺序；上限按总字节计。改写去掉顺序
  暗示并点名两种补救——降低非 evidence 日志量，且把日志并成更少的文件或目录
  （目录与空文件计条目上限、不计字节预算，R1-7）——保留 main 的执行审批尾部
  （电池前以 `--execution host|vm` 及其批准参数重跑 prepare；绝不手写声明）。
- **B2 —— 钉上限常量（第 7 轮 #8）。** 拒绝文案的数字曾独立于函数内
  `TOTAL_BUDGET`/`MAX_ENTRIES` 硬编码，常量被悄悄改动不会红（R1-5）。把两个界
  提到模块作用域、用它们拼拒绝文案，并钉渲染出的 `64 MiB total / 20000 entries`
  ——常量改动即红消息钉。两个界导出，skill 侧界句钉由它们拼出（R2-4），常量
  改动无需改 SKILL 也红 skill 钉——面向操作者的契约不会与扫描漂移。
- **B3 —— 按文件/按目录预算见证（第 7 轮 #9）。** 两个界只在扁平单目录夹具上
  断言；补嵌套目录森林证明条目上限聚合、补双文件（2 × 33 MiB）夹具证明字节
  预算聚合——按目录/按文件重置各使其夹具红（R1-6）。

### C. skill 契约（`.qwen/skills/verify-pr/SKILL.md`）

- **C1 —— nonce 扫描界文案（第 7 轮 #2）。** nonce 契约漏写扫描的 64 MiB/
  20000 条目界，合规轮也可能被拒而操作者不知其因。补一句点名该界与两种补救
  （降低非 evidence 日志量/并成更少的文件或目录/经批准以 `--execution host|vm`
  重跑 prepare）。
- **C2 —— nonce 声称限定为「无法产出」（第 7 轮 #3）。** step-5 echo 把 nonce
  明文放进 PR 可写日志，故「宿主电池读不到 nonce」强于所证。绑定在于宿主电池
  没有容器本地明文就**无法产出**匹配的 `container-nonce:` 行。据此改写，并把
  声称限定为 echo 实际所证——harness 在 echo 时读到了容器本地值，而非电池在
  容器内运行：echo 副本随共享挂载可见，任何后续拿到 round dir 的写者都能复用
  该行（R1-1）。step-7 注释同批对齐。
- **C3 —— R12-D4 moved-head 终态组。** moved-head 指引说启动 release 的
  deferred 列表点名的 head，但该列表还带「多次 inconclusive 后终态 not-covered」
  组，无新 head move 不得启动。在 moved-head 措辞与读同一份 release 输出的
  exit-3 死标记条目中都再排除终态组——后者的「启动最后一个 deferred head」
  限定到 awaiting 组，因为终态组打印在最后（R1-2）。
- **C4 —— 第 14 轮 prose 结构项，评估而不反复改。** :786 项（moved-head
  release `--round <r>`「在重启改编号后」）是已核实的 bot 误读：moved-head 分支
  释放**本轮**标记且**不**重启，故 `--round <r>` 正确（`<r+1>` 改编号属于另一条
  死轮恢复分支）。:261/:278/:767 项是 below-Critical 的 prose 结构细节，其实质
  已由相邻澄清承载（注册是 watch/复验程序、而非全新 `/verify-pr <n>`；瞬时情形
  重试 prepare 不 release）。它们作为打磨项继续由 #17371 跟踪，不在此反复改，
  以免陷入不收敛的 prose 循环。
- **C5 —— 把撤回并入开头句（R2-1）。** 第 1 轮把 echo 时限定追加在仍声称绑定
  「ties the `mode:"container"` declaration to execution inside this container」
  的开头句之下，使段落同时断言两件相反的事。把开头句改写为：绑定的是 harness
  在 echo 时读到的容器本地值——而非在容器内执行——并在现有 nonce 负向钉旁对
  被撤回的开头句加负向钉。

### D. prepare（`scripts/verify-pr-prepare.mjs`）+ 测试

- **D1 —— `homedir()` 抛出见证（第 7 轮 #4）。** R5-1 home 拒绝守卫仅经 catch 后
  `home:null` 接缝演练；补一条注入真正抛出的 `homedir` 的见证，证明惰性
  try/catch 到达 exit-3 拒绝（而非逃逸 exit 1）。
- **D2 —— 对齐门禁 nonce 注释（R2-5）。** `requireBoundary` 的 nonce 注释仍写
  绑定「ties the declaration to execution inside THIS container」与
  「corroborates an operator who ran the round in the container」，与 R1-1 后的
  skill/checker 矛盾。改写为 echo 时限定（仅哈希记录证明 harness 在 echo 时
  持有容器本地明文；echo 行随 PR 可写 round dir 可见，故不说明电池在哪里运行），
  并补 prepare 源码钉，使恢复被撤回声称即红。

### E. 文本钉套件（`scripts/tests/qwen-triage-workflow.test.js`）

- **E1 —— VM 负向钉（第 7 轮 #7）。** R16-4/R3-4 VM 文案修复只正向钉；补
  `not.toContain` 断言被撤回的 preflight 句（把 VM 送进 `--require-isolation`）已消失。
- **E2 —— R12-D5 精确注册钉。** 无 `--artifact-dir` 注册钉对 `--start` 命令
  前缀匹配，flag 可被重新追加到命令末尾而钉仍绿。收紧为完整命令形式。
- **E3 —— 第 14 轮钉守卫。** 补手动节顺序钉左操作数（及 watch 标题钉右操作数）
  缺失的存在性守卫，并把 `<dir>` 来源钉限定到 watch prompt 自己的切片，使手动
  副本不作不在场证明。
- **E4 —— 第 2 轮钉纠正。** R2-1：在折叠后的限定声称旁，对被撤回的
  「ties the declaration to execution inside this container」开头句加负向钉。
  R2-3：nonce 负向钉改钉被撤回的整句，而非其中为真的原子。R2-4：skill 界句钉
  由导出的 `TOTAL_BUDGET` / `MAX_ENTRIES` 拼出，常量改动无需改 SKILL 即红。
  R2-5：prepare 源码钉使门禁 nonce 注释保持 echo 时限定。

### F. 文档 sweep（双语）

- **F1 —— R5-2 Java 配方 waived 模型协调。** 原始 head 曾把
  `docs/design/2026-11-14-verify-pr-java-container-recipe.md`（+ `.zh-CN.md`）
  全文统一为单一自洽 `mode:"waived"` 模型。main 的执行审批重写（#18064、
  #18539）此后重新表述了整份配方：prepare 在预置前执行批准下写出 `waived`
  声明，预置门禁只是可选溯源，容器在 `--reason` 点名、而非手写 `detail`。
  合并双语照单采纳 main 的配方；本 PR 不再编辑该配方对。
- **F2 —— `verify-pr-watch.md` null 目录。** 规范 watch 设计仍称每条状态带产物
  目录；提前注册（#17550）允许在飞标记 `null` 目录。修正（+ `.zh-CN.md`）。
- **F3 —— `verify-pr-residual-hardening.md` Files-affected 完整性。** 清单列了
  PR 14 个文件中的 8 个；把文档对也枚举（+ `.zh-CN.md`）。
- **F4 —— 第 14 轮 register-ahead 文档。** 在范围边界注明 prepare 成功后的 head
  比对。残余(3)恢复配方保留「从状态文件读出死轮编号传入（仅遗留无 round 标记
  可省略）」的指引；合并采纳 main 的可选 `--round` / 重启于 `<r>` 形式，
  registration-nonce 守卫如今为其兜底（+ `.zh-CN.md`）。

## 关键设计决定

- **先重新枚举再修。** 已被跟进 PR 闭合（D17-11）、被重写覆盖（D17-10）、或
  不可复现（第 8 轮 #3）的项如实记录，而非再「修」一遍；保留唯一不变量加固
  （A1）因其廉价且使文档声称成立。
- **已接受风险保持接受。** RS-1/RS-2（fail-closed 预算）与三条静默丢弃窗口是
  维护者接受的活性/可用性取舍；超出范围，仍由 #17371 跟踪。
- **尽量 prose/测试-only。** 生产改动都很小——三个文件：A1（一个字段）、
  A2（移除死字段）、B1/B2（拒绝文案，现由提升后的界常量拼出）、D1
  （`requireBoundary` 上的测试接缝）；其余皆 prose、文档或测试加固，影响面小
  且每项有见证。

## 涉及文件

- `scripts/verify-pr-watch-state.mjs`（A1）、`scripts/verify-pr-prepare.mjs`
  （A2、D1）。
- `scripts/verify-pr-check.mjs`（B1、B2）。
- `.qwen/skills/verify-pr/SKILL.md`（C1–C4）。
- `scripts/tests/verify-pr-watch-state.test.js`（A1 见证）、
  `scripts/tests/verify-pr-prepare.test.js`（A2、D1）、
  `scripts/tests/verify-pr-check.test.js`（B2、B3、D17-10 见证）、
  `scripts/tests/qwen-triage-workflow.test.js`（C/E 钉）。
- `docs/design/verify-pr-watch.md` + `.zh-CN.md`（F2）、
  `docs/design/verify-pr-residual-hardening.md` + `.zh-CN.md`（F3）、
  `docs/design/verify-pr-register-ahead-of-prepare.md` + `.zh-CN.md`（F4）、
  以及本设计文档对。Java 配方对（F1）合并后与 main 一致，不再在此编辑。

## 范围边界

- 仅上述可操作 below-Critical 残余。watch-gate 所有权/游标、去重/defer/release
  语义、信任边界检查（R17-1，已闭合）均不变。RS-1/RS-2 与三条静默丢弃窗口保持
  接受并由 #17371 跟踪。

## 待决问题

- 簇 F 中含糊的测试质量项（D17-4/5/6/9：ambient-gated 通过路径测试、quote-blind
  钉、到不了写点的 replay、渲染 Markdown 披露匹配）记录于 #17185 findings
  artifact；需要该 artifact 确切夹具细节的项继续跟踪，不在此凭猜测修。
