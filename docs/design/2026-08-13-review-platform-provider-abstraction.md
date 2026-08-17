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
- AI-comment marking: probe whether `comment create` sets `isAiComment`
  automatically or needs a flag; qwen-posted comments SHOULD carry it, because
  Aone has a dedicated `ai_comment` merge gate. (Open question Q4.)

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
- **Phase 4 — semantic gaps.** Incremental-cache ancestry fallback, build-test
  repo-config escape hatch, publish-assets gating polish, generic-GitLab
  (glab) evaluation.

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

1. **Q1 — a1 minimum version.** Which `a1` version introduced `mr comment
create --file/--line` and `-f json` stability? Provider version floor TBD.
2. **Q2 — Inline anchor semantics.** Does `--line` accept only new-side lines?
   How are removed-line (`side: left`) comments posted? Needs a controlled
   experiment on a scratch CR.
3. **Q3 — REQUEST_CHANGES.** Confirm no native reject/unapprove API exists
   (a1 surface + platform docs); if one exists, prefer it over the blocking
   header.
4. **Q4 — AI-comment marking.** Does `comment create` auto-set `isAiComment`
   for bot/token identities, or is there a flag? Determines whether qwen
   comments fall under the `ai_comment` merge gate or the `discussion` gate.
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
