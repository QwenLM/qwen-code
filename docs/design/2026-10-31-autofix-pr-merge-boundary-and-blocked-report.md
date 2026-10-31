# /autofix-pr: the merge boundary, and a blocked round that reports itself

[English](2026-10-31-autofix-pr-merge-boundary-and-blocked-report.md) | [简体中文](2026-10-31-autofix-pr-merge-boundary-and-blocked-report.zh-CN.md)

Status: implemented (2026-10-31)

## Problem statement

GitHub shipped **Agent Merge** on 2026-10-28: a `Watch and fix` button in the
PR's merge box that watches a PR for the blockers its owner selected (failed
Actions workflows, merge conflicts) and fixes them in the cloud. Comparing it
with `/autofix-pr` surfaced two gaps that cost nothing to close:

1. **A round that pushes nothing is silent on the PR.** What the round could
   not do reaches `needsHuman` in the state file and `/autofix-pr status`,
   and the session's one-line report — but the skill told the round to omit
   the summary whenever nothing was pushed and no review or issue comment
   was answered. A reviewer watching the PR cannot tell a watch that is
   still working from one that gave up. Agent Merge posts a timeline event
   when it starts and keeps a panel in the merge box, so its state is always
   visible where the PR is read.
2. **The boundary of the job is only written for the agent.** "Never merge,
   never approve" lives in the fix brief's `## Never`, which the user never
   reads. Neither the skill's opening, nor the start confirmation, nor the
   user guide said what the watch does _not_ do, or how it relates to
   auto-merge. Agent Merge's documentation states both in one sentence: it
   gets the PR ready to merge, it does not enable auto-merge, and it does not
   replace human review or the repository's merge requirements.

## Current state

Verified against `origin/main` at `46d825d115` (2026-10-31):

- `packages/cli/src/commands/autofix-pr/reply.ts`: a summary that answers no
  comments was due only while `state.summarizedSha !== head`. The helper
  therefore already allowed a summary with no push — once per head — but a
  head an earlier round had summarized (after a push, or after answering
  comments) suppressed every later blocked round on it.
- The same file records `needsHuman` per `(head, text)`, deduplicated, so a
  retry of one plan adds nothing.
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md`, Round step 7:
  "Omit it (`null`) when nothing was pushed and no review or issue comment
  was answered."
- `status.ts` lists `needsHuman`; no PR-side report of it existed.

## Goals

- A round that leaves something for a person says so on the PR even when it
  pushed nothing, including on a head an earlier round already summarized.
- The same blocked items never post twice, and a `--no-reply` watch still
  posts nothing.
- The skill, the start confirmation and the user guide state the boundary:
  ready to merge, never approve / change review state / merge / close /
  enable auto-merge — and that it combines with the repository's auto-merge.

## Scope boundaries (non-goals)

The rest of what Agent Merge does is deliberately left out of this change:

- No per-blocker authorization (`allowed_actions: fix_ci |
resolve_merge_conflicts`). A scope option has to reach the watch options,
  `schedule`, the gate probe and the round snapshot together, or the gate
  keeps waking rounds for blockers the watch may not fix.
- No declared environment setup (Agent Merge's
  `.github/workflows/copilot-setup-steps.yml`). Autofix worktrees still have
  no dependencies installed; that is a separate change to `prepare`.
- No "enable by default for the PRs I create", and no default watch options
  in settings.
- No stacked-PR or fork eligibility change.
- No new GitHub write surface: no timeline event of our own, no editable
  status comment, no auto-merge toggle. Every write still goes through the
  existing helpers, and `reply` still only creates comments.

## Changes

### 1. `reply.ts` — a blocked round is due a summary

The plan's `needsHuman` lines that this head has not recorded are computed
once (`freshNeedsHuman`) and used both to record the items and to decide the
summary:

```ts
const summaryDue =
  summary !== null &&
  (freshNeedsHuman.length > 0 ||
    ((summary.handled ?? []).length > 0
      ? summaryHandled.length > 0 || pushUnsummarized
      : state.summarizedSha !== head));
