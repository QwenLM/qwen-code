# Autofix-PR：面向 linked-worktree daemon 会话的「按 worktree 落盘」watch 存储

[English](2026-10-29-autofix-pr-worktree-rooted-storage.md) | [简体中文](2026-10-29-autofix-pr-worktree-rooted-storage.zh-CN.md)

状态：提案（2026-10-29）。修订
[2026-10-21-autofix-pr-command.zh-CN.md](2026-10-21-autofix-pr-command.zh-CN.md)
的 Section 6（存储）、6.1 step 7（daemon 拒绝）、6.10（status）与 6.15（watch 列表）。

## 问题

当一个 daemon 会话的工作目录是多 worktree clone 的 **linked worktree** 时，
`/autofix-pr` 无法 prepare。会话
`b1887512-645c-46a2-a4e1-97d17390c674`（cwd `…/git/qwen-code-x2`）对 PR #15816
调用 `/autofix-pr`，`prepare` 拒绝：

```
…/git/qwen-code/.qwen/tmp/autofix-pr-15816 is outside this session's working
directory (…/git/qwen-code-x2): the daemon runs the fix agent's commands only
there … Prepare the PR from …/git/qwen-code …
```

`qwen-code-x2` 是某个 clone 的 linked worktree，其主 worktree 为
`…/git/qwen-code`（`git rev-parse --git-common-dir` → `…/qwen-code/.git`）。
这正是维护者的常用布局（`x1`…`x9`），因此该拒绝使得 `/autofix-pr` 在他几乎
所有常用会话里都不可用——哪怕 PR 分支就检出在这个 worktree 里。

## 现状

两个各自有意的设计相互碰撞：

1. **按 clone 落盘。** `repoRoot()`
   （`packages/cli/src/commands/review/lib/git.ts`）返回 clone 的**主
   worktree**（`git worktree list --porcelain` 的第一条）。
   `autofixPrPaths(root, pr)`（`packages/cli/src/commands/autofix-pr/state.ts`）
   把 worktree 与全部状态文件放在 `<主worktree>/.qwen/tmp/` 下。设计理由：
   分支由 clone 的所有 worktree 共享，所以 watch 属于 clone，任何 worktree
   里的 helper 都能找到同一个 watch。
2. **daemon 包含边界。** daemon shell guard
   （`packages/cli/src/serve/daemon-git-worktree-guard.ts`）只允许在会话的
   有效工作目录之内、或该会话拥有的 worktree
   （`GitWorktreeService.getWorktreesDir(sessionId)`）里执行命令。
   `assertSessionCanRunWorktree`（`prepare.ts`）在创建任何东西之前复算这条
   边界并 fail-closed。

linked-worktree 会话的 cwd 既不是主 worktree，也不是会话拥有的隔离 worktree，
因此按 clone 落盘的产物永远在其可达范围之外。daemon 的 watch 列表同样按 clone
落盘：`cloneRootOf()` / `listAutofixPrWatches()`
（`packages/cli/src/serve/routes/autofix-pr-watches.ts`）扫描主 worktree 的
`.qwen/tmp`，从而「同一 clone 的两个 workspace 列出相同的 watch」。

## 目标

- clone 的任意 worktree 里的 daemon 会话都能 `prepare`、运行并 `resume` 一个
  产物落在该会话工作目录之内的 watch。
- 不削弱 daemon shell guard 与 worktree 信任检查。
- Web Shell 仍能从 clone 的任意 workspace 列出该 clone 的全部 watch。
- 不回退 plain-CLI（非 daemon）流程，包括对按 clone 落盘 watch 的跨 worktree
  操作。

## 非目标 / 范围边界

- 不改 daemon shell guard 的包含规则。把它放宽到「同一 clone 的任意
  worktree」会让一个会话能在兄弟 worktree 与主检出里执行命令，破坏兄弟隔离
  ——这是安全回退。排除。
- 不改分支命名、按 PR 编号的状态模型，或信任检查的语义。
- 「autofix worktree 没有 `node_modules`」这一独立问题不在本范围内。

## 方案

### 1. 感知环境的 watch 根，跨 clone 发现

