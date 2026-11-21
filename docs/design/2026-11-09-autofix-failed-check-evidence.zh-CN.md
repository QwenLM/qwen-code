# Autofix 失败检查证据

[English](2026-11-09-autofix-failed-check-evidence.md) | [简体中文](2026-11-09-autofix-failed-check-evidence.zh-CN.md)

状态：已随本次改动实现；验证情况见「验证计划」中列出的单测与 workflow 钉子套件。

## 问题

Qwen Autofix 评审循环会在 PR 检查变红时选中它，但真正修 PR 的 agent 只拿到检查
**名称**。`feedback.md` 把 `## Failed checks` 与 `## Still-red checks` 渲染成
`名称: 结论` 行（`.github/workflows/qwen-autofix.yml`），而 agent 不持有任何
GitHub 凭据（`.qwen/skills/autofix/SKILL.md` 的 “You have no GitHub
credentials”）。它读不到 job 日志、annotation，甚至连失败步骤的名字都拿不到。

对本地可复现的车道这还能撑住：agent 把检查名映射到仓库自己的命令再跑一遍。有三类
撑不住：

- 分片车道（`Linux unit tests (shard 2/2)`）不说明哪个测试文件红了，agent 只能跑
  整包再二分。
- 名为 `Test` 的检查可能红在非测试步（schema、format、lint、freshness）。skill
  专门警告过这一类，因为它反复出现。
- 环境特有的车道本地根本无法复现；没有日志，agent 只能花一轮去赌一个假设。

CI Failure Patrol 已经在为它的分类器蒸馏 job 日志
（`.github/scripts/ci-flaky-rerun.mjs`：`redactLog` + `skillLog`，取自
`repos/<repo>/actions/jobs/<id>/logs`）。判定失败是否 flaky 的自动化能看到日志，
真正改代码的自动化却看不到。

## 目标

- 给 address agent 提供失败**步骤名**，以及每个失败 job 的有界、已脱敏日志摘要。
- 复用巡逻的脱敏逻辑，让两套自动化以相同方式擦除密钥。
- 退化方向永远是「证据更少」，绝不是「整轮失败」。

## 非目标

- 不改变选中哪些 PR、轮次计数或验证门。
- 不给 agent 新增凭据；它仍然只读 `feedback.md`。
- 不做 flaky 重跑——那仍是 CI Failure Patrol 的职责。
- 不把完整日志下载进 agent 上下文；摘要保持有界。

## 方案

新增采集器 `.github/scripts/autofix-check-evidence.mjs`，输出
`## Failed check evidence (bounded excerpts)` 段落。`Prepare branch and
feedback` 把它写入 `${WORKDIR}/check-evidence.md`，反馈块在非空时 cat 它，位置在
两个仅名称段落之后、gate-rejection 上下文之前。

每个失败 job 输出：

- 检查名与 workflow 名，按既有检查名列表相同的字符类清洗；
- `Failed steps:` —— 结论为 `failure` 的步骤名，取自
  `repos/<repo>/actions/jobs/<id>`；
- 一段围栏内的日志摘要，取自 `repos/<repo>/actions/jobs/<id>/logs`，经巡逻的
  `skillLog`（脱敏 + 按错误标记选行）处理，并完整保留其自身约 120 行的选行；围栏
  长度大于摘要内任何反引号串，使日志行无法提前闭合它。

job id 直接来自检查的 `detailsUrl`（`…/actions/runs/<run>/job/<job>`），因此解析
它不需要额外查询。

## 设计决策

1. **在切到 PR 分支之前运行。** 调用位于 `Prepare branch and feedback` 中工作树
   仍是可信 base 的位置，与 `resolve-sandbox-image.mjs` 已有的运行位置相同。采集器
   导入 `./ci-flaky-rerun.mjs`，因此两个文件都必须来自可信代码；放到 checkout 之后
   它们就成了分支持有的代码、在带 PAT 的环境里执行。由于该位置尚未执行任何分支
   代码，不需要暂存副本或摘要校验（对照 af-158：它的度量工具在 gate 中、分支代码
   已执行之后才运行）。
