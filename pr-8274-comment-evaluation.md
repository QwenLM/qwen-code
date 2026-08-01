# PR 8274 Comment Evaluation

Source: https://github.com/QwenLM/qwen-code/pull/8274
Generated: 2026-08-01
Reviewed head: `ed32544c6124ea473b6835a39f1c2ce8c4eba0b5`

## Summary

- Worth fixing: 9
- Not worth fixing: 10
- Needs maintainer judgment: 2
- Informational bot comments excluded: lifecycle completion, duplicate triage summaries, and the successful Serve A/B report

The counts are per independently actionable finding, not per GitHub comment. PR conversation currently has no inline review threads; the substantive human review is one consolidated comment.

## Resolution Status

- Implemented all nine worthwhile items, including the two documentation-only clarifications and the Web Shell visual scenario.
- Changed both PR references from `Closes #8271` to `Refs #8271` so Part 2 remains open.
- Verified 270 Core tests, 474 Session tests, 360 ACP Agent tests, 492 Web Shell tests, and two Chromium visual cases.
- The combined CLI run passed 1,681 of 1,684 tests; its three unrelated serve tests failed under concurrent load and each passed when rerun independently.
- Targeted ESLint, repository build, repository typecheck, and `git diff --check` pass.

## Findings

### 1. Missing file-history backups make ordinary branches fail

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Worth fixing
- Reason: The existing housekeeping job removes old per-session backup directories by mtime while transcripts remain. The branch path still reads retained snapshot records, so treating an already-missing backup as fatal regresses the pre-PR latest-state branch behavior.
- Fix: Warn and omit backups that are already missing or no longer regular files, rewrite the creation manifest to the names actually staged, and continue publishing the branch. Access or copy failure for an existing regular file remains fatal and leaves no visible session.
- Tests: Add separate regression cases for a missing backup that degrades successfully and an existing backup whose copy fails atomically.

### 2. Checkpoint recording failure retroactively fails a completed turn

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Worth fixing
- Reason: The Assistant response has already streamed successfully before the optional checkpoint transaction runs. Letting a recorder error escape converts that completed response into a turn error and skips success-path work unrelated to branching.
- Fix: Catch and log checkpoint transaction failures, return the original completed result without branch metadata, and continue normal post-turn work.
- Tests: Assert a rejected checkpoint transaction still returns `end_turn`.

### 3. Full transcript re-read while holding the topology fence

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Needs maintainer judgment
- Reason: The O(total transcript) read on each eligible completed turn is real, but a safe bounded-read or cache requires a new cursor/index ownership contract across restore, rewind, writer failure, and automatic metadata appends. No workload measurement establishes the threshold, and adding an unreviewed cache to this already-large core PR would increase correctness risk.
- Suggested follow-up: Benchmark long transcripts, then design an append-sequence or byte-offset cursor that can prove the frozen interval without reconstructing the whole file.

### 4. Repeated branch-point resolution rescans prefixes

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Worth fixing
- Reason: Each checkpoint currently slices and rescans the chain prefix. The resolver already validates unique record IDs, so it can index boundaries once and carry tool state forward once without changing the fail-closed semantics.
- Fix: Pre-index record UUIDs, capture pending-tool snapshots at checkpoint boundaries in one forward pass, and validate each turn interval without allocating prefix slices.

### 5. Synchronous branch GC in the service constructor

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Worth fixing
- Reason: Request-scoped service construction can synchronously recurse through stale staging directories and block the daemon event loop. Existing list and fork entry points already provide activity-triggered cleanup.
- Fix: Remove constructor GC and retain the hourly gate on list/fork operations.
- Test: Assert construction preserves stale staging until an active list operation runs GC.

### 6. Rewind waits behind the mutation queue without a queue-wait deadline

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Needs maintainer judgment
- Reason: Queueing is intentional in reviewed design v6 so branch, rewind, prompt, and close have deterministic ordering. Adding a timeout without cancellation can return an error while the queued rewind later executes; restoring fail-fast behavior changes the product contract. This needs an explicit product choice and a cancellable queue admission design rather than a local timeout wrapper.

### 7. Transcript commit uses a hard link

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Not worth fixing in this PR
- Reason: The hard link is the available Node filesystem primitive that is both atomic and no-clobber. Plain rename overwrites on POSIX, while exclusive copy exposes a partially written target. On an unsupported filesystem the branch fails before publication, which is safer than weakening the central visibility invariant.
- Follow-up condition: Revisit only if supported storage explicitly includes filesystems without hard-link support and a platform no-replace rename abstraction is available.

### 8. A committed branch remains after response delivery fails

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Worth fixing as documentation, not behavior
- Reason: This is the deliberate post-commit ownership rule in design v6: after the transcript becomes visible, transport cleanup may release only live state and must never delete the user's complete persisted session. Reverting to deletion would introduce cross-client data loss.
- Fix: Add a call-site comment explaining the commit boundary and persisted-session ownership. Keep the existing regression test and PR risk disclosure.

### 9. Fail-closed pending tool calls from the prefix

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Not worth fixing
- Reason: A fork containing unresolved provider tool calls can produce malformed model history. The prefix state is also required for trusted continuation, where the response that closes a tool call appears after the captured boundary. Keeping the pure resolver fail-closed is safer than authorizing a later checkpoint over malformed active history; replay logging would also be noisy and context-free.

### 10. Buffered side artifacts are reparented after the checkpoint

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Worth fixing as documentation
- Reason: Reparenting is intentional: side artifacts keep `updateActiveTail=false`, but must not become siblings of the reserved checkpoint. The reason is not obvious from the local assignment.
- Fix: Add a focused comment describing this topology invariant.

### 11. Legacy fallback Branch affordance

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdict: Not worth fixing
- Reason: The reviewed product contract intentionally shows historical Branch only when Core produced durable evidence. Restoring the old last-message fallback would make an unanchored latest-state branch look as though it branches from the clicked historical response. Legacy transcripts remain usable through the existing session-level latest-state branch path.

