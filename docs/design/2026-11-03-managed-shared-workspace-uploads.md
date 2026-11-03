# Shared Workspace uploads

[English](2026-11-03-managed-shared-workspace-uploads.md) | [简体中文](2026-11-03-managed-shared-workspace-uploads.zh-CN.md)

## Problem and scope

Ordinary Sessions already share a Workspace directory. Upload admission still
requires zero execution members and installs an exclusive `holder_key` until the
original file process reports a terminal result. One upload therefore blocks
ordinary tools and other uploads, even when they write different files.

Allow ordinary edits, commands and uploads to share LOCAL and SSH_LOCAL directories.
Keep the existing exclusion for rewind, directory recovery, migration and physical resource
collection. Authorization, frozen upload identity, idempotency, unknown-outcome
reconciliation and generation fencing remain required.

## Design

Reuse the directory's existing `member_count` for ordinary users: Runtime Session
rows with that `execution_storage_key`, plus `RUNNING` `WORKSPACE_UPLOAD`
operations with that `physical_key`. No new schema field or lock service is needed.

Upload admission registers the operation and increments the count in the same
transaction. It permits other members, requires a ready directory, and rejects
an exclusive rewind, maintenance or physical owner. It does not set `holder_key`.
The existing short transaction and its serialization of upload receipts remain;
file I/O continues after commit.

A confirmed terminal result decrements the count and settles that exact operation
in one transaction. Replays of settled operations do not decrement again. A pending
or unknown result retains membership across restart and only queries the frozen
original target. One upload cannot release another upload's membership or a
Runtime Session's membership.

Maintenance and physical fencing still require zero members. Rewind requires its
own Runtime Session to be the only member, so an upload blocks rewind in either
admission order. Directory recovery and cleanup already check this count or
unfinished upload operations. Runtime drain and stopped-member cleanup affect only
the exact Runtime process or membership; uploads use independent file processes
and retain their original targets and membership during that cleanup.

Uploads retain atomic no-clobber publication: an occupied destination returns a
conflict and is never overwritten. Ordinary tools can still edit the same file;
this change adds no cross-session file merging guarantee.

## Affected components

- `WorkspaceFileUploadStore`: shared admission and exactly-once membership release.
- Storage owner schema comment: document the combined member count.
- Upload and membership verification: count live Runtime members and upload operations.
- Upload and directory-membership designs: describe shared upload membership.

There are no route, request, response or authentication changes. CSI uploads remain
unsupported. This increment is based on PR #16205.

## Verification and acceptance

1. Two overlapping uploads to one directory both reach the file process.
2. Tools can acquire and retain membership while an upload is pending; an upload
   can start while tools have membership.
3. Uploads and rewind/maintenance/fencing exclude each other. Recovery and cleanup
   cannot discard an unfinished upload's original target. Runtime member release
   leaves any unfinished upload counted.
4. Completion, failure, retry and restart leave the count equal to the sum of live
   Runtime memberships and running upload operations. Repeated terminal responses
   do not subtract twice.
5. Existing actor, changed-request, backend-selection and frozen-target tests pass.

Use focused Java and real MySQL tests within the module's shared local verification
budget. Keep full MySQL and Hosted/fault gates in CI. Record executed checks and
remaining acceptance gaps in the E2E report; this document does not claim a pass.

## Open questions

None. The user explicitly chose shared ordinary execution and uploads while
retaining rewind, recovery, migration and collection protections.
