# File History: Atomic Backup Publication

[English](2026-11-11-file-history-atomic-backup.md) | [简体中文](2026-11-11-file-history-atomic-backup.zh-CN.md)

Status: Implemented and verified (pilot for issue #16896, porting the
crash-safe capture from `v1.0.0-preview` @ `587e3429cabf` into main's existing
file history). Reproduced via failure injection on the base commit, fixed,
and verified with the regression suite plus an interactive E2E pass on
2026-11-11.

## Problem

`createBackup` in `packages/core/src/services/fileHistoryService.ts` copies the
working file **directly onto the final backup path** (`copyFile` via
`safeCopyFile`), then `chmod`s the final path. Two failure modes publish
incomplete content at a path that later reads treat as a valid checkpoint:

1. **Interrupted capture.** A process crash or I/O error during `copyFile`
   leaves a truncated blob at the final backup path.
2. **Concurrent overwrite of a referenced backup.** Backup names are
   deterministic (`sha256(path)[0:16]@vN`), and `trackEdit` explicitly allows
   concurrent calls to write the same path ("the second overwrites the first
   harmlessly"). That is only harmless while both copies complete: if the
   process crashes during the second copy, the blob is truncated **even though
   a confirmed snapshot entry already references it**.

After a resume, `validateRestoredSnapshots` only `stat`s referenced backups —
a truncated blob passes validation. `checkOriginFileChanged` then sees a
size/content mismatch and `rewind` restores the truncated content as if it
were the captured checkpoint: a silent wrong-restore in a feature whose whole
purpose is reliable undo.

## Current state

Main's capture flow (`createBackup`):

1. `stat(filePath)`; ENOENT → record a `null` backup (the file did not exist).
2. `safeCopyFile(filePath, backupPath)` — direct `copyFile` onto the final
   path, with an ENOENT disambiguation: source gone → `'src-missing'`;
   destination directory missing → `mkdir` + retry.
3. `chmod(backupPath, srcStats.mode)`.
4. Return `{ backupFileName, version, backupTime }`. Failures throw;
   `trackEdit` swallows them (records nothing), `makeSnapshot` records a
   `failed: true` entry, and `rewind` surfaces those paths via `filesFailed`.

The preview branch (`packages/core/src/file-history/file-history.ts`) already
solves this: copy to `${backupPath}.tmp` with `COPYFILE_EXCL`, `chmod` the
temporary file, `rename` it into place, and remove the temporary file on
failure. Preview can use a fixed `.tmp` suffix because its backup names are
UUIDs; main's deterministic names need an adaptation (see below).

## Goals

- A crash or I/O error during capture never leaves incomplete content at the
  final backup path.
- Failures keep surfacing through the existing `failed` / `filesFailed`
  semantics — no new flags, no caller changes.
- Failure-injection regression tests for `copyFile` / `chmod` / `rename`.
- Evaluate the per-snapshot `cwd` item and close it with evidence.

## Non-goals (from issue #16896)

- Replacing `FileHistoryService` with preview's `FileHistoryManager`.
- UUID-based backup names (main's `hash@version` + max-version scanning
  already avoids collisions).
- Re-porting `captureFailed` / per-file rewind-failure reporting (main already
  has `failed` / `filesFailed`).
- Session-fork backup migration (hardlink copy).
- The retained-storage capture path
  (`packages/cli/src/serve/managed-csi-file-backend.ts` implements
  `RetainedFileHistoryStorage.createBackup` separately); it is not touched by
  this change.

## Proposed solution

Change only `createBackup` and `safeCopyFile` in
`packages/core/src/services/fileHistoryService.ts`:

1. `safeCopyFile` gains an optional `mode` parameter (default `0`, the
   `copyFile` default) so the exclusive flag applies to both the first attempt
   and the post-`mkdir` retry. `restoreBackup` keeps calling it without a
   mode — restore behavior is unchanged.
2. `createBackup` publishes atomically:
   - `temporaryPath = `${backupPath}.${randomUUID()}.tmp`` — a **unique**
     temporary name per call.
   - `safeCopyFile(filePath, temporaryPath, constants.COPYFILE_EXCL)` —
     exclusive copy; `'src-missing'` still returns a `null` backup, with a
     best-effort unlink of the temporary file (the copy may have created it
     before the source vanished).
   - `chmod(temporaryPath, srcStats.mode)` — permissions applied **before**
     publication.
   - `open(temporaryPath, 'r+')` + `handle.sync()` + `handle.close()` — flush
     the copied bytes before publication (issue #16896 triage note 1); a sync
     failure routes through the same cleanup path.
   - `renameWithRetry(temporaryPath, backupPath, 3, 50)` — atomic publication
     on the same directory/filesystem, reusing the shared helper from
     `utils/atomicFileWrite.ts` (see below).
   - On any failure: `unlink(temporaryPath)` (ENOENT ignored, other cleanup
     errors logged), then rethrow so the existing caller-side `failed`
     semantics apply.

The `stat`-ENOENT early return, the `'src-missing'` disambiguation, the
deterministic final name, and the throwing contract are all preserved.

## Design decisions and rationale

### Unique temporary suffix instead of preview's fixed `.tmp`

Main's final backup names are deterministic, and concurrent captures of the
same `(file, version)` are an acknowledged, supported scenario. With a shared
`${backupPath}.tmp`:

- the second concurrent `copyFile(..., COPYFILE_EXCL)` fails with `EEXIST`;
- worse, each call's failure cleanup would delete the other call's
  in-progress temporary file, turning a harmless race into mutual failure.

A per-call `randomUUID()` suffix keeps concurrent captures independent: each
publishes a complete copy, and `rename` makes the last one win — exactly
today's "second overwrites the first harmlessly" semantics, minus the
truncation window. `COPYFILE_EXCL` is kept as a cheap guard against
overwriting an existing temporary file.

### Failure contract unchanged

Preview's `createBackup` returns an `unavailableBackup` record; main's throws
and lets callers record failure (`trackEdit`: swallow + record nothing;
`makeSnapshot`: `failed: true` entry). The port keeps main's contract so no
caller, serialization format, or rewind/diff path changes.

### Publication rename reuses `renameWithRetry`

The repository's atomic-publication convention (`atomicWriteFile`,
`mods/store.ts`, `extension-store.ts`, the workflow journal) publishes via
`renameWithRetry` from `utils/atomicFileWrite.ts`: transient `EPERM`/`EACCES`
(common on Windows under concurrent access or antivirus scans) retry with
exponential backoff (3 retries, 50 ms base); every other error rethrows
immediately. A bare `rename` would turn an absorbable transient lock into a
lost capture (`makeSnapshot` records `failed: true`; `trackEdit` records
nothing). The port reuses the helper with the same `(3, 50)` parameters as
`mods/store.ts`, so the publication step matches the convention while the
non-retryable failure contract above is preserved. Whole-function reuse of
`atomicWriteFile` is not appropriate: it takes `string | Buffer` content and
has no `'src-missing'` sentinel, no destination-directory `mkdir` retry, and
no `COPYFILE_EXCL` source copy.

### Flush before publication (fsync)

`rename` is atomic in the metadata sense, but without flushing the copied
bytes a host crash (power loss, kernel panic) on filesystems that can commit
rename metadata ahead of data blocks (XFS, ext4 `data=writeback`, btrfs)
could still expose a zero-filled or short backup — the same silent
wrong-restore one crash layer down. Issue #16896's triage note 1 therefore
asks the port to match `atomicWriteFile`'s durability contract (`flush`
defaults to true there) rather than transcribe preview's no-fsync sequence.
The capture fsyncs the temporary file after `chmod` and before the
publication rename, inside the existing `try` so a sync failure still cleans
up and rethrows. The flush stays at this call site: `renameWithRetry` has no
flush parameter and is shared by every other atomic publisher. The directory
entry itself is not separately fsynced (matching `atomicWriteFile`; the
retained-storage CSI backend additionally syncs its directory handle) —
journaling filesystems commit the rename through the journal.