### 12. UI and transport nits

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdicts:
  - Fresh `AbortController().signal`: Not worth fixing. The reload is scoped to the stale-action handler and has no longer-lived owner that could meaningfully cancel it.
  - Pending-state reset after unmount: Not worth fixing. React 18 safely ignores it; a mounted-ref lifecycle adds more state for no observed defect.
  - Conditional `atRecordId` spread: Not worth fixing. `JSON.stringify` omits `undefined`; this is style-only.
  - Duplicated UUID regex: Not worth fixing. The packages intentionally do not share relative internals across package boundaries, and the pattern accepts RFC-4122 versions 1–5 rather than only v4.
  - Owner-token validation through the safe filename pattern: Not worth fixing. It enforces the required path-safe token shape; changing it is readability-only.
  - Static GC timestamp map: Not worth fixing. It stores one small timestamp per workspace touched during the daemon process lifetime; no practical unbounded allocation path was shown.
  - Housekeeping deleting live staging: Not worth fixing. Retention is clamped to at least one hour and a normal fork is short-lived; changing the global cleanup protocol for a hypothetical hour-long fork is disproportionate.

### 13. Test gaps

- Comment source: wenshao, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149919667
- Verdicts:
  - Missing backup regression: Worth fixing; added.
  - Checkpoint rejection preserving `end_turn`: Worth fixing; added.
  - Interleaved prompt/close/branch: Not worth adding another overlapping test. Bridge tests already pin branch/rewind FIFO and reject queued branch after close begins, while the Agent test proves close cannot finalize the recorder during a branch mutation.

### 14. Issue closing scope

- Comment source: qwen-code-ci-bot and wenshao, conversation
- Verdict: Worth fixing
- Reason: The PR implements Part 1 of #8271, while Part 2 worktree isolation remains open. `Closes #8271` would incorrectly close the whole issue.
- Fix: Change both English and Chinese PR sections to a non-closing `Refs #8271` reference.

### 15. Behavioural proof request

- Comment source: qwen-code-ci-bot and wenshao, conversation
- Verdict: Worth fixing
- Reason: Historical truncation and stale-checkpoint rejection are the central user-visible claims. Static review alone is insufficient.
- Fix: Run focused cross-layer tests locally and trigger the repository `@qwen-code /verify` workflow after pushing the fixes.

### 16. Web Shell visual scenario coverage

- Comment source: qwen-code-ci-bot, conversation, https://github.com/QwenLM/qwen-code/pull/8274#issuecomment-5149620840
- Verdict: Worth fixing
- Reason: The existing visual scenarios never seed branch metadata, so the workflow cannot render or compare the new action.
- Fix: Add a dark/light head-only scenario with two branchable Assistant responses, hover the earlier response, assert both Branch controls exist, and capture the result.
- Local evidence: Both Chromium visual cases pass after setting localhost `NO_PROXY`.

## Original Comments

### Maintainer review by wenshao

