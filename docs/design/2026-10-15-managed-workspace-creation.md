# Create empty Managed Workspaces from WebShell

[中文](2026-10-15-managed-workspace-creation.zh-CN.md)

## Problem and current behavior

Managed mode uses the normal WebShell composer and sidebar, but its Workspace picker only lists administrator-registered Workspaces. The Java server exposes discovery and session creation; its runtime, storage guard, and initial Turn admission retain static mount mappings loaded at startup. Adding a browser button alone would not create an executable Workspace.

## Scope

An authenticated tenant actor can create an empty Workspace by entering its display name, select it, and start a Managed task immediately. The operator opts in with `qwen.managed-agent.runtime-broker.workspace-creation-root`, an existing canonical directory on the verified Linux local-process host. Creation requires the enabled durable, Session-isolated Broker, verified Workspace recovery, Harness Workspace files, and Session Store. The default is disabled.

Importing existing host paths, Git cloning, upload, quota management, Workspace deletion, shared Workspace administration, and repair of existing Session writer recovery are outside this change. The browser never chooses a filesystem path, storage ID, policy, or principal. Local mode keeps its existing Workspace behavior.

## Creation protocol and authority

The WebShell API adds `POST /api/agent/web-shell/v1/workspaces/create` with `displayName` and `idempotencyKey`. Query capabilities advertise `workspaceCreation` only when enabled. A successful response has the existing Workspace summary shape. Names are trimmed and limited to 1–128 characters, without control characters. Actor and tenant come from the authenticated request context.

Creation uses the existing request receipt table with a new `WORKSPACE_CREATE` namespace and actor scope. The request digest covers the normalized name. Reusing a key with different content returns conflict. The receipt freezes the generated Workspace ID, storage ID, registration operation UUID, and name before filesystem changes. Its lifecycle is PENDING to COMPLETED; Workspace lifecycle values retain their current meanings.

The server derives an independent path under `creationRoot / hash(tenant) / receiptKey` from verified receipt identities. It creates only its owned directories, checks canonical ancestry, and registers the physical directory using the existing native storage guard outside any enclosing SQL transaction. The final SQL transaction inserts an ACTIVE ROOT Workspace, generation 1, the existing Workspace execution config/policy, an OWNER grant for the creator, and completes the receipt atomically. The new Workspace does not replace a tenant's default.

Retries resume the same PENDING receipt, directory, and registration operation. COMPLETED replay checks the current Workspace and actor access, without recreating a removed row, restoring a revoked grant, reactivating a drained Workspace, or registering storage again. If concurrent registration loses a race to a completed creation, read back that receipt and current authorization before returning success. Failed preparations remain resumable; no automatic destructive directory cleanup is added.

Schema V4 adds the receipt namespace after the published V3 Session-list index migration. V1, V2 and V3 resources and applied history remain unchanged; initialization and Flyway admission recognize each canonical published version before applying later migrations.

## Runtime integration

A shared creation-root resolver validates the configured parent against static mounts and private runtime state, and validates exact receipt namespace, tenant, storage ID, Workspace ID, result shape, and status. Pending roots are available only to the creation registration path. Runtime resolution, storage verification, and initial Turn admission require a COMPLETED receipt. Native physical identity and marker verification remain authoritative; a recognizable storage prefix alone grants nothing.

The storage guard, runtime resolver, and Managed session store consult this resolver for dynamically created storage while retaining static mount support. Low-level lookup does not require the Workspace still be ACTIVE: existing Sessions must remain closable after draining or removal. Registry admission continues to enforce ACTIVE state and current permissions for new work. Restart reconstructs mappings from SQL and the configured root; in-memory registration is not persistence.

## Browser integration

The shared Workspace picker exposes a create action when the provider advertises creation. A scoped shared dialog asks for a name, shows progress and errors, and selects the returned Workspace without losing the current prompt or model. The client freezes and persists the pending creation key and name before sending; an uncertain response offers retry of that same operation. Closing the dialog does not issue a second create. Refresh can resume a pending operation. Unsupported or disabled providers retain discovery only.

## Affected areas

| Area                      | Change                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime Broker schema     | Receipt namespace migration, fresh baseline and upgrade validation                       |
| Java control plane        | Configuration, controlled roots, creation receipt/store, API and runtime admission       |
| OpenAPI and Java provider | Capability, request/response types and create method                                     |
| WebShell                  | Existing picker action, creation dialog, pending request persistence and translations    |
| Tests and docs            | Focused protocol/security tests, browser plan, configuration and experience instructions |

## Acceptance criteria

1. Disabled deployments do not advertise or accept creation; supported deployments create an independent registered directory with creator access.
2. Same-key retries and concurrent requests produce one Workspace; mismatched requests conflict. Recovery after filesystem registration reuses the same physical identity.
3. Actor/tenant isolation, canonical path containment, marker/identity validation, and private runtime-state separation hold.
4. The page creates and selects a Workspace, preserves its draft, runs a real file tool there, and finds it after refresh and Java restart; a new Session can reuse its original files.
5. Existing static Workspaces, Local mode, Session creation, cancellation, and close remain functional. No secrets or host paths appear in API responses.
6. Fresh schema and existing V1/V2/V3 catalogs upgrade without changing historical migration checksums or deleting data.

## Observed recovery limitation

Before integration with current main, the demo based on `4b6b4270` plus these local features showed an existing idle Harness Session remaining on an expired writer lease when a graceful control-plane shutdown outlasted that lease. This physical restart scenario has not been rerun on the integrated PR head; whether that head still exhibits it remains unverified. Its next prompt stays ACCEPTED while authorization retries. In that demo, the resident-Session load and writer-renewal paths did not reacquire that authority. Workspace directory, marker and SQL identity remain intact. Record old-Session continuation as failed separately from Workspace persistence and new-Session reuse; this feature does not relax lease fencing or repair that existing recovery path.

## Open questions

None for the selected empty-Workspace scope. Operator quotas and storage reclamation require separate product decisions.
