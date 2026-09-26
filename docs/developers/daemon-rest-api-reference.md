# Daemon REST API Reference

This is the public REST/SSE interface for integrations that run
`qwen serve --no-web` and provide their own UI. Start with the
[integration guide](./rest-api-integration.md), then use this page for endpoint
discovery and the [HTTP protocol reference](./qwen-serve-protocol.md) for
detailed lifecycle semantics.

## OpenAPI

The curated 26-operation contract is available as
[OpenAPI 3.1 JSON](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/developers/daemon-rest-api.openapi.json).
Import that URL into an OpenAPI-compatible renderer, client generator, or
validation tool. The checked-in JSON is the portable interface contract for the
operations indexed below and is validated against the guide, protocol headings,
and registered routes in CI.

This index covers a curated core subset of the daemon's REST surface, not all
of it.
Outside it are the first-party Web Shell routes, conditional internal surfaces,
and other public but non-core routes: file mutation, workspace registration,
session organization and session generation, and workspace MCP, skills, and providers
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

Creation with `startupConfig: { modelServiceId, reasoningEffort? }` additionally requires `session_startup_config`. Only the model is required; omission of reasoning does not set a default. Successful preparation returns `modelApplied: true` and `startupConfigApplied`; malformed input returns `400 invalid_startup_config`, while rejected selection returns `422 startup_config_rejected`. See the [startup negotiation contract](./qwen-serve-protocol.md#capabilities) for ordinary and standalone behavior.

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

| Operation                                                                     | Capability             | Scope            | TypeScript SDK                          |
| ----------------------------------------------------------------------------- | ---------------------- | ---------------- | --------------------------------------- |
| [`GET /workspace/tools`](./qwen-serve-protocol.md#get-workspacetools)         | —                      | `legacy-primary` | `DaemonClient.workspaceTools`           |
| [`POST /workspace/generate`](./qwen-serve-protocol.md#post-workspacegenerate) | `workspace_generation` | `legacy-primary` | `DaemonClient.generateWorkspaceContent` |
| [`GET /file`](./qwen-serve-protocol.md#get-file)                              | `workspace_file_read`  | `legacy-primary` | `DaemonClient.readWorkspaceFile`        |
| [`GET /file/bytes`](./qwen-serve-protocol.md#get-filebytes)                   | `workspace_file_bytes` | `legacy-primary` | `DaemonClient.readWorkspaceFileBytes`   |
| [`GET /stat`](./qwen-serve-protocol.md#get-stat)                              | `workspace_file_read`  | `legacy-primary` | `DaemonClient.fileStat`                 |
| [`GET /list`](./qwen-serve-protocol.md#get-list)                              | `workspace_file_read`  | `legacy-primary` | `DaemonClient.dirList`                  |
| [`GET /glob`](./qwen-serve-protocol.md#get-glob)                              | `workspace_file_read`  | `legacy-primary` | `DaemonClient.glob`                     |

These singular routes target the primary workspace. Integrations that expose
multiple registered workspaces should use the workspace-qualified counterparts
documented in the full protocol and preflight `workspace_qualified_rest_core`.

## Additional documented APIs

The 25 operations above are the stable OpenAPI integration contract. The
following operations complete the index of HTTP routes with dedicated protocol
sections. They are documented v1 surfaces, but they are outside that compact
OpenAPI contract because they are conditional, administrative, or primarily
support first-party clients. Preflight every listed capability and treat a
missing capability as an unavailable route. A grouped row can contain several
operations when they share ownership and an SDK family.

| Area                           | Operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Capability and scope                                                                                                                                                                                                           | TypeScript SDK                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator state                 | [`GET /daemon/status`](./qwen-serve-protocol.md#get-daemonstatus) · [`GET /brand`](./qwen-serve-protocol.md#get-brand) · [`GET /daemon/update`](./qwen-serve-protocol.md#get-daemonupdate-post-daemonupdateprepare-and-post-daemonupdaterestart) · [`POST /daemon/update/prepare`](./qwen-serve-protocol.md#get-daemonupdate-post-daemonupdateprepare-and-post-daemonupdaterestart) · [`POST /daemon/update/restart`](./qwen-serve-protocol.md#get-daemonupdate-post-daemonupdateprepare-and-post-daemonupdaterestart)                                                                                                                                                                                                                                        | `daemon_status`, `web_shell_brand`, `daemon_update`; process-global                                                                                                                                                            | `DaemonClient.daemonStatus`, `DaemonClient.brand`, `DaemonClient.daemonUpdateStatus`, `DaemonClient.prepareDaemonUpdate`, `DaemonClient.restartDaemonForUpdate`                    |
| Workspace registration         | [`POST /workspaces`](./qwen-serve-protocol.md#post-workspaces) · [`PATCH /workspaces/:workspace`](./qwen-serve-protocol.md#patch-workspacesworkspace) · [`DELETE /workspaces/:workspace`](./qwen-serve-protocol.md#delete-workspacesworkspace) · [`GET /workspace-registrations`](./qwen-serve-protocol.md#get-workspace-registrations) · [`DELETE /workspace-registrations/:id`](./qwen-serve-protocol.md#delete-workspace-registrationsid)                                                                                                                                                                                                                                                                                                                  | `dynamic_workspace_registration`, `persistent_workspace_registration`, `workspace_display_name`, `workspace_runtime_removal`; process-global or selected-runtime                                                               | `DaemonClient.addWorkspace`, `DaemonClient.updateWorkspace`, `WorkspaceDaemonClient.remove`; registration-store routes use raw REST                                                |
| Workspace runtime status       | [`GET /workspace/mcp`](./qwen-serve-protocol.md#get-workspacemcp) · [`GET /workspace/skills`](./qwen-serve-protocol.md#get-workspaceskills) · [`GET /workspace/providers`](./qwen-serve-protocol.md#get-workspaceproviders) · [`GET /workspace/env`](./qwen-serve-protocol.md#get-workspaceenv) · [`GET /workspace/preflight`](./qwen-serve-protocol.md#get-workspacepreflight)                                                                                                                                                                                                                                                                                                                                                                               | `workspace_mcp`, `workspace_skills`, `workspace_providers`, `workspace_env`, `workspace_preflight`; legacy-primary                                                                                                             | `DaemonClient.workspaceMcp`, `workspaceSkills`, `workspaceProviders`, `workspaceEnv`, `workspacePreflight`                                                                         |
| File mutation                  | [`POST /file/write`](./qwen-serve-protocol.md#post-filewrite) · [`POST /file/edit`](./qwen-serve-protocol.md#post-fileedit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `workspace_file_write`; legacy-primary                                                                                                                                                                                         | `DaemonClient.writeWorkspaceFile`, `DaemonClient.editWorkspaceFile`                                                                                                                |
| Session inspection and tasks   | [`GET /session/:id/supported-commands`](./qwen-serve-protocol.md#get-sessionidsupported-commands) · [`GET /session/:id/tasks`](./qwen-serve-protocol.md#get-sessionidtasks) · [`POST /session/:id/tasks/:taskId/workflow-action`](./qwen-serve-protocol.md#post-sessionidtaskstaskidworkflow-action) · [`GET /session/:id/lsp`](./qwen-serve-protocol.md#get-sessionidlsp) · [`GET /session/:id/resources`](./qwen-serve-protocol.md#get-sessionidresources)                                                                                                                                                                                                                                                                                                  | `session_supported_commands`, `session_tasks`, `session_lsp`, `session_resources`; live-session-owner                                                                                                                          | `DaemonClient.sessionSupportedCommands`, `sessionTasks`, `sessionWorkflowTaskAction`, `sessionLspStatus`, `sessionResources`                                                       |
| Workspace-qualified history    | [`GET /workspaces/:workspace/session/:id/transcript`](./qwen-serve-protocol.md#get-workspacesworkspacesessionidtranscript) · [`GET /workspaces/:workspace/session/:id/export`](./qwen-serve-protocol.md#get-workspacesworkspacesessionidexport) · [`GET /workspaces/:workspace/session/:id/archive/export`](./qwen-serve-protocol.md#get-workspacesworkspacesessionidarchiveexport)                                                                                                                                                                                                                                                                                                                                                                           | `workspace_persisted_transcript`, `workspace_session_export`, `workspace_archived_session_export`; persisted-workspace                                                                                                         | `WorkspaceDaemonClient.getSessionTranscriptPage`, `exportSession`, `exportArchivedSession`                                                                                         |
| Worktree recovery              | [`POST /session/:id/worktree-reset`](./qwen-serve-protocol.md#post-sessionidworktree-reset)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `session_worktree_reset_v1`; live-session-owner                                                                                                                                                                                | `DaemonClient.resetWorktreeSession`                                                                                                                                                |
| Persisted session catalog      | [`POST /sessions/catalog`](./qwen-serve-protocol.md#post-sessionscatalog) · [`GET /workspace/:id/session-info`](./qwen-serve-protocol.md#get-workspaceidsession-info-and-get-workspacesworkspacesession-info) · [`GET /workspaces/:workspace/session-info`](./qwen-serve-protocol.md#get-workspaceidsession-info-and-get-workspacesworkspacesession-info) · [`GET /workspace/:id/sessions`](./qwen-serve-protocol.md#get-workspaceidsessions-and-get-workspacesworkspacesessions) · [`GET /workspaces/:workspace/sessions`](./qwen-serve-protocol.md#get-workspaceidsessions-and-get-workspacesworkspacesessions) · [`GET /workspaces/:workspace/sessions/live-state`](./qwen-serve-protocol.md#get-workspacesworkspacesessionslive-state)                    | `session_info`, `session_list`, `workspace_session_live_state`; persisted-workspace; `session_catalog_batch`; persisted-workspace per member                                                                                   | `DaemonClient.getStandaloneSession`, `listWorkspaceSessions`, `listSessionsCatalog`, `getWorkspaceSessionLiveState`                                                                |
| Session organization           | [`GET /workspace/:id/session-groups`](./qwen-serve-protocol.md#get-workspaceidsession-groups) · [`POST /workspace/:id/session-groups`](./qwen-serve-protocol.md#post-workspaceidsession-groups) · [`PATCH /workspace/:id/session-groups/:groupId`](./qwen-serve-protocol.md#patch-workspaceidsession-groupsgroupid) · [`DELETE /workspace/:id/session-groups/:groupId`](./qwen-serve-protocol.md#delete-workspaceidsession-groupsgroupid) · [`PATCH /session/:id/organization`](./qwen-serve-protocol.md#patch-sessionidorganization-and-patch-workspacesworkspacesessionidorganization) · [`PATCH /workspaces/:workspace/session/:id/organization`](./qwen-serve-protocol.md#patch-sessionidorganization-and-patch-workspacesworkspacesessionidorganization) | `session_organization`; legacy-primary or persisted-workspace                                                                                                                                                                  | `DaemonClient.listSessionGroups`, `createSessionGroup`, `updateSessionGroup`, `deleteSessionGroup`, `updateSessionOrganization`; `WorkspaceDaemonClient.updateSessionOrganization` |
| Bulk persisted-session changes | [`POST /sessions/delete`](./qwen-serve-protocol.md#post-sessionsdelete) · [`POST /sessions/archive`](./qwen-serve-protocol.md#post-sessionsarchive) · [`POST /sessions/unarchive`](./qwen-serve-protocol.md#post-sessionsunarchive)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `session_archive`; legacy-primary                                                                                                                                                                                              | `DaemonClient.deleteSessionsData`, `archiveSessionsData`, `unarchiveSessionsData`                                                                                                  |
| Optional session controls      | [`POST /session/:id/recap`](./qwen-serve-protocol.md#post-sessionidrecap) · [`POST /session/:id/approval-mode`](./qwen-serve-protocol.md#post-sessionidapproval-mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `session_recap`, `session_approval_mode_control`; live-session-owner                                                                                                                                                           | `DaemonClient.recapSession`, `DaemonClient.setSessionApprovalMode`                                                                                                                 |
| Stateless generation           | [`POST /session/:id/generate`](./qwen-serve-protocol.md#post-sessionidgenerate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `session_generation`, `session_generation_options`; live-session-owner                                                                                                                                                         | `DaemonClient.generateSessionContent`, `DaemonSessionClient.generateContent`                                                                                                       |
| Workspace configuration        | [`POST /workspace/tools/:name/enable`](./qwen-serve-protocol.md#post-workspacetoolsnameenable) · [`POST /workspace/skills/:name/enable`](./qwen-serve-protocol.md#post-workspaceskillsnameenable) · [`POST /workspace/skills/enable`](./qwen-serve-protocol.md#post-workspaceskillsenable) · [`POST /workspace/init`](./qwen-serve-protocol.md#post-workspaceinit) · [`POST /workspace/mcp/reload`](./qwen-serve-protocol.md#post-workspacemcpreload) · [`POST /workspace/mcp/:server/restart`](./qwen-serve-protocol.md#post-workspacemcpserverrestart) · [`POST /language`](./qwen-serve-protocol.md#post-language)                                                                                                                                         | `workspace_tool_toggle`, `workspace_skill_settings_toggle`, `workspace_skill_settings_batch_toggle`, `workspace_init`, `workspace_mcp_manage`, `workspace_mcp_restart`, `user_language_sync`; legacy-primary or process-global | `DaemonClient.setWorkspaceToolEnabled`, `setWorkspaceSkillEnabled`, `setWorkspaceSkillsEnabled`, `initWorkspace`, `reloadWorkspaceMcp`, `restartMcpServer`, `setUserLanguage`      |
| Device-flow authentication     | [`POST /workspace/auth/device-flow`](./qwen-serve-protocol.md#post-workspaceauthdevice-flow) · [`GET /workspace/auth/device-flow/:id`](./qwen-serve-protocol.md#get-workspaceauthdevice-flowid) · [`DELETE /workspace/auth/device-flow/:id`](./qwen-serve-protocol.md#delete-workspaceauthdevice-flowid) · [`GET /workspace/auth/status`](./qwen-serve-protocol.md#get-workspaceauthstatus)                                                                                                                                                                                                                                                                                                                                                                   | `auth_device_flow`; legacy-primary                                                                                                                                                                                             | `DaemonClient.startDeviceFlow`, `getDeviceFlow`, `cancelDeviceFlow`, `getAuthStatus`                                                                                               |

Routes without a dedicated protocol section are intentionally absent from this
index. They may be first-party Web Shell plumbing or conditional implementation
surfaces and are not promoted to an integration contract by omission.

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