2. **镜像既有选择条件。** 采集器套用相同的失败结论集合，以及相同的
   `Qwen Autofix` 自车道排除与 `review-address` 例外，对齐 `## Still-red checks`
   门禁。兄弟列表 `## Failed checks` 还接纳 `CANCELLED`；被取消的 job 不是要诊断
   的失败，因此此处省略。外部 commit status 没有 job URL，保持仅名称。
3. **限制扇出。** 按 rollup 顺序取前三个不同 job，完整保留 `skillLog` 自身约
   120 行的选行（从头部截断会在嘈杂的多错误日志上丢掉携带失败汇总与末尾
   `Process completed with exit code 1` 的尾部），`execFileSync` 缓冲上限 8 MiB，
   超过即丢弃日志而不是把它整个缓冲进来。
4. **处处尽力而为。** 脚本在本改动合入前不存在于可信 base，因此 `node` 调用带
   `|| true`；rollup 不可读、API 读取失败或日志超限，都只产生空的或部分的段落。
   采集器 stderr 写入 `${WORKDIR}/check-evidence.log`，整个 WORKDIR 的产物上传
   已经会带上它。
5. **快照语义。** 摘要在 checkout 之前采集，前言写明它描述的 head。两个仅名称段落
   仍是被评估 head 的权威列表；两次读取之间若有推送，摘要可能描述上一个 head，
   前言让这种不一致可见而非静默。
6. **不可信文本。** 日志输出是不可信的：`skillLog` 擦除凭据，标题被清洗，既有的
   反馈 echo 在任何内容到达 step stdout 之前对两种 workflow 命令语法（`::` 与
   `##[`）去毒。skill 告知 agent 该段落是有界快照，且仍须在本地复现失败。
7. **日志抓取需要三段式。** 当前 `gh` 在响应含终端转义序列时会拒绝打印——而
   Actions 的 job 日志几乎总是含有——除非传 `--allow-escape-sequences`；裸调用
   退出码 1、stdout 为空，而把非零退出吞掉的辅助函数会静默地不渲染任何摘要。
   因此抓取时传该标志，仅当 stderr 含 `unknown flag` 时回退到裸调用（旧版 `gh`
   既无该检查也无该标志），并做 `stripVTControlCharacters`，使原始 ANSI 不会到达
   `feedback.md` 或 step stdout。这一抓取形状——标志、旧 gh 回退、脱 VT——与
   `packages/cli/src/commands/autofix-pr/ci-log.ts` 的 `jobLog` 一致，行为套件
   的假 `gh` 会复现该拒绝，因此缺标志即变红。同样的修复也落到巡逻自己的
   `GhClient.jobLog`（`.github/scripts/ci-flaky-rerun.mjs`）——它在当前 `gh` 下
   同样对日志盲；在此一并处理而非延后，使被复用的脱敏器的抓取真正可用。