`watchRoot()`（在 `packages/cli/src/commands/autofix-pr/state.ts`）决定**新建**
watch 的落盘根：

- daemon 会话（`QWEN_CODE_SERVE === '1'`）：取**当前 worktree 的 toplevel**
  （从 cwd 跑 `git rev-parse --show-toplevel`）——即会话的包含边界，产物因而
  可达。
- 否则：`repoRoot()`（clone 的主 worktree），与今天完全一致。

watch 落在它被 prepare 的那个 worktree，而 helper 无法从自己的 cwd 反推出来：
会话可能已经移动，且 `cleanup` 必须能够到任意 worktree 里的 watch 去结束它。
所以**既有** watch 是被发现，而非猜测。`findWatchRoot(pr)` 扫描 clone 的各
worktree 找 `autofix-pr-<pr>-state.json`（活 watch worktree 优先于陈旧状态
文件），`resolveWatchRoot(pr) = findWatchRoot(pr) ?? watchRoot()`。`prepare`
恢复发现到的 watch——仍由 `assertSessionCanRunWorktree` 拒绝会话边界之外的
——或在 `watchRoot()` 新建；`snapshot`、`sync`、`push`、`reply`、`rerun`、
`ci-log`、`schedule`、`fix`、`cleanup` 都经 `resolveWatchRoot` 解析。

列表（`status` 默认与 daemon 路由）不选单一根：它扫描 clone 的**每一个**
worktree（`cloneWorktreeRoots()`），所以无论 watch 落在哪个 worktree 都能被
找到。枚举是 NUL 安全的（`git worktree list --porcelain -z`、
`parseWorktreePaths`）：含换行的路径仍是一条记录，不会伪造出额外的根让扫描
读到 clone 之外。git 2.36 之前没有 `-z`，而行式无法安全表示这种路径，所以
fallback 只扫描主 worktree（恒为第一条），而不冒伪造根的风险。`repoRoot()`
本身不变——`review` 命令及其 reviewer 游标仍以主 worktree 为根。

对主 worktree 会话而言 `watchRoot() === repoRoot()`，因此既有的按主 worktree
落盘的 watch 与主 clone 会话行为完全一致。唯一的行为变化发生在 linked-worktree
daemon 会话——而它们今天是死角。

### 2. 信任始终锚定到 genuine clone

信任检查函数（`packages/cli/src/commands/autofix-pr/worktree.ts` 的
`untrustedGitfile` / `untrustedSubmodules`）本身不变：用
`git -C <root> rev-parse --git-common-dir` 解析某个 clone 的公共 git 目录，
再校验 worktree 的 gitfile 指向 `<common>/worktrees/<name>` 且反向指回。
关键在于传给它们的 `root` 是谁。clone 全量列表会在兄弟 worktree 里发现
watch，但兄弟检出的 `.git` 是一个 gitfile，在其中运行过的代码可以把它改写成
指向一个替换仓库——所以绝不能把发现来的 worktree 当作信任根，否则它会为自己
嵌套的 watch 担保，`status` 就会执行替换仓库的 `core.fsmonitor`。

锚也不能只靠单一来源。`repoRoot()` 从 helper 的 cwd 跑 git，所以一个 `.git`
被改指向替换仓库的 cwd 会让它失真；而 state 文件**并非** round 够不到——
`working_dir` 只是 cwd pin、不是文件系统沙箱，修复 worktree 里的命令能写兄弟
文件 `../autofix-pr-<n>-state.json`，所以单凭记录的 `trustRoot` 也可被篡改。
`prepare` 在会话 cwd 还可信时把 genuine clone 记入 `state.trustRoot`（resume
会为旧 watch 补填），但 `trustAnchor(state)` 要求记录的根与 cwd 推导的
`repoRoot()` **一致**——按 realpath 比较，不在可能敌意的锚里跑 git。不一致即
说明有一处被篡改，fail-closed 拒绝、两个都不信；没有记录根的旧 watch 回退到
cwd 推导的 clone。列表把每个 watch 的信任检查（及 `unsavedWork`）锚定到
`trustAnchor(state)`；写路径的 `requireWorktree` 接收独立的 `trustRoot`，与其
`root`（watch 根，仍作为符号链接 walk 的停止点）分开，`push`/`sync` 传入
`trustAnchor(state)`。任何单一的可被 round 改写的来源都不作锚。

