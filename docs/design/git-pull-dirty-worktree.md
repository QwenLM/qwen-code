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
  the restore conflicts after a successful pull, the response is still a
  success and its `output` carries git's conflict notice; git keeps the
  stash entry, so nothing is lost.
- `force`: discard all local changes first (`git reset --hard` +
  `git clean -fd`; ignored files are kept), then pull. Destructive.

Stash detection compares `refs/stash` before/after the push instead of
parsing git output, which varies by version and locale.

## UI

When the plain pull fails with `409 dirty_working_tree`, the branch picker
footer switches from the status line to a resolution panel offering:

- **Stash Changes and Update** — pulls with `stash: true`.
- **Discard Changes and Update…** — destructive, so it takes a second
  click: the panel swaps to a warning plus a confirm button that pulls with
  `force: true`.
- **Cancel** — dismisses the panel.

The panel state resets whenever the popover is reopened.

## Ownership

Both routes keep their existing scoping: the legacy route is
legacy-primary-workspace scoped; the qualified route resolves the trusted
runtime and contained `cwd` exactly as before. The new options only change
which git commands run inside the resolved workspace and add no new trust
surface.

## Alternatives considered

Automatic stash on every dirty pull was rejected: silently moving the
user's changes through a stash is surprising, and the discard option is
destructive, so both need an explicit choice. `git pull --autostash` was
not usable because autostash only exists for rebase, while the default
pull here is a merge.
