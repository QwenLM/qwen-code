# Managed Workspace uploads

[English](2026-10-26-managed-workspace-upload.md) | [简体中文](2026-10-26-managed-workspace-upload.zh-CN.md)

## Problem and scope

Managed WebShell can attach text and images to a message and snapshot small
Workspace text files. It cannot upload browser files into persistent Workspace
storage. The existing file service resolves registered LOCAL and SSH_LOCAL
storage through a bounded CLI bootstrap exchange; CSI file access is unsupported.

Implement uploads for these existing storage kinds, including empty files and
binary files, with an 8 MiB per-file limit. Reuse the composer picker, drop
choice, progress/error rows, cancellation and session-switch fencing. Uploads
create files in the selected working directory or a browsed existing directory.
An occupied destination returns a conflict and is never overwritten. Folder
uploads, automatic directory creation, CSI, and an object-storage service are
outside this change.

Uploads require no outstanding execution-storage members. Ordinary settled
Turns release these members; a persistent MCP Runtime may still retain one and
therefore return `workspace_busy`. This change does not weaken that ownership
boundary to treat an apparently idle Session as proof of a stopped tool process.

## Ownership and API

The new WebShell `POST /api/agent/web-shell/v1/workspaces/files/upload` route is
persisted-Workspace scoped. Query parameters are `workspaceId`, `cwdRelative`,
`path`, `expectedScopeRevision` and UUID `uploadId`; the request body is
`application/octet-stream`. It requires a trusted actor with OPERATOR or OWNER
access and enabled Workspace file access. The server validates the registered
storage identity and revision, and never resolves a daemon primary Workspace.
The binary body is read with a hard limit. A matching repeat of an upload ID
reconciles its original command; a changed request conflicts.

The response includes `scopeRevision`, `uploadId`, `path`, `sizeBytes` and
`sha256`. A Workspace file query advertises optional `maxUploadBytes` only when
the selected CLI supports the independent `workspaceFileUpload: 1` handshake.
Old deployments retain text references and keep upload disabled. OpenAPI, its
generated client types, surface registry and capability parity advance together.

## Durable admission and recovery

A short SQL transaction admits a `WORKSPACE_UPLOAD` operation in the existing
operation ledger and takes the physical storage owner hold. It freezes the
actor, request digest, ContextBinding, storage identity and original bootstrap
target; binary bytes are not stored in SQL. Existing tool acquisition, storage
fencing and retirement must respect this hold. No subprocess or SSH exchange
runs inside a SQL transaction. A completed or definitively failed command
releases only its own hold; a timeout, lost response or control-plane restart
keeps it until the original command is reconciled.

The runtime keeps an owner-private receipt under its configured state directory,
keyed by `uploadId`. It atomically claims the operation before writing, records
the original PID, and publishes a terminal receipt only after all file mutation
and temporary-file cleanup has finished. Reconciliation never executes an upload.
It returns a terminal receipt, conservatively waits for a live original process,
or, after definite original-process absence, checks the original destination's
length and digest. If no claim exists, reconciliation atomically publishes a
failure tombstone so a delayed original command cannot start. PID reuse may
delay reconciliation; it never authorizes replay. No replacement Runtime,
repeated mutation, or rollback deletion is used to resolve an unknown outcome.

## Runtime filesystem boundary

The existing bootstrap verifies allowed roots, storage identity and working
directory. Upload requests use protocol version 1 with operations `upload` and
`upload-status`, `uploadId`, relative `path`, `sizeBytes`, `sha256`, and base64
`data` for upload only. Responses use `state: completed | failed | pending`,
with terminal `code` on failure. Transport input is bounded separately from the
64 KiB response and ordinary bootstrap limits.

Reuse normalized relative-path validation and directory identity checks. Reject
symlinks, traversal, reserved managed storage paths and non-regular files. Write
an owner-only temporary file, sync it, check the directory anchors again, and
publish with an atomic no-clobber hard link. Never overwrite an occupied path.
Detected path or storage identity changes fail closed. These checks retain the
existing Node filesystem race limitations; they do not claim an `openat` sandbox.

