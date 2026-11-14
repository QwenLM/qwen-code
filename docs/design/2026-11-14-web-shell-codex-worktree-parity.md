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
when the workspace is eligible (trusted + Git branch present) and the effective
setting is `true`. SDK, channel, and managed-session callers keep explicit
control; no wire semantics change.

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
untracked files with `--full-name` and copies from the repository top, so a
service rooted at a subdirectory still lands files at the correct worktree
offset (the pre-extraction pattern misplaced them).

Unlike `setupWorktrees`, the session path does **not** create a baseline
commit: Codex applies the changes as uncommitted state, and the Changes view
shows them exactly as the user had them. This also keeps the detached HEAD
at the frozen base commit, which the cleanup and handoff logic rely on.

**Interaction with the cleanliness gates (verified).** Carrying dirty state
as uncommitted changes makes `worktreeHasWork` and the `isClean` gate in
`removePreparedUserWorktree` see work, so explicit session deletion preserves
the worktree instead of removing it. That is the safe interim: preservation,
never loss, and the worktree stays visible in the Worktrees manager. P6
resolves it the Codex way — snapshot-then-delete replaces the cleanliness
refusal for managed session worktrees, so archiving deletes the checkout
after archiving its work. A baseline commit is deliberately not used: it
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
(`worktreeSessionService.ts:100-118`) requires `typeof worktreeBranch ===
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
(applied to the worktree being left). Capability: `session_worktree_handoff_v1`.

- **Worktree → Local** (`to: 'local'`): refuse unless the local checkout
  (`sidecar.originalCwd`) is clean (`local_checkout_dirty`). Carry the work
  first: a named worktree branch is checked out in the local checkout; a
  detached worktree with commits beyond base gets a branch first
  (`name`, else `worktree-<slug>`); a detached worktree at base with no work
  carries nothing. The worktree is detached first to release the branch —
  git forbids the same branch checked out in two worktrees at once. Uncommitted worktree changes travel as a `git stash
