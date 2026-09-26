# W0d: WebShell Workspace selection and fixed binding

[English](managed-workspace-w0d-web-shell-binding.md) | [简体中文](managed-workspace-w0d-web-shell-binding.zh-CN.md)

## Status and problem

W0b persists an authorized Workspace binding when a Session is created, but an authenticated embedded WebShell host cannot discover a Workspace or create an empty bound Session. The Java client also drops the binding on read and treats a Session without a Turn as running. W0d exposes metadata selection and fixed binding; message execution remains unavailable.

## Scope and decision

The host opts in with `enableWorkspaceBinding: true` and supplies a nonempty `productScope`. The host must change that scope when its tenant or actor changes. The provider includes the service URL, product scope, Agent ID, and feature version in its browser storage key. Credentials are never stored. A host that does not opt in keeps its existing message-first flow.

The new capability `workspaceBinding` means the service supports discovery, empty creation, and reading the fixed binding. `workspaceContext` remains `false` until the full execution path is ready. The client requires the narrow capability before enabling creation; it does not silently create an unbound Session when a legacy service lacks it.

## Discovery contract

The public routes are `GET /v1/agents/workspaces` and `GET /v1/agents/workspaces/{workspaceId}`. The WebShell BFF routes are `POST /api/agent/web-shell/v1/workspaces/query` and `/workspaces/get`. Both use the same service and Registry. Public fields use snake_case; BFF fields use camelCase. A list returns `data`, `hasMore`/`has_more`, `nextCursor`/`next_cursor`, `defaultWorkspace`/`default_workspace`, and the two capability flags. The default page size is 50 and the permitted range is 1–100.

Discovery requires the existing trusted `AuthenticatedTenantActor`; missing actor returns 401, scope mismatch returns 403. SQL filters readable grants before pagination and sorts by the exact Workspace ID bytes. A cursor binds a digest of tenant and actor, effective page size, and last ID; each page rechecks grants. Single-item lookup returns 404 for unreadable or absent IDs. The explicit tenant default is returned independently of the current page only when it is readable, creatable, and `ACTIVE`. Readable entries with no create grant or a nonactive state remain visible but disabled. Create admission rechecks authorization and state inside its existing transaction.

The responses expose only logical ID, display name, state, and create eligibility, and set `Cache-Control: no-store`. Discovery does not resolve physical storage, touch the filesystem, or start a Runtime. Existing Registry, access, default, and create receipt tables suffice; no migration is needed.

## Create and display flow

The new form starts at relative directory `.`. It preserves a still-valid selection on refresh; otherwise it uses the explicit server default. It never selects the first listed item implicitly. A selected or default item outside the current page is included once, and “Load more” fetches later pages. Switching Workspace after editing a nonroot directory requires confirmation and resets that directory to `.`. The raw directory is submitted without trimming or URL decoding; the server applies the existing W0a normalization and validation. The form explains that Sessions in one Workspace share files and directory availability is checked before execution.

Creation uses the existing BFF Session create command with `input: []` and an explicit `workspace`. An empty Session response needs a `sessionId` but no `turnId`; the message-first create and submit commands still need `turnId`. On success the client reads the Session and checks that the saved Workspace ID matches the requested one. The displayed Workspace ID and normalized relative directory always come from the saved Session. A missing or mismatched binding is a protocol error; the known Session ID remains available for another read. Bound Sessions have a static `created` phase and disabled send/cancel controls. They never show a Turn timer or environment preparation claim.

## Retry and identity isolation

Immediately before sending, the client stores a frozen request in `sessionStorage`: Agent ID, Workspace ID, raw relative directory, empty input, client ID, and idempotency key. Creation does not start if that first write fails. A lost response is retried with that exact request. Once a Session ID is returned, the client saves it and subsequent retries read the Session only. A first definitive 4xx restores editing; after any uncertain outcome a later 4xx cannot prove the original request never committed. The user can explicitly abandon local confirmation, with a warning that the empty server Session may still exist. No automatic server deletion occurs.

Changing tenant, actor, or Agent changes the host scope or provider storage key, remounts the form, cancels its requests, and ignores late responses. The old selected Session ID is cleared before the new provider can request it; a newly supplied Session ID can still be opened. Credential refresh within the same identity retains the pending request. Ordinary unsubmitted drafts and recent directories are not persisted.

## Validation and boundaries

HTTP and SQL tests cover authorization, pagination before filtering, page-independent default, exact ID matching, no physical-path leakage, and empty creation. WebShell tests cover idle state, capability gating, frozen retries, and read-only retry after admission. Browser acceptance must cover desktop and mobile layouts and a real Spring/SQL route with a principal adapter confined to test code. The full execution path needs Hosted tool orchestration, approval/history settlement, product identity propagation, and W0e restart, reclamation, and old-writer isolation checks. W0d does not claim those capabilities.

Acceptance is a user selecting an authorized Workspace and relative directory, creating exactly one empty Session despite a lost response, and seeing the server's fixed binding without any running or execution controls.