## Composer behavior

A Managed upload target is supplied explicitly to the shared composer, without
enabling unrelated daemon features. The target identity includes provider,
Workspace, working directory, revision and session. An upload completion from a
previous target cannot append to the current draft. The existing customization
switch can still disable uploads.

A successful upload inserts a scoped path reference. On send, the Managed
adapter checks its scope and includes the relative path in model input; binary
bytes are not turned into a text attachment or read through the small-text
snapshot API. Existing text references keep their immutable snapshot behavior.
Cancelling a browser request does not promise deletion of an already committed
file; uncertain outcomes reconcile by the original upload ID.

## Validation and acceptance

- Baseline: the installed CLI lacks the upload handshake and the Managed menu
  cannot upload to Workspace storage.
- Runtime: exact binary/empty bytes, 8 MiB boundaries, existing files, nested and
  Unicode paths, symlinks/traversal, changed storage identity, concurrent/repeated
  IDs, terminal receipts and crash/late-start reconciliation.
- Control plane: actor/tenant isolation, roles, stale scope, disabled/unsupported
  storage, durable holds, concurrent tools/fencing, request mismatch, unknown
  results, original-target recovery and response byte/digest validation.
- UI: enabled capability path, old capability disabled path, binary references,
  failed uploads, target switches and unchanged text snapshots.
- Run focused package tests, root build/typecheck/bundle, OpenAPI contract and
  surface gates, plus focused Java checks within the module's shared ten-minute
  local verification budget. SQL/concurrency cases need real MySQL evidence;
  unrun SSH, CSI, Linux or real-provider paths remain explicit acceptance gaps.

Implemented across the control plane, bundled CLI and WebShell. Local
verification passed root build/typecheck/bundle, focused TypeScript and Java
tests, contract/surface gates and Checkstyle. The selected Java run covered 99
distinct cases; the new upload suite also passed 10 cases on disposable MySQL
8.4.11. Initial Java setup, checks and cleanup used 569 seconds; the final
review regression, direct compilation and style checks stayed within the same
shared 600-second local budget. Independent review identified a blocked stdin
writer competing with stdout readers in the common pool. An independent JVM
reproduced the timeout; moving the writer to a virtual thread passed both that
probe and the permanent forked-process regression. Review then found no
additional confirmed defect.

The actual bundled LOCAL Runtime passed 15 smoke-test groups (27 subprocess
commands). Earlier Chromium verification passed five groups using the real UI
and bundled Runtime with controlled Java HTTP responses. It exposed and
verified the repair of an existing-Session submission path that discarded
prepared text-only file context; that evidence is limited to its controlled
HTTP setup.

After rebasing onto main `338f13366c`, root build/typecheck/bundle, 452 selected
WebShell tests, 267 selected CLI tests, 92 selected Java tests, executable server
packaging and Checkstyle passed. A fresh MySQL 8.4.11 case initialized the full
current V1 baseline and verified that the original process hold excludes a
second upload and physical fencing. The user explicitly added 30 minutes to
the shared Java verification budget for this deployment work.

The actual `qwen serve --managed` deployment used isolated data, signed
Gateway-to-Java requests, fresh H2, Hosted Harness, and the production bundled
LOCAL Runtime without HTTP interception. Ten API groups passed binary/empty
and 8 MiB uploads, oversize rejection, no-clobber/idempotent results, path safety
and independent actor/tenant isolation. Chromium uploaded through the actual
full application menu and submitted a new Session with scoped path-only input.
The configured Kimi Turn produced no assistant or tool result within 150
seconds and was cancelled; real-provider file reading is not accepted. A
controlled restart preserved all four completed upload receipts, exact disk
digests and scope revision. The original Session subsequently required operator
recovery, so its disabled upload menu followed that failure boundary and an
existing-Session binary submission was not verified by this deployment run.

Remote SSH, Linux, real-provider reading, recovery of that Session and full
Java/Hosted/fault CI gates remain pending. CSI remains unsupported. Server, CLI
and WebShell must be deployed together; the pre-release schema policy requires
recreating development catalogs after this V1 baseline change.
