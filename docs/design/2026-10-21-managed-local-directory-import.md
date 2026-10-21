# Managed local directory import

[English](2026-10-21-managed-local-directory-import.md) | [简体中文](2026-10-21-managed-local-directory-import.zh-CN.md)

## Problem and scope

Selecting an existing local project currently requires an administrator to
register a projects parent directory and grant an OWNER Workspace first. A
trusted, single-user local deployment should perform those steps when the user
selects the project. Existing files stay in place. SSH onboarding, shared remote
deployments, marker repair, and filesystem sandboxing are outside this change.

## Authority

Add `runtime-broker.local-directory-import-enabled`, default `false`. Startup
requires a loopback public listener, OPEN authentication with a configured
trusted actor header, Workspace files, durable local-process execution, and
verified recovery. This is an explicit single-user host capability. Publish
`localDirectoryImport` independently from existing directory selection and empty
Workspace creation. Every request still requires an authenticated tenant actor.

## Import lifecycle

Extend WebShell Workspace creation with an optional absolute `localPath`,
exclusive with `sourceWorkspaceId` and `cwdRelative`. Reuse the actor-scoped
`WORKSPACE_CREATE` receipt and its idempotency key. Freeze the request before
submitting it; an uncertain retry cannot change the path or name.

Canonicalize and validate the existing project. Reuse a verified LOCAL storage
root from an ACTIVE ROOT Workspace owned by the actor when it contains the
project. Otherwise select the nearest projects parent outside every ancestor
Git worktree. Reject filesystem-root storage, reserved directories, private
Runtime state and empty-Workspace creation-root overlaps. Persist the canonical
root and its native host/device/inode/birth identity in the pending receipt
before registration. Reuse the existing guarded registration and OWNER grant
transaction; never copy files or replace an existing marker.

Completed receipts resolve imported roots for file access, tool admission,
Runtime mounting and recovery, including after a restart or disabling further
imports. The guard continues to verify the marker and physical identity. The
receipt resolver must not depend on an empty-Workspace creation root. Repeated
imports under a root in use reuse its storage rather than registering it again.
A concurrent first import can fail closed while registration is pending; a
retry may reuse the now-completed owned root after verifying the pinned
identity. Revoked access is never restored by replay.

The selected project becomes `defaultCwdRelative`. The registered parent and
its physical-owner lease are shared, as in existing directory selection;
selecting a child directory does not establish filesystem isolation. The marker
stays outside Git cleanup and the project remains the initial working directory.

## Browser flow and contract

Reuse the existing Add Workspace directory browser. In local import mode,
“Choose existing directory” opens host directories directly without an
authorized-Workspace selector. Extend the existing directories query with
`localPath`, exclusive with the existing Workspace-relative request. An empty
local path starts at the host home directory. Bounded directory enumeration
omits symlinks and reserved/private paths and requires the local import
capability. Restricted deployments retain their current authorized-root flow.

Update the OpenAPI schemas, generated WebShell types, Java adapter, capability
mapping, pending-request validation and English/Chinese labels together. Keep
directory queries actor/host scoped and imported Workspace operations scoped to
their persisted storage; do not fall back to the primary daemon or SSH.

## Affected areas

- Java configuration/security and `WorkspaceDiscoveryController`.
- `WorkspaceCreationStore`, `WorkspaceCreationRoots`, and storage identity
  access in `WorkspaceStorageGuard`.
- OpenAPI, contract tests, Java integration tests and server README.
- WebShell Java provider/client, `WorkspaceBindingCreator`, translations and
  focused UI/browser tests.

No schema migration or new receipt namespace is needed. Imported-root receipts
require compatible Java readers; older binaries refuse them. The Node worker
contract stays unchanged.

## Validation and acceptance

1. With no registered parent, browse and import an existing Git project; the
   resulting Workspace has OWNER access and starts in that project.
2. Files remain unchanged and the registration marker is outside the worktree.
   File queries and an initial tool Turn use the imported root.
3. Retry, restart, disabled future imports, second-project reuse and concurrent
   first imports preserve durable authority and idempotency.
4. Missing/replaced directories, foreign markers, overlapping roots, private
   state, invalid requests and revoked grants fail without creating authority.
5. Disabled or remotely exposed deployments cannot browse arbitrary host paths.
   Existing empty creation, authorized directory selection and SSH still work.
6. Run focused H2/unit tests, disposable MySQL 8.4 integration tests, Maven
   verification, TypeScript build/typecheck/bundle and browser checks at desktop
   and mobile widths. Record baseline and results in `.qwen/e2e-tests/`.

## Status and open questions

Implemented. Native macOS checks cover import from an empty registry, file
queries, model Read tools, active-root reuse, browser retry, and restart with
new imports disabled. Native Linux execution was not exercised locally.
Targeted Java/MySQL and TypeScript/browser checks are recorded separately from
the interrupted full Java suite in `.qwen/e2e-tests/`. No unresolved product
decisions remain. Ordinary creation receipts omit the unused import field so
they remain readable by previous Java versions.
