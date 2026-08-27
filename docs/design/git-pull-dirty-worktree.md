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
  then restore by `git stash apply` + identity re-check + `git stash
drop` — never a single `git stash pop`, because `refs/stash` is
  shared with the user's terminal and no check-then-act on it is atomic:
  the apply leaves every entry in place, so a racing push or pop is
  reported as a restore conflict with the entries kept instead of
  consuming a foreign entry behind a success. If the pull fails, any
  partial merge/rebase is aborted and the stash is popped back,
  restoring the pre-pull state. If the restore fails after a successful
  pull — a conflict, an untracked-file collision, or a racing actor —
  the response is still a success with `stashRestoreConflict: true` and
  its `output` carries git's failure notice; git keeps the stash entry,
  so nothing is lost.
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
parsing git output, which varies by version and locale, and the restore
attributes the entry by identity — the recorded SHA plus the reflog
marker the auto-stash pushes with — rather than by stack movement, which
a concurrent actor's push also changes: when the top of the stack is not
attributable as the pull's own entry, the restore fails closed with the
stash pointer instead of applying and dropping a foreign entry. The update runs
as an explicit fetch followed by a merge (or rebase) of exactly the
fetched upstream tip, never as a bare `git pull`: re-fetching between
the probe and the merge would let a commit pushed into that window
bypass the probe, and on the force path could fail a fetch after the
local changes were already discarded. The merge passes `--ff --no-edit --no-autostash --no-verify-signatures
--no-gpg-sign --commit --no-squash` (the rebase passes `--no-autostash
--no-gpg-sign`) so
divergent branches merge instead of fataling on git builds without a
`pull.rebase` / `pull.ff` policy, and ambient config the HOME/system
channels keep reachable cannot change the outcome host-dependently:
`merge.autostash`/`rebase.autostash` would silently move the user's
changes through a stash the caller never learns about; `merge.ff = only`
would fatal the pinned merge on diverged branches, recreating the exact
dead-end this feature exists to eliminate; `merge.verifySignatures =
true` would fatal on every unsigned tip, even a fast-forward;
`commit.gpgsign = true` would fatal the merge/rebase commit write
whenever the daemon process cannot sign, leaving the MERGE_HEAD the
update created behind; and `branch.<name>.mergeoptions` is read before
command-line options, so a `--no-commit` or `--squash` injected there
would stop the pinned merge before committing — exit 0, HEAD unmoved,
MERGE_HEAD left behind — while the pinned `--commit --no-squash` parses
after the mergeoptions defaults and wins. A configured `pull.rebase` or `pull.ff` policy —
and the `merge.ff`, `merge.verifySignatures`, `commit.gpgsign`, and
`branch.<name>.mergeoptions` keys above — is deliberately overridden by
this pinned shape: the resolution
flow must behave the same on every host, honoring `pull.ff = only`
would recreate the exact dead-end this feature exists to eliminate (the
update refuses instead of resolving), and ambient policy is what makes
a bare `git pull` fatal on policy-less git builds; users who want
rebase-on-pull semantics get them through the explicit `rebase` option
instead. Pulls are serialized per workspace cwd so
overlapping pulls cannot cross-apply each other's auto-stashes (one
shared `refs/stash`) or abort each other's in-progress merge.

Pulls are refused while a merge, rebase, cherry-pick, revert, or am
session is already in progress (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`, the rebase state directories, or a stopped `git am`,
which parks in `rebase-apply` without the `onto` file a rebase
writes): the failure recovery aborts merge/rebase state
indiscriminately, so it must only ever abort state the pull itself
started, and the stash/discard steps would abandon the staged
resolution a cherry-pick, revert, or am carries (unrecoverable by
reflog). Every mutating step re-verifies both identities immediately
before it — the foreign-state guard plus HEAD still being the branch the
upstream resolved for — and refuses with `head_changed` (retryable; the
auto-stash is restored) when a concurrent checkout moved HEAD during the
slow probe window: the merge would land on the foreign branch, and on
the force path `reset --hard` would erase foreign sequence heads before
any later guard could see them. Every pull shape — plain, stash, and
force — is also refused when the incoming commits add paths that exist
locally as ignored files: git would silently check the incoming file
out over the ignored one (ignored paths never appear in `git status`,
so even a plain pull reads clean), and neither the auto-stash
(`--include-untracked` skips ignored files) nor the force reset/clean
protects it. The incoming-addition set is computed relative to every merge base
(`merge-base --all`, unioned: a criss-cross history's real merge
computes from the virtual merge of its best common ancestors, so
diffing a single base can hide a path) from the repository toplevel
with `--no-renames -z` (rename destinations count as additions,
non-ASCII names are not C-quoted, and unpushed local deletions are not
counted as incoming additions); for a rebase, the additions the replayed
local commits introduce join the set (the replay checks them out over
the worktree the same way). The probe runs just-in-time — after the
stash/discard, next to the guard re-run — because neither step touches
ignored files and one a concurrent actor creates while they run must
still refuse the update; the force shape also probes before the discard
so the refusal precedes the destructive step when visible. The set is
compared byte-for-byte against the ignored files present in the
worktree (`ls-files --others --ignored --exclude-standard -z`), with no
pathspec parsing and no filesystem walk: a collision is an exact match
or a segment-boundary prefix in either direction, folded case-wise when
the repository says the filesystem folds case (`core.ignorecase`) — on
both the byte-mapped form and the decoded-UTF-8 form, since the
byte-mapped fold covers ASCII only.

Failures are classified from repository state (`MERGE_HEAD`, rebase
state, unmerged index entries, ahead/behind counts, dirtiness) into
typed codes instead of matching git's rendered error text, which varies
by version and locale and embeds arbitrary file names.

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
reopened. The 409 body carries a structured `unmerged: true` flag (from
the route's repository-state probe, not the error text) when the index
has unmerged entries; the stash option is then replaced by an
explanation — `git stash push` refuses unmerged entries — leaving discard
as the recovery path. In workspaces below the repository root discarding
is unsupported: the discard confirm is still offered but the daemon
refuses it with an error, so conflicts there must be resolved from
a terminal.

States no panel action can resolve — an in-progress merge or rebase,
a diverged branch whose update conflicts with the local commits, or
incoming changes colliding with local ignored files — return their own
409 codes (`merge_in_progress`, `rebase_in_progress`, `diverged`,
`ignored_collision`) and render terminal guidance instead of the
stash/discard buttons, surfacing the daemon's 409 message alongside the
fixed guidance text — it is the sole carrier of the unrestored-stash
pointer. The dirty-tree panel does the same in its message line. A
`head_changed` refusal (a concurrent checkout moved the branch mid-pull)
is retryable: it carries no fixed guidance and renders the daemon
message through the generic error line.

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
