# PR 10226 评论评估

来源：https://github.com/QwenLM/qwen-code/pull/10226
生成日期：2026-08-30
远端评估基线：PR head `a3c7b7fc409524a073a3ea6fe25ae53da68ee282`，base `413b6d15d3d7bb17e22b05e07b008efb1cb7f43e`
本地实现基线：`c7a0bff02b3bbe4ad634dfff59305c6fb835cdc5`（已 fast-forward PR head 并合并本地 main，尚未发布 merge commit）

## 摘要

- 值得修复：23
- 不值得修复：1
- 需要维护者判断：0
- 当前状态：PR 为 `CHANGES_REQUESTED` / `BLOCKED`；Ubuntu Test、no-AK Integration 与 Java 11 检查失败。
- 分支对齐：已安全 fast-forward 到 PR head，合并本地 main 的单个后续提交，并完整恢复 `.gitignore` 与报告。
- 去重范围：保留此前 16 条已修复记录；新增显式锚定 AutoFix 状态评论与当前 Review 9 的 7 条行内 Critical。Review 9 body 中按收敛策略明确 deferred 的项目不在本轮实施范围。

## 评估结果

### 1. 空会话 worktree 分支留下 outcome-unknown 资源

- 评论来源：qqqys，会话评论，https://github.com/QwenLM/qwen-code/pull/10226#issuecomment-5433976717
- 结论：值得修复
- 理由：E2E 的 happy path 证据有效；其行动项在远端 head 仍成立。SessionService.forkSession() 对空源会话抛普通 Error，branch route 在 mutation 已 dispatch 后不能证明其为 commit 前失败，因此返回 branch_worktree_outcome_unknown 并保留 worktree/journal，造成可重复资源残留。
- 建议修复：为“源会话为空”提供明确且不可发布 transcript 的 typed error/errorKind，仅将该类型纳入 settled pre-commit cleanup，并补真实 route 回归测试。
- 实施状态：已修复并验证
- 修复批次：F8
- 实施证据：`SessionForkSourceUnavailableError` 将空源会话映射为 `session_not_found`，branch route 将其视为 settled pre-commit failure 并清理准备资源；ACP 与真实 route 回归测试均通过。

原始评论：

> ## tmux E2E test report (head `535a3e6feb`)
>
> Independent review of the production diff found **no blocking (Critical) issues in the code itself** — the authorization chain, journal hardening (O_EXCL/O_NOFOLLOW, inode+realpath identity), refuse-to-destroy-on-doubt cleanup, safe `-d`-only branch deletion, and the trusted-workspace gate are all consistent with the repo's fail-closed posture. The merge blocker (the PR-caused `Check serve fast-path bundle closure` failure — verified against main, where that step passes and only the Win/macOS test lanes are red) is **already flagged by the bot's stage-3 comment**, so this report does not duplicate it; it adds the functional e2e evidence instead. Per review policy, no approval is given.
>
> **Setup.** Built the PR head in a scratch tree (`npm ci` + bundle), ran `node dist/cli.js serve --port 18745 --token …` in a tmux pane, and bound the workspace to a managed git worktree of this repository (trust pre-seeded via `QWEN_CODE_TRUSTED_FOLDERS_PATH`; no user config touched).
>
> **Results.**
>
> - **Capability gating**: `/capabilities` advertises `session_branch_worktree`.
> - **Happy path**: created a session, seeded it with one model turn, then `POST /session/:id/branch` with `worktree: {slug: "e2e-wt2"}` → the branched session came back fully restored; `git worktree list` showed `.qwen/worktrees/e2e-wt2` on branch `worktree-e2e-wt2`; the `.qwen-session` marker contained exactly the new session id; sidecar + forked transcript persisted; **the preparation journal was cleared on success**; and the marker exclusion rule `/.qwen-session` was added to the repository's `info/exclude` via `--git-common-dir` (the linked-worktree fix in this PR).
> - **Fail-closed under unknown outcome**: branching a brand-new **empty** session → the agent rejects the fork after worktree preparation was dispatched ("Source session not found or empty" — pre-existing fork semantics; a plain non-worktree branch fails identically). The daemon returned `branch_worktree_outcome_unknown` (500) and **preserved** the prepared worktree, branch, and journal — no guessing, no destruction. A follow-up attempt with the same slug then failed cleanly (`worktree_create_failed`) against the preserved residue, and a fresh slug succeeded.
> - **Negative**: slug `../evil` → `400 worktree_invalid_slug` (charset validation blocks traversal shapes).
>
> **Suggestion-level observation (non-blocking; not raised elsewhere).** The "source session empty" failure surfaces as `outcome_unknown` with preserved resources rather than a settled pre-commit rejection, even though the agent's refusal is deterministic and pre-persistence. Branching a just-created session is a plausible UI path; pre-checking session non-emptiness before dispatching worktree preparation (or classifying that agent error as a settled pre-commit failure so `cleanupPrepared()` rolls back cleanly) would avoid the stranded worktree + journal for this common case.
>
> **CI note.** Ubuntu lane red = the PR-caused bundle-closure gate (confirmed above); all other ran lanes pass. Not approving in this pass (no bot/maintainer approval and CI red at this head).
>
> ---
>
> ## tmux E2E 测试报告（head `535a3e6feb`）
>
> 对生产代码 diff 的独立审查**未在代码本身发现阻塞性（Critical）问题**——鉴权链、日志加固（O_EXCL/O_NOFOLLOW、inode+realpath 身份）、"存疑即不销毁"的清理、仅安全 `-d` 的分支删除、受信任工作区门控，均与仓库失败即关闭的姿态一致。合并阻塞项（PR 引入的 `Check serve fast-path bundle closure` 失败——已对照 main 验证：该步骤在 main 上通过，main 的红灯仅为 Win/macOS 测试通道）**已由机器人 stage-3 评论指出**，本报告不重复该项，仅补充功能性 e2e 证据。按评审规则，不予 approve。
>
> **方法。** 在临时目录构建 PR head（`npm ci` + bundle），在 tmux 面板中运行 `node dist/cli.js serve --port 18745 --token …`，工作区绑定到本仓库的一个受管 git worktree（通过 `QWEN_CODE_TRUSTED_FOLDERS_PATH` 预置信任；未改动任何用户配置）。
>
> **结果。**
>
> - **能力门控**：`/capabilities` 声明 `session_branch_worktree`。
> - **快乐路径**：创建会话并以一次模型回合填充后，`POST /session/:id/branch` 携带 `worktree: {slug: "e2e-wt2"}` → 分支会话完整恢复；`git worktree list` 显示 `.qwen/worktrees/e2e-wt2` 位于分支 `worktree-e2e-wt2`；`.qwen-session` 标记内容恰为新会话 id；sidecar 与分叉后的 transcript 已持久化；**准备日志在成功后被清除**；标记排除规则 `/.qwen-session` 经由 `--git-common-dir` 写入仓库 `info/exclude`（即本 PR 对 linked-worktree 的修复）。
> - **结果未知时的失败即关闭**：对全新的**空**会话分支 → agent 在 worktree 准备已派发后拒绝分叉（"Source session not found or empty"——既有的分叉语义；不带 worktree 的普通分支同样失败）。daemon 返回 `branch_worktree_outcome_unknown`（500）并**保留**已准备的 worktree、分支与日志——不猜测、不销毁。随后以相同 slug 的重试干净失败（`worktree_create_failed`，面对保留的残留物），换新 slug 则成功。
> - **负例**：slug `../evil` → `400 worktree_invalid_slug`（字符集校验拦截穿越形态）。
>
> **建议级观察（非阻塞；未在别处提出）。** "源会话为空"的失败以 `outcome_unknown` + 保留资源的形式呈现，而非确定性的提交前拒绝——尽管 agent 的拒绝是确定且发生在持久化之前的。对刚创建的会话分支是可预见的 UI 路径；若在派发 worktree 准备前预检会话非空（或将该 agent 错误归类为确定的提交前失败，使 `cleanupPrepared()` 干净回滚），可避免这一常见场景下遗留的 worktree 与日志。
>
> **CI 说明。** Ubuntu 通道红灯 = PR 引入的 bundle-closure 门禁（已如上确认）；其余已运行通道均通过。本轮不予 approve（本 head 无机器人/维护者 approve 且 CI 非绿）。

### 2. Sidecar no-follow、错误分类与同步 Git 探测

- 评论来源：doudouOUC，会话评论，https://github.com/QwenLM/qwen-code/pull/10226#issuecomment-5433998372
- 结论：值得修复
- 理由：人工复审的两个 Critical 在远端 head 仍存在：resolver 仍裸读并 JSON.parse sidecar，且关键验证段仍以空 catch 降级为 400。同步 execFileSync 轮询也成立但可作为后续性能项；硬编码常量价值较低。
- 建议修复：采用 bounded + O_NOFOLLOW + dev/ino 复验的共享 reader，并把 ownership 拒绝与内部 I/O/parse error 分型；后者记录日志并返回 500。
- 实施状态：已修复并验证
- 修复批次：F2
- 实施证据：resolver 的 sidecar/marker 改为 bounded、O_NOFOLLOW、单链接及 dev/ino 复验；所有 workspace-qualified Git route 通过统一 wrapper 将意外 parse/I/O 错误交给 `sendBridgeError`，明确拒绝仍为 400。同步 `execFileSync` 属于性能 Suggestion，改为全异步会扩大 12 条路由与 core helper 的接口，本轮按多轮 review 收敛约束不扩张；硬编码 marker 已替换为 `WORKTREE_SESSION_FILE`。

原始评论：

