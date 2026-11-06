# Phase 3b: Aone Code `pr-context` backing for /review

> Status: draft. Scope: back `qwen review pr-context` on Aone Code through the
> platform reader, lifting the forced context-unavailable cap on Aone runs.
> Parent: `2026-08-13-review-platform-provider-abstraction.md` (Phase 3,
> "still open: context reads"). Continues `2026-08-15-review-aone-provider.md`.

## Context

The Aone read path (Phase 2, #9226) and the Aone write path (Phase 3 `submit`
slice, #9491) are landed. But `pr-context` — the subcommand that fetches a
target's metadata and existing discussion into the context file every agent
reads — is still GitHub-direct. On an Aone target it is SKIPPED, and the skip
cascade defines the current Aone experience:

- every Aone run is context-unavailable; `submit` FORCES the cap for Aone
  writes, so the verdict can never rise past COMMENT;
- the wired `a1 repo mr approve` never fires (the cap precedes it);
- Agent 0 (issue fidelity) is skipped — it is gated on `pr-context` success,
  even though `issue-context` (its evidence command) is already Aone-backed;
- the machine ledger is never recovered from the MR, so every round re-opens
  as round 1 even though the posted summary comment carries the marker.

Backing `pr-context` is the single change that lifts all four: the cap is a
consequence of the skip, Agent 0's gate is `pr-context` success, and the
ledger lives in the posted comments this subcommand would now read.

Out of scope (tracked): comment-status/presubmit backing and cross-round
dedup (#9613), AI-comment marking (#9614), removed-line anchors (#9615),
self-PR detection (#9616 — landed via #9629 and merged into this branch
while it was in flight), cleanup audit (#9617), incremental cache under
AGit-Flow (#9618 — landed via #9630 and merged into this branch while it was
in flight; see D6), test-plan routing / composeUrl / a1 version floor (#9619).

## Verified platform facts

The Phase-2 facts table (probed 2026-08-13 against maxcompute/odps_src with
a1 v0.1.90) already covers everything this phase reads, plus the a1 command
surface re-checked 2026-08-21 via help (no auth needed):

| Need               | a1 surface                                                                                                                                            | Notes                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| MR metadata        | `a1 repo mr view <id> -f json` → `title, description, state, sourceBranch, targetBranch, author, detailUrl`                                           | `sourceBranch` is a full SHA under AGit-Flow and a branch name otherwise; no separate head SHA or diff stats |
| All comments       | `a1 repo mr comment list --mr <id> -f json [--sort asc]` → `id, note, author, closed, outdated, path, line, side, parentNoteId, isAiComment, isDraft` | one flat collection; `path` present ⇔ inline; NO pagination flags (full list returned); default sort `desc`  |
| Reviews / verdicts | none — no review object exists on Aone                                                                                                                | approvals surface only through `mr status` checks                                                            |
| Current user       | `a1 auth whoami -f json` → `account`                                                                                                                  |                                                                                                              |

Probe-pending shapes RESOLVED 2026-08-21 against live MRs once a1 auth was
restored:

- `author` is an object `{id, name, username}` — `username` is the identity
  space `a1 auth whoami`'s `account` answers in (verified both on one MR).
  The tolerant reader tries `account` first, then `username`.
- `createdAt` is present (ISO-8601 with offset); `closed` is a NUMBER,
  `outdated`/`isAiComment`/`isAiSummary`/`isDraft` are booleans — the draft
  skip is live, not hypothetical.
- The comment envelope also carries `updatedAt`, `adopted`, `labels` —
  unread.

One gap surfaced by the same E2E: `mr view` carries no separate head-SHA
field, and `sourceBranch` is a branch name on branch-based MRs. Resolved for
#9620: the provider now resolves the exact MR-head ref only from a verified
target clone. Clone-less context keeps the branch name but renders the SHA as
unavailable; safety and write paths fail closed if a known branch cannot be
resolved.

## Design decisions

### D1 — One new reader operation, `getReviewContext`, plus `getCurrentUser`

`pr-context` is the single consumer, so the reader gains exactly two members:

- `getReviewContext(prNumber, ownerRepo): ReviewContext` — the normalized
  bundle: metadata, the flat comment list split into inline/thread channels,
  and the platform's review-level verdicts.
- `getCurrentUser(): string` — the authenticated account ('' on the
  empty-output shape; throws on lookup failure).

The end-state interface in the parent doc named this `getContext(req)` —
"description, comments, verdicts, self"; `self` stays a separate operation
because pr-context's identity policy is deliberately NOT "always fetch": the
lookup runs only when comments exist, and its failure semantics (fail closed
iff a posted root carries a critical marker) are pr-context's security
logic, not the platform's. Keeping that logic in one place, platform-neutral,
is the point.

```ts
interface ReviewContextComment {
  id: number;
  author: string; // login/account, '' when absent
  body: string;
  createdAt: string; // ISO; '' when the platform gives none
  path?: string; // present ⇔ inline comment
  line?: number;
  parentId?: number; // GitHub in_reply_to_id / Aone parentNoteId
}

interface ReviewContextVerdict {
  id: number;
  author: string;
  body: string;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | …
  submittedAt: string;
  commitId?: string; // GitHub: the head the review was submitted against
}

interface ReviewContext {
  title: string;
  body: string;
  authorLogin: string;
  state: string;
  baseRefName: string;
  headRefName: string; // branch name; under AGit-Flow, Aone's sourceBranch is a bare SHA
  headRefOid: string;
  additions?: number; // absent where the platform reports no stats
  deletions?: number;
  changedFiles?: number;
  comments: ReviewContextComment[];
  verdicts: ReviewContextVerdict[];
  /** Where this platform's machine-ledger markers live, shaped as verdicts
   *  ready for `recoverLedger`: GitHub — the review bodies; Aone — the
   *  thread-level comments (the posted summaries). */
  ledgerCarriers: ReviewContextVerdict[];
}
```

`github.ts`'s implementation EXTRACTS pr-context's existing calls (one
`gh pr view` + the three paginated `ghApiAll` fetches; `ledgerCarriers` =
`verdicts`). The transport seam stays `lib/gh.js`, so pr-context's existing
test suite — which mocks that module — pins the extraction unchanged. That
suite passing unmodified is the no-regression evidence.

### D2 — Aone channel mapping

One flat comment collection serves three GitHub channels:

- `path` present → inline comment; `parentNoteId` → `in_reply_to_id`, so
  `classifyInlineThreads`/`findRootId` walk Aone threads unchanged.
- `path` absent → issue-level ("general MR thread") comment — blocker
  promotion and the "Already discussed" channel, exactly the treatment
  GitHub's issue comments get.
- ledger carriers = the path-ABSENT comments, mapped into the verdict shape
  (`state: 'COMMENTED'`, no `commitId`): the qwen summary lands there, and
  `recoverLedger` walks carriers — own/foreign split, round-first selection,
  headroom, the merge-over-own union — with zero Aone-specific code. Aone
  comments carry no `commit_id`, so a recovered Aone ledger has no age
  reference — the convergence posture already skips its age rule on that
  shape ("skip the age rule, not the review").
- `isDraft` comments are skipped (the PENDING-review analogue: a draft is
  not a posted round and not settled discussion).
- Resolved comments are INCLUDED: the default `comment list` excludes them
  (measured: the MR's `comments` minus `closedComments`), while GitHub's
  REST fetches include resolved-thread comments — so `getReviewContext`
  unions the default and `--resolved` listings, deduped by id, the same
  union `cleanup`'s audit applies. The `closed`/`outdated` FLAGS are still
  ignored this phase (their consumer is comment-status, #9613); the union
  is about which comments ARRIVE, not how their state is rendered.
  Disclosed residual: resolved REPLIES stay invisible — the `--resolved`
  listing returns resolved ROOT inline comments only, so a resolved thread
  renders its root without its reply chain (the re-check walk is unaffected
  — a reply alone never retires a blocker).
- `verdicts` is empty: Aone has no review object. The "Review summaries"
  section therefore renders nothing on Aone; human overall comments are
  thread comments and render in the thread channels like GitHub issue
  comments. Approvals are visible only through `mr status` and join with the
  dedup/presubmit phase.

### D3 — Metadata mapping

From `mr view`: `title`, `description` → body, `author` → authorLogin,
`state` passthrough, `targetBranch` → baseRefName, and trimmed `sourceBranch`
→ headRefName. A full 40-hex `sourceBranch` also supplies headRefOid directly.
For a branch name, headRefOid comes from
`refs/merge-requests/<global-id>/head` only when the cwd `origin` is verified
against the MR's full repository path; otherwise it is unavailable. Diff
stats have no Aone source: the header line degrades to
"not reported by the platform" instead of printing zeros (zeros would assert
an empty diff). pr-context does not compute them locally — the worktree
belongs to fetch-pr, and duplicating its merge-base arithmetic here would be
a second copy of logic that has a home.

### D4 — Refetch commands bake `--pr` on Aone; only an explicit `--host` bakes

pr-context's truncation notes emit `comment-body` commands. On GitHub,
inline and issue comment ids are global, so only `--kind review` carries
`--pr`; on Aone every comment body is addressed per-MR (comment-body already
refuses a pr-less Aone call). The emitted command builder learns the
platform: on Aone, every emitted refetch carries `--pr <id>`. A refetch a
reader cannot run is a truncation nobody can complete, which the fail-closed
"partial read is `cannot tell`" rule then turns into a stalled re-check.

The host half of the contract: on Aone only an EXPLICIT `--host` flag bakes
into the emitted refetches. An ambient `GH_HOST` never does — it is a
different platform's host, and baking it would silently retarget every
refetch at a GitHub host, re-opening the exact cross-platform leak the
`--pr` rule closes. A flagless Aone run's refetches rely on the cwd clone's
origin — the same detection the run itself used. (GitHub keeps its existing
policy: the explicit `--host` else an operator-exported `GH_HOST` bakes.)

### D5 — The forced context-unavailable cap leaves the Aone write path

`submit` forces `contextUnavailable: true` for Aone writes because "this
phase has no Aone backing for pr-context" — the premise this change removes.
The force goes away; the Aone path takes the state's claim exactly as GitHub
does (handed through raw, a malformed value refused by compose-review). The
forgery class the force closed — a forged/omitted field composing an APPROVE
— reopens to exactly the level GitHub runs at, where the reads are backed
and the claim stands. comment-status/presubmit remain unbacked, but they
feed the `presubmit` downgrade fields, never `contextUnavailable` (whose
meaning is "pr-context failed or was skipped", per Step 1). Consequence: an
Aone run that read its context can now compose APPROVE, and the wired
`a1 repo mr approve` fires for the first time.

### D6 — Ledger anchors under AGit-Flow: carried, live via the no-ancestry rule

A recovered own-ledger's `sha` rides into the side file and the section's
anchor ruling as on GitHub. Under AGit-Flow the anchored head is amended
(orphaned) on every update, so the ancestry test GitHub's incremental path
relies on would fail for EVERY update; `fetch-pr --since` therefore
resolves Aone anchors with the no-ancestry rule (the parent doc's D7,
shipped by #9630 while this branch was in flight): the anchor-behind-head
test and the merge-base clamp are both skipped, and a recovered anchor
delta-scopes the round to the files the update touched — rebase drift
staying within them keeps the scope, anything wider falls back to
full-range, and no drift byte enters the published scope. The anchor is
LIVE on Aone, not inert: the draft's "inert until #9618" text predates that
landing and was wrong from the merge on.

### D7 — Skill and doc surface

SKILL.md's Aone paragraph: every Aone run is NO LONGER context-unavailable;
`pr-context` runs like GitHub (same failure handling — warn, continue,
context-unavailable state); Agent 0 runs (its welded `issue-context` command
is Aone-backed); `plan-diff` gets `--pr`/`--repo` when the fetch succeeds.
The skip list shrinks to what is still unbacked: `comment-status`,
`presubmit`, `test-plan`, the Step 9 bypass audit, and `publish-assets`.
The repeat-round caveats shrink to the two that remain true (no dedup
backing; no self-PR detection). The "approve does not fire this phase" text
goes. `docs/users/features/code-review.md`'s Aone paragraph and the parent
doc's phase tracker update with it. (Post-write merges shrink the list
again: #9629 lands presubmit's self-PR/drift backing and #9633 the Aone
bypass audit — the merged SKILL.md and user doc carry the live state; this
paragraph records the phase-3b scope as written.)

## Files affected

- `lib/platform/types.ts` — `ReviewContext` types; the two reader members.
- `lib/platform/github.ts` — implementation (extraction of pr-context's
  current calls; `currentUser` passthrough).
- `lib/platform/aone.ts` — implementation over `mr view` + `comment list`;
  whoami mapping.
- `pr-context.ts` — routes through `getPlatformReader({host})`; keeps ALL
  rendering and security logic (blocker promotion, ledger recovery,
  fail-closed identity, truncation discipline) platform-neutral over the
  normalized bundle; PrMetadata's stats become optional; refetch commands
  gain `--pr` on Aone.
- `submit.ts` — the forced cap removed (D5), its comment rewritten.
- `SKILL.md`, `docs/users/features/code-review.md`,
  `docs/design/2026-08-13-review-platform-provider-abstraction.md`
  (phase tracker).

Tests: pr-context's suite passes unmodified (transport seam unchanged);
new tests in `lib/platform/aone.test.ts` for the mapping (channel split,
draft skip, carrier shaping, author fallbacks, stats absence), in
`pr-context.test.ts` for the Aone routing (emitted `--pr` refetches,
degraded diff line, ledger recovery from comments), and the `submit` suites'
forced-cap pins flip to parity pins.

## Open questions

1. ~~The probe-pending shapes above (author field, createdAt, isDraft
   visibility).~~ RESOLVED — see the facts table addendum; the mapping tests
   are pinned to the live shapes.
2. Comment volume: a long-lived odps_src CR's comment list arrives in one
   un-paginated JSON payload; the 64 MiB aone-client bound covers it, but a
   monster thread's context file crosses the read_file threshold — the
   existing size warning + paging guidance already handles that shape.
3. ~~Branch-based MRs carry a branch name in `sourceBranch`, so the provider
   cannot treat it as the head SHA.~~ Resolved for #9620 by verified clone-side
   MR-ref resolution, honest clone-less degradation, and fail-closed safety
   consumers.
