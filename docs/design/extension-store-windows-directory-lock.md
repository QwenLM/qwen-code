# Extension Store Windows Directory Lock Design

[English](extension-store-windows-directory-lock.md) | [简体中文](extension-store-windows-directory-lock.zh-CN.md)

Status: implemented. Date: 2026-09-14.

## Background

Updating or uninstalling a user-scope extension fails on Windows with a raw
filesystem error and no explanation:

```text
EPERM: operation not permitted, rename
'C:\Users\<user>\.qwen\extensions\i-have-adhd' ->
'C:\Users\<user>\.qwen\extension-store\rollback\b101694b-c6a6-4a54-9cf1-4f3e8dd7f7c0'
```

The text reaches the terminal unchanged because the update command reports the
mutation failure with `writeStderrLine(getErrorMessage(error))`. The transaction
rolls back cleanly, so the extension stays on its old version and nothing is
corrupted - but the operation can never succeed, and the message gives the user
no way to act on it. Installing a brand new extension is unaffected.

## Root Cause

`ExtensionStore.commitArtifact()` swaps an installed extension out of the way by
renaming the whole directory into the rollback area:

```ts
await renameWithRetry(destinationDirectory, backupDirectory, 3, 50);
```

On Windows, `MoveFileEx` of a directory fails when any **descendant** of that
directory has an open handle. Qwen Code creates exactly that handle itself:
`ExtensionFileWatcher` watches `~/.qwen/extensions` with chokidar at unlimited
depth, and chokidar attaches one native `ReadDirectoryChangesW` handle **per
subdirectory** it discovers. Every interactive session therefore locks every
directory of every installed extension.

The retry cannot help. `renameWithRetry` makes 4 attempts inside ~350 ms for
EPERM/EACCES, and the lock is not transient: it is held for the whole lifetime of
another running session.

Three properties of the surrounding code shape the fix.
`ExtensionFileWatcher.subscribeExtensionManagerMutations()` reacts to a mutation
with `ExtensionRefreshState.beginSuppression()`, which only hides the resulting
refresh notifications and never releases the chokidar handles - so a mutation
started inside a live session locks its own destination. `renameWithRetry` is
shared with `atomicWriteFile`, the native LSP service and the background shell
registry, so its retryable codes are not the place to add a store-specific
classification. `EBUSY` is outside the retry set too; it is what a child process
reports when its working directory _is_ the directory being renamed, which takes a
manifest pointing `cwd` inside the extension - hooks use `process.cwd()` and stdio
servers take `cwd` from their manifest entry - so it joins the classification as
the same failure shape, not as a common one. Upstream issue #10187 fixed the
analogous managed-Skill bug with this same backup-rename pattern, which removed
data loss but never addressed Windows locks.

Who holds the handles depends on the entry point: the CLI subcommand exits during
argument parsing and never starts a watcher, so there the locks belong to _other_
sessions. That is why the fix has to be holder-agnostic, and why "close your other
Qwen Code sessions" is not a reliable workaround - the UI path is blocked by the
acting session itself.

### Measured evidence

Probes on Windows (Node 24, chokidar 4 - the version this repo depends on),
renaming an extension directory that contains a nested subdirectory:

| Handle holder                                | rename of ancestor        |
| -------------------------------------------- | ------------------------- |
| none                                         | OK                        |
| `fs.watch` on the directory itself           | OK                        |
| `fs.watchFile` (stat polling)                | OK                        |
| chokidar recursive, repo configuration       | **EPERM**, all 4 attempts |
| chokidar recursive, watcher closed first     | OK                        |
| chokidar `depth: 1` / `depth: 0`             | OK                        |
| open file handle on a file inside the tree   | **EPERM**                 |
| child process with cwd in a subdirectory     | **EPERM**                 |
| child process with cwd on the directory      | **EBUSY**                 |
| `rm -rf` while a descendant handle is open   | OK                        |
| `cp -r` over a tree with a descendant handle | OK                        |

Confirmed against the live machine: a throwaway directory created under the real
`~/.qwen/extensions` could not be renamed while other Qwen Code sessions were
running, and the probe was removed afterwards. The last two rows are what make
the fix possible: these handles block directory rename and directory removal, not
deletion or copying, so a swap can avoid the lock without any cross-process
protocol.

## Scope

In scope:

- `qwen extensions update <name>` and `uninstall <name>` succeed on Windows while
  other Qwen Code sessions are running, and an update started from the
  `/extensions` UI of a live session succeeds even though that session is itself
  one of the holders.
- When the swap is still impossible, say so in terms the user can act on, and
  leave the previous version installed.
- Keep the journal recovery story explicit for the new swap strategy, and leave
  POSIX behaviour unchanged.

Out of scope:

- No cross-process coordination protocol between sessions, and no change to how
  the watcher attaches to the extension tree.
- No change to `renameWithRetry` semantics for its other callers.
- No attempt to make the copy-based swap atomic. It cannot be; the design contains
  that instead.

## Proposed Solution

