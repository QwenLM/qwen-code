# verify-pr：加固 watch-state 形状守卫、容器 nonce 与 VM 文案

语言：[English](verify-pr-residual-hardening.md) | 中文

跟踪 issue：#17371（#17185 的 land-with-residual-risk 决定与 #17375 第 8 轮接受所
接受的残余风险）。本改动关闭该清单中三个便宜、自包含的簇：**A**（watch-state 形状
守卫，R16-2 / D17-3）、**B**（容器 nonce 完整性，R16-1 / D17-1 / D17-2）、**C**
（VM 文案矛盾，R16-4）。核心信任边界（宿主持有的权威 `--context` 快照 + sha256 内容
绑定）已在 #17375 落地，本改动不触碰。

## 问题陈述与现状

### A —— watch-state 形状守卫被纯身份键满足

`readState`（`scripts/verify-pr-watch-state.mjs`）对「键全未知」的良构对象 fail
closed，使手写正文不会被读作「无状态」而让 `--start` 从空列表重写文件。但已知集合
`STATE_KEYS` 把**身份**键（`pr`、`repo`、`round`、`artifactDir`、`startedAt`、
`completedAt`、`verdict`、`commentId`）与**承载状态**键（`inFlightHeads`、
`verifiedHeads`、`seqCounter`……）混在一起。形如
`{"pr":1,"startedAt":"…","inflightHead":"abc"}`（一个身份键加一个拼错的 head 标记）
的正文即可满足守卫、产出无可迁移的在飞 head，随后 `--start` 重置文件——抹掉操作者
本想用该拼错标记阻挡的内容。这是 R16-2；D17-3 是同簇 `inFlightEntries` 加宽的遗留
迁移（接受字符串 `inFlight` head）。

本助手写出的每个状态都带承载状态键：`startRound` 与 `completeRound` 总是产出
`inFlightHeads`、`verifiedHeads`、`deferredHeads`、`releasedHeads`、`retiredSeqs`、
`seqCounter`，`deriveView` 再补派生的 `verifiedHead` / `previousHead` /
`inFlightHead` / `inFlight`。因此要求一个承载状态键绝不会拒掉合法状态。

### B —— 容器 nonce 明文随 PR 可写的 gate 记录一起落盘

`requireBoundary`（`scripts/verify-pr-prepare.mjs`）把每轮 nonce 写到容器本地
`$HOME/.qwen-verify-nonce`，**并**把同一明文存进 `boundary-gate.json`（`nonce`）。
产物树是 PR 可写的，所以在宿主上跑的电池可以把明文从记录里抄进日志、伪造
`mode:"container"`，根本不必读容器本地文件。step-7 的 shell 配方*从那份同一 PR 可写
记录*取出期望 nonce 再在轮目录里 grep 它，判据来源由攻击者提供：该检查佐证的是「某个
值被抄进了日志」，而非「电池跑在容器内」（R16-1）。D17-1 是 step 7 为判据读取 PR 可写
记录；D17-2 是拒绝文案里的逃生口措辞。

记录自身的正文已承认它「不是对抗同时伪造记录与日志的轮的证明」。它*应当*关闭的威胁
是事故形状：操作者在宿主上跑了轮、跳过了容器门禁。

### C —— VM 文案与 VM 条目矛盾

preflight 段（`.qwen/skills/verify-pr/SKILL.md`，约 280 行）在紧接着为容器路径规定
`--require-isolation --artifact-dir <round-dir>` 之后说「a VM boundary runs the
same file from the trusted checkout instead」。其上方的 VM 条目（约 208 行）明说
VM 路径**不跑** `--require-isolation` 门禁。这句未限定的话可能把 VM 操作者推向跑容器
门禁（R16-4）。

## 提议改动

### A —— 要求承载状态键（fail closed）

