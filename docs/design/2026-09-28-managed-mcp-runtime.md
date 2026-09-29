# Managed MCP Runtime (H1)

[English](2026-09-28-managed-mcp-runtime.md) | [简体中文](2026-09-28-managed-mcp-runtime.zh-CN.md)

Status: implemented as a private profile; production enablement remains separate. This implements H1 of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), following H0c at `b32f261afd`. It includes the prerequisite wiring necessary for an actual Hosted call. The normative references are sections 4, 12–14 of the [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md) and section 5 of the [configuration design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-config-extensions.md).

## Problem and existing boundaries

H0c commits extension records but has no MCP producer. The private Hosted Workspace profile executes only file tools. Its Broker supports reserve-before-dispatch, status and cancellation, but its control transport cannot configure MCP or read a resource or prompt. Legacy MCP discovery also treats some failures as empty catalogs. Reusing that result would publish a failed discovery as a successful removal of capabilities.

MCP needs independent configuration and operation records, immutable catalog revisions, Runtime-owned connections and credentials, and an unknown outcome that cannot authorize another request. Resource reads and prompt gets return data; they must not masquerade as model tool results. MCP records do not belong to the five-kind Session task list.

## Scope

Add an explicit private Hosted MCP profile and its necessary Broker control path. Keep public production enablement separate. Support stdio, Streamable HTTP and SSE connections with tool, resource and prompt catalogs. SDK reverse transports require their original client lease and are refused where that lease cannot be represented; they must never become shared HTTP or stdio servers.

Definitions are deployment-owned Runtime inputs, selected by workspace, server ID and immutable revision. A Runtime-only manifest carries connection recipes and credentials; the Harness receives only display metadata and schemas. There is no ambient settings or OAuth discovery in the Harness. Updating a recipe requires a new definition revision. Installing a replacement never changes an admitted operation's definition, catalog or connection generation.

This change does not implement Hooks, Shell/Monitor background work, children, Channels, automation, a public MCP configuration editor, or automatic remote retries. It does not expand the existing ordinary file profile. Necessary control forwarding is narrow; unrelated generic Broker control verbs remain unsupported.

## Architecture and ownership

| Layer                  | Responsibility                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core Session authority | Commit closed `mcp_configuration` and `mcp_operation` records and referenced resources; rebuild their chains; issue scoped grants.                                                            |
| Hosted Harness         | Select the explicit MCP profile, commit intents before dispatch, consume the pinned catalog, and accept physical receipts before continuing inference.                                        |
| Java Session store     | Validate and materialize MCP domain revisions in the journal transaction without emitting task events. Serve a sanitized Session catalog.                                                     |
| Runtime Broker         | Resolve the saved Session and original Runtime, enforce Workspace ownership, and forward MCP controls with their original identities. Never use a primary/default Workspace fallback.         |
| Tool Runtime           | Load the workspace's allowed definitions, own transports, enforce Session admission and quotas, fix connection/catalog revisions, and retain invocation receipts for that Runtime generation. |

All new private worker routes are live-session-owner scoped. The Broker route is resolved from the authenticated Harness Session; it is not a caller-selected workspace route. New work requires the live installed context and grant. Lookup, cancellation and drain address the original owner; a missing generation is unknown, not permission to attach elsewhere.

Observing an already acquired owner rechecks its persisted identity and live generation without requiring permission for new work. New effects still pass Workspace authorization. After both Broker restart and access revocation, missing process-local ownership remains blocked rather than reopening admission.

## Records, catalogs and effects

Configuration and non-tool operations embed the H0 run block. Each configuration persists its immutable `runtimeSessionId` so reload, status and drain address the original owner. Only after the Broker confirms release are configurations marked released; the next attachment derives a fresh Runtime Session identity from the committed configuration history. Their revision chains have no task projection. Shared TypeScript/Java fixtures cover malformed shapes, immutable identities, legal successors and terminal results. Resource closure includes catalog, arguments and raw MCP response references.

A configuration intent fixes a server definition. Its receipt records the connection generation and independent tools/resources/prompts discovery states (`complete`, `partial`, `failed`, `stale`). An empty successful list is complete. Failed discovery cannot replace a previously valid list with an apparently authoritative empty list. Catalog updates affect only newly admitted calls.

A resource or prompt intent fixes its arguments and server/catalog/connection revision. The physical request is keyed by a stable operation ID, and its raw response is committed as a resource before settlement. Duplicate command content joins the same operation; conflicting reuse fails. Tool calls retain ordinary tool intent, permission/preflight and receipt semantics, including the original execution identity.

An effect has a committed intent before network send or process start. A resource/prompt intent that has not reached `dispatch_started` can resume its first dispatch with the original pins, or be cancelled locally with proof that it never started. Status queries do not turn that unsent intent into an unknown effect. Committed results replay without reconnecting to a Runtime. A failed reply after send is `outcome_unknown`; recovery queries the original identity. No reconnect path resends it. Cancellation of an unsent request is immediate. Cancellation after dispatch is deferred: the Runtime does not send the native cancellation notification, because SDK servers suppress subsequent replies and thereby destroy settlement evidence. The original response is still recorded; cancellation never proves that a remote effect did not run. A known late response can settle the original call. A lost Runtime leaves unresolved effects blocked.