8. **终端控制字符在两遍脱敏之间、于共享脱敏器内剥离。** `stripVTControlCharacters`
   去掉转义序列却留下裸的 C0/C1 控制字符与 Unicode Bidi 覆盖字符：由 fork 控制
   的日志行可借 `\r` 在终端里视觉覆盖某一行开头，`\b`、`\x0b`、`\x0c`、DEL 与
   C1 区间同样能重绘该行，`Bidi_Control` 集则能重排该行。因此 `skillLog` 剥离
   `[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]`
   （C0/DEL/C1 加上 `safeReason` 已在剥离的完整 `Bidi_Control` 集，保留 `\n` 与
   `\t`）——置于两遍脱敏之间。第一遍是原样不变的 `redactLog`，且在剥离之前：
   裸 `\r` 既提供锚定密钥模式（`\bnpm_…`、`\bsk-…`、`\beyJ…`、
   `\b<scheme>://`）所需的词边界，也界定按行作用的 `Cookie:` / `Authorization:`
   规则——它们的 `[^\r\n]*` 必须停在 header 自己那一行。行选择也在剥离之前：
   选择器需要前导 `\r` 提供的空白（`\sFAIL\s`），且焊接不能在被选中之前就吃掉
   失败行。因此第二遍 `redactWeldedTokens` 在剥离之后、按**连续下标组成的段**
   分别运行：选中的窗口在日志里未必相邻，把它们整体拼接会让私钥规则把一个窗口
   里的 BEGIN 与另一个窗口里的 END 配成一对，并删掉两者之间的每一行——包括摘要
   本来要展示的失败。仅当整个 BEGIN…END 跨度落在同一个选中窗口内时，分段才保留
   私钥修复；伪造的跨窗口配对无法形成。真实的 2048 位 RSA PEM 有 27–29 行，超过
   选行窗口（命中处至多 24 行，外加末尾 20 行），因此那么长的控制拆分私钥会丢掉
   BEGIN 标签、分组从正文中间开始、正文未经脱敏照常发出——merge base 同样发出该
   正文，故这是窗口上限而非回归（见下文「代价」）。它与第一遍的每一处差别，都源于
   剥离删掉了规则用作分隔符或终止符的字符。`\b` 锚点被去掉：凭据内部的控制字节
   （`npm_\rABC…`）
   会让第一遍的所有锚点失配，而同一次剥离还可能把单词字符焊到 token 前面
   （`x\rnpm_…` 变成 `xnpm_…`），使 `\b` 无从匹配。对只处理已脱敏文本的一遍
   来说，过度脱敏是安全方向；代价是不加锚点的 `sk-` 也会把带 20 个以上字母
   数字的 `task-…` 标识符脱敏。值是一个 **tempered token**——跑到下一个空白处
   为止，但绝不跨过 `##[error]` 标记——而不是一个排除标记字符的字符类：排除
   `#`、`[`、`]` 会让合法含有这些字符的凭据（含 `#` 的口令、PEM 正文、日志自己
   写的 `[redacted]realsecret…` 前缀）把尾部明文发出，而 tempered 写法脱敏整个
   值并仍停在标记之前。对 env/token 规则，**带引号**的值按其配对收尾引号收口；
   **未加引号**且已是 `[redacted]` 占位符、后跟结构分隔符（`,`、`}`、引号、空白
   或行尾）的值则不再处理：否则修复遍会重新匹配无控制字符 JSON 行里已脱敏的值、
   一路跑到行尾，吃掉对象其余部分——摘要本要展示的失败载荷。fork 的
   `[redacted]secret` 仍被脱敏，因为占位符后跟的是凭据字符而非分隔符。`Bearer`
   的分隔符是水平空白、零或多个，因此分隔符处的
   控制字节（`Bearer\rsecret` → `Bearersecret`）仍被脱敏。URL 的 scheme 用长度
   上界而非 lookbehind 收口——lookbehind 会拒绝前一个字符是数字的起点（焊接出的
   `42https://…`），长度上界既保持线性扫描又不拒绝它——userinfo 则是一段或多段
   `@` 分段，因此含 `@` 的口令被完整脱敏。两条 header 规则留在这一遍之外：它们
   的值一直跑到行尾。
   记录而非关闭的代价：header 值内部的控制字符仍留下 CR 之后的碎片
   （`Cookie: [redacted]=abc`），与未剥离的 base 一致；header 关键字内部的
   控制字符（`Coo\rkie: sid=abc`）两遍都够不到，焊接后的值因此仍未脱敏，而
   空值 header（`Cookie:` 后接 CR）在第一遍就已丢掉下一行，base 亦然；
   `TOKEN`/`KEY`/… 规则在 base 里对长单词串就是平方复杂度（40k 字符需数秒，随主机而异）；
   修复遍把输入截到 300 个**剥离前**字符（呈现用的 300 字符切片在剥离后施加），
   因此不再叠加第二份该成本，对抗性长行只剩第一遍的 base 成本。该钳制**不是**
   无泄漏保证：值本身被截断时只能发出低于最小长度的碎片，但若凭据的**终止符**
   （`-----END …-----` 标签、URL 的 `@`）落在截断之后，规则整体不匹配，凭据值
   ——或其中落在钳制内的前缀——照样明文发出；剥离把它焊成连续，而 merge base
   发出的是被控制字符拆开的同一值。修复还可能让行变长，接近 300 字符的行会被末次
   切片截掉尾部，包括行尾的 `##[error]` 标记。且修复只看到选中窗口：长于该窗口的
   控制拆分私钥会丢掉 BEGIN 标签、正文照常发出，与 base 一致。这些作为上限记录、
   不在此关闭；值无法区分「焊接在凭据内部」与「焊接在后续类词文本之前」，
   因此焊到值上的裸失败关键字（没有 `##[error]`）仍被吃掉（消息尾部仍在）；
   BEGIN…END 跨度内部的 `##[error]` 会中止私钥匹配，宁可保留标记也不脱敏该跨度
   ——不含标记的真实 PEM、含非标记 `#` 的正文仍被完整脱敏（含标记的完整标签块
   会被第一遍整体脱敏，与 base 一致）。剥离类还未覆盖更广的 Unicode 空白/格式
   字符族。被这些字符拆分是否泄漏，取决于规则、也取决于 JS 是否把该字符算作空白：
   破坏固定前缀 token 规则所需连续性的字符（`npm_`、`sk-`、`ghp_`、AKIA、JWT）会
   让 token 不被脱敏；JS 视为空白的字符——NBSP（U+00A0）、U+2000–U+200A、U+3000、
   以及 U+FEFF——会终止以空白收口的值类，尾部因此发出；但落在 env / Bearer / URL
   **值内部**的非空白格式字符（如 U+200B / U+2060）属于该值的一部分，会被脱敏。
   凭据内部的制表符被剥离保留、并终止两遍的值类，因此该形状也匹配不到。这些作为
   缺口记录，不在此关闭；该记录是对无界对抗面的示意，并非穷尽枚举。
   剥离位于 `skillLog`，因此
   同时覆盖采集器摘要与巡逻渲染的证据（巡逻唯一的 `jobLog` 调用方经过
   `skillLog`）。两个兄弟抓取本身不变：`ci-log.ts` 的 `jobLog` 仍会把裸控制字符
   写进 `.qwen/tmp/autofix-pr-<n>-ci-<run>.log`，巡逻的 `GhClient.jobLog` 也仍
   把它们返回给调用方。一次性过渡成本：巡逻还把标记评论的键基于 `skillLog` 的
   输出（`scan` 里的 `fingerprint(target, log)`），而 `alreadyHandled` 精确比对
   该键。剥离与焊接修复都会改变该输出——修复对无控制字符的日志同样改写——因此
   fingerprint 会重键：本次上线前写入的标记会失配一次，巡逻重新分流该失败并发
   一条新标记，从下一条标记起自愈。
