# Phase 2: Aone Code read path for /review

> Status: draft. Parent: `docs/design/2026-08-13-review-platform-provider-abstraction.md`.
> Phase 0+1 (GitHub provider) merged as #9096 (`dc7e234876`).

## Problem

Phase 0+1 added the `ReviewPlatformReader` seam with one provider (GitHub).
`/review` still cannot review a MaxCompute CR on Aone Code (`odps_src`), which
is the motivating target. This phase adds the Aone read path so a local review
of an Aone CR works end to end (diff + worktree + issue evidence + agent
findings), and `--comment` on an Aone target refuses cleanly.

## Verified platform facts (re-confirmed 2026-08-29 across both Aone MR flows)

| Capability     | a1 CLI / git                                                                                                                                  | Notes                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MR metadata    | `a1 repo mr view <global-id> --repo <g/p> -f json` → `mergeRequest{sourceBranch, targetBranch, title, description, detailUrl, author, state}` | `sourceBranch` is the full head SHA under AGit-Flow but a branch name under branch-based flow; there is no separate pre-merge head-SHA field. `targetBranch` is base; **no** diff stats are reported. |
| Fetch ref      | `git fetch <remote> refs/merge-requests/<global-id>/head:<ref>`                                                                               | The exact MR ref is authoritative in both flows. A verified target clone can resolve it with `git ls-remote`; merge-base vs `targetBranch` and `git diff` are computable.                             |
| id/iid         | `mr view`/`mr list` carry both `id` (global) and `iid`                                                                                        | refs/`mr view` key on the **global id**; Aone CR URL is `/codereview/<global-id>`                                                                                                                     |
| Discussion     | `a1 repo mr comment list --mr <id> --repo <g/p> -f json` → array with `id, note, path, line, author, closed, outdated, isAiComment`           | **text is in `note`** (not `body`); `body` is empty                                                                                                                                                   |
| Issue evidence | `a1 repo mr workitem list --mr <id>` → `[{id, subject, link, assigned_to}]`; `a1 project workitem get <id>` for body/comments                 | workitem id = the `#AONE_ID` in the commit title                                                                                                                                                      |
| Diff listing   | `a1 repo mr diff <id>` (file list) / `<id> <file>` (per-file)                                                                                 | only needed in lightweight mode; the primary path diffs via git after fetching the ref                                                                                                                |
| CI status      | `a1 repo mr status <id>`                                                                                                                      | presubmit-equivalent (read-only)                                                                                                                                                                      |

## Proposed scope (vertical slice — confirm before implementing)

**In scope (makes local Aone review work):**

1. `lib/platform/aone-client.ts` — a1 transport sibling to `lib/gh.ts`,
   replicating its contract: `execFileSync` without shell, transient retry only
   on idempotent reads, byte mode for diffs, actionable auth check
   (`a1 auth whoami`), and `--repo` threading (Aone has no `GH_HOST` analogue;
   the repo coordinate is passed per call).
