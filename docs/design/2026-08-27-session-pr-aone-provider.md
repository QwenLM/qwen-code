# Aone provider for session PR bindings

> Status: draft. Relates to `docs/design/2026-08-15-review-aone-provider.md`
> (reuses its host predicates and a1 platform facts; touches none of its code
> paths).

## Problem

Session PR bindings record which pull requests a session produced, as a
`<sessionId>.pr.json` sidecar (`packages/core/src/services/session-pr-service.ts`).
Manual binding — the REST `PATCH …/session/:id/metadata` routes and the ACP
`session/update_metadata` method — is platform-neutral: it accepts any
positive integer `number` plus any http(s) `url`, so an Aone codereview URL
can be bound today.

The two AUTOMATIC paths are GitHub-only:

1. **Backfill** (`packages/cli/src/serve/routes/session-pr-backfill.ts`,
   `POST /sessions/backfill-prs`): maps session branches to PRs via one
   `gh pr list --state all` per workspace, and resolves the `pr-<N>`
   worktree slug/branch convention's number to a URL through gh, falling back
   to `<origin web URL>/pull/<N>`. On an Aone workspace, `gh` fails against
   the non-GitHub remote, and the fallback fabricates a
   `https://gitlab.alibaba-inc.com/<g>/<p>/pull/<N>` URL — a page that does
   not exist (Aone CR pages live at `…/codereview/<global-id>` on the WEB
   host `code.alibaba-inc.com`).
2. **State refresh** (`packages/cli/src/serve/server/session-pr-refresh.ts`):
   a 5-minute daemon sweep that keeps each binding's `state` snapshot
   (open/merged/closed badge) fresh via `gh pr list --state all`. An Aone
   binding's number never appears in gh's page, so its state is frozen at
   bind time forever.

Goal: Aone workspaces get the same automatic binding and state refresh as
GitHub workspaces — first-class, not manual-only.

## Verified platform facts (probed 2026-08-27 against a1 0.2.51)

Probes: `aone/a1` (list-permitted, view-forbidden for the probing account)
and `jspt/agentic_coding` (fully permitted).

