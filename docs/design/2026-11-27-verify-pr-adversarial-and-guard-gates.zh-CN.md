# Verify-PR 对抗验证协议、顶层阻塞评论抓取与发布前守卫硬门禁

[English](2026-11-27-verify-pr-adversarial-and-guard-gates.md) | [简体中文](2026-11-27-verify-pr-adversarial-and-guard-gates.zh-CN.md)

- **状态**：已实现并完成本地验证
- **日期**：2026-11-27

## 问题陈述

在 PR #18494 的五轮 `/verify-pr` 验证（`3363f8a5` 至 `aa4677734f`）中，skill
稳定检出了编译错误、空转测试和回归叙事失实，却在相同提交上连续漏检了并行人工复审找出的静默数据丢失、稳态归档堆积与平方级
I/O 回归（`7210889200`、`7214891441`、`7215477398`、`7215982054`、`7218091603`、`7219372287`、`7220037991`）。具体暴露出三类根因：

1. **破坏性/排除类 diff 的方法论盲区**：验证把作者的排除声明直接当作 oracle；中心
   A/B 夹具始终锁死在单一 `.gitignore` 拼写（`.qwen/tmp/`）；过度依赖低层 helper
   单次调用和变异测试（无法发现代码未写出的模型缺口，如中间 symlink 跳点或外部
   `objects/` 反向指针）；跳过多轮真实清理 sweep 与 `git worktree prune --expire=now`；既未反打自己给出的建议修复，也未给新 `refuse` 守卫配反向可用性对照。
2. **对维护者顶层阻塞评论失明**：`scripts/verify-pr-prepare.mjs` 和
   `.github/workflows/qwen-triage.yml` 的 `REVIEW_STATE_QUERY` 仅抓取
   `latestOpinionatedReviews` 和行内 `reviewThreads`，维护者以普通顶层 PR 评论发出的
   `[P1]` 复审在 `review-threads.json` 中完全不可见。
3. **发布前守卫仅为软约定**：`scripts/verify-pr-guard.mjs` 只向 stdout 打印
   `clean`/`dirty`，不生成结构化、带摘要绑定的 verdict；`scripts/verify-pr-check.mjs`
   也从不校验 guard 是否已执行。R4 在同 head 落下一条新顶层 P1 评论 8 分钟后发布；R5
   在落下两条新 P1 后 23 分钟、且 head 已推进 18 分钟后仍发出 `merge-ready`。

## 目标与范围边界

### 目标

- 在 `.qwen/skills/verify-pr/SKILL.md` 中为破坏性、排除、忽略、清理、快照和迁移类
  diff 增加由 diff 触发的对抗验证协议与独立销毁后恢复 oracle，并要求反打自己推荐的最小修复。
- 同步扩展 `REVIEW_STATE_QUERY`、`reviewState()` 与 `.github/workflows/qwen-triage.yml`（保持精确对等），纳入 `OWNER`、`MEMBER`、`COLLABORATOR` 的非折叠顶层评论（`comments(last: 100)`），并将其绑定到与 open blocking review threads 同等的阻塞门槛。
- 将 `verify-pr-guard.mjs` + `verify-pr-check.mjs` 升级为 fail-closed 的机械发布前门禁，提供宿主侧 verdict 存储、SHA-256 内容绑定、PR 坐标/head/`OPEN` 状态核验及抓拍鲜度校验。

### 非目标

- 不将不可信外部评论者（`NONE` / `FIRST_TIME_CONTRIBUTOR`）的顶层评论正文暴露进
  token-free 验证沙箱。
- 不破坏现有 `verify-pr-check.mjs` 的 CI `--publish-lane` 调用或 sparse-checkout
  边界（CI publish job 仅签出 `scripts/verify-pr-check.mjs`，不签出
  `scripts/verify-pr-guard.mjs`）。
- 不新增独立的 `gh pr comment` 包装脚本，继续通过 `verify-pr-guard.mjs` 与
  `verify-pr-check.mjs` 简洁组合实现。

## 方案设计

### 1. Diff 触发的对抗验证协议与独立恢复 Oracle（`SKILL.md`）

