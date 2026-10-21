# Atomic settings saves for #12417

[English](2026-09-30-atomic-settings-save.md) | [简体中文](2026-09-30-atomic-settings-save.zh-CN.md)

Status: implemented; macOS verification passes; maintainer reports native Linux acceptance at `d0be922868`; native Windows checks remain open.
Date: 2026-09-30.
Issue: [#12417](https://github.com/QwenLM/qwen-code/issues/12417).
Source baseline: 3a8fd11711a10b9a2435bd0051485e31479e90ae.

## Problem and evidence

At the baseline, saving an existing settings file first renames the target to its backup, then
renames a temporary file to the target. Between those operations the target
does not exist. Operator settings readers accept that absence as empty
settings, so an unrelated settings save can temporarily remove an execution
sandbox policy from a concurrent startup.

An independent controlled reproduction used the real baseline writer and
reader, plus global qwen 0.24.6 on macOS arm64 / Node.js 22.14.0. Before and
after the save, qwen sandbox read the configured policy and exited 1 because
the selected execution sandbox requires Linux. Pausing immediately after the
backup rename made the target disappear; the source reader returned no policy
and a second qwen sandbox exited 0 with "Tool execution sandbox: none".
The writer was resumed and the isolated fixture removed.

This proves an observable intermediate state, not the natural race frequency,
a Linux tool escaping confinement, or Windows behavior. The historical
2-in-100 measurement in the issue was not re-executed here. Reproduction
artifacts are in .qwen/issues/issue-12417.md and
.qwen/e2e-tests/issue-12417-settings-gap-repro.json.

## Goals and boundaries

For replacement of an existing settings file, repository-owned saves must
publish a complete file without making the target absent. Each successful
open during a save must see a complete previously committed or newly committed
file. A replacement failure must leave the current target alone and report
failure.

The first implementation covers the atomic-save part of #12417. It preserves
scope precedence, JSONC editing, environment expansion, missing-file behavior,
and sandbox selection. It does not add a settings lock service, runtime
policy hot reload, settings-merge conflict detection, startup retries, or
automatic recovery from external deletion.

First creation remains absent until publication; this proposal cannot make a
policy effective before it exists. Concurrent saves remain last successful
whole-file publication wins. Two read-modify-write operations can still lose
an unrelated edit; eliminating that separate conflict is outside this slice.

## Current consumers

The helper is internal to the CLI package. The complete production call-site
search at the baseline found the following consumers:

| Consumer                                                                            | Contract to preserve                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [JSONC editor](../../packages/cli/src/utils/jsonc-editor.ts)                        | First creation, merge, subtree replacement and migration synchronization publish the already validated bytes; comments and BOM handling stay in the editor. |
| [Provider settings adapter](../../packages/cli/src/config/loadedSettingsAdapter.ts) | Transaction restore writes its independent in-memory file snapshot through the helper; it does not read the helper's backup.                                |
| [Settings persistence](../../packages/cli/src/config/settings.ts)                   | setValue, batched writes and migrations use the JSONC editor; existing save-error propagation stays intact.                                                 |
| [Operator reader](../../packages/cli/src/config/execution-sandbox-settings.ts)      | Startup and bare mode read the target, never staging or backup files; absent files remain optional, malformed files remain refused.                         |
| [Scope reload and watcher](../../packages/cli/src/config/settingsWatcher.ts)        | Reload uses the target path; the watcher filters the exact settings basename and must ignore save artifacts.                                                |

The async writeWithBackup export delegates to the synchronous helper; no
production caller of that export was found. backupSuffix and encoding have
test coverage; no production caller supplies a custom backup suffix or reads
the fixed .orig path. The adapter's intentional removal when its pretransaction
snapshot was absent is unchanged.

## Proposed save sequence

Keep the existing synchronous API and implement the sequence in the helper.
Use one private, uniquely named working directory beside the target, created
with fs.mkdtempSync using a settings.json.write- prefix. Its child paths are
settings.json.tmp and settings.json plus backupSuffix (default .orig).
A directory on the same parent filesystem supports a same-filesystem rename
and gives each invocation exclusive ownership of its artifacts.

1. Preserve the existing rejection of a directory target. Create the working
   directory, then write the complete new bytes to its staging file with
   exclusive creation and flush: true. Keep the helper's existing encoding
   and file-creation permission semantics.
2. If the target exists, copy it into this invocation's backup with
   COPYFILE_EXCL. Copying never moves or truncates the target. A backup failure
   aborts publication; do not silently continue.
3. Publish with a single fs.renameSync from staging to the target. This is the
   only step that replaces the target. Do not rename or unlink the target
   beforehand.
4. After successful publication, remove only this invocation's working
   directory, best effort. Cleanup failure does not undo a successful save.
5. On failure before publication, compare a complete backup with the current
   target as raw bytes. If they match, remove this invocation's directory, best
   effort: retaining an identical copy would accumulate directories when
   replacement persistently fails, such as on a single-file bind mount. If they
   differ or either read fails, retain the backup, name it in the error and
   remove only staging, best effort. Without a complete backup, clean up the
   private directory. Never restore a backup automatically over the target.

The private directory avoids shared .tmp collisions and shared .orig ownership.
A plain copy into a fixed backup path could also overwrite a pre-existing
symlink destination; exclusive creation inside a newly created private
directory avoids introducing that behavior. No other invocation's artifacts,
including historical .tmp/.orig files, are removed or treated as committed
settings. There is no new scavenger.

The backup is a diagnostic/manual recovery copy of a previous complete file,
not an authoritative transaction snapshot. It may precede another writer's
successful publication. Removing the old automatic restore branch is essential:
writer A failing after writer B publishes must not overwrite B with A's older
backup. The provider adapter's explicit transaction restore remains separate.

## Failure and crash behavior

| Point                                                   | Target behavior                                                                         | Artifact/result behavior                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Working-directory or staging creation/write/flush fails | Existing target untouched                                                               | Save fails; clean only owned artifacts.                                                                   |
| Backup copy fails                                       | Existing target untouched                                                               | Save fails; incomplete backup is not advertised as usable.                                                |
| Final rename fails, including EPERM/EACCES/EBUSY        | Current target untouched by this invocation, including another writer's successful save | Save fails; remove identical backup, retain different or unreadable backup; no rollback or copy fallback. |
| Publication succeeds but cleanup fails                  | Complete new file remains committed                                                     | Save succeeds; private artifacts may remain.                                                              |
| Process stops before publication                        | Existing committed file remains at the target                                           | Private artifacts may remain and are ignored by readers.                                                  |
| Process stops after publication                         | Complete committed file remains at the target                                           | Backup/staging cleanup may be incomplete; no automatic replay.                                            |

These are process-crash and publication-visibility requirements on supported
local filesystems. The current file flush is retained, but this change adds
no directory fsync and makes no new power-loss durability guarantee. External
deletion, permission changes, network-filesystem semantics, and an actor
replacing the containing directory are outside the guarantee.

Repeated failed saves do not accumulate identical backups when cleanup succeeds.
Different or unreadable recovery copies, cleanup failures and process crashes
can still leave multiple private directories. Comparison is not a lock or a
guarantee against later external deletion; it never changes the live target.
Recovery copies are never loaded automatically. Inspect the current target before
manually restoring a reported backup, since it may predate another writer.
After inspection, remove only the named invocation's directory; this proposal
does not introduce a scavenger for artifacts from earlier invocations.

## Windows and alternatives

Use the same single-rename publication path on all platforms. Node.js documents
replacement of an existing destination; the Windows libuv implementation used
by local Node.js calls MoveFileExW with MOVEFILE_REPLACE_EXISTING. These sources
support the chosen mechanism; they are not Windows runtime test evidence.
See [Node.js rename](https://nodejs.org/docs/latest-v22.x/api/fs.html#fsrenameoldpath-newpath-callback),
[libuv v1.49.2](https://github.com/libuv/libuv/blob/v1.49.2/src/win/fs.c#L2077),
and [Microsoft replacement flags](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

If Windows sharing or access rules reject replacement, propagate failure and
preserve the target. Do not fall back to copying onto the live target or to
unlink-then-rename. Node.js explicitly does not guarantee atomic file copying;
such fallbacks would expose partial bytes or absence. See
[Node.js copyFileSync](https://nodejs.org/docs/latest-v22.x/api/fs.html#fscopyfilesyncsrc-dest-mode).

Native Windows NTFS tests must cover ordinary replacement and a handle that
denies replacement, using the supported Node release. Mocked EPERM tests verify
our control flow only. This host has no native Windows verification, so that
acceptance requirement remains open.

The existing core `atomicWriteFileSync` was considered as a replacement. It
provides unique staging, file flush, permission preservation, symlink handling,
and EPERM/EACCES rename retries. Those are useful shared capabilities, but its
failure contract differs from this settings change: on EXDEV it falls back to
writing the live target directly; with `noFollow: true` it unlinks the target
before recreating it. A failed fallback can therefore leave partial bytes or
an absent target. There is no supported option to refuse that fallback. The
uid-preserving in-place branch belongs to the async `atomicWriteFile`, not the
synchronous variant proposed for these settings callers.

Routing these callers directly through the shared helper would weaken the
requirement that rejected publication leaves committed settings untouched.
It would also remove the existing manual recovery copy and change default
symlink behavior from replacing the link to writing through it. This slice
therefore retains the smaller CLI writer with strict replacement failure and
private recovery artifacts. Changing core's fallback policy or adding a new
strict mode would involve its other consumers and is outside this fix. This
choice does not inherit core's mode preservation or retry behavior; existing
settings permission semantics are retained, and native Windows validation is
still required. Rename retries alone do not establish replacement/refusal
behavior on Windows. The shared helper can be reconsidered if it gains an
equivalent strict-publication contract without changing those consumers.

Removing backups entirely would simplify publication but discard the helper's
existing manual recovery contract. Keeping shared staging paths would leave
two writer processes able to consume each other's temporary files. Adding
reader retries would mask the writer's intermediate absence and leave other
readers exposed. The proposed change needs no platform fallback or new package.

## Implementation and validation plan

The production logic change stays in the writer. The legacy writer and its
collocated test are renamed to write-with-backup.ts and write-with-backup.test.ts,
the two production imports are updated, and the obsolete filename allowlist
entry is removed. Helper, JSONC editor, settings and adapter comments now match
the recovery contract. Existing readers and sandbox validation have no
production logic changes; settings-test filesystem mocks use private staging.

Tests must assert outcomes rather than the number or order of filesystem calls:

- Deterministic checkpoints during staging, backup and before publication:
  the real operator reader always retains a valid configured policy. Reintroducing
  rename-away must make the test fail. Separately cover scope reload.
- Real subprocess writer/reader runs: alternate two complete JSONC settings
  documents that both retain the policy. Every sampled target is complete and
  no startup loses the policy. Include two writers to check artifact isolation;
  do not infer read-modify-write serializability from this test.
- Inject backup and final-rename failures; confirm exact committed bytes remain.
  Let writer B publish between A's backup and A's forced failure and verify B
  survives and the different recovery copy is reported. Repeated EBUSY failures
  with unchanged target bytes must leave no owned artifacts after cleanup;
  comparison-read failures must retain the complete copy and original write
  error. Include custom suffix, encoding, first creation, directory refusal
  and best-effort cleanup.
- Kill a writer before and after publication; readers ignore private leftovers.
  Existing JSONC, migration, adapter-restore and watcher behavior must remain.
- Run native Linux, macOS and Windows filesystem cases. On Linux, run a real
  global-qwen baseline first, then the built CLI sandbox verification and an
  ordinary confined tool-call probe during repeated saves.

After implementation run build and typecheck from the root, and focused writer,
JSONC editor, operator-settings, settings, adapter and watcher tests from
packages/cli. Build the bundle for CLI verification. The detailed plan is
.qwen/e2e-tests/issue-12417-atomic-settings-save.md.

Acceptance: no repository-owned replacement removes the target; readers see
complete committed bytes; the helper's failure path never rolls back another
writer (explicit caller-requested snapshot restores remain separate); artifacts
are invocation-owned; native Windows replacement/refusal is verified; Linux
confinement remains enforced during saves. Local implementation evidence is
recorded below; native platform requirements remain explicit.

## Remaining #12417 work

Keep #12417 open after the atomic-save slice and handle the remaining items
in separate changes. The following is a disposition, not fresh E2E validation:

| Item                                                                                                  | Disposition                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Malformed settings UX, obsolete corruption/reset flows and release note                               | Separate settings-error change; preserve refusal and audit every startup surface.                                                                                        |
| Scope-reload BOM handling                                                                             | Baseline already calls stripUtf8Bom; add focused coverage if missing, not another parser implementation.                                                                 |
| Explicit legacy sandbox selection conflict                                                            | Baseline validateExecutionSandboxSelection already refuses a policy combined with a truthy legacy selection; retain coverage and recheck subcommand coercion separately. |
| Inherited SANDBOX reporting and bwrap migration argument shapes                                       | Separate diagnostics/parser change; do not weaken selection guards.                                                                                                      |
| Wrapper environment normalization                                                                     | QWEN_SANDBOX already trims/lowercases; SANDBOX still uses exact equality. Fix the remaining discrepancy only.                                                            |
| About wording and bwrap install path                                                                  | State that npm was not probed; document the existing supported installation path before considering a new setting.                                                       |
| Final output tail, stdin regular-file offset and idle FIFO shutdown                                   | Separate stream/descriptor correctness work with real-pipe tests.                                                                                                        |
| Connected sockets/TTY inheritance, worktree Git metadata, TMPDIR viability and model network guidance | Separate boundary decisions and Linux acceptance; do not silently broaden permissions.                                                                                   |

## Validation evidence and open platform checks

The independent baseline is reproduced. Build, typecheck, bundle, focused
ESLint, and six focused CLI test files pass (383 tests). The real operator-reader
and scope-reload regression fails with the baseline writer restored and passes
with the fix. Failure injection covers staging/flush, partial backup copy,
EPERM/EACCES, first publication and post-publication cleanup. Overlapping
writers are covered, including a failed writer preserving another writer's save.

Independent verification uses built CLI 0.24.7 on macOS arm64 / Node 22.14.0.
Six controlled CLI scenarios pass: successful save, injected EPERM, SIGKILL
before and after publication, overlapping successful writers, and writer A
failing after B publishes. At the former gap checkpoint the target retains
the complete old settings and policy; after publication it contains the new
settings. The CLI consistently refuses the Linux-only sandbox on this host
instead of reporting that no sandbox policy exists.

Two native writer processes perform 600 JSONC saves while an independent
reader samples 2,500 complete known documents and invokes the real operator
reader. There are no missing-file, parse or policy-loss failures. Barriers
confirm 100 samples while both writers are paused after backup and 2,100
samples after release before either finishes. All five old/new document
markers are observed, and successful completion leaves only the target.
These counts describe the initial independent verification run. A subsequent
PR-submission run of the same production code at `3923fd845` again completes
600 saves, with 2,700 reader samples: 100 while both writers are paused and
2,300 after release before the first writer completes. Reader sample counts
vary with process scheduling; these are two separate successful runs, not
conflicting measurements of one run. The PR E2E comment reports the latter.
Its raw results are .qwen/e2e-tests/issue-12417-pr-settings-gap-verify.json and
.qwen/e2e-tests/issue-12417-pr-concurrent-save-verify.json.
Initial raw evidence is retained in .qwen/e2e-tests/issue-12417-settings-gap-verify.json
and .qwen/e2e-tests/issue-12417-concurrent-save-verify.json; the corresponding
scripts are in .qwen/scripts/.

On 2026-09-30, maintainer wenshao supplied [native Linux verification at
`d0be922868`](https://github.com/QwenLM/qwen-code/pull/13119#issuecomment-5918187683):
Linux 6.12/ext4, Node 22.22 and real bubblewrap 0.12.0, using the bundled CLI.
The report covers every writer checkpoint, process-kill injection, concurrent
saves and live watcher behavior. During saves, the admitted policy remains
configured, workspace writes succeed and outside-workspace writes fail with
EROFS. This is maintainer-supplied evidence, not a run on the local macOS host.
The same report also verifies the proposed identical-backup cleanup patch on
Linux; local reproduction and post-fix verification are recorded separately.

The cleanup follow-up is independently reproduced on macOS with the compiled
writer and real isolated files: three injected EBUSY failures leave three
identical backups before the fix and none after it. A second process publishing
before the first writer fails keeps its newer target and the different recovery
copy. Injected errors reading either comparison input retain the complete copy
and original publication error. First-publication failure and normal creation
and replacement also pass; 17 focused writer tests pass. These injected errors
are control-flow evidence, not native Linux bind-mount or Windows verification.

Native Windows replacement/refusal remains pending. macOS error injection and
the CLI's unsupported-platform refusal do not satisfy that requirement.