List-change notifications received during discovery keep the affected category stale; a concurrent list response cannot erase the invalidation. Before each model request and new resource/prompt command, the Harness checks discovery. An unchanged catalog keeps its revision, including repeated failure of a category that has never produced a valid list; healthy categories keep their connection. A category recovering from failure publishes a changed catalog. A changed catalog or retired connection causes a new immutable configuration and connection generation to be installed; already admitted requests retain their original pins and are never resent. An unconfirmed or failed discovery ends the current turn with an error, without permanently blocking the Session; the next turn can refresh again. An unknown configuration or invocation still requires reconciliation of its original operation. The public catalog remains a committed snapshot, not a live Runtime health or availability check.

An idle Harness reload advances the durable revision of its existing configuration records before issuing grants for the new writer. Catalog and connection pins stay unchanged; the Runtime grant gate still rejects owner changes at the same revision. Explicit replacement commands can install an allowed newer definition after an initial configuration conclusively failed, without first requiring the failed definition to recover. An unresolved configuration blocks new revisions for that server with HTTP 503; retrying the same explicit configuration command remains allowed. Detach reconciles every unresolved configuration against its original operation, including older records superseded by previous writers, and releases ownership only after conclusive settlement and drain.

## Admission, credentials and cleanup

The Runtime permits only the requested workspace's configured definitions and the Session's installed server bindings. Configured credentials stay on the Runtime. Stdio command, arguments, environment keys and values must not contain NUL; invalid definitions are rejected before allocating a connection. Public catalog responses omit recipes, environment, headers, endpoints, process identifiers, grants and internal binding IDs. Errors use bounded stable codes rather than reflecting connection exceptions that might contain credentials.

Each Runtime instance permits at most 16 connections and 32 in-flight requests, including old connections awaiting drain. A replacement cannot temporarily exceed the limit. Hosted Session creation accepts 1–16 server pins and rejects larger sets before creating the Session. Previously saved Sessions with up to 32 pins retain their original definition and can still load and detach for cleanup. Replacement opens the new connection before retiring the old one. At exactly 16 live connections there is no replacement slot: a catalog change or explicit replacement fails with the quota error until detach/load closes the old connections and reacquires them. Deployments needing live catalog refresh must leave a free slot (at most 15 pinned servers when no older connections are draining). Runtime capacity can still be exhausted by existing connections; quota failures during prompt admission, configuration replacement or raw-operation initialization return HTTP 409 with `managed_mcp_connection_quota`, without admitting a model turn. A quota failure discovered after prompt admission remains a turn error. New admissions stop before release; active operations retain their original transport until settlement. Idle retired connections are closed, and busy retired connections close only after their original requests settle. Streamable HTTP DELETE is best effort with a one-second bound; release confirms local transport closure after all requests settle, not deletion of the remote server session. Local shutdown is bounded and an unproven drain must not acknowledge release. Runtime/Session release waits for these holds. A configuration that never reached dispatch can be cancelled with `not_started_proven`; close then finishes and releases the original Broker ownership, including an acquisition left incomplete by an earlier busy Workspace, without configuring MCP.

## Files and integration points

- `packages/core/src/managed-runtime`: MCP record/protocol definitions, authority integration and resource closure.
- `packages/cli/src/serve`: MCP Runtime service/routes, worker admission, Hosted orchestration and model catalog.
- `packages/sdk-java/runtime-broker` and `managed-agent-server`: scoped forwarding, record materialization, catalog contract and tests.
- `.qwen/e2e-tests/12827-h1.md`: baseline, deterministic protocol tests and fault evidence.

## Private profile usage

Set `QWEN_MANAGED_MCP_CONFIG` on the Runtime process to an absolute manifest path. The file is deployment-owned and is never sent through the Hosted API. For example (the digest is an illustrative deployment pin):

```json
{
  "version": 1,
  "servers": [
    {
      "tenantId": "tenant",
      "workspaceId": "workspace",
      "serverId": "demo",
      "serverRevision": 1,
      "definitionDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/mcp/server.mjs"],
      "env": { "MCP_TOKEN": "deployment-secret" }
    }
  ]
}
```

For `streamable-http` or `sse`, use `url` and optional `headers` instead of `command`, `args` and `env`. Definitions are loaded at Runtime startup; a changed recipe requires a new `serverRevision` and matching digest. Keep both revisions available when replacing a live binding. Optional `timeoutMs` is an integer from 1 to 600000 and defaults to 600000 for invocation responses. Connect/discovery retain their 25-second bound. Hosted tool observation lasts 630 seconds, queries the original execution through temporary UNKNOWN responses, and MCP polling explicitly opts into original-execution reconciliation with `GET /executions/:id?reconcile=true`; Java persists only a conclusive late Runtime result. V2 status reads without this opt-in remain passive, while v3 retains its existing automatic reconciliation. The optional query accepts `true` or `false` and does not change execution ownership or permit dispatch. Polling reuses the acquired owner; failed status queries re-establish only that original owner.