9. **围栏不会被日志闭合。** 摘要的 Markdown 围栏长度大于其内部最长的反引号串，
   因此含反引号的日志行无法提前闭合围栏、把余下内容作为标记溢入
   `feedback.md`。

## 约束与风险

- workflow 文件有体积门禁（`.github/scripts/check-workflow-size.sh`）；本次改动
  增加约 1.3 KB，仍在记录的基线容差内。
- 日志文本可能包含受攻击者影响的输出。脱敏、清洗与既有去毒是缓解措施；agent 本来
  就把所有反馈当作不可信输入。
- 证据采集每轮最多增加六次 API 读取（三个 job 的元数据 + 日志）。任一读取失败都
  静默退化。
- 摘要可能描述两次读取之间已移动的 head；前言写明 head，使差异可见而非静默。

## 验证计划

- `.github/scripts/autofix-check-evidence.test.mjs`（node:test）：选择条件镜像
  workflow 门禁（含一个保持仅名称的真实 `StatusContext`）、去重与扇出上限、脱敏
  见证、约 120 行上限且保住失败汇总尾部、围栏大于反引号串、80 字符名字上限、
  标记清洗、每个参数缺失的 usage 守卫，以及通过 PATH 上的假 `gh` 覆盖每条退化
  路径。假 `gh` 复现当前 gh 的转义序列拒绝（不传标志即 exit 1）与旧 gh 的
  `unknown flag`，因此渲染摘要的用例同时见证标志与脱 ANSI。另有用例端到端钉住
  控制字符剥离：裸 `\r` 之后的密钥仍被脱敏（第一遍 `redactLog` 在剥离之前）、
  以裸 CR 结尾的 header 行与以裸 CR 结尾的 token 值（`SSH_AUTH_SOCK=`、
  `Bearer`）都不会吞掉紧随其后的 `##[error]` 行、控制字符拆开凭据键名时摘要仍
  留有该失败文本、backspace/C0/C1 与 Bidi 被剥离而 tab 与换行保留、首个控制
  字符之后的文本被保留（截断实现保持红）。
  Bidi 用例喂入每一个 `Bidi_Control` 码点，并对 stdout 断言
  `/\p{Bidi_Control}/u`，因此把字符类收窄到采样码点无法保持绿。