- **Scope selection**：只要 diff 改动了排除、忽略、跳过、修剪、删除、快照或迁移逻辑（由
  diff 触发，而非按中心声明触发），即禁止把作者声明当成 oracle，要求写明核心安全不变量、在
  follow-up 轮次同样保留独立对抗预算、`grep` 盘点仓内往被排除目录写入数据的真实消费者，并系统扫描六条对抗轴（在报告中列明实测轴，其余记入 _Not covered_）：
  1. **路径间接性与反向依赖**：终点 `realpath` 在树外但中间 symlink 跳点落在被删目录内，或外部仓库内部依赖（`objects/`、`refs/`、`objects/info/alternates`、symlink）反向指回被删目录。
  2. **位置与嵌套深度**：非默认父目录（如 `vendor/inner`）、容器根目录本身（`.qwen/tmp` 作为工作树）、更深层后代（`.qwen/tmp/runs/inner`）以及已保留/排除子目录内部的次级忽略子树。
  3. **规则拼写变体、混合布局与复杂度阶梯**：覆盖目录折叠规则（`dir/`）、通配展开规则（`dir/*`）与无规则工作区；对新增扫描/谓词做数量阶梯（如 16/32/64 或数千条目）捕捉平方级 `lstat`/I/O 退化；在中心 A/B 中加入混合夹具（忽略缓存 + 同级干净嵌套工作树），避免修复悄悄打掉缓存排除率。
  4. **真实上层调用入口与多轮稳态**：驱动真实上层清理/保留 sweep（而非仅单次低层 helper）连续跑至少 2 轮，验证首轮收敛、次轮不循环堆积重复归档。
  5. **组合型控制流交互**：审计新增的 `continue`、`handled*`、`visited*` 与跳过集合，构造组合夹具（例如同级空被忽略目录 + 未忽略仓库 + 另一被忽略目录的对象库）捕获单因素夹具撞不到的早标缺陷。
  6. **反向可用性（anti-over-refusal / liveness）对照**：每新增一条 `refuse`/拦截守卫，必须配对一个外观最接近但合法、仍须正常归档放行的邻居构型（如带草稿的独立外置 `--separate-git-dir` 仓库 vs 外部 linked worktree）。
- **Artifact-type 方法**：新增 **Snapshot, backup, cleanup, and pruning PRs** 条目，禁止以被测系统自带 `verify() === true`、成员数或工作区草稿作为终判；必须预置无法从工作区重建的历史状态（如两次提交且第二次删除首次的 `old.txt`），执行真实销毁 + 外部维护动作（如清理 sweep 与 `git worktree prune --expire=now`），原位恢复后用独立消费工具（`git cat-file -e 'HEAD^{commit}'`、`git show <first>:old.txt`、`git fsck`）验收，并连续运行至少两轮 sweep 验证稳态收敛。
- **Findings（`A suggested fix is measured, not eyeballed`）**：凡建议修复引入新判别条件或放行二分（如按 `.git` 文件/目录区分），必须显式列出其依赖前提并至少构造一个反例进行反打，避免补丁本身种下下一轮缺陷。

### 2. 维护者顶层阻塞评论纳入 `review-threads.json`

- 扩展 `REVIEW_STATE_QUERY`（仍只在 `reviewThreads` 上保留 `pageInfo`，保持
  `gh api graphql --paginate --slurp` 对行内线程的分页行为不变）：
  ```graphql
  comments(last: 100) { totalCount nodes { createdAt updatedAt url body author { login } authorAssociation isMinimized } }
  ```
- `scripts/verify-pr-prepare.mjs` 中的 `reviewState(pages)` 与
  `.github/workflows/qwen-triage.yml` 中的 `jq` 过滤器保持严格等价：对
  `pullRequest`、`comments.nodes`、`latestOpinionatedReviews.nodes`、`reviewThreads.nodes`
  以及各线程的 `comments.nodes` 统一校验为纯 JSON 对象（两端对称拒绝数组如 `[[]]` 与
  `null` 元素，畸形时 fail-closed 返回 `null`/报错），并输出：
  - `issueCommentCount`：`comments.totalCount`（超过 100 条时在 _Not covered_ 中披露仅抓取最近 100 条）。
  - `issueComments`：`authorAssociation` 属于 `{OWNER, MEMBER, COLLABORATOR}` 且未折叠（`!isMinimized`）的顶层评论，结构为 `{ author, association, createdAt, updatedAt, url, body }`。
