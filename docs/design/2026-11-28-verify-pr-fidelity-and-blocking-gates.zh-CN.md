# Verify-PR 保真变换协议、容器 UID 可观测性与阻塞评审机械覆盖门禁

[English](2026-11-28-verify-pr-fidelity-and-blocking-gates.md) | [简体中文](2026-11-28-verify-pr-fidelity-and-blocking-gates.zh-CN.md)

- **状态**：提案中（Proposed）
- **日期**：2026-11-28

## 问题背景

在 PR #18581 的三轮 `/verify-pr` 验证中（`ad5531c0`、`bfc396ee`、`253c0ae1`
以及运行中途推进的 `2490bb3f`），第 3 轮给出了 `88/88` `merge-ready`
（`#issuecomment-7239662950`），但 28 分钟后的人工复评
（`#issuecomment-7239998370`）直接用真实 `e2fsprogs` 在已认证提交 `2490bb3f`
上复现了 1 个 P1 和 1 个 P2 缺陷：

1. **解包重打包变换的静默保真丢失（P1）**：`debugfs rdump` + `mkfs.ext4 -d`
   会静默丢弃 FIFO、把硬链接拆散为独立的 `nlink=1` inode、并丢失扩展属性
   （`xattrs`）。即便 `2490bb3f` 新增了所有权校验，也因为遍历起点是有损解包目录
   `extractTree` 而非源镜像，导致已被略过的对象完全逃逸。三轮验证的真实
   `e2fsprogs` 探针都只抽查了单个普通文本文件。
2. **容器全程以 `root` 运行导致非 root 权限路径彻底失明（P2）**：三轮验证的真实
   `e2fsprogs` 探针都在 Docker 默认 `uid=0`（`root`）下执行，而未使用
   `--user "$(id -u):$(id -g)"`。由于 `root` 下 `debugfs rdump` 永远不会输出
   `Operation not permitted` 所有权告警，导致验证从未进入非 root 分支——既漏掉
   了早前的 P1（`#issuecomment-7239376491`），也漏掉了 `2490bb3f` 引入的 P2
   （仅符号链接 UID 不同时 `rdump` 产生 0 条告警，跳过 `restoreOutputOwnership`，
   连带使符号链接与新注入的 `/opt/poc/init` 所有者全部变成构建用户而非
   `14001:14002` 与 `0:0`）。
3. **中途 delta 复测仅重跑旧探针**：提交 `2490bb3f` 在验证中途一次性新增了 164 行
   非 root 所有权采集与恢复逻辑，但 delta re-check 仅重跑了上一轮的 root 探针、
   旧的 7 守卫变异矩阵和假二进制单测，对新增逻辑及其代理信号门控
   （`hasOwnershipWarnings`）做了零新探针与零变异。
4. **缺少阻塞评审覆盖的机械校验**：虽然 `#18549` 已扩展 `review-threads.json`
   抓取维护者顶层评论（`OWNER`、`MEMBER`、`COLLABORATOR`），但
   `verify-pr-check.mjs` 尚未在放行 `merge-ready` 前机械校验每一条未决阻塞行内
   线程、阻塞变更请求正文与顶层 `P0`/`P1`/`Critical`/`Blocker` 评论是否均已在
   `assertions.json` 与 `report.md` 中交代。

## 目标与范围边界

### 目标

- 在 `verify-pr-prepare.mjs --require-isolation` 写入 `boundary-gate.json` 时
  记录容器进程 `uid`，在 `verify-pr-check.mjs` 中对畸形 `uid` fail-closed 报错，
  并在 `container` 轮次以 `uid=0`（`root`）运行时输出显式告警。
- 为 `review-threads.json` 增加 SHA-256 摘要绑定（`verify-pr-prepare.mjs` 打印
  `review-sha256`），并在 `verify-pr-check.mjs` 中通过 `--review-threads <snapshot>`
  与 `--review-threads-sha256 <digest>` 对 `assertions.json` 的 `reviewCoverage`
  与 `report.md` 引用执行机械覆盖校验。
