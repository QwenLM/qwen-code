# Daemon REST API Reference

This is the public REST/SSE interface for integrations that run
`qwen serve --no-web` and provide their own UI. Start with the
[integration guide](./rest-api-integration.md), then use this page for endpoint
discovery and the [HTTP protocol reference](./qwen-serve-protocol.md) for
detailed lifecycle semantics.

## OpenAPI

The curated 25-operation contract is available as
[OpenAPI 3.1 JSON](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/developers/daemon-rest-api.openapi.json).
Import that URL into an OpenAPI-compatible renderer, client generator, or
validation tool. The checked-in JSON is the portable interface contract for the
operations indexed below and is validated against the guide, protocol headings,
and registered routes in CI.

This index covers a curated core subset of the daemon's REST surface, not all
of it.
Outside it are the first-party Web Shell routes, conditional internal surfaces,
and other public but non-core routes: file mutation, workspace registration,
session organization and generation, and workspace MCP, skills, and providers
among them. Those surfaces are advertised by their own capability tags; the
[HTTP protocol reference](./qwen-serve-protocol.md) documents the session,
workspace-status, and file surfaces, and MCP server management, auth providers,
and device-flow sign-in are covered by the
[daemon auth and security notes](./daemon/12-auth-security.md). They are outside
this contract, not deprecated.

## Reading the index

- **Capability** is the feature tag to check in `GET /capabilities`. An
  em dash means the operation has no dedicated feature tag; clients that need
  to support older daemon builds should handle `404`.
- **Scope** says which runtime owns the operation. `process-global` reads
  daemon-wide state, `selected-runtime` uses the request's workspace selection,
  `persisted-workspace` resolves persisted session storage, `live-session-owner`
  routes by the live session, and `legacy-primary` always targets the daemon's
  primary workspace. `GET /session/:id/export` is primary-pinned: it resolves
  only managed internal runtimes before falling back to the primary workspace.
- All operations in this index are **stable** in the v1 REST contract. The
  deprecated `unstable_session_resume` capability name is only an alias; use
  `session_resume` for the stable resume route.

## Discovery