- `scripts/tests/ci-flaky-rerun.test.js`（vitest）：巡逻的 `GhClient.jobLog` 传
  标志、仅在 `unknown flag` 时回退、脱去 VT 控制字符，并向上抛出非拒绝类错误；
  `skillLog` 在两遍脱敏之间剥离终端控制字符与 Bidi 覆盖字符（裸 CR 后的密钥仍
  被脱敏，backspace、纵向制表符与 Bidi 消失，被控制字符拆分的凭据在剥离拼合后
  仍被脱敏，前置词边界也被剥离删掉的凭据同样被脱敏），保住以 CR 结尾的 header
  之后、以及任何以空白结尾的规则其值以 CR 结尾之后的失败行（5 个前缀 ×
  CR/VT/FF），保住被焊接的 URL userinfo 本会够到的失败行（第一遍已脱敏的形状
  与第一遍根本没匹配的形状各一条），在控制字符拆开凭据**键名**时保住
  `##[error]` 标记（env、`Bearer`、私钥头，置于 30/40 行噪声窗口中），选中前导
  空白是控制字符的 `FAIL` 行，脱敏被日志自己写在 `[redacted]` 前缀后面的凭据
  （含引号形态共四条），逐条修复被控制字节拆开的九类凭据以及第六轮入口
  （含 `#`、`}` 或引号的值、焊接出的数字前缀 scheme、多 `@` userinfo、含 `#`
  的 URL 口令、被删的 `Bearer` 分隔符、日志自写的 `[redacted]` URL 值）——每个
  形状一个夹具，同时断言占位符存在与密钥尾部消失，删掉任何一条规则都会变红——在 BEGIN…END 跨度内部含
  `##[error]` 时保留标记而非脱敏该跨度（真实 PEM 与含非标记 `#` 的正文仍脱敏），
  不把非相邻选中窗口里的 key BEGIN 与 END 配成一对（其间的 `TypeError:` 仍在），
  并剥离每一个 C0/DEL/C1 与 `Bidi_Control` 码点，以 Unicode 自身的属性断言，
  且 `\n` 与 `\t` 仍保留。
- `scripts/tests/qwen-autofix-workflow.test.js`（vitest）：调用先于 checkout 且
  使用工作树路径；容错回退与 stderr 去向；段落位于仅名称列表与 gate rejection
  之间、且在去毒 echo 之前；两个 helper 测试列表的 CI 成员资格；af-161 指针与
  skill 指引。
