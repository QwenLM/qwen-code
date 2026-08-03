# Web Shell Git diff sources

## Summary

Extend the Web Shell Changes view with five Git-backed sources:

- Uncommitted: current working tree compared with `HEAD`.
- Unstaged: current working tree compared with the index.
- Staged: index compared with `HEAD`.
- Committed: a selected commit compared with its first parent.
- Branch: current working tree compared with a selected branch tip.

The existing uncommitted behavior remains the default. Turn-based comparison is
out of scope.

## Design

The Core diff utility accepts a discriminated mode and an optional ref. It keeps
the existing file-count and hunk caps, rename handling, binary handling, and
untracked-file synthesis. Untracked files are included only for comparisons
whose target is the working tree (`uncommitted`, `unstaged`, and `branch`).

Commit and branch refs are resolved to commit object IDs before they are used by
later Git commands. A missing or invalid ref makes the diff unavailable. Commit
mode uses the selected commit's first parent; a root commit is compared with an
empty tree. Merge commits therefore show what the merge introduced relative to
its first parent, matching the existing History summary.

The daemon reads `mode` and `ref` query parameters on the existing workspace
diff routes. The qualified routes remain selected-workspace scoped: they resolve
the trusted runtime and optional contained worktree path before calling Core.
The legacy route remains bound-workspace scoped. Omitting both parameters keeps
the v1 request behavior.

The TypeScript SDK exposes the new arguments as an optional final options
parameter so existing callers remain source compatible.

The Web Shell Changes view owns the selected source. Commit and branch metadata
come from the existing log and branch endpoints. Selecting a source reloads the
file list, and expanding a file sends the same source to the per-file hunk
endpoint. Commit and branch selectors filter their loaded choices by commit SHA,
subject, or branch name. The branch selector presents the current branch (or
detached HEAD) before the selected baseline and excludes the current local
branch from baseline choices. Branch selection never checks out or mutates the
repository. When a large comparison omits all per-file details, the view shows
the hidden-file count instead of reporting that there are no changes.

## Error handling

- A mode outside the supported enum, or a commit/branch mode without `ref`, is
  rejected as a parse error by the daemon.
- An unresolved ref returns `available: false` without falling back to `HEAD`.
- Non-repositories and transient Git states retain their current unavailable
  behavior.
- Older daemons continue to support the default uncommitted request; new source
  selection requires the updated daemon.

## Testing

- Core integration-style unit tests cover all five comparisons, root and merge
  commits, invalid refs, staged/unstaged overlap, untracked files, and per-file
  hunks.
- Daemon route tests cover query parsing, forwarding, and selected-runtime cwd
  containment.
- SDK tests cover bound and workspace-qualified URL encoding.
- Web Shell tests cover source selection, metadata loading, request propagation,
  and selection reset when the workspace changes.
