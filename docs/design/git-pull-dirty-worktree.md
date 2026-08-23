# Git pull with a dirty working tree

## Goal

Let the Web Shell "Update Project" action succeed when the workspace has
uncommitted changes, instead of dead-ending at an opaque
`dirty_working_tree` error that forces users back to a terminal.

## Problem

The workspace git pull path (branch picker popover → SDK
`workspaceGitPull` → `POST /workspace(s)/git/pull` → core `gitPull`) ran a
plain `git pull`. With local modifications to files the incoming merge
touches, git refuses to merge; the route already classified that failure as
`409 dirty_working_tree` with a path-redacted git message, but the popover
only rendered the SDK's raw error string, so nothing actionable surfaced.

## Behavior

`POST /workspace/git/pull` and `POST /workspaces/:workspace/git/pull`
accept two new boolean options (both default false, mutually exclusive —
sending both is a 400):

- `stash`: stash local changes (`git stash push --include-untracked`, so
  untracked files that could block the merge are covered), run the pull,
  then `git stash pop`. If the pull fails, any partial merge/rebase is
  aborted and the stash is popped back, restoring the pre-pull state. If
  the restore fails after a successful pull — a conflict, or an
  untracked-file collision — the response is still a success with
  `stashRestoreConflict: true` and its `output` carries git's failure
  notice; git keeps the stash entry, so nothing is lost.
- `force`: discard all local changes first (`git reset --hard` +
  `git clean -fd`; ignored files are kept), then pull. Destructive.
  `git reset --hard` acts on the whole repository regardless of the cwd,
  but `git clean -fd` run from a subdirectory only removes untracked
  files inside that subtree, so `force` is refused when the workspace
  cwd is below the repository root (it would destroy tracked changes
  outside the workspace while leaving the untracked files that block the
  merge in place). The pull is validated before anything is
  discarded: the fetch runs first and a diverged branch (local commits
  on both sides) is refused, because the post-discard merge could wedge
  the repository mid-merge; a failed post-discard pull still aborts any
  partial merge/rebase.

Stash detection compares `refs/stash` before/after the push instead of
parsing git output, which varies by version and locale. The pull itself
passes `--no-rebase --no-edit` when rebase is not requested, so divergent
branches merge instead of fataling on git builds without a `pull.rebase`
/ `pull.ff` policy.

## UI

When the plain pull fails with `409 dirty_working_tree`, the branch picker
footer switches from the status line to a resolution panel offering:

- **Stash Changes and Update** — pulls with `stash: true`.
- **Discard Changes and Update…** — destructive, so it takes a second
  click: the panel swaps to a warning plus a confirm button that pulls with
  `force: true`.
- **Cancel** — dismisses the panel.

The panel stays mounted (with a spinner on the clicked button) while its
own stash/discard pull is in flight, and resets whenever the popover is
reopened. When the blocking state is an unmerged working tree (conflicting
restore or abandoned merge), the stash option is replaced by an
explanation — `git stash push` refuses unmerged entries — leaving discard
as the recovery path, except in workspaces below the repository root,
where discarding is unsupported and the conflicts must be resolved from
a terminal.

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