> ## Review — `feat: fork from any conversation`
>
> Reviewed the full diff (48 files, +4236/−450) plus surrounding code in this checkout.
>
> ### Overview
>
> The PR replaces "branch from latest session state" with a durable, replayable branch point:
>
> - **Core** — a new `system`/`branch_checkpoint` record written at `end_turn` inside a _topology fence_ that buffers concurrent metadata writers, so the checkpoint is guaranteed to be the immediate child of the turn's last record. `branch-points.ts` is the single resolver used by the recorder, the transcript reader, and fork validation.
> - **Transport** — the checkpoint rides the turn-complete `_meta` through bridge → SDK → webui → web-shell; historical turns get it from `branchPointsByAssistantUuid` on the transcript page and via replay `_meta`.
> - **Persistence** — `forkSession` gained an `atRecordId`/`title` path and a claim + staging + link-commit protocol so a partially-built branch is never discoverable, plus an activity-triggered GC for abandoned staging.
> - **Concurrency** — a per-session `runExclusiveHistoryMutation` mutex in `QwenAgent` now serializes prompt / close / rewind / branch / cron / notification turns; rewind additionally chains onto `entry.promptQueue`.
> - **UI** — the Branch affordance moves from "last completed assistant" to "any assistant block carrying a `branchRecordId`", with a pending state and a 409 stale-checkpoint path that refreshes the transcript.
>
> The layering is clean and the single-resolver decision is the right call — recording, replay, reader, and validation all agreeing removes a whole class of drift. Design doc is thorough. Test coverage is genuinely broad (contract tests at every layer plus concurrency cases).
>
> Findings below, ordered by severity.
>
> ---
>
> ### High
>
> **1. Branching now hard-fails when a referenced file-history backup is gone.**
> `copyFileHistoryBackupsToStaging` throws `Missing file-history backup: ${name}` when a referenced backup is not a regular file, and that propagates out of `forkSession`. The previous `copyFileHistoryBackups` logged a warning per failed entry and let the fork succeed.
>
> This is reachable on the ordinary "branch from latest" path, not just the historical one: `cleanupOldFileHistoryBackups` sweeps `<globalQwenDir>/file-history/<sessionId>/` purely by directory mtime, while the transcript with its `file_history_snapshot` records lives on indefinitely. Any session older than the cleanup period therefore has snapshot records pointing at deleted backups — and branching it now fails outright instead of producing a branch without rewind material.
>
> Suggest treating a missing backup as a warning (skip the name, keep it out of the manifest) and reserving the throw for cases where the file exists but cannot be linked/copied.
>
> **2. A checkpoint write failure turns a completed turn into a failed turn.**
> In `Session.prompt`, `recordBranchCheckpointTransaction` is awaited inside the main `try`, before `releasePendingSend()`. It can throw in several ways:
>
> - `this.writeFailure` rethrown (set by an earlier async write failure)
> - `SessionWriterUnavailableError` when `state !== 'active'`
> - `appendRecordStrict` rejecting
> - a plain `Error('Unable to load active transcript for session ...')` from `readActiveTranscriptChain` when `loadSession` returns `undefined`
>
> The first three are `SessionWriterError`s, so the existing catch converts them into a `RequestError` — the client gets a turn error for a turn whose response already streamed successfully. The fourth is a bare `Error` and escapes uncaught. In all cases the success-path work after it (`#maybeEmitFollowupSuggestion`, `#scheduleChannelDelivery`, the eager cron/notification drains) is skipped.
>
> The checkpoint is an optional convenience; it should never be able to fail the turn. Suggest wrapping the call in `try/catch`, logging, and falling back to `undefined` (no branch point) — which the whole downstream chain already handles.
>
> ---
>
> ### Medium
>
> **3. Full transcript re-read on every completed turn.**
> `recordBranchCheckpointTransaction` → `readActiveTranscriptChain()` → `flush()` + `loadSession()`, which `readAllRecords` + `reconstructHistory` over the _entire_ JSONL. That now runs once per `end_turn`, and it runs while the topology fence is blocking every other transcript writer. Cost scales with session size, so the longest sessions — exactly the ones where branching is most useful — pay the most per turn.
>
> Since the recorder already knows `lastRecordUuid` and the turn's start cursor, the candidate resolution only needs records from `startExclusiveRecordUuid` forward. A tail-bounded read (or caching the active chain across turns) would remove the O(session) per-turn cost.
>
> **4. `resolveBranchPoints` is O(n²) in active-chain length.**
> For each `branch_checkpoint` it calls `resolveCompletedTurnBranchCandidate` with `activeChain.slice(0, index)`, which allocates a fresh array and rescans from record 0. With one checkpoint per turn that is ~`turns × records` work per invocation. It is called from `SessionTranscriptReader` (memoized on the index — fine) and from `forkSession`, where `validateTargetBranchPoint()` runs it twice _and_ `reconstructHistory(forked)` runs twice on top of the initial source resolve. A single forward pass carrying per-turn pending-tool state would make this linear; at minimum, `validateTargetBranchPoint()` could be computed once and reused.
>
> **5. Synchronous filesystem GC in the `SessionService` constructor.**
> `maybeCleanupStaleBranchCreations()` runs `readdirSync` / `statSync` / `readFileSync` / `existsSync` / `rmSync({recursive})` on the constructor path. `SessionService` is constructed inside daemon request handling (`createWorkspaceRuntimeSessionService`), so this stalls the event loop — at most hourly per chats dir, but the recursive `rmSync` on a stale staging dir is unbounded in duration. Deferring to `setImmediate`/a microtask, or triggering GC only from `listSessions`/`forkSession` (which already call it) rather than from the constructor, would keep construction cheap.
>
> Related nit: `SessionService.branchGcLastRunAt` is a static `Map` keyed by chats dir with no eviction — bounded by workspace count, but it never shrinks.
>
> **6. Rewind changed from fail-fast to unbounded queueing.**
> `sessionRewind` now runs inside `entry.promptQueue.then(...)`. Previously a rewind during an active prompt surfaced `session_busy` promptly; now the request waits for the prompt to drain first. `withTimeout(initTimeoutMs, ...)` only wraps the ext-method call _after_ dequeue, so the queue wait itself is unbounded — an HTTP rewind can hang for the length of a long agentic turn. If the intent is to make rewind wait rather than fail, please confirm and consider bounding the queue wait so the client gets a deterministic error.
>
> **7. Transcript commit relies on hardlink support.**
> `fs.linkSync(stagedTranscriptPath, targetPath)` is the commit step. Hardlinks are unavailable on exFAT/FAT32 and some network/container mounts, so `forkSession` would fail there where the previous `writeFileSync` succeeded. The backup staging next to it already commits with `renameSync` — using `renameSync` for the transcript too would be atomic, portable, and would also make the staging cleanup a no-op instead of an unlink.
>
> **8. Aborted branches now leave a persisted session behind.**
> `routes/session.ts` swapped `deleteDaemonSessionIfOrphan(...)` for `killSession(..., { requireZeroAttaches: true })` on both the generation-guard and dead-socket paths, and the test now asserts `removeSpy` is never called. So when the response never reaches the client, a fully committed branch session stays in the user's session list — created by an action they saw fail. That is defensible under the new "never expose a partial session, never delete a complete one" model, but it is a user-visible behavior change that isn't called out in the PR description and isn't explained at the call site. Worth a comment either way.
>
> ---
>
> ### Low / nits
>
> - **Fail-closed prefix scan can permanently disable checkpoints.** `resolveCompletedTurnBranchCandidate` seeds `pendingCalls` from `activeChain.slice(0, startIndex + 1)` and bails if anything is still open at the end. A single `functionCall` anywhere earlier in the session that never received a matching `functionResponse` leaves a permanent resident in `pendingCalls`, so _every_ subsequent turn silently loses its checkpoint with no diagnostic. Restricting the pending set to the branch interval, or logging when the prefix is what blocked the candidate, would make this debuggable.
> - **`releaseTopologyFence` reparents side-artifact records.** It assigns `intent.record.parentUuid = this.lastRecordUuid` for every buffered append, including the `{ updateActiveTail: false }` writers (`recordSessionArtifactEvent` / `recordSessionArtifactSnapshot`) that deliberately do not advance the tail. Reparenting those onto the checkpoint changes side-chain topology. If that is intended (it looks like it is — it's the point of the fence), a one-line comment would save the next reader the trace.
> - **No fallback affordance when a checkpoint is absent.** `showAssistantBranch` is now strictly `branchRecordId !== undefined`, and the `lastCompletedAssistantId` fallback was deleted. For legacy transcripts, or any turn where the candidate resolver bails (see above), the message list has no Branch button at all — even though `forkSession` still supports branching from latest. Consider keeping the old fallback on the final completed assistant when no checkpoint exists.
> - **`new AbortController().signal`** in `App.tsx`'s stale-branch handler creates a signal that can never fire. If `reloadSession` is expected to be cancellable here, thread a real controller; otherwise a shared never-aborting constant makes the intent explicit.
> - **`setBranchPending(false)` in `finally`** (`AssistantMessage.tsx`) runs after a successful branch has likely unmounted the component. Harmless under React 18, but a mounted guard is worth it if that's the pattern elsewhere in this package.
> - **`DaemonClient.branchSession`** sends `atRecordId: req.atRecordId` unconditionally while `name` uses conditional spread. `JSON.stringify` drops `undefined`, so it works — just inconsistent with the line above it.
> - **Duplicated UUID regex.** The strict RFC-4122 pattern (`[1-5]` version, `[89ab]` variant) is inlined in both `bridge.ts` and `DaemonClient.ts`. Worth a shared constant; also note that any record whose uuid isn't strict v4 silently loses its branch point at the transport boundary.
> - **`parseBranchCreationManifest`** validates `ownerToken` via `SESSION_FILE_PATTERN.test(\`${ownerToken}.jsonl\`)`. It works, but reusing a filename pattern to validate a token reads as accidental; a direct UUID check would state the intent.
>
> ---
>
> ### Security
>
> No issues found. Specifically checked and satisfied:
>
> - `validatedBackupPath` rejects non-basename names and verifies the resolved parent, so manifest-driven names can't escape the backup directory.
> - `atRecordId` is only ever a map key / uuid comparison — it never reaches a path, a shell, or a query.
> - Claim, staging, and owner-marker files are created with `wx` and `0o600` / `0o700`, so no pre-existing-file hijack and no world-readable transcript staging.
> - The GC refuses to delete anything whose `.branch-owner` marker doesn't match the manifest, and re-reads the claim before removing it — the ambiguous cases are preserved rather than reclaimed.
>
> One operational note: staging directories are created under `<globalQwenDir>/file-history/` as `.<sessionId>.<token>.staging`, which `cleanupOldFileHistoryBackups` will sweep by mtime like any other child directory. Harmless for abandoned staging, but a housekeeping sweep landing during a very slow fork could delete the directory out from under it.
>
> ### Tests
>
> Coverage is strong and layered — `branch-points.test.ts`, fork staging/GC/concurrency cases in `sessionService.test.ts`, bridge and route contract tests (forwarding, 400, 409), compaction meta-merge, replay-page anchoring, SDK normalizer/transcript, web-shell adapter + DOM, and the webui provider. Gaps worth closing:
>
> - A fork whose referenced file-history backup is missing on disk (finding 1) — currently the tests lock in the failing behavior.
> - A turn where `recordBranchCheckpointTransaction` rejects, asserting the turn still returns `end_turn` (finding 2).
> - Interleaved prompt / close / branch through `runExclusiveHistoryMutation` asserting ordering and no lost release.
>
> ### Style
>
> Matches house conventions — ESM, no `any` in the new code, `kebab-case.ts` in core, `PascalCase.tsx` for components, collocated tests, comments reserved for non-obvious _why_. `packages/core/src/index.ts` re-exports `branch-points.js` with no name collisions.

### Web Shell visual preview bot

> <!-- qwen:web-shell-visuals -->
>
> ### 🖼️ web-shell visual preview
>
> Rendered against a mock daemon (no real backend): the PR base vs this PR head `ed32544`. Only **screenshots** that changed are shown (flows below, if any, are head-only) — refreshes on every push.
>
> #### Screenshots · before / after
>
> ℹ️ _No screenshot changed against the PR base_ — but this PR edits 6 render-shaping files:
>
> - `packages/web-shell/client/App.tsx`
> - `packages/web-shell/client/components/MessageItem.tsx`
> - `packages/web-shell/client/components/MessageList.tsx`
> - `packages/web-shell/client/components/messages/AssistantMessage.tsx`
> - `packages/web-shell/client/i18n.tsx`
> - `packages/webui/src/daemon/session/DaemonSessionProvider.tsx`
>
> Either the change has no visual effect (logic, plumbing, a state the scenarios never reach), or **no scenario renders this UI** — in which case the preview cannot see it, and an empty result is a coverage gap rather than a clean bill of health. To make it visible, add a scenario to `packages/web-shell/client/e2e/visuals/screenshots.spec.ts` that seeds whatever state the UI is gated on; it then appears here as a head-only (NEW) capture.
>
> <sub>Full-resolution recordings (.webm) are attached to the <a href="https://github.com/QwenLM/qwen-code/actions/runs/30681894876">workflow run</a>.</sub>
>
> — _Qwen Code · web-shell visuals_

### Triage lifecycle bot

> <!-- qwen-triage lifecycle -->
>
> ✅ **Qwen Triage finished** — [view run](https://github.com/QwenLM/qwen-code/actions/runs/30681894086). See the stage comments in this thread for the result.
>
> ✅ **Qwen Triage 已完成** —— [查看运行](https://github.com/QwenLM/qwen-code/actions/runs/30681894086)。结果见本线程中的各阶段评论。

### Triage stage 1 bot

> <!-- qwen-triage stage=1 -->
>
> Thanks for this — it's a substantial piece of work and the design doc is genuinely helpful.
>
> **Template:** complete ✓ — all sections present, with a real reviewer test plan and before/after evidence.
>
> **Problem:** this is a feature request (#8271), self-reported and on the `roadmap/session-management` track (P3). The gap is real and user-facing — today you can only branch from the latest session state, so exploring an alternative direction from an _earlier_ Assistant response means manually recreating context. That's a legitimate problem, not theoretical hardening. Worth noting it's self-reported and low priority, so the bar is "is this the right thing to build and is it safe to land," not "is this urgent."
>
> **Direction:** aligned. Conversation forking is an active area in the reference product (claude-code ships `/fork`, fork-session lineage, and checkpoint pruning), and this extends the idea in a sensible direction — durable checkpoints as a single source of truth shared by recording, replay, UI, and Core validation, rather than trusting a visible message as the branch point. The issue deliberately splits the work; this PR is Part 1 (branch from any eligible response), with worktree isolation (Part 2) deferred. One linking nit: the body says `Closes #8271`, which would close the whole issue including the not-yet-implemented Part 2 — a plain reference (or scoping the close) would avoid that.
>
> **Size:** this is the thing a maintainer needs to see. ~2,099 production-logic lines (additions+deletions, excluding ~1,796 test lines and the ~791-line design doc) across 48 files and 6 packages, with the weight in core session infrastructure (`packages/core/src/services/sessionService.ts` alone is ~637 changed lines, plus a new `branch-points.ts` service). Per the core-module gate, a `feat` of this size touching core is not blocked, but it does cross both the 500-line maintainer-awareness threshold and the 1,000-line large-PR advisory. Flagging it here so it gets a maintainer's architectural sign-off rather than sliding through on review quality alone. Splitting isn't obviously feasible given how tightly the durability, crash-safety, and concurrency pieces couple, but I'll leave that judgment to the maintainer.
>
> **Approach:** the scope feels earned rather than padded — each layer maps to a stated requirement (durable checkpoint, crash-safe atomic creation, stale-checkpoint rejection, UI surface). I don't see a materially simpler path that still meets the "never expose a partially created session" constraint. Implementation-level observations are in the next comment.
>
> **Risk:** elevated. The diff touches `packages/cli/src/acp-integration/` (`acpAgent.ts`, `session/Session.ts`, `history-replay-page.ts`), which is on the high-revert-correlation path list for this repo. That doesn't block anything, but it means the code review below goes to full depth and the CI evidence is load-bearing before any approval.
>
> Moving on to code review. 🔍
>
> <details>
> <summary>中文说明</summary>
>
> 感谢贡献，工作量很大，设计文档也很有帮助。
>
> **模板：** 完整 ✓ —— 各节齐全，有真实的 reviewer 测试计划和 before/after 证据。
>
> **问题：** 这是一个 feature request（#8271），由作者自己提出，挂在 `roadmap/session-management` 路线上（P3）。缺口是真实且面向用户的——目前只能从会话最新状态分支，想从*更早*的一条 Assistant 回复探索另一条路径，只能手动重建上下文。这是合理的问题，不是理论性加固。需要说明：它是自我提出且低优先级的，所以标准是"该不该做、能否安全落地"，而不是"是否紧急"。
>
> **方向：** 对齐。会话 fork 在参考产品里是活跃方向（claude-code 已有 `/fork`、fork 会话谱系、checkpoint 清理），本 PR 把思路往合理方向延伸——用持久化 checkpoint 作为录制、回放、UI 和 Core 校验共享的唯一事实来源，而不是把界面上可见的消息当作分支点。issue 有意拆分了工作；本 PR 是 Part 1（从任意符合条件的回复分支），worktree 隔离（Part 2）延后。一个关联小问题：正文写了 `Closes #8271`，会连同尚未实现的 Part 2 一起关掉——改成普通引用（或限定关闭范围）更稳妥。
>
> **规模：** 这是维护者需要看到的重点。约 2,099 行生产逻辑（增+删，不含约 1,796 行测试和 791 行设计文档），跨 48 个文件、6 个 package，重量集中在核心会话基础设施（仅 `packages/core/src/services/sessionService.ts` 就改动约 637 行，外加新增的 `branch-points.ts` 服务）。按核心模块门禁，这种规模的 `feat` 触及核心不会被拦截，但确实同时越过 500 行维护者关注阈值和 1,000 行大 PR 提示线。在此标出，以便获得维护者的架构层面确认，而不是仅凭 review 质量通过。鉴于持久化、崩溃安全、并发这几块耦合紧密，拆分未必可行，这个判断留给维护者。
>
> **方案：** 范围是"挣来的"而非堆砌——每一层都对应一个明确需求（持久化 checkpoint、崩溃安全的原子创建、过期 checkpoint 拒绝、UI 层面）。在满足"绝不暴露部分创建的会话"这一约束的前提下，我没有看到明显更简的路径。实现层面的观察见下一条评论。
>
> **风险：** 升级。diff 触及 `packages/cli/src/acp-integration/`（`acpAgent.ts`、`session/Session.ts`、`history-replay-page.ts`），这是本仓库高回滚相关路径之一。这不拦截任何东西，但意味着下面的代码审查要走完整深度，且 CI 证据在任何批准前都是关键依据。
>
> 进入代码审查。🔍
>
> </details>
>
> — _Qwen Code · qwen3.8-max-preview_
>
> <sub>Reviewed at `ed32544c6124ea473b6835a39f1c2ce8c4eba0b5` · re-run with `@qwen-code /triage`</sub>

### Triage stage 2 bot

> <!-- qwen-triage stage=2 -->
>
> ## Code review
>
> I wrote my independent proposal first (a versioned checkpoint record appended to the transcript, validated against the reconstructed active chain, with branch creation that truncates the raw JSONL at the checkpoint and refuses stale points), then read the diff. The PR matches or exceeds it — and goes further than I would have on crash safety.
>
> The core design is sound. `branch-points.ts` treats a checkpoint as valid only when the turn is genuinely complete: it replays tool-call/tool-response pairing across the chain, bails on any unbalanced call, and requires exactly one final visible-text Assistant record after the last tool result. The payload is versioned (`v: 1`) and defensively parsed. `resolveBranchPoints` de-duplicates by assistant UUID and drops ambiguous points rather than guessing.
>
> Two pieces are notably careful:
>
> - **Concurrency.** `ChatRecordingService` grows a "topology fence" so async metadata writers (titles, artifacts) that land during a checkpoint transaction are buffered and re-parented onto the checkpoint instead of becoming its siblings — this is what keeps the recorded topology authoritative. In `acpAgent.ts`, a new per-session promise-chain mutex (`runExclusiveHistoryMutation`) serializes prompt / rewind / close / branch, with a regression test asserting a close can't finalize the source recorder mid-branch. This directly answers the issue's "concurrent transcript mutations" concern.
> - **Crash safety.** `forkSession` now stages through a claim file + staging dir + owner tokens, publishes the transcript via an atomic hard link, fsyncs along the way, validates the branch point twice (before staging and after building the forked records), and on failure deliberately _preserves_ ambiguous resources for a stale-creation GC rather than risk deleting something it doesn't own. The GC (`cleanupStaleBranchCreations`) is conservative in the same direction — it refuses to touch anything with an owner-marker mismatch. Path-traversal is guarded (`validatedBackupPath`). This is the right instinct for "never expose a partially created session."
>
> The serve route validates `atRecordId` (400 on non-string) and maps `branch_point_invalid` → 409; the ACP layer maps it to `-32009`. `compactionEngine` now merges nested `qwenTranscript` meta so checkpoints survive compaction instead of being overwritten. Conventions look clean (ESM, kebab-case core files, collocated tests), and test coverage is heavy (~1,796 test lines, including concurrency and stale-checkpoint cases).
>
> No critical blockers found in static review. Two non-blocking notes:
>
> 1. The body says `Closes #8271`, but the PR implements only Part 1 of that issue (branch from any response); Part 2 (worktree isolation) is not here. Worth scoping the close so Part 2 isn't silently closed.
> 2. This is a static review only — I did not build or run the PR (CI path). The behavioural claims below are not independently exercised here.
>
> ```mermaid
> sequenceDiagram
>     participant P1 as Web Shell UI
>     participant P2 as Serve route
>     participant P3 as Bridge and Agent
>     participant P4 as SessionService
>     participant P5 as Filesystem
>     P1->>P2: POST branch with atRecordId
>     P2->>P3: branchSession atRecordId
>     P3->>P3: serialize via history mutex
>     P3->>P4: forkSession atRecordId
>     P4->>P4: resolveBranchPoints then validate
>     P4->>P5: claim then stage transcript and backups
>     P4->>P5: atomic link publish
>     P4-->>P3: new session path
>     P3-->>P2: attached session
>     P2-->>P1: 201 created
> ```
>
> <details>
> <summary>Files changed (28 of 48 shown)</summary>
>
> | File                                                                            | What changed                                                                                                 |
> | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
> | <code>packages/core/src/services/branch-points.ts</code>                        | New service: versioned checkpoint payload, completed-turn validation, branch-point resolution with de-dup    |
> | <code>packages/core/src/services/chatRecordingService.ts</code>                 | Topology fence buffering concurrent writes; recordBranchCheckpointTransaction; new branch_checkpoint subtype |
> | <code>packages/core/src/services/sessionService.ts</code>                       | forkSession gains atRecordId; crash-safe claim/stage/publish; stale-creation GC; backup path guards          |
> | <code>packages/core/src/services/session-transcript-reader.ts</code>            | Projects validated branch points per transcript page                                                         |
> | <code>packages/core/src/index.ts</code>                                         | Export new branch symbols                                                                                    |
> | <code>packages/acp-bridge/src/bridge.ts</code>                                  | branchSession forwards atRecordId; error mapping                                                             |
> | <code>packages/acp-bridge/src/compactionEngine.ts</code>                        | Merge nested qwenTranscript meta so checkpoints survive compaction                                           |
> | <code>packages/acp-bridge/src/bridgeTypes.ts</code>                             | atRecordId option type                                                                                       |
> | <code>packages/cli/src/acp-integration/acpAgent.ts</code>                       | Per-session history-mutation mutex; branch handler maps BranchPointInvalidError to -32009 (high-risk path)   |
> | <code>packages/cli/src/acp-integration/session/Session.ts</code>                | Accepts the mutation serializer; branch plumbing (high-risk path)                                            |
> | <code>packages/cli/src/acp-integration/session/history-replay-page.ts</code>    | Expose branch points in the replay page (high-risk path)                                                     |
> | <code>packages/cli/src/serve/routes/session.ts</code>                           | POST branch accepts atRecordId; 400 on non-string; 409 on invalid point                                      |
> | <code>packages/cli/src/serve/server/error-response.ts</code>                    | branch_point_invalid error kind                                                                              |
> | <code>packages/sdk-typescript/src/daemon/DaemonClient.ts</code>                 | branchSession atRecordId parameter                                                                           |
> | <code>packages/sdk-typescript/src/daemon/ui/transcript.ts</code>                | Branch points in UI transcript model                                                                         |
> | <code>packages/sdk-typescript/src/daemon/ui/normalizer.ts</code>                | Normalize branch points from events                                                                          |
> | <code>packages/sdk-typescript/src/daemon/ui/types.ts</code>                     | Branch point UI types                                                                                        |
> | <code>packages/sdk-typescript/src/daemon/types.ts</code>                        | Daemon event types for branch points                                                                         |
> | <code>packages/web-shell/client/App.tsx</code>                                  | Branch action handler wiring                                                                                 |
> | <code>packages/web-shell/client/components/messages/AssistantMessage.tsx</code> | Branch action on eligible Assistant responses                                                                |
> | <code>packages/web-shell/client/components/MessageList.tsx</code>               | Thread branch points to messages                                                                             |
> | <code>packages/web-shell/client/adapters/transcriptToMessages.ts</code>         | Carry branch points into message view model                                                                  |
> | <code>packages/web-shell/client/i18n.tsx</code>                                 | Branch action strings                                                                                        |
> | <code>packages/webui/src/daemon/session/DaemonSessionProvider.tsx</code>        | Branch action provider wiring                                                                                |
> | <code>packages/webui/src/daemon/session/actions.ts</code>                       | Branch action plumbing                                                                                       |
> | <code>docs/design/web-shell/assistant-response-session-branching.md</code>      | New design doc (791 lines)                                                                                   |
> | <code>packages/core/src/services/sessionService.test.ts</code>                  | +616 lines: fork-at-record, crash-safety, GC, stale-point cases                                              |
> | <code>packages/core/src/services/branch-points.test.ts</code>                   | +263 lines: completed-turn validation and resolution                                                         |
> | …and 20 more files                                                              | Mostly collocated tests (acpAgent, bridge, server, web-shell/webui components) plus small type plumbing      |
>
> </details>
>
> ## Test evidence (PR's own CI)
>
> CI on the reviewed commit is **still running** — no failures so far, but the load-bearing suites have not completed. I fetched this once via the API and did not poll; the finalize job updates the table below when CI settles. The macOS/Windows test jobs are `skipped` (gated behind the Ubuntu suite), so cross-platform coverage is not yet established either.
>
> <!-- qwen-triage-ci sha=ed32544c6124ea473b6835a39f1c2ce8c4eba0b5 -->
>
> Final CI results for `ed32544` (auto-updated by the triage finalize job after CI completed):
>
> | Check                                                                     | Conclusion |
> | ------------------------------------------------------------------------- | ---------- |
> | <code>Capture web-shell visuals &#40;ubuntu-latest, Node 22.x&#41;</code> | ✅ success |
> | <code>Classify PR</code>                                                  | ✅ success |
> | <code>macos-latest / Java 21</code>                                       | ✅ success |
> | <code>Real daemon E2E / Java 11</code>                                    | ✅ success |
> | <code>Serve A/B &#40;ubuntu-latest, Node 22.x&#41;</code>                 | ✅ success |
> | <code>Test &#40;ubuntu-latest, Node 22.x&#41;</code>                      | ✅ success |
> | <code>ubuntu-latest / Java 11</code>                                      | ✅ success |
> | <code>ubuntu-latest / Java 17</code>                                      | ✅ success |
> | <code>ubuntu-latest / Java 21</code>                                      | ✅ success |
> | <code>web-shell E2E Smoke &#40;ubuntu-latest, Node 22.x&#41;</code>       | ✅ success |
> | <code>windows-latest / Java 21</code>                                     | ✅ success |
>
> <sub>One row per check name (latest run); skipped checks omitted; failures sort first. / 每个检查名一行（取最新一次运行），省略 skipped，失败项排在最前。</sub>
>
> <!-- /qwen-triage-ci -->
>
> Sandboxed verification would settle the behavioural core here: `@qwen-code /verify` — that `forkSession(atRecordId)` actually produces a session whose transcript ends at the chosen Assistant turn (and that a stale/inactive checkpoint is rejected with `branch_point_invalid` rather than silently falling back to latest state) is not observable from the diff, and a green suite could pass with that truncation logic weakened. `@qwen-code /tmux` would additionally confirm the Web Shell surface — that the Branch action appears only on eligible completed responses and that selecting it switches to the truncated session. The author has write access, so both lanes are available directly; given the high-risk `acp-integration` paths, running at least `/verify` before merge is the least-optional step.
>
> <details>
> <summary>中文说明</summary>
>
> ## 代码审查
>
> 我先独立写下自己的方案（一个带版本的 checkpoint 记录追加到 transcript，针对重建出的活跃链做校验，分支创建时在 checkpoint 处截断原始 JSONL 并拒绝过期点），然后再读 diff。PR 达到甚至超过了这个方案——而且在崩溃安全方面做得比我预期的更多。
>
> 核心设计是合理的。`branch-points.ts` 只在一个回合真正完整时才认为 checkpoint 有效：它回放整条链上的工具调用/响应配对，任何未闭合的调用就退出，并要求最后一个工具结果之后恰好有一条可见文本的 Assistant 记录。payload 带版本（`v: 1`）且防御性解析。`resolveBranchPoints` 按 assistant UUID 去重，对歧义点直接丢弃而不是猜测。
>
> 有两处特别用心：
>
> - **并发。** `ChatRecordingService` 引入"拓扑栅栏（topology fence）"，使 checkpoint 事务期间落地的异步元数据写入（标题、产物）被缓冲并重新挂到 checkpoint 之下，而不是成为它的兄弟节点——这正是保证记录的拓扑权威的关键。`acpAgent.ts` 里新增了一个按会话的 promise 链互斥锁（`runExclusiveHistoryMutation`），串行化 prompt / rewind / close / branch，并有回归测试断言 close 不能在分支进行中途 finalize 源记录器。这直接回应了 issue 里"并发 transcript 写入"的担忧。
> - **崩溃安全。** `forkSession` 现在通过 claim 文件 + 暂存目录 + owner token 来暂存，用原子硬链接发布 transcript，沿途 fsync，两次校验分支点（暂存前和构建 fork 记录后各一次），失败时*刻意保留*歧义资源交给过期创建 GC，而不是冒险删除不属于自己的东西。GC（`cleanupStaleBranchCreations`）同样保守——owner marker 不匹配就拒绝触碰。路径穿越也有防护（`validatedBackupPath`）。对于"绝不暴露部分创建的会话"这个要求，这是正确的取向。
>
> serve 路由校验 `atRecordId`（非字符串返回 400），把 `branch_point_invalid` 映射为 409；ACP 层映射为 `-32009`。`compactionEngine` 现在会合并嵌套的 `qwenTranscript` 元数据，使 checkpoint 在压缩后存活而不是被覆盖。约定看起来干净（ESM、core 文件 kebab-case、测试就近放置），测试覆盖很重（约 1,796 行测试，含并发和过期 checkpoint 用例）。
>
> 静态审查未发现关键阻塞项。两条非阻塞提示：
>
> 1. 正文写了 `Closes #8271`，但本 PR 只实现了该 issue 的 Part 1（从任意回复分支）；Part 2（worktree 隔离）不在这里。建议限定关闭范围，避免 Part 2 被静默关掉。
> 2. 这只是静态审查——我没有构建或运行 PR（CI 路径）。下面的行为性结论在此未被独立验证。
>
> （时序图见上方英文部分：Web Shell UI → serve 路由 → bridge/agent（经历史互斥锁串行化）→ SessionService（resolveBranchPoints 校验 → claim/暂存 → 原子链接发布）→ 文件系统。）
>
> ## 测试证据（PR 自身的 CI）
>
> 所审提交上的 CI **仍在运行**——目前没有失败，但关键的几个套件还没跑完。我通过 API 只取了一次，没有轮询；CI 结束后 finalize 任务会更新上方表格。macOS/Windows 测试任务为 `skipped`（门控在 Ubuntu 套件之后），所以跨平台覆盖也尚未建立。
>
> 沙盒化验证可以落实这里的行为性核心：`@qwen-code /verify`——`forkSession(atRecordId)` 是否真的产出一个 transcript 止于所选 Assistant 回合的会话（以及过期/非活跃 checkpoint 是否被以 `branch_point_invalid` 拒绝、而不是静默回退到最新状态）从 diff 看不出来，而且即使截断逻辑被削弱，绿色套件也可能照样通过。`@qwen-code /tmux` 还能额外确认 Web Shell 层面——Branch 操作只出现在符合条件的已完成回复上，且选中后会切换到截断后的会话。作者有写权限，两条通道都可直接使用；鉴于触及高风险的 `acp-integration` 路径，合并前至少跑一次 `/verify` 是最不该省略的一步。
>
> </details>
>
> — _Qwen Code · qwen3.8-max-preview_
>
> <sub>Reviewed at `ed32544c6124ea473b6835a39f1c2ce8c4eba0b5` · re-run with `@qwen-code /triage`</sub>

### Triage stage 3 bot

> <!-- qwen-triage stage=3 -->
>
> **Confidence: 3/5** — clean review and genuinely strong engineering, but this is a large `feat` touching core session infrastructure, so the core-module gate caps it here and it needs a maintainer's architectural sign-off rather than an auto-approval. The 3/5 is policy, not doubt about the code.
>
> Stepping back: this is better work than most of what lands in the queue. My independent proposal was a fraction of this — a versioned checkpoint plus truncation at the branch point — and the PR goes well past it on the two things that are actually hard here, concurrency and crash safety. The topology fence, the per-session history mutex (with a test that pins the exact race), and the claim/stage/atomic-publish/GC dance in `forkSession` are the work of someone who has thought about how this fails, not just how it succeeds. The conservative "preserve ambiguous resources for GC" instinct is the right one. Test coverage is heavy and aimed at the right risks (stale checkpoints, concurrent mutation, crash cleanup).
>
> The reason I'm not approving isn't a defect — it's scope and trust boundary. ~2,099 production lines across six packages, with the weight in `packages/core/src/services/`, is exactly the surface the core-module gate exists to slow down. It's also self-reported and P3: a real, roadmap-aligned feature, but not urgent, so the question for a maintainer is less "is it correct" (the review and tests make a strong case) and more "do we want this much new core machinery now, and is the durable-checkpoint contract the one we want to commit to long-term." That's a judgment call I shouldn't make unilaterally.
>
> Two things I'd want settled before merge, neither blocking the review:
>
> 1. **Behavioural proof.** The central claims — a branch at a historical checkpoint ends the new session at exactly that turn, and a stale checkpoint is rejected rather than silently falling back to latest state — are not observable from the diff, and CI is still running. `@qwen-code /verify` (and `/tmux` for the Web Shell surface) would close that; the author has write access, so both are available. Given the high-risk `acp-integration` paths, I'd treat at least `/verify` as a precondition.
> 2. **Issue scoping.** `Closes #8271` would close Part 2 (worktree isolation) too, which isn't implemented here.
>
> ⏸️ Deferring to @wenshao @tanzhenxin @yiliang114 @LaZzyMan (core CODEOWNERS) — no blocking defects found; this needs a maintainer call on whether the scope and the durable-checkpoint contract are what we want, plus green CI and ideally a `/verify` run before merge.
>
> <details>
> <summary>中文说明</summary>
>
> **置信度：3/5** —— 审查干净、工程质量确实很高，但这是一个触及核心会话基础设施的大型 `feat`，核心模块门禁在此把它封顶，需要维护者的架构层面确认，而不是自动批准。这个 3/5 是策略所致，并非对代码有疑虑。
>
> 退一步看：这比队列里大多数 PR 都要好。我独立的方案只是它的一小部分——一个带版本的 checkpoint 加上在分支点截断——而 PR 在真正难的两点上远超我的方案：并发与崩溃安全。拓扑栅栏、按会话的历史互斥锁（附带一个精确钉住该竞态的测试）、以及 `forkSession` 里的 claim/暂存/原子发布/GC 流程，都出自一个认真思考过"它会怎么失败"而不只是"它怎么成功"的人。保守的"把歧义资源留给 GC"取向是正确的。测试覆盖很重，且对准了正确的风险（过期 checkpoint、并发写入、崩溃清理）。
>
> 我不批准的原因不是缺陷——而是范围与信任边界。约 2,099 行生产代码跨六个 package，重量集中在 `packages/core/src/services/`，这正是核心模块门禁要放慢的那类改动。它也是自我提出且 P3 的：一个真实、与路线图对齐的功能，但不紧急，所以维护者要回答的问题与其说是"它是否正确"（审查和测试已给出有力论证），不如说是"我们现在是否想要这么多新的核心机制，以及持久化 checkpoint 契约是否是我们想长期承诺的那个"。这是我不该独自做出的判断。
>
> 合并前我希望落实两件事，都不阻塞审查：
>
> 1. **行为性证明。** 核心结论——在历史 checkpoint 处分支会使新会话恰好止于该回合，且过期 checkpoint 会被拒绝而非静默回退到最新状态——从 diff 看不出来，而且 CI 还在跑。`@qwen-code /verify`（以及针对 Web Shell 层面的 `/tmux`）可以闭环；作者有写权限，两者都可用。鉴于高风险的 `acp-integration` 路径，我会把至少跑一次 `/verify` 视为前置条件。
> 2. **issue 范围。** `Closes #8271` 会连同 Part 2（worktree 隔离）一起关掉，而它并未在此实现。
>
> ⏸️ 转交 @wenshao @tanzhenxin @yiliang114 @LaZzyMan（core CODEOWNERS）—— 未发现阻塞性缺陷；需要维护者就范围与持久化 checkpoint 契约是否符合预期做出决定，并在合并前等 CI 转绿、最好再跑一次 `/verify`。
>
> </details>
>
> — _Qwen Code · qwen3.8-max-preview_
>
> <sub>Reviewed at `ed32544c6124ea473b6835a39f1c2ce8c4eba0b5` · re-run with `@qwen-code /triage`</sub>

### Serve A/B bot

> <!-- qwen:serve-ab -->
>
> ### 🩺 serve daemon A/B
>
> Built the PR base vs this PR head `ed32544`, drove a fixed endpoint set against each, and diffed the JSON responses. Only fields that changed are shown.
>
> ✅ _No response changes against the PR base across 4 scenario(s)._
>
> — _Qwen Code · serve A/B_
