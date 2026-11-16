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
正文仅在 `inFlightEntries`、`verifiedEntries`、`deferredEntries`、`releasedEntries`
之一产出条目，或 `seqCounter` 为整数，或 `retiredSeqs` 为非空对象时才被接纳。梯拒绝
其值的键——数组键下的字符串（`inFlightHeads:"<hex>"`）、无遗留标记的空列表——不计入，
于是像损坏 JSON 一样 fail closed，而非被接纳后抹掉；「身份键 + 拼错的 head 标记」同样
被拒（R16-2）。`inFlightEntries` 即使在*resting* 的空 `inFlightHeads: []` 旁也消费裸
`inFlightHead`（非空字符串）以及字符串 `inFlight`，故标记阻挡第二轮并在被拒的 start
后存活（R1-1、R2-1）。助手写出的每个状态都经 `deriveView`，产出数组列表加整数
`seqCounter`，故合法文件绝不会被拒。见证钉住可消费形状、被拒的不可消费形状（数组键下
字符串、空列表）与遗留迁移边界（`inFlight:true`、空串或单独对象不迁移）。

### B —— 记录只存 nonce 哈希；佐证由 checker 强制

- `requireBoundary` 在记录里存 `nonceSha256`（明文的 sha256）而非明文 `nonce`。明文
  只写到容器本地 `$HOME/.qwen-verify-nonce`。宿主电池无法从哈希还原明文，因此产不出
  匹配的日志行。
- `verify-pr-check.mjs` 新增权威的机器强制层：`containerNonceErrors(boundaryText,
gateText, roundDir)`，由 `main` 调用（轮目录在那里可用，`checkArtifacts` 没
  有）。对由 `require-isolation` 记录支撑的 `mode:"container"` 声明，要求
  `gate.nonceSha256`（64 位十六进制串）**且**轮日志里有一行 `container-nonce:
<value>`，其值的 sha256 等于它。扫描遍历轮目录，跳过 `boundary.json` /
  `boundary-gate.json` 与非常规文件（不跟随符号链接），并分块读取每个常规文件**整体**
  ——marker 落在更早输出之后的合法日志仍被找到——同时约束**聚合**工作量：一个复用的
  1 MiB 暂存缓冲（无每文件分配）加整趟 64 MiB 总字节预算（R1-2、R2-5）。哈希缺失/不匹配
  或无匹配行即拒绝容器声明。检查**无条件**执行：豁免基于**记录**而非旗标——
  `containerNonceErrors` 对 `ci-lane` 记录与非 container 模式返回 `[]`，故
  `--publish-lane`（R1-7）与 `$QWEN_VERIFY_CONTEXT`（R2-7）都不能为
  `require-isolation` 容器声明关掉该绑定。
- 容器本地 nonce 写入是门禁的一部分：`$HOME` 不可写或缺失时，门禁在通过行之前以
  exit 3 失败并使任何陈旧通过记录失效，而不是静默写下一个明文无处存在的记录、让该轮
  直到电池跑完才无法认证（R1-4、R2-4）。
- step-7 的 shell **不再重复实现 nonce 匹配**：checker 是**唯一**权威匹配器，消除
  shell↔checker 分叉（R1-2、R2-6）以及在 PR 投放的长行上卡死的第二匹配器（R1-3）。
  shell 仍写声明并调用 checker，由 checker 拒绝宿主电池；nonce 接纳/拒绝/对齐见证移至
  checker 单测与真实环境往返。step-5 与 boundary-gate 正文说明记录携带哈希、绝不携带
  明文，电池须 echo 一行从容器本地文件读出的 `container-nonce:`。
- `requireBoundary` 加可选 `{env, exists, home}` 接缝（其检测器本就接受）并导出，使
  一个无门控单测见证能在裸宿主上演练只含哈希的记录写入；gate-pass 路径否则受 observed
  容器标记环境门控。
- D17-2：拒绝文案明确 `mode:"waived"` 需要维护者批准——不是免费绕过。

这在关闭宿主抄录路径的同时保持已承认的边界诚实：同时伪造记录哈希与匹配日志行的轮仍
在范围外（记录佐证的是跳过门禁的操作者，而非同时伪造两者的 PR 代码）。

### C —— 限定 VM 句

把 preflight 句改写为「a VM boundary runs the same file from the trusted checkout
**without the `--require-isolation` gate** instead」，与 VM 条目一致。

## 涉及文件

- `scripts/verify-pr-watch-state.mjs` —— 梯推导形状守卫；`inFlightEntries` 在空列表
  旁也消费裸遗留标记。
- `scripts/verify-pr-prepare.mjs` —— 记录 `nonceSha256`，去掉明文 `nonce`；致命 nonce
  写入（exit 3）使陈旧记录失效；导出 `requireBoundary` 并加 `{env, exists, home}` 接缝。
- `scripts/verify-pr-check.mjs` —— `containerNonceErrors` + 整文件聚合界日志扫描，由
  `main` 无条件调用。
- `.qwen/skills/verify-pr/SKILL.md` —— step-5 nonce 正文、step-7 shell nonce 匹配移除
  （checker 唯一匹配器）、VM 句限定。
- `scripts/tests/verify-pr-watch-state.test.js` —— 可消费/不可消费形状见证、纯身份
  fail-closed、迁移边界见证。
- `scripts/tests/verify-pr-prepare.test.js` —— 门控记录断言、经接缝的无门控只含哈希
  记录见证、陈旧记录失效见证。
- `scripts/tests/verify-pr-check.test.js` —— `containerNonceErrors` 见证（匹配行接纳；
  哈希/行缺失或不匹配拒绝；不跟随 symlink；ci-lane/非容器豁免；整文件与跨块读取；
  行语义对齐）+ CLI 拒绝见证（`--publish-lane`、`$QWEN_VERIFY_CONTEXT`）；容器夹具携带
  `nonceSha256` 与日志行。
- `scripts/tests/qwen-triage-workflow.test.js` —— step-5 flat 钉、VM 限定钉、checker
  唯一匹配器钉；shim-node replay 保留声明/teardown 见证（nonce 见证移至 checker 测试）。

## 范围边界

- 簇 D（R17-2 活性）、E（R8 长尾）、F（D17-4…14）仍由 #17371 跟踪；本改动不触碰。
- 核心 `--context` 信任边界与 sha256 内容绑定（#17375）不变。
- 不新增脚本或 CLI 入口；checker 加一个依赖目录的 nonce 检查并成为**唯一**匹配器——
  step-7 shell 不再重复实现（#17185 的铸声明前 shell 拒绝由权威 checker 拒绝取代，后者
  在发布前运行）。`requireBoundary` 仅作可测试性接缝导出，与已导出的检测器一致。
- 单记录/单 nonce 绑定约束多容器 Java 配方（R1-10、R3-6）：checker 只读一份记录与一个
  哈希，`container-nonce:` 行必须由跑电池的容器 echo。电池跑在与门禁不同容器的轮次读不到
  门禁的明文，故按 skill 的 step 5 经维护者批准声明 `mode:"waived"`；门禁容器的佐证不能
  替代。该配方的声明步骤已在双语中记录此约束；它是提案，非已发布代码。

## 待决问题

- 无阻塞项。nonce 强制为**单一实现**（checker），由 node 单测与真实环境往返见证；
  移除 shell 的第二匹配器消除了评审循环不断再生的对齐分叉（R1-2/R2-2/R2-3/R2-6）。
  记录只含哈希，故匹配器不从 PR 可写记录读取明文判据。聚合字节预算意味着总计超过
  64 MiB 的日志不被扫描（fail closed）；合法轮次的日志远低于该界。
