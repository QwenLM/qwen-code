# K2-A2: one retained backend for file tools and history

[English](2026-10-08-k2-retained-file-backend.md) | [简体中文](2026-10-08-k2-retained-file-backend.zh-CN.md)

Status: implementation design, 2026-10-08. Baseline
`3d64d91d35bd74ce6a4c8f5ba5ca091940d61d28` in
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526).
This implements the storage component of the
[native file chain](2026-10-07-k2-native-file-execution.md); it does not enable
boot4/CSI2, native mutation admission or a public CSI selector.

## 1. Problem and scope

The mount now lends its original root through a joined, verified callback, and
Read can consume one descriptor through its complete format pipeline. Actual
Write/Edit metadata, mkdir and post-write stat still use pathnames. History
validation, fingerprinting, backup copying, reuse and diff also use pathnames
and the global home directory. Replacing text writes alone leaves these paths.

Add one concrete Linux backend and an internal file-only composer. The composer
creates and populates the backend on Config and forwards the same object to
history before initialization, including rollback constructors. Legacy omitted
dependencies retain their behavior. The generic worker continues refusing the
reserved profile: component composition is not native dispatch authorization.

## 2. Original directory and lifetime

The backend borrows the supplied original `ManagedCsiMount`; it never opens a
second root. Retain no-follow directory descriptors for
`.qwen-csi-file-history/<canonical owner UUID>` on that device. Initial bind
creates the owner directory exclusively; any existing owner directory, including
an empty one, is refused rather than adopted. Existing prefix directories may be
opened only after the same-device no-follow checks. Create missing directories through one validated component below an admitted
parent, sync their parents, and retain the original identities. Verify named
and descriptor identities before and after each complete operation.

Working paths must be canonical absolute paths under that logical mount root.
Deny the entire reserved subtree and original/provisional backup inode aliases.
Walk parents one component at a time through `/proc/self/fd/<parent fd>` with
`O_DIRECTORY | O_NOFOLLOW`. Admit only regular same-device leaves, with
`O_NOFOLLOW | O_NONBLOCK`, and hold all opened parents through final checks and
close joins. A missing parent/leaf means absence only after those checks; other
errors cannot become an empty file. Backup aliases are refused by their original
device/inode, including handles retained for partial attempts.

Register pending work before its first await. Close immediately fences new work,
retains one promise, joins admitted operations and closes all owned descriptors
once. Identity, I/O, copy, sync and close failures remain observable blockers;
do not self-await close from inside a borrow. Invalid lexical input refuses
before I/O. Wrappers borrow the backend and never close it on metadata rollback.

## 3. Finite tool and history contracts

The existing FSS gains an optional `textFileIo` member with two required methods.
Its actual private producer populates both; Standard/ACP omit it.