### Orphaned temporary files

A crash between copy and rename leaves `<name>.<uuid>.tmp` in the session
backup directory. Orphans are never referenced by any snapshot, are invisible
to `validateRestoredSnapshots` (which stats referenced names only), and are
removed by the existing sweeps: session deletion
(`sessionService.removeFileHistoryBackups` removes the whole session
directory) and housekeeping (`cleanupOldFileHistoryBackups` sweeps session
directories by mtime). No new sweeper is added.

### Per-snapshot `cwd`: evaluated, no change

The issue asks to record the producing `cwd` per snapshot **only if a real
wrong-restore defect is confirmed across enter/exit worktree**. Investigation
of main at the pilot's base commit shows no such path:

- `EnterWorktreeTool.execute` creates the worktree and instructs the model to
  route all file operations through its absolute path; it never changes
  `Config.cwd`. `ExitWorktreeTool` likewise never relocates. The TUI
  sidecar watcher (`useWorktreeSession`) is display-only.
- Because `FileHistoryService.cwd` is constant across enter/exit, tracking
  paths (relative under the unchanged cwd, e.g.
  `.qwen/worktrees/<slug>/file.txt`, or absolute for files outside cwd)
  expand back to the same absolute paths at restore time.
- The `--worktree` launch flag chdirs **before** Config construction, so that
  session's cwd is the worktree from the start — also consistent.