create` snapshot applied in the local checkout after the checkout. Then
  relocate the session cwd to the local checkout, clear the sidecar and the
  bridge worktree association, and leave the worktree directory (with its
  marker) for retention cleanup (P6) or manual removal.
- **Local → Worktree** (`to: 'worktree'`): refuse if the session already has
  a worktree sidecar. Create a detached managed worktree from the local
  HEAD with the dirty overlay (D3), write the sidecar + marker, relocate the
  session into it, and set the bridge worktree metadata. On relocation
  failure the fresh worktree, sidecar, and marker are rolled back. The local
  checkout is left as it was.

v1 limitations (documented, not silent): the local-clean requirement stands
in for "no other active session owns the local checkout" (the bridge has no
session-list probe to check occupancy); and the handoff does not implement
`worktree-reset`'s crash-window atomic rollback — a crash mid-handoff leaves
a recoverable shape (the sidecar/marker still name the session, and the
worktree manager shows the checkout), not a self-healing transfer.

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
- Acceptance: with no setting, a new session in a trusted Git workspace sends
  `worktree: {}` on first prompt; with `worktree.defaultForNewSessions: false`
  it sends no worktree param; explicit selections behave as today.

### P2 — Dirty carry-over for session worktrees — implemented

- Core: extract `captureDirtyState` / `applyDirtyState` helpers from
  `setupWorktrees` (capture-once semantics preserved there); add
  `carryDirtyState` option to `createUserWorktree` (D3). No baseline commit
  on the session path.
- Routes: both session worktree creation sites pass the option —
  `POST /session` (`session.ts:3388`) and the branch-worktree preparation
  route (`session.ts:5172`).
- Tests: `gitWorktreeService.dirty-carry.integ.test.ts` (real git fixture,
  symlinks-integ pattern) — three dirty shapes carried, source checkout and
  index untouched, HEAD stays at base, option off = today, dangling-symlink
  copy failure fails open.
- Acceptance: start a session worktree from a dirty checkout; the agent sees
  the same files the user has on disk.
- Known limitation (nested case): the branch-worktree route captures dirty
  state from `base.repoTop` (the main checkout). A session already inside a
  worktree therefore carries the main checkout's dirty state, not its own;
  when the HEADs differ the stash apply fails open to committed state (no
  loss). P3's detached refactor revisits this route's capture source.

### P3 — Detached HEAD (core refactor) — implemented

- `createUserWorktree` opt-in detached mode (D4); session route uses it.
- Migrate every consumer in the inventory below (sidecar, marker, reset,
  cleanup/branch finalization, journal identity checks, restore prompt,
  Web Shell display, TUI footer indicator). SDK wire types stay unchanged
  (`branch: string`, `''` = detached).
- Cleanup: branch finalization becomes commit-finalization — a detached
  worktree with no commits beyond base and no work is removable; unique
  commits (HEAD reachability, per the `workspace-git-worktrees.ts` exemplar)
  or work preserve it (snapshot path in P6). `branchPreserved` reports
  `false` for detached removals (there is no branch to keep).
- Tests: per-consumer migration tests; journal recovery on detached shape;
  reset/restore on detached shape; named-branch worktrees still work
  (both shapes tolerated everywhere).
- Acceptance: a new session worktree has no branch (`git branch --list
'worktree-*'` unchanged); all lifecycle operations work on it; existing
  named-branch tool/agent worktrees are unaffected.

**Consumer inventory** (codebase census 2026-11-14, load-bearing claims
re-verified against the source; each entry must be migrated or explicitly
tolerated in P3). Convention: detached session worktrees carry `branch: ''`;
named-branch worktrees (tools, agents, startup) are unchanged.

A. Creation and metadata producers

| Site                                                                                                                              | Today                                                                       | P3 migration                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `core/services/gitWorktreeService.ts:2487-2543` `createUserWorktree`                                                              | `-b worktree-<slug>`; same-name branch refusal; `WorktreeInfo.branch`       | Opt-in detached mode (`--detach`); branch refusal only in named mode; `branch: ''` |
| `cli/serve/routes/session.ts:3388-3400` POST /session                                                                             | Passes `worktree.branch` through                                            | Requests detached mode; `worktreeMeta.branch = ''`                                 |
| `cli/serve/routes/session.ts:5166-5215` branch-worktree route                                                                     | Journal `worktreeBranch = worktreeBranchForSlug(slug)`; sidecar from result | Journal + sidecar carry the `''` convention                                        |
| `cli/startup/worktreeStartup.ts:342,528`                                                                                          | Named creation (kept)                                                       | Sidecar write tolerates `''` when reattaching a detached checkout                  |
| `core/tools/enter-worktree.ts:164,200-229`; `core/tools/agent/agent.ts:3569`; `core/agents/runtime/workflow-orchestrator.ts:1819` | Named creation (kept)                                                       | No creation change; user/model-facing text must not claim a branch when `''`       |

B. Lifecycle gates (highest risk — fail-closed leaks if missed)

| Site                                                                           | Today                                                                 | P3 migration                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitWorktreeService.ts:3122-3131` `checkoutMatches`                            | `HEAD == base && branch == worktree-<slug>`                           | `HEAD == base`; branch equality only in named mode                                                                                            |
| `gitWorktreeService.ts:3193-3207` tip checks (×2)                              | `for-each-ref refs/heads/worktree-<slug>` tip `== base`               | Detached: covered by HEAD equality; named: unchanged                                                                                          |
| `gitWorktreeService.ts:3262-3287` `finalizePreparedUserWorktreeBranch`         | Tip null → no-op; else `branch -d`                                    | Already tolerant (no branch → no-op); keep                                                                                                    |
| `gitWorktreeService.ts:2990-3047` `removeUserWorktree`                         | `-d`/`-D worktree-<slug>`; `branchPreserved`                          | Detached: skip branch deletion, `branchPreserved: false` (no branch to keep); named: unchanged                                                |
| `gitWorktreeService.ts:3296-3330` `hasUnmergedWorktreeCommits`                 | `rev-parse worktree-<slug>`, fail-closed `true` on error              | Detached: judge by HEAD reachability — exemplar `cli/serve/routes/workspace-git-worktrees.ts:714-725` (`commitIsReachable`); named: unchanged |
| `cli/serve/server/worktree-orphan-cleanup.ts:427-469` `executeWorktreeCleanup` | `worktreeHasWork` gate + `removeUserWorktree` + `branchPreserved` log | Gate unchanged in P3 (dirty work preserved, see D3); log tolerates no-branch; P6 snapshot lifts the gate                                      |
| `cli/serve/branch-worktree-preparation.ts:436` journal identity                | `worktreeBranch === worktreeBranchForSlug(slug)`                      | Accept the `''` detached convention alongside the named form                                                                                  |
| `cli/startup/worktreeStartup.ts:250-282` reattach                              | Expected branch; null → "Worktree already exists"                     | `getRegisteredWorktreeBranch` reports detached as `{branch: '', headCommit}` (identity validation kept); reattach accepts `''`                |

