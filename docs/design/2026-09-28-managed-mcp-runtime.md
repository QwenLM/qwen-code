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

An effect has a committed intent before network send or process start. A resource/prompt intent that has not reached `dispatch_started` can resume its first dispatch with the original pins, or be cancelled locally with proof that it never started. Status queries do not turn that unsent intent into an unknown effect. Committed results replay without reconnecting to a Runtime. A failed reply after send is `outcome_unknown`; recovery queries the original identity. No reconnect path resends it. Cancellation still addresses an unresolved request after timeout, but does not prove that a remote effect was cancelled. A known late response can settle the original call. A lost Runtime leaves unresolved effects blocked.

List-change notifications received during discovery keep the affected category stale; a concurrent list response cannot erase the invalidation. The public catalog remains a committed snapshot, not a live Runtime health or availability check.

## Admission, credentials and cleanup

The Runtime permits only the requested workspace's configured definitions and the Session's installed server bindings. Configured credentials stay on the Runtime. Public catalog responses omit recipes, environment, headers, endpoints, process identifiers, grants and internal binding IDs. Errors use bounded stable codes rather than reflecting connection exceptions that might contain credentials.

Each Runtime instance permits at most 16 connections and 32 in-flight requests, including old connections awaiting drain. A replacement cannot temporarily exceed the limit. New admissions stop before release; active operations retain their original transport until settlement. Streamable HTTP termination and stdio shutdown are bounded, and an unproven drain must not acknowledge release. Runtime/Session release waits for these holds.

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

For `streamable-http` or `sse`, use `url` and optional `headers` instead of `command`, `args` and `env`. Definitions are loaded at Runtime startup; a changed recipe requires a new `serverRevision` and matching digest. Keep both revisions available when replacing a live binding.

Create or load a private Hosted Session with its usual `managedSessionStore` fields plus `toolProfile: "hosted-workspace-mcp/1"` and `mcpServers: [{serverId, serverRevision, definitionDigest}]`. The Session retains these initial admission pins; replacements are committed separately. The first prompt or resource/prompt operation initializes the bindings before admitting the work. Hosted requests use the existing Harness protocol/boot and client identity headers.

- `POST /session/:id/mcp/configurations`: `{operationId, expectedRevision, server: {serverId, serverRevision, definitionDigest}}`; the UUID identifies one immutable configuration change, and `expectedRevision` compares the latest admitted configuration revision, including a failed attempt. The same definition with a newer configuration revision refreshes discovery through a new connection. Only initially allowed server IDs can be updated.
- `POST /session/:id/mcp/operations`: `{operationId, serverId, request}`; request is `{kind: "resource_read", uri}` or `{kind: "prompt_get", name, arguments}`. Reuse the original UUID only with the same content.
- `GET /session/:id/mcp/operations/:operationId` and `POST /session/:id/mcp/operations/:operationId/cancel` query or request cancellation of that original operation.
- `GET /session/:id/mcp-catalog` shows the private active catalog. The authenticated public `GET /v1/agents/sessions/{sessionId}/mcp-catalog` reads committed display metadata and schemas, selecting the latest published catalog even if a replacement is pending or failed. Released catalogs are stale. It does not configure or invoke MCP.

## Validation and acceptance

First attempt the baseline with the globally installed CLI. Use deterministic MCP servers and a fake model for local verification, so success proves that the model advertised and invoked the selected MCP capability. Exercise stdio and HTTP; separately verify resource blobs and complete prompt messages. Retain request counts and original operation IDs for lost replies and restart cases.

Required checks include Session/workspace isolation, credential omission, successful empty discovery versus failure, replacement during an in-flight call, duplicate and conflicting commands, cancellation followed by late success, quota rejection, original-owner lookup after lost ACK, and release with active work. Run focused tests from each package, Java contract tests, the repository build/typecheck and bundle, then review the full diff twice. Record unavailable gates honestly; catalog display or unit tests alone do not establish production migration.

## Open questions and limits

Public configuration management and production AgentBundle capability publication remain separate deployments. Remote systems without query or idempotency support cannot recover an unknown effect automatically. The Runtime's generation-local receipts are not durable across physical Runtime loss; committed Session intents preserve the blocked outcome in that case. Quotas are per Runtime instance, not an aggregate across separate Runtime processes. The private profile uses the existing inline Session Store: each discovery list is limited to 16 KiB, with retained prefixes marked partial and no usable entries marked failed; raw operation responses are limited to 60 KiB and oversized responses settle with an output-limit error. SDK reverse clients, production profile advertisement, cross-process aggregate budgets and object-storage results are not enabled by this slice.