- ACP managed conversations refuse `enter_worktree` / `exit_worktree`
  outright; the standalone ACP path uses the same non-relocating tools.

Recording a per-snapshot `cwd` would therefore add no correctness to
enter/exit worktree. The item closes as "documented, no change".

Adjacent observation (out of pilot scope, candidate follow-up): `/cd`
(`cdCommand`) and ACP `session/cd` call `relocateWorkingDirectory`, which
resets `fileHistoryService` but leaves `sessionData` untouched; the lazy
`getFileHistoryService()` then rehydrates `sessionData.fileHistorySnapshots`
(the resume-time payload) against the **new** cwd. In a resumed session, a
rewind to a pre-`cd` checkpoint could restore relative tracking paths under
the new directory. This is a directory-relocation question, not a worktree
enter/exit question; it is tracked as #16982 (which asks for an end-to-end
reproduction before implementing per-snapshot cwd) and is not changed by
this pilot.

## Constraints

- The temporary file lives in the same directory as the final path, so
  `rename` is same-filesystem (no `EXDEV`) and atomic on POSIX. On Windows,
  Node's `rename` replaces an existing destination (`MoveFileExW` with
  `MOVEFILE_REPLACE_EXISTING`), preserving the concurrent last-wins behavior;
  transient `EPERM`/`EACCES` from concurrent access or antivirus scans are
  absorbed by `renameWithRetry`'s backoff (worst case 350 ms added latency).
- `resolveBackupPath`'s directory-escape guard is unchanged; temporary names
  are derived internally, never from user input.
- ESM, strict TypeScript, no `any`; comments only where the why is
  non-obvious (the unique-suffix concurrency invariant).

## Risks

- **Orphan accumulation after repeated crashes**: bounded by the existing
  session-deletion and housekeeping sweeps; each orphan is at most one
  backup's size.
- **Concurrent `rename` to the same final path**: last complete copy wins —
  identical to today's concurrent `copyFile` outcome, without the truncation
  window.
- **Cleanup failure** (e.g. permission flip on the backup directory): logged
  and swallowed; the original capture error still propagates, so failure
  reporting is unaffected. The orphan is swept later.
- **Per-capture fsync latency**: publication now flushes the temporary file
  (one `fsync` per captured backup), the price of the host-crash durability
  contract; captures happen once per edited file per turn, not per read.
- **Directory-entry durability**: the file data is fsynced, the rename's
  directory entry is not separately synced (matching `atomicWriteFile`);
  journaling filesystems commit it through the journal. A filesystem that
  neither journals nor ordering-guarantees the entry could still lose the
  name (not the content) on power loss — the backup then reads as missing and
  surfaces via the existing `failed` semantics, never as truncated content.

## Validation plan

1. **Failure-injection unit tests** (mirroring preview's `file-history.test.ts`,
   adapted to main's semantics): for each of `copyFile` (writes partial
   content, then throws), `chmod`, and `rename` (reject once):
   - `trackEdit` resolves and records nothing; the backup directory stays
     empty (no final blob, no temporary leftover); the working file is
     untouched.
   - `makeSnapshot` records a `failed: true` entry; `rewind` reports the file
     via `filesFailed`; still nothing is published.
2. **Old-checkpoint preservation**: a failed capture for version N+1 leaves
   the complete version N blob intact and rewindable.
