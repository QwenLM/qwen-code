# `/autofix-pr`: Built-in Undirected/Adversarial Audit, Real-Environment Verification, `--audit`, and Fail-Closed Thread Resolution

[English](2026-11-28-autofix-pr-audit-and-resolve.md) | [简体中文](2026-11-28-autofix-pr-audit-and-resolve.zh-CN.md)

Status: Implemented. Extends
[`2026-10-21-autofix-pr-command`](2026-10-21-autofix-pr-command.md) and
[`2026-10-31-autofix-pr-in-place-scheduled-ask`](2026-10-31-autofix-pr-in-place-scheduled-ask.md).

## 1. Motivation

Empirical analysis of 65 historical PR sessions in a real maintainer workspace
revealed a consistent gap between how `/autofix-pr` ran a fix round and how
complex PRs are actually brought to merge-ready quality:

1. **Shallow verification in the fix brief.** Running only the narrowest unit
   tests left real bugs that were caught only after unit tests turned green —
   through repeated undirected diff audits (missed sibling call sites, dead
   optional flags, contract/docs drift), adversarial testing (boundary inputs,
   races, cleanup, verifying tests are actually load-bearing), and local
   real-environment checks (built artifacts, real child processes/daemons,
   temporary git repos, headless browsers).
2. **No way to run proactive audit on a quiet PR.** When a PR was just opened or
   had no new review comments or CI failures yet, `snapshot` answered `wait` and
   `/autofix-pr` exited without running any audit or real-environment check.
3. **Avoidable local `/review` invocations.** Fix rounds occasionally invoked
   the heavy local `/review` workflow even though CI runs formal review after
   each push, wasting wall-clock time and attempt budget.
4. **Incomplete comment close-out.** Reviewers and verification tools frequently
   place findings or deferred checklists in `review` bodies or trusted
   `issue_comment` reports (e.g., `Verdict: findings`), and maintainers expect
   fixed review threads to be resolved once verified and pushed — whereas v1
   forbade resolving review threads altogether.
5. **Tight budgets on long-lived PRs.** Complex PRs routinely require 10–17
   iteration rounds, and a full audit + build + real-environment verification
   round can exceed the original 30-minute background fix cap.

## 2. Decisions

### 2.1 Built-in Multi-Round Audit + Local Real-Environment Verification

Every fix round brief in
`packages/core/src/skills/bundled/autofix-pr/SKILL.md` now enforces a three-phase
workflow before committing:

1. **Full event accounting (`## What to do`)**:
   - Resolve conflicts and `baseBehind` merges while checking cross-file
     contracts, schemas, version bumps, and size ratchets.
   - Distinguish aggregate/summary CI jobs from the underlying failing child
     job, and separate PR defects from external/runner/base-branch flakes.
   - Account for every actionable item across inline `review_thread` comments,
     findings/deferred checklists in `review` bodies, and verification reports
     or maintainer follow-ups in trusted `issue_comment` entries, while
     recognizing purely procedural bot status notices (e.g., CI-pending
     downgrades) that require no code change.
2. **Multi-round undirected & adversarial audit (`## Audit until clean`)**:
   - **Undirected audit**: read the full PR diff against `<remote>/<baseRefName>`
     and nearby callers without a preset checklist to catch missed sibling call
     sites, unwired switches, contract/docs drift, and merge side effects.
   - **Adversarial audit**: assume implementation and tests are wrong; probe
     boundaries, platform/path edge cases, concurrency/restart/cleanup paths,
     legacy compatibility, and whether tests are truly load-bearing.
   - **Convergence**: each real PR-scoped fix resets the clean-pass counter and
     re-runs affected checks. Non-trivial code changes require **2 consecutive
     clean passes** (capped at 5 passes; if still not converged, stop widening
     and report residual risk). Docs-only or trivial config changes require 1
     careful clean pass.
   - **No local `/review`**: `## Never` explicitly forbids running the local
     `/review` skill or `qwen review run`, leaving formal review to CI.