形状守卫**从迁移梯实际消费的内容推导**，使守卫的接纳与梯的消费不可能分叉（R2-1）。
正文在 `inFlightEntries`、`verifiedEntries`、`deferredEntries`、`releasedEntries`
之一产出条目，或 `seqCounter` 为整数，或 `retiredSeqs` 为非空对象时被接纳。早于
列表/seqCounter 格式的遗留 resting 正文——只含身份键与前列单标记 head 键
（`inFlight`/`inFlightHead`/`verifiedHead`/`previousHead`），且全持 resting 值
（null/空/false）——按无状态接纳：梯把它消费为 resting，拒绝它会让一个状态不含任何去重
历史的 PR 再也无法开轮（R7-1）。resting 分支限定于遗留单标记键：携带 `*Heads` **列表**键
（即使为空）的正文是新格式，而新格式总写 `seqCounter`，故无承载条目的空列表仍被拒。
其余无可消费承载条目的正文像损坏 JSON 一样 fail closed；「身份键 + 拼错（**未知**）的 head
标记」同样被拒（R16-2）。独立于该析取式，一个**存在**但持非数组值的 `*Heads` 键（裸字符串
`inFlightHeads:"<hex>"`）即使整数 `seqCounter` 已接纳该文件也被拒——梯无法消费该标记，
`--start` 否则会抹掉它，破坏「同一 PR 只跑一轮」的串行化（R6-1）。`inFlightEntries` 即使在
_resting_ 的空 `inFlightHeads: []` 旁也消费裸 `inFlightHead`（非空字符串）以及字符串
`inFlight`，故标记阻挡第二轮并在被拒的 start 后存活（R1-1、R2-1）。助手写出的每个状态都经
`deriveView`，产出数组列表加整数 `seqCounter`（以及派生的 `inFlight:false` /
`inFlightHead:null` resting 视图），故合法文件绝不会被拒。见证钉住可消费形状、遗留 resting
正文的接纳、被拒的不可消费形状（带与不带承载 `seqCounter` 的数组键下字符串、无承载条目的
空列表、未知 head 拼写），与遗留迁移边界（非空字符串 head 迁移并阻挡；`inFlight:true` 或
单独对象被拒；空串是 resting——被接纳但绝不迁移去阻挡某个 head）。

### B —— 记录只存 nonce 哈希；佐证由 checker 强制

- `requireBoundary` 在记录里存 `nonceSha256`（明文的 sha256）而非明文 `nonce`。明文
  只写到容器本地 `$HOME/.qwen-verify-nonce`。宿主电池无法从哈希还原明文，因此产不出
  匹配的日志行。
- `verify-pr-check.mjs` 新增权威的机器强制层：`containerNonceErrors(boundaryText,
gateText, roundDir)`，由 `main` 调用（轮目录在那里可用，`checkArtifacts` 没
  有）。对由 `require-isolation` 记录支撑的 `mode:"container"` 声明，要求
  `gate.nonceSha256`（64 位十六进制串）**且**轮日志里有一行 `container-nonce:
<value>`，其值的 sha256 等于它。扫描遍历轮目录，跳过 `boundary.json` /
  `boundary-gate.json`、**顶层** `evidence/` 子树（skill 的二进制 PNG 产物——嵌套的
  evidence 目录仍被扫描，R4-5）与非常规文件（不跟随符号链接）。分块读取每个常规文件
  **整体**，并在截断 carry **之前**先扫描跨块半行，使其头部的 marker 不丢失（R3-3）
  ——落在更早输出之后或跨块边界的 marker 仍被找到。**聚合**工作量有界：一个复用的
  1 MiB 暂存缓冲（无每文件分配）、整趟 64 MiB 总字节预算、以及把目录也计入的 20000
  访问条目上限（R1-2、R2-5、R4-4）。扫描返回是否因界而停，故资源耗尽获得与「无匹配行」
  不同的专属拒绝文案（R4-1）。哈希缺失/不匹配或无匹配行即拒绝容器声明。检查**无条件**
  执行：豁免基于**记录**而非旗标——
  `containerNonceErrors` 对 `ci-lane` 记录与非 container 模式返回 `[]`，故
  `--publish-lane`（R1-7）与 `$QWEN_VERIFY_CONTEXT`（R2-7）都不能为
  `require-isolation` 容器声明关掉该绑定。
