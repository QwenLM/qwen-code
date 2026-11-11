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

- 分片车道（`Linux unit tests (shard 3/8)`）不说明哪个测试文件红了，agent 只能跑
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
8. **终端控制字符在脱敏之后、于共享脱敏器内剥离。** `stripVTControlCharacters`
   去掉转义序列却留下裸的 C0/C1 控制字符：由 fork 控制的日志行可借 `\r` 在终端
   里视觉覆盖某一行开头，`\b`、`\x0b`、`\x0c`、DEL 与 C1 区间同样能重绘该行。
   因此 `skillLog` 剥离 `[\x00-\x08\x0b-\x1f\x7f-\x9f]`（除 `\n` 与 `\t` 外的
   全部）——但只在 `redactLog` 之后：锚定的密钥模式（`\bnpm_…`、`\bsk-…`、
   `\beyJ…`、`\b<scheme>://`）需要裸 `\r` 提供的词边界，先剥离会把 `x\rnpm_…`
   拼接成任何锚点都匹配不到的 token，让它在承诺已脱敏的前言下泄露。剥离位于
   `skillLog`，因此同时覆盖采集器摘要与巡逻渲染的证据（巡逻唯一的 `jobLog`
   调用方经过 `skillLog`）。两个兄弟抓取本身不变：`ci-log.ts` 的 `jobLog` 仍会
   把裸控制字符写进 `.qwen/tmp/autofix-pr-<n>-ci-<run>.log`，巡逻的
   `GhClient.jobLog` 也仍把它们返回给调用方。
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
  控制字符剥离：裸 `\r` 之后的密钥仍被脱敏（剥离在 `redactLog` 之后）、
  backspace/C0/C1 被剥离而 tab 与换行保留、首个控制字符之后的文本被保留
  （截断实现保持红）。
- `scripts/tests/ci-flaky-rerun.test.js`（vitest）：巡逻的 `GhClient.jobLog` 传
  标志、仅在 `unknown flag` 时回退、脱去 VT 控制字符，并向上抛出非拒绝类错误；
  `skillLog` 在脱敏后剥离终端控制字符（裸 CR 后的密钥仍被脱敏，backspace 与
  纵向制表符消失）。
- `scripts/tests/qwen-autofix-workflow.test.js`（vitest）：调用先于 checkout 且
  使用工作树路径；容错回退与 stderr 去向；段落位于仅名称列表与 gate rejection
  之间、且在去毒 echo 之前；两个 helper 测试列表的 CI 成员资格；af-161 指针与
  skill 指引。
- 变异验证：把调用移到 checkout 之后、改为 `RUNNER_TEMP` 暂存路径、去掉
  `|| true`、去掉反馈守卫、去掉任一 CI 成员条目、去掉 skill 句子，都会让
  workflow 钉子变红；去掉标志、脱 ANSI、脱控制字符、旧 gh 回退、把行数上限改回
  60、把围栏定长四反引号、把 usage 守卫收窄为 `&&`、渲染原始日志、去掉自车道
  排除、job 上限、去重，或加入 `CANCELLED`，都会让采集器测试变红；把控制字符
  剥离移到脱敏之前、收窄为仅 `\r`、在首个控制字符处截断、或放宽到吞掉
  `\n`/`\t`，都会让采集器或巡逻见证变红；去掉巡逻的标志会让其见证变红。
- 因为改了 `ci.yml`，复跑 `scripts/tests/ci-platform-lanes.test.js`。

## 验收标准

- 红 PR 的 `feedback.md` 带有失败步骤名，以及最多三个失败 job 的已脱敏摘要；
  摘要在当前 `gh` 下确实渲染（传了标志），且没有原始 ANSI 或终端控制字符
  （裸 CR、backspace、C0/C1）到达 `feedback.md` 或 step stdout。
- job 日志中的任何密钥都不会到达 `feedback.md` 或 step stdout。
- 脚本缺失、rollup 不可读或 API 读取失败，绝不会让一轮失败。
- 采集器及其导入的 helper 在切到 PR 分支之前、从可信 base 执行。
- 两个 helper 测试列表都运行该行为套件；workflow 钉子、采集器测试与巡逻测试
  通过。

## 待定问题

- 对一个跨多分片变红的 PR，三个 job 的扇出是否合适；上限是常量，可在不改变形状
  的前提下提高。
- 是否把 annotation 作为更廉价的首发信号；本仓库车道中它很稀疏，因此改选步骤名
  加摘要。