Two parts. The first makes the swap tolerate a directory another process is
holding open; the second makes whatever still cannot be swapped legible.

**A - lock-tolerant swap.** When the backup rename fails with a lock error on
Windows, the whole transaction switches to a copy-based swap. The strategy is
decided once, recorded in the journal, and used consistently by the apply,
rollback and recovery paths:

```ts
swapStrategy?: 'rename' | 'copy';
```

`ExtensionTransactionJournal` gains that optional field. An absent field means
`rename`, so journals written by older builds recover unchanged and `version`
stays `1`. The strategy is persisted before the first irreversible write. The
rename path itself is unchanged: rename destination to backup, rename staging to
destination. The copy path is:

1. **Backup by copy.** Copy `destinationDirectory` into `backupDirectory`. Proven
   to work under a descendant handle. The copy lands first at
   `${backupDirectory}.partial` and is published with one rename, because a
   half-copied backup is worse than none: recovery would restore it over a
   destination that is still intact. A crash inside the copy leaves the `.partial`
   tree unpublished; both journal teardown paths remove it, so recovering that
   transaction sweeps it.
2. **Reconcile types, then apply by copy.** Remove only the destination entries
   whose type differs from the staged entry at the same relative path - `fsp.cp`
   refuses to replace those, and refuses before a prune could reach them - then
   `fsp.cp(stagingDirectory, destinationDirectory, { recursive: true,
force: true })`, preserving symlinks and timestamps (`dereference` stays false,
   `preserveTimestamps` on). Relative symlink targets remain valid because the
   tree shape is identical.
3. **Prune.** Walk the destination against the staging tree and remove every path
   staging does not carry, recursing into directories present on both sides.
   Running the walk after the apply is what keeps freshly copied content from
   being mistaken for stale content, and it also keeps the window in which a crash
   could leave the extension missing content as narrow as a copy-based swap
   allows.
4. For `uninstall`, replace steps 2-3 with: wipe the destination's children, then
   remove the destination itself; a linked destination is unlinked rather than
   emptied. If the wipe fails, the directory is held open as a working directory;
   restore from the backup copy and raise the locked error. A manifest-less husk
   must not survive, because `pathExists()` would report it as installed and block
   a later reinstall.

The copy strategy refuses a destination whose real path leaves the extensions
root, because every walk below reaches that root and `readdir` follows a link
there. It also refuses a destination that is not a real directory, before it
copies anything. The walks themselves enumerate a root only when it is a real directory, and
unlink it instead, so journal recovery reaches the same conclusion without a
caller-side check.

`rollbackJournal()` gains the matching direction: with `swapStrategy: 'copy'` it
restores by copying `backupDirectory` over the destination and pruning what the
backup does not carry, rather than emptying the destination first, and then
deletes the backup, which a copy leaves in place where a rename would have
consumed it. Restoring over the live tree is what keeps a manifest-less husk out
of reach when an entry cannot be deleted: the swap fails, but the tree it failed
over is the installed one. Recovery needs no new concept -
`recoverTransactionsUnlocked()` keeps its existing phase comparison and simply
calls the strategy-aware rollback.

**B - actionable failure text.** Alongside the existing store errors:

```ts
export class ExtensionDirectoryLockedError extends Error {
  readonly code = 'extension_directory_locked';
}
```

The message names the directory and states that a process still has it open, this
session included. It is raised wherever a descendant handle can
defeat the swap - the backup copy and its publish rename, the apply copy, the
prune walk, and the wipe and removal of a copy-mode uninstall - so a holder
blocking any of those steps produces the actionable message instead of a raw
errno, rather than only the last one doing so. A rollback that itself fails still
goes through the existing `AggregateError` path. Lock classification lives here
rather than in `renameWithRetry`, and covers
`EPERM` and `EBUSY` - the latter because a child process whose working directory
is the directory being renamed reports that code rather than `EPERM`, and neither
error is otherwise retried or explained. `EACCES` is deliberately excluded: a
permission denial is not a held handle, and treating it as one would divert a
permission problem into a copy that fails later with a different error.

## Decisions and Rejected Alternatives

Decisions:

- **Windows only.** The fallback is gated on `process.platform === 'win32'` and on
  a lock-classified error. Measured on the Linux lane with the same held handles,
  the rename is not blocked there, so nothing changes on POSIX and no CI platform
  silently loses atomicity.
- **Copy the backup rather than skip it.** Skipping would be cheaper but would
  turn every uncommitted copy-mode journal into an unrecoverable half-state.
  Copying keeps the existing rollback and recovery design intact and costs one
  extra tree copy on a path that is already the slow path.
- **Staging stays on disk until the commit is clean.** This is already true, and it
  is what lets a copy-mode transaction that died mid-apply be rolled back by a
  later run.

Rejected:

- **Release the acting session's own handles around a mutation.** A `pause()` on
  the watcher helps only when that session is the sole holder, which a second open
  session defeats, and `beginMutation()` has 18 call sites, most of which never
  touch an artifact. Copy reaches everywhere rename does, so it buys no
  reachability.