- 在 `.qwen/skills/verify-pr/SKILL.md` 中补齐：
  - 面向解包重打包与保真变换 diff 的五轴对抗验证协议；
  - 跟进轮或中途 delta 新增生产逻辑的 fresh-round 对抗验证门槛；
  - 代理信号门控的假阴性反例攻击，以及假二进制套件中新增外部工具修复的真实二进
    制实测要求；
  - 容器 `uid=0` 非 root 覆盖规范及 `--review-threads` 发布门禁接线。

### 非目标

- 不把 `uid=0` 设为 `verify-pr-check.mjs` 的硬错误：确实需要以 root 装包的容器
  轮次仍可运行，但告警与规程禁止仅凭 root 跑测把非 root 权限路径签发为
  `merge-ready`。
- 不破坏未传 `--review-threads` 的既有 `verify-pr-check.mjs` 调用，并保持
  `verify-pr-check.mjs` 在 CI 稀疏签出发布车道中的零外部脚本依赖独立运行能力。
- 不自动排除 PR 作者本人的顶层评论：维护者经常用与提 PR 相同的账号发表独立复评
  （如 `#18581` 的 `7239376491` 与 `7239998370`）。

## 技术方案

### 1. 容器执行 UID 记录与 root 告警

- **`scripts/verify-pr-prepare.mjs`（`requireBoundary`）**：在 POSIX 平台（或测试
  注入 `options.uid` 时），在 `boundary-gate.json` 中记录非负整数 `uid`。
- **`scripts/verify-pr-check.mjs`（`gateRecordErrors`、`checkArtifacts`）**：
  - 当非 `ci-lane` 的 `boundary-gate.json` 携带畸形 `uid`（非整数、负数或超过
    `Number.MAX_SAFE_INTEGER`）时 fail-closed 报错。
  - 当 `boundary.mode === 'container'` 且非 `ci-lane` 门禁记录 `uid === 0` 时输出
    明确告警，提示 root 会绕过非 root 权限、`chown` 及所有权告警路径。

### 2. 阻塞评审覆盖机械门禁

- **`scripts/verify-pr-prepare.mjs`**：对 `prepare` 写入的 `review-threads.json`
  精确字节计算 `reviewSha256`（GraphQL 拉取失败时为 `null`），在计算
  `contextSha256` 前将 `reviewSha256` 写入宿主侧 `pr.json` 上下文快照，并在
  `review` 行之后打印 `  review-sha256  <64-hex>`（拉取失败未写文件时省略）。将
  `reviewSha256` 绑定到宿主 `pr.json` 后，即使两个 PR 的空评审快照逐字节相同，也
  无法用其他 PR 或旧轮次的快照与摘要冒名顶替。
