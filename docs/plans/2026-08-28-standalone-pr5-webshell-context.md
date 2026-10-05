# Standalone PR5 WebShell Session Context Plan

## Goal

Make the daemon React provider represent and switch workspace, standalone, and Live sessions explicitly while keeping current WebShell entry points unchanged. The implementation starts from `main`, where WebShell consumes the provider through `@qwen-code/webui/daemon-react-sdk`. It does not copy the in-flight WebShell cutover; a later rename can carry the provider changes unchanged.

## Product Context Contract

```ts
type DaemonProductSessionContext =
  | { kind: 'workspace'; cwd: string }
  | { kind: 'standalone' }
  | { kind: 'live' };
```

`sessionContext` is the product and routing authority. `connection.context` remains the existing model context-window snapshot. `connection.workspaceCwd` is set only for a product workspace; the internal Conversations runtime cwd is never exposed as a project.

Legacy callers may continue supplying `workspaceCwd`. The provider converts it once to a workspace context. An explicit workspace context must match a simultaneously supplied legacy cwd after path normalization. Standalone and Live contexts reject a supplied legacy cwd. If neither value is supplied, existing primary-workspace behavior is preserved.

## Restore and Create Dispatch

| Product context | Create                                 | Load and resume                                                    | Ownership proof                                                          |
| --------------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Workspace       | Existing generic create with exact cwd | Existing generic load/resume with exact cwd                        | Exact ordinary runtime selected by the caller/provider                   |
| Standalone      | `DaemonSessionClient.createStandalone` | `loadStandalone` / `resumeStandalone`                              | SDK runtime validation of the dedicated standalone response              |
| Live            | Not created by this provider           | Generic load/resume against the one trusted `kind: 'live'` runtime | Capability runtime identity plus daemon-side persisted-source validation |

An explicit context never falls back to the primary workspace. A missing standalone capability, a missing/untrusted/ambiguous Live runtime, or a context/cwd conflict fails before a session request is sent.

## Switching Semantics

The provider retains the post-#9129 loading-skeleton model:

1. Capture a new transition generation and publish the target session id and context.
2. Detach the previous client, clear the old transcript, and show the target loading state.
3. Commit the restored client, replay, standalone working-directory state, and warnings only if the transition is still current.
4. On failure, keep the target id/context visible with the structured error. Do not restore the previous conversation.
5. Detach a stale successful client and discard its replay, warnings, and recovery state.

Reload, reconnect, live-journal repair, and invalid-client reattachment reuse the stored context. They never reconstruct context from an absent cwd.

## Standalone State

Successful standalone create/load stores the SDK-provided `projectlessOutputDirectory` and `workingDirectory` under a standalone-specific connection field. A `recreated` warning belongs only to that target and is discarded if another transition supersedes it.

`DaemonStandaloneCreationOutcomeUnknownError` is rethrown intact. When the create owns an empty connection, the generated UUID and exact-lookup recovery result are also recorded in connection state. A detached create beside an active session leaves that active connection untouched and carries recovery only on the structured error. The provider does not retry create. It does not wrap standalone create in the generic 30-second action timeout because that could reject before the SDK's required exact lookup completes.

Standalone directory error codes are copied from structured daemon error bodies into connection state so PR6 can present repair or terminal guidance without parsing strings.

## Workspace Isolation

For standalone and Live sessions, the provider skips session-less workspace providers, skills, ACP preheat, Git status, and workspace event invalidation. Session-scoped supported commands, context/model status, Goal state, transcript replay, prompts, permissions, and heartbeat remain available.

The current visible WebShell has no standalone entry point in PR5. PR6 must gate App-level workspace features before wiring Global New Chat and Recents to the new context. PR5 nevertheless exposes enough typed state for that gating without interpreting the internal runtime cwd as a workspace.

## Compatibility and Migration

- Existing Provider props and action calls remain valid.
- Workspace behavior and primary fallback remain unchanged only for callers without an explicit context.
- The public daemon React SDK exports the context and standalone state types.
- No new daemon route or SDK validator is added.
- The later WebShell provider cutover moves these files without architectural changes.
- Before publishing a WebShell package that directly requires the standalone SDK methods, align its SDK peer minimum with the first released SDK version containing PR4.

## Verification

Focused tests cover:

- context normalization and conflict rejection;
- exact route selection for workspace, standalone, and Live;
- missing standalone capability and zero/multiple/untrusted Live runtime failures with no fallback request;
- workspace to standalone to workspace/Live switching;
- rapid supersession, stale-client detach, and target-only replay/warnings;
- loading-skeleton failure semantics with no rollback;
- reload and reconnect using the stored context;
- outcome-unknown recovery states without create retry or outer timeout masking;
- recreated-directory state and structured directory error codes;
- no workspace providers, skills, Git, preheat, or event invalidation for non-workspace contexts;
- unchanged legacy workspace callers and controlled Provider transitions;
- public type exports and browser bundles.

Run the focused WebUI provider/action tests, WebUI build/typecheck/lint, WebShell provider integration tests, WebShell build/typecheck/lint/format, root build and typecheck, and the SDK/WebShell public-surface and browser-bundle checks.

## Scope Boundary

PR5 does not add Global New Chat, Recents, lifecycle menus, archive/delete/repair controls, deep links, standalone uploads, or project-control hiding. Those visible product flows remain PR6. It does not change daemon lifecycle behavior or recreate the reverted transactional session-switch coordinator.
