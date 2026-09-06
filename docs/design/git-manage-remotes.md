# Web Shell Manage Remotes

## Problem statement

The Web Shell workspace git popover (`BranchPickerPopover`, opened from the
left-sidebar workspace git pill or the composer branch chip) can pull, commit,
push, create/checkout branches, and lists remote-tracking branches grouped by
remote name — but there is no way to manage the remotes themselves. A user who
clones-from-zip (no `origin`), works triangular (fork + upstream), or wants to
drop a stale remote must leave the Web Shell and use a terminal.

There is no daemon route, SDK method, or core CRUD helper for git remotes
today (grep-verified 2026-09-06). `git remote` otherwise appears in the
shell read-only classifier, a worktree-service error message, push-remote
resolution inside `gitPush`, and two read-only `git remote -v` parsers under
`packages/cli/src/commands/review/` (`lib/remote-match.ts`,
`match-remote.ts`) plus simple-git's `getRemotes` in
`packages/core/src/extension/github.ts` — precedent that the rendered
`git remote -v` surface is unstable (remote-match already carries a
regression test for the partial-clone `[filter]` annotation), which is why
the new reader below uses the structured accessors instead.

Scope (confirmed with the maintainer): **list + add + remove**, surfaced as a
panel **inside the BranchPicker popover**. No set-url, rename, or fetch/prune.

## Current state

| Layer         | What exists                                                                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon routes | `packages/cli/src/serve/routes/workspace-git-branches.ts` registers `GET …/git/branches`, `POST …/git/{checkout,branch,push,pull,commit}` in both legacy (`/workspace/…`) and scoped (`/workspaces/:workspace/…`) forms; mounted in `packages/cli/src/serve/server.ts` ~L2403-2413 |
| core          | `packages/core/src/utils/git-branches.ts`: private `runGit(cwd, args, env)` (execFile, 30 s, 10 MB, `gitEnv`), exported `gitEnv`, `fetchGitBranches`, `gitPush`, …; re-exported from `packages/core/src/index.ts` (`export * from './utils/git-branches.js'`)                      |
| SDK           | `WorkspaceDaemonClient` in `packages/sdk-typescript/src/daemon/DaemonClient.ts` (~L6600-6770 git block) calls `client.workspaceJsonRequest(selector, suffix, label, opts)`; types in `packages/sdk-typescript/src/daemon/types.ts`, re-exported in `daemon/index.ts`               |
| UI            | `packages/web-shell/client/components/BranchPickerPopover.tsx` + `.module.css`; i18n keys `branchPicker.*` in `packages/web-shell/client/i18n.tsx` (en ~L34-80, zh ~L3523-3566)                                                                                                    |
| e2e mock      | `packages/web-shell/client/e2e/utils/mockDaemon.ts`: scenario fields (~L106-120), `isDaemonPath` regex (~L744-753), `isDaemonRoute` regex (~L887-905), response fixtures (~L1450-1593)                                                                                             |

Scoped-only precedent: `workspace-github-prs.ts` registers only
`/workspaces/:workspace/…` routes (no legacy form).

## Proposed changes

### 1. Core — new `packages/core/src/utils/git-remotes.ts`

```ts
export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export function isValidRemoteName(name: string): boolean;
export function isValidRemoteUrl(url: string): boolean;
export function isRemovableRemoteName(name: string): boolean;
export async function fetchGitRemotes(cwd, env?): Promise<GitRemoteInfo[]>;
export async function gitRemoteAdd(
  cwd,
  name,
  url,
  env?,
): Promise<GitRemoteInfo[]>;
export async function gitRemoteRemove(
  cwd,
  name,
  env?,
): Promise<GitRemoteInfo[]>;
```