3. **Build, checks, and local real-environment verification (`## Verify in a real environment, then commit`)**:
   - Run the affected build (rebuilding upstream workspace packages first in a
     monorepo), targeted tests, lint, and typecheck.
   - Exercise the changed runtime boundary locally with as few mocks as possible
     (built CLI/artifact, real child process/local service, temporary git repo
     or filesystem, headless browser/UI, or merged tree). Any bug found loops
     back into fix + regression test + audit convergence. When no runnable
     boundary exists or a local prerequisite is genuinely unavailable, report
     uncovered areas explicitly instead of claiming unit tests prove them.
   - Stop every started child process/server, release ports, and remove
     untracked scratch artifacts before committing.

### 2.2 Proactive `--audit` Mode

`/autofix-pr` adds `--audit`:

- One-shot semantics (like `--once`): runs a single foreground round, schedules
  nothing, leaves an already-running watch intact, and cleans up a freshly
  created one-shot state on completion. Mutually exclusive with `--watch` and
  `--every`. Compatible with `--in-place`, `--no-reply`, `--no-resolve`,
  `--yes`, and free-text instructions.
- Unlike `--once`, when `snapshot` returns `action: "wait"` (no new comments,
  CI failures, or conflicts), `--audit` proceeds into the fix agent for a
  proactive undirected + adversarial audit and local real-environment
  verification over the full PR diff.
- If the audit finds nothing to change (`commits` empty and `verified: true`),
  the round skips `push` and `reply` and reports a single clean summary line.
  If verified fixes are committed, they flow through the standard `sync` →
  `push` → `reply` pipeline.

### 2.3 Fail-Closed Thread Resolution in `autofix-pr reply` (`--no-resolve`)

Thread resolution remains strictly inside the deterministic helper boundary
(`packages/cli/src/commands/autofix-pr/reply.ts`); the model still may never
call raw `gh api` or GraphQL mutations directly.

- `ReplyPlan.replies[i]` accepts an optional boolean `resolve?: boolean`. The
  skill sets `"resolve": true` **only** for threads whose fix was verified and
  pushed in the round (`outcome: "fixed"` with a pushed commit) — never for
  `declined`, `needs_human`, or unpushed rounds.
- `autofix-pr reply` exposes `--resolve` (default `true`; `--no-resolve` sets
  `false`). `schedule` persists `watch.resolve` (`--no-resolve` sets `false`),
  emits `--no-resolve` in scheduled tick prompts and `BackgroundFix.followUp()`
  when disabled, preserves it on `schedule --again`, and `reply` refuses a
  scheduled round that omits `--no-resolve` when `watch.resolve === false`.
  Older state files without `watch.resolve` default to `true`.
- Resolution runs **only after** thread replies, summary comments, and
  `handledCommentIds` have been persisted, and enforces all fail-closed gates
  before calling GitHub GraphQL `resolveReviewThread`:
  1. `post === true` (`--no-post` skips with `no_post`).
  2. `resolve !== false` (`--no-resolve` skips with `disabled`).
  3. `state.pushedShas.includes(head)` **and** the round's prepared snapshot
     (`autofix-pr-<n>-snapshot.json` or background-fix
     `autofix-pr-<n>-fix-snapshot.json`) exists with `headSha !== head` —
     proving this round actually pushed a new head after reading the thread,
     and preventing a later non-pushing round from resolving a new thread
     opened on an earlier pushed head (`not_pushed`).
  4. `pr.headRefOid === head` — GitHub's live PR head matches the pushed head
     (`head_mismatch`).
  5. Thread exists with a valid GraphQL id (`thread_not_found`) and is currently
     open (`isResolved === true` skips idempotently with `already_resolved`;
     `unresolveReviewThread` is never called).
  6. The thread carries our matching reply — either posted in this `reply` call
     or already present on the thread with `isOwnReply` and matching `bodyHash`
     — and every id in `reply.handled` is recorded in `done` (`not_replied`).
     Matching `bodyHash` prevents a later pushed round from resolving an older
     thread that had previously been answered `"Needs a human decision"`.
  7. No unanswered trusted follow-up comment exists in the thread (`offer.threads`
     has no id outside `done`; otherwise skips with `new_comment_in_thread`).
  8. GraphQL `resolveReviewThread` runs via `ghWithInput` over stdin JSON
     (`gh api --method POST graphql --input -`, avoiding flag injection), checks
     `!errors?.length` and post-checks
     `data.resolveReviewThread.thread.isResolved === true`. Any failure
     (`graphql_error`, `not_resolved`, `request_failed`) is isolated into
     `resolveSkipped` without losing posted replies or state, and retrying the
     same plan resolves idempotently without reposting.