| Operation                                                        | Capability     | Scope            | TypeScript SDK              |
| ---------------------------------------------------------------- | -------------- | ---------------- | --------------------------- |
| [`GET /health`](./qwen-serve-protocol.md#get-health)             | `health`       | `process-global` | `DaemonClient.health`       |
| [`GET /capabilities`](./qwen-serve-protocol.md#get-capabilities) | `capabilities` | `process-global` | `DaemonClient.capabilities` |

## Session lifecycle

| Operation                                                                         | Capability          | Scope                | TypeScript SDK                       |
| --------------------------------------------------------------------------------- | ------------------- | -------------------- | ------------------------------------ |
| [`POST /session`](./qwen-serve-protocol.md#post-session)                          | `session_create`    | `selected-runtime`   | `DaemonClient.createOrAttachSession` |
| [`POST /session/:id/load`](./qwen-serve-protocol.md#post-sessionidload)           | `session_load`      | `selected-runtime`   | `DaemonClient.loadSession`           |
| [`POST /session/:id/resume`](./qwen-serve-protocol.md#post-sessionidresume)       | `session_resume`    | `selected-runtime`   | `DaemonClient.resumeSession`         |
| [`POST /session/:id/heartbeat`](./qwen-serve-protocol.md#post-sessionidheartbeat) | `client_heartbeat`  | `live-session-owner` | `DaemonClient.heartbeat`             |
| [`PATCH /session/:id/metadata`](./qwen-serve-protocol.md#patch-sessionidmetadata) | `session_metadata`  | `live-session-owner` | `DaemonClient.updateSessionMetadata` |
| [`POST /session/:id/model`](./qwen-serve-protocol.md#post-sessionidmodel)         | `session_set_model` | `live-session-owner` | `DaemonClient.setSessionModel`       |
| [`DELETE /session/:id`](./qwen-serve-protocol.md#delete-sessionid)                | `session_close`     | `live-session-owner` | `DaemonClient.closeSession`          |

## Prompts and events

| Operation                                                                                   | Capability           | Scope                 | TypeScript SDK                          |
| ------------------------------------------------------------------------------------------- | -------------------- | --------------------- | --------------------------------------- |
| [`GET /session/:id/status`](./qwen-serve-protocol.md#get-sessionidstatus)                   | `session_status`     | `live-session-owner`  | `DaemonClient.sessionStatus`            |
| [`POST /session/:id/prompt`](./qwen-serve-protocol.md#post-sessionidprompt)                 | `session_prompt`     | `live-session-owner`  | `DaemonClient.promptNonBlocking`        |
| [`POST /session/:id/cancel`](./qwen-serve-protocol.md#post-sessionidcancel)                 | `session_cancel`     | `live-session-owner`  | `DaemonClient.cancel`                   |
| [`GET /session/:id/events`](./qwen-serve-protocol.md#get-sessionidevents-sse)               | `session_events`     | `live-session-owner`  | `DaemonClient.subscribeEvents`          |
| [`GET /session/:id/transcript`](./qwen-serve-protocol.md#get-sessionidtranscript)           | `session_transcript` | `persisted-workspace` | `DaemonClient.getSessionTranscriptPage` |
| [`GET /session/:id/context`](./qwen-serve-protocol.md#get-sessionidcontext)                 | `session_context`    | `live-session-owner`  | `DaemonClient.sessionContext`           |
| [`GET /session/:id/export`](./qwen-serve-protocol.md#get-sessionidexport)                   | `session_export`     | `legacy-primary`      | `DaemonClient.exportSession`            |
| [`GET /session/:id/pending-prompts`](./qwen-serve-protocol.md#get-sessionidpending-prompts) | —                    | `live-session-owner`  | `DaemonClient.getPendingPrompts`        |

`POST /session/:id/prompt` returns `202` when the prompt enters the queue, not
when the Agent finishes. Subscribe first, then correlate `turn_complete` or
`turn_error` by `promptId`.

## Permissions

| Operation                                                                                               | Capability                | Scope                | TypeScript SDK                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------- | ----------------------------------------- |
| [`POST /session/:id/permission/:requestId`](./qwen-serve-protocol.md#post-sessionidpermissionrequestid) | `session_permission_vote` | `live-session-owner` | `DaemonClient.respondToSessionPermission` |
| [`POST /permission/:requestId`](./qwen-serve-protocol.md#post-permissionrequestid)                      | `permission_vote`         | `legacy-primary`     | `DaemonClient.respondToPermission`        |

New multi-workspace integrations should always use the session-scoped route.
The legacy route can return the same `404` for a request owned by another
runtime as it does for an already-resolved vote.

## Read-only workspace context

| Operation                                                             | Capability             | Scope            | TypeScript SDK                        |
| --------------------------------------------------------------------- | ---------------------- | ---------------- | ------------------------------------- |
| [`GET /workspace/tools`](./qwen-serve-protocol.md#get-workspacetools) | —                      | `legacy-primary` | `DaemonClient.workspaceTools`         |
| [`GET /file`](./qwen-serve-protocol.md#get-file)                      | `workspace_file_read`  | `legacy-primary` | `DaemonClient.readWorkspaceFile`      |
| [`GET /file/bytes`](./qwen-serve-protocol.md#get-filebytes)           | `workspace_file_bytes` | `legacy-primary` | `DaemonClient.readWorkspaceFileBytes` |
| [`GET /stat`](./qwen-serve-protocol.md#get-stat)                      | `workspace_file_read`  | `legacy-primary` | `DaemonClient.fileStat`               |
| [`GET /list`](./qwen-serve-protocol.md#get-list)                      | `workspace_file_read`  | `legacy-primary` | `DaemonClient.dirList`                |
| [`GET /glob`](./qwen-serve-protocol.md#get-glob)                      | `workspace_file_read`  | `legacy-primary` | `DaemonClient.glob`                   |

These singular routes target the primary workspace. Integrations that expose
multiple registered workspaces should use the workspace-qualified counterparts
documented in the full protocol and preflight `workspace_qualified_rest_core`.

## Common protocol rules

- Authenticate normal routes with `Authorization: Bearer <token>`. A default
  loopback `/health` probe may be exempt; non-loopback binds are not.
- Send `X-Qwen-Client-Id` when a create/load response supplied one. It is an
  attachment and attribution identifier, not an end-user security principal.
- Treat error bodies as additive. Branch primarily on HTTP status and the
  stable `code` or `errorKind` when present.
- Preserve SSE response headers and disable proxy buffering. Resume with both
  `Last-Event-ID` and `X-Qwen-Event-Epoch` when the daemon supplied an epoch.
- A workspace trust boundary is not tenant isolation. Run separate daemons when
  security principals or process-level failure boundaries must be independent.
