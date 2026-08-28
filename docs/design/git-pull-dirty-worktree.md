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

- `stash`: `git stash push --include-untracked`, run the same `git pull`
  as before, then restore the entry. If the pull fails, the merge or
  rebase it started is aborted and the entry is restored, so the
  workspace is back in its pre-pull state; the response is `409
pull_failed` carrying git's message. If the pull succeeds but the
  restore does not (a conflict, or an incoming file at a path the stash
  holds untracked), the response is still a success with
  `stashRestoreConflict: true`; git keeps the entry, and `output` names
  it.
- `force`: `git reset --hard` + `git clean -fd` (ignored files are kept),
  then `git pull --ff-only`. Destructive, so the update is validated
  before anything is discarded: the branch is fetched first and a
  diverged branch is refused (`409 diverged`) while the local changes are
  still intact, which also means the post-discard pull can only ever
  fast-forward. `force` is refused (`409 force_unsupported`) when the
  workspace cwd is below the repository root, because `git reset --hard`
  acts on the whole repository and would erase changes outside the
  workspace.

Both options are refused (`409 operation_in_progress`) while a merge,
cherry-pick, revert, rebase or am is parked in the worktree: `git stash
push` and `git reset --hard` both clear that state — a resolved but
uncommitted merge lives only in `MERGE_HEAD` — and the failure recovery
must only ever abort a merge or rebase the pull itself started. The
states are probed through `git rev-parse --git-path`, so linked worktrees
resolve correctly and a branch named `MERGE_HEAD` cannot shadow them.

The stash entry is identified by SHA, never by position: `refs/stash` is
compared before and after the push (parsing the push output differs by
git version and locale), the restore is `git stash apply <sha>`, and the
drop looks the entry's slot up at drop time. A terminal pushing to the
shared stash while the pull runs therefore neither gets consumed nor
prevents the restore.

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
  fail loudly on git's own `index.lock`; the identity-based restore
  fails closed (entry kept, `stashRestoreConflict`) rather than applying
  someone else's entry. Nothing is lost in any interleaving.
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
dismissed by any competing action (checkout, push, new branch). A success
with `stashRestoreConflict` renders as a warning that names the stash as
the place the changes are kept. Every other refusal — `pull_failed`,
`diverged`, `operation_in_progress`, `force_unsupported` — renders the
daemon's `message`, which carries git's own notice or the core's
explanation, instead of the SDK's route label.

The SDK's `workspaceGitPull` takes an optional per-call timeout so the
popover can outsize the client's default fetch budget: the stash flow
chains several git commands, each with its own 30s limit.

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