C. Sidecar, restore, and display

| Site                                                                                                                                                  | Today                                            | P3 migration                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `core/services/worktreeSessionService.ts:100-118` validator                                                                                           | `worktreeBranch: string` required                | No shape change; `''` convention documented        |
| `worktreeSessionService.ts:913` restore context message                                                                                               | `"(branch: …)"` injected into the model prompt   | Omit the fragment when `''` (or say detached HEAD) |
| `cli/serve/server/session-restore.ts:243,401`; `session-list.ts:501`                                                                                  | Pass-through to `setSessionWorktree` / responses | Tolerate `''`                                      |
| `cli/serve/routes/session.ts:4500,4550,4663` worktree-reset                                                                                           | Reads sidecar branch                             | Tolerate `''`                                      |
| `cli/nonInteractiveCli.ts:1668`; `cli/ui/AppContainer.tsx:1124`; `cli/ui/opentui/opentui-app-shell.tsx:1097`; `cli/ui/hooks/useWorktreeSession.ts:53` | Branch display                                   | Show slug / detached indicator when `''`           |

D. Verified tolerant (no change needed)

- `core/agents/worktree-pin.ts:127-131` — already detached-friendly (exemplar).
- `cli/serve/routes/session-pr-backfill.ts:81-97,576` — slug-first PR parsing;
  loses only the renamed-branch fallback.
- `sdk-typescript DaemonSessionClient.ts:898-928` — durable identity compares
  `worktree.path` only.
- `acp-bridge/session-control-plane.ts` — pure pass-through, no git semantics.
- `workspace-git-worktrees.ts:714-725` — already detached-aware.
- `branch-worktree-preparation.ts:709` `resolveBranchWorktreeBaseCheckout` —
  `getCurrentBranch().catch(() => 'HEAD')` already tolerates a detached base.
- The 30-day agent sweep (`core/services/worktreeCleanup.ts`) only matches
  `agent-<7hex>` slugs, which POST /session rejects — session worktrees are
  never touched by it.

E. Tests pinning the branch contract (update in P3)

- `core/tools/enter-worktree.test.ts:108-115` (prefix contract)
- `core/tools/exit-worktree.test.ts:258,299,310,423,458`
- `core/services/git-worktree-marker.test.ts:431`
- `cli/serve/branch-worktree-preparation.test.ts`

Hardcoded `.qwen/worktrees` root sites (migrate in P7, listed for reference):
`gitWorktreeService.ts:1936-1945,3069-3075`; `core/config.ts:5006`;
`worktreeSessionService.ts:647,832`; `core/utils/workspace-artifact-directory.ts:58`;
`core/utils/workspace-artifact-path.ts:12,30`; `core/tools/enter-worktree.ts:84`;
`core/tools/exit-worktree.ts:546-551`; `session.ts:3653,3665,5263,4173`;
`branch-worktree-preparation.ts:434,696,735-745`;
`workspace-route-runtime.ts:698`; `worktree-orphan-cleanup.ts:198,202`;
`session-restore.ts:192,327`. The daemon shell guard
(`daemon-git-worktree-guard.ts:3288-3331`) needs no root exemption today
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

- No change to `POST /session` wire semantics for callers that do not opt in.
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
  index state can still differ). Fail-open per the existing pattern; the
  session starts with committed state and the failure is surfaced.
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