- 更新 `SKILL.md` Scope 第 5 项和 report 第 4 项：排除 `/verify-pr` 自身报告与 bot
  生命周期/fallback 评论后，凡带 Critical、Blocker、P0 或 P1 标记的维护者顶层评论，与 open
  blocking review threads 享有同等预算和 `merge-ready` 禁令（任一条留为 `not measured`
  即禁止 `merge-ready`，无其他失败时降级为 `inconclusive`）。

### 3. 机械化发布前 Guard 硬门禁（`verify-pr-guard.mjs` + `verify-pr-check.mjs`）

- **Schema 单一真源**：在 `scripts/verify-pr-check.mjs` 中定义并导出
  `GUARD_VERDICT_SCHEMA = 'verify-pr-guard-verdict-v1'`，由
  `scripts/verify-pr-guard.mjs` 导入复导出，确保 CI publish job 单独 sparse-checkout
  `verify-pr-check.mjs` 时不增加对 `verify-pr-guard.mjs` 的运行时依赖。
- **`verify-pr-guard.mjs`**：
  - `fetchSnapshot()` 在首次读取元数据前记录 UTC ISO-8601 `capturedAt`（`isSnapshot()` 对缺少 `capturedAt` 的旧快照保持向后兼容），收紧 `owner/repo` slug 校验，并拒绝空值参数与多余位置参数。
  - 在三类评论全部分页拉取完成后再次读取 PR head、状态、`reviews` 与 `reviewComments`（内部以显式 `{ ok, value }` 区分调用失败与 JSON `null` 响应，杜绝末次确认返回 `null` 被静默跳过），若分页在途期间发生推送、状态变更、无行内评论的 `CHANGES_REQUESTED` 评审或行内评论变动则直接拒绝写出快照并要求重抓。
  - 为本轮独占目录中的起始快照新增 `--no-clobber`（内核级 `O_EXCL` 排他创建），防止并发两轮互相覆盖或删除彼此的 `guard-start.json`。
  - 在非 `--no-clobber` 的 `--snapshot <file>` 刷新及 `--compare --out <verdict-file>` 中，预先校验目标安全性；无论抓取失败还是写入失败（例如可写目录中只读旧文件触发 `EACCES`），均自动移除单链接普通旧文件使之失效（绝不触动 symlink、hardlink 或非普通文件）。
  - `--compare` 通过 `realpathSync`、父目录规范化与 `(dev, ino)` 强化同文件判定，防止经由 symlink 或 hardlink 自我对比，并将倒序时间戳（`now.capturedAt < start.capturedAt`）直接判为 dirty。
  - `--compare --out` 无论 clean 还是 dirty 均覆写输出文件；clean 时打印 `  guard-verdict  <path>` 与 `  guard-sha256  <64-hex>`。
- **`verify-pr-check.mjs`**：
  - 新增 `--guard <verdict>`、`--guard-sha256 <64-hex>`、`--guard-max-age-sec <1..86400>`（默认 `600`）与 `--require-guard`（同时要求经 `--context-sha256` 摘要绑定的宿主 `--context` 快照携带 repo、PR 号和 `headRefOid`，防止拿其他 PR 或旧 head 的新鲜 verdict 重放）。
  - 复用与 `--context`、`--execution-record` 相同的宿主信任边界：拒绝 PR 可写树内路径、文件系统根信任根、hardlink、symlink、非普通文件/FIFO/超大文件、摘要不匹配，并始终拒绝 PR 可写产物目录内私自植入的 `guard-verdict.json`。
  - 校验 verdict schema、`clean === true` 且 `reasons` 为空、合法 `owner/repo` 与正整数 `pr` 且匹配 `--context` 坐标、40-hex `startHeadRefOid`/`nowHeadRefOid`/`expectedHead` 一致、起止 PR 状态均为 `OPEN`、UTC 时间戳单调（`startCapturedAt <= nowCapturedAt <= comparedAt`）、`nowCapturedAt` 与 `comparedAt` 均在鲜度窗口内且不超过 60 秒未来时钟偏移。