### 3. 按 clone 全量列出 watch

`status`（默认、未显式指定 root）与 daemon 的 `listAutofixPrWatches` 以 NUL
安全方式枚举 clone 的各 worktree（`cloneWorktreeRoots`），扫描每个的
`.qwen/tmp` 并合并 watch。按 PR 编号去重：git 不允许同一分支在两个 worktree
同时检出，所以一个 PR 的 watch worktree 至多存在于一个 worktree，合并绝不会
重复计入活跃 watch；活 watch worktree 优先于另一根里的陈旧状态文件。daemon
视图仍把 clone 的主 worktree 作为展示用的 `root`；扫描覆盖所有 worktree，从而
保持「同一 clone 的两个 workspace 列出相同的 watch」。程序化传给 `runStatus`
的单个 `root`（测试、内部调用方）仍只扫描那一个 worktree；CLI 不提供 `--root`
flag。

读取之前，`vouchedScanRoots` 先过滤枚举出的根（仅文件读取、不跑 git 命令，
所以 daemon 仍只用一次 git 调用）：丢弃嵌套在另一根 `.qwen/tmp` 里的 watch
worktree（在那里 force-add 一个状态文件会伪造 watch），并把每个剩余的根对照
genuine clone 的 worktree 登记项做担保——被无关仓库占据的失效条目、或 `.git`
被改写的兄弟，都不会被当成本 clone 的 watch 读取。genuine 公共目录对两种布局
都能解析：非 bare 主 worktree 的 `.git` 目录，或 bare clone 的主条目——它本身
就是 git 目录（没有 `.git` 子目录）。锚无法解析时**不**当作校验通过：扫描只
信主根，绝不对未担保的兄弟 fail-open。然后每个 worktree 的目录扫描相互隔离：
某个兄弟的 `.qwen/tmp` 是普通文件或不可访问（ENOTDIR/EACCES）时跳过它，而不会
让其余所有 worktree 的 watch 列表整体中止（经 daemon 那会是整个 clone 的
500）。**主根**的读取失败会被抛出（surface），而不是吞成空列表——主
`.qwen/tmp` 不可读是真实的诊断信号。同样的逐根隔离也用于 watch 发现
（`findWatchRoot`），所以畸形兄弟不会挡住 helper 在别处找到并结束一个健康
watch。daemon 视图会对 `unreadable[].error` 里的兄弟绝对路径与状态文件名脱敏
（CLI 保留完整路径）。

### 4. prepare 拒绝作为安全网保留

`assertSessionCanRunWorktree` 不变。配合按 worktree 落盘，它对 linked-worktree
daemon 会话现在会通过（worktree 在 cwd 之内）。当 worktree 仍会落在会话工作
目录之外时（例如会话位于该 worktree 的子目录）它仍然拒绝，并指明应去哪个
目录 prepare。

## 设计决策与理由

- **感知环境的根，而非永远按 worktree 落盘。** 永远用 `--show-toplevel` 更
  简单，但会回退 plain-CLI 的跨 worktree 操作：今天在主 worktree prepare 的
  watch 可以从 linked worktree 操作（daemon 之外没有 guard）。环境分支把改动
  限定在恰好损坏的场景（daemon + linked worktree），并保留所有当前可用的
  流程。这一额外分支是避免回退，而非投机性的灵活性。
- **按 clone 全量列出，而非按 worktree 列出。** 在存储变为感知 worktree 的
  同时，保持 Web Shell 的 clone 级契约不变。
- **不动 guard。** 包含边界是一项安全属性；修复把产物移到边界之内，而不是
  移动边界。

## 约束

- ESM、严格 TS、无 `any`；kebab-case 文件名；同目录 `*.test.ts`。
- 安全检查必须保持 fail-closed；任何 helper 都不在 watch 的 `.qwen/tmp` 之外
  写入。
- daemon 列表在自己的线程上运行且不得挂起：保留每 worktree 的 git 超时与
  非阻塞文件读取。

## 风险与迁移