- `ReplyOutcome` reports `resolvedThreads: string[]` and
  `resolveSkipped: Array<{ replyTo: number; reason: ResolveSkipReason }>`.

### 2.4 Raised Long-Running PR Budgets

Empirical measurement of 106 pure single-prompt audit + real-environment rounds
in a maintainer workspace (excluding erroneous local `/review` runs and mid-turn
injections) showed P50 = 34.1 min, P75 = 61.2 min, P90 = 116.1 min, P95 = 155.3
min, and P98 = 173.4 min — so even 60 minutes would still cut off 26.4% of real
deep rounds. Raising the background fix limit to 240 minutes (4 hours) covers
over 97% of real rounds while normal crashes or suspended sessions still expire
within 90 seconds via the heartbeat freshness check:

| Budget                                           | Previous |     Updated |
| ------------------------------------------------ | -------: | ----------: |
| `MAX_PUSHES` (`state.ts`)                        |       10 |      **20** |
| `FIX_TIME_LIMIT_MS` (`autofix-pr-grants.ts`)     |   30 min | **240 min** |
| `FIX_CLAIM_DEADLINE_MS` (`autofix-pr-grants.ts`) |   40 min | **250 min** |
| `FIX_MAX_AGE_MS` (`fix.ts`)                      |   45 min | **255 min** |

The safety invariants (`FIX_CLAIM_DEADLINE_MS = FIX_TIME_LIMIT_MS + 10 min`,
`FIX_MAX_AGE_MS = FIX_CLAIM_DEADLINE_MS + 5 min`) are preserved.

## 3. Non-Goals & Preserved Security Boundaries

- Still never approves a PR, changes review state, merges/closes a PR, turns on
  auto-merge, edits PR title/description, or force-pushes.
- Still never unresolves review threads, and never lets untrusted authors trigger
  edits or replies.
- Scheduled `tick` rounds remain silent on `wait` (never proactively burn turns
  on quiet PRs without an explicit `--audit` invocation).
- `authorCanPush === false` remains restricted to one-shot runs (`--once`,
  `--audit`, or one-shot `--in-place`) with mandatory explicit confirmation.

## 4. Acceptance Criteria

1. `SKILL.md` and `SKILL.test.ts` specify and pin built-in undirected +
   adversarial audit (2 consecutive clean passes, cap 5), local
   real-environment verification + cleanup, prohibition on local `/review`,
   full review body / trusted `issue_comment` accounting, `--audit` on `wait`,
   `resolve: true` only for pushed fixes, `--no-resolve`, and updated budgets.
2. `reply.test.ts` verifies positive GraphQL thread resolution and every
   fail-closed skip reason (`no_post`, `disabled`, `not_pushed`,
   `head_mismatch`, `already_resolved`, `not_replied`, `new_comment_in_thread`,
   `graphql_error`, `not_resolved`, `request_failed`), plus idempotent retry
   and `watch.resolve === false` enforcement.
3. `chain.integration.test.ts` proves the full `prepare` → `snapshot` → fix →
   `push` → `reply` flow resolves fixed threads on `fake-gh`, leaves declined
   threads open, and leaves fixed threads open under `--no-resolve`.
4. `schedule.test.ts`, `state.test.ts`, `fix.test.ts`, and `autofix-pr.test.ts`
   verify `watch.resolve` persistence, `--no-resolve` propagation across
   `schedule`/`reply`/`autofix_pr` tool/`BackgroundFix.followUp()`, legacy state
   compatibility, and the updated 20-push / 240-250-255-minute budgets.