> ## Review of PR #10226 — feat: shell support optional worktree
>
> This is a second-opinion review of the full diff (48 files, +5237/−199). The triage bot (stage 2) already gave a thorough review covering the CI red-blocker, the overall architecture, and three suggestions. I confirm those findings and add the following:
>
> ---
>
> ### Critical 1: `resolveSessionManagedGitCwd` reads the sidecar without O_NOFOLLOW
>
> `packages/cli/src/serve/workspace-route-runtime.ts` (the `resolveSessionManagedGitCwd` function) reads the worktree sidecar with a bare `JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))`. This is the **only** sidecar read in the entire diff that does not use the O_NOFOLLOW + lstat/fstat identity-verification pattern that the rest of the PR established everywhere else — `readWorktreeSessionMarker` in core, `markerIsOwnedBy` in the same file, `readStrictFile` in the preparation module, `createWorktreeSessionMarker`, `replaceWorktreeSessionMarker`, and the other marker reads in `gitWorktreeService.ts` all use it.
>
> A symlink sidecar is unlikely-in-practice (the path is daemon-controlled), but the inconsistency means the fixture is not hardened to the same standard as the rest of the PR. If the sidecar path is ever made externally influenceable in the future, this read would follow a symlink to attacker-chosen content.
>
> **Fix:** Use the same O_NOFOLLOW + lstatSync/fstatSync identity check that `markerIsOwnedBy` in the same file already implements for the marker, or import the async `readWorktreeSession` from core and add a sync wrapper.
>
> ---
>
> ### Critical 2: `resolveSessionManagedGitCwd` swallows all filesystem errors with bare `catch {}`
>
> The entire verification block in `resolveSessionManagedGitCwd` is wrapped in `try/catch` with an empty catch body:
>
> ```ts
> try {
>   // ... Git execFileSync, sidecar readFileSync, marker check, realpathSync ...
>   return requested;
> } catch {
>   return null;
> }
> ```
>
> This means any filesystem error — corrupt JSON in the sidecar, a Git repository with a corrupted HEAD, a disk-full or EACCES on transient paths — silently returns `null`, which becomes `400 invalid_cwd` with no diagnostic. The `markerIsOwnedBy` helper in the same file uses the same pattern but is excusable (it is a boolean predicate). `resolveSessionManagedGitCwd` is a routing function where a `500` internal error is the correct response for an unexpected filesystem failure, and the error should be logged.
>
> **Fix:** Log the caught error (at least `daemonLog?.warn`), and consider returning `null` only for expected `ENOENT`/`EACCES`/`EPERM` while letting other errors propagate as internal errors.
>
> ---
>
> ### Suggestion 1: `resolveSessionManagedGitCwd` uses `execFileSync` on every worktree Git request
>
> Every worktree Git status/diff/log/branch/commit/push/pull request now calls `execFileSync` for `git rev-parse --show-toplevel` and `git rev-parse --git-common-dir` synchronously, blocking the event loop. The `GitWorktreeService` in core uses `simpleGit` (async) for these operations. Consider caching the `repoTop` and `workspaceCommonDir` for the lifetime of the runtime (they don't change), or implementing an async variant.
>
> ---
>
> ### Suggestion 2: (de minimis, already covered by the triage bot)
>
> The triage bot's suggestion to import `WORKTREE_SESSION_FILE` instead of hardcoding the `.qwen-session` literal in `resolveSessionManagedGitCwd` is good — the hardcoded literal is at line ~4470 of the diff.
>
> ---
>
> ### Verdict
>
> No new blockers beyond what the triage bot already identified (the CI red-blocker is the main merge blocker). The two Criticals above are correctness/defense-in-depth issues that should be fixed before merge, but the triage bot's bundle-closure regression is the actual gate. The daemon-side transaction design, authorization chain, and fail-closed semantics are sound. Cross-platform coverage (Windows marker tests already skipIf) and the bundle import issue are the remaining practical concerns.
>
> **Not approving** (consistent with the triage bot's deferral — CI red, maintainer escalation).

### 3. Reserved target-id 测试期望与标题规则冲突

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278210
- 结论：值得修复
- 理由：远端 head 仍在新增测试中期望 Source session (Branch)，而生产 title 规则与相邻用例使用 Source session(1)，断言确定失败；main 的 Llm rename 没有改变该语义。
- 建议修复：更新断言为 Source session(1)，并确保测试失败时也释放 mock connection，避免 teardown rejection。
- 实施状态：已修复并验证
- 修复批次：F1
- 实施证据：断言已改为 `Source session(1)`；对应 ACP test 在最终目标测试中通过。

原始评论：

标注位置：`packages/cli/src/acp-integration/acpAgent.test.ts:17583`（RIGHT（新增侧））

```diff
@@ -17554,6 +17554,64 @@ describe('QwenAgent extMethod renameSession routing', () => {
     await agentPromise;
   });

+  it('uses a daemon-reserved target session id for branch publication', async () => {
+    const targetSessionId = '11111111-1111-4111-8111-111111111111';
+    const recording = makeRecordingService();
+    const sessionService = {
+      forkSession: vi.fn().mockResolvedValue(undefined),
+      findSessionTitlesByPrefix: vi.fn().mockResolvedValue([]),
+    };
+    const innerConfig = makeLiveSessionInnerConfig(recording);
+    innerConfig.getSessionService.mockReturnValue(
+      sessionService as unknown as SessionService,
+    );
+    const { agent, agentPromise } = await bootAgent(innerConfig);
+    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
+
+    const result = await agent.extMethod(
+      SERVE_CONTROL_EXT_METHODS.sessionBranch,
+      {
+        cwd: '/tmp',
+        sessionId: liveSessionId,
+        targetSessionId,
+      },
+    );
+
+    expect(sessionService.forkSession).toHaveBeenCalledWith(
+      liveSessionId,
+      targetSessionId,
+      { title: 'Source session (Branch)' },
```

> **[Critical]** R1-1: Re-checked at the current head (ef450b68): still stands. The test this PR adds — 'uses a daemon-reserved target session id for branch publication' — fails against the PR's own code. The handler derives the fork title via `computeUniqueBranchTitle`, which returns `'Source session(1)'` for the recording service's title `'Source session'`, but this assertion expects the legacy `'Source session (Branch)'`. The sibling `it.each` cases this PR adds already pin the `(1)` convention, and `normalizeDerivedBranchTitle` treats `'(Branch)'` as a legacy token to strip, so the suite cannot go green without reconciling the two — and this is what keeps the cli Test lane red. The failing assertion also leaves `mockConnectionState` unresolved, adding an unhandled rejection at worker teardown.
>
> ```
> Round-4 run: 'uses a daemon-reserved target session id for branch publication'
>   expected: { title: 'Source session (Branch)' }
>   received: { title: 'Source session(1)' }
> Test absent at the built merge base (netNew by test-delta).
> ```
>
> ```suggestion
>       { title: 'Source session(1)' },
> ```
>
> After applying the fix, confirm this test goes green — that is the acceptance criterion for this change.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R1-1：已在当前 head（ef450b68）复查：仍然存在。本 PR 新增测试 'uses a daemon-reserved target session id for branch publication' 仍在本 PR 代码上失败——handler 通过 `computeUniqueBranchTitle` 派生分叉标题，对 'Source session' 返回 `'Source session(1)'`，断言却期望旧式 `'Source session (Branch)'`。本 PR 新增的兄弟 `it.each` 用例已钉住 `(1)` 约定，且 `normalizeDerivedBranchTitle` 将 `'(Branch)'` 视为要剥离的遗留标记，因此两者不对齐该套件无法变绿——这正是 cli Test 通道保持红灯的原因。失败的断言还使 `mockConnectionState` 未 resolve，teardown 时产生未处理 rejection。第 4 轮证据：该测试在 PR 树上失败（期望 'Source session (Branch)'，收到 'Source session(1)'）；在构建后的 merge base 上不存在（test-delta 判定 netNew）。请将期望对齐到实现的约定（见 suggestion）。修复后确认该测试变绿（验收标准）。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 4. Session-writable durable 文件可触发无界读取与 OOM

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278232
- 结论：值得修复
- 理由：marker、sidecar、journal 和共享 reader 仍在 shape/UUID 校验前读取整个文件；inode/no-follow 不能限制内存分配，Git status 轮询会反复触发 marker/sidecar 热路径，评论描述的持久化 OOM 与 symlink gap 均成立。
- 建议修复：为 marker、worktree sidecar、journal 建立共享严格 bounded reader：fstat size cap、固定最大读取、O_NOFOLLOW、单链接及 dev/ino 前后复验；补 oversized/symlink/hardlink 测试。
- 实施状态：已修复并验证
- 修复批次：F2
- 实施证据：marker 上限 256 B，sidecar/journal 上限 64 KiB；四处读取均改为固定缓冲区并保留 inode/no-follow 检查。oversized marker、sidecar、journal 及 symlink/hardlink 回归测试通过。

原始评论：

标注位置：`packages/cli/src/serve/workspace-route-runtime.ts:447`（RIGHT（新增侧））

```diff
@@ -401,3 +404,147 @@ export function resolveContainedCwdOrFail(
   }
   return null;
 }
+
+function pathIsWithin(candidate: string, root: string): boolean {
+  const relative = path.relative(root, candidate);
+  return (
+    relative === '' ||
+    (!relative.startsWith('..') && !path.isAbsolute(relative))
+  );
+}
+
+function resolveGitCommonDir(cwd: string): string | null {
+  try {
+    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
+      cwd,
+      encoding: 'utf8',
+      timeout: 30_000,
+    }).trim();
+    return fs.realpathSync(path.resolve(cwd, raw));
+  } catch {
+    return null;
+  }
+}
+
+function markerIsOwnedBy(markerPath: string, sessionId: string): boolean {
+  let fd: number | undefined;
+  try {
+    const pathStat = fs.lstatSync(markerPath);
+    if (!pathStat.isFile() || pathStat.nlink !== 1) return false;
+    fd = fs.openSync(
+      markerPath,
+      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
+    );
+    const openedStat = fs.fstatSync(fd);
+    if (
+      !openedStat.isFile() ||
+      openedStat.nlink !== 1 ||
+      openedStat.dev !== pathStat.dev ||
+      openedStat.ino !== pathStat.ino
+    ) {
+      return false;
+    }
+    const owner = fs.readFileSync(fd, 'utf8').trim();
```

> **[Critical]** R1-2: Re-checked at the current head (ef450b68): still stands. `markerIsOwnedBy` reads the session-writable `.qwen-session` marker with an unbounded `fs.readFileSync(fd, 'utf8')` — a legitimate owner is a 36-char UUID, yet the entire file is allocated before validation. The marker lives at the branched session's execution cwd, so that session's own tool execution (or any same-user process) can grow it, and every git-route request for a branched session runs this read while Web Shell polls every 30 s — a multi-GB planted marker OOM-kills the daemon that hosts every workspace, re-triggered until the file is hand-deleted. The same unbounded family remains open at the sidecar read in this file (line 532, which also follows symlinks), `readWorktreeSessionMarker` in core (gitWorktreeService.ts:220), `replaceWorktreeSessionMarker`'s direct read (gitWorktreeService.ts:170), `readStrictFile` (branch-worktree-preparation.ts:152), and `readWorktreeSession` (worktreeSessionService.ts:96).
>
> ```
> Round-3 probe at HEAD: 120 MiB planted .qwen-session marker, one resolveSessionManagedGitCwd request
>   PR:   rssDeltaMiB=124.1  (whole file allocated)
>   FIX:  rssDeltaMiB=0.9    (4096-byte size bound; probe flips)
> Round-1 probe: 400 MB marker under a 512 MB heap limit -> V8 heap-exhaustion abort.
> ```
>
> Fail closed on size before reading (stat, then refuse files past a small bound), and consolidate all of these sites — including `readWorktreeSession` — onto one bounded, identity-checked reader so the copies cannot drift. A test planting an oversized marker must assert the resolver returns null without buffering it; removing the size bound must turn it red.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R1-2：已在当前 head（ef450b68）复查：仍然存在。`markerIsOwnedBy` 以无界的 `fs.readFileSync(fd, 'utf8')` 读取会话可写的 `.qwen-session` 标记——合法 owner 是 36 字符 UUID，代码却先完整分配整个文件再校验。标记位于分支会话的执行 cwd，该会话自己的工具执行（或任何同用户进程）可以扩大它；每个针对分支会话的 git 路由请求都会执行该读取，而 Web Shell 每 30 秒轮询一次——植入数 GB 的标记会令承载所有工作区的 daemon OOM，且反复触发直至手工删除。同族无界读取仍存在于：本文件 532 行的 sidecar 读取（还会跟随符号链接）、core 的 `readWorktreeSessionMarker`（gitWorktreeService.ts:220）、`replaceWorktreeSessionMarker` 的直接读取（:170）、`readStrictFile`（branch-worktree-preparation.ts:152）与 `readWorktreeSession`（worktreeSessionService.ts:96）。第 3 轮探测：植入 120 MiB 标记，一次请求 RSS +124.1 MiB；加 4096 字节上限后 +0.9 MiB（探测翻转）。请在读取前按大小失败关闭，并将上述所有读取点统一到同一个有界、带身份校验的读取器；补充植入超大标记的测试，移除上限应使其变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 5. Worktree branch 201 响应缺少 skill-details redaction

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278238
- 结论：值得修复
- 理由：worktree branch 成功路径仍直接 res.status(201).json(restored)，而 load/resume、普通 branch、side-task 都应用 omitSkillDetailsFromReplayArrays()；新增浏览器 egress 违反 #9234 redaction 不变量。
- 建议修复：对 worktree 201 响应应用 redaction helper，并添加含 availableSkillDetails replay 的 response-level 回归测试。
- 实施状态：已修复并验证
- 修复批次：F3
- 实施证据：worktree branch 201 响应现统一调用 `omitSkillDetailsFromReplayArrays`；成功 route 测试注入 `availableSkillDetails` 并确认响应删除正文、保留 `availableSkills`。

原始评论：

标注位置：`packages/cli/src/serve/routes/session.ts:4414`（RIGHT（新增侧））

```diff
@@ -4058,6 +4087,413 @@ export function registerSessionRoutes(
         }
         const clientId = parseClientIdHeader(req, res);
         if (clientId === null) return;
+        const rawWorktree = body?.['worktree'];
+        if (rawWorktree !== undefined) {
+          if (!runtime.trusted) {
+            res.status(403).json({
+              error: 'Worktree creation requires a trusted workspace',
+              code: 'untrusted_workspace',
+            });
+            return;
+          }
+          if (
+            rawWorktree === null ||
+            typeof rawWorktree !== 'object' ||
+            Array.isArray(rawWorktree)
+          ) {
+            res.status(400).json({
+              error: '`worktree` must be an object',
+              code: 'invalid_worktree',
+            });
+            return;
+          }
+          const worktreeRequest = rawWorktree as Record<string, unknown>;
+          const rawSlug = worktreeRequest['slug'];
+          const slug =
+            rawSlug === undefined
+              ? GitWorktreeService.generateAutoSlug()
+              : rawSlug;
+          if (typeof slug !== 'string' || slug.length === 0) {
+            res.status(400).json({
+              error: '`worktree.slug` must be a non-empty string',
+              code: 'worktree_invalid_slug',
+            });
+            return;
+          }
+          const slugError = GitWorktreeService.validateUserWorktreeSlug(slug);
+          if (slugError) {
+            res.status(400).json({
+              error: slugError,
+              code: 'worktree_invalid_slug',
+            });
+            return;
+          }
+
+          const sessionService = createWorkspaceRuntimeSessionService(runtime);
+          if (runtime.bridge.getSessionSummary(sessionId).hasActivePrompt) {
+            throw new BranchWhilePromptActiveError(sessionId);
+          }
+          const snapshot =
+            runtime.bridge.getSessionExecutionSnapshot(sessionId);
+          const base = await resolveBranchWorktreeBaseCheckout({
+            workspaceCwd: runtime.workspaceCwd,
+            sessionId,
+            snapshot,
+            sidecarPath: sessionService.getWorktreeSessionPath(sessionId),
+          });
+          if (!base) {
+            res.status(409).json({
+              error:
+                'The current session cwd cannot be used as a worktree base',
+              code: 'worktree_base_checkout_unsupported',
+            });
+            return;
+          }
+          if (!(await isBranchWorktreeCreationSupported(base))) {
+            res.status(500).json({
+              error: 'Worktree creation is not available for this checkout',
+              code: 'worktree_create_failed',
+            });
+            return;
+          }
+
+          const targetSessionId = crypto.randomUUID();
+          await archiveCoordinator.runSharedMany(
+            [targetSessionId],
+            async () => {
+              let reservation: RequestedSessionIdReservation | undefined;
+              let worktreeCreated = false;
+              let markerCreated = false;
+              let mutationDispatched = false;
+              let published: BridgePersistedBranchedSession | undefined;
+              let restored: BridgeBranchedSession | undefined;
+              const worktreeService = new GitWorktreeService(base.repoTop);
+              const sidecarPath =
+                sessionService.getWorktreeSessionPath(targetSessionId);
+              const journalPath = getBranchWorktreeJournalPath(
+                sidecarPath,
+                targetSessionId,
+              );
+              let journal: BranchWorktreePreparationJournal | undefined;
+              const cleanupPrepared = async (): Promise<void> => {
+                if (!journal) return;
+                if (
+                  await sessionService.sessionExistsInAnyState(targetSessionId)
+                ) {
+                  await clearBranchWorktreeJournalDurable(journalPath);
+                  return;
+                }
+                if (!worktreeCreated) {
+                  const pathExists = await fs.promises
+                    .lstat(journal.worktreePath)
+                    .then(() => true)
+                    .catch((error: NodeJS.ErrnoException) => {
+                      if (error.code === 'ENOENT') return false;
+                      throw error;
+                    });
+                  if (!pathExists) {
+                    await clearBranchWorktreeJournalDurable(journalPath);
+                  } else {
+                    daemonLog?.warn(
+                      'planned branch worktree residue preserved',
+                      { targetSessionId },
+                    );
+                  }
+                  return;
+                }
+                if (!journal.sidecarCreated) {
+                  const sidecarExists = await fs.promises
+                    .lstat(sidecarPath)
+                    .then(() => true)
+                    .catch((error: NodeJS.ErrnoException) => {
+                      if (error.code === 'ENOENT') return false;
+                      throw error;
+                    });
+                  if (sidecarExists) {
+                    daemonLog?.warn(
+                      'branch worktree sidecar ownership is unknown',
+                      { targetSessionId },
+                    );
+                    return;
+                  }
+                }
+                journal = await updateBranchWorktreeJournal(
+                  journalPath,
+                  journal,
+                  'cleanup-intent',
+                );
+                const removed =
+                  await worktreeService.removePreparedUserWorktree(
+                    slug,
+                    markerCreated ? targetSessionId : null,
+                    base.headCommit,
+                    async () => {
+                      journal = await updateBranchWorktreeJournal(
+                        journalPath,
+                        journal!,
+                        'worktree-removed',
+                      );
+                      runtime.generationGuard?.assertOpen();
+                    },
+                  );
+                if (!removed.success) {
+                  daemonLog?.warn('branch worktree cleanup refused', {
+                    targetSessionId,
+                    error: removed.error,
+                  });
+                  return;
+                }
+                journal = await updateBranchWorktreeJournal(
+                  journalPath,
+                  journal,
+                  removed.branchPreserved
+                    ? 'branch-preserved'
+                    : 'branch-deleted',
+                );
+                if (removed.branchPreserved) {
+                  daemonLog?.warn('branch worktree cleanup preserved branch', {
+                    targetSessionId,
+                    branch: journal.worktreeBranch,
+                  });
+                }
+                if (journal.sidecarCreated) {
+                  await clearWorktreeSessionDurable(sidecarPath);
+                } else {
+                  const lateSidecarExists = await fs.promises
+                    .lstat(sidecarPath)
+                    .then(() => true)
+                    .catch((error: NodeJS.ErrnoException) => {
+                      if (error.code === 'ENOENT') return false;
+                      throw error;
+                    });
+                  if (lateSidecarExists) {
+                    daemonLog?.warn(
+                      'branch worktree sidecar ownership is unknown',
+                      { targetSessionId },
+                    );
+                    return;
+                  }
+                }
+                await clearBranchWorktreeJournalDurable(journalPath);
+              };
+              const releaseRestored = async (): Promise<void> => {
+                if (!restored) return;
+                if (restored.attached) {
+                  await runtime.bridge
+                    .detachClient(restored.sessionId, restored.clientId)
+                    .catch(() => {});
+                } else {
+                  await runtime.bridge
+                    .killSession(restored.sessionId, {
+                      requireZeroAttaches: true,
+                    })
+                    .catch(() => false);
+                }
+              };
+
+              try {
+                reservation = await requestedSessionIdAdmission.reserveCreate(
+                  targetSessionId,
+                  {
+                    bridge: runtime.bridge,
+                    workspaceCwd: runtime.workspaceCwd,
+                    workspaceId: runtime.workspaceId,
+                  },
+                );
+                runtime.generationGuard?.assertOpen();
+                journal = await createBranchWorktreeJournal({
+                  journalPath,
+                  targetSessionId,
+                  slug,
+                  worktreePath: worktreeService.getUserWorktreePath(slug),
+                  worktreeBranch: worktreeBranchForSlug(slug),
+                  repoTop: base.repoTop,
+                  baseCommit: base.headCommit,
+                  sidecarPath,
+                });
+                runtime.generationGuard?.assertOpen();
+                const worktreeResult = await worktreeService.createUserWorktree(
+                  slug,
+                  base.headCommit,
+                );
+                if (!worktreeResult.success || !worktreeResult.worktree) {
+                  await cleanupPrepared();
+                  res.status(500).json({
+                    error: 'Failed to create worktree',
+                    code: 'worktree_create_failed',
+                  });
+                  return;
+                }
+                worktreeCreated = true;
+                journal = await updateBranchWorktreeJournal(
+                  journalPath,
+                  journal,
+                  'worktree-created',
+                );
+                runtime.generationGuard?.assertOpen();
+                const worktree = {
+                  slug,
+                  path: worktreeResult.worktree.path,
+                  branch: worktreeResult.worktree.branch,
+                };
+                await createWorktreeSessionMarker(
+                  worktree.path,
+                  targetSessionId,
+                );
+                markerCreated = true;
+                journal = await updateBranchWorktreeJournal(
+                  journalPath,
+                  journal,
+                  'marker-created',
+                );
+                runtime.generationGuard?.assertOpen();
+                await createWorktreeSession(sidecarPath, {
+                  slug,
+                  worktreePath: worktree.path,
+                  worktreeBranch: worktree.branch,
+                  originalCwd: base.repoTop,
+                  originalBranch: base.branch,
+                  originalHeadCommit: base.headCommit,
+                });
+                journal = await updateBranchWorktreeJournal(
+                  journalPath,
+                  journal,
+                  'sidecar-ready',
+                );
+
+                runtime.generationGuard?.assertOpen();
+                journal = await updateBranchWorktreeJournal(
+                  journalPath,
+                  journal,
+                  'mutation-dispatched',
+                );
+                runtime.generationGuard?.assertOpen();
+                mutationDispatched = true;
+                published = (await runtime.bridge.branchSession(
+                  sessionId,
+                  {
+                    name,
+                    ...(atRecordId !== undefined ? { atRecordId } : {}),
+                    targetSessionId,
+                    persistOnly: true,
+                  },
+                  { clientId },
+                )) as BridgePersistedBranchedSession;
+                await clearBranchWorktreeJournalDurable(journalPath);
+
+                runtime.generationGuard?.assertOpen();
+                const loaded = await runtime.bridge.loadSession({
+                  sessionId: targetSessionId,
+                  workspaceCwd: runtime.workspaceCwd,
+                  historyReplay: 'response',
+                  ...(clientId !== undefined ? { clientId } : {}),
+                });
+                restored = {
+                  ...loaded,
+                  displayName: published.displayName,
+                  forkedFrom: published.forkedFrom,
+                };
+                runtime.generationGuard?.assertOpen();
+                const changed = await runtime.bridge.changeSessionCwd(
+                  targetSessionId,
+                  {
+                    path: worktree.path,
+                    allowedRoots: [
+                      path.join(base.repoTop, '.qwen', 'worktrees'),
+                    ],
+                  },
+                );
+                runtime.generationGuard?.assertOpen();
+                runtime.bridge.setSessionWorktree(targetSessionId, worktree);
+                restored.currentCwd = changed.newCwd;
+                restored.worktree = worktree;
+                if (!res.writable) {
+                  await releaseRestored();
+                  return;
+                }
+                res.status(201).json(restored);
```

> **[Critical]** R1-3: Re-checked at the current head (ef450b68): still stands — and independently re-derived this round by two separate review agents. The worktree-branch 201 response is still built from `bridge.loadSession({ historyReplay: 'response' })` and sent without `omitSkillDetailsFromReplayArrays` — the #9234 redaction every other SDK/browser egress in this file applies (the load route ~3926 with a comment citing #9234, legacy load/resume, and this handler's own sibling non-worktree branch at 4532 and side-task path at 4602). With skills installed, each `available_commands_update` frame in the replay snapshot embeds every skill's full SKILL.md body under `update._meta.availableSkillDetails` — hundreds of KB of payload bloat #9234 removed. The helper is already imported in this file and is a no-op when no replay arrays are present, so this is safe unconditionally.
>
> ```
> Round-3 probe replaying the full route at HEAD:
>   PR:  201 body carries availableSkillDetails [{"name":"bugfix","body":"PROBE-SKILL-BODY"}]
>   FIX: wrapped in omitSkillDetailsFromReplayArrays -> field absent (probe flips)
> ```
>
> ```suggestion
>                 res.status(201).json(omitSkillDetailsFromReplayArrays(restored));
> ```
>
> Extend 'publishes and activates a branch inside a new managed worktree' in server.test.ts so the fake bridge's `loadSession` returns a `compactedReplay` frame with `_meta.availableSkillDetails`, and assert the 201 body no longer carries it — deleting the redaction call must turn that test red.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R1-3：已在当前 head（ef450b68）复查：仍然存在，且本轮由两个独立评审代理分别重新发现。worktree 分支的 201 响应仍由 `bridge.loadSession({ historyReplay: 'response' })` 构建且未经过 `omitSkillDetailsFromReplayArrays` 脱敏——即本文件中所有其他 SDK/浏览器出口都在应用的 #9234 脱敏（load 路由 ~3926 有引用 #9234 的注释、旧版 load/resume、以及本 handler 的非 worktree 分支 4532 与 side-task 路径 4602）。安装较多 skills 时，每个 `available_commands_update` 帧都会在 `update._meta.availableSkillDetails` 下内嵌全部 skill 的完整 SKILL.md 正文——正是 #9234 已消除的数百 KB 负载膨胀。该 helper 已在本文件导入且无 replay 数组时是空操作。第 3 轮探测：PR 侧 201 响应携带 availableSkillDetails；包上脱敏后字段缺失（探测翻转）。请应用脱敏（见 suggestion），并在 server.test.ts 的成功测试中让 `loadSession` 返回带 `_meta.availableSkillDetails` 的帧，断言 201 响应不再携带该字段——删除脱敏调用应使测试变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 6. Git repo-top 探测失败时授权 fail-open

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278250
- 结论：值得修复
- 理由：git rev-parse --show-toplevel 的任何异常仍退化为 workspace containment，跳过 sessionId、snapshot、sidecar、marker 和 common-dir 校验；timeout/spawn/I/O 失败可授权另一个 managed worktree，与 fail-closed 设计冲突。
- 建议修复：把非 Git workspace 与 probe failure 分型；身份不明一律拒绝或传播内部错误，并补 probe failure 指向其他 worktree 的测试。
- 实施状态：已修复并验证
- 修复批次：F3
- 实施证据：只有 Git 明确报告 `not a git repository` 时才保留 contained non-Git fallback；PATH/spawn 等未知探测失败一律返回 null。两类分支均有回归测试并通过。

原始评论：

标注位置：`packages/cli/src/serve/workspace-route-runtime.ts:490`（RIGHT（新增侧））

```diff
@@ -401,3 +404,147 @@ export function resolveContainedCwdOrFail(
   }
   return null;
 }
+
+function pathIsWithin(candidate: string, root: string): boolean {
+  const relative = path.relative(root, candidate);
+  return (
+    relative === '' ||
+    (!relative.startsWith('..') && !path.isAbsolute(relative))
+  );
+}
+
+function resolveGitCommonDir(cwd: string): string | null {
+  try {
+    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
+      cwd,
+      encoding: 'utf8',
+      timeout: 30_000,
+    }).trim();
+    return fs.realpathSync(path.resolve(cwd, raw));
+  } catch {
+    return null;
+  }
+}
+
+function markerIsOwnedBy(markerPath: string, sessionId: string): boolean {
+  let fd: number | undefined;
+  try {
+    const pathStat = fs.lstatSync(markerPath);
+    if (!pathStat.isFile() || pathStat.nlink !== 1) return false;
+    fd = fs.openSync(
+      markerPath,
+      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
+    );
+    const openedStat = fs.fstatSync(fd);
+    if (
+      !openedStat.isFile() ||
+      openedStat.nlink !== 1 ||
+      openedStat.dev !== pathStat.dev ||
+      openedStat.ino !== pathStat.ino
+    ) {
+      return false;
+    }
+    const owner = fs.readFileSync(fd, 'utf8').trim();
+    const finalStat = fs.lstatSync(markerPath);
+    return (
+      finalStat.isFile() &&
+      finalStat.nlink === 1 &&
+      finalStat.dev === openedStat.dev &&
+      finalStat.ino === openedStat.ino &&
+      owner === sessionId
+    );
+  } catch {
+    return false;
+  } finally {
+    if (fd !== undefined) fs.closeSync(fd);
+  }
+}
+
+export function resolveSessionManagedGitCwd(
+  req: Request,
+  runtime: WorkspaceRuntime,
+): string | null {
+  const rawCwd = req.query['cwd'];
+  if (rawCwd === undefined) return runtime.workspaceCwd;
+  if (typeof rawCwd !== 'string' || rawCwd.length === 0) return null;
+
+  let requested: string;
+  let workspace: string;
+  try {
+    requested = fs.realpathSync(path.resolve(rawCwd));
+    workspace = fs.realpathSync(runtime.workspaceCwd);
+  } catch {
+    return null;
+  }
+
+  let repoTop: string | undefined;
+  try {
+    repoTop = fs.realpathSync(
+      execFileSync('git', ['rev-parse', '--show-toplevel'], {
+        cwd: workspace,
+        encoding: 'utf8',
+        timeout: 30_000,
+      }).trim(),
+    );
+  } catch {
+    return pathIsWithin(requested, workspace) ? requested : null;
```

> **[Critical]** R1-4: Re-checked at the current head (ef450b68): still stands. The catch around the `git rev-parse --show-toplevel` probe returns `pathIsWithin(requested, workspace) ? requested : null` on ANY failure, conflating 'workspace is not a git repository' (the only case where containment-only authorization is sound — no managed worktree can exist there) with 'the git probe failed' (an unknown state). On the healthy path this function requires the full sessionId → snapshot → sidecar → marker chain for any cwd under `<repoTop>/.qwen/worktrees`; this catch skips all of it, and all twelve converted git routes funnel through here — contradicting design doc §7.1 step 5 and the PR's own test 'authorizes only the live session that owns the managed worktree'.
>
> ```
> Round-3 probe at HEAD:
>   healthy probe:            unbound request -> result=null (strict chain rejects)
>   git removed from PATH:    same request   -> result=<repo>/.qwen/worktrees/branch-a (AUTHORIZED)
>   stderr-discriminating catch: result=null, legitimate non-git fallback preserved (probe flips)
> ```
>
> Fail closed on unknown errors: fall back to containment-only when git deterministically reports 'not a git repository' (inspect the non-zero exit's stderr); return null for spawn/timeout/realpath failures. Add a test making the toplevel probe throw and asserting the resolver returns null for a cwd under the managed root; widening the catch back to containment-only must turn it red.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R1-4：已在当前 head（ef450b68）复查：仍然存在。`git rev-parse --show-toplevel` 探测的 catch 在任何失败时返回 `pathIsWithin(requested, workspace) ? requested : null`，把"工作区不是 git 仓库"（唯一适合仅按包含关系授权的情形——其中不可能存在 managed worktree）与"git 探测失败"（未知状态）混为一谈。正常路径下，对 `<repoTop>/.qwen/worktrees` 内的任何 cwd 都要求完整的 sessionId → 快照 → sidecar → 标记链；此 catch 会跳过全部检查，且全部十二条已迁移的 git 路由都经过这里——与设计文档 §7.1 第 5 步及本 PR 自身测试相矛盾。第 3 轮探测：正常探测拒绝未绑定请求（result=null）；从 PATH 移除 git 后同一请求被授权返回受害 worktree 路径；将 catch 改为仅对 'not a git repository' 降级后失败关闭、合法非 git 回退保留（探测翻转）。请对未知错误失败关闭并补充相应测试；把 catch 放宽回仅包含关系应使测试变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 7. Startup marker adoption 拒绝被唯一调用方吞掉

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278258
- 结论：值得修复
- 理由：owner active/CAS 失败仍由 persistStartupWorktreeSidecar 抛出，但唯一生产调用方在 cwd 已切换后以 non-fatal catch 吞掉并继续，导致 sidecar 缺失且后续 resume 丢失 worktree binding；main 只重命名 llm 标识，没有修复流程。
- 建议修复：在 chdir 前完成 ownership/adoption 验证，或让 ownership error 穿透 non-fatal catch 并终止/回滚 startup；显式区分普通 sidecar I/O。
- 实施状态：已修复并验证
- 修复批次：F4
- 实施证据：active owner 使用 typed `WorktreeOwnershipConflictError`，`llm.tsx` 不再吞掉该错误；非 ownership marker I/O 仍允许 durable sidecar 落盘。active-owner、同 owner、非 ownership failure 测试通过。

原始评论：

标注位置：`packages/cli/src/startup/worktreeStartup.ts:417`（RIGHT（新增侧））

```diff
@@ -411,14 +413,16 @@ export async function persistStartupWorktreeSidecar(
         );
         return true;
       });
-      shouldWriteMarker = !ownerActive;
+      if (ownerActive) {
+        throw new Error(`Worktree is owned by active session ${owner}`);
```

> **[Critical]** R1-5: Re-checked at the current head (ef450b68): still stands — re-derived independently this round by a territory agent. The new adoption-rejection throw is neutralized by its only production caller. `setupStartupWorktree` already ran `process.chdir` into the worktree before persist (no ownership check before chdir); this throw then fires inside `persistStartupWorktreeSidecar`, whose sole production caller (gemini.tsx:958-961, untouched by this PR) wraps the call in a catch-all that logs `debugLogger.warn('--worktree sidecar persist failed (non-fatal...)')` — a no-op unless `QWEN_DEBUG_LOG_FILE` is set — and continues startup. Because the throw fires before `writeWorktreeSession`, the guard never rejects anything user-visible and silently drops the sidecar write the pre-PR code performed unconditionally. Design doc §10 requires adoption to abort on CAS failure.
>
> Failure: Terminal A runs `qwen --worktree demo` (session A active, marker=A). Terminal B runs the same command: the persist throws, gemini.tsx catches and continues — session B starts inside A's working tree with zero user-visible error, two live sessions sharing one checkout (git index-lock contention, interleaved edits), the exact hazard the marker ownership model exists to police. Additionally B never gets a sidecar, so a later `qwen --resume <B>` resumes outside the worktree, silently orphaning B from the branch it committed to.
>
> witness: not run — settling it end-to-end requires two concurrent authenticated interactive `qwen --worktree` launches with live session-runtime detection; the verdict rests on the quoted straight-line code: chdir at worktreeStartup.ts:236 preceding the persist, the catch-and-warn-only at gemini.tsx:965-969, and the diff's deleted unconditional `writeWorktreeSession`.
>
> Make the rejection effective: perform the ownership check in `setupStartupWorktree` before `process.chdir` and return `{ ok: false, error }` via its existing refusal channel (or throw a typed error gemini.tsx distinguishes, prints to stderr, and aborts startup for). Separately, restore pre-PR semantics for non-ownership marker failures so they cannot abort the sidecar write. The fix owes a startup-path test asserting an actively-owned re-attach aborts startup or emits a visible stderr error, and a persist test asserting a marker write failure still writes the sidecar; removing either guard must turn them red.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R1-5：已在当前 head（ef450b68）复查：仍然存在，本轮由一个区域代理独立重新发现。新增的"收养拒绝"throw 被其唯一生产调用方化解。`setupStartupWorktree` 在 persist 之前已 `process.chdir` 进入 worktree（chdir 前无所有权检查）；该 throw 发生在 `persistStartupWorktreeSidecar` 内，而其唯一生产调用方（gemini.tsx:958-961，本 PR 未改动）用 catch-all 包裹，仅 `debugLogger.warn`（未设 `QWEN_DEBUG_LOG_FILE` 时为空操作）然后继续启动。由于 throw 先于 `writeWorktreeSession` 触发，该守卫对用户从不可见，并悄悄丢掉了 PR 之前无条件执行的 sidecar 写入。设计文档 §10 要求 CAS 失败必须终止收养。故障场景：终端 A 运行 `qwen --worktree demo`（会话 A 活跃，marker=A）；终端 B 运行同一命令：persist 抛错，gemini.tsx 捕获后继续——会话 B 在零用户可见错误的情况下进入 A 的工作树，两个活跃会话共享一个 checkout；此外 B 没有 sidecar，之后 `qwen --resume <B>` 会在 worktree 之外恢复。证据：未运行——端到端需要两个并发的交互式启动；结论基于所引代码。请让拒绝生效：在 chdir 之前做所有权检查并经既有拒绝通道返回；同时恢复非所有权标记失败仍写 sidecar 的 PR 前语义。修复需附启动路径测试与 persist 测试；移除任一应使其变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 8. BranchPicker 新参数未同步既有测试

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278266
- 结论：值得修复
- 理由：生产调用已经是 workspaceGitCheckout(ref, gitCwd, gitSessionId)，但远端 head 的 WorkspaceSection test 仍只断言两个参数，第三个 undefined 会导致 Vitest 参数匹配失败。
- 建议修复：把普通场景断言更新为第三参数 undefined，并新增 worktree owning session id 的正向断言。
- 实施状态：已修复并验证
- 修复批次：F1
- 实施证据：既有断言已更新为三参数；新增真实 `gitCwd`/`gitSessionId` 的 worktree checkout 转发测试。Web Shell 相关 581 个测试全部通过。

原始评论：

标注位置：`packages/web-shell/client/components/BranchPickerPopover.tsx:132`（RIGHT（新增侧））

```diff
@@ -127,7 +129,7 @@ export function BranchPickerPopover({
       if (busyAction) return;
       setBusyAction('checkout');
       try {
-        await ws.workspaceGitCheckout(ref, gitCwd);
+        await ws.workspaceGitCheckout(ref, gitCwd, gitSessionId);
```

> **[Critical]** R1-7: Re-checked at the current head (ef450b68): still stands. This PR changed the picker's checkout call to pass a third `gitSessionId` argument, but the pre-existing `WorkspaceSection.test.tsx` test ('re-fetches git status right after a picker checkout instead of waiting for the poll', line 1037 — not updated by this PR) still expects a 2-argument call, so `npm test --workspace=packages/web-shell` fails. This is the PR's own failure, and it is what keeps the web-shell CI lane red.
>
> ```
> Round-4 measurement (re-run this round): netNew failure
>   fails on the PR head — AssertionError: expected "spy" to be called with arguments: [ 'main', undefined ]
>   — the call received an extra third argument (undefined)
>   passes on the built merge base
> ```
>
> Update the untouched existing test to the new 3-arg signature in `packages/web-shell/client/components/sidebar/WorkspaceSection.test.tsx`:
>
> ```ts
> expect(workspaceGitCheckout).toHaveBeenCalledWith(
>   'main',
>   undefined,
>   undefined,
> );
> ```
>
> That assertion is currently the only pin on this call shape — it must go green; consider also adding a case with a real `gitCwd`/`gitSessionId` pair (see the forwarding-witness comment on line 232).
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R1-7：已在当前 head（ef450b68）复查：仍然存在。本 PR 将分支选择器的 checkout 调用改为传递第三个参数 `gitSessionId`，但既有的 `WorkspaceSection.test.tsx` 测试（第 1037 行，本 PR 未更新）仍期望 2 参数调用，导致 `npm test --workspace=packages/web-shell` 失败。这是本 PR 自身引入的失败，也是 web-shell CI 通道红灯的原因。第 4 轮重新测量：在 PR 树上失败（断言收到多余的第三个参数 undefined）、在构建后的 merge base 上通过（netNew）。请将既有测试更新为 3 参数签名；由于该断言是目前唯一钉住此调用形状的测试，建议再补充带真实 `gitCwd`/`gitSessionId` 的用例。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 9. 旧 branch promise 会关闭新 session 的 dialog

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278280
- 结论：值得修复
- 理由：confirmBranchSession 的 finally 仍无条件清 busy/关闭 dialog；A 请求结算可覆盖切换后 B 的新 dialog。pending map 只去重请求，不保护 dialog ownership，跨 session lifecycle race 仍存在。
- 建议修复：用 confirmed dialog identity/request token 做函数式清理，只允许拥有同一 sourceSessionId/atRecordId 的 promise 修改 dialog 与 busy，并补 A pending→B dialog→A settle 测试。
- 实施状态：已修复并验证
- 修复批次：F6
- 实施证据：confirm 时捕获 dialog 对象身份，promise finally 仅在同一 dialog 仍为 current 时清 busy/关闭；A pending→切 B→开 B dialog→A settle 的回归测试通过。

原始评论：

标注位置：`packages/web-shell/client/App.tsx:8583-8586`（RIGHT（新增侧））

```diff
@@ -8423,16 +8512,80 @@ export function App({
       requireActiveSessionForLocalCommand,
       sessionWriteBlocked,
       sessionActions,
+      sessionCatalogController,
       store,
       t,
       transcriptReloadSupported,
     ],
   );
   const handleBranchCurrentSession = useCallback(
     (atRecordId?: string) => {
-      return branchCurrentSession(undefined, atRecordId);
+      const sourceSessionId = connectionRef.current.sessionId;
+      const sourceWorkspaceCwd = connectionRef.current.workspaceCwd;
+      if (!branchWorktreeEligible || !sourceSessionId || !sourceWorkspaceCwd) {
+        return branchCurrentSession({ atRecordId });
+      }
+      return (async () => {
+        try {
+          const status = await workspace.client
+            .workspaceByCwd(sourceWorkspaceCwd)
+            .workspaceGit({
+              cwd: sessionWorktree?.path,
+              sessionId: sourceSessionId,
+            });
+          if (connectionRef.current.sessionId !== sourceSessionId) return;
+          setSelectedWorkspaceGitStatus(status);
+          if (status.worktreeSupported !== true) {
+            return branchCurrentSession({ atRecordId });
+          }
+        } catch {
+          if (connectionRef.current.sessionId !== sourceSessionId) return;
+          return branchCurrentSession({ atRecordId });
+        }
+        setBranchSessionDialog({ sourceSessionId, atRecordId });
+        setBranchSessionDialogBusy(false);
+      })();
     },
-    [branchCurrentSession],
+    [
+      branchCurrentSession,
+      branchWorktreeEligible,
+      sessionWorktree?.path,
+      workspace.client,
+    ],
+  );
+
+  useEffect(() => {
+    if (
+      branchSessionDialog &&
+      (connection.sessionId !== branchSessionDialog.sourceSessionId ||
+        !branchWorktreeEligible)
+    ) {
+      setBranchSessionDialog(undefined);
+      setBranchSessionDialogBusy(false);
+    }
+  }, [branchSessionDialog, branchWorktreeEligible, connection.sessionId]);
+
+  const confirmBranchSession = useCallback(
+    (isolation: BranchSessionIsolation) => {
+      if (!branchSessionDialog || branchSessionDialogBusy) return;
+      if (
+        connectionRef.current.sessionId !== branchSessionDialog.sourceSessionId
+      ) {
+        setBranchSessionDialog(undefined);
+        setBranchSessionDialogBusy(false);
+        return;
+      }
+      setBranchSessionDialogBusy(true);
+      const result = branchCurrentSession({
+        atRecordId: branchSessionDialog.atRecordId,
+        ...(isolation === 'worktree' ? { worktree: {} } : {}),
+      });
+      Promise.resolve(result).finally(() => {
+        setBranchSessionDialogBusy(false);
+        setBranchSessionDialog(undefined);
+      });
```

> **[Critical]** R2-1: Re-checked at the current head (ef450b68): still stands. `confirmBranchSession`'s completion callback writes dialog state unconditionally, so a settling branch request from session A closes a freshly opened isolation dialog belonging to session B and resets its double-submit busy guard. Nothing cancels a source session's pending callback on session switch — the close effect at ~8557 only clears state, the in-flight promise still settles and re-writes it, and `pendingBranchRequestsRef` dedupes requests but does not gate these writes.
>
> Concretely: the user confirms 'New worktree' on session A (the request takes seconds — worktree prep, fork, publish, activate), switches to session B and opens B's isolation dialog; when A's request finally settles, this unguarded `finally` wipes B's dialog mid-selection (no branch request is ever sent for B — the user must reopen and re-select) and resets `branchSessionDialogBusy` even if B's own request is already in flight.
>
> ```
> Round-3 probe at HEAD:
>   PR:  dialogAfterStaleSettle=false (session-2's radio group gone), branchSessionCalls=1
>   FIX: identity-guarded completion writes -> dialogAfterStaleSettle=true (probe flips)
> ```
>
> Capture the confirmed dialog's identity and guard the completion writes, e.g. `setBranchSessionDialog((current) => current?.sourceSessionId === confirmedSourceSessionId ? undefined : current)`, and reset busy only while the same-owned dialog is current. An App.test.tsx case — open A's dialog, hold branchSession pending, confirm, switch to B, open B's dialog, resolve A's promise, assert B's isolation radios still render — must go red when the guard is removed.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R2-1：已在当前 head（ef450b68）复查：仍然存在。`confirmBranchSession` 的完成回调无条件写入对话框状态，会话 A 已完成的分支请求会关掉会话 B 刚打开的隔离对话框，并重置其防重复提交的 busy 守卫。切换会话时没有任何机制取消源会话的挂起回调——~8557 的关闭 effect 只清状态，进行中的 promise 仍会 settle 并再次写入；`pendingBranchRequestsRef` 只对请求去重，不管这些写入。具体场景：用户在会话 A 确认 'New worktree'（请求需数秒），切到会话 B 并打开 B 的隔离对话框；A 的请求最终 settle 时，这个无守卫的 `finally` 会在 B 选择过程中清掉 B 的对话框（B 从未发出分支请求，用户必须重开重选），即使 B 自己的请求已在进行中也会重置 `branchSessionDialogBusy`。第 3 轮探测：PR 侧 settle 过期请求后 session-2 的 radio 组消失；加上身份守卫后对话框存活（探测翻转）。请捕获被确认对话框的身份并对完成写入加守卫，仅当同属会话的对话框仍在时才重置 busy。需补充 App.test.tsx 用例；移除守卫应使其变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 10. Legacy marker writer 仍会跟随 symlink 并覆盖 owner

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278284
- 结论：值得修复
- 理由：writeWorktreeSessionMarker 仍是普通 fs.writeFile，会跟随 tracked symlink、截断外部目标并无条件覆盖 owner；多个生产调用点仍使用它，破坏本 PR 新增的 marker ownership 安全边界。
- 建议修复：移除或硬化该 writer：fresh 路径 exclusive/no-follow create，adoption 仅 expected-owner compare-and-replace；迁移全部调用点并补真实 symlink/owner 测试。
- 实施状态：已修复并验证
- 修复批次：F7
- 实施证据：legacy writer 复用 strict create/read 与 typed owner-change 错误，不再跟随 symlink 或覆盖已有 owner；symlink victim 内容不变与 owner CAS 测试通过。

原始评论：

标注位置：`packages/core/src/services/gitWorktreeService.ts:98-102`（RIGHT（新增侧））

```diff
@@ -83,6 +90,105 @@ export async function writeWorktreeSessionMarker(
   }
 }

+/** Writes the owning session id into the worktree's session marker. */
+export async function writeWorktreeSessionMarker(
+  worktreePath: string,
+  sessionId: string,
+): Promise<void> {
+  await fs.writeFile(
+    path.join(worktreePath, WORKTREE_SESSION_FILE),
+    sessionId,
+    'utf8',
+  );
```

> **[Critical]** R2-2: Re-checked at the current head (ef450b68): still stands. `writeWorktreeSessionMarker` — re-declared by this diff — remains a plain `fs.writeFile`: it follows symlinks, truncates, and never compares the owner, while four production call sites stay wired to it (tools/enter-worktree.ts:179, tools/agent/agent.ts:2871, agents/runtime/workflow-orchestrator.ts:1359, serve/routes/session.ts:3288); only worktreeStartup.ts migrated to the hardened create/replace APIs. Git tracks symlinks, and a branch can carry a tracked `.qwen-session` symlink — the exclude rule is best-effort (its own comment admits 'git add -A would just stage it', and `git add -f` bypasses exclude anyway), and a hostile repo can ship one.
>
> Any legacy path creating a worktree on such a branch materializes the symlink in the fresh checkout, and this writer then follows it and truncates + writes the session id into an arbitrary file outside the worktree (absolute symlink targets allowed); with a tracked regular-file marker, the same call silently clobbers the recorded owner — the exact integrity property the hardened `createWorktreeSessionMarker` and the new daemon/load-resume ownership gates now rely on.
>
> ```
> Round-3 probe at HEAD:
>   symlinkMaterialized=true
>   victimAfterLegacyWrite="session-x"      (was "VICTIM ORIGINAL CONTENT" — truncated)
>   hardened createWorktreeSessionMarker -> EEXIST before any write, victim unchanged
> ```
>
> Route the remaining call sites through the hardened primitives (`createWorktreeSessionMarker`, falling back to `replaceWorktreeSessionMarker` when a known owner is expected), or reimplement this writer on an O_NOFOLLOW open + fstat/lstat identity check. A git-worktree-marker.test.ts case planting a symlink at `.qwen-session`, calling `writeWorktreeSessionMarker`, and asserting the target file is unchanged must go red when the writer reverts to `fs.writeFile`.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R2-2：已在当前 head（ef450b68）复查：仍然存在。`writeWorktreeSessionMarker` 由本 diff 重新声明，但仍是普通 `fs.writeFile`：跟随符号链接、截断、从不比对 owner，而四个生产调用点仍在使用它（tools/enter-worktree.ts:179、tools/agent/agent.ts:2871、agents/runtime/workflow-orchestrator.ts:1359、serve/routes/session.ts:3288）；只有 worktreeStartup.ts 迁移到了加固的 create/replace API。git 会跟踪符号链接，分支可能携带被跟踪的 `.qwen-session` 符号链接——exclude 规则是尽力而为（其注释自认 'git add -A would just stage it'，且 `git add -f` 可绕过 exclude），恶意仓库也可以直接提供。任何旧路径在此类分支上创建 worktree 时，符号链接会在新 checkout 中实体化，该写入器随即跟随它并把会话 id 截断写入 worktree 之外的任意文件；若被跟踪的是普通文件标记，同样的调用会静默覆盖记录的 owner。第 3 轮探测：符号链接被实体化，旧写入器将受害文件截断为会话 id；加固的 `createWorktreeSessionMarker` 在写入前以 EEXIST 拒绝，受害文件完好。请将其余调用点改走加固原语，或将该写入器重写为 O_NOFOLLOW open + fstat/lstat 身份校验；补充植入符号链接的测试，把写入器还原为 `fs.writeFile` 应使测试变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 11. Recovery 未检查其他 live session 对 worktree 的占用

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278296
- 结论：值得修复
- 理由：recovery sweep 仍没有 bridge/live effective-cwd occupancy 输入，而 /session/:id/cd 可进入 managed worktree 且不重写 marker；clean/base-tip 条件满足时可删除另一个 live session 的 cwd。
- 建议修复：destructive recovery 前查询 runtime/bridge 全部 live effective cwd，发现目标树内占用即保留并告警；同时限制 /cd 进入 managed root 或要求 session-bound adoption。
- 实施状态：已修复并验证
- 修复批次：F5
- 实施证据：recovery 接收 live occupancy 查询，生产调用从所属 bridge 的 session snapshot 检查 effective cwd；占用或 snapshot 不可判定时保留资源。目标 session 缺失但另一 live cwd 位于 worktree 内的测试通过。

原始评论：

标注位置：`packages/cli/src/serve/branch-worktree-preparation.ts:498`（RIGHT（新增侧））

```diff
@@ -0,0 +1,726 @@
+/**
+ * @license
+ * Copyright 2026 Qwen Team
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import * as fs from 'node:fs/promises';
+import { constants as fsConstants } from 'node:fs';
+import * as os from 'node:os';
+import * as path from 'node:path';
+import * as crypto from 'node:crypto';
+import { execFile } from 'node:child_process';
+import { promisify } from 'node:util';
+import {
+  GitWorktreeService,
+  WORKTREE_SESSION_FILE,
+  clearWorktreeSessionDurable,
+  readWorktreeSession,
+  readWorktreeSessionMarker,
+  worktreeBranchForSlug,
+  type SessionService,
+} from '@qwen-code/qwen-code-core';
+import type { BridgeSessionExecutionSnapshot } from '@qwen-code/acp-bridge/bridgeTypes';
+import { getHeadCommit } from './server/git-branch-ops.js';
+
+const execFileAsync = promisify(execFile);
+
+export interface BranchWorktreeBaseCheckout {
+  repoTop: string;
+  checkoutCwd: string;
+  headCommit: string;
+  branch: string;
+}
+
+export type BranchWorktreePreparationPhase =
+  | 'planned'
+  | 'worktree-created'
+  | 'marker-created'
+  | 'sidecar-ready'
+  | 'mutation-dispatched'
+  | 'cleanup-intent'
+  | 'worktree-removed'
+  | 'branch-deleted'
+  | 'branch-preserved';
+
+export interface BranchWorktreePreparationJournal {
+  version: 1;
+  ownerToken: string;
+  pid: number;
+  hostname: string;
+  createdAt: string;
+  targetSessionId: string;
+  slug: string;
+  worktreePath: string;
+  worktreeBranch: string;
+  repoTop: string;
+  baseCommit: string;
+  sidecarPath: string;
+  markerCreated: boolean;
+  sidecarCreated: boolean;
+  phase: BranchWorktreePreparationPhase;
+}
+
+const PREPARATION_PHASES = new Set<BranchWorktreePreparationPhase>([
+  'planned',
+  'worktree-created',
+  'marker-created',
+  'sidecar-ready',
+  'mutation-dispatched',
+  'cleanup-intent',
+  'worktree-removed',
+  'branch-deleted',
+  'branch-preserved',
+]);
+
+async function fsyncDirectory(directory: string): Promise<void> {
+  try {
+    const handle = await fs.open(directory, 'r');
+    try {
+      await handle.sync();
+    } finally {
+      await handle.close();
+    }
+  } catch (error) {
+    if (process.platform !== 'win32') throw error;
+  }
+}
+
+async function pathExists(filePath: string): Promise<boolean> {
+  return await fs
+    .lstat(filePath)
+    .then(() => true)
+    .catch((error: NodeJS.ErrnoException) => {
+      if (error.code === 'ENOENT') return false;
+      throw error;
+    });
+}
+
+async function writeExclusiveFile(
+  filePath: string,
+  contents: string,
+): Promise<void> {
+  const handle = await fs.open(
+    filePath,
+    fsConstants.O_WRONLY |
+      fsConstants.O_CREAT |
+      fsConstants.O_EXCL |
+      (fsConstants.O_NOFOLLOW ?? 0),
+    0o600,
+  );
+  try {
+    const openedStat = await handle.stat();
+    if (!openedStat.isFile() || openedStat.nlink !== 1) {
+      throw new Error('Branch worktree journal must be a regular file');
+    }
+    await handle.writeFile(contents, 'utf8');
+    await handle.sync();
+    const finalStat = await fs.lstat(filePath);
+    if (
+      !finalStat.isFile() ||
+      finalStat.nlink !== 1 ||
+      finalStat.dev !== openedStat.dev ||
+      finalStat.ino !== openedStat.ino
+    ) {
+      throw new Error('Branch worktree journal path changed');
+    }
+  } finally {
+    await handle.close();
+  }
+}
+
+async function readStrictFile(filePath: string): Promise<string> {
+  const pathStat = await fs.lstat(filePath);
+  if (!pathStat.isFile() || pathStat.nlink !== 1) {
+    throw new Error('Branch worktree journal must be a regular file');
+  }
+  const handle = await fs.open(
+    filePath,
+    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
+  );
+  try {
+    const openedStat = await handle.stat();
+    if (
+      !openedStat.isFile() ||
+      openedStat.nlink !== 1 ||
+      openedStat.dev !== pathStat.dev ||
+      openedStat.ino !== pathStat.ino
+    ) {
+      throw new Error('Branch worktree journal path changed');
+    }
+    const contents = await handle.readFile('utf8');
+    const finalStat = await fs.lstat(filePath);
+    if (
+      !finalStat.isFile() ||
+      finalStat.nlink !== 1 ||
+      finalStat.dev !== openedStat.dev ||
+      finalStat.ino !== openedStat.ino
+    ) {
+      throw new Error('Branch worktree journal path changed');
+    }
+    return contents;
+  } finally {
+    await handle.close();
+  }
+}
+
+export function getBranchWorktreeJournalPath(
+  sidecarPath: string,
+  targetSessionId: string,
+): string {
+  return path.join(
+    path.dirname(sidecarPath),
+    `.branch-worktree-${targetSessionId}.json`,
+  );
+}
+
+export async function createBranchWorktreeJournal(args: {
+  journalPath: string;
+  targetSessionId: string;
+  slug: string;
+  worktreePath: string;
+  worktreeBranch: string;
+  repoTop: string;
+  baseCommit: string;
+  sidecarPath: string;
+}): Promise<BranchWorktreePreparationJournal> {
+  const journal: BranchWorktreePreparationJournal = {
+    version: 1,
+    ownerToken: crypto.randomUUID(),
+    pid: process.pid,
+    hostname: os.hostname(),
+    createdAt: new Date().toISOString(),
+    targetSessionId: args.targetSessionId,
+    slug: args.slug,
+    worktreePath: args.worktreePath,
+    worktreeBranch: args.worktreeBranch,
+    repoTop: args.repoTop,
+    baseCommit: args.baseCommit,
+    sidecarPath: args.sidecarPath,
+    markerCreated: false,
+    sidecarCreated: false,
+    phase: 'planned',
+  };
+  await fs.mkdir(path.dirname(args.journalPath), {
+    recursive: true,
+    mode: 0o700,
+  });
+  await writeExclusiveFile(args.journalPath, `${JSON.stringify(journal)}\n`);
+  await fsyncDirectory(path.dirname(args.journalPath));
+  return journal;
+}
+
+export async function updateBranchWorktreeJournal(
+  journalPath: string,
+  current: BranchWorktreePreparationJournal,
+  phase: BranchWorktreePreparationPhase,
+): Promise<BranchWorktreePreparationJournal> {
+  const onDisk = JSON.parse(
+    await readStrictFile(journalPath),
+  ) as BranchWorktreePreparationJournal;
+  if (
+    onDisk.version !== 1 ||
+    onDisk.ownerToken !== current.ownerToken ||
+    onDisk.pid !== current.pid ||
+    onDisk.hostname !== current.hostname ||
+    onDisk.createdAt !== current.createdAt ||
+    onDisk.targetSessionId !== current.targetSessionId ||
+    onDisk.slug !== current.slug ||
+    onDisk.worktreePath !== current.worktreePath ||
+    onDisk.worktreeBranch !== current.worktreeBranch ||
+    onDisk.repoTop !== current.repoTop ||
+    onDisk.baseCommit !== current.baseCommit ||
+    onDisk.sidecarPath !== current.sidecarPath ||
+    onDisk.markerCreated !== current.markerCreated ||
+    onDisk.sidecarCreated !== current.sidecarCreated ||
+    onDisk.phase !== current.phase
+  ) {
+    throw new Error('Branch worktree journal ownership changed');
+  }
+  const next = {
+    ...current,
+    phase,
+    markerCreated:
+      current.markerCreated ||
+      phase === 'marker-created' ||
+      phase === 'sidecar-ready' ||
+      phase === 'mutation-dispatched',
+    sidecarCreated:
+      current.sidecarCreated ||
+      phase === 'sidecar-ready' ||
+      phase === 'mutation-dispatched',
+  };
+  const tempPath = `${journalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
+  await writeExclusiveFile(tempPath, `${JSON.stringify(next)}\n`);
+  try {
+    await fs.rename(tempPath, journalPath);
+    await fsyncDirectory(path.dirname(journalPath));
+  } catch (error) {
+    await fs.unlink(tempPath).catch(() => {});
+    throw error;
+  }
+  return next;
+}
+
+export async function clearBranchWorktreeJournalDurable(
+  journalPath: string,
+): Promise<void> {
+  await fs.unlink(journalPath).catch((error: NodeJS.ErrnoException) => {
+    if (error.code !== 'ENOENT') throw error;
+  });
+  await fsyncDirectory(path.dirname(journalPath)).catch(
+    (error: NodeJS.ErrnoException) => {
+      if (error.code !== 'ENOENT') throw error;
+    },
+  );
+}
+
+async function clearTerminalMetadata(
+  journalPath: string,
+  journal: BranchWorktreePreparationJournal,
+  warn?: (message: string, fields?: Record<string, unknown>) => void,
+): Promise<void> {
+  if (journal.sidecarCreated) {
+    await clearWorktreeSessionDurable(journal.sidecarPath);
+  } else if (await pathExists(journal.sidecarPath)) {
+    warn?.('branch worktree recovery sidecar ownership is unknown', {
+      targetSessionId: journal.targetSessionId,
+    });
+    return;
+  }
+  await clearBranchWorktreeJournalDurable(journalPath);
+}
+
+const recoveryByChatsDir = new Map<string, Promise<void>>();
+const RECOVERY_REQUEST_AGE_MS = 2 * 60_000;
+
+function ownerProcessIsAlive(journal: BranchWorktreePreparationJournal) {
+  if (journal.hostname !== os.hostname()) return true;
+  try {
+    process.kill(journal.pid, 0);
+    return true;
+  } catch (error) {
+    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
+  }
+}
+
+function isPreparationJournal(
+  value: unknown,
+): value is BranchWorktreePreparationJournal {
+  if (typeof value !== 'object' || value === null) return false;
+  const record = value as Record<string, unknown>;
+  return (
+    record['version'] === 1 &&
+    typeof record['ownerToken'] === 'string' &&
+    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
+      record['ownerToken'],
+    ) &&
+    typeof record['pid'] === 'number' &&
+    Number.isInteger(record['pid']) &&
+    record['pid'] > 0 &&
+    typeof record['hostname'] === 'string' &&
+    typeof record['createdAt'] === 'string' &&
+    typeof record['targetSessionId'] === 'string' &&
+    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
+      record['targetSessionId'],
+    ) &&
+    typeof record['slug'] === 'string' &&
+    GitWorktreeService.validateUserWorktreeSlug(record['slug']) === null &&
+    typeof record['worktreePath'] === 'string' &&
+    path.isAbsolute(record['worktreePath']) &&
+    typeof record['worktreeBranch'] === 'string' &&
+    typeof record['repoTop'] === 'string' &&
+    path.isAbsolute(record['repoTop']) &&
+    typeof record['baseCommit'] === 'string' &&
+    /^[0-9a-f]{40,64}$/i.test(record['baseCommit']) &&
+    typeof record['sidecarPath'] === 'string' &&
+    path.isAbsolute(record['sidecarPath']) &&
+    typeof record['markerCreated'] === 'boolean' &&
+    typeof record['sidecarCreated'] === 'boolean' &&
+    typeof record['phase'] === 'string' &&
+    PREPARATION_PHASES.has(record['phase'] as BranchWorktreePreparationPhase)
+  );
+}
+
+export function recoverBranchWorktreePreparations(args: {
+  workspaceCwd: string;
+  sessionService: SessionService;
+  assertGenerationOpen?: () => void;
+  warn?: (message: string, fields?: Record<string, unknown>) => void;
+}): Promise<void> {
+  const probeSidecar = args.sessionService.getWorktreeSessionPath(
+    '00000000-0000-4000-8000-000000000000',
+  );
+  const chatsDir = path.dirname(probeSidecar);
+  const current = recoveryByChatsDir.get(chatsDir);
+  if (current) return current;
+  const recovery = (async () => {
+    const entries = await fs.readdir(chatsDir).catch(() => []);
+    if (!entries.some((name) => name.startsWith('.branch-worktree-'))) return;
+    const workspaceCwd = await fs.realpath(args.workspaceCwd).catch(() => null);
+    const discoveredRepoTop = workspaceCwd
+      ? await new GitWorktreeService(workspaceCwd)
+          .getRepoTopLevel()
+          .catch(() => null)
+      : null;
+    const runtimeRepoTop = discoveredRepoTop
+      ? await fs.realpath(discoveredRepoTop).catch(() => null)
+      : null;
+    if (runtimeRepoTop === null) {
+      args.warn?.('branch worktree recovery workspace is unavailable', {
+        workspace: args.workspaceCwd,
+      });
+      return;
+    }
+    for (const name of entries) {
+      if (!/^\.branch-worktree-[0-9a-f-]{36}\.json$/i.test(name)) continue;
+      args.assertGenerationOpen?.();
+      const journalPath = path.join(chatsDir, name);
+      let journal: BranchWorktreePreparationJournal;
+      try {
+        const parsed: unknown = JSON.parse(await readStrictFile(journalPath));
+        if (!isPreparationJournal(parsed)) throw new Error('invalid shape');
+        journal = parsed;
+      } catch (error) {
+        args.warn?.('invalid branch worktree recovery journal preserved', {
+          journalPath,
+          error: error instanceof Error ? error.message : String(error),
+        });
+        continue;
+      }
+      const expectedJournalPath = getBranchWorktreeJournalPath(
+        journal.sidecarPath,
+        journal.targetSessionId,
+      );
+      const worktreeService = new GitWorktreeService(runtimeRepoTop);
+      const journalRepoTop = await fs
+        .realpath(journal.repoTop)
+        .catch(() => null);
+      if (
+        expectedJournalPath !== journalPath ||
+        journal.sidecarPath !==
+          args.sessionService.getWorktreeSessionPath(journal.targetSessionId) ||
+        journalRepoTop !== runtimeRepoTop ||
+        path.resolve(journal.repoTop, '.qwen', 'worktrees', journal.slug) !==
+          path.resolve(journal.worktreePath) ||
+        journal.worktreeBranch !== worktreeBranchForSlug(journal.slug)
+      ) {
+        args.warn?.('branch worktree recovery journal identity mismatch', {
+          targetSessionId: journal.targetSessionId,
+        });
+        continue;
+      }
+      if (
+        await args.sessionService.sessionExistsInAnyState(
+          journal.targetSessionId,
+        )
+      ) {
+        await clearBranchWorktreeJournalDurable(journalPath);
+        continue;
+      }
+      if (!journal.sidecarCreated && (await pathExists(journal.sidecarPath))) {
+        args.warn?.('branch worktree recovery sidecar ownership is unknown', {
+          targetSessionId: journal.targetSessionId,
+        });
+        continue;
+      }
+      if (
+        journal.phase === 'branch-deleted' ||
+        journal.phase === 'branch-preserved'
+      ) {
+        await clearTerminalMetadata(journalPath, journal, args.warn);
+        continue;
+      }
+      if (journal.phase === 'mutation-dispatched') {
+        args.warn?.('branch worktree outcome remains unknown; resources kept', {
+          targetSessionId: journal.targetSessionId,
+        });
+        continue;
+      }
+      const createdAt = Date.parse(journal.createdAt);
+      if (
+        !Number.isFinite(createdAt) ||
+        Date.now() - createdAt < RECOVERY_REQUEST_AGE_MS ||
+        ownerProcessIsAlive(journal)
+      ) {
+        continue;
+      }
+      if (journal.phase === 'planned') {
+        if (!(await pathExists(journal.worktreePath))) {
+          await clearBranchWorktreeJournalDurable(journalPath);
+        } else {
+          args.warn?.('planned branch worktree residue preserved', {
+            targetSessionId: journal.targetSessionId,
+          });
+        }
+        continue;
+      }
+      if (journal.phase === 'worktree-removed') {
+        args.assertGenerationOpen?.();
+        const finalized =
+          await worktreeService.finalizePreparedUserWorktreeBranch(
+            journal.slug,
+            journal.baseCommit,
+          );
+        if (!finalized.success) {
+          args.warn?.('branch worktree recovery could not finalize branch', {
+            targetSessionId: journal.targetSessionId,
+            error: finalized.error,
+          });
+          continue;
+        }
+        journal = await updateBranchWorktreeJournal(
+          journalPath,
+          journal,
+          finalized.branchPreserved ? 'branch-preserved' : 'branch-deleted',
+        );
+        if (finalized.branchPreserved) {
+          args.warn?.('branch worktree recovery preserved branch', {
+            targetSessionId: journal.targetSessionId,
+            branch: journal.worktreeBranch,
+          });
+        }
+        await clearTerminalMetadata(journalPath, journal, args.warn);
+        continue;
+      }
+      if (journal.phase !== 'cleanup-intent') {
+        journal = await updateBranchWorktreeJournal(
+          journalPath,
+          journal,
+          'cleanup-intent',
+        );
+      }
+      if (await pathExists(journal.worktreePath)) {
+        const markerOwner = await readWorktreeSessionMarker(
+          journal.worktreePath,
+        );
+        if (
+          (journal.markerCreated && markerOwner !== journal.targetSessionId) ||
```

> **[Critical]** R2-3: Re-checked at the current head (ef450b68): still stands. The recovery sweep's only occupancy signal for a managed worktree is the journal's marker, so a different live session occupying the worktree through a path that never re-stamps the marker is structurally invisible to it — and `removePreparedUserWorktree` can delete that session's working directory. `POST /session/:id/cd` (routes/session.ts:4646-4676) forwards `changeSessionCwd` with no `allowedRoots`, and the agent-side `sessionCd` handler runs its containment check only when `containmentRoots` is a non-empty array — skipped here — with folder trust disabled by default, so a live session can relocate its cwd into `<repoTop>/.qwen/worktrees/<slug>` without any marker write. The sweep has no bridge or live-session input at all: it checks journal identity, marker owner vs `journal.targetSessionId`, `sessionExistsInAnyState(targetSessionId)`, cleanliness and branch tip — an occupying session Y ≠ X is invisible.
>
> Sequence: a branch for target X fails with the daemon dying mid-cleanup, leaving a non-terminal journal; restart within 2 minutes skips it via the age gate; session Y cds into the worktree; at the next sweep X is gone, the marker reads X (or is absent), the idle occupant leaves the tree clean and the tip at baseCommit — every gate argued in design doc §8.5 passes, and `git worktree remove` deletes session Y's live cwd plus the branch, marker and sidecar, with only a daemon-log warn.
>
> Witness: partially run — the deletion half was verified: the PR's own 'removes a stale prepared worktree whose identity is unchanged' test passes 12/12 under exactly these marker-only preconditions; the full chain needs a daemon crash/restart cycle plus a cross-session cd across two daemon generations, beyond unit reach. Every gate/entry fact above is quoted from code at the reviewed commit.
>
> Before the destructive branch, ask the runtime/bridge whether any session's effective cwd is inside `journal.worktreePath` and preserve with a warn if so; defense-in-depth: have `/session/:id/cd` re-stamp the marker when entering a managed worktree. Do not simply tighten the marker conjuncts — the absent-marker case is also the legitimate crashed-before-marker-creation case where removal is intended, so the sweep needs an independent occupancy signal. A recovery test where the journal passes the identity gate and its target session is gone, but a live session's cwd is inside `journal.worktreePath`, must assert the worktree and journal are preserved; deleting the occupancy check makes it red.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R2-3：已在当前 head（ef450b68）复查：仍然存在。恢复扫描对 managed worktree 的唯一占用信号是日志的标记，因此通过不重写标记的路径占用该 worktree 的另一个活跃会话在结构上不可见——`removePreparedUserWorktree` 可能删除该会话的工作目录。`POST /session/:id/cd`（routes/session.ts:4646-4676）转发 `changeSessionCwd` 时不带 `allowedRoots`，agent 侧 `sessionCd` 仅在 `containmentRoots` 非空时做包含检查——此处被跳过——且文件夹信任默认关闭，活跃会话可以把 cwd 迁入 `<repoTop>/.qwen/worktrees/<slug>` 而不写任何标记。扫描完全没有 bridge/活跃会话输入。时序：目标 X 的分支在 daemon 清理中途崩溃，留下非终态日志；2 分钟内重启被年龄门跳过；会话 Y cd 进入该 worktree；下次扫描时 X 已不存在、标记仍为 X（或缺失）、空闲占用者使树保持干净且 tip 等于 baseCommit——设计文档 §8.5 论证的所有门全部通过，`git worktree remove` 删除会话 Y 正在使用的 cwd 以及分支/标记/sidecar，只留一条 daemon 日志警告。证据：删除的一半已验证（本 PR 自己的 'removes a stale prepared worktree whose identity is unchanged' 测试恰在这些仅凭标记的前提下通过，12/12）；完整链条超出单测范围。请在破坏性分支前向 runtime/bridge 查询是否有会话的 effective cwd 位于 `journal.worktreePath` 内，如有则告警并保留；纵深防御：让 `/session/:id/cd` 进入 managed worktree 时重写标记。不要只收紧标记条件——标记缺失也是合法的 '创建标记前崩溃' 场景，扫描需要独立的占用信号。需补充恢复测试；删除占用检查应使其变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 12. Resolver 将内部文件系统故障静默降级为 400

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278301
- 结论：值得修复
- 理由：resolver 的验证段仍由空 catch 包围，corrupt JSON、EIO、权限和竞态全部变成 null/400 且无日志；明确的 ownership 拒绝与内部错误没有区分。
- 建议修复：返回结构化结果或 typed internal error；只有明确拒绝映射 400，意外 I/O/parse 故障记录结构化日志并映射 500，补 EIO/corrupt JSON 测试。
- 实施状态：已修复并验证
- 修复批次：F2
- 实施证据：expected ENOENT/EACCES/EPERM/ELOOP/ENOTDIR 继续 fail-closed 为 null；损坏 JSON 等意外错误向 route wrapper 传播并进入 500/logging 通道。malformed sidecar 测试确认未调用 400 status。

原始评论：

标注位置：`packages/cli/src/serve/workspace-route-runtime.ts:547`（RIGHT（新增侧））

```diff
@@ -401,3 +404,147 @@ export function resolveContainedCwdOrFail(
   }
   return null;
 }
+
+function pathIsWithin(candidate: string, root: string): boolean {
+  const relative = path.relative(root, candidate);
+  return (
+    relative === '' ||
+    (!relative.startsWith('..') && !path.isAbsolute(relative))
+  );
+}
+
+function resolveGitCommonDir(cwd: string): string | null {
+  try {
+    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
+      cwd,
+      encoding: 'utf8',
+      timeout: 30_000,
+    }).trim();
+    return fs.realpathSync(path.resolve(cwd, raw));
+  } catch {
+    return null;
+  }
+}
+
+function markerIsOwnedBy(markerPath: string, sessionId: string): boolean {
+  let fd: number | undefined;
+  try {
+    const pathStat = fs.lstatSync(markerPath);
+    if (!pathStat.isFile() || pathStat.nlink !== 1) return false;
+    fd = fs.openSync(
+      markerPath,
+      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
+    );
+    const openedStat = fs.fstatSync(fd);
+    if (
+      !openedStat.isFile() ||
+      openedStat.nlink !== 1 ||
+      openedStat.dev !== pathStat.dev ||
+      openedStat.ino !== pathStat.ino
+    ) {
+      return false;
+    }
+    const owner = fs.readFileSync(fd, 'utf8').trim();
+    const finalStat = fs.lstatSync(markerPath);
+    return (
+      finalStat.isFile() &&
+      finalStat.nlink === 1 &&
+      finalStat.dev === openedStat.dev &&
+      finalStat.ino === openedStat.ino &&
+      owner === sessionId
+    );
+  } catch {
+    return false;
+  } finally {
+    if (fd !== undefined) fs.closeSync(fd);
+  }
+}
+
+export function resolveSessionManagedGitCwd(
+  req: Request,
+  runtime: WorkspaceRuntime,
+): string | null {
+  const rawCwd = req.query['cwd'];
+  if (rawCwd === undefined) return runtime.workspaceCwd;
+  if (typeof rawCwd !== 'string' || rawCwd.length === 0) return null;
+
+  let requested: string;
+  let workspace: string;
+  try {
+    requested = fs.realpathSync(path.resolve(rawCwd));
+    workspace = fs.realpathSync(runtime.workspaceCwd);
+  } catch {
+    return null;
+  }
+
+  let repoTop: string | undefined;
+  try {
+    repoTop = fs.realpathSync(
+      execFileSync('git', ['rev-parse', '--show-toplevel'], {
+        cwd: workspace,
+        encoding: 'utf8',
+        timeout: 30_000,
+      }).trim(),
+    );
+  } catch {
+    return pathIsWithin(requested, workspace) ? requested : null;
+  }
+  const managedRoot = path.join(repoTop, '.qwen', 'worktrees');
+  if (
+    pathIsWithin(requested, workspace) &&
+    !pathIsWithin(requested, managedRoot)
+  ) {
+    return requested;
+  }
+  if (!pathIsWithin(requested, managedRoot)) return null;
+  const workspaceCommonDir = resolveGitCommonDir(workspace);
+  const requestedCommonDir = resolveGitCommonDir(requested);
+  if (
+    workspaceCommonDir === null ||
+    requestedCommonDir === null ||
+    requestedCommonDir !== workspaceCommonDir
+  ) {
+    return null;
+  }
+
+  const parsedSessionId = parseCallerSuppliedSessionId(req.query['sessionId']);
+  if (parsedSessionId.kind !== 'valid') return null;
+  const sessionId = parsedSessionId.sessionId;
+  try {
+    const snapshot = runtime.bridge.getSessionExecutionSnapshot(sessionId);
+    if (
+      fs.realpathSync(snapshot.workspaceCwd) !== workspace ||
+      !snapshot.worktree
+    ) {
+      return null;
+    }
+    const worktreeRoot = fs.realpathSync(snapshot.worktree.path);
+    if (
+      path.dirname(worktreeRoot) !== managedRoot ||
+      !pathIsWithin(requested, worktreeRoot)
+    ) {
+      return null;
+    }
+    const sidecarPath =
+      createWorkspaceRuntimeSessionService(runtime).getWorktreeSessionPath(
+        sessionId,
+      );
+    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<
+      string,
+      unknown
+    >;
+    if (
+      typeof sidecar['worktreePath'] !== 'string' ||
+      fs.realpathSync(sidecar['worktreePath']) !== worktreeRoot
+    ) {
+      return null;
+    }
+    const markerPath = path.join(worktreeRoot, '.qwen-session');
+    if (!markerIsOwnedBy(markerPath, sessionId)) {
+      return null;
+    }
+    return requested;
+  } catch {
```

> **[Critical]** R2-4: Re-checked at the current head (ef450b68): still stands. The entire verification block of `resolveSessionManagedGitCwd` is wrapped in a try/catch with an empty catch body: any filesystem error — corrupt sidecar JSON, a corrupted HEAD, ENOSPC or EACCES on transient paths — silently returns null, which the routes turn into `400 invalid_cwd` with no diagnostic and nothing logged. This was raised as Critical 2 in @doudouOUC's second-opinion review and re-verified at every head since. `resolveSessionManagedGitCwd` is a routing function: an unexpected filesystem failure is an internal error (500), not 'the supplied cwd is not owned by this session' (400); an operator chasing a 'worktree git routes refuse my cwd' report gets no breadcrumb. (The sibling `markerIsOwnedBy` predicate using the same pattern is excusable — it is a boolean.)
>
> Witness: not run — the defect is the literal empty catch body plus the routes' null→400 mapping, both quoted from code at HEAD; the file contains no daemonLog/console/warn call anywhere, and no behavioural discriminator exists beyond the code text (fail-closed, no security/data impact).
>
> Log the caught error (at least `daemonLog?.warn`) and return null only for expected ENOENT/EACCES/EPERM, letting other errors surface as internal errors. A workspace-route-runtime.test.ts case making the sidecar read throw EIO and asserting the error is logged (or propagated) rather than silently swallowed must go red when the logging is removed.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R2-4：已在当前 head（ef450b68）复查：仍然存在。`resolveSessionManagedGitCwd` 的整个校验块包在空 catch 的 try/catch 中：任何文件系统错误——损坏的 sidecar JSON、损坏的 HEAD、临时路径上的 ENOSPC 或 EACCES——都静默返回 null，路由将其转为 `400 invalid_cwd`，无诊断、无日志。该问题由 @doudouOUC 的第二意见评审作为 Critical 2 提出，并在之后每个 head 复查确认。`resolveSessionManagedGitCwd` 是路由函数：意外的文件系统失败属于内部错误（500），而不是 'cwd 不属于该会话'（400）；排查相关报告的运维人员没有任何线索。（同文件的 `markerIsOwnedBy` 谓词使用同样模式可以谅解——它是布尔判断。）证据：未运行——缺陷即空 catch 本体与路由的 null→400 映射，均引自 HEAD 代码；文件中没有任何日志调用。请记录捕获的错误（至少 `daemonLog?.warn`），仅对预期的 ENOENT/EACCES/EPERM 返回 null，其他错误作为内部错误上抛；补充测试，移除日志应使其变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 13. Cleanup 可删除未初始化 submodule 目录中的用户文件

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278309
- 结论：值得修复
- 理由：cleanliness gate 仍只依赖 status、git clean preview 与 Git remove；tracked gitlink 下未初始化 submodule 目录内容不会被可靠枚举，自动 cleanup 存在真实数据丢失风险。
- 建议修复：删除前枚举 index/HEAD gitlink 并 fail-closed 检查对应目录；任何内容或未知状态均保留 worktree，补未初始化 submodule 内文件的真实 Git 测试。
- 实施状态：已修复并验证
- 修复批次：F5
- 实施证据：cleanup 每次 clean gate 都枚举 index 中 mode 160000 gitlink，非空/非目录/越界路径均拒绝删除；真实未初始化 gitlink 内用户文件存活测试通过。

原始评论：

标注位置：`packages/core/src/services/gitWorktreeService.ts:2452-2455`（RIGHT（新增侧））

```diff
@@ -2224,6 +2357,191 @@ export class GitWorktreeService {
     return { success: true, branchPreserved: true };
   }

+  async removePreparedUserWorktree(
+    slug: string,
+    expectedOwner: string | null,
+    expectedBaseCommit: string,
+    onWorktreeRemoved?: () => Promise<void>,
+  ): Promise<{
+    success: boolean;
+    error?: string;
+    branchPreserved?: boolean;
+  }> {
+    const expectedPath = this.getUserWorktreePath(slug);
+    let worktreePath: string;
+    try {
+      worktreePath = await fs.realpath(expectedPath);
+      const initialPathStat = await fs.lstat(worktreePath);
+      const canonicalRepo = await fs.realpath(this.sourceRepoPath);
+      const canonicalExpectedPath = path.join(
+        canonicalRepo,
+        '.qwen',
+        WORKTREES_DIR,
+        slug,
+      );
+      if (
+        !initialPathStat.isDirectory() ||
+        worktreePath !== canonicalExpectedPath
+      ) {
+        return { success: false, error: 'Worktree path identity changed' };
+      }
+      const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
+      const markerMatches = async () => {
+        if (expectedOwner === null) {
+          return await fs
+            .lstat(markerPath)
+            .then(() => false)
+            .catch((error: NodeJS.ErrnoException) => {
+              if (error.code === 'ENOENT') return true;
+              throw error;
+            });
+        }
+        const markerStat = await fs.lstat(markerPath);
+        if (!markerStat.isFile() || markerStat.nlink !== 1) return false;
+        const owner = await readWorktreeSessionMarker(worktreePath);
+        return owner === expectedOwner;
+      };
+      if (!(await markerMatches())) {
+        return { success: false, error: 'Worktree marker owner changed' };
+      }
+      const { simpleGit } = await loadSimpleGit();
+      const worktreeGit = simpleGit(worktreePath);
+      const trackedMarker = await worktreeGit.raw([
+        'ls-files',
+        '-z',
+        '--',
+        WORKTREE_SESSION_FILE,
+      ]);
+      if (trackedMarker.length > 0) {
+        return { success: false, error: 'Worktree marker is tracked' };
+      }
+      const checkoutMatches = async () => {
+        const [head, branch] = await Promise.all([
+          worktreeGit.revparse(['HEAD']),
+          worktreeGit.revparse(['--abbrev-ref', 'HEAD']),
+        ]);
+        return (
+          head.trim() === expectedBaseCommit &&
+          branch.trim() === worktreeBranchForSlug(slug)
+        );
+      };
+      if (!(await checkoutMatches())) {
+        return { success: false, error: 'Worktree checkout changed' };
+      }
+      const isClean = async () => {
+        const status = await worktreeGit.status();
+        return (
+          status.isClean() &&
+          (
+            await worktreeGit.raw([
+              'clean',
+              '-ndx',
+              '-e',
+              `/${WORKTREE_SESSION_FILE}`,
+            ])
+          ).trim().length === 0
+        );
+      };
+      if (!(await isClean())) {
+        return { success: false, error: 'Worktree contains changes' };
+      }
+      let branchTip = await this.getPreparedUserWorktreeBranchTip(slug);
+      if (branchTip !== expectedBaseCommit) {
+        return { success: false, error: 'Worktree branch changed' };
+      }
+      if (!(await isClean())) {
+        return { success: false, error: 'Worktree contains changes' };
+      }
+      branchTip = await this.getPreparedUserWorktreeBranchTip(slug);
```

> **[Critical]** R3-3: Re-checked at the current head (ef450b68): still stands. `removePreparedUserWorktree`'s cleanliness gate — `status.isClean()` plus `git clean -ndx -e /.qwen-session` — is blind to files inside uninitialized submodule directories, so `git worktree remove` silently deletes them. Git never looks inside a tracked gitlink that has no initialized checkout, and Git's own backstop ('working trees containing submodules cannot be moved or removed') fires only for INITIALIZED submodules (verified: then status shows ` M sub` and remove exits 128), so the uninitialized case has no second line of defense. This method is reached both by the stale-journal recovery sweep at daemon startup and by the branch route's `cleanupPrepared`.
>
> Failure: in a repo with a committed submodule, `git worktree add` materializes the submodule path as an empty directory in the worktree even when the submodule is never initialized; agent or user files written there before `git submodule update --init` are invisible to both halves of the gate. With HEAD still at the expected base commit (no commits), all double-checked gates pass and `git worktree remove` succeeds (exit 0), irreversibly deleting those files during recovery or cleanup.
>
> ```
> Round-3 probe against the real method (git 2.43.0):
>   PRISTINE: removed = { success: true }, fileSurvived = false   (user file deleted)
>   FIXED (enumerate mode-160000 gitlinks, refuse non-empty dir):
>             removed = { success: false, error: 'Worktree contains changes' }, fileSurvived = true
> ```
>
> In `isClean`, additionally enumerate gitlink entries (`git ls-files -s -z`, mode `160000`) and, for each whose directory exists in the worktree without an initialized checkout, refuse removal unless the directory is empty. Add a case in git-worktree-marker.test.ts: seed a worktree from a repo with a committed submodule, leave it uninitialized, place a file inside, assert `removePreparedUserWorktree` returns `success: false` and the file survives; with the guard removed the call succeeds and the file is deleted.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R3-3：已在当前 head（ef450b68）复查：仍然存在。`removePreparedUserWorktree` 的清洁度门——`status.isClean()` 加 `git clean -ndx -e /.qwen-session`——对未初始化子模块目录内的文件不可见，因此 `git worktree remove` 会静默删除它们。git 从不查看没有初始化 checkout 的已跟踪 gitlink 内部，而 git 自身的兜底只对已初始化的子模块生效（已验证：此时 status 显示 ` M sub`、remove 退出码 128），未初始化的情形没有第二道防线。该方法同时被启动时的陈旧日志恢复扫描与分支路由的 `cleanupPrepared` 调用。故障场景：在含已提交子模块的仓库中，`git worktree add` 即使子模块从未初始化也会实体化一个空目录；在 `git submodule update --init` 之前写入其中的文件对门的两半都不可见；当 HEAD 仍等于期望的 base commit 时，所有双重检查通过，`git worktree remove` 成功（exit 0），不可逆地删除这些文件。第 3 轮探测（git 2.43.0）：原始实现 `removed = {success: true}, fileSurvived = false`；枚举 160000 gitlink 并拒绝非空目录后 `removed = {success: false, 'Worktree contains changes'}, fileSurvived = true`。请在 `isClean` 中枚举 gitlink 条目并拒绝非空目录；补充上述测试，移除守卫后调用将成功且文件被删除。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 14. 篡改 worktree .git 指针可跨 session 操作另一个 checkout

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278315
- 结论：值得修复
- 理由：resolver 仍只比较 shared common dir，不校验 requested 的 absolute git dir 与 owning worktree metadata/back-pointer。A 的 .git 改指 B 后，A 的 sidecar/marker/containment 仍通过，Git 命令会操作 B 的 index/HEAD。
- 建议修复：用 Git worktree registry/--absolute-git-dir 推导 authoritative metadata dir，并验证 gitdir back-pointer 回指 owning worktree；补双 worktree 指针改写测试。
- 实施状态：已修复并验证
- 修复批次：F3
- 实施证据：resolver 现在校验 requested absolute git dir 必须位于 authoritative common-dir/worktrees，且 metadata `gitdir` 必须回指 owning worktree `.git`；双真实 worktree 指针改写测试返回 null。

原始评论：

标注位置：`packages/cli/src/serve/workspace-route-runtime.ts:543`（RIGHT（新增侧））

```diff
@@ -401,3 +404,147 @@ export function resolveContainedCwdOrFail(
   }
   return null;
 }
+
+function pathIsWithin(candidate: string, root: string): boolean {
+  const relative = path.relative(root, candidate);
+  return (
+    relative === '' ||
+    (!relative.startsWith('..') && !path.isAbsolute(relative))
+  );
+}
+
+function resolveGitCommonDir(cwd: string): string | null {
+  try {
+    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
+      cwd,
+      encoding: 'utf8',
+      timeout: 30_000,
+    }).trim();
+    return fs.realpathSync(path.resolve(cwd, raw));
+  } catch {
+    return null;
+  }
+}
+
+function markerIsOwnedBy(markerPath: string, sessionId: string): boolean {
+  let fd: number | undefined;
+  try {
+    const pathStat = fs.lstatSync(markerPath);
+    if (!pathStat.isFile() || pathStat.nlink !== 1) return false;
+    fd = fs.openSync(
+      markerPath,
+      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
+    );
+    const openedStat = fs.fstatSync(fd);
+    if (
+      !openedStat.isFile() ||
+      openedStat.nlink !== 1 ||
+      openedStat.dev !== pathStat.dev ||
+      openedStat.ino !== pathStat.ino
+    ) {
+      return false;
+    }
+    const owner = fs.readFileSync(fd, 'utf8').trim();
+    const finalStat = fs.lstatSync(markerPath);
+    return (
+      finalStat.isFile() &&
+      finalStat.nlink === 1 &&
+      finalStat.dev === openedStat.dev &&
+      finalStat.ino === openedStat.ino &&
+      owner === sessionId
+    );
+  } catch {
+    return false;
+  } finally {
+    if (fd !== undefined) fs.closeSync(fd);
+  }
+}
+
+export function resolveSessionManagedGitCwd(
+  req: Request,
+  runtime: WorkspaceRuntime,
+): string | null {
+  const rawCwd = req.query['cwd'];
+  if (rawCwd === undefined) return runtime.workspaceCwd;
+  if (typeof rawCwd !== 'string' || rawCwd.length === 0) return null;
+
+  let requested: string;
+  let workspace: string;
+  try {
+    requested = fs.realpathSync(path.resolve(rawCwd));
+    workspace = fs.realpathSync(runtime.workspaceCwd);
+  } catch {
+    return null;
+  }
+
+  let repoTop: string | undefined;
+  try {
+    repoTop = fs.realpathSync(
+      execFileSync('git', ['rev-parse', '--show-toplevel'], {
+        cwd: workspace,
+        encoding: 'utf8',
+        timeout: 30_000,
+      }).trim(),
+    );
+  } catch {
+    return pathIsWithin(requested, workspace) ? requested : null;
+  }
+  const managedRoot = path.join(repoTop, '.qwen', 'worktrees');
+  if (
+    pathIsWithin(requested, workspace) &&
+    !pathIsWithin(requested, managedRoot)
+  ) {
+    return requested;
+  }
+  if (!pathIsWithin(requested, managedRoot)) return null;
+  const workspaceCommonDir = resolveGitCommonDir(workspace);
+  const requestedCommonDir = resolveGitCommonDir(requested);
+  if (
+    workspaceCommonDir === null ||
+    requestedCommonDir === null ||
+    requestedCommonDir !== workspaceCommonDir
+  ) {
+    return null;
+  }
+
+  const parsedSessionId = parseCallerSuppliedSessionId(req.query['sessionId']);
+  if (parsedSessionId.kind !== 'valid') return null;
+  const sessionId = parsedSessionId.sessionId;
+  try {
+    const snapshot = runtime.bridge.getSessionExecutionSnapshot(sessionId);
+    if (
+      fs.realpathSync(snapshot.workspaceCwd) !== workspace ||
+      !snapshot.worktree
+    ) {
+      return null;
+    }
+    const worktreeRoot = fs.realpathSync(snapshot.worktree.path);
+    if (
+      path.dirname(worktreeRoot) !== managedRoot ||
+      !pathIsWithin(requested, worktreeRoot)
+    ) {
+      return null;
+    }
+    const sidecarPath =
+      createWorkspaceRuntimeSessionService(runtime).getWorktreeSessionPath(
+        sessionId,
+      );
+    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<
+      string,
+      unknown
+    >;
+    if (
+      typeof sidecar['worktreePath'] !== 'string' ||
+      fs.realpathSync(sidecar['worktreePath']) !== worktreeRoot
+    ) {
+      return null;
+    }
+    const markerPath = path.join(worktreeRoot, '.qwen-session');
+    if (!markerIsOwnedBy(markerPath, sessionId)) {
```

> **[Critical]** R3-6: Re-checked at the current head (ef450b68): still stands. `resolveSessionManagedGitCwd` binds the requested cwd to the owning session only by path containment, sidecar, and marker — never by git linkage: it never checks that `requested`'s resolved git dir is the worktree's own metadata dir (`<repo>/.git/worktrees/<slug>` with a `gitdir` back-pointer to `<worktreeRoot>/.git`). A worktree's `.git` is a plain file inside the owning session's working directory — writable by that session's own tools even under sandboxing — so session A can overwrite it with `gitdir: <repo>/.git/worktrees/branch-b`. Every check in this function then passes truthfully: containment in the snapshot worktree root holds, `resolveGitCommonDir(requested)` follows the rewritten pointer to the shared `<repo>/.git` so the common-dir equality below still holds, and the sidecar and marker checks read A's own untouched files. The handlers then run git with cwd inside A's worktree, and git resolves through the pointer — mutating session B's HEAD, index, and files. No race is needed: check side and use side read the same rewritten pointer. This bypasses exactly the cross-session containment this function was added to enforce.
>
> ```
> Round-3 probe at HEAD (two real worktrees A=branch-a, B=branch-b):
>   baseline:                     resolveSessionManagedGitCwd(cwd=A, sessionId=A) -> …/worktrees/branch-a
>   AFTER rewriting <A>/.git to 'gitdir: <repo>/.git/worktrees/branch-b':
>                                 resolver STILL returns …/worktrees/branch-a (authorized)
>   git commit --allow-empty from cwd=A -> B's log: 'attacker-commit' on top of B's tip
>                                 (A's own HEAD never moved)
>   WITH the linkage check below: post-rewrite request -> null; baseline still authorizes (probe flips)
> ```
>
> After the marker check, pin the linkage: resolve `requested`'s git dir (e.g. `git -C <requested> rev-parse --absolute-git-dir`, realpathed) and require it to equal `path.join(workspaceCommonDir, 'worktrees', path.basename(worktreeRoot))`, and additionally read that dir's `gitdir` back-pointer file requiring it to equal `path.join(worktreeRoot, '.git')`; return null otherwise. Add a case in workspace-route-runtime.test.ts: after the existing owned-worktree setup, create a second worktree `branch-b` with its metadata dir, overwrite `branch-a/.git` with the `branch-b` pointer, and assert `resolveSessionManagedGitCwd` returns null — red on the PR tree (returns the worktree path), green with the linkage check.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R3-6：已在当前 head（ef450b68）复查：仍然存在。`resolveSessionManagedGitCwd` 仅通过路径包含、sidecar 与标记把请求的 cwd 绑定到属主会话——从不校验 git 链接关系：它不检查 `requested` 解析出的 git dir 是否为该 worktree 自身的元数据目录（`<repo>/.git/worktrees/<slug>`，且其 `gitdir` 回指文件应等于 `<worktreeRoot>/.git`）。worktree 的 `.git` 是属主会话工作目录内的普通文件——即使在沙箱下也可被该会话自己的工具写入——因此会话 A 可以把它改写为 `gitdir: <repo>/.git/worktrees/branch-b`。此后本函数的所有检查都如实通过；各路由处理器以 A 的 worktree 为 cwd 运行 git，git 沿指针解析——改动会话 B 的 HEAD、index 与文件。无需竞态：检查侧与使用侧读到的是同一个被改写的指针。这绕过的正是本函数被加入以强制执行的跨会话隔离。第 3 轮探测（两个真实 worktree）：改写 `<A>/.git` 指向 branch-b 后，解析器仍授权 A；从 cwd=A 发起的 commit 落在 B 的分支上（A 的 HEAD 未动）；加上链接校验后同一请求返回 null、合法基线仍被授权（探测翻转）。请在标记检查之后钉住链接关系；补充测试：在 PR 树上为红，加上校验后变绿。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 15. Unknown owner 是否允许 startup adoption

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3878278321
- 结论：值得修复
- 理由：评论给出的三态拆分能够同时保持删除路径 fail-closed，并恢复 startup re-attach 对无证据/异主机 owner 的既有可用性；无需改变共享删除授权策略，范围可控且有明确反例。
- 建议修复：新增 `active | inactive | unknown` liveness 查询；startup 只拒绝 confirmed active，对 unknown 告警后 CAS adoption；既有 `isSessionRuntimeActive` 继续把 unknown 当 active，供删除路径保守使用。
- 实施状态：已修复并验证
- 修复批次：F4
- 实施证据：新增三态 helper；exit-worktree/AppContainer 仍使用保守 boolean helper。missing evidence、foreign hostname、confirmed dead、confirmed active 与 repo-contained 非权威 dead evidence 测试全部通过。

原始评论：

标注位置：`packages/cli/src/startup/worktreeStartup.ts:407`（RIGHT（新增侧））

```diff
@@ -393,14 +395,14 @@ export async function persistStartupWorktreeSidecar(
     overriddenSlug = previous.slug;
   }

-  // Best-effort marker write. On re-attach, adopt only when the previous
-  // owner is not a live runtime anymore; otherwise keep the old marker so
-  // two active sessions cannot both remove the same worktree.
-  let shouldWriteMarker = !context.wasReattached;
-  if (context.wasReattached) {
+  if (!context.wasReattached) {
+    await createWorktreeSessionMarker(context.worktreePath, sessionId);
+  } else {
     const owner = await readWorktreeSessionMarker(context.worktreePath);
-    if (owner === null || owner === sessionId) {
-      shouldWriteMarker = true;
+    if (owner === null) {
+      await createWorktreeSessionMarker(context.worktreePath, sessionId);
+    } else if (owner === sessionId) {
+      await ensureWorktreeSessionMarkerExcluded(context.worktreePath);
     } else {
       const ownerActive = await isSessionRuntimeActive(owner, [
```

> **[Critical]** R3-18: Re-checked at the current head (ef450b68): still stands. The new adoption throw fires on false-positive 'active' verdicts — `isSessionRuntimeActive` returns true when the owner left NO runtime-status evidence (`return !sawDeadRuntimeStatus` in worktreeSessionService.ts), when its status file was written under a different hostname ('active' without a pid probe), or when the probe itself errors (this call's pre-existing `.catch(() => true)`). The diff escalates that verdict from the pre-PR benign outcome (keep old marker, still write the sidecar — binding functional, protection retained) to a throw that gemini.tsx:966-971 swallows into a debugLogger.warn, so re-attach to a genuinely dead owner permanently loses the durable binding: no sidecar, no marker adoption, every subsequent `qwen --worktree <slug>` startup repeats the abort, and `--resume` never restores the worktree context again — until hand-deleting `.qwen-session` or using a fresh slug. Pre-PR the identical states still wrote the sidecar. Distinct from R1-5 (the neutralized throw for a TRUE active owner): even a perfectly surfaced refusal would still wrongly lock these users out, because the verdict itself classifies a dead/unverifiable owner as active.
>
> ```
> Round-3 probe driving persistStartupWorktreeSidecar at HEAD:
>   A-no-evidence:      isSessionRuntimeActive=true  -> threw 'Worktree is owned by active session …', markerAfter=<old owner>, sidecarWritten=false
>   B-dead-owner:       isSessionRuntimeActive=false -> succeeded, markerAfter=<new session>, sidecarWritten=true   (flip pair)
>   C-foreign-hostname: isSessionRuntimeActive=true  -> threw despite a dead pid
> ```
>
> Distinguish 'affirmatively alive' from 'unverifiable': expose a tri-state from the runtime-status check (or a sibling helper) and throw only for an affirmative live owner (status present, hostname matches, pid alive); for unknown/probe-failed owners restore the pre-PR functional outcome (adopt via `replaceWorktreeSessionMarker` with a warn). Keep `exit-worktree.ts:246` and `AppContainer.tsx:2064` fail-closed (unknown must still block worktree removal), so do not simply invert the shared `!sawDeadRuntimeStatus` default. Add to worktreeStartup.test.ts: (1) 'adopts a marker when the owner left no runtime-status evidence' — marker `old-session`, no `writeRuntimeStatus`, expect the marker becomes `new-session` (red today: the call throws); (2) a hostname-mismatch sibling writing the status JSON with `hostname: 'elsewhere'` and a dead pid, expecting adoption. Removing the unknown-vs-active distinction makes both red.
>
> <details><summary>中文说明</summary>
>
> **【Critical】** R3-18：已在当前 head（ef450b68）复查：仍然存在。新增的收养 throw 会在"活跃"误判时触发——当 owner 没有留下任何 runtime-status 证据时（worktreeSessionService.ts 的 `return !sawDeadRuntimeStatus`）、当其状态文件写自不同主机名时（不做 pid 探测即判 'active'）、或当探测本身出错时（本调用既有的 `.catch(() => true)`）。该 diff 把这种误判从 PR 前的良性结果（保留旧标记、仍写 sidecar——绑定可用、保护仍在）升级为 throw，而 gemini.tsx:966-971 将其吞成 debugLogger.warn，因此对确实已死的 owner 重新挂载会永久丢失持久绑定：没有 sidecar、没有标记收养，之后每次 `qwen --worktree <slug>` 启动都重复中止，`--resume` 永远无法恢复 worktree 上下文——除非手工删除 `.qwen-session` 或换新 slug。与 R1-5（真正活跃 owner 的被化解 throw）不同：即使拒绝被完善地呈现，这些用户仍会被错误锁在外面，因为判定本身把已死/不可验证的 owner 归类为活跃。第 3 轮探测：无证据 → 判活跃并 throw、标记不变、未写 sidecar；有证据的死 owner → 成功收养（翻转对）；异主机名 → 尽管 pid 已死仍 throw。请区分"确证活跃"与"不可验证"：对确证活跃才 throw；未知/探测失败的 owner 恢复 PR 前的功能性收养（带告警）。保持 exit-worktree 与 AppContainer 的失败即关闭语义，不要简单反转共享的 `!sawDeadRuntimeStatus` 默认。需补充两个测试；移除未知/活跃区分应使二者变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 16. Case-variant session restore 丢失 worktree isolation

- 评论来源：qwen-code-ci-bot，Review，https://github.com/QwenLM/qwen-code/pull/10226#pullrequestreview-5048319612
- 结论：值得修复
- 理由：Review body 独有的 R3-7 在远端 head 仍成立：sidecar 用 restoredStorageSessionId 查找，但 marker owner 与 caller-supplied sessionId 比较；uppercase 持久化 ID 经 lowercase URL 恢复时会误判并落回主 checkout。
- 建议修复：marker owner 与 restoredStorageSessionId 比较，补 uppercase persisted + lowercase request 的 load/resume 测试，并保留真正跨 owner 拒绝测试。
- 实施状态：已修复并验证
- 修复批次：F3
- 实施证据：marker owner 改与 `restoredStorageSessionId` 比较；uppercase persisted/lowercase request 的 worktree load 测试恢复 cwd 并通过。

原始评论：

> Partially reviewed — gaps disclosed.
>
> 11 Suggestion-level finding(s) this review confirmed are already reported on this PR and are not repeated:
>
> - empty-marker EEXIST re-attach lockout (worktreeStartup.ts:402) — already reported as R1-15 ([comment 3871421096](https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3871421096)); round-4 auditors in three consecutive passes argued Critical severity, the existing record is a Suggestion
> - torn-sidecar jam of cleanup and recovery (worktreeSessionService.ts:160) — already recorded in the round-3 deferral list
> - recovery liveness gate hostname/PID false-alive retention (branch-worktree-preparation.ts:297) — already recorded in the round-2 deferral list (PID reuse defeats owner liveness)
> - orphaned journal .tmp files never reclaimed (branch-worktree-preparation.ts:253) — already recorded in the round-2 deferral list (crash-window .tmp journals)
> - resolveBranchWorktreeBaseCheckout negative-path coverage — already reported as R1-28 ([comment 3871421003](https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3871421003))
> - synchronous execFileSync git probes in the request path (workspace-route-runtime.ts) — already reported by @doudouOUC (issue [comment 5433998372](https://github.com/QwenLM/qwen-code/pull/10226#issuecomment-5433998372), Suggestion 1); recorded in rounds 1 and 3
> - worktreeSupported recomputed from scratch per git-status request (workspace-git.ts:107) — already recorded in the round-3 deferral list
> - worktreeSupported push-mirror merge coverage (App.tsx:2696) — already recorded in the round-3 deferral list
> - marker-gate rejection branches (missing marker / non-file) untested (server.test.ts:14340) — already recorded in the round-3 deferral list
> - 'parent directory is absent' test never has an absent parent (worktreeSessionService.test.ts:170) — already reported as R1-17 ([comment 3871421106](https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3871421106)) and recorded in the round-3 deferral list
> - branch_worktree_activation_failed double toast (App.tsx:8495) — already reported as R1-19 ([comment 3871421118](https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3871421118)); round-4 auditor argued Critical severity, the existing record is a Suggestion
>
> Not reviewed: build-and-test — Integration Tests (CLI, No Sandbox) was skipped in CI and its suite did not run locally.
>
> Not reviewed: reverse audit — stopped at the plan's 3-round cap without converging (round 3 still surfaced new findings).
>
> Not explored to full depth (tool budget reached): chunk 5: `executing  branch-worktree-preparation.test.ts  (dependencies not installed and core  dist/  not built in this worktree; install+build exceeds budget) — all ver…`.
>
> Deferred under the convergence posture (round 4, not a blocker) — recorded, not requested in this round:
>
> - `packages/core/src/services/gitWorktreeService.ts:2452 — [review] isClean tail window after the last cleanliness gate lets an ignored file be deleted by worktree remove (probe witness)`
> - `packages/cli/src/serve/workspace-route-runtime.ts:408 — [review] resolveContainedCwd/resolveContainedCwdOrFail left exported with zero production callers, advertised for mutation routes`
> - `docs/design/web-shell/web-shell-branch-session-optional-worktree.md:468 — [review] design doc prescribes the unanchored clean-exclusion pattern the implementation deliberately anchors (probe witness)`
>
> Convergence: round 4 posted 13 inline comment(s), 4 of them reported for the first time; the previous round posted 13 (6 new). Findings keep coming back to the same files: `packages/cli/src/startup/worktreeStartup.ts` (findings in round 3; 2 more now); `packages/cli/src/serve/workspace-route-runtime.ts` (findings in rounds 1, 2, 3; 1 more now); `packages/web-shell/client/components/BranchPickerPopover.tsx` (findings in round 3; 1 more now). A cluster that keeps producing siblings usually means the fixes are treating instances of a shared root cause — triaging that cause before the next round, or splitting an independent cluster into its own pull request, tends to end the loop faster than fixing them one at a time. (Observation only — nothing was withheld from this review because of this observation.)
>
> Mechanism health: this round did not close cleanly, so it withholds the incremental anchor — and the round it recovered had no anchor this round could use either — none at all, one with no certifier, one certified by an identity other than the one this round runs under, or one this round's fetch refused or resolved to the head — so the next review re-reads the whole diff unless recovery grafts an earlier own anchor that the round running it can use onto the complete work list this round leaves behind, and keeps doing so until a round's marker carries an anchor again or a graft lands that the round running it can use. (Stated, not acted on — this changes nothing about what the round posts.)
>
> **[Critical]** R3-7 (packages/cli/src/serve/routes/session.ts:3872 — dropped from inline by a deterministic position overlap with the existing R1-23 thread at that line; this body entry is its only copy): Re-checked at the current head (ef450b68): still stands. The new marker-ownership gate compares markerOwner against the caller-supplied sessionId instead of restoredStorageSessionId — the persisted spelling the sidecar was just read under. This route deliberately supports loading a session under a different case spelling (resolveSessionIdForRestore → findSessionIdIgnoreCase exists because legacy CLI sessions may have been written with uuidgen's uppercase spelling while daemon-facing caller IDs are canonicalized to lowercase), and the marker is written with the persisted spelling. A case-variant restore of a worktree session then silently fails the ownership check: realTarget = undefined, the worktree restore is skipped with a misleading 'worktree sidecar path failed containment' warning, and the session resumes executing in the main workspace checkout instead of its worktree — losing exactly the isolation this feature exists to provide, on every such load. Round-3 probe at HEAD: uppercase-persisted session loaded via lowercase URL → status=200 worktree=undefined changeSessionCwdCalls=0; with the operand changed to restoredStorageSessionId → worktree populated, changeSessionCwdCalls=1, and the two sibling tests stay green (probe flips). Fix: compare against restoredStorageSessionId (equal to sessionId for exact-spelling loads, so the common path and the cross-session rejection test are unaffected). Fix witness: a case-variant sibling of 'restores worktree isolation on load when sidecar exists' asserting res.body.worktree is populated and changeSessionCwdCalls has length 1; reverting the operand makes it red.
>
> <details>
> <summary>中文说明</summary>
>
> 仅完成部分审查，审查缺口已披露。
>
> 本轮确认的 11 条建议级发现已在 PR 上报告过，不再重复发布（列表见上方英文部分）。
>
> 未审查：build-and-test — Integration Tests (CLI, No Sandbox) was skipped in CI and its suite did not run locally。
>
> 未审查：reverse audit — stopped at the plan's 3-round cap without converging (round 3 still surfaced new findings)。
>
> 未探索到全部深度（达到工具调用预算）：chunk 5：`executing  branch-worktree-preparation.test.ts  (dependencies not installed and core  dist/  not built in this worktree; install+build exceeds budget) — all ver…`。
>
> 收敛姿态下延后（第 4 轮，非阻断）——已记录，本轮不要求修改：共 3 条（原文未翻译，列表见上方英文部分）。
>
> 收敛情况：第 4 轮发布了 13 条行内评论，其中 4 条是首次提出；上一轮发布了 13 条（其中 6 条首次提出）。发现反复回到同一批文件：`packages/cli/src/startup/worktreeStartup.ts`（第 3 轮已出过发现，本轮又有 2 条）；`packages/cli/src/serve/workspace-route-runtime.ts`（第 1、2、3 轮已出过发现，本轮又有 1 条）；`packages/web-shell/client/components/BranchPickerPopover.tsx`（第 3 轮已出过发现，本轮又有 1 条）。一个不断再生兄弟发现的簇，通常意味着逐条修复只在处理同一根因的实例——先定位并处理该根因，或把独立的簇拆成单独的 PR，通常比逐条修复更快结束循环。（仅为观察——本轮评审未因此扣留任何内容。）
>
> 机制健康：本轮未能干净收尾，因而扣留了增量锚点，而它恢复到的那一轮也没有留下本轮可用的锚点——要么完全没有、要么没有认证者、要么由本轮运行身份之外的身份认证、要么被本轮的获取拒绝或解析为头提交——因此下一次评审将重读整个 diff，除非恢复流程把本轮能使用的更早自有锚点嫁接到本轮留下的完整工作清单上；并会一直如此，直到某一轮的标记重新带上锚点，或落地的嫁接能被运行该轮的评审使用。（仅陈述，不据此行动——这不改变本轮发布的任何内容。）
>
> **[Critical]** R3-7 (packages/cli/src/serve/routes/session.ts:3872 — dropped from inline by a deterministic position overlap with the existing R1-23 thread at that line; this body entry is its only copy): Re-checked at the current head (ef450b68): still stands. The new marker-ownership gate compares markerOwner against the caller-supplied sessionId instead of restoredStorageSessionId — the persisted spelling the sidecar was just read under. This route deliberately supports loading a session under a different case spelling (resolveSessionIdForRestore → findSessionIdIgnoreCase exists because legacy CLI sessions may have been written with uuidgen's uppercase spelling while daemon-facing caller IDs are canonicalized to lowercase), and the marker is written with the persisted spelling. A case-variant restore of a worktree session then silently fails the ownership check: realTarget = undefined, the worktree restore is skipped with a misleading 'worktree sidecar path failed containment' warning, and the session resumes executing in the main workspace checkout instead of its worktree — losing exactly the isolation this feature exists to provide, on every such load. Round-3 probe at HEAD: uppercase-persisted session loaded via lowercase URL → status=200 worktree=undefined changeSessionCwdCalls=0; with the operand changed to restoredStorageSessionId → worktree populated, changeSessionCwdCalls=1, and the two sibling tests stay green (probe flips). Fix: compare against restoredStorageSessionId (equal to sessionId for exact-spelling loads, so the common path and the cross-session rejection test are unaffected). Fix witness: a case-variant sibling of 'restores worktree isolation on load when sidecar exists' asserting res.body.worktree is populated and changeSessionCwdCalls has length 1; reverting the operand makes it red.
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_
>
> <!-- qwen-review-ledger {"v":1,"round":4,"findings":[{"id":"R1-1","sev":"C","file":"packages/cli/src/acp-integration/acpAgent.test.ts","line":17583,"title":"Re-checked at the current head (ef450b68): still stands. The test this PR adds —"},{"id":"R1-2","sev":"C","file":"packages/cli/src/serve/workspace-route-runtime.ts","line":447,"title":"Re-checked at the current head (ef450b68): still stands. `markerIsOwnedBy` reads"},{"id":"R1-3","sev":"C","file":"packages/cli/src/serve/routes/session.ts","line":4414,"title":"Re-checked at the current head (ef450b68): still stands — and independently re-d"},{"id":"R4-1","sev":"C","file":"packages/cli/src/serve/workspace-route-runtime.ts","line":490,"title":"Re-checked at the current head (ef450b68): still stands. The catch around the `g"},{"id":"R4-2","sev":"C","file":"packages/cli/src/startup/worktreeStartup.ts","line":417,"title":"Re-checked at the current head (ef450b68): still stands — re-derived independent"},{"id":"R4-3","sev":"C","file":"packages/web-shell/client/components/BranchPickerPopover.tsx","line":132,"title":"Re-checked at the current head (ef450b68): still stands. This PR changed the pic"},{"id":"R2-1","sev":"C","file":"packages/web-shell/client/App.tsx","line":8586,"title":"Re-checked at the current head (ef450b68): still stands. `confirmBranchSession`'"},{"id":"R2-2","sev":"C","file":"packages/core/src/services/gitWorktreeService.ts","line":102,"title":"Re-checked at the current head (ef450b68): still stands. `writeWorktreeSessionMa"},{"id":"R2-3","sev":"C","file":"packages/cli/src/serve/branch-worktree-preparation.ts","line":498,"title":"Re-checked at the current head (ef450b68): still stands. The recovery sweep's on"},{"id":"R2-4","sev":"C","file":"packages/cli/src/serve/workspace-route-runtime.ts","line":547,"title":"Re-checked at the current head (ef450b68): still stands. The entire verification"},{"id":"R3-3","sev":"C","file":"packages/core/src/services/gitWorktreeService.ts","line":2455,"title":"Re-checked at the current head (ef450b68): still stands. `removePreparedUserWork"},{"id":"R3-6","sev":"C","file":"packages/cli/src/serve/workspace-route-runtime.ts","line":543,"title":"Re-checked at the current head (ef450b68): still stands. `resolveSessionManagedG"},{"id":"R4-4","sev":"C","file":"packages/cli/src/startup/worktreeStartup.ts","line":407,"title":"Re-checked at the current head (ef450b68): still stands. The new adoption throw "},{"id":"R3-7","sev":"C","file":"(body)","title":"(packages/cli/src/serve/routes/session.ts:3872 — dropped from inline by a determ"}],"posted":13,"floor":"o","fresh":4,"prevPosted":13,"src0":3836} -->

### 17. AutoFix 第二次运行超时且未发布改动

- 评论来源：qwen-code-dev-bot，会话评论，https://github.com/QwenLM/qwen-code/pull/10226#issuecomment-5460063523
- 结论：不值得修复
- 理由：该评论明确说明 AutoFix 因一小时超时退出、runner 内提交已丢弃且没有 push；它是外部自动化状态，不指出可由本分支修复的代码缺陷。
- 实施状态：无需修改
- 修复批次：N/A
- 实施证据：已核对锚定 comment、Run log 链接与当前 PR HEAD；本轮不会把 runner 中未发布的提交当作仓库状态。

原始评论：

> 🤖 AutoFix ran out of time before finishing (timeout (3600000ms)) (attempt 2/100) — it will retry on the next scan.
>
> ⚠️ This change was NOT pushed — any commit referenced below was made only in the runner workspace and has been discarded. What the agent reported:
> Qwen failed during address-review: timeout (3600000ms).
>
> See the Qwen Autofix agent step logs for model/tool output.
>
> <details>
> <summary>中文说明</summary>
>
> 🤖 AutoFix 在完成前耗尽了时间（timeout (3600000ms)）（第 2/100 次尝试）—— 将在下次扫描时重试。
>
> </details>
>
> Run log: https://github.com/QwenLM/qwen-code/actions/runs/33226232315
>
> ---
>
> 🧠 Handled by **Qwen Code** · model/模型 `qwen3.8-max`
>
> <!-- autofix-eval ts=9999-12-31T23:59:59Z acted=false round=2 win=2026-08-27T04:08:49Z -->
> <!-- autofix-growth-now src=0 test=0 over=false round=2 run=33226232315 measured=2026-08-29T01:32:16Z key=2026-08-27T04:08:49Z -->

### 18. 被重新持有的 worktree 仍向旧 session 注入恢复提示

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3888412727
- 结论：值得修复
- 理由：daemon 的 marker gate 会拒绝旧 owner，但 core restore helper 与 session-list enrichment 仍只信任 sidecar，可能把另一个 live session 已接管的 worktree 暴露给旧 session。
- 建议修复：恢复提示与列表富集均交叉检查 marker owner；不匹配时不注入、不展示，并清理旧 session sidecar。
- 实施状态：已修复并验证
- 修复批次：F9
- 实施证据：`restoreWorktreeContext` 以目标 session id 交叉检查 marker owner，不匹配时清理旧 sidecar 且不生成恢复提示；三个生产恢复入口均传入 owning session id，daemon 列表仅富集 owner 匹配的 sidecar。Core restore、ACP、headless resume 与 daemon list 回归测试通过。

原始评论：

标注位置：`packages/cli/src/serve/routes/session.ts:3889`（RIGHT（新增侧））

```diff
@@ -3863,6 +3882,18 @@ export function registerSessionRoutes(
               if (!contained) {
                 realTarget = undefined;
               }
+              if (realTarget) {
+                const markerStat = fs.lstatSync(
+                  path.join(realTarget, WORKTREE_SESSION_FILE),
+                );
+                const markerOwner = await readWorktreeSessionMarker(realTarget);
```

> **[Critical]** R8-1: [certifies-falsely] [new-surface] Re-checked at the current head (a3c7b7fc): still stands. The marker-owner refusal half of this load/resume gate leaves the sidecar in place, and the agent-side restoreWorktreeContext (worktreeSessionService.ts:520-605) decides from the sidecar alone — it never consults marker ownership — so a session whose worktree was re-owned by another session is still told by a system-reminder to operate in it. Concretely: session A creates worktree W (marker + sidecar A); A dies; session B legitimately adopts W via replaceWorktreeSessionMarker; the user resumes A — the daemon gate correctly skips the restore, but A's first prompt still prepends '[Resumed] Active worktree ... Continue using this path for all file operations', pointing A's agent at the worktree B now owns and executes in. Restore the worktree context only while the marker owner still matches: cross-check the marker owner in restoreWorktreeContext (and the daemon list enrichment) before emitting the context message, or clear/re-validate the sidecar when the owner no longer matches. Fix witness: a load/resume test whose sidecar names a worktree whose marker belongs to another session must not emit the resume-worktree context message; removing the ownership cross-check must turn it red.
>
> Witness:
>
> ```
> witness: not run — nearest capability is a load/resume probe with a re-owned marker; mechanism re-traced verbatim at the byte-identical head (round-9 verifier: restoreWorktreeContext clears only read-failure/containment/dead-dir shapes, never ownership; pendingWorktreeNotice rides the first prompt as a system-reminder)
> ```
>
> <details>
> <summary>中文说明</summary>
>
> 【Critical】R8-1：已在当前 head（a3c7b7fc）复查：仍然存在。load/resume 门禁中「标记属主不符」的拒绝分支把 sidecar 留在了原地，而 agent 侧的 restoreWorktreeContext（worktreeSessionService.ts:520-605）只依据 sidecar 做决定——从不检查标记属主——因此一个 worktree 已被另一个会话重新持有（re-owned）的会话，仍会收到 system-reminder 指示它继续在该 worktree 中工作。具体场景：会话 A 创建 worktree W（标记 + sidecar 均为 A）；A 死亡；会话 B 通过 replaceWorktreeSessionMarker 合法接管 W；用户恢复 A 时，daemon 门禁正确地跳过了恢复，但 A 的第一个 prompt 仍会被前置 '[Resumed] Active worktree ... Continue using this path for all file operations'——把 A 的 agent 指向 B 现在持有并正在使用的 worktree。建议只在标记属主仍然匹配时才恢复 worktree 上下文：在 restoreWorktreeContext（以及 daemon 的会话列表富集）发出上下文消息前交叉检查标记属主，或在属主不再匹配时清理/重新校验 sidecar。修复见证：sidecar 指向的 worktree 标记属于另一个会话的 load/resume 测试不得发出恢复 worktree 的上下文消息；移除属主交叉检查后该测试应变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.3)_

### 19. 用户可选 agent slug 会被 stale-agent sweep 删除

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3888412730
- 结论：值得修复
- 理由：用户入口允许 agent-<7hex>，而后台清理将该形状视为可自动删除的 ephemeral worktree，存在删除活跃分支 session 工作目录与未跟踪成果的风险。
- 建议修复：在所有用户可控 worktree 创建路由拒绝 canonical agent slug，并补路由级负例。
- 实施状态：已修复并验证
- 修复批次：F10
- 实施证据：普通 session 创建与 branch-session worktree 两个用户路由均在通用 slug 校验前拒绝 `AGENT_WORKTREE_SLUG_PATTERN`；`agent-1234567` 的三个路由级负例通过，且均未进入 worktree 准备或 branch mutation。

原始评论：

标注位置：`packages/cli/src/serve/routes/session.ts:4144`（RIGHT（新增侧））

```diff
@@ -4076,6 +4108,415 @@ export function registerSessionRoutes(
         }
         const clientId = parseClientIdHeader(req, res);
         if (clientId === null) return;
+        const rawWorktree = body?.['worktree'];
+        if (rawWorktree !== undefined) {
+          if (!runtime.trusted) {
+            res.status(403).json({
+              error: 'Worktree creation requires a trusted workspace',
+              code: 'untrusted_workspace',
+            });
+            return;
+          }
+          if (
+            rawWorktree === null ||
+            typeof rawWorktree !== 'object' ||
+            Array.isArray(rawWorktree)
+          ) {
+            res.status(400).json({
+              error: '`worktree` must be an object',
+              code: 'invalid_worktree',
+            });
+            return;
+          }
+          const worktreeRequest = rawWorktree as Record<string, unknown>;
+          const rawSlug = worktreeRequest['slug'];
+          const slug =
+            rawSlug === undefined
+              ? GitWorktreeService.generateAutoSlug()
+              : rawSlug;
+          if (typeof slug !== 'string' || slug.length === 0) {
+            res.status(400).json({
+              error: '`worktree.slug` must be a non-empty string',
+              code: 'worktree_invalid_slug',
+            });
+            return;
+          }
+          const slugError = GitWorktreeService.validateUserWorktreeSlug(slug);
```

> **[Critical]** R5-3: [certifies-falsely] [new-surface] Re-checked at the current head (a3c7b7fc): still stands. This route accepts any slug passing validateUserWorktreeSlug — which deliberately ALLOWS the canonical agent-<7hex> slugs ('the exact agent-<7hex> slugs that generateAgentWorktreeSlug produces ARE allowed', gitWorktreeService.ts:1759-1772) — and binds a session to that worktree (marker, sidecar, setSessionWorktree). But cleanupStaleAgentWorktrees, which runs fire-and-forget at CLI starts, sweeps worktrees matching the agent-slug pattern by mtime only — never consulting marker, sidecar, or live occupancy. Probe this round (scratch tree, real git): validateUserWorktreeSlug('agent-1234567') returned null (accepted); a marker-bound live-session worktree aged to a 31-day mtime was swept — cleanupStaleAgentWorktrees returned 1 and the directory was gone afterwards (git worktree remove --force plus fs.rm fallback destroys untracked work too). Trigger: a user branches with slug 'agent-1234567'; after the staleness window the sweep deletes the live branch session's worktree out from under it. Reject agent-pattern slugs at the branch route, or exclude marker/sidecar-bound worktrees from the sweep (consult ownership before removal). Fix witness: a test that binds a session marker to an agent-<7hex> worktree, ages it past the staleness window, runs the sweep, and asserts the worktree survives; removing the occupancy check must turn it red.
>
> Witness:
>
> ```
> validateUserWorktreeSlug('agent-1234567') => null (accepted)
> AGENT_WORKTREE_SLUG_PATTERN.test('agent-1234567') => true
> marker-bound worktree aged to 31-day mtime => swept
> cleanupStaleAgentWorktrees(root) => 1; worktree directory gone
> ```
>
> <details>
> <summary>中文说明</summary>
>
> 【Critical】R5-3：已在当前 head（a3c7b7fc）复查：仍然存在。该路由接受任何通过 validateUserWorktreeSlug 的 slug——而该校验器刻意允许规范的 agent-<7hex> slug（gitWorktreeService.ts:1759-1772 明确写着「generateAgentWorktreeSlug 产生的 agent-<7hex> slug 是被允许的」）——并把会话绑定到该 worktree（标记、sidecar、setSessionWorktree）。但 cleanupStaleAgentWorktrees 在 CLI 启动时 fire-and-forget 运行，只按 mtime 清扫匹配 agent-slug 模式的 worktree——从不检查标记、sidecar 或存活占用。本轮探测（scratch tree，真实 git）：validateUserWorktreeSlug('agent-1234567') 返回 null（接受）；一个绑定了存活会话标记、mtime 老化到 31 天的 worktree 被清扫——cleanupStaleAgentWorktrees 返回 1，目录随后消失（git worktree remove --force 加 fs.rm 兜底，连未跟踪的工作成果也会被摧毁）。触发条件：用户以 'agent-1234567' 为 slug 创建分支会话；超过陈旧窗口后，清扫会把这个存活分支会话的 worktree 从其脚下删除。建议在分支路由拒绝 agent 模式的 slug，或在清扫中排除已绑定标记/sidecar 的 worktree（删除前检查属主）。修复见证：把会话标记绑定到一个 agent-<7hex> worktree、将其老化过窗口、运行清扫并断言 worktree 存活的测试；移除占用检查后该测试应变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.3)_

### 20. Branch worktree Git 子进程继承仓库重定向环境变量

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3888412734
- 结论：值得修复
- 理由：新增的 direct Git spawn 未使用仓库现有 gitEnv，继承 GIT*DIR/GIT_WORK_TREE/GIT_CONFIG*\* 时可对另一个仓库做身份判断。
- 建议修复：让本文件新增的 resolver 与 preflight Git 子进程统一应用 gitEnv，并用 decoy repository 回归测试固定。
- 实施状态：已修复并验证
- 修复批次：F11
- 实施证据：`resolveGitCommonDir`、`git worktree list --porcelain` 与 `git ls-tree` 三个新增 spawn 均传入完整 `gitEnv()`；在继承 `GIT_DIR`/`GIT_WORK_TREE` 指向 decoy repository 时，branch worktree preflight 仍认证真实 checkout，13 项文件测试通过。

原始评论：

标注位置：`packages/cli/src/serve/branch-worktree-preparation.ts:742`（RIGHT（新增侧））

```diff
@@ -0,0 +1,768 @@
+/**
+ * @license
+ * Copyright 2026 Qwen Team
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import * as fs from 'node:fs/promises';
+import { constants as fsConstants } from 'node:fs';
+import * as os from 'node:os';
+import * as path from 'node:path';
+import * as crypto from 'node:crypto';
+import { execFile } from 'node:child_process';
+import { promisify } from 'node:util';
+import {
+  GitWorktreeService,
+  WORKTREE_SESSION_FILE,
+  clearWorktreeSessionDurable,
+  readWorktreeSession,
+  readWorktreeSessionMarker,
+  worktreeBranchForSlug,
+  type SessionService,
+} from '@qwen-code/qwen-code-core';
+import type { BridgeSessionExecutionSnapshot } from '@qwen-code/acp-bridge/bridgeTypes';
+import { getHeadCommit } from './server/git-branch-ops.js';
+
+const execFileAsync = promisify(execFile);
+const BRANCH_WORKTREE_JOURNAL_MAX_BYTES = 64 * 1024;
+
+export interface BranchWorktreeBaseCheckout {
+  repoTop: string;
+  checkoutCwd: string;
+  headCommit: string;
+  branch: string;
+}
+
+export type BranchWorktreePreparationPhase =
+  | 'planned'
+  | 'worktree-created'
+  | 'marker-created'
+  | 'sidecar-ready'
+  | 'mutation-dispatched'
+  | 'cleanup-intent'
+  | 'worktree-removed'
+  | 'branch-deleted'
+  | 'branch-preserved';
+
+export interface BranchWorktreePreparationJournal {
+  version: 1;
+  ownerToken: string;
+  pid: number;
+  hostname: string;
+  createdAt: string;
+  targetSessionId: string;
+  slug: string;
+  worktreePath: string;
+  worktreeBranch: string;
+  repoTop: string;
+  baseCommit: string;
+  sidecarPath: string;
+  markerCreated: boolean;
+  sidecarCreated: boolean;
+  phase: BranchWorktreePreparationPhase;
+}
+
+const PREPARATION_PHASES = new Set<BranchWorktreePreparationPhase>([
+  'planned',
+  'worktree-created',
+  'marker-created',
+  'sidecar-ready',
+  'mutation-dispatched',
+  'cleanup-intent',
+  'worktree-removed',
+  'branch-deleted',
+  'branch-preserved',
+]);
+
+async function fsyncDirectory(directory: string): Promise<void> {
+  try {
+    const handle = await fs.open(directory, 'r');
+    try {
+      await handle.sync();
+    } finally {
+      await handle.close();
+    }
+  } catch (error) {
+    if (process.platform !== 'win32') throw error;
+  }
+}
+
+async function pathExists(filePath: string): Promise<boolean> {
+  return await fs
+    .lstat(filePath)
+    .then(() => true)
+    .catch((error: NodeJS.ErrnoException) => {
+      if (error.code === 'ENOENT') return false;
+      throw error;
+    });
+}
+
+async function writeExclusiveFile(
+  filePath: string,
+  contents: string,
+): Promise<void> {
+  const handle = await fs.open(
+    filePath,
+    fsConstants.O_WRONLY |
+      fsConstants.O_CREAT |
+      fsConstants.O_EXCL |
+      (fsConstants.O_NOFOLLOW ?? 0),
+    0o600,
+  );
+  let openedStat: Awaited<ReturnType<typeof handle.stat>> | undefined;
+  let completed = false;
+  try {
+    openedStat = await handle.stat();
+    if (!openedStat.isFile() || openedStat.nlink !== 1) {
+      throw new Error('Branch worktree journal must be a regular file');
+    }
+    await handle.writeFile(contents, 'utf8');
+    await handle.sync();
+    const finalStat = await fs.lstat(filePath);
+    if (
+      !finalStat.isFile() ||
+      finalStat.nlink !== 1 ||
+      finalStat.dev !== openedStat.dev ||
+      finalStat.ino !== openedStat.ino
+    ) {
+      throw new Error('Branch worktree journal path changed');
+    }
+    completed = true;
+  } finally {
+    await handle.close();
+    if (!completed && openedStat) {
+      await fs
+        .lstat(filePath)
+        .then(async (pathStat) => {
+          if (
+            pathStat.isFile() &&
+            pathStat.nlink === 1 &&
+            pathStat.dev === openedStat!.dev &&
+            pathStat.ino === openedStat!.ino
+          ) {
+            await fs.unlink(filePath);
+          }
+        })
+        .catch(() => {});
+    }
+  }
+}
+
+async function readStrictFile(filePath: string): Promise<string> {
+  const pathStat = await fs.lstat(filePath);
+  if (!pathStat.isFile() || pathStat.nlink !== 1) {
+    throw new Error('Branch worktree journal must be a regular file');
+  }
+  const handle = await fs.open(
+    filePath,
+    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
+  );
+  try {
+    const openedStat = await handle.stat();
+    if (
+      !openedStat.isFile() ||
+      openedStat.nlink !== 1 ||
+      openedStat.dev !== pathStat.dev ||
+      openedStat.ino !== pathStat.ino ||
+      openedStat.size > BRANCH_WORKTREE_JOURNAL_MAX_BYTES
+    ) {
+      throw new Error('Branch worktree journal path changed');
+    }
+    const buffer = Buffer.alloc(BRANCH_WORKTREE_JOURNAL_MAX_BYTES + 1);
+    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
+    if (bytesRead > BRANCH_WORKTREE_JOURNAL_MAX_BYTES) {
+      throw new Error('Branch worktree journal is too large');
+    }
+    const contents = buffer.subarray(0, bytesRead).toString('utf8');
+    const finalStat = await fs.lstat(filePath);
+    if (
+      !finalStat.isFile() ||
+      finalStat.nlink !== 1 ||
+      finalStat.dev !== openedStat.dev ||
+      finalStat.ino !== openedStat.ino
+    ) {
+      throw new Error('Branch worktree journal path changed');
+    }
+    return contents;
+  } finally {
+    await handle.close();
+  }
+}
+
+export function getBranchWorktreeJournalPath(
+  sidecarPath: string,
+  targetSessionId: string,
+): string {
+  return path.join(
+    path.dirname(sidecarPath),
+    `.branch-worktree-${targetSessionId}.json`,
+  );
+}
+
+export async function createBranchWorktreeJournal(args: {
+  journalPath: string;
+  targetSessionId: string;
+  slug: string;
+  worktreePath: string;
+  worktreeBranch: string;
+  repoTop: string;
+  baseCommit: string;
+  sidecarPath: string;
+}): Promise<BranchWorktreePreparationJournal> {
+  const journal: BranchWorktreePreparationJournal = {
+    version: 1,
+    ownerToken: crypto.randomUUID(),
+    pid: process.pid,
+    hostname: os.hostname(),
+    createdAt: new Date().toISOString(),
+    targetSessionId: args.targetSessionId,
+    slug: args.slug,
+    worktreePath: args.worktreePath,
+    worktreeBranch: args.worktreeBranch,
+    repoTop: args.repoTop,
+    baseCommit: args.baseCommit,
+    sidecarPath: args.sidecarPath,
+    markerCreated: false,
+    sidecarCreated: false,
+    phase: 'planned',
+  };
+  await fs.mkdir(path.dirname(args.journalPath), {
+    recursive: true,
+    mode: 0o700,
+  });
+  await writeExclusiveFile(args.journalPath, `${JSON.stringify(journal)}\n`);
+  await fsyncDirectory(path.dirname(args.journalPath));
+  return journal;
+}
+
+export async function updateBranchWorktreeJournal(
+  journalPath: string,
+  current: BranchWorktreePreparationJournal,
+  phase: BranchWorktreePreparationPhase,
+): Promise<BranchWorktreePreparationJournal> {
+  const onDisk = JSON.parse(
+    await readStrictFile(journalPath),
+  ) as BranchWorktreePreparationJournal;
+  if (
+    onDisk.version !== 1 ||
+    onDisk.ownerToken !== current.ownerToken ||
+    onDisk.pid !== current.pid ||
+    onDisk.hostname !== current.hostname ||
+    onDisk.createdAt !== current.createdAt ||
+    onDisk.targetSessionId !== current.targetSessionId ||
+    onDisk.slug !== current.slug ||
+    onDisk.worktreePath !== current.worktreePath ||
+    onDisk.worktreeBranch !== current.worktreeBranch ||
+    onDisk.repoTop !== current.repoTop ||
+    onDisk.baseCommit !== current.baseCommit ||
+    onDisk.sidecarPath !== current.sidecarPath ||
+    onDisk.markerCreated !== current.markerCreated ||
+    onDisk.sidecarCreated !== current.sidecarCreated ||
+    onDisk.phase !== current.phase
+  ) {
+    throw new Error('Branch worktree journal ownership changed');
+  }
+  const next = {
+    ...current,
+    phase,
+    markerCreated:
+      current.markerCreated ||
+      phase === 'marker-created' ||
+      phase === 'sidecar-ready' ||
+      phase === 'mutation-dispatched',
+    sidecarCreated:
+      current.sidecarCreated ||
+      phase === 'sidecar-ready' ||
+      phase === 'mutation-dispatched',
+  };
+  const tempPath = `${journalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
+  await writeExclusiveFile(tempPath, `${JSON.stringify(next)}\n`);
+  try {
+    await fs.rename(tempPath, journalPath);
+    await fsyncDirectory(path.dirname(journalPath));
+  } catch (error) {
+    await fs.unlink(tempPath).catch(() => {});
+    throw error;
+  }
+  return next;
+}
+
+export async function clearBranchWorktreeJournalDurable(
+  journalPath: string,
+): Promise<void> {
+  await fs.unlink(journalPath).catch((error: NodeJS.ErrnoException) => {
+    if (error.code !== 'ENOENT') throw error;
+  });
+  await fsyncDirectory(path.dirname(journalPath)).catch(
+    (error: NodeJS.ErrnoException) => {
+      if (error.code !== 'ENOENT') throw error;
+    },
+  );
+}
+
+async function clearTerminalMetadata(
+  journalPath: string,
+  journal: BranchWorktreePreparationJournal,
+  warn?: (message: string, fields?: Record<string, unknown>) => void,
+): Promise<void> {
+  if (journal.sidecarCreated) {
+    await clearWorktreeSessionDurable(journal.sidecarPath);
+  } else if (await pathExists(journal.sidecarPath)) {
+    warn?.('branch worktree recovery sidecar ownership is unknown', {
+      targetSessionId: journal.targetSessionId,
+    });
+    return;
+  }
+  await clearBranchWorktreeJournalDurable(journalPath);
+}
+
+const recoveryByChatsDir = new Map<string, Promise<void>>();
+const RECOVERY_REQUEST_AGE_MS = 2 * 60_000;
+
+function ownerProcessIsAlive(journal: BranchWorktreePreparationJournal) {
+  if (journal.hostname !== os.hostname()) return true;
+  try {
+    process.kill(journal.pid, 0);
+    return true;
+  } catch (error) {
+    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
+  }
+}
+
+function isPreparationJournal(
+  value: unknown,
+): value is BranchWorktreePreparationJournal {
+  if (typeof value !== 'object' || value === null) return false;
+  const record = value as Record<string, unknown>;
+  return (
+    record['version'] === 1 &&
+    typeof record['ownerToken'] === 'string' &&
+    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
+      record['ownerToken'],
+    ) &&
+    typeof record['pid'] === 'number' &&
+    Number.isInteger(record['pid']) &&
+    record['pid'] > 0 &&
+    typeof record['hostname'] === 'string' &&
+    typeof record['createdAt'] === 'string' &&
+    typeof record['targetSessionId'] === 'string' &&
+    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
+      record['targetSessionId'],
+    ) &&
+    typeof record['slug'] === 'string' &&
+    GitWorktreeService.validateUserWorktreeSlug(record['slug']) === null &&
+    typeof record['worktreePath'] === 'string' &&
+    path.isAbsolute(record['worktreePath']) &&
+    typeof record['worktreeBranch'] === 'string' &&
+    typeof record['repoTop'] === 'string' &&
+    path.isAbsolute(record['repoTop']) &&
+    typeof record['baseCommit'] === 'string' &&
+    /^[0-9a-f]{40,64}$/i.test(record['baseCommit']) &&
+    typeof record['sidecarPath'] === 'string' &&
+    path.isAbsolute(record['sidecarPath']) &&
+    typeof record['markerCreated'] === 'boolean' &&
+    typeof record['sidecarCreated'] === 'boolean' &&
+    typeof record['phase'] === 'string' &&
+    PREPARATION_PHASES.has(record['phase'] as BranchWorktreePreparationPhase)
+  );
+}
+
+export function recoverBranchWorktreePreparations(args: {
+  workspaceCwd: string;
+  sessionService: SessionService;
+  assertGenerationOpen?: () => void;
+  isWorktreeOccupied?: (worktreePath: string) => boolean;
+  warn?: (message: string, fields?: Record<string, unknown>) => void;
+}): Promise<void> {
+  const probeSidecar = args.sessionService.getWorktreeSessionPath(
+    '00000000-0000-4000-8000-000000000000',
+  );
+  const chatsDir = path.dirname(probeSidecar);
+  const current = recoveryByChatsDir.get(chatsDir);
+  if (current) return current;
+  const recovery = (async () => {
+    const entries = await fs.readdir(chatsDir).catch(() => []);
+    if (!entries.some((name) => name.startsWith('.branch-worktree-'))) return;
+    const workspaceCwd = await fs.realpath(args.workspaceCwd).catch(() => null);
+    const discoveredRepoTop = workspaceCwd
+      ? await new GitWorktreeService(workspaceCwd)
+          .getRepoTopLevel()
+          .catch(() => null)
+      : null;
+    const runtimeRepoTop = discoveredRepoTop
+      ? await fs.realpath(discoveredRepoTop).catch(() => null)
+      : null;
+    if (runtimeRepoTop === null) {
+      args.warn?.('branch worktree recovery workspace is unavailable', {
+        workspace: args.workspaceCwd,
+      });
+      return;
+    }
+    for (const name of entries) {
+      if (!/^\.branch-worktree-[0-9a-f-]{36}\.json$/i.test(name)) continue;
+      args.assertGenerationOpen?.();
+      const journalPath = path.join(chatsDir, name);
+      let journal: BranchWorktreePreparationJournal;
+      try {
+        const parsed: unknown = JSON.parse(await readStrictFile(journalPath));
+        if (!isPreparationJournal(parsed)) throw new Error('invalid shape');
+        journal = parsed;
+      } catch (error) {
+        args.warn?.('invalid branch worktree recovery journal preserved', {
+          journalPath,
+          error: error instanceof Error ? error.message : String(error),
+        });
+        continue;
+      }
+      const expectedJournalPath = getBranchWorktreeJournalPath(
+        journal.sidecarPath,
+        journal.targetSessionId,
+      );
+      const worktreeService = new GitWorktreeService(runtimeRepoTop);
+      const journalRepoTop = await fs
+        .realpath(journal.repoTop)
+        .catch(() => null);
+      if (
+        expectedJournalPath !== journalPath ||
+        journal.sidecarPath !==
+          args.sessionService.getWorktreeSessionPath(journal.targetSessionId) ||
+        journalRepoTop !== runtimeRepoTop ||
+        path.resolve(journal.repoTop, '.qwen', 'worktrees', journal.slug) !==
+          path.resolve(journal.worktreePath) ||
+        journal.worktreeBranch !== worktreeBranchForSlug(journal.slug)
+      ) {
+        args.warn?.('branch worktree recovery journal identity mismatch', {
+          targetSessionId: journal.targetSessionId,
+        });
+        continue;
+      }
+      if (
+        await args.sessionService.sessionExistsInAnyState(
+          journal.targetSessionId,
+        )
+      ) {
+        await clearBranchWorktreeJournalDurable(journalPath);
+        continue;
+      }
+      if (!journal.sidecarCreated && (await pathExists(journal.sidecarPath))) {
+        args.warn?.('branch worktree recovery sidecar ownership is unknown', {
+          targetSessionId: journal.targetSessionId,
+        });
+        continue;
+      }
+      if (
+        journal.phase === 'branch-deleted' ||
+        journal.phase === 'branch-preserved'
+      ) {
+        await clearTerminalMetadata(journalPath, journal, args.warn);
+        continue;
+      }
+      if (journal.phase === 'mutation-dispatched') {
+        args.warn?.('branch worktree outcome remains unknown; resources kept', {
+          targetSessionId: journal.targetSessionId,
+        });
+        continue;
+      }
+      const createdAt = Date.parse(journal.createdAt);
+      if (
+        !Number.isFinite(createdAt) ||
+        Date.now() - createdAt < RECOVERY_REQUEST_AGE_MS ||
+        ownerProcessIsAlive(journal)
+      ) {
+        continue;
+      }
+      if (journal.phase === 'planned') {
+        if (!(await pathExists(journal.worktreePath))) {
+          await clearBranchWorktreeJournalDurable(journalPath);
+        } else {
+          args.warn?.('planned branch worktree residue preserved', {
+            targetSessionId: journal.targetSessionId,
+          });
+        }
+        continue;
+      }
+      if (journal.phase === 'worktree-removed') {
+        args.assertGenerationOpen?.();
+        const finalized =
+          await worktreeService.finalizePreparedUserWorktreeBranch(
+            journal.slug,
+            journal.baseCommit,
+          );
+        if (!finalized.success) {
+          args.warn?.('branch worktree recovery could not finalize branch', {
+            targetSessionId: journal.targetSessionId,
+            error: finalized.error,
+          });
+          continue;
+        }
+        journal = await updateBranchWorktreeJournal(
+          journalPath,
+          journal,
+          finalized.branchPreserved ? 'branch-preserved' : 'branch-deleted',
+        );
+        if (finalized.branchPreserved) {
+          args.warn?.('branch worktree recovery preserved branch', {
+            targetSessionId: journal.targetSessionId,
+            branch: journal.worktreeBranch,
+          });
+        }
+        await clearTerminalMetadata(journalPath, journal, args.warn);
+        continue;
+      }
+      let occupied = false;
+      try {
+        occupied = args.isWorktreeOccupied?.(journal.worktreePath) ?? false;
+      } catch (error) {
+        args.warn?.('branch worktree live occupancy is unknown', {
+          targetSessionId: journal.targetSessionId,
+          error: error instanceof Error ? error.message : String(error),
+        });
+        continue;
+      }
+      if (occupied) {
+        args.warn?.('branch worktree is still occupied by a live session', {
+          targetSessionId: journal.targetSessionId,
+        });
+        continue;
+      }
+      if (journal.phase !== 'cleanup-intent') {
+        journal = await updateBranchWorktreeJournal(
+          journalPath,
+          journal,
+          'cleanup-intent',
+        );
+      }
+      if (await pathExists(journal.worktreePath)) {
+        const markerOwner = await readWorktreeSessionMarker(
+          journal.worktreePath,
+        );
+        if (
+          (journal.markerCreated && markerOwner !== journal.targetSessionId) ||
+          (markerOwner !== null && markerOwner !== journal.targetSessionId)
+        ) {
+          args.warn?.('branch worktree recovery marker owner changed', {
+            targetSessionId: journal.targetSessionId,
+          });
+          continue;
+        }
+        args.assertGenerationOpen?.();
+        const removed = await worktreeService.removePreparedUserWorktree(
+          journal.slug,
+          journal.markerCreated || markerOwner === journal.targetSessionId
+            ? journal.targetSessionId
+            : null,
+          journal.baseCommit,
+          async () => {
+            journal = await updateBranchWorktreeJournal(
+              journalPath,
+              journal,
+              'worktree-removed',
+            );
+            args.assertGenerationOpen?.();
+          },
+        );
+        if (!removed.success) {
+          args.warn?.('branch worktree recovery refused cleanup', {
+            targetSessionId: journal.targetSessionId,
+            error: removed.error,
+          });
+          continue;
+        }
+        journal = await updateBranchWorktreeJournal(
+          journalPath,
+          journal,
+          removed.branchPreserved ? 'branch-preserved' : 'branch-deleted',
+        );
+      } else {
+        const registered = await worktreeService
+          .isPreparedUserWorktreeRegistered(journal.slug)
+          .catch(() => undefined);
+        if (registered !== false) {
+          args.warn?.('branch worktree registry state remains unknown', {
+            targetSessionId: journal.targetSessionId,
+          });
+          continue;
+        }
+        journal = await updateBranchWorktreeJournal(
+          journalPath,
+          journal,
+          'worktree-removed',
+        );
+        args.assertGenerationOpen?.();
+        const finalized =
+          await worktreeService.finalizePreparedUserWorktreeBranch(
+            journal.slug,
+            journal.baseCommit,
+          );
+        if (!finalized.success) {
+          args.warn?.('branch worktree recovery could not finalize branch', {
+            targetSessionId: journal.targetSessionId,
+            error: finalized.error,
+          });
+          continue;
+        }
+        journal = await updateBranchWorktreeJournal(
+          journalPath,
+          journal,
+          finalized.branchPreserved ? 'branch-preserved' : 'branch-deleted',
+        );
+        if (finalized.branchPreserved) {
+          args.warn?.('branch worktree recovery preserved branch', {
+            targetSessionId: journal.targetSessionId,
+            branch: journal.worktreeBranch,
+          });
+        }
+      }
+      await clearTerminalMetadata(journalPath, journal, args.warn);
+    }
+  })().finally(() => {
+    recoveryByChatsDir.delete(chatsDir);
+  });
+  recoveryByChatsDir.set(chatsDir, recovery);
+  return recovery;
+}
+
+function isWithinRoot(candidate: string, root: string): boolean {
+  const relative = path.relative(root, candidate);
+  return (
+    relative === '' ||
+    (!relative.startsWith('..') && !path.isAbsolute(relative))
+  );
+}
+
+async function resolveGitCommonDir(cwd: string): Promise<string | null> {
+  try {
+    const { stdout } = await execFileAsync(
+      'git',
+      ['rev-parse', '--git-common-dir'],
+      { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 },
+    );
+    return await fs.realpath(path.resolve(cwd, stdout.trim()));
+  } catch {
+    return null;
+  }
+}
+
+export async function resolveBranchWorktreeBaseCheckout(args: {
+  workspaceCwd: string;
+  sessionId: string;
+  snapshot: BridgeSessionExecutionSnapshot;
+  sidecarPath: string;
+}): Promise<BranchWorktreeBaseCheckout | null> {
+  const workspaceCwd = await fs.realpath(args.workspaceCwd).catch(() => null);
+  const snapshotWorkspace = await fs
+    .realpath(args.snapshot.workspaceCwd)
+    .catch(() => null);
+  const effectiveCwd = await fs
+    .realpath(args.snapshot.effectiveCwd)
+    .catch(() => null);
+  if (
+    workspaceCwd === null ||
+    snapshotWorkspace !== workspaceCwd ||
+    effectiveCwd === null
+  ) {
+    return null;
+  }
+
+  const workspaceGit = new GitWorktreeService(workspaceCwd);
+  if (!(await workspaceGit.isGitRepository())) return null;
+  const repoTop = await workspaceGit.getRepoTopLevel().catch(() => null);
+  if (repoTop === null) return null;
+  const canonicalRepoTop = await fs.realpath(repoTop).catch(() => null);
+  if (canonicalRepoTop === null) return null;
+
+  const effectiveGit = new GitWorktreeService(effectiveCwd);
+  if (!(await effectiveGit.isGitRepository())) return null;
+  const checkoutTop = await effectiveGit.getRepoTopLevel().catch(() => null);
+  if (checkoutTop === null) return null;
+  const canonicalCheckoutTop = await fs.realpath(checkoutTop).catch(() => null);
+  if (canonicalCheckoutTop === null) return null;
+
+  if (canonicalCheckoutTop !== canonicalRepoTop) {
+    const [workspaceCommonDir, checkoutCommonDir] = await Promise.all([
+      resolveGitCommonDir(canonicalRepoTop),
+      resolveGitCommonDir(canonicalCheckoutTop),
+    ]);
+    const sidecar = await readWorktreeSession(args.sidecarPath).catch(
+      () => null,
+    );
+    const sidecarPath = sidecar
+      ? await fs.realpath(sidecar.worktreePath).catch(() => null)
+      : null;
+    const snapshotPath = args.snapshot.worktree
+      ? await fs.realpath(args.snapshot.worktree.path).catch(() => null)
+      : null;
+    const managedRoot = path.join(canonicalRepoTop, '.qwen', 'worktrees');
+    const markerOwner = await readWorktreeSessionMarker(canonicalCheckoutTop);
+    if (
+      workspaceCommonDir === null ||
+      checkoutCommonDir !== workspaceCommonDir ||
+      sidecar === null ||
+      sidecarPath !== canonicalCheckoutTop ||
+      snapshotPath !== canonicalCheckoutTop ||
+      markerOwner !== args.sessionId ||
+      !isWithinRoot(canonicalCheckoutTop, managedRoot)
+    ) {
+      return null;
+    }
+  } else if (!isWithinRoot(effectiveCwd, canonicalRepoTop)) {
+    return null;
+  }
+
+  const headCommit = await getHeadCommit(canonicalCheckoutTop);
+  if (!headCommit) return null;
+  const branch = await effectiveGit.getCurrentBranch().catch(() => 'HEAD');
+  return {
+    repoTop: canonicalRepoTop,
+    checkoutCwd: canonicalCheckoutTop,
+    headCommit,
+    branch: branch || 'HEAD',
+  };
+}
+
+export async function isBranchWorktreeCreationSupported(
+  base: BranchWorktreeBaseCheckout,
+): Promise<boolean> {
+  const qwenDir = path.join(base.repoTop, '.qwen');
+  try {
+    let writableTarget = base.repoTop;
+    for (const candidate of [qwenDir, path.join(qwenDir, 'worktrees')]) {
+      const stat = await fs
+        .lstat(candidate)
+        .catch((error: NodeJS.ErrnoException) => {
+          if (error.code === 'ENOENT') return null;
+          throw error;
+        });
+      if (stat === null) break;
+      if (!stat.isDirectory()) return false;
+      writableTarget = candidate;
+    }
+    await fs.access(writableTarget, 2);
+    const [, trackedMarker] = await Promise.all([
+      execFileAsync('git', ['worktree', 'list', '--porcelain'], {
```

> **[Critical]** R6-1: [certifies-falsely] [new-surface] Re-checked at the current head (a3c7b7fc): still stands (family head). Every git spawn this new file adds passes no env option — git worktree list --porcelain and git ls-tree in isBranchWorktreeCreationSupported, plus the async resolveGitCommonDir — so inherited GIT*DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_CONFIG*_ redirect them to a different repository, the exact hazard the codebase's own gitEnv() exists to strip (core utils/git-branches.ts documents 'Repository-shifting variables that a daemon process may inherit from its launch environment'). A daemon launched from a shell exporting GIT*DIR (a hook runner, an IDE launcher) probes the foreign repository's worktree list and certifies a wrong checkout as a valid branch base. Route every new spawn through gitEnv(); the fix must clear the full GIT_ENV_VARS_TO_CLEAR set (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_CONFIG*_), not just GIT_DIR.
>
> Witness:
>
> ```
> witness: not run at this site — the family's site-2 probe (round 9, workspace-route-runtime.ts) demonstrated the redirect on the identical spawn shape: clean env authorizes the managed worktree, GIT_DIR pointed at a decoy repo flips the identical request to null, sanitized env flips it back to authorized
> ```
>
> <details>
> <summary>中文说明</summary>
>
> 【Critical】R6-1：已在当前 head（a3c7b7fc）复查：仍然存在（该缺陷族的族首）。这个新文件中的每一处 git 派生进程都不传 env 选项——isBranchWorktreeCreationSupported 里的 git worktree list --porcelain 与 git ls-tree，以及异步的 resolveGitCommonDir——因此继承到的 GIT*DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_CONFIG*_ 会把它们重定向到另一个仓库，这正是代码库自己的 gitEnv() 存在的原因所要清除的危害（core utils/git-branches.ts 记录了「daemon 进程可能从启动环境继承的仓库偏移变量」）。从一个导出了 GIT*DIR 的 shell 启动的 daemon（hook 运行器、IDE 启动器）会探测到外部仓库的 worktree 列表，并把错误的 checkout 认证为合法的分支基线。建议让所有新派生进程经过 gitEnv()；修复必须清除完整的 GIT_ENV_VARS_TO_CLEAR 集合（GIT_DIR、GIT_WORK_TREE、GIT_COMMON_DIR、GIT_INDEX_FILE、GIT_CONFIG*_），而不仅是 GIT_DIR。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.3)_

### 21. Marker exclude 写入可被 GIT_DIR 重定向到其他仓库

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3888412736
- 结论：值得修复
- 理由：ensureWorktreeSessionMarkerExcluded 使用未净化的 simple-git 解析 common dir，继承环境可造成跨仓库 info/exclude 写入。
- 建议修复：为 marker exclude common-dir 探测的 simple-git 客户端应用完整 gitEnv，并验证规则只落入目标仓库。
- 实施状态：已修复并验证
- 修复批次：F11
- 实施证据：`ensureWorktreeSessionMarkerExcluded` 的 common-dir 探测通过 `gitEnv()` 隔离仓库重定向变量；`gitEnv` 同时剔除 simple-git 会拒绝的 editor/pager 变量。在 decoy `GIT_DIR` 下，`/.qwen-session` 只写入 owning repo，marker 文件 15 项与 gitEnv 目标测试通过。

原始评论：

标注位置：`packages/core/src/services/gitWorktreeService.ts:77`（RIGHT（新增侧））

```diff
@@ -33,33 +34,47 @@ export function worktreeBranchForSlug(slug: string): string {
 /**
  * Filename of the in-worktree session marker. Created at worktree
  * provisioning time and consulted by `exit_worktree` to decide
- * whether the current session is allowed to drop the worktree. The
- * file lives outside the working tree (it is .gitignored as part of
- * `.qwen/worktrees/.gitignore`) so it cannot leak into commits.
+ * whether the current session is allowed to drop the worktree. Marker
+ * writers add it to the repository's `info/exclude` so it does not
+ * leak into commits from the linked worktree.
  */
 export const WORKTREE_SESSION_FILE = '.qwen-session';
+const WORKTREE_SESSION_MARKER_MAX_BYTES = 256;

-/** Writes the owning session id into the worktree's session marker. */
-export async function writeWorktreeSessionMarker(
+export class WorktreeSessionMarkerOwnerChangedError extends Error {
+  constructor() {
+    super('Worktree session marker owner changed');
+    this.name = 'WorktreeSessionMarkerOwnerChangedError';
+  }
+}
+
+async function fsyncDirectory(directory: string): Promise<void> {
+  try {
+    const handle = await fs.open(directory, 'r');
+    try {
+      await handle.sync();
+    } finally {
+      await handle.close();
+    }
+  } catch (error) {
+    if (process.platform !== 'win32') throw error;
+  }
+}
+
+export async function ensureWorktreeSessionMarkerExcluded(
   worktreePath: string,
-  sessionId: string,
 ): Promise<void> {
-  await fs.writeFile(
-    path.join(worktreePath, WORKTREE_SESSION_FILE),
-    sessionId,
-    'utf8',
-  );
   // The marker lives inside the worktree dir so a subagent running
   // `git add -A` inside it would otherwise add the session id to its
   // first commit. Write a `.git/info/exclude` rule so the marker is
   // ignored without requiring (or modifying) a tracked `.gitignore`.
-  // `.git` inside a worktree is actually a file pointing at
-  // `<repo>/.git/worktrees/<name>/`, so resolve `--git-dir` instead
-  // of joining naively.
+  // Linked worktrees use a per-worktree git dir, but Git reads the shared
+  // repository's info/exclude. Resolve `--git-common-dir` instead of joining
+  // `.git` naively.
   try {
     const { simpleGit } = await loadSimpleGit();
     const wtGit = simpleGit(worktreePath);
-    const gitDir = (await wtGit.revparse(['--git-dir'])).trim();
+    const gitDir = (await wtGit.revparse(['--git-common-dir'])).trim();
```

> **[Critical]** R7-8: [certifies-falsely] [new-surface] Re-checked at the current head (a3c7b7fc): still stands (site 4 of 4 — ensureWorktreeSessionMarkerExcluded's revparse). The marker-exclude write resolves the common dir through simpleGit(worktreePath).revparse(['--git-common-dir']) with no env sanitization — simple-git is loaded bare and configures no env. With GIT_DIR inherited, gitDir is the foreign repository's common dir, and the function then writes the /.qwen-session exclude rule into that foreign repository's info/exclude (a cross-repository write), while the real worktree's repository receives no rule — the marker stays stageable by git add -A, defeating the function's stated purpose. Sanitize the spawn env (gitEnv()) when resolving the common dir for the exclude write; the fix must clear the full GIT_ENV_VARS_TO_CLEAR set (packages/core/src/utils/git-branches.ts), not just GIT_DIR.
>
> Witness:
>
> ```
> witness: not run — traced at HEAD (simple-git loaded bare, no env configuration); same env-redirect class as the round-9 R7-6 site probe, which flipped a managed-worktree authorization under a GIT_DIR decoy
> ```
>
> <details>
> <summary>中文说明</summary>
>
> 【Critical】R7-8：已在当前 head（a3c7b7fc）复查：仍然存在（第 4 处——ensureWorktreeSessionMarkerExcluded 的 revparse）。标记排除规则的写入通过 simpleGit(worktreePath).revparse(['--git-common-dir']) 解析 common dir，没有任何 env 净化——simple-git 是裸加载的，不配置任何 env。在继承了 GIT_DIR 的情况下，gitDir 是外部仓库的 common dir，函数随后把 /.qwen-session 排除规则写入那个外部仓库的 info/exclude（一次跨仓库写入），而真正 worktree 所在的仓库拿不到任何规则——标记仍可被 git add -A 暂存，与该函数声明的目的背道而驰。建议在解析 common dir 用于排除规则写入时净化派生进程 env（gitEnv()）；修复必须清除完整的 GIT_ENV_VARS_TO_CLEAR 集合（packages/core/src/utils/git-branches.ts），而不仅是 GIT_DIR。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.3)_

### 22. Owner-preserving marker 修复未同步旧 round-trip 测试

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3888412741
- 结论：值得修复
- 理由：生产代码已改为拒绝 foreign owner，但 exit-worktree 旧测试仍要求盲覆写，导致 core suite 确定性失败。
- 建议修复：更新测试分别固定 foreign-owner rejection 与 same-owner idempotent path。
- 实施状态：已修复并验证
- 修复批次：F12
- 实施证据：旧 round-trip 断言已改为验证 foreign owner 抛出 `WorktreeSessionMarkerOwnerChangedError`、same owner 幂等成功且 owner 不变；`exit-worktree.test.ts` 16/16 通过。

原始评论：

标注位置：`packages/core/src/services/gitWorktreeService.ts:111-113`（RIGHT（新增侧））

```diff
@@ -83,6 +98,119 @@ export async function writeWorktreeSessionMarker(
   }
 }

+/** Writes the owning session id into the worktree's session marker. */
+export async function writeWorktreeSessionMarker(
+  worktreePath: string,
+  sessionId: string,
+): Promise<void> {
+  const owner = await readWorktreeSessionMarker(worktreePath);
+  if (owner === sessionId) {
+    await ensureWorktreeSessionMarkerExcluded(worktreePath);
+    return;
+  }
+  if (owner !== null) {
+    throw new WorktreeSessionMarkerOwnerChangedError();
+  }
```

> **[Critical]** R2-2: (fix-induced) [fails-closed] [regression] Re-checked at the current head (a3c7b7fc): still stands. The round-7 fix — the owner-preserving guard replacing writeWorktreeSessionMarker's blind overwrite — closed the reported input but left the pre-existing exit-worktree.test.ts round-trip test asserting the old overwrite semantics, so packages/core is deterministically red at PR head. Ran it this round (scratch tree): 'marker also written by writeWorktreeSessionMarker survives round-trip' (exit-worktree.test.ts:299-304) fails with WorktreeSessionMarkerOwnerChangedError at gitWorktreeService.ts:112 — the test expects a blind rewrite; the merge base is green. Update the test to the new ownership semantics (expect the OwnerChanged throw for a foreign owner, and exercise the same-owner path separately). Fix witness: the updated test must go red if the owner guard is removed.
>
> Witness:
>
> ```
> npx vitest run src/tools/exit-worktree.test.ts -t 'marker also written by writeWorktreeSessionMarker survives round-trip'
> × marker also written by writeWorktreeSessionMarker survives round-trip
>   WorktreeSessionMarkerOwnerChangedError: Worktree session marker owner changed
>     ❯ writeWorktreeSessionMarker src/services/gitWorktreeService.ts:112
>     ❯ src/tools/exit-worktree.test.ts:304
> Test Files  1 failed (1)
> ```
>
> <details>
> <summary>中文说明</summary>
>
> 【Critical】R2-2：（修复引入）已在当前 head（a3c7b7fc）复查：仍然存在。第 7 轮的修复——用属主保护守卫替换 writeWorktreeSessionMarker 的盲目覆写——关闭了当初上报的入口，却把既有的 exit-worktree.test.ts 往返测试留在原地断言旧的覆写语义，导致 packages/core 在 PR head 上确定性地变红。本轮实际运行（scratch tree）：'marker also written by writeWorktreeSessionMarker survives round-trip'（exit-worktree.test.ts:299-304）在 gitWorktreeService.ts:112 处以 WorktreeSessionMarkerOwnerChangedError 失败——测试期望盲目覆写；merge base 是绿的。建议把测试更新为新的属主语义（对不同属主断言抛出 OwnerChanged，并单独覆盖同属主路径）。修复见证：移除属主守卫后，更新后的测试必须变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.3)_

### 23. BranchPicker status 请求漏传 owning session id

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3888412747
- 结论：值得修复
- 理由：worktree status 请求只传 cwd，daemon ownership resolver 因缺少 sessionId 返回 invalid_cwd，导致 status refresh 与后续 reconciliation 静默失效。
- 建议修复：fetchStatus 同时传 gitSessionId、更新依赖，并补 worktree status 请求断言。
- 实施状态：已修复并验证
- 修复批次：F13
- 实施证据：BranchPicker worktree status refresh 现在发送 `{ cwd, sessionId }`，callback 依赖同步包含 `gitSessionId`；`BranchPickerPopover.test.tsx` 29/29 通过并固定请求参数。

原始评论：

标注位置：`packages/web-shell/client/components/BranchPickerPopover.tsx:302`（RIGHT（新增侧））

```diff
@@ -295,7 +297,7 @@ export function BranchPickerPopover({
         setLoading(false);
       }
     }
-  }, [ws, gitCwd]);
+  }, [ws, gitCwd, gitSessionId]);

   const fetchStatus = useCallback(async () => {
```

> **[Critical]** R8-3: [fails-closed] [regression] Re-checked at the current head (a3c7b7fc): still stands. fetchStatus is the one git call site this PR did not bind to a session: it calls workspaceGit({cwd: gitCwd}) without gitSessionId, and the daemon now rejects a managed-worktree cwd that carries no valid session id (workspace-route-runtime.ts:548 — parsedSessionId.kind !== 'valid' returns null, and the route answers 400 invalid_cwd). So in a worktree session — this PR's headline path — every popover status fetch 400s and the catch swallows it: liveStatus never populates, onStatusRefreshed never fires, and post-checkout/push/pull reconciliation silently stops. Pre-PR the same call returned 200 via the lenient fallback. Pass sessionId: gitSessionId in the fetchStatus workspaceGit call and add gitSessionId to the useCallback deps. Fix constraint: workspace-route-runtime.ts:548-549 — a cwd under <repoTop>/.qwen/worktrees 400s invalid_cwd without a valid sessionId, so gitSessionId must accompany any worktree gitCwd. Fix witness: mount with a worktree cwd and gitSessionId, open the popover, and assert workspaceGit was called with {cwd, sessionId}; removing the fix must turn it red.
>
> Witness:
>
> ```
> probe (jsdom, unmodified PR, worktree session):
> workspaceGitBranches called with ('/repo/.qwen/worktrees/test', 'session-1')
> workspaceGit called with ({ cwd: '/repo/.qwen/worktrees/test' }) — 'sessionId' in call === false
> FIX (add sessionId to fetchStatus): workspaceGit call now carries "sessionId": "session-1"
> ```
>
> <details>
> <summary>中文说明</summary>
>
> 【Critical】R8-3：已在当前 head（a3c7b7fc）复查：仍然存在。fetchStatus 是本 PR 中唯一没有绑定会话的 git 调用点：它调用 workspaceGit({cwd: gitCwd}) 时不带 gitSessionId，而 daemon 现在会拒绝不带有效会话 id 的受管 worktree cwd（workspace-route-runtime.ts:548——parsedSessionId.kind !== 'valid' 返回 null，路由回应 400 invalid_cwd）。因此在 worktree 会话中——本 PR 的招牌路径——每次打开弹层的 status 请求都会 400，且被 catch 吞掉：liveStatus 永远不会填充，onStatusRefreshed 永远不会触发，checkout/push/pull 之后的状态同步会静默停止。PR 之前同一调用通过宽松兜底返回 200。建议在 fetchStatus 的 workspaceGit 调用中传入 sessionId: gitSessionId，并把 gitSessionId 加入 useCallback 依赖。修复约束：workspace-route-runtime.ts:548-549——<repoTop>/.qwen/worktrees 下的 cwd 若无有效 sessionId 会 400 invalid_cwd，因此任何 worktree gitCwd 都必须伴随 gitSessionId。修复见证：以 worktree cwd 和 gitSessionId 挂载、打开弹层并断言 workspaceGit 被以 {cwd, sessionId} 调用；移除修复后该测试应变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.3)_

### 24. 路径包含谓词误拒绝以双点开头的合法目录段

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/10226#discussion_r3888412752
- 结论：值得修复
- 理由：relative.startsWith("..") 会把 ...、..cache 等合法段误判为逃逸，与同文件已使用的 house isWithinRoot 语义冲突。
- 建议修复：删除私有谓词并复用 isWithinRoot；补合法双点前缀目录与真实逃逸控制测试。
- 实施状态：已修复并验证
- 修复批次：F14
- 实施证据：删除私有 `pathIsWithin` 并统一复用 house `isWithinRoot`；新增 `...` 与 `..cache` 合法目录段回归，既有外部逃逸负例继续通过，workspace runtime 文件 35/35 通过。

原始评论：

标注位置：`packages/cli/src/serve/workspace-route-runtime.ts:409`（RIGHT（新增侧））

```diff
@@ -400,3 +405,238 @@ export function resolveContainedCwdOrFail(
   }
   return null;
 }
+
+function pathIsWithin(candidate: string, root: string): boolean {
```

> **[Critical]** R9-1: [fails-closed] [regression] New this round (probe-verified). pathIsWithin uses relative.startsWith('..'), which misclassifies any segment merely beginning with two dots ('...', '..cache', '..build') as a root escape — diverging from the house predicate isWithinRoot in config/path-comparison.ts, which this same file imports and uses in resolveContainedCwdOrFail twenty lines above. A workspace or managed worktree under a directory whose name starts with '..' (legal on Linux) is a legitimately contained cwd: path.relative('/repo', '/repo/.../sub') is '.../sub' and startsWith('..') is true, so every arm of resolveSessionManagedGitCwd returns false and all five git route files answer 400 invalid_cwd for it, while the isWithinRoot-based resolver in this same file accepts the identical path. The merge base accepted these cwds on these exact routes (they swapped from resolveContainedCwdOrFail to this resolver in this diff), so the rejection is a regression this PR introduces — fail-closed (real escapes are still rejected, probe-verified) but breaking legitimate paths. Delete pathIsWithin and call the already-imported isWithinRoot(candidate, root) at its call sites. Fix witness: add a resolver test accepting a cwd under a '...'-named subdirectory of the workspace; it is red while startsWith('..') stands.
>
> Witness:
>
> ```
> probe (Node, both predicates copied verbatim from source):
> relative: ".../sub" startsWith(".."): true
> pathIsWithin('/repo/.../sub', '/repo'): false   isWithinRoot('/repo/.../sub', '/repo'): true
> pathIsWithin('/repo/..cache/x', '/repo'): false   isWithinRoot('/repo/..cache/x', '/repo'): true
> pathIsWithin('/other/x', '/repo'): false          isWithinRoot('/other/x', '/repo'): false  ← real escapes still rejected
> ```
>
> <details>
> <summary>中文说明</summary>
>
> 【Critical】R9-1：本轮新发现（探测验证）。pathIsWithin 使用 relative.startsWith('..')，会把任何仅仅以两个点开头的段（'...'、'..cache'、'..build'）误判为根逃逸——与同文件已导入并在上方二十行 resolveContainedCwdOrFail 中使用的 house 谓词 isWithinRoot（config/path-comparison.ts）相悖。位于以 '..' 开头的目录（在 Linux 上合法）之下的工作区或受管 worktree 是合法包含的 cwd：path.relative('/repo', '/repo/.../sub') 是 '.../sub' 且 startsWith('..') 为 true，于是 resolveSessionManagedGitCwd 的每个分支都返回 false，五个 git 路由文件对它一律回应 400 invalid_cwd，而同文件中基于 isWithinRoot 的解析器接受同一路径。merge base 上这些路由正是接受这类 cwd 的（本 diff 把它们从 resolveContainedCwdOrFail 换成了这个解析器），因此该拒绝是本 PR 引入的回归——虽然失败方向是保守的（真正的逃逸仍被拒绝，已探测验证），但会破坏合法路径。建议删除 pathIsWithin，在各调用点改用已导入的 isWithinRoot(candidate, root)。修复见证：新增一个接受 '...' 命名子目录下 cwd 的解析器测试；只要 startsWith('..') 还在，该测试就是红的。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.3)_

## 实施摘要

- 已修复并验证：23
- 待实施：0
- 已修复待验证：0
- 无需修改：1
- 需要维护者判断：0
- 受阻：0

## 实施批次

### F1. 确定性测试失败

- 对应评论：3、8
- 修改：修正 reserved target title 与 BranchPicker 三参数断言，并补 owning session id 覆盖。
- 验证：ACP 目标用例通过；Web Shell 相关三文件 581/581 通过。
- 状态：已修复并验证

### F2. Durable 文件读取与 resolver 错误分型

- 对应评论：2、4、12
- 修改：在 sync/async durable 读取点统一落实 bounded/no-follow/inode identity 条件；区分 ownership 拒绝与内部 I/O/parse error。
- 验证：core durable/marker 40/40；CLI journal、oversized、malformed route 目标用例通过。
- 状态：已修复并验证

### F3. Worktree route 授权、redaction 与 restore identity

- 对应评论：5、6、14、16
- 修改：补 201 redaction；Git probe fail-closed；钉住 worktree git metadata/back-pointer；case-variant restore 使用 persisted id。
- 验证：workspace resolver 五个目标用例与 server route 的 redaction/case-variant 用例通过。
- 状态：已修复并验证

### F4. Startup adoption 错误传播与三态 liveness

- 对应评论：7、15
- 修改：confirmed active 通过 typed error 终止 startup；unknown owner 告警后 adoption；删除调用继续把 unknown 当 active；非 ownership marker failure 仍写 sidecar。
- 验证：`persistStartupWorktreeSidecar` 七个目标用例通过，覆盖 missing/foreign/dead/active/same-owner/non-ownership failure。
- 状态：已修复并验证

### F5. Destructive recovery 安全边界

- 对应评论：11、13
- 修改：增加 live cwd occupancy 与 uninitialized submodule content gate。
- 验证：recovery journal 目标用例、真实 gitlink 用户文件存活测试通过。
- 状态：已修复并验证

### F6. Branch dialog ownership race

- 对应评论：9
- 修改：按 dialog 对象 identity 管理 finally cleanup 与 busy state。
- 验证：A 请求 pending、B dialog 重开、A settle 后 B 仍存在的测试通过；App 全文件测试 551/551。
- 状态：已修复并验证

### F7. Legacy marker writer hardening

- 对应评论：10
- 修改：legacy writer 迁移到 strict create/expected-owner CAS，拒绝 symlink 与无条件覆盖。
- 验证：`git-worktree-marker.test.ts` 14/14 通过。
- 状态：已修复并验证

### F8. Empty-session settled failure

- 对应评论：1
- 修改：增加明确 typed pre-commit failure、HTTP 404 分类并安全回滚准备资源。
- 验证：ACP mapping 与 worktree route empty-source cleanup 用例通过。
- 状态：已修复并验证

### F9. Re-owned worktree 恢复身份

- 对应评论：18
- 修改：恢复提示、ACP/headless/TUI 调用方与 daemon 列表富集均交叉检查 marker owner；不匹配时不暴露 worktree，恢复路径同时清理旧 sidecar。
- 验证：Core restore、ACP、headless resume 与 server list 目标用例通过。
- 状态：已修复并验证

### F10. Ephemeral agent slug 路由隔离

- 对应评论：19
- 修改：两个用户 worktree 创建路由拒绝 canonical `agent-<7hex>` slug，不改变内部 ephemeral agent 生成路径。
- 验证：普通 session 两个 slug 负例与 branch-session agent slug 负例通过。
- 状态：已修复并验证

### F11. Git 子进程环境隔离

- 对应评论：20、21
- 修改：branch worktree resolver/preflight 的三个新增 Git spawn 与 marker exclude common-dir 探测均应用 `gitEnv()`；补齐 simple-git 显式环境所需的 editor/pager 清理。
- 验证：decoy repository 回归、branch preparation 13/13、marker 15/15 与 gitEnv 目标测试通过。
- 状态：已修复并验证

### F12. Marker owner 测试契约

- 对应评论：22
- 修改：旧 blind-overwrite 测试改为 foreign-owner rejection 与 same-owner idempotence。
- 验证：`exit-worktree.test.ts` 16/16 通过。
- 状态：已修复并验证

### F13. BranchPicker worktree status ownership

- 对应评论：23
- 修改：worktree status refresh 同时传递 owning session id，并把它纳入 callback 依赖。
- 验证：`BranchPickerPopover.test.tsx` 29/29 通过。
- 状态：已修复并验证

### F14. Workspace 路径包含语义

- 对应评论：24
- 修改：删除误用 `startsWith('..')` 的私有谓词，统一复用 house `isWithinRoot`。
- 验证：`...`、`..cache` 合法目录与真实逃逸控制均通过；workspace runtime 35/35 通过。
- 状态：已修复并验证

## 验证与剩余外部状态

- `npm install` 补齐合入 main 后 lockfile 已声明但共享 `node_modules` 缺失的 `@tanstack/react-table`；安装触发的完整 prepare/build 通过，lockfile 安装噪声已移除。
- 根 `npm run typecheck`：通过，包含所有 workspace 与 integration typecheck。
- 变更文件 ESLint 与 `git diff --check`：通过。
- Core 最终目标集：4 个文件，31 项通过；另有 marker 15/15、exit-worktree 16/16 的完整文件运行。
- CLI 最终目标集：5 个文件，20 项通过，覆盖 ACP、headless resume、branch preparation、workspace runtime 与 server routes。
- Web Shell：`BranchPickerPopover.test.tsx` 29/29 通过。
- main 合入内容的 CLI 文本/图片渲染相关测试共 97 项通过。
- 交付前再次确认 GitHub head `a3c7b7fc409524a073a3ea6fe25ae53da68ee282`、base `413b6d15d3d7bb17e22b05e07b008efb1cb7f43e` 均未变化，没有 head race；PR 仍为 `CHANGES_REQUESTED`，现有远端失败检查属于该评估基线。

## Stash 恢复结果

- 本轮 stash `3591f8c32f85596f4e3508af6abd4068dd718dae` 已成功 apply 并审计后删除。
- stash 恢复后 `.gitignore` 保持原 unstaged 语义，评估报告直至交付阶段保持 untracked；没有未合并路径。
