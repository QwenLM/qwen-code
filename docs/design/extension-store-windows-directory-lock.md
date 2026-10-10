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

| Handle holder                                   | rename of ancestor        |
| ----------------------------------------------- | ------------------------- |
| none                                            | OK                        |
| `fs.watch` on the directory itself              | OK                        |
| `fs.watchFile` (stat polling)                   | OK                        |
| chokidar recursive, repo configuration          | **EPERM**, all 4 attempts |
| chokidar recursive, watcher closed first        | OK                        |
| chokidar `depth: 1` / `depth: 0`                | OK                        |
| open file handle, delete sharing (Node default) | OK                        |
| open file handle, delete sharing withheld       | **EPERM**                 |
| child process with cwd in a subdirectory        | **EPERM**                 |
| child process with cwd on the directory         | **EBUSY**                 |
| `rm -rf` while a descendant handle is open      | OK                        |
| `cp -r` over a tree with a descendant handle    | OK                        |

Confirmed against the live machine: a throwaway directory created under the real
`~/.qwen/extensions` could not be renamed while other Qwen Code sessions were
running, and the probe was removed afterwards. The last two rows are what make
the fix possible: these handles block directory rename, not directory removal,
deletion or copying, so a swap can avoid the lock without any cross-process
protocol.

Handle rows are split by sharing, which a single row conflated: a holder that
grants delete - what `libuv` opens with, so every Qwen Code child counts - blocks
neither a rename nor a copy, while a holder that withholds it, such as a scanner or
an editor holding one file exclusively, refuses the rename with `EPERM` and makes a
copy over that file fail with `EBUSY`. That last value is the one a lock classifier
sees on the copy path, and it is why the copy retries.

## Scope

In scope:

- `qwen extensions update <name>` and `uninstall <name>` succeed on Windows while
  other Qwen Code sessions are running, and an update started from the
  `/extensions` UI of a live session succeeds even though that session is itself
  one of the holders.
- When the swap is still impossible, say so in terms the user can act on, and
  leave the previous version installed.
- Keep the journal recovery story explicit. The copy fallback is Windows-only; the
  journal markers and the rules that follow from them - a settled transaction does
  not block the next mutation, a rollback that cannot be retried to a loadable
  artifact stops the caller, a blocked rollback is retried on a deferred window
  rather than on every operation - apply on every platform.

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