2. `lib/platform/aone.ts` — implements `ReviewPlatformReader`:
   `resolveRepo` (parse the clone's origin URL → `gitlab.alibaba-inc.com/<g>/<p>`),
   `getPrMeta` (mr view + verified MR-ref resolution → head SHA/detailUrl), `getClosingIssues` (workitem
   list), `getIssue` (workitem get), `fetchDiff` (git-based after fetching the
   ref; a1 per-file diff only for lightweight mode), `getCommentBody` (read
   `note` from comment list).
3. **Detection** in `registry.ts`: select the platform from (a) an explicit
   `--host` whose host is an Aone host, (b) an explicit `--remote` URL on an
   Aone host, else (c) the cwd clone's origin. An explicit NON-Aone
   host/remote beats the cwd probe (so an explicitly-GitHub subcommand run
   from an Aone clone is not hijacked). The four reader-backed subcommands
   (meta/issue-context/fetch-diff/comment-body) thread `--host` into
   detection; fetch-pr threads the remote URL. (An explicit `--platform`
   override is deferred — an explicit `--host` already serves as the
   practical override.)
4. `fetch-pr.ts` — provider-aware refspec + metadata: Aone uses
   `refs/merge-requests/<global-id>/head` and mr-view metadata (no
   additions/deletions — compute from the fetched diff). This is the enabler
   for worktree mode, build/test, and the full agent review.

**Deferred to a follow-up (degrade gracefully in this phase):**

- `pr-context.ts` discussion rendering (inline threads, review summaries,
  ledger): Aone has comments but no GitHub review-summary model. For v1, Aone
  runs enter the existing **context-unavailable** mode (verdict caps at
  COMMENT; findings still generated). Note Agent 0 (issue fidelity) is gated
  on `pr-context` success, so it is SKIPPED on Aone too — `issue-context`
  works standalone for the workitem evidence but is not wired to Agent 0.
- `comment-status.ts` anchor-status and `presubmit.ts` CI checks: skip for
  Aone v1 (the skill already handles their absence). **Landed (2026-08-21):**
  both subcommands are a1-backed, reusing the same pure classification cores
  the GitHub path pins — see the Phase 3 note in
  `2026-08-13-review-platform-provider-abstraction.md` for the shape mapping
  (parentNoteId threading, `closed` → resolved, `outdated` → stale, no
  commit anchors, drift with no compare API). Of the flows deferred in
  this section, only `pr-context` remains unbacked (the
  context-unavailable cap stays until it lands).

_Update (2026-08-21, #9619): `test-plan` is no longer unbacked — its body
fetch routes through the platform reader (the MR description on Aone, already
carried by the reader's fetch metadata), so the Test Plan check runs on Aone
targets like any other._

~~`--comment` on an Aone target refuses with a clear message (posting is Phase 3).~~
**Superseded — Phase 3 landed.** `--comment` on an Aone target POSTS: `submit`
routes the write at `submitAoneReview` (one `a1 repo mr comment create` per
inline finding, then the summary comment, `a1 repo mr approve` on APPROVE).
See the "Landed" entries in
`2026-08-13-review-platform-provider-abstraction.md` for the write-safety
semantics (head-drift refusal, partial-post reporting, host binding).

## Key design decisions

- **Transport is a sibling, not a refactor of gh.ts.** `isOwnerRepo`,
  `HOSTNAME_RE`, and the host-routing state (`setGhHost`/`resolveGhHost`/
  `getGhHost`) are currently gh.ts-owned. Aone has no global host routing
  (repo coordinate per call), so the shared surface is the _validators_
  (move `isOwnerRepo`/`HOSTNAME_RE` into `lib/platform/` or a shared
  `lib/validate.ts`) — not the gh host state.
- **Detection is cheap and explicit.** Remote-URL host is already parsed by
  `match-remote`'s matcher; the reader threads `--host`/the remote URL into
  detection. An explicit non-Aone signal beats the cwd probe.
- **Diff is git-based.** Fetching the MR ref makes Aone diffs identical to
  GitHub's (merge-base + unified diff), so `plan-diff`/chunking need no
  Aone branch. `a1 mr diff` is only the lightweight fallback.
- **Global id is the review number.** Aone CR URLs carry the global id; the
  reader uses it for refs/`mr view`/comments/workitems.
- **Head identity is flow-aware.** A full 40-hex `sourceBranch` is the
  AGit-Flow head. Any other non-empty value is a branch label; its SHA is read
  from the exact MR ref only after the cwd `origin` is proven to be the target
  Aone repository. Clone-less reads report the SHA as unavailable, while
  presubmit/comment-status and posting fail closed when a known branch cannot
  be resolved.

## Files affected

- New: `lib/platform/aone-client.ts`, `lib/platform/aone.ts` (+ tests).
- Modified: `lib/platform/types.ts` (add `'aone'` to `PlatformKind`),
  `lib/platform/registry.ts` (detection), `fetch-pr.ts` (provider routing),
  possibly a shared validators module, `parse-args.ts` (Aone CR URL grammar
  `/codereview/<id>`), `meta.ts`/`issue-context.ts`/`fetch-diff.ts`/
  `comment-body.ts` (platform selection + non-GitHub `--host` semantics),
  `SKILL.md` (Aone target handling + lightweight/detect guidance),
  `docs/users/features/code-review.md`.

## Open questions

1. **Scope**: ship the minimal slice (reader + detection + fetch-pr;
   pr-context/comment-status/presubmit degrade), or also make `pr-context`
   render Aone comments (bigger lift)? Recommendation: minimal slice.
   _Resolved: minimal slice shipped; comment-status/presubmit backing
   landed 2026-08-21; pr-context rendering remains open._
2. Aone comment threading (`closed`, `outdated`) vs GitHub's
   `in_reply_to_id`/`line` model — only matters if `comment-status` joins.
   _Resolved with the 2026-08-21 backing: `parentNoteId` → `in_reply_to_id`,
   `outdated` → GitHub's null-line (stale), `closed` → the resolved bucket._
   The ANCHOR half of this (how `--line` lands, what `side`/`outdated`
   read back) is RESOLVED by the 2026-08-21 probe — see
   `docs/design/2026-08-21-review-aone-removed-line-anchoring.md`: new-side
   only, zero server validation, `outdated` ≈ line-beyond-EOF, and
   file-level comments drop their path.
3. build/test (Agent 7) on a Bazel monorepo needs a repo-config escape hatch
   (already flagged out of scope in the parent doc); confirm it degrades
   cleanly rather than attempting a full `bazel build`.