```

No new state field, no schema change: the deduplication that already keeps
`needsHuman` from growing on a retry is what keeps the summary from
repeating.

### 2. `SKILL.md` — the boundary and the summary rule

- An opening paragraph: the watch gets the PR ready to merge and keeps it
  there; it never approves, changes the review state, merges or closes the
  PR, or turns on auto-merge; it combines with the repository's auto-merge.
- One more bullet in the start confirmation (Start step 5) saying the same,
  so the user consents to a job whose limit is stated.
- Round step 7's `summary`: with nothing pushed, post one anyway when
  `needsHuman` is not empty — what was attempted, what blocks it, what a
  person has to decide. `null` only when nothing was pushed, no review or
  issue comment was answered, and `needsHuman` is empty. The deduplication
  is described as the helper's, not the round's.
- The `needsHuman` bullet says the summary reports the items on the PR.

### 3. Documentation

- `docs/users/features/autofix-pr.md`: the boundary in the introduction and
  in the start-confirmation paragraph; the blocked-round summary in step 5
  of "What a check does".
- `docs/design/2026-10-21-autofix-pr-command.md` and its Chinese version:
  a non-goal, a confirmation bullet, the `reply` deduplication rule
  (Section 6.5), the round's answer to items needing a human (Section 7),
  and a Replies bullet (Section 9).

### 4. Tests

- `reply.test.ts`: a blocked round posts on an already-summarized head; the
  same plan posts nothing again; a summary with nothing new stays skipped;
  a new item on that head posts again; `--no-post` records and posts
  nothing. The first assertion was mutation-checked (with the new condition
  disabled the test fails on `summarySkipped`).
- `SKILL.test.ts`: pins for the boundary paragraph, the confirmation bullet,
  and the three sentences of the summary rule.

## Design decisions and rationale

- **Gate on fresh `needsHuman` lines, not on a new state field.** A
  `blockedSummarySha` would duplicate what `(head, text)` deduplication
  already knows, and would need state validation and migration. Deriving
  the condition from data the helper already records keeps the change to
  one expression and makes a retry of the same plan silent by construction.
- **The condition applies to both branches of `summaryDue`.** A round that
  answers comments _and_ leaves something for a person is blocked too; its
  summary must not depend on whether the comments it names were already
  answered by an earlier run.
- **A comment, not an editable status panel.** Agent Merge keeps a panel in
  the merge box and a timeline event per start. Reproducing that needs a
  GitHub write the helpers do not have (editing a comment, or a custom
  timeline event), and a marker protocol to keep it from multiplying. The
  blocked summary covers the case that mattered — the watch going quiet —
  with the write surface that already exists.
- **The boundary is stated where the user reads it, three times.** The
  brief's `## Never` binds the fix agent; the opening paragraph binds the
  session; the confirmation is what the user actually consents to. Stating
  it in only one of them leaves the other two readers guessing.
- **No auto-merge write.** The interplay is documented, never enabled: a
  watch that turned on auto-merge would merge code nobody approved, which
  is the opposite of the boundary this change states.

## Constraints and risks

- At most one extra comment per head that has no summary yet, plus one per
  round that adds a new blocked item on a head already summarized. New
  blocked items require new events (a new failed attempt, a new trusted
  comment), which the gate reports once and `handledChecks` /
  `handledCommentIds` then suppress, so a quiet PR costs nothing and a
  stuck one cannot loop on the same item.
- `--no-reply` (`reply --no-post`) records the same state and posts nothing,
  unchanged.
- "New" means what the `needsHuman` list no longer holds: it keeps the
  newest 20 items of the watch (`MAX_NEEDS_HUMAN`). A plan with more than 20
  blocked lines, or an item that later ones pushed out of the list, can
  therefore be reported again. The cost is one extra comment, never a loop:
  a round runs only when the gate reports a new event.
- The gate probe, the cursor, the push budget and the trust rules are
  untouched.

## Validation

- `cd packages/core && npx vitest run src/skills/bundled/autofix-pr/SKILL.test.ts`
  — 11 passed (9 before).
- `cd packages/cli && npx vitest run src/commands/autofix-pr` — 16 files,
  482 passed; `reply.test.ts` alone 32 (30 before).
- Mutation check: with `freshNeedsHuman.length > 0` disabled, the new
  blocked-round test fails on `summarySkipped`; restored, it passes.
- `tsc --noEmit` in `packages/core`: clean. In `packages/cli`: 68 errors,
  every one in `src/acp-integration/*` or `src/serve/*`, from the checkout's
  stale `@qwen-code/acp-bridge` dist; none names a changed file. Restoring
  the two changed files to the base commit and re-running gives an identical
  error list, so all 68 are pre-existing.
- A full `npm run build` was not run: this checkout's dependencies predate
  the lockfile (`mime` 2.6.0, `ignore` 5.3.2, `playwright-core` 1.58.2),
  which fails `packages/browser-use` for reasons unrelated to this change.
  CI on the PR is the authoritative build and typecheck.
- ESLint and Prettier clean on every changed file.

## Acceptance criteria

- A round that pushed nothing and answered no comments posts one summary
  when it leaves something for a person, on a fresh head and on a head an
  earlier round summarized.
- Running the same plan again posts nothing; a later round with a new
  blocked item on the same head posts once more.
- A `--no-reply` watch posts nothing in either case.
- The skill's opening, the start confirmation and the user guide all state
  that the watch never approves, changes the review state, merges, closes
  or enables auto-merge.
- No new GitHub write surface, no gate or cursor change, no budget change.

## References

- GitHub Changelog, 2026-10-28: [Agent Merge watches and fixes pull requests
  in the cloud](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud/)
- GitHub Docs: [Getting pull requests ready to merge with Agent
  Merge](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests)
- GitHub Docs: [REST API endpoints for Agent
  Merge](https://docs.github.com/en/rest/pulls/agent-merge)
