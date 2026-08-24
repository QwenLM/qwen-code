# /review Platform Provider Abstraction (GitHub + Aone Code)

> Status: draft. Scope: make `/review` work against non-GitHub review platforms,
> starting with Aone Code (Alibaba's internal GitLab-based platform), without
> regressing the GitHub path.

## Context

`/review` today is GitHub-only. Every platform operation goes through the `gh`
CLI, and GitHub concepts (the `/pull/<n>` URL grammar, the `pull/<n>/head`
refspec, the Create Review API, `closingIssuesReferences`, GitHub Actions
check-run vocabulary) are hardcoded across ~12 command files, the SKILL.md
prose, and two agent briefs.

The motivating target is the internal `odps_src` repository (MaxCompute engine,
hosted on Aone Code at `gitlab.alibaba-inc.com`, reviewed on
`code.alibaba-inc.com`). Its review model differs from GitHub in ways that
matter to the skill:

- CRs are created by AGit-Flow pushes (`git push origin HEAD:refs/for/master/<feature>`);
  **one CR = one commit**, amended in place on update (multi-commit CRs are CI-rejected).
- Commit messages carry mandatory `[to/fix #AONE_ID]` + `AI-Ratio` trailers.
- The "linked issue" is an Aone **workitem**, not a GitHub issue.
- The platform has **first-class AI-comment handling**: comments carry
  `isAiComment`/`isAiSummary` flags, and there is a merge gate requiring all AI
  comments to be addressed.

## Verified platform facts (probed 2026-08-13 against maxcompute/odps_src)

Everything below was confirmed by running the commands, not from docs.

| Capability                     | GitHub (`gh`)                                                          | Aone Code (`a1` CLI, v0.1.90, already authed)                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review ref                     | `refs/pull/<n>/head`                                                   | `refs/merge-requests/<global-id>/head` — **global id, NOT iid** (8402 refs present)                                                                                                                                   |
| Canonical web URL              | `https://<host>/<o>/<r>/pull/<n>`                                      | `https://code.alibaba-inc.com/<group>/<repo>/codereview/<id>` (from `mr view`'s `detailUrl`)                                                                                                                          |
| Git host vs web host           | same host                                                              | **differ**: git `gitlab.alibaba-inc.com`, web `code.alibaba-inc.com` — needs host-alias handling                                                                                                                      |
| Metadata                       | `gh pr view --json …`                                                  | `a1 repo mr view <id> -f json` → `id, iid, title, description, state, sourceBranch (= head SHA under AGit-Flow), targetBranch, author, assignees, detailUrl`. No additions/deletions stats — compute locally from git |
| Diff                           | `gh pr diff`                                                           | Prefer local `git diff` after fetching the ref; `a1 repo mr diff <id> [file]` as fallback (file list without file arg)                                                                                                |
| Inline comments (read)         | `pulls/<n>/comments`                                                   | `a1 repo mr comment list --mr <id> -f json` → `id, note, author, closed, outdated, path, line, side ("right"/"left"), parentNoteId, isAiComment, isDraft`                                                             |
| Inline comment (write)         | Create Review API, one batched call                                    | `a1 repo mr comment create --mr <id> -m <body> [--file <path> --line <n>] [--reply-to <id>]` — one call per comment                                                                                                   |
| Review verdict                 | events `APPROVE/REQUEST_CHANGES/COMMENT`                               | `a1 repo mr approve <id>` exists; **no native reject** observed                                                                                                                                                       |
| Merge readiness / CI           | check-runs + combined status API                                       | `a1 repo mr status <id> -f json` → `checks[]` (`discussion`, `approver_number`, `test`, `ai_comment`) + `readyToMerge`                                                                                                |
| Linked issues                  | `closingIssuesReferences` + `gh issue view --json title,body,comments` | `a1 repo mr workitem list --mr <id>` → ids; `a1 project workitem get <id> --format json` (title + fields array; body is a team-defined field) + `a1 project workitem comment`                                         |
| Whoami                         | `gh api user --jq .login`                                              | `a1 auth whoami -f json` → `account`                                                                                                                                                                                  |
| Repo identity for bare numbers | `gh repo view --json owner,name,url`                                   | remote URL path (`group/repo`) + `a1 repo view`; `a1 repo link` binding if present                                                                                                                                    |

Post-publication addendum (2026-08-21): the `Inline comment (write)` row
above creates comments that read back `isAiComment: false` — there is no
auto-marking for the posting identity and a1 exposes no flag to request it
(Q4, resolved by a controlled probe — see the open questions section).
Created comments join the `discussion` gate only, never the `ai_comment`
gate.

## Goals / non-goals

**Goals**

1. `/review <aone-cr-url>` and `/review <n>` inside an Aone-hosted clone run the
   full pipeline (worktree fetch, context, agents, verification, terminal report)
   with the same behavior contract as GitHub.
2. `--comment` posts the review to Aone (inline comments + summary + verdict),
   with the same write-discipline invariants (compose-then-post once, no
   throwaway posts, auditable afterwards).
3. Zero regression on the GitHub path: existing tests pass unchanged in behavior.
4. The interface admits a future generic-GitLab provider (via `glab`) without
   reshaping.

**Non-goals**

- Gerrit-native (`refs/changes/`) support, Bitbucket, etc.
- Installing/bootstrapping `a1` for the user; absence is a clean error.
- Repo-specific build/test strategy for Bazel monorepos (Agent 7). Tracked as
  adjacent follow-up: build command discovery needs a repo-config escape hatch
  regardless of platform work.
- Migrating `publish-assets` (GitHub Contents API) to Aone — feature-gated off
  on non-GitHub in v1.
- Content-level GitHub _rules_ (`lib/path-rules.ts` GitHub Actions security
  rules, `script-lint`/`extract-step` workflow parsing) — they key off
  `.github/workflows` files and simply never fire in Aone repos. No change.

## Design decisions

### D1 — The provider boundary is at the operation level, not the transport level

`lib/gh.ts` is already a single transport choke point (exec, retry, pagination,
`GH_HOST` routing, auth check). A "wrap the CLI" abstraction would leak GitHub's
API shape into every call site. Instead, the interface captures **review
operations**. The sketch below is the **end-state** interface the write
operations join in Phase 3; Phase 1 (the `meta` / `issue-context` /
`fetch-diff` / `comment-body` PR, #9096) ships a synchronous, read-only subset
named `ReviewPlatformReader` with exactly the operations those four subcommands
consume (`resolveRepo`, `getPrMeta`, `getClosingIssues`, `getIssue`,
`fetchDiff`, `getCommentBody`) plus the `ensureAuthenticated` gate every one
of them calls first, and a no-arg `getPlatformReader()` registry — the subset
keeps the interface honest (every member has a consumer), and detection
arrives with the second provider:

```ts
// packages/cli/src/commands/review/lib/platform/types.ts
interface ReviewPlatform {
  readonly kind: 'github' | 'aone';

  // Step 1 — target & repo resolution
  parseReviewUrl(url: string): ParsedReviewTarget | null;
  resolveRepo(cwd: string): Promise<RepoIdentity>; // absorbs `gh repo view`
  matchRemote(remotes: GitRemote[], id: RepoIdentity): RemoteMatch;

  // Fetch & context
  ensureAuthenticated(): void;
  fetchReview(req: FetchRequest): Promise<FetchReviewResult>; // refspec + metadata + base
  getContext(req: ReviewRef): Promise<ReviewContext>; // description, comments, verdicts, self

  // Issue Fidelity (Agent 0)
  getLinkedIssueEvidence(req: ReviewRef): Promise<IssueEvidence[]>;

  // Gates
  getCommentStatus(req: ReviewRef): Promise<CommentStatusFacts>;
  presubmit(req: ReviewRef): Promise<PresubmitFacts>; // head drift, CI, prior qwen comments

  // Write (Step 7) & audit (Step 9)
  submitReview(req: SubmitRequest): Promise<SubmitReceipt>;
  composeUrl(ref: ReviewRef, commentId?: string): string;
  auditWrites(req: ReviewRef, window: AuditWindow): Promise<WriteAuditFacts>;
}
```

`github.ts` is an **extraction of existing code** (no behavior change);
`aone.ts` implements the same operations over `a1`.

### D2 — Absorb prose-side `gh` commands into subcommands first

The skill's own history: logic carried in prompt prose ships bugs; the tested
implementation is a subcommand. Today the following are **prose the model
executes**, and each becomes a subcommand (or folds into one) so that SKILL.md
carries zero platform-specific command syntax **the model executes** (the
write-discipline prohibitions that name `gh …` by design, the subcommand-internal
descriptions like "queries `gh pr view`", and Step 4's scratch-repo
render-adjudication carve-out — a deliberately raw `gh api` call, GitHub-specific
by nature — remain, to be re-authored or gated in Phase 3):

| Prose today                                                                               | New home                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh repo view` owner/repo/host derivation (bare PR numbers; Step 1 & 7)                   | `qwen review meta <n>` — one call returning `{platform, ownerRepo, host, headSha, webUrl}`                                                                                                                                                                                                  |
| `gh pr view --json headRefOid` head-SHA fallbacks (Step 7, 422 recovery)                  | same `meta` subcommand                                                                                                                                                                                                                                                                      |
| Agent 0's `closingIssuesReferences` + `gh issue view` pair                                | `qwen review issue-context <n> --out <file>` — emits the evidence markdown; GitHub: closing issues + bodies + comments; Aone: workitems + fields + comments                                                                                                                                 |
| `gh pr diff` (lightweight cross-repo mode)                                                | `qwen review fetch-diff <target>`                                                                                                                                                                                                                                                           |
| `gh api repos/…/pulls/comments/<id>` refetch refs that `pr-context` emits into context.md | emit `qwen review comment-body <id>` commands instead (provider-routed)                                                                                                                                                                                                                     |
| `GH_HOST=<host>` prefixing rule for all model-run gh calls                                | gone for every call; the Step 4 carve-out (the one remaining model-run `gh api`) carries no host routing of its own — it routes at the Enterprise host only when `GH_HOST` is exported in the environment (subagent shells inherit it), and is unavailable otherwise. Phase 3 re-authors it |

This phase is GitHub-only behavior-preserving and independently shippable: it
removes the exact class of prose-carried failures the skill has measured, even
before Aone lands.

### D3 — Aone transport is the `a1` CLI, not raw HTTP

`a1` owns authentication (`a1 auth login`, token storage in
`~/.config/a1/config.yaml`), exposes `-f json` everywhere we need, and is
already the org-standard tool. Raw HTTP would mean re-implementing auth and
tracking an unstable internal API. The a1 invocations sit behind a thin
`aone-client.ts` mirroring `lib/gh.ts`'s shape (`execFileSync('a1', …)`, no
shell, JSON parse, transient-retry on idempotent reads, no retry on writes), so
a future HTTP client replaces one file. Provider checks `a1` presence + version
at `ensureAuthenticated()` and fails with an actionable message otherwise.

### D4 — Detection: URL grammar first, remote probing second, settings override last

- `parse-args` gains two URL grammars: `…/codereview/<id>` (Aone canonical) and
  `…/merge_requests/<n>` (GitLab-shaped; accepted and routed to the Aone
  provider when the host matches an Aone mapping, refused with a clear message
  otherwise — reserving the grammar for a future glab provider). The verdict
  carries `platform`.
- Bare numbers: probe git remotes. Known host patterns (`github.com`, GHE via
  `GH_HOST`/`--host`) → GitHub; hosts matching the Aone mapping (initially the
  `*.alibaba-inc.com` pair, configurable) → Aone, repo path from the remote URL.
- Host aliasing (web `code.alibaba-inc.com` ↔ git `gitlab.alibaba-inc.com`)
  lives in a small mapping table in the Aone provider, overridable via settings
  (`review.platforms[]`) so other Aone-hosted pairs need no code change.
- `match-remote` becomes platform-aware: on Aone, match by **repo path**
  (group/repo) after alias-normalizing the host.

### D5 — Aone review identity is the global MR `id`, never the `iid`

Everything on Aone keys on the global id: the web URL, the git ref, and every
`a1 repo mr` subcommand. The `iid` appears only in list output and is
display-only. `parse-args` treats the number in a `/codereview/<id>` URL as the
id directly; no id↔iid mapping is needed anywhere in the pipeline.

### D6 — Verdict mapping on Aone

- `APPROVE` → `a1 repo mr approve` (after the summary comment lands).
- `COMMENT` → summary comment only.
- `REQUEST_CHANGES` → **no native reject exists on Aone**. Post the summary
  comment with an explicit blocking header (`**Request changes**` + marker).
  The merge gate already blocks on unresolved discussions, so inline Critical
  comments left unresolved carry the blocking semantics. This is a semantic
  difference from GitHub and is called out in the terminal report.
- AI-comment marking: **probed 2026-08-21 (Q4 resolved — see the open
  questions section).** `comment create` does NOT auto-set `isAiComment` for
  the posting identity, and a1 (v0.1.90) has no flag to request it, so
  qwen-posted comments join the generic `discussion` gate only — the
  dedicated `ai_comment` merge gate does not track them. Until a1 ships a
  marking flag, `submit`'s REQUEST_CHANGES note discloses the gate split;
  the marking itself is blocked on the a1 feature request.

### D7 — One-commit CRs and the incremental cache

Under AGit-Flow, updating a CR amends the single commit: the old head SHA is
orphaned, so an ancestry test (`merge-base --is-ancestor <cached> <new>`) fails
for **every** update — the amend's H2 has H1's parent, never H1 itself. The
incremental rule for Aone therefore does not test ancestry at all: both heads
are local after fetch, so `git diff <cachedSha>..<newSha>` **is** the update's
delta (for a pure amend, exactly the amended lines; if the author also rebased
onto newer master, the range additionally carries the rebase drift, which the
re-review should see anyway). `presubmit`'s head-drift check likewise compares
the live `sourceBranch` SHA (it is the head) against the reviewed SHA, with
local git, not a platform compare API — none exists on Aone.

### D8 — Feature-gate GitHub-only capabilities

`publish-assets` (Contents API) is GitHub-only in v1: on Aone, steps that would
publish image assets degrade to embedding nothing and noting the skip.
`cleanup`'s bypass audit maps to `comment list` filtered by
`author.account == whoami()` within the audit window. Everything else
(capture-local, findings, verification, reverse audit, build-test,
save-artifact, cost-ledger) is platform-neutral already — with one
qualification: `plan-diff` gains a `--host` option in Phase 1 (recorded into
the plan as the host carrier for lightweight runs, read by the welded Agent 0
command), so its platform dimension is the recorded host, not any API call.

### D9 — Bound the diff: keep existing command/file names

`fetch-pr`, `pr-context`, `pr-number` target types, and the SKILL.md step
structure keep their names; "PR" remains the user-facing vocabulary. The
provider is an internal parameter. Renaming everything to neutral terms would
double the diff for no behavioral gain.

## File layout

```
packages/cli/src/commands/review/lib/platform/
  types.ts         — ReviewPlatform + shared request/result types
  registry.ts      — detect(target, cwd, settings) → platform
  github.ts        — extraction of today's logic (Phase 1 note: lib/gh.ts
                     gained the untouched-bytes ghRaw transport and empty-flag
                     host normalisation, and github.ts consumes ghRaw;
                     existing call behavior otherwise unchanged)
  aone-client.ts   — a1 exec wrapper (execFileSync, -f json, retry policy)
  aone.ts          — Aone implementation
```

New/changed subcommands: `meta` (new), `issue-context` (new), `fetch-diff`
(new), `comment-body` (new); `parse-args`, `match-remote`, `fetch-pr`,
`pr-context`, `comment-status`, `presubmit`, `submit`, `compose-review`,
`cleanup`, `test-plan` route through the registry; `plan-diff` gains `--host`
(recorded into the plan — see D8).

`agent-briefs.ts` (Agent 0 brief, scratch-repo carve-out) and `agent-prompt.ts`
(`gh pr view` fallback warning) are re-authored to reference subcommands only —
with one deliberate exception: the Step 4 render-adjudication carve-out stays a
raw `gh api repos/$QWEN_REVIEW_SCRATCH_REPO/issues/<n>/comments` call inside the
verifier brief, because what it adjudicates is GitHub's own rendering; it is
GitHub-specific by nature and gains a host-routing note in SKILL.md's
Enterprise paragraph.

## Phasing

- **Phase 0 — extract (pure refactor).** `github.ts` behind the interface;
  behavior identical; existing tests pin behavior. SKILL.md untouched.
- **Phase 1 — prose absorption (GitHub-only).** The four new subcommands;
  SKILL.md + briefs re-authored; GitHub behavior unchanged. Shippable on its
  own merits. Note: unlike Phase 0, the subcommand/provider code here is NEW
  implementation of operations that previously existed only as prose —
  nothing pre-existing pinned them; their behavior is pinned by tests added
  in the phase-1 PR itself (as merged: PR #9096's own tests).
- **Phase 2 — Aone read path.** `aone-client`, detection, fetch, context,
  issue-context, comment-status, presubmit (read-only parts). Full local review
  of an Aone CR works; `--comment` on an Aone target refuses with a clear
  message. E2E: review a real odps_src CR locally.
- **Phase 3 — Aone write path.** `submit` (batched inline + summary + verdict),
  `composeUrl`, cleanup audit, AI-comment marking. Also owns the deferred
  render-adjudication carve-out: either re-author it per provider (the
  Enterprise host must reach the verifier subagent — SKILL.md currently says
  exported-GH_HOST only, and "unavailable otherwise"), or gate it off
  explicitly on non-github.com runs. E2E: `--comment` against a
  scratch/test CR.
  - **Landed (2026-08-19):** the `submit` slice. `submitAoneReview` in
    `lib/platform/aone.ts` posts the review as N+1 calls — one
    `a1 repo mr comment create` per inline finding, the summary comment
    last (Q5 order), `a1 repo mr approve` on APPROVE (D6); writes ride a
    no-retry transport (`a1Once`) so a transient retry can never
    double-post. The commit_id gate GitHub enforces server-side lives in
    the provider as a pre-write head-drift refusal; a mid-batch failure
    throws `AonePartialPostError` naming exactly what landed, and
    `submit` reports it exit-3 with do-not-re-run advice (a retry would
    duplicate). REQUEST_CHANGES posts the blocking summary header (D6);
    the recorded-but-hostless refusal stays fail-closed, now between two
    WRITABLE platforms. The created-comment read-back is tolerant: an
    exec failure still propagates, but an ACCEPTED write whose answer
    fails to parse degrades to "landed, id unknown" — counting it as
    unposted would re-post it on a retry. Two deliberate trade-offs to
    revisit when the Q4-era response changes land: the head-drift gate is
    fail-OPEN on an empty `sourceBranch` (a `mr view` shape regression
    must not brick posting), and the id read-back parses a set of
    tolerated shapes best-effort. Still open: `composeUrl`, cleanup
    audit, AI-comment marking (Q4), the render-adjudication carve-out.
  - **Hardened (2026-08-19, review round 2):** five write-safety fixes
    from the maintainer review of #9491. (1) The `target-platform-unbound`
    refusal now HONOURS its own remedy — an explicit `--host` on the
    re-run is platform proof and lifts it, instead of refusing again.
    (2) The write gate binds hosts through `hostsEquivalent`, not raw
    equality — Aone's web/git host pair is one platform. (3) Write
    routing keys on the CANONICAL Aone pair (`isAoneCanonicalHost`),
    never the family wildcard (a `*.alibaba-inc.com` GHE host is not
    Aone), never the ambient GH_HOST (reads never detect from it), and
    an explicit `--host` outranks the recorded binding in both
    directions. (4) A size gate refuses any message over the
    131072-byte single-argv-element limit a1 must pass it as, BEFORE
    any write lands (a long CJK summary is inside compose-review's
    char cap and outside the OS byte limit). (5) An exec failure counts
    as possibly-landed (`ambiguous`), so submit's do-not-re-run advisory
    fires even when the count is zero — an accepted-then-died write must
    never read back as a clean total failure.
  - **Hardened further (2026-08-20, verify-lane review of #9491):** the
    sandboxed-verification review surfaced the next layer. (6) The
    fail-closed refusal now also fires when NO recording exists at all —
    a `--user-authorized` publish invoked from another directory finds
    nothing, and the cwd probe alone must not pick the platform of an
    irreversible write. (7) The gh write rebinds its routing host to the
    same evidence that selected it (`explicitHost ?? recordedHost`), so a
    recorded non-canonical host (a GHE instance) no longer posts wherever
    the ambient env pointed. (8) The REQUEST_CHANGES terminal note is
    conditioned on the inline Criticals actually posted — a body-only
    Critical posts no discussion threads, so nothing mechanically blocks
    the merge and the note says so. (9) `a1Cause` reads the captured
    stderr, not the execFileSync message — the message embeds the FULL
    argv (the multi-line comment body), so parsing it surfaced the
    operator's review text instead of a1's error. (10) The summary
    skip-guard keys on the posted `summaryMessage`, not the raw body — an
    empty-body REQUEST_CHANGES still posts its blocking header, the
    verdict's sole carrier. Host comparison is normalised once
    (`normalizeHostSpelling`: case/port/trailing-dot) and shared by
    `hostsEquivalent` and `isAoneCanonicalHost`; the fast-path repo axis
    binds case-insensitively; the cross-session scan is last-writer-wins
    by mtime, and the newest same-PR recording decides (host or unbound)
    instead of harvesting an older session's stale host.
  - **Hardened again (2026-08-20, third review round of #9491):** the
    next review pass found the layer under that one. (11) The cwd arm of
    the write gate now probes the origin through the canonical predicate
    itself instead of delegating to the registry's family-wildcard
    detection — a `ghe.alibaba-inc.com` origin no longer takes the a1
    path. (12) `submit` FORCES context-unavailable into the compose input
    on the Aone path — the cap no longer rides the model-written state,
    so an omitted field cannot buy a real platform approval; the docs now
    say the native approve does not fire this phase. (13) A mid-batch
    failure now emits `"partial": true` with the landed counts/ids —
    `posted: false` alone invited a wrapper retry that double-posts; and
    a deliberate pre-write refusal (drift, oversized) reads as
    `aone-post-refused`, while an UNEXPECTED pre-write error rethrows
    (gh parity — nothing landed, a re-run is safe). (14) The floor
    recovery's host axis binds to the host the write routes at
    (explicit ?? recorded ?? gh fallback), so a flagless Aone post no
    longer drops the operator's recorded floor. (15) The batch re-reads
    the head once after posting and discloses a mid-batch amend
    (`headMovedDuringPost`) instead of claiming the pins held. The
    approve-failure and oversized refusals name the USER as the manual
    actor; the completion contract reads `partial`/`approved`; and the
    repeat-round caveats (no dedup backing, no self-PR detection) are
    documented for the user. Still open: dedup/self-PR backing for Aone,
    `composeUrl`, AI-comment marking (Q4), the
    render-adjudication carve-out.
  - **Anchored (2026-08-21, issue #9615):** Q2's controlled probe
    (scratch MR 29427547 of base-biz/sqlt, a1 v0.2.51) proved the
    platform posts ANY `--line` unvalidated and cannot express the old
    side — an old-side number silently becomes the same-numbered
    new-side line. `submit`'s Aone branch now validates every inline
    anchor against the review's captured diff BEFORE posting: an
    unanchorable Critical is relocated into the summary body, an
    unanchorable Suggestion discarded and counted (the GitHub
    422-recovery dispose, performed in code), each disclosed in the
    terminal; a missing captured diff refuses the whole post. Probe
    evidence and pinned semantics:
    `docs/design/2026-08-21-review-aone-removed-line-anchoring.md`.

  - **Landed (2026-08-21, #9617):** the cleanup bypass audit — D8's
    "`comment list` filtered by author within the audit window". `cleanup`
    selects the audit backend from the fetch report's recorded host, with
    the registry's cwd-origin fall-through for a hostless report (a
    bare-number Aone run that omitted `--host`), so an Aone window is
    never audited against GitHub — the misroute that queried github.com's
    same-named repo (host null) or pointed gh at a host it has no auth on
    (host recorded), skipping the tripwire either way. The author arm
    keys on `author.username == aoneWhoamiAccount()`; the window arm
    compares epoch milliseconds, because Aone stamps a numeric utc offset
    (`+08:00`) and a lexicographic comparison across offsets orders by
    local wall clock, not instant. Sanctioned-vs-bypass keys on COMMENT
    ids — Aone's submit posts comments, not a review — so the submit
    receipt grew a `commentIds` axis beside `reviewIds`, written on a
    successful post (inline ids + summary id) and on a mid-batch failure
    (the landed ids) so the audit never flags submit's own writes; an id
    never read back is unvouchable and may draw a flag (fail-safe). The
    automation-marker filter and the best-effort skip note carry over
    unchanged; the audit stays read-only and offline-safe. Hardened by the
    change's own review round, which measured two more platform facts: the
    default `comment list` EXCLUDES resolved comments (an MR's `comments`
    minus `closedComments` is exactly what it returns), so the audit
    unions a `--resolved` query — a posted-then-resolved bypass inside the
    window is still flagged — but judges a resolved comment by its
    CREATION only, because a resolution bumps `updatedAt` exactly like an
    edit and is not edit evidence; and a1 can answer a well-formed
    `a1.error/v1` error object with exit 0 (a backend auth failure or a
    client timeout), whose `message` now rides the skip note instead of a
    bare "unexpected shape". Five disclosed residuals: resolved REPLIES
    have no a1 listing at all; an EDIT of a receipt-vouched
    (submit-posted) comment is outside the tripwire's sight — the
    `updatedAt` bump cannot be told from a resolution or other state flip,
    so detecting it would flag healthy runs, and a1 has no comment-edit
    subcommand to begin with (the GitHub twin's sanctioned channel, the
    review, is likewise uneditable); an edit of an UNVOUCHED
    pre-window comment is invisible once its discussion is resolved — the
    `--resolved` union lists it, but the posted arm keys on creation
    inside the window and the edited arm skips resolved comments, so a
    resolved comment is judged by creation only; the comment listing is
    UNPAGED — one `comment list` per query, and a1 documents no page-size
    guarantee, so if a cap exists, comments past it stay invisible to the
    audit; and `a1 repo mr approve` / `a1 repo mr edit` writes — banned
    by SKILL.md's Step 7 write ban — are outside the tripwire's coverage,
    the recorded a1 surface exposing no listing an audit could query for
    approvals or MR-metadata edits (`mr view`'s recorded shape carries no
    approval state).
  - **AI-gate probe (2026-08-21, issue #9614):** Q4 was resolved by a
    controlled write probe on a scratch CR — `comment create` auto-sets
    NOTHING (both a general and an inline probe read back
    `isAiComment: false`, re-checked against an async classifier), and
    v0.1.90 exposes no marking flag — and Q3 was re-confirmed (still no
    native reject; `mr comment resolve` and `mr cr list` are new on the
    surface). Since the marking cannot be requested today, the write path
    DISCLOSES the gate split instead of silently implying participation:
    the REQUEST_CHANGES note names the posted comments as unflagged, joins
    them to the discussion gate only, and says the repo's `ai_comment`
    gate does not track them; SKILL.md's Aone paragraph carries the same
    fact for the relay. Marking stays open as an a1 feature request; when
    the flag ships it wires at `createMrComment` (the sole write seam).
    Still open: dedup/self-PR backing for Aone, `composeUrl`, the
    ai_comment marking flag (a1-side), the render-adjudication carve-out.
  - **Self-PR backing (2026-08-21, #9616):** `presubmit` became
    platform-aware. On an Aone target it runs the backed slice —
    self-PR detection (`a1 auth whoami`'s `account` vs the `mr view`
    author, one fetch, case-insensitive, fail-soft on a missing author,
    fail-closed on a thrown `mr view`) and head drift (`sourceBranch` IS
    the head under AGit-Flow; no compare API exists, so `compare` is
    null and a drifted head is always anchors-at-risk) — and reports the
    unbacked slice neutral (`no_checks` with zero checks, zero existing
    comments: no downgrades from them, no overlap blocks). Same report
    shape as GitHub, so Step 7's apply-the-report rules and
    compose-review's downgrade fields are unchanged; the verdict cap
    stays forced in `submit` (pr-context is still unbacked). SKILL.md's
    Aone list names presubmit as reduced-backing instead of skipped, and
    the "no self-PR detection" caveat is gone from both docs. Still
    open: dedup backing for Aone, `composeUrl`, the
    ai_comment marking flag (a1-side), the render-adjudication
    carve-out.
  - **Residuals closed (2026-08-21, #9619):** three small gaps, one pass.
    (a) `composeUrl` joined the reader interface — in the spirit of the
    sketch's provider-owned URL composition, scoped to the `Posted:`
    line (`(prNumber, ownerRepo)` → the PR/MR page URL; the sketch's
    deeper comment-anchor variant stays future work): GitHub COMPOSES
    the PR-page URL from the routed host (deterministic grammar, no API
    call), normalised through the ONE host-spelling helper the comment
    anchors use (`normalizeGhHostForUrl`), and `submit` fills a GitHub
    receipt that carries no `html_url` through it. Aone is reader-backed
    — the platform's own `detailUrl`, never assembled, because the
    owner/repo collapse to the last two segments names a different repo
    for a nested-group project — but Aone's `submit` does NOT re-query
    through it: the pre-write drift-gate read already carries the same
    stable field, so a second fetch cannot add a link (round-2 review
    R1-4), and an empty receipt rides the coordinates relay. (b)
    `test-plan`'s body fetch routes through the platform reader — the
    MR description on Aone, already carried by the reader's fetch
    metadata, so the check runs on Aone targets instead of being
    skipped, and no new API surface landed; the Aone arm runs the same
    `ensureAuthenticated` gate every other a1-backed flow runs first
    (round-2 review R1-5), and the handler wiring is pinned by a
    handler-level test (R1-6). (c) Q1's version floor is enforced in
    `ensureAoneAuthenticated` — resolved to 0.1.90, the version the
    platform facts were probed against (nothing older was verified);
    presence → floor → auth, each with its own remedy; both fail-open
    arms (failed probe, unparseable output) disclose on stderr with the
    CAUSE extracted past the execFileSync preamble (R1-1), and the
    composeUrl failure arm discloses too (R1-2). The floor check shares
    the gate #9616's self-PR read passes through: `ensureAoneAuthenticated`
    now returns the whoami account (`--format json`, one spawn), so the
    version floor applies to the presubmit seam as well. Still open:
    dedup backing for Aone, the ai_comment marking flag
    (a1-side), the render-adjudication carve-out.
  - **Landed (2026-08-21, #9627): the dedup backing for Aone** —
    `comment-status` and `presubmit` route an Aone target at the a1 reads
    (`mr view` author+head, `mr status` gates, `mr comment list`,
    `auth whoami`) and reuse the SAME pure classification core the GitHub
    path pins, so the buckets, the downgrade flags, and the report schema
    stay one contract. The a1 shape differences map onto the GitHub
    inputs: threads ride `parentNoteId`, a `closed` thread is the engaged
    (resolved) bucket, an `outdated` thread takes the stale bucket (its
    line was rewritten — a new finding there still posts), comments carry
    NO commit anchor (code facts degrade to `unknown`; nothing is stale by
    commit), and drift has no compare API (anchorsAtRisk fails safe). The
    context-unavailable cap stays until `pr-context` lands. Still open:
    pr-context Aone backing, the ai_comment marking flag (a1-side), the
    render-adjudication carve-out.

- **Phase 3b — Aone `pr-context` backing (this change).** The reader gains
  `getReviewContext` + `getCurrentUser` (D1's `getContext` + `self`,
  synchronous). `pr-context` routes through the platform reader; the
  normalized bundle keeps ALL rendering and security logic platform-neutral.
  GitHub's implementation EXTRACTS pr-context's existing gh calls
  unchanged — the existing suite passing unmodified is the no-regression
  evidence. On Aone: metadata from `mr view` (stats degrade), one flat
  comment list split by `path`, no verdicts, ledger carriers = the
  thread-level comments (the posted summaries); refetch commands bake
  `--pr` (Aone addresses every comment body per-MR) and bake only an
  explicit `--host` (never the ambient GH_HOST). The forced
  context-unavailable cap leaves submit (the reads are backed now), so an
  Aone run that read its context can APPROVE and the wired
  `a1 repo mr approve` fires. Agent 0 becomes runnable on Aone (its gate
  is pr-context success; its welded `issue-context` command is already
  backed). Design: `2026-08-21-review-aone-pr-context.md`. Still open: the
  Phase-3 open items above, unchanged.
- **Phase 4 — semantic gaps.** Incremental-cache ancestry fallback, build-test
  repo-config escape hatch, publish-assets gating polish, generic-GitLab
  (glab) evaluation.
  - **Landed (2026-08-21): the incremental-cache ancestry fallback (D7,
    #9618).** `resolveIncrementalAnchor` gained a `noAncestry` mode that
    `fetch-pr` selects when the platform is Aone: an AGit-Flow update
    AMENDS the single CR commit in place, orphaning the cached head, so
    the anchor-behind-head test failed for EVERY update and an
    amend-and-re-review never scoped. Both ancestry tests — the
    anchor-behind-head test and the behind-merge-base clamp — are
    skipped (the clamp only ever fired when the update ALSO rebased onto
    newer master, moving the merge base past the cached head; a pure
    amend passed it); after the fetch both heads are local, so
    `anchor..head` IS the update's delta, and the narrowing step
    assembles the published scope from the CR's own diff exactly as it
    does for an ancestrally valid GitHub anchor (an amended-and-rebased
    update's delta carries the rebase drift, but the join reads it only
    for which files changed — no drift byte reaches the published scope
    — and drift touching a file outside the CR's diff falls back to the
    full range there).
    The existence checks and the `base-untrusted` refusal stay — they
    guard presence and the base-derived capture, not the lineage. The
    head-drift checks Aone has were confirmed to compare the live
    `sourceBranch` SHA against the reviewed SHA the same way D7 names —
    submit's pre-write gate and mid-batch re-read, and fetch-pr's resume
    probe; none consults a platform compare API or an ancestry test.
    GitHub keeps the tests: there an ancestor-less anchor is a
    force-push, and the tests are the detection.

## Testing strategy

- Provider contract tests: a shared suite run against `github.ts` with `gh`
  mocked and `aone.ts` with `a1` mocked (fixture JSON captured from real calls
  — the shapes in the facts table). The mock seam is the transport choke point
  (`lib/gh.ts` today, `aone-client.ts` for Aone); full-pipeline E2E without a
  model remains covered by the existing `mock-provider.ts` LLM endpoint.
- Golden-path E2E per phase against odps_src (internal, manual): local review
  of CR 28230262-class targets; write path only against a scratch CR.
- Phase 0 keeps every existing GitHub-path test passing unmodified. From
  Phase 1 on, an existing test may change only where an absorbed subcommand
  intentionally changes output (Phase 1 itself modified the pins that asserted
  the old emitted `gh api …` text — they now assert the `comment-body`
  command); each such modification is called out in the phase's PR. Everything
  else passing unmodified is the no-regression evidence.

## Open questions

1. **Q1 — a1 minimum version.** ~~Which `a1` version introduced `mr comment
create --file/--line` and `-f json` stability? Provider version floor TBD.~~
   Resolved (2026-08-21, #9619): the floor is **0.1.90** — the version the
   platform facts above were probed against; nothing older was verified, and
   the exact introducing version is not recoverable from outside Alibaba.
   `ensureAoneAuthenticated` enforces it (presence → floor → auth) with an
   actionable upgrade message; an unparseable `--version` and a failed
   probe alike are disclosed on stderr and fail OPEN, never refusing an
   a1 the check merely cannot read.
2. **Q2 — Inline anchor semantics. RESOLVED (2026-08-21).** The controlled
   probe (scratch MR 29427547 of base-biz/sqlt, a1 v0.2.51) proved: `--line`
   is new-side only (no `--side` flag exists; an old-side number silently
   becomes the same-numbered new-side line), the server performs ZERO anchor
   validation (even beyond-EOF lines post), and `--file` without `--line`
   drops the path entirely (file-level is MR-level in disguise). Semantics
   pinned in `docs/design/2026-08-21-review-aone-removed-line-anchoring.md`:
   client-side hunk validation in submit's Aone branch, with the GitHub
   422-recovery degrade (Critical → body, Suggestion → discarded) performed
   in code and disclosed in the terminal.
3. **Q3 — REQUEST_CHANGES.** ~~Confirm no native reject/unapprove API
   exists.~~ **Re-confirmed 2026-08-21 on a1 v0.1.90:** the `repo mr` surface
   (approve/close/comment/cr/create/diff/edit/list/merge/remind/reopen/
   reviewers/status/view/workitem) still has no reject/request-changes/
   unapprove. The blocking header stands. Two surface changes observed:
   `mr comment resolve` (inline comments only) and `mr cr list` now exist;
   the a1 FAQ documents `mr create --enable-ai-review`, but the v0.1.90
   binary refuses it (`unknown flag`).
4. **Q4 — AI-comment marking.** ~~Does `comment create` auto-set
   `isAiComment`?~~ **Resolved 2026-08-21 by a controlled probe** (scratch
   CR on a scratch repo, posting identity a personal account): one general
   and one inline comment posted via `a1 repo mr comment create` both read
   back `isAiComment: false` — immediately and ~3 min later (async
   classifier ruled out) — and v0.1.90 exposes no marking flag. Read-side
   corroboration: across 68 recent MRs on maxcompute/odps_src (a repo whose
   gates include `ai_comment`) zero comments carried the flag — CI-bot and
   human-posted "AI 评审" comments alike — so it is neither identity- nor
   content-derived; it appears to be server-side state only the platform's
   own AI-review service sets. Qwen comments therefore fall under the
   `discussion` gate only; the remedy is a marking flag requested from the
   a1 CLI (feature request), wired at `createMrComment` when it ships.
5. **Q5 — Partial failure in batched submit.** GitHub's Create Review is
   atomic; Aone is N+1 calls. Policy: post inline first, summary last (summary
   references nothing not yet posted), and on mid-batch failure report exactly
   which comment ids landed so cleanup's audit stays meaningful. Confirm
   idempotency/markers suffice for a retry-safe resume.
6. **Q6 — workitem body field.** `project workitem get` returns a team-defined
   `fields[]` array; the description identifier varies by project. The
   issue-context extractor must locate the body heuristically (label match
   like 描述/description) — validate across a few ODPS*SQL*\* workitem types.

## Alternatives considered

- **Generic GitLab first (via `glab`)**: Aone Code is GitLab-based, so `glab`
  might half-work — but workitem linkage, AGit-Flow refs, AI-comment gates, and
  the `/codereview/` URL form are Aone-specific, and `glab` isn't installed or
  authed on the target machines while `a1` is. The interface admits glab later;
  starting there serves no current user.
- **Raw Aone HTTP API**: rejected (D3) — auth re-implementation against an
  unstable internal API.
- **Lightweight-only support** (diff-only, no fetch/context/post): viable as a
  stopgap but fails the actual goal — the team's workflow needs posted,
  gate-aware reviews, and diff-only mode forbids APPROVE by design.