- **`scripts/verify-pr-check.mjs`**：
  - 新增 `--review-threads <snapshot>` 与 `--review-threads-sha256 <64-hex>`，施加
    与 `--context` / `--guard` 相同的宿主信任边界校验（拒绝 PR 可写树内路径、文件
    系统根信任根、硬链接、符号链接、非普通文件、摘要不匹配、`--require-guard` 下
    缺摘要，以及私自植入在 PR 可写产物目录内的 `review-threads.json`）。当已绑定
    的宿主 `--context` 携带 `reviewSha256` 时，对 `--review-threads` 摘要不一致、
    `reviewSha256` 为 `null` 却传入 `--review-threads`、`--require-guard` 下存在
    64 位十六进制 `reviewSha256` 却省略 `--review-threads`，以及 `reviewSha256` 为
    `null` 时尝试发布 `merge-ready` 均 fail-closed 拒绝。
  - 导出 `extractBlockingFindings(body)`、`hasBlockingSeverityTag(body)`、
    `extractBlockingReviewItems(reviewData, { coordinates })` 与
    `checkReviewThreads(text, { coordinates })`：
    - 对畸形 JSON/结构，以及与可信 `--context` 坐标不匹配的跨 PR URL fail-closed
      拒绝（防止跨 PR 重放）。
    - 在 Markdown 代码围栏之外提取每一条独立的阻塞发现（`P0`、`P1`、`Critical`、
      `Blocker`），涵盖 Markdown 表格严重度列中的独立单元格（仅对无独立文字描述列、
      无行内阻塞标签且计数列全为数值/零值的纯计数汇总行应用零计数豁免或汇总回退，
      确保 `Severity | Findings` 及含 `—`/`0` 计数列的
      `Severity | Count | Description` 逐条保留）、以标题引导的阻塞列表
      （`**Blockers**`，按 CommonMark 规则在顶格懒续行、缩进续段、子列表项与缩进
      代码块后保持同一标题作用域）以及同一评论内的多个编号/列表阻塞项；对
      `<details><summary>中文说明</summary>` 执行一对一对应合并，明确禁止合并编
      号或发现代号冲突的条目，并保留折叠区内独有或主题不重合的额外发现，同时忽略
      正文行内反引号提及（如 `` `[P1]` ``）、闭合 HTML 注释、零项/无项标题
      （`**Blockers**: None`、`### Critical (0)`、`### Blockers\nNone`）与普通
      叙述语句。
    - 收集未决阻塞行内线程（`resolved !== true` 或所属评审位于未解除
      `changeRequests` 中）、带阻塞标签的未解除 `changeRequests` 正文，以及带阻塞
      标签的 `OWNER`/`MEMBER`/`COLLABORATOR` 顶层 `issueComments`（单条评论含多个
      阻塞发现时输出独立的 `finding: 1..N` 条目），同时排除 `/verify-pr` 自身报告
      （首段含 `Verdict:` 且末行匹配 `/verify-pr` 签名）及开头带机器人生命周期/状态
      注释头的评论。
  - 校验 `assertions.json` 中的可选字段 `reviewCoverage`（元素形态
    `{ url, finding?, status, evidence | reason }`，`status` 取值
    `reproduced | not-reproduced | not-measured | no-defect-claimed`，禁止重复
    `(url, finding)` 键或对同一 URL 混用带序号与不带序号条目，
    `reproduced`/`not-reproduced` 须带非空 `evidence`，
    `not-measured`/`no-defect-claimed` 须带非空 `reason`）：
    - 当一条评论包含多个阻塞发现时，强制要求逐项提供 `{ url, finding: 1..N }` 记
      录，单条不带 `finding` 的 `{ url }` 无法放行多发现评论。
    - 若 `verdict` 为 `merge-ready`，任何未决阻塞发现被遗漏、标为 `reproduced` 或
      `not-measured`、或标为 `not-reproduced` 却未在 **`report.md` 与 `comment.md`
      （存在时）两处可见正文中同时**引用其 URL/片段/评论 ID（多发现评论还须按发
      现编号核对披露，支持 `finding 2`、`findings 1, 2, and 3` 或 `第 1、2 项`
      等写法，并对同一行内以句号、逗号或相邻锚点分隔的多条评论隔离归属），均
      fail-closed 报错拒绝。
    - 若 `verdict` 非 `merge-ready`（`inconclusive`、`findings`、`blocked`），遗漏
      项降级为告警，避免阻塞部分完成或失败轮次的报告发布。

### 3. Skill 规程加固（`.qwen/skills/verify-pr/SKILL.md`）

- **Step 1 与本地 `--publish` 门禁**：当 `prepare` 写出 `pr<n>-review-threads.json`
  时清理并提取 `~/.cache/qwen-verify/pr<n>/review-threads.sha256`，并在本地容器与
  runner-backed VM 两条最终发布检查命令中均绑定 `--review-threads` 与
  `--review-threads-sha256`（同步更新 `scripts/tests/verify-pr-model-proxy.test.js`
  的 shell AST 白名单与对抗变异测试）。