- 变异验证：把调用移到 checkout 之后、改为 `RUNNER_TEMP` 暂存路径、去掉
  `|| true`、去掉反馈守卫、去掉任一 CI 成员条目、去掉 skill 句子，都会让
  workflow 钉子变红；去掉标志、脱 ANSI、脱控制字符、旧 gh 回退、把行数上限改回
  60、把围栏定长四反引号、把 usage 守卫收窄为 `&&`、渲染原始日志、去掉自车道
  排除、job 上限、去重，或加入 `CANCELLED`，都会让采集器测试变红；在剥离之后
  重跑整个 `redactLog`、给剥离后的 `npm_` 规则重新加上锚点、把第二遍变成空操作、
  把控制字符剥离移到第一遍脱敏之前、删除剥离、收窄为仅 `\r`、把 Bidi 类收窄到
  采样码点、删掉单个未被采样的 `Bidi_Control` 码点、在首个控制字符处截断、或
  放宽到吞掉 `\n`/`\t`，都会让采集器或巡逻见证变红；把剥离移回行选择之前会让
  前导控制字符的 `FAIL` 用例变红；把 env 值的 tempered token 还原为 `#` 收口
  字符类会让「含终止字符的值」用例在两套里变红；恢复 env 值的结构字符排除
  （`}` 与引号）会让 `}`/引号钉子变红；从 URL userinfo 排除 `#` 会让含 `#` 的
  URL 口令钉子变红；要求 `Bearer` 分隔符（`\s+` 而非零或多个）会让被删分隔符入口变红；恢复 URL scheme 的 lookbehind 会让
  数字前缀 scheme 入口变红；把 URL userinfo 收成单段 `@` 会让多 `@` 入口变红；
  从 URL userinfo 排除 `[` `]` 会让日志自写 `[redacted]` 入口变红；把私钥正文
  还原为 `[^#]*?` 会让含非标记 `#` 用例变红；把所有选中窗口拼成一段会让跨窗口
  BEGIN/END 用例变红；删掉九条剥离后规则中的任何一条会让逐类修复用例变红；
  去掉巡逻的标志会让其见证变红。URL scheme 的长度上界是成本修复而非行为修复：
  有它时单独的 URL 规则是线性的（40k 字符 1–2 毫秒）。修复遍把输入截到 300
  字符，因此对抗性的 100k 字符词串耗时约等于 base（head/base 比值约 1.0；绝对秒数
  随主机而异——第一遍的平方复杂度 `TOKEN`/`KEY`/… 规则），而非翻倍。
- 因为改了 `ci.yml`，复跑 `scripts/tests/ci-platform-lanes.test.js`。

## 验收标准

- 红 PR 的 `feedback.md` 带有失败步骤名，以及最多三个失败 job 的已脱敏摘要；
  摘要在当前 `gh` 下确实渲染（传了标志），且没有原始 ANSI、终端控制字符
  （裸 CR、backspace 及其余 C0/C1 控制字符——tab 与换行保留）或 Bidi 覆盖字符
  到达 `feedback.md` 或 step stdout。
- 脱敏对套件钉住的焊接形状是**尽力而为**，而非完备性保证：控制字节在凭据内部、
  在其前置词边界之前、或在其键名内部；值含 `#`、`[`、`]`、`@`、`}` 或引号；日志
  自写的 `[redacted]` 前缀；焊接出的 scheme 前缀；被删的 `Bearer` 分隔符。对抗性
  输入仍可能发出凭据材料，base 亦然——上文「代价」段记录了已知机制（被剥离类之外
  字符拆分，仅对匹配被其破坏的规则泄漏；焊到值上的裸失败关键字；被拆开的 header
  键名；终止符落在 300 字符剥离前钳制之后的凭据，发出该值或其中落在钳制内的前缀；
  长于选行窗口的控制拆分私钥，发出正文）。该记录是对无界对抗面的示意，并非穷尽
  枚举。
- 以裸 CR 结尾的**非空**以空白结尾的凭据值，仍会把紧随其后的失败行留在摘要里；
  控制字符拆开凭据键名时不会吃掉 `##[error]` 标记——前提是值与标记落在钳制与选行
  窗口之内（攻击者构造的超长值可把标记推出剥离前钳制）。空值 header 在第一遍就已
  丢掉下一行，base 亦然（见「代价」）。
- 脚本缺失、rollup 不可读或 API 读取失败，绝不会让一轮失败。
- 采集器及其导入的 helper 在切到 PR 分支之前、从可信 base 执行。
- 两个 helper 测试列表都运行该行为套件；workflow 钉子、采集器测试与巡逻测试
  通过。

## 待定问题

- 对一个跨多分片变红的 PR，三个 job 的扇出是否合适；上限是常量，可在不改变形状
  的前提下提高。
- 是否把 annotation 作为更廉价的首发信号；本仓库车道中它很稀疏，因此改选步骤名
  加摘要。