- `fetchGitRemotes` uses the **structured accessors**: `git remote` for the
  (sorted) name list, then `git remote get-url <name>` and
  `git remote get-url --push <name>` per name — not the rendered
  `git remote -v`, whose promisor/partial-clone annotation
  (`… (fetch) [blob:none]`) silently breaks a line parser (the trap
  `commands/review/lib/remote-match.ts` already patched once). `--push`
  answers the pushurl override or falls back to the fetch URL, so a remote
  without an override reports `pushUrl === fetchUrl`; a remote whose config
  lost its URL reports the name as URL, per git's own `get-url` fallback.
  The per-name lookups run in bounded batches (8-wide — the name list comes
  from config the user may not have authored). A name that vanishes between
  the listing and the lookup (concurrent CLI use, git's `No such remote`) is
  omitted; any other lookup failure rethrows, so a real error never answers
  200 with a silently truncated list. No `rev-parse` probe —
  outside a repo `git remote` itself fails with
  `fatal: not a git repository`, which the route layer already classifies.
- `gitRemoteAdd` / `gitRemoteRemove` run `git remote add <name> <url>` /
  `git remote remove <name>` and then return `fetchGitRemotes`, so each
  mutation response carries the fresh list (one round trip for the UI; the
  extra lookups are milliseconds).
- `runGit` stays the single exec wrapper: export it from `git-branches.ts`
  (add one keyword) and import it here; `gitEnv` is already exported.
- `isValidRemoteName` is deliberately conservative — a single refname-style
  component: it reuses `isValidRefName` (control/space/zero-width/bidi and
  `~^:?*[\` rejection, dot/`.lock`/`..`/`@{` rules, per-component 255-char
  cap) and adds `no /` and `no leading -` (flag-injection guard). Git
  validates again at `remote add` time; this predicate exists so the route
  can answer 400 before spawning git.
- `isValidRemoteUrl` accepts almost anything git accepts (https/ssh/scp-like/
  local paths, spaces included) and rejects only blanks, a leading `-`
  (exec vector) and C1/zero-width/bidi characters (the URL is rendered
  verbatim in the Web Shell — gitDirect's display policy).
- `isRemovableRemoteName` is the removal predicate and is deliberately
  **more lenient** than the add one: removal targets a remote git already
  has configured (a hand-edited `.git/config` can hold names the add
  predicate rejects), so it guards only the exec vector (non-empty, no
  leading `-`, no control chars).
- New file added to `packages/core/src/index.ts` next to the
  `git-branches.js` export.

### 2. Daemon routes — new `packages/cli/src/serve/routes/workspace-git-remotes.ts`

Scoped only (GitHub-PRs precedent; the Web Shell always goes through
`workspaceByCwd`):

| Method | Path                                       | Body            | Success                                                             |
| ------ | ------------------------------------------ | --------------- | ------------------------------------------------------------------- |
| GET    | `/workspaces/:workspace/git/remotes`       | — (`?cwd=` ok)  | `{ v: 1, workspaceCwd, available: true, remotes: GitRemoteInfo[] }` |
| POST   | `/workspaces/:workspace/git/remote`        | `{ name, url }` | `{ v: 1, workspaceCwd, remotes: GitRemoteInfo[] }`                  |
| POST   | `/workspaces/:workspace/git/remote/remove` | `{ name }`      | `{ v: 1, workspaceCwd, remotes: GitRemoteInfo[] }`                  |

- Registration shape mirrors `registerWorkspaceQualifiedGitBranchRoutes`:
  `registerWorkspaceQualifiedGitRemotesRoutes(app, { workspaceRegistry,
sendBridgeError, mutate })`, mounted in `server.ts` directly after the
  branch-route mounts.
- Request pipeline identical to the branch mutations: `deps.mutate({ strict:
true })` → `resolveTrustedRuntime` → `generationGuard.assertOpen()` →
  `resolveContainedCwdOrFail` (GET uses the non-fatal `resolveContainedCwd`).
- Body validation before any git spawn: `name` must satisfy
  `isValidRemoteName` (→ 400 `invalid_remote_name`); `url` must satisfy
  `isValidRemoteUrl` after trimming (→ 400 `invalid_remote_url`). Remove
  validates with the lenient `isRemovableRemoteName` and lets an unknown
  name surface git's own `error: No such remote` (see below) rather than a
  pre-check, keeping the route race-free against concurrent CLI use.
- Error mapping: the shared `sendGitError` in `workspace-git-branches.ts`
  (exported; its `redactGitMessage` helper stays private) gains two
  remote-specific branches **before** the generic `/already exists/` one,
  which would otherwise mislabel them:
  - `/remote .* already exists/i` → 409 `remote_already_exists`
  - `/no such remote/i` → 404 `no_such_remote`
    The remotes routes delegate to it unchanged; everything else
    (not-a-repo → 404 `not_a_git_repository`, redacted 500 fall-through)
    keeps its existing classification. Note the blast radius: this
    classifier is shared by all git routes, so the two new patterns were
    checked against every branch/push/pull/commit message shape (none
    contains `remote … already exists` or `no such remote`).

### 3. SDK — `packages/sdk-typescript`

- `types.ts`: `DaemonGitRemoteInfo { name; fetchUrl; pushUrl }`,
  `DaemonGitRemotesResult { v; workspaceCwd; available; remotes }`,
  `DaemonGitRemoteMutationResult { v; workspaceCwd; remotes }` (mutations
  answer the fresh list without `available`); re-export from
  `daemon/index.ts`.
- `WorkspaceDaemonClient` (scoped only, next to `workspaceGitBranches`):
  - `workspaceGitRemotes(cwd?)` — GET `…/git/remotes`
  - `workspaceGitRemoteAdd(name, url, cwd?)` — POST `…/git/remote`
  - `workspaceGitRemoteRemove(name, cwd?)` — POST `…/git/remote/remove`
- No legacy `DaemonClient` methods (no legacy routes exist).

### 4. Web Shell UI — `BranchPickerPopover.tsx`

- New state `view: 'branches' | 'remotes'`, reset to `'branches'` on open;
  entering the remotes view clears the pull-resolution panel **only while it
  is standing** (`pullBlocked`) — a sticky stash-restore warning survives the
  round trip, per `stickyWarningRef`'s contract (pinned by a test).
- New action row **Manage Remotes…** (lucide `GlobeIcon`) in the second
  action group, after _Checkout Tag or Revision…_; also matched by the
  existing `actionsVisible` search filter.
- Remotes view replaces the scrollable list area (search box and footer
  status bar stay):
  - Header row: back chevron + title.
  - Remote rows: name, fetch URL (truncated, `title` attr; push URL shown
    only when it differs), and a trailing remove icon-button.
  - Remove uses a **two-click inline confirm** (first click swaps the row's
    button to a red _Confirm_ state; second click executes; any other action
    or view switch resets it) — no nested dialog inside a popover.
  - Inline add form at the bottom of the list: name input + URL input + Add
    button (Enter submits from either input; the client guard rejects only
    empty and leading-`-` values — the daemon remains the validation
    authority and its 400 message lands in the footer).
  - Remote names and URLs are rendered through a display sanitizer that
    strips C1/zero-width/bidi characters (a `.git/config` the user did not
    author can carry them); mutation requests still use the raw name.
  - The search input filters remotes by name/URL substring while in this
    view.
- Data flow: entering the view fetches `workspaceGitRemotes(gitCwd)`; add /
  remove use the list returned by the mutation response directly. Only
  **remove** then calls `fetchBranches(true)` in the background —
  `git remote remove` deletes `refs/remotes/<name>/*`, so the branches
  view's remote groups must refresh before the user navigates back; an add
  creates no remote-tracking refs, so it does not. A **refused** mutation
  re-reads the remotes list too (a `no_such_remote`/`already_exists` answer
  means the displayed list is stale). Mutation errors land in the existing
  footer status bar (`statusType: 'error'`).
- i18n (en + zh), following the existing `branchPicker.*` block:
  `branchPicker.action.manageRemotes`, `branchPicker.remotes.title`,
  `.empty`, `.noMatches`, `.loading`, `.namePlaceholder`, `.urlPlaceholder`,
  `.add`, `.back`, `.remove`, `.removeConfirm`, `.added`, `.removed`,
  `.invalidInput` (client-side guard for empty/dash-prefixed input; the
  daemon remains the validation authority).
- CSS: ~8 new classes in `BranchPickerPopover.module.css` (`.remotesHeader`,
  `.backButton`, `.remoteRow`, `.remoteName`, `.remoteUrl`,
  `.remoteRemove`, `.remoteRemoveConfirm`, `.addRemoteForm`), built on the
  same `--border` / `--muted-foreground` / `--destructive` vars.

### 5. e2e mock — `packages/web-shell/client/e2e/utils/mockDaemon.ts`

- New optional scenario field `gitRemotes?: { name; fetchUrl; pushUrl }[]`
  (default fixture: one `origin`), threaded like `gitBranches`.
- Extend the git alternations in `isDaemonPath` and `isDaemonRoute` with
  `remotes|remote` so the new paths stay on the daemon route table.
- Response handlers: GET returns the fixture list; POST add/remove mutate
  the in-memory list and return it (mirrors the real contract).

### 6. Tests (collocated)

| File                                                                | Covers                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/utils/git-remotes.test.ts`                       | structured-accessor listing (sorted order, push-url override via `git remote set-url --push`, promisor/partial-clone remote, url-less config entry → name-as-url fallback), add/remove round-trips in a tmp repo, predicate tables incl. the add/remove leniency divergence and a hand-configured `x.lock` removal round-trip                                                                                  |
| `packages/cli/src/serve/routes/workspace-git-remotes.test.ts`       | mirrors `workspace-git-branches.test.ts`: trust gate, generation guard (503 `workspace_runtime_unavailable` on all three endpoints), `invalid_cwd` 400, `invalid_remote_name`/`invalid_remote_url` 400, add→list, duplicate → 409 `remote_already_exists`, remove→list, remove-missing → 404 `no_such_remote`, non-repo → 404 `not_a_git_repository`, unknown workspace → `workspace_mismatch`, path redaction |
| `packages/sdk-typescript/test/unit/DaemonClient.test.ts`            | URL/method/body composition for the three new methods, with and without `cwd`                                                                                                                                                                                                                                                                                                                                  |
| `packages/web-shell/client/components/BranchPickerPopover.test.tsx` | open panel → list renders; add success/failure; local dash guard; remove two-click confirm + counted post-remove refreshes + `onBranchChanged`; back button; search filters; filtered-to-empty copy; load-failure rendering; sticky-warning survival across the round trip; reopen reset/disarm                                                                                                                |
| `packages/web-shell/client/e2e/web-shell.git-remotes.spec.ts`       | Playwright + mockDaemon: sidebar pill → panel → list/add/remove (two-click), duplicate-add error, search filtering                                                                                                                                                                                                                                                                                             |

## Files affected

- `packages/core/src/utils/git-remotes.ts` (new) + `.test.ts` (new)
- `packages/core/src/utils/git-branches.ts` (export `runGit`)
- `packages/core/src/index.ts` (one export line)
- `packages/cli/src/serve/routes/workspace-git-remotes.ts` (new) + `.test.ts` (new)
- `packages/cli/src/serve/routes/workspace-git-branches.ts` (export `sendGitError`; the shared classifier gains the two remote-specific branches)
- `packages/cli/src/serve/server.ts` (mount new register fn)
- `packages/sdk-typescript/src/daemon/types.ts`, `daemon/index.ts`, `daemon/DaemonClient.ts`
- `packages/sdk-typescript/test/unit/DaemonClient.test.ts`
- `packages/web-shell/client/components/BranchPickerPopover.tsx` + `.module.css` + `.test.tsx`
- `packages/web-shell/client/i18n.tsx`
- `packages/web-shell/client/e2e/utils/mockDaemon.ts`
- `packages/web-shell/client/e2e/utils/gitScenario.ts` (new — git-workspace fixture shared with `web-shell.git-mode.spec.ts`) + `web-shell.git-remotes.spec.ts` (new) + `web-shell.git-mode.spec.ts` (uses the shared fixture)

## Scope boundaries

- List + add + remove only. No set-url, rename, fetch, prune, or LFS/URL
  rewriting UI.
- Scoped routes only; no legacy `/workspace/git/remote*`.
- No changes to `GitDialog`; the only entry point is the BranchPicker
  popover.
- No daemon-side caching — every GET re-reads git (cheap, always accurate
  against concurrent CLI use).

## Security notes

- All git invocation goes through `runGit` (execFile arg vector, no shell);
  `name`/`url` additionally reject a leading `-` so neither can be
  reinterpreted as a flag, and `url` rejects C1/zero-width/bidi characters
  because it is rendered verbatim in the Web Shell.
- Transport-helper URLs (`ext::sh -c …`) are **not** rejected by predicate:
  git's own default policy is `protocol.ext.allow=never`, so a stored `ext::`
  URL cannot execute on fetch/pull, and `gitEnv` strips the `GIT_CONFIG_*`
  variables that could flip that policy per-invocation. A blanket `::`
  rejection was considered and dropped — it would break the legitimate
  `ssh::git@host:path` helper form. (`extension/github.ts`'s pinned-config
  precedent — `protocol.allow=never` + explicit https — is the same posture,
  enforced by git's default instead of a flag.)
- Mutations inherit the full strict chain: mutation gate → trusted-runtime
  resolution → generation guard → workspace-contained `cwd`.
- Error responses pass through the existing redaction (`redactGitMessage`)
  so absolute paths never reach the client.

## Open questions

None blocking. Assumption to sanity-check at review: two-click inline
confirm (vs. a modal) for remove — chosen because a Radix Dialog nested in a
portaled Popover fights the dismiss layer; the pattern matches the popover's
existing inline confirm for discard-and-update.