- **`SKILL.md`**：定义位于容器挂载树之外的按轮次隔离宿主目录布局（`~/.cache/qwen-verify-guard/pr<n>/<round-id>/`，与 Docker 挂载为 `/verify-context:ro` 的 `~/.cache/qwen-verify/pr<n>` 彻底分离，避免含未过滤外部评论正文的原始 guard 快照暴露给沙箱容器）；要求在 `verify-pr-prepare.mjs` 抓取 `review-threads.json` **之前**分配独立 `<round-id>` 并用 `--no-clobber` 建立起始快照 `guard-start.json`（若 `prepare` 已先执行则在基线建立后重跑 `prepare`），彻底闭合准备评审材料与建立基线之间的漏评窗口；本地 `--publish` 流程在同一独占目录中清理陈旧文件、同步骤重抓 `guard-now.json`（失败即退出）、比对写出 `guard-verdict.json` 与 `guard.sha256`，仅在 `verify-pr-check.mjs`（带 `--require-guard`）退出 0 后允许发评论；并单列 runner 驱动 VM 轮次（`microvm`/`provider-vm`）的发布检查命令，在同一次检查中沿用 runner 的 `--execution-record`、`--execution-record-sha256` 与宿主 vault 产物目录。

## 设计决策与权衡

- **在快照阶段即按 `OWNER`/`MEMBER`/`COLLABORATOR` 过滤 `issueComments`**：防止任意外部 PR 评论者向 token-free 沙箱注入正文，同时让 `jq` 与 JS 两端零正则、100% 确定性等价。
- **鲜度检查同时锚定 `nowCapturedAt` 与 `comparedAt`**：防止用 30 分钟前的旧 `now.json` 重新跑 `--compare` 刷新 `comparedAt` 从而绕过鲜度窗口。
- **dirty 时同样覆写 `--out`**：确保前一次 clean 文件不会在后续 dirty 复检后残留复用。
- **`--require-guard` 保持 CLI 显式开启**：不破坏 CI `--publish-lane` 和非发布本地自检的向后兼容，同时让本地 `--publish` 路径严格 fail-closed。

## 约束与风险

- `comments(last: 100)` 将顶层评论快照上限设为最新 100 条；通过 `issueCommentCount` 暴露截断，要求在 _Not covered_ 中如实披露。
- `verify-pr-guard.mjs --compare --out` 的鲜度检查依赖宿主机时钟在抓拍与校验之间偏移不超过 60 秒。
- `SKILL.md` 中的对抗验证协议仍依赖执行体遵守，因此要求在报告中显式列出六条轴的覆盖状态、未跑轴移入 _Not covered_，以便评审者审计遗漏。

## 验证计划与验收标准

1. 使用 `gh api graphql --paginate --slurp` 对真实 PR（`QwenLM/qwen-code#18494`）实测新版 `REVIEW_STATE_QUERY`。
2. 单元测试与对等测试全部通过：
   - `scripts/tests/verify-pr-prepare.test.js`（新版 `REVIEW_STATE_QUERY`、仅保留非折叠维护者 `issueComments`、`issueCommentCount`、畸形 `comments` fail-closed）。
   - `scripts/tests/qwen-triage-workflow.test.js`（workflow `jq` 与 `reviewState()` 包含 `issueComments` 的精确对等，以及 `SKILL.md` 对抗协议、顶层阻塞评论与 `--require-guard` 门禁的 pin 测试）。
   - `scripts/tests/verify-pr-guard.test.js`（`capturedAt`、symlink/hardlink 自我比较拒绝、`--out` clean/dirty 覆写、`guard-sha256`、安全写拒绝）。
   - `scripts/tests/verify-pr-check.test.js`（`checkGuardVerdict()` 全分支单测，以及 CLI 端到端串联 `verify-pr-guard --compare --out` → `verify-pr-check --require-guard --guard --guard-sha256`、树内/硬链/软链/篡改/过期/dirty/非 OPEN/私自植入拒绝）。
   - `scripts/tests/verify-pr-model-proxy.test.js`（不破坏任何既有 `SKILL.md` pin 断言）。
3. 对 `.github/workflows/qwen-triage.yml` 执行 `actionlint`，对所有修改与新增文件执行 `eslint` 与 `prettier --check`，全部零错误通过。