- **Step 3**：说明 `boundary-gate.json` 的 `uid` 记录机制，明确涉及权限/所有权/非
  root 调用的 PR 不得凭 root 容器运行签发 `merge-ready`。
- **跟进轮分类**：明确 `P..H` 或中途 delta 新增生产逻辑时，禁止仅凭重跑旧探针、旧
  变异和假二进制单测签发 `merge-ready`，必须补写新真实输入探针（含门控假阴性反
  例）与新变异行。
- **范围选择**：新增由 diff 触发的五轴**解包重打包与保真变换**对抗协议（源锚定全
  量差分 Oracle、含 FIFO 的文件类型矩阵、硬链接 inode 拓扑、含仅 symlink 异主与新
  注入文件的元数据/所有权/xattr 矩阵，以及非特权执行身份）。
- **方法与报告第 4 项**：补充代理信号门控假阴性攻击、外部工具新修复的真实二进制实
  测要求，以及 `assertions.json` `reviewCoverage` 机械契约。

## 设计决策与理由

- **采用显式 `no-defect-claimed` + 必填 `reason`，而非按 PR 作者过滤**：维护者常
  用同一账号发表独立复评，按 `author !== pr.author` 排除会直接重现 `#18581` 的漏
  检。保留全部维护者 `[P1]` 评论并允许对作者修复回复（如 `7239531608`）显式标注
  `no-defect-claimed` 及原因，既不误拦，又确保每条阻塞标记可审计。
- **将 `reviewCoverage` 放在 `assertions.json` 内**：无需跨 CI 与本地流程新增强
  制产物文件，同时保持合法 JSON 与既有消费者完全兼容。
- **CLI 层保持 `--review-threads` 显式传入，并在 `SKILL.md` 发布命令中强绑定**：
  兼顾既有稀疏签出 CI 与历史测试兼容性，同时令本地 `--publish` 在存在
  `review-threads.json` 时严格 fail-closed。

## 约束与风险

- `review-threads.json` 仍抓取最新 100 条顶层评论（超限时由 `issueCommentCount` 披
  露截断），超出最近 100 条窗口的顶层评论不在机械校验范围内。
- 五轴保真协议与中途 delta 探针门槛在规程层仍依赖执行体遵守覆盖与 _Not covered_
  披露契约；新增的 `uid=0` 告警与 `--review-threads` 门禁则在机械层堵住了导致
  `#18581` 误报 `merge-ready` 的两个静默绕过点。
- `verify-pr-check.mjs` 继续保持不运行时依赖其他仓库脚本，确保 CI 稀疏签出发布车
  道独立运行。

## 验证计划与验收标准

1. `scripts/tests/verify-pr-prepare.test.js`：验证 `review-sha256` 与
   `pr<n>-review-threads.json` 精确字节一致（拉取失败时不输出），且
   `requireBoundary()` 正确写入容器 `uid`（`0`、`1000` 及 POSIX 默认
   `process.getuid()`）。
2. `scripts/tests/verify-pr-check.test.js`：验证 `uid=0` 告警 / 非 root 静默 / 畸
   形 `uid` 报错、阻塞严重度标签分类（含代码围栏与零项标题负控）、复刻 `#18581`
   评论形态的 `extractBlockingReviewItems()`、跨 PR URL 拦截、`reviewCoverage` 校
   验与 `report.md` 引用检查，以及完整 CLI 宿主边界/摘要/植入文件拒绝对照。
3. `scripts/tests/verify-pr-model-proxy.test.js`：更新后的 `SKILL.md` 通过 shell
   AST 白名单审计，对 `review-threads.sha256` 与 `--review-threads` 的对抗变异全
   部被拒绝，并钉住 `SKILL.md` 新增的保真协议、中途 delta 门槛、代理信号规则、容
   器 `uid` 披露及 `--review-threads` / `reviewCoverage` 接线。
4. 所有改动文件通过 ESLint 与 Prettier 检查，并在隔离稀疏目录独立运行
   `scripts/verify-pr-check.mjs` 验证零额外脚本依赖。
