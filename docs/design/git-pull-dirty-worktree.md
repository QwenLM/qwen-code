# Git pull with a dirty working tree

## Goal

Let the Web Shell "Update Project" action succeed when the workspace has
uncommitted changes, instead of dead-ending at an opaque
`dirty_working_tree` error that forces users back to a terminal.

## Problem

The workspace git pull path (branch picker popover → SDK
`workspaceGitPull` → `POST /workspace(s)/git/pull` → core `gitPull`) runs a
plain `git pull`. With local modifications to files the incoming merge
touches, git refuses to merge; the route already classified that failure
as `409 dirty_working_tree` with a path-redacted git message, but the
popover only rendered the SDK's raw error string, so nothing actionable
surfaced.

## Behavior

`POST /workspace/git/pull` and `POST /workspaces/:workspace/git/pull`
accept two new boolean options (both default false, mutually exclusive —
sending both is a 400). They are the two things a user would do in a
terminal, and nothing more:

- `stash`: fetch (`--prune`, so a tracking ref pruned earlier is back if
  the remote branch exists again), check the upstream, `git stash push
--include-untracked`, run the same `git pull` as before, then restore
  the entry. If the pull fails, the merge or rebase it started is aborted
  and the entry is restored, so the workspace is back in its pre-pull
  state; the response is `409 pull_failed` carrying git's message — also
  when there was nothing to stash (edits hidden by `skip-worktree`, a
  diverged clean tree), so the client shows git's reason instead of
  re-offering the same resolution. If git refuses the stash itself (an
  intent-to-add entry, a wedged index lock), nothing has been touched and
  the refusal is `409 pull_failed` as well. If the pull succeeds but the
  restore does not (a conflict, or an incoming file at a path the stash
  holds untracked), the response is still a success with
  `stashRestoreConflict: true` and `stashSha`; git keeps the entry, and
  `output` names it.
- `force`: fetch (`--prune`), check the upstream, refuse unless the update
  is a fast-forward, then `git reset --hard` + `git clean -fd` (ignored
  files are kept) and `git merge --ff-only <validated sha>`. Destructive,
  so everything is validated before anything is discarded: a branch
  deleted on the remote is refused as `409 pull_failed` with nothing
  discarded, a diverged branch as `409 diverged` while the local changes
  are still intact. The merge integrates the exact commit that was
  validated, by SHA: neither a push landing between the check and the
  merge nor a concurrent fetch moving `@{upstream}` can turn the validated
  fast-forward into a refusal after the discard. `force` is refused (`409
force_unsupported`) when the workspace cwd is below the repository root,
  because `git reset --hard` acts on the whole repository and would erase
  changes outside the workspace.

Both options are refused (`409 operation_in_progress`) while a merge,
cherry-pick, revert, rebase or am is parked in the worktree: `git stash
push` and `git reset --hard` both clear that state — a resolved but
uncommitted merge lives only in `MERGE_HEAD`. The probe runs immediately
before each of those two commands, so the window in which a terminal can
park an operation unseen is the command itself. The states are read
through `git rev-parse --git-path`, so linked worktrees resolve correctly
and a branch named `MERGE_HEAD` cannot shadow them.

The failure recovery aborts only the merge or rebase the pull itself
created, and its provenance comes from git: when such a state already
exists, `git pull` exits 128 before touching the tree, so a merge or
rebase present after an exit of 1 (git attempted the integration and
stopped on conflicts) is the pull's own. It must also point at the
upstream tip the pull integrated. Anything else — a merge a terminal
parked meanwhile, whatever its tip — is left in place, and the failure
names the stash entry that still holds the user's changes. The recovery
helpers are best-effort end to end: a probe or listing failure never
turns a recovered state into an unclassified error.

The stash entry is identified by provenance and SHA, never by position:
the listing is compared before and after the push and the entry chosen is
the new one carrying the auto-stash message (a terminal push landing in
between sits above it and is left alone; if that re-listing fails, the
refusal points at the entry by its message); the restore is `git stash
apply <sha>`; the drop names the slot resolved right before it and then
checks the SHA git reports as dropped — git has no identity-addressed
drop — and if the slots shifted under it, the other entry is `git stash
store`d back and ours is reported as kept; should even that store fail,
the displaced entry's SHA and the command that brings it back are in the
output. Every notice about a kept entry carries its SHA.

A plain pull — no option — is byte-for-byte the previous behavior.

## Non-goals (deliberate)

These are the boundaries of the feature; each is a decision, not an
omission:

- **Ambient git configuration is honored, not overridden.** The pull is
  the same `git pull` the terminal runs, so `pull.rebase`, `pull.ff`,
  `merge.ff`, autostash and signing settings apply exactly as they do
  there. A host whose policy makes a diverged plain pull fatal gets the
  same fatal here (restored, as `pull_failed`), with git's own hint.
- **Ignored files are expendable, as in git.** Git checks incoming files
  out over ignored paths silently; a terminal `git pull` and the plain
  pull on `main` already do this. The resolution flows do not add a
  collision preflight: one that is correct for every path shape (renames,
  symlinks, case folding, criss-cross merge bases, nested repositories)
  is a re-implementation of git's checkout rules, not a feature of this
  UI.
- **No cross-request serialization.** Concurrent pulls on one repository
  fail loudly on git's own `index.lock`; the provenance-based capture,
  identity-based restore and checked drop fail closed (entry kept,
  `stashRestoreConflict`, or the other entry stored back) rather than
  applying or dropping someone else's entry. Nothing is lost in any
  interleaving.
- **Failures are classified by what the core did, not by matching git's
  text.** The new codes come from `GitPullFailure`; the pre-existing
  regex classification in the route is unchanged and still covers the
  plain pull.

## UI

When the plain pull fails with `409 dirty_working_tree`, the branch picker
footer switches from the status line to a resolution panel offering:

- **Stash Changes and Update** — pulls with `stash: true`.
- **Discard Changes and Update…** — destructive, so it takes a second
  click: the panel swaps to a warning plus a confirm button that pulls with
  `force: true`.
- **Cancel** — dismisses the panel.

The panel stays mounted (with a spinner on the clicked button) while its
own pull is in flight, resets whenever the popover is reopened, and is
dismissed by any competing action that actually runs (checkout, push, a
valid new-branch submit). A success with `stashRestoreConflict` renders
as a warning naming the stash entry (`stashSha`) that holds the changes;
that warning survives the reopen reset, since the pull may settle while
the popover is closed and it is the only signal the user gets. A
`force_unsupported` refusal keeps the panel up with the daemon's
explanation in place of the blocked line, because the tree is still
dirty and stashing is still available. Every other refusal —
`pull_failed`, `diverged`, `operation_in_progress` — renders the daemon's
`message`, which carries git's own notice or the core's explanation,
instead of the SDK's route label.

The SDK's `workspaceGitPull` takes an optional per-call timeout so the
popover can outsize the client's default fetch budget: the stash flow's
failure path chains up to 16 git commands, each with its own 30s limit,
so the popover allows 600s.

## Ownership

Both routes keep their existing scoping: the legacy route is
legacy-primary-workspace scoped; the qualified route resolves the trusted
runtime and contained `cwd` exactly as before. The new options only change
which git commands run inside the resolved workspace and add no new trust
surface.

## Alternatives considered

Automatic stash on every dirty pull was rejected: silently moving the
user's changes through a stash is surprising, and the discard option is
destructive, so both need an explicit choice. `git pull --autostash`
performs that same stash-then-restore implicitly, so it was not adopted.