| Capability      | a1 command                                                                       | Notes                                                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List MRs        | `a1 repo mr list --state opened\|merged --format json [--page N] [--repo <g/p>]` | page size fixed at 20; `--page` max 100; default order `updated_at desc`. Entries carry `id` (global), `iid`, `state`, `sourceBranch`, `projectPath`. **`detailUrl`/`webUrl` are empty strings in list output.** `--state` has `opened` (includes `reopened` entries), `accepted`, `merged` — no `closed`, no `all` |
| Single MR       | `a1 repo mr view <global-id> [--repo <g/p>] --format json`                       | → `{mergeRequest: {state, detailUrl, sourceBranch, targetBranch, …}}`; `detailUrl` = `https://code.alibaba-inc.com/<groupPath>/codereview/<global-id>` — the ONLY sanctioned URL source (the review provider's `composeUrl` forbids assembling Aone links because nested-group collapse is non-injective)           |
| State values    | list/view `state`                                                                | observed: `opened`, `reopened`, `merged`; `accepted` is a filter value (approved, unmerged); `closed` never observed (nothing listable) — mapped defensively                                                                                                                                                        |
| Errors          | exit code UNRELIABLE                                                             | a1 may answer `{"schemaVersion":"a1.error/v1","code","message","retryable","exitCode"}` with exit 0 OR exit 1 — the parsed shape, not the exit code, is the error signal. 403 on `mr view` is possible even when `mr list` works (per-MR visibility)                                                                |
| id semantics    | global                                                                           | `id` is unique platform-wide (the CR URL keys on it), so within Aone a number alone identifies one MR                                                                                                                                                                                                               |
| AGit-Flow       | `sourceBranch` may be the head SHA                                               | branch-name mapping then simply finds no match (a transcript `gitBranch` is a branch name, never a bare SHA) — no misattribution risk                                                                                                                                                                               |
| Repo coordinate | `--repo <group>/<project>` full path                                             | the daemon's cwd is not the workspace, so every call passes `--repo` explicitly; the coordinate comes from the workspace's own origin via `parseRemoteUrl(...).groupPath`                                                                                                                                           |

Reusable Aone primitives from the review subsystem (both dependency-light):

- `packages/cli/src/commands/review/lib/remote-match.ts` (zero imports):
  `parseRemoteUrl` (https/ssh/scp → `{host, owner, repo, groupPath}`) and
  `isAoneHostFamily` (canonical web/git pair plus `*.alibaba-inc.com`).
- `packages/cli/src/commands/review/lib/platform/aone-client.ts`:
  `A1_MIN_VERSION` (0.1.90) and `parseA1Version`. (Its exec transport is NOT
  reused — see below.)

NOT reused: `registry.ts`'s `detectPlatformKind` — its no-signal branch probes
`process.cwd()`, which is wrong for a multi-workspace daemon, and its
explicit-hint branches apply the CANONICAL-only predicate (serve needs the
family predicate on a workspace origin; see Detection below).

## Design

### Detection — per workspace, origin-based

Each backfill run / refresh sweep resolves the workspace's platform from its
OWN origin: `git remote get-url origin` at the workspace git root (async
`execFile`, env sanitized through core's `gitEnv` like every sibling git call
in these paths), parsed by review's `parseRemoteUrl`, gated by
`isAoneHostFamily`. Undefined host / unreadable origin / non-Aone host →
GitHub path (today's behavior).

This is the same FAMILY semantics as review's no-signal cwd probe. The
review write path's stricter canonical-only rule exists because a
user-supplied `--host`/number could be resolved on the WRONG platform — a
global Aone id hijacking a GitHub review. That hazard cannot occur here: a
workspace's a1 calls are scoped to that same origin's `--repo` coordinate,
and a number discovered on one platform is never resolved through the other.
A family-but-not-canonical host (a `ghe.alibaba-inc.com`-style GHE instance)
routes to a1, whose calls fail cleanly → degraded, never wrong bindings.

### New module: `packages/cli/src/serve/server/aone-mrs.ts`

Async a1 transport + the three operations the binding paths need. Collocated
test `aone-mrs.test.ts`.

- **Runner**: `execFile` (promisified), no shell, `--format json` appended,
  20s timeout, 16MB maxBuffer, `windowsHide`. The review `aone-client.ts`
  transport is deliberately not reused: it is `execFileSync` (blocks the
  daemon event loop), sleeps via `Atomics.wait`, retries twice with 3s/6s
  blocking backoff against a 120s timeout (worst case ~6 min per call —
  wrong for a 5-minute timer and an HTTP route), and exposes no env/cwd
  options. The daemon re-attempts on the next sweep/run instead; one failed
  call must cost one timeout, not six minutes. Parsed output is checked for
  the `a1.error/v1` shape before use — a1 answers some errors that way at
  exit 0 and others at exit 1 with the same object on stdout.
- **Version floor**: `a1 --version` before the first read; a POSITIVE probe
  is memoized per daemon process, while a missing or too-old a1 keeps
  re-checking so installing/upgrading it takes effect without a restart.
  Below the review-subsystem's `A1_MIN_VERSION` → unavailable with the
  upgrade remedy in the message.
- **Failure contract** (as shipped): detection returns `undefined` for a
  non-Aone workspace, and reads throw `AoneCliUnavailableError` /
  `AoneCommandError`, which both consumers catch and degrade in place
  (skip branch mapping, leave a number unresolved, keep a binding's last
  state) — the same degrade-in-place behavior the gh path gets from its
  `not_a_repo / cli_unavailable / failed` unions.
- Exports:
  - `resolveAoneWorkspaceRepo(workspaceCwd, env?) →
Promise<{ repoPath: string } | undefined>` — detection + coordinate in
    one git call; `undefined` = not an Aone workspace (or not a repo).
  - `listAoneMergeRequests(repoPath, { state, pages }) →
Promise<Array<{ number, headRefName, state }>>` — sequential pages of 20,
    stopping at a short page.
  - `viewAoneMergeRequest(repoPath, id) →
Promise<{ number, url, state }>` — `url` = `detailUrl`.
  - State mapping: `merged` → `merged`; `closed` → `closed`; anything else
    (`opened`, `reopened`, `accepted`) → `open`. No `draft` variant exists in
    the sidecar (same as gh's mapping).

Test injection: `backfillWorkspaceSessionPrs` and
`refreshWorkspaceSessionPrStates` gain an optional `aoneBackend` in their
options object (the gh fetcher's positional injection stays as-is, so every
existing test keeps compiling). The backend interface is the two functions
above; tests substitute fakes.

### Backfill changes (`session-pr-backfill.ts`)

Per workspace, after candidate collection (unchanged):

- GitHub workspace → exactly today's code path.
- Aone workspace:
  - Branch mapping: `listAoneMergeRequests` for `opened` then `merged`,
    `AONE_BACKFILL_PAGES_PER_STATE` = 3 pages each (60 newest MRs per
    state — a documented window vs gh's single 500-entry call; recent MRs are
    the ones sessions map to). Same highest-number-wins rule for reused head
    branches; same default-branch exclusion (`getDefaultBranch` is git-local).
    AGit-Flow SHA heads simply never match transcript branches.
  - URL resolution: NEVER fabricate. The `pr-<N>` convention number AND every
    branch-mapped number that is newly bound this run is resolved through
    `viewAoneMergeRequest` (the only sanctioned URL source), capped at
    `AONE_MAX_MR_VIEW_CALLS_PER_RUN` = 25 unique numbers (the same constant
    bounds the refresh sweep); the excess counts as `unresolved` and the
    next run retries it. A successful view also records the attested URL in
    the same-PR identity map, and that identity check fails CLOSED on Aone
    (an unattested number is treated as a foreign binding and kept, never
    trimmed) — the gh path keeps its fail-open default.
  - Legacy repair: bindings the pre-Aone backfill persisted in the fabricated
    `<origin web URL>/pull/<N>` shape are detected and re-resolved through
    the same capped view path, then rewritten in place with the real
    `detailUrl` + state (createdAt preserved). Without this they can never
    match a fetched URL — frozen state and one wasted view call per refresh
    sweep, forever.
  - A failed `mr list` skips branch mapping for the run (the
    `ghAvailable: false` degraded mode) while convention bindings survive; a
    failed `mr view` leaves that number unresolved.
  - The `getRemoteWebUrl` + `/pull/<N>` fallback applies to GitHub only.
- Response shape (wire): additive fields only — `platform: 'github' | 'aone'`
  per workspace result and `aoneAvailable?: boolean` mirroring `ghAvailable`.

### Refresh changes (`session-pr-refresh.ts`)

Per workspace, after pending-number collection (unchanged):

- GitHub workspace → exactly today's code path.
- Aone workspace: dedupe pending numbers ACROSS sessions (a global id bound by
  several sessions costs one call), then `viewAoneMergeRequest` per unique
  number, capped at `AONE_MAX_MR_VIEW_CALLS_PER_RUN` = 25. Successful views
  feed the existing `updateSessionPrStates` write path keyed by
  `{state, url: detailUrl}` — its canonical-URL identity check keeps working
  because `detailUrl` is the canonical form of a bound Aone URL. Per-number
  errors (403/404/timeout) skip that entry; the sweep continues.
- Only non-`merged` entries are swept today; that stays. Closed MRs are not
  listable via a1, so a binding whose MR was closed keeps its last state —
  but a reopened MR appears under `--state opened` and self-heals.

### Environment

a1 takes no env parameter (review precedent: it inherits `process.env` and
authenticates through its own `a1 auth login` config; there is no `A1_TOKEN`
convention). The git calls added here ride `gitEnv(runtime.env.effectiveEnv)`
like their siblings.

## Files affected

| File                                                        | Change                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/cli/src/serve/server/aone-mrs.ts`                 | NEW — detection, a1 runner, list/view, state mapping               |
| `packages/cli/src/serve/server/aone-mrs.test.ts`            | NEW — runner error shapes, state mapping, paging, detection        |
| `packages/cli/src/serve/routes/session-pr-backfill.ts`      | platform dispatch; aone branch-mapping + view-based URL resolution |
| `packages/cli/src/serve/routes/session-pr-backfill.test.ts` | aone cases via injected backend                                    |
| `packages/cli/src/serve/server/session-pr-refresh.ts`       | platform dispatch; view-based state refresh                        |
| `packages/cli/src/serve/server/session-pr-refresh.test.ts`  | aone cases via injected backend                                    |

`packages/core` is untouched. Imports from
`packages/cli/src/commands/review/lib/` are dependency-light modules
(`remote-match.ts` has zero imports; `aone-client.ts` only `node:child_process`),
and serve → commands imports have precedent (the channel modules).

## Non-goals

- Web Shell `/prs` glance panel and PR creation dialog
  (`workspace_github_prs` capability, `workspace-github-prs.ts`): a separate
  feature with its own CI-rollup/review-decision fields.
- Creating MRs on Aone from the Git dialog.
- Detecting CLOSED Aone MRs (a1 cannot list them); reopen self-heals.
- AGit-Flow SHA-head attribution (nothing to match against; convention/slug
  bindings are unaffected).
- Any change to manual binding, the sidecar schema, or the bridge/ACP wire
  shapes.

## Risks / open questions

- **Latency**: a large Aone workspace's backfill serializes up to ~6 list
  calls + ≤25 view calls (each ≤20s timeout, typically ~1s). The route is a
  manually-triggered maintenance operation; acceptable, documented.
- **`accepted` semantics**: treated as `open` (approved but unmerged). If
  Aone later distinguishes it in the badge, revisit.
- **Closed-state string** was never observed in probes; the mapping is
  defensive (`closed` → `closed`).
- **Cap starvation**: with >25 unique non-merged bindings, refresh sweeps the
  first 25 deterministically each tick. Overflow is implausible in practice
  (sidecars cap at 10 per session and merged entries drop out); documented
  rather than engineered around.