Create or load a private Hosted Session with its usual `managedSessionStore` fields plus `toolProfile: "hosted-workspace-mcp/1"` and `mcpServers: [{serverId, serverRevision, definitionDigest}]`. The Session retains these initial admission pins; replacements are committed separately. The first prompt or resource/prompt operation initializes the bindings before admitting the work. Hosted requests use the existing Harness protocol/boot and client identity headers.

- `POST /session/:id/mcp/configurations`: `{operationId, expectedRevision, server: {serverId, serverRevision, definitionDigest}}`; the UUID identifies one immutable configuration change, and `expectedRevision` compares the latest admitted configuration revision, including a failed attempt. The same definition with a newer configuration revision refreshes discovery through a new connection. Only initially allowed server IDs can be updated.
- `POST /session/:id/mcp/operations`: `{operationId, serverId, request}`; request is `{kind: "resource_read", uri}` or `{kind: "prompt_get", name, arguments}`. Reuse the original UUID only with the same content.
- `GET /session/:id/mcp/operations/:operationId` and `POST /session/:id/mcp/operations/:operationId/cancel` query or request cancellation of that original operation.
- `GET /session/:id/mcp-catalog` shows the private active catalog. The authenticated public `GET /v1/agents/sessions/{sessionId}/mcp-catalog` reads committed display metadata and schemas, selecting the latest published catalog even if a replacement is pending or failed. Released catalogs are stale. It does not configure or invoke MCP.

## Validation and acceptance

First attempt the baseline with the globally installed CLI. Use deterministic MCP servers and a fake model for local verification, so success proves that the model advertised and invoked the selected MCP capability. Exercise stdio and HTTP; separately verify resource blobs and complete prompt messages. Retain request counts and original operation IDs for lost replies and restart cases.

Required checks include Session/workspace isolation, credential omission, successful empty discovery versus failure, replacement during an in-flight call, duplicate and conflicting commands, cancellation followed by late success, quota rejection, original-owner lookup after lost ACK, and release with active work. Run focused tests from each package, Java contract tests, the repository build/typecheck and bundle, then review the full diff twice. Record unavailable gates honestly; catalog display or unit tests alone do not establish production migration.

## Open questions and limits

H1 deliberately permits only one attached MCP owner per tenant/storage lease. This excludes other Sessions in the same Workspace and also other Workspaces sharing that storage, even between turns. Detach releases the lease. Releasing it while a stdio server still has Workspace access would allow concurrent writers; separating connection lifetime from storage ownership is follow-up work before production enablement.

Physical connection loss with an unresolved request remains recovery-blocked. A lost connection or a server that never replies can consume the full 630-second Hosted observation window; a shorter Runtime timeout or cancellation does not shorten that window. Every pinned server must refresh successfully before the model request, so an unavailable server also blocks text-only turns and calls to healthy servers until it recovers. A tool that settles after the 630-second Hosted observation window, or after Harness restart during its turn, still needs checkpoint recovery that this private slice does not implement. Raw resource/prompt operations can accept a late result through their original status route or close. Runtime receipt history and closed connection tombstones remain generation-local and grow for the process lifetime; pruning with durable acknowledgement, as well as eliminating the pending-release waiter on a permanently lost request, remains follow-up work. Do not treat the concurrency quotas as a bound on history memory.

Model tool names intentionally include catalog and connection identity so old advertised calls cannot silently use a newer binding. A reloaded transcript can contain historical names. The stdio HOME/USERPROFILE directory is the Workspace; deployment definitions should explicitly set a separate HOME if a server writes caches there.

The record domains are globally recognized by the Session store, while execution remains gated by the explicit private profile and scoped Runtime definitions. Shared Broker acquire is intentionally idempotent for its existing owner and returns workspace generation plus Runtime binding/generation; ordinary file/Shell prepare calls keep the actual prompt and call identity.

The unreleased MCP migration is V21 to avoid the V19/V20 publication migrations on #12894. Deploy both migrations in increasing order; whichever branch lands later must recheck against main. If MCP V21 has already run before the publication migrations arrive, those pending migrations must be renumbered above the deployed version; do not enable out-of-order migration to bypass that check. The generic controls in #12868 require a semantic merge that preserves MCP original-owner recovery after revocation and drain-before-storage-release ordering.

Public configuration management and production AgentBundle capability publication remain separate deployments. Remote systems without query or idempotency support cannot recover an unknown effect automatically. The Runtime's generation-local receipts are not durable across physical Runtime loss; committed Session intents preserve the blocked outcome in that case. Quotas are per Runtime instance, not an aggregate across separate Runtime processes. The private profile uses the existing inline Session Store: each discovery list is limited to 16 KiB, with retained prefixes marked partial and no usable entries marked failed; raw operation responses are limited to 60 KiB and oversized responses settle with an output-limit error. SDK reverse clients, production profile advertisement, cross-process aggregate budgets and object-storage results are not enabled by this slice.