3. **Concurrent-capture crash**: two simultaneous `trackEdit` calls race onto
   the same deterministic path; the second copy is interrupted mid-write.
   The confirmed entry's blob keeps the full content, and a
   serialize → resume → validate → rewind cycle restores the true checkpoint
   (the issue's silent wrong-restore scenario).
4. **Concurrent captures (success)**: two simultaneous `trackEdit` calls for
   the same file both succeed, publish exactly one complete backup, and leave
   no temporary files. A gated variant holds both copies inside a `copyFile`
   spy until both have started, then asserts the two destinations are
   distinct and neither is the final path — pinning the unique-suffix
   adaptation deterministically rather than by I/O timing.
5. **Permissions**: the published backup carries the source file's mode.
   POSIX-only (`it.runIf(process.platform !== 'win32')`): Windows synthesizes
   `st_mode` from file attributes, so permission assertions are meaningless
   there — guarded like the forked-session mode sibling in
   `sessionService.test.ts`.
6. **Source-vanished race**: `copyFile` fails with ENOENT after the source is
   deleted → a `null` backup is recorded, nothing published. Includes the
   mid-copy variant where the copy created a partial temporary file before
   the source vanished → the temporary file is cleaned up as well.
7. **Rename retry semantics**: a single transient `EPERM` rename is retried
   and the complete backup is published; a persistent `EPERM` exhausts the
   retries and surfaces as a failed capture with nothing published.
8. **Flush ordering**: spies on `open` / the returned handle's `sync` /
   `rename` record the call order over one successful capture; the temporary
   file (and only it) is synced before the publication rename.
9. **Existing suite**: `fileHistoryService.test.ts` and the retained-storage
   suite stay green (the `safeCopyFile` mode parameter defaults to today's
   behavior).
10. `npm run build && npm run bundle && npm run typecheck`, focused vitest
    runs, and an interactive E2E sanity pass (capture + rewind via tmux) per
    the test plan in `.qwen/e2e-tests/`. E2E is interactive-only: file
    checkpointing defaults to `!sdkMode && interactive`, so headless runs do
    not capture snapshots on either binary (existing gating).

## Validation results (2026-11-11)

- Reproduction: four failure-injection probes failed on the base commit,
  including the end-to-end silent wrong-restore (rewind reported
  `filesFailed: []` while writing truncated bytes).
- The permanent suite `file-history-atomic-backup.test.ts` (17 tests) passes
  with the fix. Mutation arms, re-run against the final suite: reverting
  `createBackup` to the direct copy fails 13/17 (the 4 survivors are the
  behavior-preservation tests — transient-EPERM retry, concurrent success,
  permissions, and the source-vanished-before-copy shape — which pass on both
  implementations by design); a retries=0 mutation reddens the transient-
  EPERM test; removing the source-vanished temporary cleanup reddens the
  mid-copy cleanup test; removing the fsync block reddens the flush-ordering
  test (`expected ['rename'] to deeply equal ['sync', 'rename']`); a shared
  `${backupPath}.tmp` suffix reddens the gated distinct-destination test on
  every run (3/3).
- Focused regression: 510 core tests across 8 file-history-related files and
  81 cli tests across 2 consumer files passed; build, bundle, and typecheck
  passed.
- Interactive E2E (tmux, `node dist/cli.js` vs global qwen 0.27.2 baseline):
  complete-only publication, `<16-hex>@vN` naming, byte-exact backups, mode
  preservation, `@v2` without disturbing `@v1`, zero `*.tmp` leftovers, and
  a clean `/rewind` restore.
- Code review (medium, verified): 0 Critical, 1 Suggestion — the publication
  rename should reuse the shared `renameWithRetry` helper instead of a bare
  `rename` (probe-confirmed: a one-shot `EPERM` loses the capture with a bare
  rename, succeeds with the helper). Accepted and applied with two new
  regression tests (transient `EPERM` retried; persistent `EPERM` exhausts
  into the failed contract).
- Post-PR multi-round audit (undirected + adversarial, real probes):
  corrected the direct-copy mutation count to the re-measured value; closed
  the source-vanished mid-copy orphan edge with a best-effort cleanup and a
  pinning test; probed a directory-occupied final path (EISDIR → honest
  failed entry, nothing published), a read-only backup directory (EACCES
  propagates, nothing published), and a directory source (nothing published).
  The two red CI jobs were classified as infrastructure: shard 2/2 ran 29/29
  test files green and failed only in the post-test temporary-HOME `rm`
  cleanup step; the No-Sandbox job is the aggregate gate propagating that
  result.
- PR review round 2 (3 threads, all accepted and fixed): the permission test
  is now POSIX-guarded like its `sessionService.test.ts` sibling (Windows
  synthesizes `st_mode`, so the assertion could never pass there); the
  publication fsyncs the temporary file per issue #16896 triage note 1, with
  a flush-ordering test; and a gated concurrent-capture test pins the unique
  temporary suffix deterministically (the prior bare-`Promise.all` test
  caught a shared-suffix mutation 3/3 on this machine, but only by I/O
  timing). Each fix carries its own mutation arm above.

## Acceptance criteria

- No code path publishes incomplete content at a final backup path.
- `copyFile` / `chmod` / `rename` failures surface through the existing
  `failed` / `filesFailed` semantics, with temporary files cleaned up.
- Concurrent captures of the same deterministic path remain harmless.
- The `cwd` evaluation item is closed with the evidence above.
- Bilingual design doc and regression tests land in the same change.

## Open questions

None. The `cwd` item is resolved as "documented, no change" for worktree
enter/exit; the `/cd` rehydration observation is tracked as #16982.