- 容器本地 nonce 写入是门禁的一部分：`$HOME` 不可写或缺失时，门禁在通过行之前以
  exit 3 失败并使任何陈旧通过记录失效，而不是静默写下一个明文无处存在的记录、让该轮
  直到电池跑完才无法认证（R1-4、R2-4）。`$HOME` 惰性且防御性地解析：`os.homedir()`
  抛出（该 UID 无 passwd 条目且 HOME 未设置）或返回 `''`（HOME 已设置但为空）都到达
  同一 exit-3 拒绝——绝不是跳过失效的未捕获抛出（exit 1），也绝不是把明文写进 PR 可写
  CWD 的相对 `join('', …)` 写入（R5-1）。
- step-7 的 shell **不再重复实现 nonce 匹配**：checker 是**唯一**权威匹配器，消除
  shell↔checker 分叉（R1-2、R2-6）以及在 PR 投放的长行上卡死的第二匹配器（R1-3）。
  shell 仍写声明并调用 checker，由 checker 拒绝宿主电池；nonce 接纳/拒绝/对齐见证移至
  checker 单测与真实环境往返。step-5 与 boundary-gate 正文说明记录携带哈希、绝不携带
  明文，电池须 echo 一行从容器本地文件读出的 `container-nonce:`。
- `requireBoundary` 加可选 `{env, exists, home}` 接缝（其检测器本就接受）并导出，使
  一个无门控单测见证能在裸宿主上演练只含哈希的记录写入；gate-pass 路径否则受 observed
  容器标记环境门控。
- D17-2：拒绝文案明确 `mode:"waived"` 需要维护者批准——不是免费绕过。

这在为 `require-isolation` 记录关闭宿主抄录路径的同时保持已承认的边界诚实：同时伪造
该记录 nonce 哈希与匹配日志行的轮仍在范围外（记录佐证的是跳过门禁的操作者，而非同时
伪造两者的 PR 代码）。CI 发布作业自己的 `ci-lane` 记录是另一条受信任车道：仅在
`--publish-lane` / CI 入口路径下被采纳，豁免 nonce 绑定（发布作业在它拥有的车道内写它），
故「同时伪造两者」的门槛点名的是 `require-isolation` 容器路径，而非该车道（R5 延后）。

### C —— 限定 VM 句

把 preflight 句——在 skill 与 prepare 打印的指引中均——改写为「a VM boundary takes the
same trusted copy but runs **no `--require-isolation` gate** … there is no in-boundary
gate command and no `boundary-gate.json` to produce — declare `mode:"vm"` per the VM
bullet above」，与 VM 条目一致。attestation 注解点名操作者已确认的内容（无挂载、无宿主
凭据），绝非反义的「what the VM mounts」；任何文案都不处方不带门禁的 `--artifact-dir`
调用——parseArgs 拒绝它（R3-4）。

## 涉及文件

- `scripts/verify-pr-watch-state.mjs` —— 梯推导形状守卫；遗留 resting 正文（身份键 +
  前列单标记键，全 resting 值）按无状态接纳（R7-1）；存在但持非数组值的 `*Heads`
  键独立于承载析取式被拒（R6-1）；`inFlightEntries` 在空列表旁也消费裸遗留标记。
- `scripts/verify-pr-prepare.mjs` —— 记录 `nonceSha256`，去掉明文 `nonce`；致命 nonce
  写入（exit 3）使陈旧记录失效；`$HOME` 惰性防御解析，不可解析/空 home 以 exit-3 拒绝
  （R5-1）；VM 指引注解与调用修正（R3-4）；导出 `requireBoundary` 并加
  `{env, exists, home}` 接缝。