- **既有的按主 worktree 落盘的 watch。** 主 clone 会话仍能找到它们
  （`watchRoot === repoRoot`）；按 clone 全量列表从任意 worktree 都能看到。
  helper 会发现 watch 实际所在的 worktree（`findWatchRoot`），所以 linked-worktree
  会话可以直接 `cleanup` 一个主 worktree 落盘的 watch——无需切到拥有它的
  worktree。要把 watch 迁到另一个 worktree，`cleanup` 它（当它属于另一个会话
  时加 `--take-over`，否则 `assertOwnedBySession` 会拒绝），再在目标重新
  `prepare`。新建 prepare 时，`reconcileHistory` 跨 clone 的各 worktree 合并该
  PR 的 history，**含目标自身的副本**，所以返回曾经离开的主根不会丢掉后续跳
  已结算的内容。已结算列表（已处理评论、已发回复、已花费的检查/重跑）取并集；
  pending 列表（重跑 hold、deferred run、已宣告的回复）是结算态，取最近写入的
  副本，并丢弃 floor 已被花费的 hold——迁移绝不复活后续 watch 已花费的 hold
  （否则会重跑一个已结算的检查）。已处理冲突标记是标量结算，同样取最新副本：
  陈旧的主根标记不能覆盖较新的 linked 根结算、把一个已留给人的冲突再修一遍。
  cleanup 会保留持有工作的 worktree；不会静默丢失数据。
- **跨环境操作。** 在 daemon 下于 linked worktree prepare 的 watch 就落在
  那里；从该 worktree 操作它。plain-CLI 的 `status` 仍通过按 clone 全量扫描
  发现它。
- **列表开销。** 扫描 N 个 worktree 而非一个；受 worktree 数量与既有 git
  超时约束。对 Web Shell 可接受。

## 验证计划

- 单元：`parseWorktreePaths` 的 NUL 安全（含换行的路径不伪造根）；`watchRoot()`
  的环境分支与 `resolveWatchRoot`/`findWatchRoot` 发现——`cleanup` 从 linked
  worktree 的 daemon 会话结束一个主 worktree 落盘的 watch，`prepare` 跨两跳
  迁移并合并 history；按 clone 全量 `status` 的合并与活 worktree 去重（两种
  顺序都能判别）；`vouchedScanRoots`（嵌套 watch worktree 与外来失效条目不被
  读取）；主根读取失败被 surface；信任在列表与写路径（`requireWorktree`/
  `unsavedWork`）都锚定 genuine clone，被改写的兄弟 gitfile 绝不执行其配置；
  daemon 跨 worktree 列表且 `unreadable` 路径脱敏。
- 回退 pin：linked worktree 里的 daemon 会话 prepare 出一个 worktree 落在
  会话 cwd 之内的 watch，且 `assertSessionCanRunWorktree` 通过（即 b1887512
  的 exact 失败场景）。
- E2E（`.qwen/e2e-tests/`）：从 linked-worktree daemon 会话，
  `/autofix-pr <n>` 能 prepare、跑一轮并 push；Web Shell 的 watch 列表从同
  clone 的兄弟 workspace 能看到该 watch。
- `npm run build && npm run typecheck` 加上所改包的单元测试。

## 验收标准

- linked-worktree daemon 会话能端到端 prepare/运行/resume 一个 watch。
- daemon shell guard 与 worktree 信任检查的行为逐字不变；不放行任何兄弟
  worktree 的执行。
- Web Shell 从任意 workspace 列出 clone 的全部 watch。
- plain-CLI 流程（包括对按主 worktree 落盘 watch 的跨 worktree 操作）不变。
- SKILL.md 与 2026-10-21 设计文档（双语）反映新的存储根与列表范围。

## 待决问题

- 程序化 `root` 参数保持单 root 扫描，CLI 不提供 `--root`；只有默认与 daemon
  按 clone 全量扫描。（已定：不新增 CLI flag。）
- 是否需要一次性迁移，在 `resume` 时把既有的按主 worktree 落盘的 watch 迁移
  进会话 worktree，还是保留手动 `cleanup` + 重新 `prepare` 的补救？
  （提案：手动，不做静默迁移。）