| Operation          | Actual behavior                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`          | One joined, read-only missing/file observation with decoded text, encoding/BOM/line endings and same-fd Stats. No mkdir, writer or escaped descriptor.                                                                                                                                                                                |
| `withMutation`     | One original-root lifetime through actual execute, providing a fresh original observation and one bound writer. The writer accepts only that logical path, creates parents only when invoked, writes encoded bytes on the admitted inode, syncs file/parent and returns actual committed Stats. It cannot be used after the callback. |
| FSS `withReadFile` | The existing complete descriptor-backed Read pipeline, preserving all formats and helper lifecycle requirements. Missing Read throws; no Standard pathname fallback.                                                                                                                                                                  |

Confirmation and modify use `inspect`. Execute uses `withMutation` through the
algorithm, writer and result. Its Stats replaces direct post-stat, and its parent
creation replaces direct mkdir. Config's duplicate built-in history and prior
read cache enforcement remain disabled in the private composer. Keep existing
encoding and structured tool error semantics. Artifact metadata uses the admitted
canonical logical path and returned Stats; it does not resolve a second pathname
after the private write. Config construction's root metadata observation stays
inside the original mount borrow.

Finite tools use conservative `ask` default permissions without host memory or
pathname canonicalization. Team-memory secret scanning remains enabled for the
logical workspace `.qwen/team-memory` subtree; the no-follow backend rejects
aliases instead of resolving them. Private Read skips host Git/home auto-memory
classification and pathname `.qwenignore` discovery. This internal profile relies
on backend membership admission, and does not enable automatic memory exemptions
or claim the ordinary local ignore policy. Ordinary tools retain their existing
permission, memory and ignore behavior. Host Git commit attribution is also omitted
for finite mutations; the managed retained history records their actual changes.

Existing-file writes retain the admitted inode. They are not atomic replacement
or compare-and-swap: interrupted writes can leave partial working bytes and a
sticky blocker. The retained raw preimage survives. New files are exclusive;
missing parents observed before execute are created exclusively, with no
recursive pathname fallback. Concurrent in-place external writers are outside
this component's immutable-version guarantee. Native prepared history remains
required before eventual private mutation admission.

`RetainedFileHistoryStorage` has exactly three required methods:
`withWorkingFile`, `withBackupFile`, and `createBackup`. The first lends a
descriptor source or genuine null absence. The second authenticates an existing
original pin and never returns missing. The third copies raw bytes into a unique
exclusive no-follow leaf, handling short reads/writes through the same handles,
preserving permissions and syncing file and directory before success.

Register attempted backup handles/inodes immediately after exclusive creation,
before writing. Serialize exclusive creation and original inode registration,
complete directory inventory checks and alias checks through one internal queue.
An inventory/alias check waits for earlier creation to register; creation cannot
change the inventory during that check. Byte copying stays outside that queue,
so nested history borrows do not wait on themselves. Retain those handles, immutable successful pins and failed
attempts independently of legacy snapshots. A failed copy is never overwritten,
deleted, retried as a replacement or adopted by hashing current bytes. Check raw
digest, extent, mode and original named/descriptor inode before and after every
backup borrow. Original pins cannot disappear across metadata rollback.

## 4. Actual history consumers and composition

Pass the backend through private composer → tool set → executor history bind →
`ManagedRuntimeFileHistory` → normal/rollback `ManagedToolFileHistory` →
`FileHistoryService`, before restored-snapshot validation. Route all retained
stat/read/backup/validation/reuse/diff/fingerprint operations through the finite
endpoints, selecting that branch before any legacy path helper. Fingerprints
hash positional chunks and captured mode. A missing non-null backup is an error.

Propagate retained failures rather than omitting rows, marking normal absence,
healing failed metadata or publishing a completed snapshot. Join every started
parallel operation before returning its group's failure. Authenticate equal
backup pointers before diff fast paths. Refuse the 101st snapshot before I/O or
metadata changes. Retained `getDiffStats` refuses content above the existing
`MAX_DIFF_SIZE_BYTES` cap rather than reading it without a bound; `getTurnDiff`
keeps its existing oversized-row behavior. Refuse rewind, apply and cleanup before
destructive I/O.

The internal composer constructs only Read/Write/Edit, sets the actual backend
through Config's existing setter, and exposes retained observation and joined
close. Retained observation compares the complete actual directory inventory
with original attempts and verifies every successful pin. Unknown/incomplete
leaves block qualification. The existing snapshot projection stays closed;
directory/pins are separate observations for the later schema-2 producer.
Composer observation joins the captured history tail, authenticates the storage
inventory, then checks that history metadata did not change across that borrow.
Composer close fences its tool set and backend immediately, joins the captured
history tail and backend operations, and closes the supplied mount after them.
It does not establish aggregate worker QUIESCENT/DRAINED or native authorization.
No new route, provider worker or environment selector is introduced here.

## 5. Affected files and verification

Change the CLI retained backend/composer, executor history dependency and managed
runtime history; core FSS, FileHistoryService, managed history, Read/Write/Edit and the team-memory secret guard;
collocated tests and this linked design pair. Read's whole-source format pipeline
and legacy helpers need no format reduction.

Global `qwen` first establishes ordinary text tool behavior. Independently test
actual component composition, build/default permission/confirmation/modify/execute
without pathname discovery, positive controls for Node named exports, preserved
team-memory secret refusal, source absence versus denial, raw non-UTF8/BOM
backups, original pin replacement/mutation, hardlink aliases, symlink/parent
replacement, short writes/sync failure with retained orphans, callback/writer
close joins, every history consumer and rollback, snapshot capacity and blocked
rewind. Verify previews create nothing and returned Stats originates from the
committed fd. Run focused core/CLI suites, build/typecheck/bundle, self-audit and
the repository review workflow. Darwin tests must identify mapping fixtures and
cannot claim actual Linux syscall qualification; Linux-only tests report skips
explicitly. Fresh Linux CSI/MySQL/Hosted proof is required later.

## 6. Acceptance and remaining work

Component acceptance requires the real producer to populate both contracts and
all finite consumers to use the same original owner, with legacy compatibility
and independent failure/lifetime verification. No bare interface or test-only
setter counts as connected production work.

Full A2 still requires boot4/CSI2, exact original native reservation → intent →
prepare → prepared → whole-batch outcomes/checkpoints, helper qualification and
retained Session completion. K2-B aggregate drain/physical stop/NodeUnpublish,
K2-C atomic release/reuse and K2-D public/deployment/fresh cloud validation remain
unmet. Draft and maintainer review remain required. No component result or green
CI substitutes for those gates.

The addressing and sync design uses documented
[Linux directory-fd/open behavior](https://man7.org/linux/man-pages/man2/open.2.html)
and [Node 22 FileHandle operations](https://nodejs.org/docs/latest-v22.x/api/fs.html#class-filehandle).
Those APIs do not themselves prove concurrency safety, original CSI provenance
or physical writer closure.
