# Managed Agent personal memory

[English](2026-11-07-managed-user-memory.md) | [简体中文](2026-11-07-managed-user-memory.zh-CN.md)

## Status and problem

Implementation design, 2026-11-07. Hosted Harness deliberately disables ambient
local memory. Existing Mem0 integrations provide useful HTTP and tool semantics,
but local configuration and working-directory checks are not tenant authorization.
Managed needs durable, explicitly selected personal memory across Sessions.

## Behavior and ownership

Each authenticated `(tenantId, actorId)` owns one personal MemoryStore. Creating
the Store is idempotent. Session creation accepts an optional `memory_store_id`
(`memoryStoreId` in WebShell). Omission disables memory entirely. A supplied Store
must belong to the creator; its immutable binding participates in the creation
digest and transaction. Recovery uses the persisted binding. The same owner may
select the Store in multiple authorized Workspaces.

Bound Sessions are owner-only in addition to existing Workspace authorization.
Lists, details, SSE, transcripts, artifacts, tools and mutations enforce this on
the server. Children receiving private context inherit owner-only visibility but
not memory access. Relaying private context into shared Sessions is forbidden.
Workspace files retain their existing sharing permissions. Disabling memory does
not disable Session history. Forgetting affects future retrieval, not previously
recorded history or prepared model requests.

## Interfaces and persistence

`POST /v1/agents/memory-stores` creates or returns the current user's Store;
`GET /v1/agents/memory-stores` returns that user's Stores (zero or one). Neither
accepts tenant or owner selectors. Public and WebShell creation carry the optional
binding. OpenAPI, SurfaceRegistry and generated WebShell types change together.

SQL stores Store ownership and its opaque Holo namespace, entry IDs and deletion
markers, Session bindings and owner-only visibility. Holo owns memory bodies.
The existing request receipt table gains a memory namespace: Session, accepted
input and tool call identify an operation, and its request digest rejects
conflicting retries. Receipt results also retain bounded recall context for
recovery. Until the first formal release the shared V1 schema baseline is edited
in place and development catalogs are recreated.

Persistence facades retain their public entry points and transaction annotations.
Access checks, model catalog validation, readable schedule queries, message-route
checks and CSI identity-field metadata use small same-package helpers to satisfy
the existing class-size ratchet. Pinned ceilings decrease; lock and transaction
boundaries stay at their existing entry points.

## Execution and recovery

Hosted calls a controlled Memory Service through the internal Session Store
channel using writer credentials. Authorization, writer-generation validation
and receipt admission are one short transaction. Holo HTTP calls run outside
transactions and Session locks. A deployment-configured, dedicated Holo service
has cross-service sharing disabled. Its endpoint and API key never reach the
model, sandbox or MCP configuration. Managed injects the Store's opaque `user_id`;
provider filters are not an authorization boundary.

Deployment uses `qwen.managed-agent.memory.enabled` (default `false`),
`qwen.managed-agent.memory.endpoint` and `qwen.managed-agent.memory.api-key`.
Enablement requires Session Store and the Harness capability `session-memory/1`.
Memory-only tool batches do not acquire a Runtime Broker binding. Their durable
approval continuation has `runtime:null`, accepted only for the four memory
tools without command-step or child-model execution; mixed batches retain the
existing runtime requirements.

Each fresh real user input, including queued inputs, triggers recall from the
original submitted text. Existing query sanitization is retained. Before the
query is truncated, the shared secret scanner and checks for Basic credentials,
password-bearing URIs and credential flags suppress recall when sensitive text
remains; the empty query never reaches the provider. Recall uses a
512-character query, at most five results, 4,000 characters of injected context
and a five-second provider deadline. Results are untrusted reference material.
Recovery reuses the accepted input's saved result; tool output and background
continuations do not cause recall. Provider unavailability does not fail the
main task. Authorization and fencing failures refuse the operation.

Bound Sessions expose `context_search`, `context_remember`, `context_get` and
`context_forget`. Their arguments contain no identity, namespace or endpoint.
Only an explicit user request permits remembering or forgetting, subject to
existing tool approval and Plan Mode. Remember uses `infer:false` and exact
requested content. Forget verifies the entry's SQL ownership, authoritative Holo
scope and complete expected content before deletion. Successful deletion records
a marker that suppresses stale search hits. No update or bulk deletion API is
introduced.

Success is durable before returning the tool result. An already dispatched write
whose outcome is lost becomes `unknown`, never an automatic retry or a claimed
success. A newer writer can replay an admitted result; a stale writer cannot
admit new work or publish Session output. The adapter uses the existing Mem0
protocol semantics without introducing a generic provider framework.

## Validation and delivery

Cover no-binding zero requests/tools; explicit save and cross-Session recall;
two tenants and two users including forged Store and entry IDs; same-user
cross-Workspace access; owner-only lists, SSE, artifacts, mutations, children and
relay; approval and Plan Mode; queued inputs and recovery; response loss, restart,
writer replacement and conflicting retries; changed-content deletion and stale
search suppression. Real Holo conformance must prove synchronous entry IDs,
exact-read scope and deletion using isolated disposable namespaces with cleanup.
Historical single-user results do not establish these guarantees.

Run affected Java contracts, MySQL and real Hosted recovery cases within the
module's shared local verification budget; full gates remain in CI. Run root
TypeScript build/typecheck and focused consumer tests. Record unavailable real
paths explicitly. Enablement defaults off until provider and isolation gates
pass. Delivery includes parameter forwarding and existing tool presentation,
not a separate memory-management UI.

## Boundaries

No team sharing, automatic extraction, Dream, directory mounts, memory versioning
or implicit child binding. No open product decisions remain. Deployment-specific
Holo conformance and unavailable test infrastructure are acceptance gates, not
permission to weaken isolation or silently fall back to local memory.