`ExtensionTransactionJournal` gains that optional field plus three more:
`rollbackBlocked` (a rollback could not complete, with `rollbackRetryAt` saying
when recovery may retry the owed step) and `cleanupPending` (only the
transaction's teardown is owed). `rollbackBlocked` marks a
transaction that is not settled and therefore still refuses that destination;
`cleanupPending` marks one that is settled and refuses nothing. Absent fields mean
`rename`, false and no window, so journals written by older builds recover unchanged
and `version` stays `1`. The strategy is
persisted before the first irreversible write. The rename path itself is
unchanged: rename destination to backup, rename staging to destination. The copy
path is:

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
force: true })` with `preserveTimestamps` and `verbatimSymlinks` on and
   `dereference` left false. The copy retries the store's lock-classified error, a
   different pair from the `EPERM`/`EACCES` set `renameWithRetry` retries: it adds
   `EBUSY`, because a child process whose working directory is the destination
   reports that code, and drops `EACCES`: every held-directory denial measured in
   section B arrived as `EPERM` or `EBUSY`, and keeping `EACCES` out means an
   ordinary permission problem stays a plain error rather than a retried lock.
   The residual is honest: if a Windows lock ever surfaced as `EACCES`, these
   steps would get no retry and no copy fallback, unlike the `renameWithRetry`
   calls in the same transaction, which do retry that code. It retries because a
   scanner or an indexer can hold one file
   transiently, which is the case the rename-only code used to absorb around that
   call. The retries come out
   of one allowance per store operation (`LOCK_RETRY_BUDGET_MS`, one second of
   sleeps) instead of one allowance per call: a step that is re-run is re-run
   whole, so a retried copy is four full tree passes at worst, but an
   entry-count-sized tree cannot multiply how long the store lock is held.
   `verbatimSymlinks` is what keeps a relative target relative: without it `fsp.cp`
   rewrites the target to an absolute path under the staging directory, which the
   commit then removes.
3. **Prune.** Walk the destination against the staging tree and remove every path
   staging does not carry, recursing into directories present on both sides.
   Running the walk after the apply is what keeps freshly copied content from
   being mistaken for stale content, and it also keeps the window in which a crash
   could leave the extension missing content as narrow as a copy-based swap
   allows.
4. For `uninstall`, replace steps 2-3 with: wipe the destination's children, then
   remove the destination itself. A destination that is not a real directory is
   refused before the wipe by the root guard below, and the wipe keeps the leaf
   rule anyway, so a destination that becomes a link between the guard and the
   wipe is unlinked rather than emptied through. If the wipe fails, the directory
   is held open as a working directory;
   restore from the backup copy and raise the locked error. A manifest-less husk
   must not survive, because `pathExists()` would report it as installed and block
   a later reinstall.

The copy strategy refuses a destination whose real path leaves the extensions
root, because every walk below reaches that root and `readdir` follows a link
there. It also refuses a destination that is not a real directory, before it
copies anything. The walks enumerate a root only when it is a real directory and
stop at it otherwise, so they never read or write through a link; unlinking a
linked root is not their job. `emptyDirectory` unlinks one in place, and
`rollbackJournal()` calls `removeNonDirectoryRoot()` on the destination before its
copy-mode walks - a caller-side check recovery does need, because `fsp.cp` would
otherwise be aimed at the link and fail with `ERR_FS_CP_DIR_TO_NON_DIR`.

`rollbackJournal()` gains the matching direction: with `swapStrategy: 'copy'` it
restores by copying `backupDirectory` over the destination and pruning what the
backup does not carry, rather than emptying the destination first. Restoring over
the live tree is what keeps a manifest-less husk out of reach when an entry cannot
be deleted: the swap fails, but the tree it failed over is the installed one.
Recovery keeps its existing phase comparison - `recoverTransactionsUnlocked()` and
the commit-side guard `assertNoPendingTransaction()` share one predicate for "this
transaction still needs a rollback" - and calls the strategy-aware rollback. What
the catch does with a lock error depends on which step it defeated, because the two
leave different states:

- **A rollback** is absorbed - marked `rollbackBlocked` and kept, so the operation
  proceeds and a later recovery retries it - only when retrying can still produce
  a loadable artifact: the destination already carries the backup's top-level
  entries, so the owed restore is effectively complete - extra paths it
  carries are the disclosed residue a later prune clears. Existence is
  not integrity, and neither is one surviving filename: a manifest standing in a
  half-wiped tree is not an artifact, while a plugin.json root or a link
  install's metadata-only root is one even though neither carries the manifest
  `qwen-extension.json` names. The states that fail the comparison - a
  destination emptied by a wipe that could not be restored, a crashed install
  with no backup at all - stop the caller. Absorbing also requires the marker
  itself to have landed: a journal that cannot record its own window must never
  be read as settled by a later pass, so an unrecordable refusal stays loud. The
  marker is written before that refusal, so even it gets a window and the reads
  that wait on it reject without touching the tree. On Windows that refusal is
  the locked-directory error with the raw errno as its cause; off Windows the
  errno is kept, because a permission denial there is not a held handle.
- **A cleanup** that fails after a rollback already restored the destination is
  marked `cleanupPending` instead: the retry repeats the removal, not the
  restore, so a settled rollback is never copied over the live tree again. That
  step owns the staging tree, the backup a copy-mode rollback restored from and
  the journal file itself; it demotes the backup to the unpublished `.partial`
  name before deleting it, so a removal that dies half-way can never be
  restored from by mistake. A lock error here is not reported to the caller: the
  journal stays, and the mark gives the owed step the same retry window the
  rollback uses, so a held removal does not tax every later read; a non-lock
  error is rethrown after the marker, as below.

`rollbackBlocked` keeps the journal out of the generation comparison, so a
transaction that still owes a rollback can never be read as a commit. Because
the holder may be a session that outlives this one, the mark also carries a
retry deadline (`ROLLBACK_RETRY_DELAY_MS`, shared with a cleanup that a lock
held): a read inside it skips the owed step instead of repeating it - or, for a
journal whose retry still cannot produce a loadable artifact, refuses without
touching the tree, with the held-handle text on Windows and an
unresolved-transaction error elsewhere. A deadline further out than the delay
is a clock that moved, not a live window, so it reads as due and the retry
resumes on its own - the destination heals instead of being wedged. A mutation
of the very destination a window waits on does not wait while a retry could
still leave a loadable artifact: the guard gives it one owed-step retry
immediately, and refuses with the diagnosis that attempt just produced if it
failed again; where no retry could, the mutation is refused from the window
check like any read, until the deadline passes. A failure that is not a lock
error stops the caller from either step - rethrown unmarked from the rollback,
rethrown after the marker from the cleanup - and so does a marker that cannot
be written, because an unmarked journal must never be absorbed and a retry
never repeats a restore from a half-deleted backup.

**B - actionable failure text.** Alongside the existing store errors:

```ts
export class ExtensionDirectoryLockedError extends Error {
  readonly code = 'extension_directory_locked';
}
```

The message names the extension directory - never an internal `rollback/` path,
which the user has nothing to inspect - and states that a process still has it
open, this session included. It is raised wherever a descendant handle can defeat
the swap: the staged rename, the `.partial` pre-clean and the backup publish
rename, the backup copy, the apply copy and the prune walk, and the wipe and
removal of a copy-mode uninstall. A rollback that itself fails still goes through
the existing `AggregateError` path; once recovery has stopped retrying one, the
refusal its guard raises for that destination is this error. Lock classification
lives here
rather than in `renameWithRetry`, and covers
`EPERM` and `EBUSY` - the latter because a child process whose working directory
is the directory being renamed reports that code rather than `EPERM`, and neither
error is otherwise retried or explained. On Windows a permission denial arrives as
`EPERM` too (libuv maps `ERROR_ACCESS_DENIED` and `ERROR_PRIVILEGE_NOT_HELD` to it),
so only a `symlink` failure is separable - and it is not a lock.

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
- **A commit refuses to stack on an unresolved transaction.** Before writing its
  journal, a commit checks `transactions/` for a journal that resolves to the same
  destination and that the shared predicate does not settle. A genuinely unresolved
  one is refused; one the holder blocked is refused with the locked-directory
  message, so a retry carries the same diagnosis as the attempt that caused it. A
  committed transaction awaiting cleanup is settled, and never refuses.

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
  a transaction whose teardown deletes it (both teardown paths do) - which is why
  no process-wide sweep is needed. A journal that is quarantined rather than
  replayed is the one case that leaves it behind for good; a rollback or a cleanup
  that a lock error or a fault defeats also leaves the backup and any unpublished
  `.partial`
  on disk, but keeps the journal that owns them, so a later operation removes
  them. While the holder holds, that is one full tree copy per affected
  destination in `rollback/`, uncapped. The rollback and the post-rollback
  cleanup log that at debug level; a cleanup the committed state no longer
  reports is silent by design, since the journal's windowed retries own it.
- **Concurrent out-of-band edits** to the destination during the copy window can be
  pruned or overwritten. The rename path has the same class of race with different
  timing; nothing here makes it safe.
- **Extra I/O** on the locked path: two full tree copies per update. Extension
  trees that ship `node_modules` make this noticeable - the largest installed here
  is 55.6 MB over 298 files - though bounded and Windows-only. A retried copy is a
  whole tree pass, so a step that is retried four times writes the tree four times;
  the allowance below bounds the sleeps, not the passes.
- **Retries are bounded per store operation, not per call.** One allowance covers
  a transaction, and one covers a recovery pass, so a tree whose entries are each
  transiently held is retried for the first second of the operation and then fails
  with the locked-directory error, instead of holding the store lock for one
  backoff per entry - which the ~27 s a waiting session allows would not survive.
- **EBUSY from a running child process is not solved by copying** when the
  process's working directory is the extension directory itself and the operation
  is an uninstall. That case ends in B's message, which is the intended outcome.
- `assertRecoveredJournalPaths()` validates journal paths only; the schema check
  for the six optional fields (`swapStrategy`, `rollbackBlocked`,
  `cleanupPending`, `rollbackRetryAt`, `rollbackHeld`, `orderMs`) lives in
  `readJournalUnlocked`, which must
  accept them without loosening any path check. An unrecognised strategy is
  quarantined.
- Copy and prune must not follow symlinks out of the destination tree - the staging
  content is already validated by `archive-safety`, but the prune walk has to treat
  a symlink as a leaf. The same rule covers a root: the walks stop at a root that is
  not a real directory instead of enumerating through it, `emptyDirectory` unlinks a
  linked one rather than emptying what it points at, and the restore path replaces
  one before copying - which is what keeps a relocated extension (a junction) from
  being deleted or overwritten through its link.
- **A type change is reconciled before the copy.** `fsp.cp` with `force` cannot
  replace a file with a directory or the reverse, so those entries are removed
  ahead of the copy - the only deletion allowed before it, since a blanket
  prune-before-copy would widen the crash window.
- **A failed swap leaves extra content; a hole needs a second failure.** Restoring
  over the live tree means an entry that cannot be deleted leaves stale files in
  place instead of emptying the destination, and the next successful swap prunes
  them. `removeKindConflicts` can still delete an entry whose replacement copy then
  fails, so a copy-mode rollback the same holder defeats can leave that entry
  missing while the journal is marked and retried. Nothing reconciles the tree on
  disk with the generation the snapshot committed, so a read in that window serves
  what the directory holds - possibly new bytes where a same-named file was
  overwritten halfway, possibly no file at all for a moment, because the copy
  unlinks each destination before writing its replacement - not the committed
  old version. A destination that lacks an entry its backup carries, or
  carries one under a different kind, or has no backup to match,
  is refused rather than served - marked first,
  so the refusal itself keeps a window;
  exposing an unresolved transaction on the read path is left to a follow-up.

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
each being refused with the relocated tree left intact; a relative symlink target
surviving a copy swap; a lock-defeated rollback keeping its journal and its backup
once the generation moves; a destination's stacked transactions replayed newest
first by the generation key that marking cannot move, the commit guard replaying
in that same order; a second transaction for one destination refused, and refused with the
locked-directory message naming the directory the user can act on when the holder
is what blocked the first one; a journal whose marker could not be written
refusing every later operation with its raw errno, backup and tree left intact;
a committed journal awaiting
cleanup not refusing the next commit; a rollback whose retry could not produce a
loadable artifact - a crashed install with no backup, or a destination wiped to
nothing - stopping the caller, marked first so even the refusal keeps its window
and no later read re-attempts the doomed restore, with the extension not
reported as installed, each platform with its own honest error class; the retry
gate comparing the destination's top level against the backup's, so an
unconverted plugin.json root, a link install's metadata-only root, and a
restore the prune could not finish taking away are absorbed with a window
while a half-wiped uninstall whose manifest survived and an entry whose kind
the restore did not finish are refused; a settled rollback whose
backup removal was held retried only once its window expired, re-marking while
the holder keeps it, and leaving no journal and no re-copied backup once
released; a cleanup that failed for another reason marked before it reached the
caller; a held journal file retried
rather than reported as a failed rollback; a copy, a destination removal and a
staged rename the holder released or refused being retried, or ending in the
actionable text; the `.partial` pre-clean and the backup publish naming the
extension directory rather than an internal path; a blocked rollback deferred by a
retry window that then resumes on its own, heals completely once the holder
releases, reads a deadline further out than the delay as a moved clock, and lets
a mutation whose owed retry could still leave a loadable artifact force that
retry instead of waiting, leaving another extension's commit untouched;
and a backup removal the holder released
absorbed inside the teardown; the shared allowance bounding the
retries one swap spends on held entries, and one recovery pass spending a single
allowance across stacked journals; a nested junction unlinked by the prune with
the tree behind it intact; a junctioned destination replaced by the restore rather
than written through; recovery reading its journals through a linked transactions
root; a copy-mode uninstall restoring the installed tree when its wipe is blocked,
including a child the wipe had already deleted; a non-lock rollback
failure still reaching the caller, with the owed step recorded under a window and
the journal kept, so the doomed restore does not re-enter on every later
operation; an entry whose type changes
between versions being reconciled so the copy runs; an interrupted backup's `.partial` tree being removed by
recovery; the staging tree being gone after a copy swap; quarantining a journal whose strategy is unrecognised; and the pre-existing
journals without the new fields keeping their current behaviour. What is not
reproducible off Windows is a real OS-level lock - a child process holding the
directory as its working directory - which the harness and the `EBUSY` row above
cover; the branch it ends in is covered here by an injected `EBUSY` on the
destination root with the platform overridden.

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
  directory, and the previous version is still installed and loadable. Three
  states can differ: a copy-mode rollback the same holder defeats may leave stale content,
  or an entry it deleted and could not copy back, until a later operation settles
  the tree; a rollback whose retry could not produce a loadable artifact stops
  the caller with the destination unusable, so the extension is not reported as
  installed and later store reads keep failing until the holder releases; and a
  rollback that failed for a fault the store cannot classify keeps its journal and
  backup, is retried after one window instead of on every operation, and refuses
  with the unresolved-transaction text rather than a held-directory one (see
  Risks).
- `npm run build && npm run typecheck` and the `packages/core` unit tests for the
  touched files pass, on both Windows and the Linux lane.
- POSIX code paths keep the rename swap. What applies on every platform is: the
  journal markers and their rules (a settled transaction does not block the next
  mutation, a genuinely unresolved one is refused, a rollback whose retry cannot
  produce a loadable artifact stops the caller, and a blocked rollback is retried on
  a deferred window); newest-first replay on the generation key, tie-broken by an
  order key stamped once and never recomputed, shared with the commit guard;
  older journals of a destination whose newer was deferred or faulted this pass
  are not allowed to apply, and a non-lock restore failure records the owed step
  under the same window and leaves the journal in the scan, so the doomed restore
  is not re-attempted on every later operation and its residue keeps its owner;
  lock-classified retries on the
  removals a rollback and a journal teardown perform, with one allowance per store
  operation; the `.partial` sibling those teardowns remove; and the refusal, with
  the locked-directory text, that a blocked rollback leaves on Windows.

## Open Questions

- Should the copy path also be attempted for `install` when staging to destination
  rename fails? Today that rename is into a fresh path and has not been observed to
  fail; leaving it out keeps the fallback narrow.
