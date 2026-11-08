# Multi-workspace session organization mutations

## Summary

Add `PATCH /workspaces/:workspace/session/:id/organization` as a
workspace-qualified session organization mutation.

The route applies pin, group, and color changes to the session organization
store owned by the selected workspace. It extends the existing plural REST
surface without changing capabilities, request or response schemas, ACP, or UI
behavior.

## Problem

Workspace-qualified session reads already target the selected workspace.
`GET /workspaces/:workspace/sessions` can return persisted, archived, and live
sessions from a trusted non-primary runtime and can apply organized views and
group filters against that runtime's organization store.

The only organization mutation today is
`PATCH /session/:id/organization`. That legacy route is primary-workspace-only.
Consequently, a client can read organization state for a secondary workspace
but cannot update it through the matching workspace-qualified REST surface.

## Decision

Register `PATCH /workspaces/:workspace/session/:id/organization` beside the
other workspace-qualified session storage routes.

The `:workspace` selector resolves exactly like the existing plural routes:

1. Match an exact registered workspace id.
2. Otherwise decode and canonicalize an absolute cwd selector.
3. Return the existing unknown-workspace error if neither resolves.

The selected runtime is the complete scope of the operation. Session lookup,
group validation, organization mutation, and persistence all use that
runtime's workspace cwd and stores. The handler never falls back to the primary
runtime or searches another registered workspace.

## Data flow

1. The request passes the daemon's normal host, bearer, and JSON middleware.
2. The plural route resolves `:workspace` to one registered runtime.
3. The plural mutation trust gate requires that runtime to be trusted.
4. The target runtime checks for `:id` in its active persisted store, archived
   persisted store, or live bridge.
5. The request body passes the existing organization request validation.
6. If `groupId` is present and non-null, the target runtime's group store
   validates that group.
7. The target runtime's organization store applies `isPinned`, `groupId`, and
   `color` with the existing semantics.
8. The route returns the same organization response as the legacy mutation.

Persisted active sessions, persisted archived sessions, and matching live-only
sessions are valid targets. Organization remains sidecar state: the mutation
does not rewrite transcript JSONL or change transcript modification time.

## Trust and error order

Plural route conventions determine the observable order:

1. An unknown workspace selector returns the existing
   `400 { code: "workspace_mismatch" }` response.
2. A known but untrusted workspace returns
   `403 { code: "untrusted_workspace" }` before session or group existence is
   disclosed.
3. A session absent from the selected runtime's active, archived, and live
   sets returns the existing session-not-found `404`.
4. Invalid organization update fields return the existing organization
   validation error after the trusted target session has been found.
5. A non-null group id absent from the selected runtime's group store returns
   `404 { code: "group_not_found" }`.
6. An unreadable organization sidecar returns
   `500 { code: "session_organization_store_unreadable" }`.

Archive and delete conflicts retain the existing archive coordinator errors.

There is no cross-workspace fallback at any error stage. A session or group
that exists only in the primary workspace remains unknown when a secondary
workspace is selected, and vice versa.

## Legacy compatibility

`PATCH /session/:id/organization` retains its current primary-only behavior,
including its mutation gate, validation, lookup, persistence, error shapes,
and response schema. Existing clients therefore keep the same routing and
duplicate-id behavior.

Clients use the plural mutation only after both `session_organization` and
`workspace_qualified_rest_core` are advertised. No new capability tag is
introduced.

## ACP behavior

ACP dispatch does not change. The qualified dispatcher already operates on
`rt.bridge` and `rt.workspaceCwd`, so workspace-qualified ACP session actions
are already bound to the selected runtime. This change is limited to the REST
organization mutation that was missing from the plural surface.

## Concurrency and store locks

`SessionOrganizationService` uses its existing per-sidecar lock only to
serialize group and session-organization read-modify-write operations against
that same sidecar. The existing archive coordinator coordinates organization
updates with archive and delete transitions. This route adds no daemon-wide
lock and no new cross-service transaction or atomicity guarantee.

## Testing and acceptance

The automated tests and real E2E acceptance strategy together cover:

- Workspace id and URL-encoded canonical cwd selectors reach the same runtime.
- A trusted secondary workspace can mutate organization for active persisted,
  archived persisted, and live-only sessions.
- Pinning, grouping, ungrouping, and supported color or `null` updates return
  the existing response shape.
- Organized lists and pinned/group filters reflect the mutation.
- Organization state survives daemon restart for persisted sessions.
- A secondary mutation does not modify the primary workspace's organization
  state.
- The legacy route remains primary-only and returns `404` for a session that
  exists only in a secondary workspace.
- Known untrusted workspaces return `403` before session or group lookup.
- Unknown selectors, unknown target-scoped sessions, and unknown target-scoped
  groups return their existing errors without cross-workspace fallback.

Acceptance also includes build, typecheck, focused route and SDK tests, and an
E2E pass covering two trusted workspaces plus negative trust and selector
cases.

## Explicit non-goals

This change introduces no capability tag or capability payload change, no
request or response schema change, no ACP behavior change, and no UI change.
It does not make the legacy route multi-workspace-aware, add cross-workspace
session discovery, or change archive, list, group, or transcript semantics.
