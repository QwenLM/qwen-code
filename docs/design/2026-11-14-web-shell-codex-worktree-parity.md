# Web Shell Worktree Sessions: Codex Parity

[English](2026-11-14-web-shell-codex-worktree-parity.md) | [简体中文](2026-11-14-web-shell-codex-worktree-parity.zh-CN.md)

## Status and scope

P1–P5 implemented (PR #17228); P6–P7 planned as follow-up. Full parity with
Codex managed worktrees for Web Shell sessions, delivered in ordered phases
(P1–P7). Each phase is independently shippable; the end state matches the
Codex reference behavior below. Maintainer-authored
core changes (the detached-HEAD refactor in P3) are exempt from the external
two-tier gate but still follow the common design and self-audit workflow.

Reference baseline: `.repro-runs/web-shell-default-worktree/codex-reference.md`
(local, git-ignored). Codex is not installed on the development machine, so
the reference facts are verbatim quotes from the official Codex documentation
(https://learn.chatgpt.com/docs/environments/git-worktrees), not a local
trace. Trace-level alignment can be added later with a nested Codex capture.

## Problem and current behavior

Web Shell sessions in a trusted Git workspace default to the current branch
(`gitModeIntent = { mode: 'current' }`, `packages/web-shell/client/App.tsx`).
Worktree isolation is opt-in through the composer's Git mode popover; the
first prompt then sends `worktree: {}` to `POST /session`, which calls
`GitWorktreeService.createUserWorktree` and creates
`<repo>/.qwen/worktrees/<slug>` on a **named branch** `worktree-<slug>` from
the current branch's HEAD.

Gaps against Codex:

| Codex behavior                                                                                     | Current Web Shell                                                                                     | Gap                                                  |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| New chats default to a managed worktree in Git repos                                               | Default is the current branch; worktree is opt-in                                                     | Flip the default; add a settings switch              |
| Uncommitted local changes are applied to the worktree                                              | Session worktree starts from HEAD only; dirty state stays in the source checkout                      | Carry dirty state on session worktree creation       |
| Worktree is detached HEAD, no branch pollution                                                     | Named branch `worktree-<slug>` per session                                                            | Detached-HEAD refactor across the worktree lifecycle |
| "Create branch here" in the chat header                                                            | No dedicated affordance (branch picker can checkout inside the worktree)                              | New route + UI                                       |
| "Hand off" moves a chat between worktree and local checkout                                        | `worktree-reset` transfers checkout ownership between sessions (channel restore), not worktree↔local | New handoff capability                               |
| Keeps the 15 most recent managed worktrees; archive deletes with a snapshot; reopen offers restore | No count-based retention; cleanup on explicit delete plus orphan/age sweeps                           | Retention + snapshot/restore                         |
| Worktree root configurable in settings                                                             | Hardcoded `<repo>/.qwen/worktrees`, incl. identity checks                                             | New setting + containment rework                     |
| Composer can manually pick Local / Worktree                                                        | Git mode popover already offers current / branch / worktree                                           | Reuse                                                |

Non-Git workspaces are unaffected in every phase (Codex: "In non-version-controlled
projects, scheduled tasks run directly in the project directory").

## Codex reference behavior (verbatim facts)

1. "By default, chats use a Codex-managed worktree."
2. "Codex creates worktrees in `$CODEX_HOME/worktrees`." Root is configurable
   via Settings > Worktrees.
3. "The starting commit is the `HEAD` commit of the branch selected when you
   start your chat. If you chose a branch with local changes, Codex applies
   the uncommitted changes to the worktree as well."
4. "The worktree isn't checked out as a branch. It's in a detached HEAD state.
   This lets Codex create several worktrees without polluting your branches."
5. "…turn your worktree into a branch using the Create branch here button in
   the chat header." Then commit / push / open a PR.
6. "…select Hand off in the chat header and move it to Local. Codex handles
   the Git steps required to move the chat safely between the worktree and
   your local checkout."
7. "By default, Codex keeps your most recent 15 Codex-managed worktrees."
   Auto-deletion skips pinned chats and chats in progress; archiving a chat
   deletes its worktree; a snapshot is saved before deletion and offered for
   restore when the chat is reopened.
8. The documentation does not describe a switch to turn the default off;
   Qwen Code adds one in `settings.json` by explicit product request.

## Target behavior

- A new Web Shell session in a trusted Git workspace starts in a managed
  worktree by default. The composer chip shows the worktree mode before the
  first prompt; the user can reset to the current branch (existing ✕ control)
  or pick a named branch. Nothing is created until the first prompt.
- `settings.json` can turn the default off (`worktree.defaultForNewSessions`,
  default `true`), set the retention limit (`worktree.maxRetained`, default
  `15`, `0` disables count-based auto-deletion), and choose the worktree root
  (`worktree.root`, default `.qwen/worktrees` relative to the repository top).
- The worktree starts at the source checkout's HEAD with its uncommitted
  changes (tracked staged + unstaged, and untracked files) applied, and sits
  in detached HEAD.
- The chat header offers "Create branch here" (detached → named branch) and
  "Hand off" (worktree ↔ local checkout).
- Archiving/deleting a session snapshots its worktree's work before removal;
  reopening the chat offers restore. A retention sweep keeps the most recent
  N worktrees, never touching active or pinned sessions.

## Key design decisions

### D1 — The default lives in the Web Shell composer, not the daemon API

`POST /session` without `worktree` keeps its current meaning (run in the
workspace directory). The default is applied where Codex applies it: the
product surface. The client initializes `gitModeIntent` to `{ mode: 'worktree' }`
when the workspace is eligible (trusted, a Git branch or detached HEAD present,
and HEAD born — `hasHead !== false`, since an unborn HEAD has no worktree base)
and the effective setting is `true`. A definitive `hasHead: false` also clears
an intent armed by an earlier fast status that omitted the field. SDK, channel,
and managed-session callers keep explicit control of the request; the
`POST /session` `worktree` contract itself is described in Scope boundaries.

The setting arrives through the existing workspace-settings route
(`getAllowedKeys` → `buildSettingsResponse`, consumed as
`workspaceSettings.find(key)?.values.effective`). Because settings load
asynchronously, the default is applied when the settings answer lands and the
intent is still untouched; an explicit user selection always wins, and the
existing intent-reset guards (workspace switch, untrusted, non-Git) keep
clearing it.

### D2 — Settings live in the existing `worktree` section

`packages/cli/src/config/settingsSchema.ts` already has a top-level `worktree`
section (today: `symlinkDirectories`). New keys:

| Key                              | Type    | Default           | Phase | Meaning                                                                                   |
| -------------------------------- | ------- | ----------------- | ----- | ----------------------------------------------------------------------------------------- |
| `worktree.defaultForNewSessions` | boolean | `true`            | P1    | New Web Shell sessions in a trusted Git workspace default to worktree mode                |
| `worktree.maxRetained`           | number  | `15`              | P6    | Most recent managed worktrees kept per repository; `0` disables count-based auto-deletion |
| `worktree.root`                  | string  | `.qwen/worktrees` | P7    | Worktree root, repository-relative; absolute paths and `..` escapes rejected              |

All three are served to Web Shell (`showInDialog: true` or the
`WEB_SHELL_SETTINGS` allowlist) and writable at user and workspace scope.
The section description is updated to mention Web Shell session worktrees.

### D3 — Dirty carry-over reuses the proven overlay, without a baseline commit

`setupWorktrees` already implements the overlay: `git stash create` in the
source (read-only), `git stash apply <snapshot>` in the worktree, copy of
`git ls-files --others --exclude-standard` files, each step fail-open.
P2 extracts this into shared `captureDirtyState` / `applyDirtyState` helpers
and invokes them from the session worktree creation path via an opt-in
option on `createUserWorktree` (`carryDirtyState`), so `enter_worktree` and
agent-isolation callers keep their current behavior. The capture lists
untracked files with `--full-name -z` (raw NUL-terminated paths — without
`-z`, git C-quotes non-ASCII, quoted, and newline names and the carry
silently drops them) and copies from the repository top, so a service
rooted at a subdirectory still lands files at the correct worktree offset
(the pre-extraction pattern misplaced them). When the repository top
cannot be resolved, the untracked overlay is skipped with a warning rather
than silently missing every copy.

The carry preserves symlinks as links (`lstat` + `readlink` + `symlink`):
`copyFile` would dereference a file link into committable out-of-repo
content and drop a directory link with `EISDIR`. The tracked-path capture
uses `stash show --name-only --no-renames -z` so a detected rename yields
both sides — the applied overlay presents `A new` plus ` D old`, and the
rollback's exemption must name both. The untracked listing runs at the
repository top (not the service root) so both halves of the overlay cover
the same repository-wide set even when the session is rooted at a
subdirectory. The daemon's own bookkeeping names (the session marker and
its staged `.tmp` siblings) are filtered from the untracked list so they
can never be carried as user content.

A conflicting 3-way `stash apply` (the capture checkout's HEAD diverged
from the worktree base on the same lines) writes conflict markers and
unmerged index entries; it is detected by the index state — simple-git's
raw mode may resolve even on the non-zero exit — and fails closed: the
worktree is restored to committed state and creation returns failure, so
a session is never relocated into a poisoned tree. Any other apply
failure (e.g. an unwritable index) fails closed the same way: a carry
that did not land must never be recorded as carried. The documented
fail-open survives only for the clean refusals — the per-file untracked
copy skips files it cannot copy, and an oversized journal-bound overlay
is skipped whole. The untracked copy never overwrites a pre-existing
destination and records only the paths it actually CREATED, so a
rollback removes only what the carry added — a pre-existing git-ignored
file the clean gate cannot see survives both the carry and its undo.

The carry bound is per call site, not universal. Only the branch-
preparation route persists `carriedPaths` (in a journal whose reader
refuses records above 64 KiB), so it passes `maxCarriedPathsBytes =
CARRIED_PATHS_MAX_BYTES` (32 KiB); above the bound the carry is skipped
(fail-open to committed state) so the journal stays readable. The handoff
and `POST /session` write no journal and carry any size — silently
dropping a large overlay there would move the session without the user's
work.

Provisioning ignores the managed worktrees directory through the
repository's `info/exclude`, not a daemon-written `.qwen/.gitignore`: a
bookkeeping file in the checkout is itself untracked work, which made the
handoff's local-clean gate refuse every pristine checkout and the
cleanup's has-work gate preserve every clean worktree. `info/exclude`
adds no status entry; the rule is anchored at the repository top and
computed relative to it, so a subdirectory-rooted service ignores its own
`.qwen/worktrees`. A byte-exact daemon-generated `.qwen/.gitignore` from
an earlier build is removed, a user-curated one is left untouched.

Unlike `setupWorktrees`, the session path does **not** create a baseline
commit: Codex applies the changes as uncommitted state, and the Changes view
shows them exactly as the user had them. This also keeps the detached HEAD
at the frozen base commit, which the cleanup and handoff logic rely on.

**Interaction with the cleanliness gates (verified).** Carrying dirty state
as uncommitted changes makes `worktreeHasWork` see work, so explicit session
deletion preserves the worktree instead of removing it. That is the safe
interim: preservation, never loss, and the worktree stays visible in the
Worktrees manager. P6 resolves it the Codex way — snapshot-then-delete
replaces the cleanliness refusal for managed session worktrees, so archiving
deletes the checkout after archiving its work. The prepared-worktree
rollback (`removePreparedUserWorktree`) must NOT preserve the carry itself:
`createUserWorktree` returns the carried repo-relative paths, the preparation
journal records them (`carriedPaths`), and the rollback's cleanliness gate
exempts exactly those paths — any other file (a nested marker-like name, a
late-arriving ignored file) still refuses the removal. A baseline commit is deliberately not used: it
would advance HEAD past the frozen base commit and break the HEAD-equality
gates P3 introduces (the same conflict the census flags for
`removePreparedUserWorktree`'s tip checks).

### D4 — Detached HEAD is the managed-worktree shape; metadata carries the slug

`createUserWorktree` gains an opt-in detached mode: `git worktree add
--detach <path> <base>` with no branch creation. Only the Web Shell session
route requests it; `enter_worktree`, agent isolation, workflow, and
`--worktree` startup keep creating named branches, so **both shapes coexist
permanently** and every consumer must tolerate both.

**The detached convention is `branch: ''` (empty string), not `undefined`.**
Verified hard constraint: the sidecar validator
(`worktreeSessionService.ts`) requires `typeof worktreeBranch ===
'string'`; an `undefined` branch makes the sidecar corrupt, and
`restoreWorktreeContext` deletes corrupt sidecars — the whole restore chain
would break. `''` passes validation, keeps the SDK's
`DaemonWorktreeInfo.branch: string` shape unchanged, and flows through the
bridge (which is pure pass-through, no git semantics) without type changes.
Display surfaces show the slug with the existing detached indicator
(`GitBranchIndicator` already renders `detached` from git status); the
restore context message omits the `(branch: …)` fragment when empty.
"Create branch here" fills `branch` with the real name in place and updates
the sidecar and live metadata.

The full consumer inventory (every site that reads `worktreeBranchForSlug`,
`WORKTREE_BRANCH_PREFIX`, or the metadata `branch` field) is enumerated in
the P3 section below. Every listed consumer migrates in P3 — no
half-migrated consumer ships. Hardcoded `.qwen/worktrees` root sites are
listed there for reference but migrate in P7, not P3.

### D5 — "Create branch here" is a session-scoped mutation

New route `POST /session/:id/worktree-branch` with `{ name }`: validates the
name with the same predicate as branch sessions (shared
`isValidGitBranchName`), refuses when the worktree already has a branch
(`worktree_already_branched`) or the name exists (`branch_already_exists`),
runs `git switch -c <name>` inside the worktree via
`GitWorktreeService.createWorktreeBranch`, and updates the sidecar and live
bridge metadata under the worktree-keyed ownership lock. Under the lock it
refuses a superseded sidecar (a reset moved the checkout to a replacement)
and verifies the marker still names this session; the marker itself needs
no change because the owner stays the same. Session resolution normalizes
persisted ids via the transcript store and falls back to the live bridge
summary for freshly created sessions that have no transcript yet (the user
can branch before the first prompt). Capability:
`session_worktree_branch_v1`. The UI affordance is a "Create branch here"
item in the branch picker popover (the worktree chip's menu), with an
inline name input; it is visible only when the popover serves a detached
worktree session (`gitSessionId` + fetched `detached` status) and the daemon
advertises the capability.

### D6 — Handoff moves the session, carrying the work

One route, `POST /session/:id/worktree-handoff` with
`{ to: 'local' | 'worktree', name?: string }`, keeps the same session id
(Codex moves the chat, not a replacement). Relocation uses the bridge's
`changeSessionCwd` on the live session — it queues behind in-flight prompts
and refuses while a prompt is active — under the worktree-keyed ownership
lock, with the same superseded-sidecar and marker-ownership guards as D5
(applied to the worktree being left). Both directions additionally refuse
a busy session up front (`cd_while_prompt_active`, the same gate as
worktree-reset) — the gate reads both `hasActivePrompt` and
`pendingPromptCount`, because a prompt is admitted (count flipped
synchronously) before `promptActive` is set while its attachments
resolve, and the barrier alone would not fence that window — and arm
the bridge's reset-pending admission barrier for the whole transfer: the snapshot/branch/checkout steps do not run on the
bridge's prompt queue, and the queue-tail check only runs after the queue
drains, so a prompt admitted mid-handoff would otherwise write files after
the copy and lose its last edits. While the barrier is armed, sendPrompt,
cd, workflow actions and goal control fail closed (`worktree_reset_active`,
retryable); the barrier is cleared in the route's finally. The
worktree-branch route carries the busy gate (`branch_while_prompt_active`).
Capability: `session_worktree_handoff_v1`.

- **Worktree → Local** (`to: 'local'`): refuse unless the local checkout
  (`sidecar.originalCwd`) is clean (`local_checkout_dirty`). The recorded
  base (`originalHeadCommit`) must describe the SAME checkout as
  `originalCwd`: the local HEAD may equal it or be a descendant (the user
  committed locally while the agent worked — the normal reason to use a
  worktree), reconciled by applying the snapshot on top; a divergent or
  unreadable local HEAD refuses with `local_head_moved`. A descendant is
  acceptable only for the snapshot-only path: when a branch will be
  checked out (recorded, or promoted at the worktree HEAD), a moved-ahead
  local HEAD refuses with `local_head_moved` — the checkout would drop
  the user's own ahead-of-base commit from the working tree. A snapshot that
  conflicts with the local checkout is refused with
  `handoff_snapshot_conflict` after restoring the local checkout — never
  left as conflict markers. A snapshot that cannot be captured from the
  worktree, or a non-conflict apply failure (e.g. an unwritable index), is
  refused with `handoff_carry_failed` — a carry that could not land, distinct
  from content to resolve. Carry the work first: a named worktree branch
  is checked out in the local checkout; a detached worktree with commits
  beyond base gets a branch first (`name`, else `worktree-<slug>`); a
  detached worktree at base with no work carries nothing. The worktree is
  detached first to release the branch — git forbids the same branch
  checked out in two worktrees at once. Uncommitted worktree changes travel
  as a `git stash create` snapshot applied in the local checkout after the
  checkout. Then relocate the session cwd to the local checkout, clear the
  sidecar and the bridge worktree association, and leave the worktree
  directory (with its marker) for retention cleanup (P6) or manual removal.
  Every worktree creation path records the base branch and HEAD commit in
  the sidecar (`originalBranch` / `originalHeadCommit`), plus the commit
  the worktree itself was created at (`worktreeBase`, falling back to
  `originalHeadCommit` for sidecars written before the field existed).
  The two differ when a branch worktree is created from a session living
  in a sibling managed worktree: `originalHeadCommit` keeps describing
  `originalCwd`'s checkout for the `local_head_moved` gate, while the
  beyond-base promotion test, `exit_worktree` and the orphan reaper read
  `worktreeBase`. A late failure rolls back: the
  auto branch is deleted only when the delete succeeds (otherwise the
  sidecar keeps naming it and the worktree is re-attached), so a retry
  always matches the checkout instead of wedging in
  `worktree_branch_mismatch`. When the worktree HEAD or the recorded base
  cannot be verified, the handoff refuses with
  `worktree_handoff_base_unavailable` instead of reporting success while
  the work stays behind.
- **Local → Worktree** (`to: 'worktree'`): the sidecar decision (refuse a
  `valid` sidecar, refuse an `invalid` one with `worktree_reset_invalid_state`,
  create only on `missing`) is taken INSIDE the worktree-keyed ownership
  lock, so concurrent requests cannot orphan a checkout. Create a detached
  managed worktree with the dirty overlay (D3), write the sidecar + marker,
  relocate the session into it, and set the bridge worktree metadata. The
  base is read from the workspace root — the checkout the sidecar records
  as `originalCwd` — so the base/cwd pair describes one checkout and the
  return leg cannot false-409 `local_head_moved`; a session cd'd into a
  sibling checkout starts its worktree at the workspace HEAD (the sibling's
  own commits stay in the sibling) while its dirty files are still carried
  from the session checkout. An unreadable HEAD refuses with
  `worktree_handoff_base_unavailable`. On relocation failure the rollback
  decides by OBSERVED state: a bridge timeout is caller-facing and the
  queued cd may still land the session in the worktree, so the route re-reads
  the effective cwd and keeps the checkout + sidecar when the session already
  lives there (comparing canonical realpath'd paths — the bridge reports the
  realpath while the service returns the raw join, and a symlinked workspace
  root must not roll back the checkout the session lives in); only when the
  cwd is still the pre-handoff checkout are the fresh worktree, sidecar, and
  marker removed. The auto-created branch name
  receives the same typed `branch_already_exists` refusal as an explicit
  name, and the "Move to worktree" action carries a hint that the local
  checkout keeps its dirty state and handing back requires a clean local
  checkout.

v1 limitations (documented, not silent): the local-clean requirement stands
in for "no other active session owns the local checkout" (the bridge has no
session-list probe to check occupancy); the handoff does not
implement `worktree-reset`'s crash-window atomic rollback — a crash
mid-handoff leaves a recoverable shape (the sidecar/marker still name the
session, and the worktree manager shows the checkout), not a self-healing
transfer. A daemon bound to a subdirectory refuses handoff-to-local with
`handoff_workspace_occupied`: `listWorkspaceSessions` only answers for the
bound workspace, so the occupants of a different `localCwd` cannot be
enumerated, and the route fails closed rather than move a shared checkout it
cannot inspect.

### D7 — Snapshots are work archives, restore recreates the worktree

Before a managed worktree is deleted (archive/delete trigger or retention
sweep), save a snapshot: a tar.gz of the worktree tree excluding regenerable
directories (the same exemption set `worktreeHasWork` uses: `node_modules`,
build output), plus a small JSON header (base commit, HEAD commit, branch if
any, dirty-state summary, session id, timestamp). Snapshots live under the
session chats directory next to the sidecar, keyed by session id.

Reopening a chat whose worktree was deleted offers restore: recreate the
worktree (detached at the recorded HEAD, or on the recorded branch), extract
the snapshot over it, flip the sidecar back. Retention protects worktrees of
active sessions and pinned chats; the sweep orders by last activity and
deletes oldest-first beyond `worktree.maxRetained`, snapshotting each.

## Phased implementation

### P1 — Default worktree + settings switch — implemented

- Schema: add `worktree.defaultForNewSessions` (D2); serve it to Web Shell.
- Client: initialize/apply the default intent per D1; chip shows worktree
  mode pre-send; existing reset/branch controls unchanged.
- i18n: update `gitMode.worktreeDesc` if needed; no new confirmation step.
- Tests: schema/validation, settings route exposure, composer default
  (setting on/off, async arrival, explicit selection wins — including
  across a transient git-status failure, reset not re-applied, workspace
  switch reset, non-Git/untrusted ineligible). The explicit-choice marker
  clears at draft boundaries (session id / active workspace change), not
  on transient eligibility drops.
- Drift guards: the repo-wide consistency checks migrate with the surface —
  the zh-CN settings coverage (`workspace-settings-i18n.test.ts`), the
  legacy telemetry route count and catalog (`telemetry.test.ts`,
  `telemetry-catalog.test.ts`), and the integration capabilities baseline
  (`integration-tests/cli/qwen-serve-routes.test.ts`).
- Acceptance: with no setting, a new session in a trusted Git workspace sends
  `worktree: {}` on first prompt; with `worktree.defaultForNewSessions: false`
  it sends no worktree param; explicit selections behave as today.

### P2 — Dirty carry-over for session worktrees — implemented

- Core: extract `captureDirtyState` / `applyDirtyState` helpers from
  `setupWorktrees` (capture-once semantics preserved there); add
  `carryDirtyState` option to `createUserWorktree` (D3). No baseline commit
  on the session path.
- Routes: both session worktree creation sites pass the option —
  `POST /session` (`session.ts`) and the branch-worktree preparation
  route (`session.ts`).
- Tests: `gitWorktreeService.dirty-carry.integ.test.ts` (real git fixture,
  symlinks-integ pattern) — three dirty shapes carried, source checkout and
  index untouched, HEAD stays at base, option off = today, dangling-symlink
  copy failure fails open.
- Acceptance: start a session worktree from a dirty checkout; the agent sees
  the same files the user has on disk.
- Capture source (shipped): the branch-worktree route passes
  `dirtyStateSource: base.checkoutCwd`, so a session already inside a
  worktree carries its own checkout's dirty state, not the main checkout's;
  the worktree is still placed under the workspace's managed root. The
  handoff `to:'worktree'` path does the same and bases the new worktree on
  the session checkout's recorded HEAD SHA (a branch name would resolve in
  the placement repository and could start at the wrong commit).

### P3 — Detached HEAD (core refactor) — implemented

- `createUserWorktree` opt-in detached mode (D4); session route uses it.
- Migrate every consumer in the inventory below (sidecar, marker, reset,
  cleanup/branch finalization, journal identity checks, restore prompt,
  Web Shell display, TUI footer indicator). SDK wire types stay unchanged
  (`branch: string`, `''` = detached).
- Cleanup: branch finalization becomes commit-finalization — a detached
  worktree with no commits beyond base and no work is removable; unique
  commits (HEAD reachability, per the `workspace-git-worktrees.ts` exemplar)
  or work preserve it (snapshot path in P6). Contract: a successful
  detached removal returns `{ success: true }` with `branchPreserved`
  unset (there is no branch to keep); a refused removal returns
  `{ success: false, branchPreserved: true }` — the flag then means the
  checkout itself was preserved, not a branch.
  `removeUserWorktree` additionally refuses the removal itself when a
  detached worktree carries unmerged commits: the named-branch path gets
  that protection from `git branch -d`'s refusal, which can never fire
  without a branch, so the detached path needs an explicit guard (an
  explicit force delete opts out). Detached cleanup also never deletes the
  slug-derived `worktree-<slug>` branch: the checkout was created with
  `worktree add --detach`, so a pre-existing ref of that name belongs to
  the user, not the session. (The prepared-worktree finalization is already
  ownership-safe: `worktree add -b` refuses a pre-existing branch, so the
  branch it later deletes is one the preparation itself created.) The
  `--worktree` startup re-attach gate keeps refusing foreign occupants
  including detached checkouts — startup worktrees are always named, and
  session re-attach goes through session-restore, not the flag.
- Tests: per-consumer migration tests; journal recovery on detached shape;
  reset/restore on detached shape; named-branch worktrees still work
  (both shapes tolerated everywhere).
- Acceptance: a new session worktree has no branch (`git branch --list
'worktree-*'` unchanged); all lifecycle operations work on it; existing
  named-branch tool/agent worktrees are unaffected.

**Consumer inventory** (codebase census 2026-11-14, load-bearing claims
re-verified against the source; each entry must be migrated or explicitly
tolerated in P3). Sites are identified by symbol, not line number — line
references drift with every merge. Convention: detached session worktrees
carry `branch: ''`; named-branch worktrees (tools, agents, startup) are
unchanged.

A. Creation and metadata producers

| Site                                                                                                        | Today                                                                       | P3 migration                                                                       |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `gitWorktreeService.ts` `createUserWorktree`                                                                | `-b worktree-<slug>`; same-name branch refusal; `WorktreeInfo.branch`       | Opt-in detached mode (`--detach`); branch refusal only in named mode; `branch: ''` |
| `cli/serve/routes/session.ts` POST /session                                                                 | Passes `worktree.branch` through                                            | Requests detached mode; `worktreeMeta.branch = ''`                                 |
| `cli/serve/routes/session.ts` branch-worktree route (POST /session `{branch:{worktree}}`)                   | Journal `worktreeBranch = worktreeBranchForSlug(slug)`; sidecar from result | Journal + sidecar carry the `''` convention                                        |
| `cli/startup/worktreeStartup.ts` named creation                                                             | Named creation (kept)                                                       | No detached creation here; startup worktrees stay named                            |
| `core/tools/enter-worktree.ts`; `core/tools/agent/agent.ts`; `core/agents/runtime/workflow-orchestrator.ts` | Named creation (kept)                                                       | No creation change; user/model-facing text must not claim a branch when `''`       |

B. Lifecycle gates (highest risk — fail-closed leaks if missed)

| Site                                                                     | Today                                                                 | P3 migration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitWorktreeService.ts` `removePreparedUserWorktree` `checkoutMatches`   | `HEAD == base && branch == worktree-<slug>`                           | `HEAD == base`; branch equality only in named mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `gitWorktreeService.ts` `removePreparedUserWorktree` `atBase` tip checks | `for-each-ref refs/heads/worktree-<slug>` tip `== base`               | Detached: covered by HEAD equality; named: unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `gitWorktreeService.ts` `finalizePreparedUserWorktreeBranch`             | Tip null → no-op; else `branch -d`                                    | `branchOwned` from the journal: named preparation owns its branch (`worktree add -b` refused a pre-existing one); detached preparation never deletes the slug-derived ref                                                                                                                                                                                                                                                                                                                                                                      |
| `gitWorktreeService.ts` `removeUserWorktree`                             | `-d`/`-D worktree-<slug>`; `branchPreserved`                          | Detached: refuse removal when HEAD carries unmerged commits of its own (force opts out); with the creation `baseCommit`, a HEAD at/behind base is no agent work even when the base is unreachable from any branch. Ownership is explicit (`branchOwned` for named creations, which provably own their slug ref even after the checkout moves) or inferred from the current branch (detached/in-place never own it). Reports `deletedBranch`/`keptBranch` so callers state what actually happened, never a deletion inferred from the slug name |
| `gitWorktreeService.ts` `hasUnmergedWorktreeCommits`                     | `rev-parse worktree-<slug>`, fail-closed `true` on error              | Judge by the checkout's own HEAD tip and actual branch (`--abbrev-ref HEAD` → `ownRef`), excluding that ref from `for-each-ref --contains <tip> refs/heads refs/remotes`; slug-ref fallback when the checkout is unreadable. Covers detached and in-place-branched worktrees alike                                                                                                                                                                                                                                                             |
| `cli/serve/server/worktree-orphan-cleanup.ts` `executeWorktreeCleanup`   | `worktreeHasWork` gate + `removeUserWorktree` + `branchPreserved` log | Gate unchanged in P3 (dirty work preserved, see D3); a refused detached removal re-observes the filesystem and logs the preserve; P6 snapshot lifts the gate                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli/serve/branch-worktree-preparation.ts` journal identity              | `worktreeBranch === worktreeBranchForSlug(slug)`                      | Accept the `''` detached convention alongside the named form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli/startup/worktreeStartup.ts` `setupStartupWorktree` reattach gate    | Expected branch; null → "Worktree already exists"                     | `getRegisteredWorktreeBranch` reports detached as `{branch: '', headCommit}`; the gate keeps refusing any occupant not on `worktree-<slug>`, including detached — session re-attach goes through session-restore, not this flag                                                                                                                                                                                                                                                                                                                |

C. Sidecar, restore, and display

| Site                                                                                                                                          | Today                                            | P3 migration                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `core/services/worktreeSessionService.ts` validator                                                                                           | `worktreeBranch: string` required                | No shape change; `''` convention documented        |
| `worktreeSessionService.ts` restore context message                                                                                           | `"(branch: …)"` injected into the model prompt   | Omit the fragment when `''` (or say detached HEAD) |
| `cli/serve/server/session-restore.ts`; `session-list.ts`                                                                                      | Pass-through to `setSessionWorktree` / responses | Tolerate `''`                                      |
| `cli/serve/routes/session.ts` worktree-reset                                                                                                  | Reads sidecar branch                             | Tolerate `''`                                      |
| `cli/nonInteractiveCli.ts`; `cli/ui/AppContainer.tsx:1124`; `cli/ui/opentui/opentui-app-shell.tsx:1097`; `cli/ui/hooks/useWorktreeSession.ts` | Branch display                                   | Show slug / detached indicator when `''`           |

D. Verified tolerant (no change needed)

- `core/agents/worktree-pin.ts` — already detached-friendly (exemplar).
- `cli/serve/routes/session-pr-backfill.ts` — slug-first PR parsing;
  loses only the renamed-branch fallback.
- `sdk-typescript DaemonSessionClient.ts` — durable identity compares
  `worktree.path` only.
- `acp-bridge/session-control-plane.ts` — pure pass-through, no git semantics.
- `workspace-git-worktrees.ts` — already detached-aware.
- `branch-worktree-preparation.ts` `resolveBranchWorktreeBaseCheckout` —
  `getCurrentBranch().catch(() => 'HEAD')` already tolerates a detached base.
- The 30-day agent sweep (`core/services/worktreeCleanup.ts`) only matches
  `agent-<7hex>` slugs, which POST /session rejects — session worktrees are
  never touched by it.

E. Tests pinning the branch contract (update in P3)

- `core/tools/enter-worktree.test.ts` (prefix contract)
- `core/tools/exit-worktree.test.ts`
- `core/services/git-worktree-marker.test.ts`
- `cli/serve/branch-worktree-preparation.test.ts`

Hardcoded `.qwen/worktrees` root sites (migrate in P7, listed for reference):
`gitWorktreeService.ts`; `core/config.ts`;
`worktreeSessionService.ts`; `core/utils/workspace-artifact-directory.ts`;
`core/utils/workspace-artifact-path.ts`; `core/tools/enter-worktree.ts`;
`core/tools/exit-worktree.ts`; `session.ts`;
`branch-worktree-preparation.ts`;
`workspace-route-runtime.ts`; `worktree-orphan-cleanup.ts`;
`session-restore.ts`. The daemon shell guard
(`daemon-git-worktree-guard.ts`) needs no root exemption today
because `.qwen/worktrees` sits inside the session root; P7 must re-derive
that property for a custom root.

### P4 — Create branch here — implemented

- Route `POST /session/:id/worktree-branch` (D5); SDK
  `createWorktreeBranch`; branch-picker menu item with inline name input.
- Tests: route suite (success + 400/409 taxonomy + 404), core
  `createWorktreeBranch` cases, popover visibility/submit/validation cases.
- Acceptance: detached worktree session → click → named branch, chip updates,
  commit/push flow works.

### P5 — Handoff — implemented

- Routes + git procedures per D6; SDK methods; chat-header affordance.
- Tests: both directions, dirty/commit carry, clean-checkout refusal,
  concurrent-session refusal, lock serialization, sidecar supersedes.
- Acceptance: a chat moves worktree↔local with its work intact; the git
  steps are handled, never left to the user.

### P6 — Retention + snapshot/restore

- Snapshot/restore per D7; `worktree.maxRetained` setting; archive/delete
  trigger; retention sweep; restore affordance on reopen.
- For managed session worktrees, snapshot-then-delete replaces the
  cleanliness refusal (`worktreeHasWork` / `isClean` gates): dirty carried
  state no longer blocks deletion because the snapshot preserves it (D3).
  Tool/agent worktrees keep the existing refusal semantics.
- Tests: snapshot content/exclusions, restore fidelity (commits + dirty +
  untracked), protection of active/pinned, count ordering, `0` disables,
  dirty-worktree deletion after snapshot.
- Acceptance: archiving a chat deletes its worktree after snapshotting;
  reopening offers restore; the sweep keeps the most recent 15.

### P7 — Configurable worktree root

- `worktree.root` setting; migrate hardcoded `.qwen/worktrees` sites to the
  resolved root; containment and shell-guard rules re-derived for the custom
  root (security-sensitive: the daemon shell guard, journal identity checks,
  and reset containment all key on the managed root).
- Tests: custom root creation/identity/recovery; escape rejection; default
  root unchanged.
- Acceptance: worktrees live under the configured root; all guards follow.

## Scope boundaries

- `POST /session` without `worktree` is unchanged. With `worktree`, every
  caller (Web Shell, SDK, channel, managed-session) gets a detached
  worktree: `worktree.branch` is `''` and no `worktree-<slug>` ref is
  created. Callers that need a named branch use
  `POST /session/:id/worktree-branch` on the session worktree, or
  `enter_worktree`, which keeps named branches.
- No change to `enter_worktree` / `exit_worktree` tool behavior, agent
  isolation worktrees, or Arena worktrees (they keep named branches; Codex
  parity targets Web Shell session worktrees).
- No change to managed (server) sessions' own worktree design
  (`2026-10-28-managed-session-worktrees.md`); alignment there is follow-up.
- Branch-mode sessions (`branch: { name }`) are unchanged.
- No merge-back UI beyond handoff; PR creation stays in the existing git flow.

## Risks and open questions

- **P3 blast radius**: the census is complete (inventory above). The
  highest-risk sites are fail-closed gates that would silently leak or
  permanently preserve detached worktrees: `removePreparedUserWorktree`'s
  branch/tip double gate, `hasUnmergedWorktreeCommits` (fail-closed `true`),
  the sidecar `worktreeBranch: string` validator, `--worktree` reattach, and
  the journal identity gate. A missed consumer is a silent lifecycle
  failure, so P3 ships with per-consumer migration tests.
- **Interim branch pollution**: P1–P2 ship before P3, so default-on sessions
  temporarily create `worktree-<slug>` branches (deleted on session cleanup).
  Acceptable interim; P3 removes it.
- **Dirty carry × cleanliness gates**: from P2 until P6, a session worktree
  carrying dirty state is preserved (not deleted) on explicit session
  deletion, because `worktreeHasWork`/`isClean` see work. Safe (no loss) but
  the worktree lingers in the Worktrees manager; P6's snapshot-then-delete
  resolves it. Documented in D3.
- **Dirty overlay conflicts**: `stash apply` can conflict when the worktree
  base differs from the source HEAD (it does not — same commit — but local
  index state can still differ). Detected by the unmerged index state and
  failed closed (D3): creation restores committed state and refuses; the
  handoff restores the local checkout and refuses with
  `handoff_snapshot_conflict`. Non-conflict apply failures (e.g. an
  unwritable index) fail closed the same way — a carry that did not land
  is never reported as carried.
- **Handoff with a dirty local checkout**: refused (D6). Codex's exact
  behavior here is undocumented; refusal is the safe reading.
- **Snapshot size**: excluding regenerable dirs keeps archives small, but a
  repo with large tracked binaries still produces large snapshots. No size
  cap in v1; revisit if needed.
- **Custom root security (P7)**: every containment check must follow the
  configured root; a root outside the workspace trust boundary is rejected.

## Validation

- Per-phase unit tests (collocated) plus the E2E plan in
  `.qwen/e2e-tests/web-shell-codex-worktree-parity.md`.
- Baseline dry-run against the installed `qwen` CLI before implementation;
  post-implementation verification against `node dist/cli.js`.
- Build + typecheck + bundle, focused package tests, self-audit per AGENTS.md.