- `scripts/verify-pr-check.mjs` —— `containerNonceErrors` + 整文件聚合界日志扫描，由
  `main` 无条件调用。
- `.qwen/skills/verify-pr/SKILL.md` —— step-5 nonce 正文、step-7 shell nonce 匹配移除
  （checker 唯一匹配器）、VM 句限定（R3-4）。
- `scripts/tests/verify-pr-watch-state.test.js` —— 可消费/不可消费形状见证、纯身份
  fail-closed、迁移边界见证、带 `seqCounter` 的非数组 `*Heads` 拒绝 + resting 文件接纳
  （R6-1）、遗留 resting 正文接纳且未知键与无承载列表拒绝保持（R7-1；空遗留 head
  夹具不再注入 `seqCounter:0`）。
- `scripts/tests/verify-pr-prepare.test.js` —— 门控记录断言、经接缝的无门控只含哈希
  记录见证、陈旧记录失效见证、不可解析/空 home 拒绝见证（R5-1）、修正后的 VM 指引钉
  （R3-4）。
- `scripts/tests/verify-pr-check.test.js` —— `containerNonceErrors` 见证（匹配行接纳；
  哈希/行缺失或不匹配拒绝；不跟随 symlink；ci-lane/非容器豁免；整文件与跨块读取；
  行语义对齐；目录与文件条目上限见证，R5-3）+ CLI 拒绝见证（`--publish-lane`、
  `$QWEN_VERIFY_CONTEXT`）；容器夹具携带 `nonceSha256` 与日志行。
- `scripts/tests/qwen-triage-workflow.test.js` —— step-5 flat 钉、VM 限定钉、checker
  唯一匹配器钉、step-5↔checker nonce 拼写钉（R6 延后）；shim-node replay 保留
  声明/teardown 见证（nonce 见证移至 checker 测试）。

## 范围边界

- 簇 D（R17-2 活性）、E（R8 长尾）、F（D17-4…14）仍由 #17371 跟踪；本改动不触碰。
  Java 配方全文统一为单一 waived 模型的协调 sweep（R5-2：step 1 的 Node 理由、step 4
  的开头、校验计划、验收标准，以及避开 waived 矛盾告警的报告 `**Boundary.**` 行措辞）
  是该提案文档中 bot 已延后的 Suggestion，记录于 #17371 而非本轮落地（PR 已过五轮
  收敛姿态）。
- 核心 `--context` 信任边界与 sha256 内容绑定（#17375）不变。
- 不新增脚本或 CLI 入口；checker 加一个依赖目录的 nonce 检查并成为**唯一**匹配器——
  step-7 shell 不再重复实现（#17185 的铸声明前 shell 拒绝由权威 checker 拒绝取代，后者
  在发布前运行）。`requireBoundary` 仅作可测试性接缝导出，与已导出的检测器一致。
- 单记录/单 nonce 绑定约束多容器 Java 配方（R1-10、R3-6）：checker 只读一份记录与一个
  哈希，`container-nonce:` 行必须由跑电池的容器 echo。电池跑在与门禁不同容器的轮次读不到
  门禁的明文，故按 skill 的 step 5 经维护者批准声明 `mode:"waived"`；门禁容器的佐证不能
  替代。该配方在 step 1（nonce 绑定）与 step 4（`mode:"waived"` 声明示例）双语记录此约束；
  它是提案，非已发布代码。

## 待决问题

- 无阻塞项。nonce 强制为**单一实现**（checker），由 node 单测与真实环境往返见证；
  移除 shell 的第二匹配器消除了评审循环不断再生的对齐分叉（R1-2/R2-2/R2-3/R2-6）。
  记录只含哈希，故匹配器不从 PR 可写记录读取明文判据。聚合字节预算意味着总计超过
  64 MiB 的日志不被扫描（fail closed）；合法轮次的日志远低于该界。
