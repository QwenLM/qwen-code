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

### 1. 感知环境的 watch 根

在 `packages/cli/src/commands/autofix-pr/state.ts` 新增 `watchRoot()`：

- daemon 会话（`QWEN_CODE_SERVE === '1'`）：取**当前 worktree 的 toplevel**
  （从 cwd 跑 `git rev-parse --show-toplevel`）——即会话的包含边界，产物因而
  可达。
- 否则：`repoRoot()`（clone 的主 worktree），与今天完全一致。

每个 helper 改用 `autofixPrPaths(watchRoot(), pr)` 而非
`autofixPrPaths(repoRoot(), pr)`：`prepare`、`snapshot`、`sync`、`push`、
`reply`、`rerun`、`ci-log`、`schedule`、`fix`、`cleanup`，以及 `status` 的
默认根。`repoRoot()` 本身不变（`review` 命令与列表的展示根仍用它）。

对主 worktree 会话而言 `watchRoot() === repoRoot()`，因此既有的按主 worktree
落盘的 watch 与主 clone 会话行为完全一致。唯一的行为变化发生在 linked-worktree
daemon 会话——而它们今天是死角。

### 2. 信任检查与 root 无关（已核实，无需改动）

`untrustedGitfile` / `untrustedSubmodules`
（`packages/cli/src/commands/autofix-pr/worktree.ts`）用
`git -C <root> rev-parse --git-common-dir` 解析 clone 的公共 git 目录，这对
clone 的每个 worktree 都相同，再校验 worktree 的 gitfile 指向
`<common>/worktrees/<name>` 且反向指回。`requireWorktree` /
`redirectedAncestor` 检查 worktree 与 `root` 之间的包含关系与符号链接；watch
worktree 落在新 root 之内，包含关系成立。因此把 `root` 从主 worktree 换成
linked worktree 不会削弱任何检查。

### 3. 按 clone 全量列出 watch

`status`（默认、未显式指定 root）与 daemon 的 `listAutofixPrWatches` 枚举
`git worktree list --porcelain`，扫描每个 worktree 的 `.qwen/tmp` 并合并
watch。按 PR 编号去重：git 不允许同一分支在两个 worktree 同时检出，所以一个
PR 的 watch worktree 至多存在于一个 worktree，合并绝不会重复计入活跃 watch。
daemon 视图仍把 clone 的主 worktree 作为展示用的 `root`；扫描覆盖所有
worktree，从而保持「同一 clone 的两个 workspace 列出相同的 watch」。程序化
传给 `runStatus` 的单个 `root`（测试、内部调用方）仍只扫描那一个 worktree；
CLI 不提供 `--root` flag。

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
  linked-worktree 会话会在自身 worktree 下计算路径，找不到主 worktree 的状态
  文件；在那里 `prepare` 会尝试新建 watch 并撞上「分支已被检出」的拒绝。
  文档化的补救：在拥有该 watch 的 worktree 里跑 `cleanup`（遗留 watch 在主
  worktree——从 linked 会话跑 `cleanup` 会以那里为根，找不到它），再在目标
  worktree 重新 `prepare`。cleanup 会保留持有工作的 worktree；不会静默丢失数据。
- **跨环境操作。** 在 daemon 下于 linked worktree prepare 的 watch 就落在
  那里；从该 worktree 操作它。plain-CLI 的 `status` 仍通过按 clone 全量扫描
  发现它。
- **列表开销。** 扫描 N 个 worktree 而非一个；受 worktree 数量与既有 git
  超时约束。对 Web Shell 可接受。

## 验证计划

- 单元：`watchRoot()` 的环境分支（daemon linked / daemon main / plain CLI）；
  每个 helper 都以 `watchRoot()` 落盘；按 clone 全量 `status` 的合并与去重；
  daemon 跨多 worktree 的列表；root 为 linked worktree 时信任检查不变。
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
