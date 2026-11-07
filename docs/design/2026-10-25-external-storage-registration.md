# External Workspace storage registration

[English](2026-10-25-external-storage-registration.md) | [简体中文](2026-10-25-external-storage-registration.zh-CN.md)

Status: implemented compatibility increment, acceptance pending CI. Tracks PR-A of
[issue #15512](https://github.com/QwenLM/qwen-code/issues/15512).

## Problem and scope

The control plane needs to reserve provider-owned storage before it can safely
bind a future external Workspace. Local directory identity cannot represent
persistent provider storage: the server cannot inspect the remote filesystem,
and a sandbox ID does not survive sandbox replacement.

This increment registers immutable metadata. It does not create a Workspace,
launch a worker, make remote calls, select a provisioner, or grant execution.
CLI admission, adapters, Kubernetes, retirement and re-registration remain later
increments. Existing LOCAL/UNREGISTERED behavior stays unchanged.

## Contract and decisions

The operator submits `ExternalStorageIdentity` (`providerId`, `physicalKey`,
positive `registrationRevision`) and `StorageAlias` (`tenantWorkspaceId`,
`aliasPath`, `mountRoot`). IDs use `[A-Za-z0-9._-]{1,128}`. Paths are absolute,
non-root, at most 2048 characters, with nonempty `[A-Za-z0-9._-]+` components
excluding `.` and `..`. This is a portable lexical contract, not filesystem
attestation; remote permissions and existence remain unverified.

`tenantWorkspaceId` reserves a tenant storage ID. Existing aliases, Workspaces
and Runtime bindings cannot be adopted. The physical owner key hashes the
provider and physicalKey, excluding revision, so a new revision cannot evade
single-tenant ownership. A physical owner has one immutable alias. External alias
paths are globally exclusive. Conflicts return sanitized HTTP 409 responses.

The registration endpoint is persisted-workspace-scoped operator control:
`POST /internal/managed-workspaces/v1/storage:register-external`. It requires an
explicit loopback listener, loopback local and peer addresses, the existing
Broker bearer credential and a tenant header. The credential is operator-wide;
Workspace grants and forwarded headers grant no access. Input is bounded to
16 KiB and rejects duplicate/unknown JSON fields. Responses are no-store.

The tenant-scoped `idempotencyKey` uses `[A-Za-z0-9._:-]{1,128}`. Its digest covers
only the registration. Optional visible-ASCII `requestId` (1–128 characters)
sets HTTP correlation, not idempotency. Identical retries return the original
registration ID and epoch-millisecond timestamp after restart; changed data with
the same key returns `idempotency_conflict`. New requests cannot change an owner.

## Persistence and compatibility

Use existing `ma_storage`, `ma_storage_owner` and `ma_request_receipt` rows in one
transaction. The only schema extension is the `EXTERNAL_STORAGE` receipt
namespace in the fresh V1 baseline and its shared Java contract. Existing
development catalogs must be recreated; there is no upgrade or repair path.

Acquire the existing tenant placement lock before a shared external-registration
lock. The latter serializes cross-tenant alias checks; the linear metadata scan
is a deliberate tradeoff for this infrequent operator operation. Owner rows keep
`mount_state=UNVERIFIED` and no holder. Local execution/recovery and CSI
registration reject EXTERNAL aliases. No local Files call interprets their paths.

## Validation and follow-up

The focused registration tests exercise SQL-backed success/replay, restart,
identity drift, tenant/alias collision, concurrent registration, legacy alias
compatibility, execution refusal, loopback/bearer admission and sanitized errors.
The same witnesses run against MySQL through the existing integration profile.
Route admission and capability inventories include the operator-only endpoint;
the CLI parity inventory explicitly excludes it from client capabilities.

Local verification is limited to the new tests, compilation and Checkstyle under
the shared ten-minute Java budget. Real MySQL, route contract suites and complete
CI gates remain required before acceptance. Future activation must attest remote
storage and install writer/generation fences before enabling tools; registration
alone is never sufficient evidence.