- **A polling watcher on Windows.** `usePolling` holds no handles anywhere, at the
  cost of continuous `stat` traffic over the extension tree, and it is still blind
  to an editor, Explorer, an antivirus scanner, or a running MCP server.
- **A "mutation in progress" marker with a heartbeat.** Coordinates Qwen's own
  sessions only, and needs timeout, crash-leftover and startup-race handling for
  what the copy path already provides unconditionally.
- **A longer retry budget.** The lock is held for the lifetime of another session;
  4 attempts in 350 ms is already more than a transient lock needs and less than a
  permanent one allows.

## Risks and Constraints

- **Copy mode is not atomic.** A crash between the apply and the prune can leave
  the destination mixing old and new files while the journal is still `prepared`.
  Recovery rolls the backup copy back, exactly as the rename path does for an
  uncommitted transaction - including once `artifact_swapped` is recorded, since
  the snapshot is what makes a transaction committed. The window is small and the
  state is always resolvable, but it is wider than the rename path's.
- **An interrupted backup leaves its `.partial` tree until the journal is torn
  down.** The journal is written before the copy starts, so a `.partial` belongs to
  a transaction whose teardown deletes it (both teardown paths do) - which is why no
  process-wide sweep is needed, and a journal that is quarantined rather than
  replayed is the one case that would leave it behind. A copy-mode rollback
  likewise deletes the backup it restored from, so a failed swap does not grow the
  rollback area.
- **Concurrent out-of-band edits** to the destination during the copy window can be
  pruned or overwritten. The rename path has the same class of race with different
  timing; nothing here makes it safe.
- **Extra I/O** on the locked path: two full tree copies per update. Extension
  trees that ship `node_modules` make this noticeable - the largest installed here
  is 55.6 MB over 298 files - though bounded and Windows-only.
- **EBUSY from a running child process is not solved by copying** when the
  process's working directory is the extension directory itself and the operation
  is an uninstall. That case ends in B's message, which is the intended outcome.
- `assertRecoveredJournalPaths()` validates journal paths and must accept the new
  optional field without loosening any path check; an unrecognised strategy is
  quarantined.
- Copy and prune must not follow symlinks out of the destination tree - the staging
  content is already validated by `archive-safety`, but the prune walk has to treat
  a symlink as a leaf. The same rule covers the root: the walks enumerate only a
  real directory and unlink a linked one instead of emptying it, which is what keeps
  a relocated extension (a junction) from being deleted through its link.
- **A type change is reconciled before the copy.** `fsp.cp` with `force` cannot
  replace a file with a directory or the reverse, so those entries are removed
  ahead of the copy - the only deletion allowed before it, since a blanket
  prune-before-copy would widen the crash window.
- **A failed swap leaves extra content, not a hole.** Restoring over the live tree
  means an entry that cannot be deleted leaves stale files in place instead of
  emptying the destination; the next successful swap prunes them.

## Verification and Acceptance

Unit tests colocated in `extension-store.test.ts` run on a real filesystem under
`os.tmpdir()` with a module-level seam injected over `renameWithRetry`, and cover: the
copy fallback engaging on a Windows lock error with stale files pruned; no
fallback and an unchanged tree when the same error arrives off Windows; uninstall
in copy mode removing the directory; recovery of a copy-mode journal by copying
the backup back, including removing content the partial apply added; a blocked copy
step surfacing the locked-directory error with the tree restored and the rollback
area empty; the rollback restoring over the live tree rather than emptying it; a
destination that resolves outside the extensions root, and a linked root inside it,
each being refused with the relocated tree left intact; an entry whose type changes
between versions being reconciled so the copy runs; an interrupted backup's `.partial` tree being removed by
recovery; quarantining a journal whose strategy is unrecognised; and the pre-existing
journals without the field keeping their current behaviour. The one branch that is
not unit-testable off Windows is the final removal refusing because a process has
the directory as its working directory - it needs a real OS-level lock, which the
harness and the `EBUSY` row above cover.

The E2E harness holds a native watch handle per directory over an extensions root
and drives a separate CLI process through update and uninstall, first against an
isolated `HOME` and then against a real profile with live sessions as the holder.
Recorded results: the released CLI fails both operations with `EPERM` and the
fixture stays on its old version; this build completes both, prunes the dropped
file, and leaves no residue in `state.json`, `rollback/` or `transactions/`. The
Linux lane runs the same suite with the same handles and reports no lock at all.

Acceptance:

- On Windows, with at least one other interactive session running,
  `qwen extensions update <name>` completes and the new version loads.
- A swap that cannot complete reports `extension_directory_locked` naming the
  directory, and the previous version is still installed and loadable.
- `npm run build && npm run typecheck` and the `packages/core` unit tests for the
  touched files pass, on both Windows and the Linux lane.
- POSIX code paths are unchanged in the diff.

## Open Questions

- Should the copy path also be attempted for `install` when staging to destination
  rename fails? Today that rename is into a fresh path and has not been observed to
  fail; leaving it out keeps the fallback narrow.
