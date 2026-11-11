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
     exclusive copy; `'src-missing'` still returns a `null` backup.
   - `chmod(temporaryPath, srcStats.mode)` — permissions applied **before**
     publication.
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
enter/exit question; it is recorded here for a separate issue and is not
changed by this pilot.

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
   no temporary files (pins the unique-suffix adaptation).
5. **Permissions**: the published backup carries the source file's mode.
6. **Source-vanished race**: `copyFile` fails with ENOENT after the source is
   deleted → a `null` backup is recorded, nothing published.
7. **Rename retry semantics**: a single transient `EPERM` rename is retried
   and the complete backup is published; a persistent `EPERM` exhausts the
   retries and surfaces as a failed capture with nothing published.
8. **Existing suite**: `fileHistoryService.test.ts` and the retained-storage
   suite stay green (the `safeCopyFile` mode parameter defaults to today's
   behavior).
9. `npm run build && npm run bundle && npm run typecheck`, focused vitest
   runs, and an interactive E2E sanity pass (capture + rewind via tmux) per
   the test plan in `.qwen/e2e-tests/`. E2E is interactive-only: file
   checkpointing defaults to `!sdkMode && interactive`, so headless runs do
   not capture snapshots on either binary (existing gating).

## Validation results (2026-11-11)

- Reproduction: four failure-injection probes failed on the base commit,
  including the end-to-end silent wrong-restore (rewind reported
  `filesFailed: []` while writing truncated bytes).
- The permanent suite `file-history-atomic-backup.test.ts` (14 tests) passes
  with the fix; a mutation arm reverting `createBackup` to the direct copy
  failed 9/12, confirming the crash-safety assertions are load-bearing (the
  3 behavior-preservation tests pass on both implementations by design).
- Focused regression: 422 core tests across 7 file-history-related files and
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
  into the failed contract); a retries=0 mutation reddens the transient
  test. The suite grew to 14 tests, all green.

## Acceptance criteria

- No code path publishes incomplete content at a final backup path.
- `copyFile` / `chmod` / `rename` failures surface through the existing
  `failed` / `filesFailed` semantics, with temporary files cleaned up.
- Concurrent captures of the same deterministic path remain harmless.
- The `cwd` evaluation item is closed with the evidence above.
- Bilingual design doc and regression tests land in the same change.

## Open questions

None. The `cwd` item is resolved as "documented, no change"; the `/cd`
rehydration observation is deferred to a separate issue.
