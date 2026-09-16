# Web Shell Secondary-workspace Voice

## Summary

Web Shell Voice must use the same workspace owner as the composer that exposes the control. The main composer, a locked embed, and each split-view composer can therefore use either the legacy primary Voice routes or the workspace-qualified Voice routes, but a single capture must never change owners after it starts.

The implementation should add a small Voice-specific target resolver and route adapter rather than retargeting the global `DaemonWorkspaceProvider` or general Settings state. The resolver feeds all existing Voice behavior: button visibility, Voice status, model discovery, the `voiceModel` setting, the streaming WebSocket, and stale-result rejection.

This design implements issue #6972 on top of the daemon and SDK support merged in #6839. It does not change the daemon protocol, SDK public API, Voice schema, or the existing Voice UX.

## Current state and failure

The daemon and TypeScript SDK already expose trusted workspace-qualified Voice:

- `GET` and `POST /workspaces/:workspace/voice`
- `POST /workspaces/:workspace/voice/transcribe`
- `WS /workspaces/:workspace/voice/stream`
- `WorkspaceDaemonClient.workspaceVoice()`, `workspaceProviders()`, `workspaceSettings()`, and workspace-scoped `setWorkspaceSetting()`

Web Shell does not use those surfaces for Voice today:

- `VoiceButton` reads `workspace.client.workspaceVoice()`, so its enabled state is always primary.
- `useVoiceCapture` always builds `<base>/voice/stream`, so audio always reaches the primary runtime.
- `/model --voice`, the Voice model picker, and the Settings `voiceModel` row load and mutate the root workspace state.
- `ChatEditor` creates `VoiceButton` without a workspace or session owner. Split-view panes therefore also use primary Voice regardless of their session workspace.
- `useVoiceCapture` keeps the latest `onFinal` callback. A final frame from an old capture can consequently call a composer callback installed after a workspace/session change unless the old capture has already been aborted.
- The Vite development proxy's `/workspace` prefix already carries qualified REST requests, but no matching qualified Voice rule opts the WebSocket upgrade into proxying.

The composer already has the correct source data. In the main view, `activeWorkspaceCwd` resolves the active session owner, otherwise the locked workspace, selected workspace, or primary workspace. Each split pane also knows its session id and workspace cwd. Voice should consume those values instead of inventing a second selection state.

## Protocol correction

The merged protocol is authoritative: `workspace_qualified_voice` alone advertises all workspace-qualified Voice modalities. The legacy `workspace_voice`, `workspace_voice_transcription`, and `voice_transcribe` tags describe primary-bound routes and are not prerequisites for a secondary runtime.

Issue #6972 originally asked for an intersection between `workspace_qualified_voice` and a legacy Voice capability. That would incorrectly hide a valid secondary configuration when the primary runtime has no Voice model or primary-only capability. The issue now reflects that separation, and the implementation and tests follow the merged protocol.

The related model and Settings UI use core routes, not Voice routes, so their capability intersection is operation-specific:

| Secondary operation                                           | Required capability                                      |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| Voice status/update, batch transcription, streaming WebSocket | `workspace_qualified_voice`                              |
| Provider discovery                                            | `workspace_qualified_rest_core`                          |
| Qualified Settings read/write                                 | `workspace_qualified_rest_core` and `workspace_settings` |
| Shared user-scope setting write                               | `workspace_settings`                                     |

These extra tags gate only their matching model/Settings controls. A secondary composer with `workspace_qualified_voice` but without Settings persistence can still dictate; it must not be hidden merely because model selection is unavailable. Conversely, model/Settings controls must not infer core-route or persistence support from `workspace_qualified_voice`, and they must never substitute primary data when their own gate is absent.

## Goals

- Bind every existing Web Shell Voice operation to the composer owner.
- Keep legacy primary and old single-workspace behavior unchanged.
- Prefer a stable workspace id and use a correctly encoded absolute cwd only as a fallback.
- Fail closed for missing, unknown, untrusted, removed, draining, or unsupported secondary workspaces.
- Preserve the existing User/Workspace scope behavior of `voiceModel`.
- Abort microphone, audio graph, timers, WebSocket, and callbacks when the target or owning session changes.
- Never retry a qualified failure against a primary route.
- Keep the change Voice-specific and small.

## Non-goals

- New Voice controls, settings, modes, or model schema.
- A general multi-workspace rewrite of the Web Shell Settings panel.
- Changes to daemon routes, ACP methods, SDK public methods, quotas, or admission policy.
- Voice access for untrusted workspaces.
- Per-workspace quotas or fairness.
- Batch transcription UI.
- Retargeting a running capture to a new workspace or session.

## Ownership model

Voice crosses several scopes. Each value must stay in its existing owner:

| Concern                                                                | Owner                                   |
| ---------------------------------------------------------------------- | --------------------------------------- |
| Composer text and capture identity                                     | One main or split-view composer/session |
| Voice status, effective model, provider environment, workspace setting | Resolved workspace runtime              |
| User-scoped `voiceModel` write                                         | Existing process/user settings surface  |
| Primary compatibility routes                                           | Legacy primary runtime                  |
| Secondary Voice routes                                                 | Trusted registered selected runtime     |
| Eight-operation Voice admission limit                                  | Daemon process                          |
| Microphone, AudioContext, timers, WebSocket                            | One browser capture generation          |

The process-global admission coordinator remains entirely server-side. The Web Shell should surface its errors but must not add a client-side quota.

## Target resolution

Add a pure Voice target resolver under `packages/web-shell/client/voice`. Its input is the intended composer workspace cwd, the daemon primary cwd, the merged registered-workspace list, and the composer session id. Its output is either no target or an immutable route descriptor:

```ts
type VoiceWorkspaceTarget =
  | {
      route: 'legacy-primary';
      workspaceKey: string;
      ownerKey: string;
      cwd?: string;
      streamPath: 'voice/stream';
    }
  | {
      route: 'workspace-qualified';
      workspaceKey: string;
      ownerKey: string;
      cwd: string;
      selector: {
        kind: 'id' | 'cwd';
        value: string;
      };
      streamPath: string;
    };
```

The descriptor contains data, not an SDK client. Small helpers choose `DaemonClient` or `WorkspaceDaemonClient` for each operation. This keeps construction and encoding in one place without adding a new provider or mutable service.

Resolution order for the main composer remains:

1. Active session `connection.workspaceCwd`.
2. Embedder-locked workspace.
3. Workspace selected for the next session.
4. Registered primary workspace, falling back to `capabilities.workspaceCwd` for older single-workspace daemons.

A split pane resolves from its own `connection.sessionId` and authoritative `connection.workspaceCwd`. Its explicit pane workspace cwd is a consistency check and a pre-connection hint, not an override: while a session id exists, a missing connection cwd or a mismatch between the connection and pane prop yields no Voice target. This prevents stale split-layout metadata from routing a live session's audio.

Ownership resolution and operation support remain separate. The resolver applies only these ownership/trust gates:

| Owner             | Required state                                           |
| ----------------- | -------------------------------------------------------- |
| Primary           | Cwd is the registered/compatibility primary              |
| Secondary         | Exact unique registered cwd match and `trusted === true` |
| Missing/ambiguous | No Voice workspace owner                                 |

Small capability helpers then decide which operations the resolved owner supports:

| Owner     | Dictation status/stream     | Model/Settings management                                                              |
| --------- | --------------------------- | -------------------------------------------------------------------------------------- |
| Primary   | `voice_transcribe`          | Preserve the existing legacy provider/Settings behavior                                |
| Secondary | `workspace_qualified_voice` | `workspace_qualified_voice`, `workspace_qualified_rest_core`, and `workspace_settings` |

Separating the owner from the operation gate preserves the current ability to configure a primary Voice model even on an older daemon where the streaming capability is absent. It also lets a qualified secondary dictate when Settings persistence is absent without exposing a non-functional model picker.

An older daemon without `workspaces[]` may use only its compatibility primary cwd and legacy routes. Because it supplies no per-workspace trust projection, preserve the existing primary behavior rather than inventing an untrusted state. A very old daemon that exposes neither `workspaces[]` nor `workspaceCwd` may keep the opaque legacy-primary target only when it advertises no modern workspace feature; a modern session with no authoritative cwd fails closed. Neither form can synthesize a secondary target.

For a qualified target, use a non-empty registered id first. If an id is unavailable, retain the raw absolute cwd as the selector. Encode the raw selector exactly once when constructing the path. SDK calls use `workspaceById(id)` or `workspaceByCwd(cwd)`, both of which own their own encoding.

`workspaceKey` includes route kind, selector identity, and cwd. Re-registering the same cwd under a different runtime id therefore invalidates the old target. `ownerKey` additionally includes `session:<id>` or `draft:<workspaceKey>`. Replacing a session in the same workspace still invalidates a capture, while a pre-session composer remains stable until its selected workspace changes or a session is attached.

## Main and split-view propagation

`App` resolves the main target from the existing `activeWorkspaceCwd` and its merged workspace list, which includes an embedder-locked capability that may not yet be present in the first capabilities snapshot. It passes the descriptor through `ChatEditor` to `VoiceButton`.

`App` also passes the same merged workspace list and Voice revision state through `SplitView` when the daemon supplied a workspace list or a locked runtime was registered locally. It leaves that prop absent for an old single-workspace daemon so `ChatPane` can retain the compatibility `workspaceCwd` fallback instead of having it shadowed by an empty list. `ChatPane` combines the applicable list with its pane connection, resolves a descriptor, and passes it through its own `ChatEditor`. This matters for a just-registered locked runtime that exists in the local merged list even if the subsequent global capabilities refresh failed. `ChatEditor` remains a presentational pass-through and does not query daemon ownership itself.

Passing the resolved descriptor is preferable to resolving inside `VoiceButton`: the main App owns the locked/selected precedence and is the only layer with the merged locked capability. It also makes target resolution independently testable.

## Status and button gate

`VoiceButton` always receives the resolved owner while the composer owns it, independently of temporary status revalidation. It applies the owner's dictation capability and keeps its existing fail-closed status gate, keyed by:

- `target.workspaceKey`
- `target.ownerKey`
- the current session provider's `settingsVersion` only when that session's cwd equals the target cwd
- the target-relevant App-owned Voice revisions incremented after local Voice model writes and propagated to the main and split-view buttons
- a local revalidation revision used after unexpected socket closure

For a primary target it calls legacy `client.workspaceVoice()`. For a qualified target it calls the corresponding `WorkspaceDaemonClient.workspaceVoice()`. Each request captures a monotonically increasing status-request generation in addition to the target keys. The request starts from a hidden state, and only the latest generation may update the gate; this covers both a simple target switch and an A → B → A sequence.

The button appears only after the selected route reports `enabled: true`. A qualified response must also echo the target's canonical `workspaceCwd`; a mismatched response is treated as stale/invalid. A missing target, pending request, request error, feature loss, trust loss, owner change, or mismatched response hides the control. The capture hook keeps the same resolved target during same-owner status revalidation so a retryable connection error is not mistaken for an owner change and erased; a real owner or stream-path change still clears target-local state. If any invalid gate affects connecting, recording, or transcribing, the capture is aborted.

No qualified status error may trigger a legacy request. HTTP `400 workspace_mismatch`, `403 untrusted_workspace`, and `503 workspace_draining` remain terminal for that revalidation.

The App-owned revision state has one user-settings counter and a counter per `workspaceKey`. User-scope Voice writes increment the shared counter because they affect every runtime; workspace-scope writes increment only the captured target's counter. A button keys on the shared counter plus its own workspace counter, so changing workspace A does not abort an unrelated capture in workspace B.

An active main or split session also receives its runtime's `settingsVersion` from that session event stream. Ignore an outer/provider signal whose connection cwd does not match the resolved owner, which can occur for a draft selected for another workspace. A draft/locked secondary composer has no workspace event stream before session creation, so it refreshes on target/capability changes and the App-owned revision after local writes. This design does not add polling or a second hidden session solely to observe out-of-process settings edits; a later target change, explicit Settings reload, capture revalidation, or page refresh reconciles those edits.

## Voice model discovery and setting scope

The existing Voice model UI is retained, but its data access becomes target-aware and independently capability-gated. Ownership resolution does not reject a valid dictation target because a core REST or Settings capability is absent.

### Model candidates

When opening `/model --voice` or the Voice model picker:

- Primary preserves the existing behavior and loads legacy `/workspace/providers`.
- Secondary first requires `workspace_qualified_voice`, `workspace_qualified_rest_core`, and `workspace_settings`, then loads `/workspaces/:workspace/providers` through the same qualified target.
- The existing `extractVoiceModels()` and `ModelDialog` continue to render the result.

The picker is a setting mutation surface, so a read-only provider list without `workspace_settings` is not useful enough to justify a new disabled-picker state. If any secondary gate is absent, do not issue the provider request; report an unsupported-capability error through the existing `model.setVoice` error path for a command entry point, and omit or disable the Settings entry point.

The async request captures the target owner key and a monotonically increasing picker-intent generation; both success and error completion require both values before changing current UI. A new Voice request supersedes the previous one. Owner/capability changes, leaving the request's originating surface (chat for a command, Settings for a Settings click), opening any competing model/fallback/auth surface, explicit dismissal, and unmount also invalidate the pending intent, so a slow provider response cannot reopen a surface the user has already left. The generation changes as soon as a committed owner or capability transition occurs, which also rejects an old A response after an A → B → A sequence. For a qualified response, additionally require `workspaceCwd` to equal the target's canonical cwd before consuming it. If the response is no longer current or names a different runtime, discard it and do not open the picker. If a Voice picker is already open when its owner or capability gate changes, close it without applying a selection.

The qualified Voice status also contains `availableVoiceModels`; it remains useful evidence that the runtime resolved its Voice transports, but it should not replace the provider response in the picker because the current UI preserves provider labels and metadata.

### Settings read

For a secondary main target with `workspace_qualified_voice`, `workspace_qualified_rest_core`, and `workspace_settings`, load qualified `/workspaces/:workspace/settings` and replace only the `voiceModel` descriptor in the Settings state passed to `SettingsMessage`. Reload that descriptor on target key, matching target-session `settingsVersion`, and target-relevant local Voice revisions. Derive the Voice picker's `currentModel` from that same overlaid descriptor; leaving the existing `currentVoiceModel` calculation on the root settings would still highlight the primary value. Other setting descriptors keep their current behavior and are outside this issue.

Until the qualified descriptor loads, or when any required capability is absent, omit or disable the secondary `voiceModel` row rather than displaying the primary value. If there is no valid trusted workspace owner, do the same for all Voice model entry points instead of leaving a primary-backed control visible. The primary row and picker keep their current legacy availability even when primary dictation is unsupported. A settings-request generation rejects late successes and failures even after an A → B → A target sequence. The qualified response already contains effective, user, and workspace values, so it can preserve the current scope-specific selection display.

### Settings write

Use the existing scope semantics:

| Target    | Scope     | Write                                                                                                                       |
| --------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Primary   | User      | Legacy `setWorkspaceSetting('user', 'voiceModel', value)`                                                                   |
| Primary   | Workspace | Legacy `setWorkspaceSetting('workspace', 'voiceModel', value)`                                                              |
| Secondary | User      | Legacy user-scoped setting write, because user settings are shared and the qualified route intentionally forbids user scope |
| Secondary | Workspace | Qualified `WorkspaceDaemonClient.setWorkspaceSetting('workspace', 'voiceModel', value)`                                     |

Every secondary model-management entry point requires `workspace_qualified_voice`, `workspace_qualified_rest_core`, and `workspace_settings`. The user-scope write itself still goes through the shared legacy route, but that does not bypass the entry point's qualified provider/Settings gates. The picker rechecks the gates at selection time rather than trusting the state from when it opened.

After a successful local Voice model write, increment the shared user revision for user scope or the captured target's workspace revision for workspace scope. Pass the relevant pair to every main and split-view `VoiceButton`. For a secondary target, also explicitly reload the target Voice settings. `VoiceButton` includes those revisions in its status key and therefore reloads the target Voice status. A user-scoped write is broadcast on the primary bridge and a pre-session secondary composer may have no target event stream, so relying only on `settingsVersion` would leave the secondary UI stale.

The main composer's locally handled `/model --voice <id>` uses the same adapter. It snapshots the invocation target. A concurrent removal is rejected by the runtime generation guard; the client never retries another route. Split panes continue sending their session-scoped daemon command through their own `DaemonSessionProvider`; this design does not reroute that command through the outer App.

The Voice picker stores its opening target and scope together. Selection is refused if the current owner no longer matches, preventing a picker opened for workspace A from writing workspace B.

## Streaming capture

Change `useVoiceCapture` to accept an immutable capture target containing `ownerKey` and `streamPath`, in addition to base URL and token.

URL construction becomes:

- Primary: `<base>/voice/stream`
- Qualified id: `<base>/workspaces/<encoded-id>/voice/stream`
- Qualified cwd fallback: `<base>/workspaces/<encodeURIComponent(absolute-cwd)>/voice/stream`

Reverse-proxy base paths remain preserved. Bearer authentication continues to offer `qwen-ws` plus `qwen-bearer.<base64url-token>` and never puts the token in a URL.

At `start()`, the hook snapshots:

- capture generation
- owner key
- stream path
- final/error callbacks

Every microphone continuation, audio callback, WebSocket callback, timer, and final delivery checks that snapshot. A layout-timed owner/route change aborts the generation before browser events can run for the newly committed composer, even when the old generation is already in an error/notice state. It also clears target-local error, notice, interim, level, and timer state so workspace B never displays workspace A's result. The hook must not use a newly rendered `onFinal` callback for an older capture.

Abort remains idempotent and performs all cleanup:

- stop every media track, including a track returned after a pending `getUserMedia`
- disconnect ScriptProcessor/source/sink nodes
- close the AudioContext
- clear response/finalization timers
- send `abort` when the socket is open
- detach socket handlers and close the socket
- clear interim text and audio level
- invalidate the generation before any asynchronous completion can publish

A final transcript is inserted only when generation and owner still match. Empty final text keeps the existing no-speech notice.

## Socket closure and lifecycle changes

The backend already closes runtime leases with `1012` for workspace removal, trust reconfiguration, or daemon shutdown, and uses an error frame plus `1013` for capacity.

Add an optional structured unexpected-close callback from `useVoiceCapture` to `VoiceButton`. A close before a final result and without a preceding terminal `error` frame is classified by close code. Ownership-ambiguous closes such as `1012`, `1006`, or an unexpected application failure invalidate the status gate and start a route revalidation; while it is pending, the button is hidden and cannot restart microphone work. Capacity `1013` is the one close-only exception because it is process-scoped and says nothing about target validity. A terminal `error` frame already owns cleanup and user-visible retry state; its later close is detached during cleanup and must not trigger a second generic failure or gate invalidation.

- `1012`: also refresh daemon capabilities. A removed or untrusted target then disappears. If refresh fails, keep the local gate invalid instead of exposing Retry.
- `1013`: the preceding capacity error frame remains the user-facing retry message and the target gate stays valid, so Retry remains visible. If a malformed peer sends `1013` without an error frame, show the generic capacity message without crossing routes.
- `1006` or another unexpected close: re-read the exact target status. A concurrent 400/403/503 stays hidden; a still-valid enabled target may return as a retry control.
- `1000` after final/abort: normal cleanup, no revalidation.

This client revalidation improves UX but is not the security boundary. The daemon still resolves trust/generation after authentication and never falls back to primary.

## Development proxy

Add a narrow qualified Voice WebSocket rule next to, preferably before, the existing `/workspace` prefix:

```ts
'^/workspaces/[^/]+/voice/stream/?$': { ...daemonProxy, ws: true },
'/workspace': daemonProxy,
```

Vite treats a proxy key beginning with `^` as a regular expression. Its upgrade loop ignores matching contexts that do not opt into WebSockets, so declaration order is not a correctness dependency in the current Vite version; keeping the specific upgrade rule before the broad REST prefix nevertheless makes the overlap explicit. The narrow suffix does not match client-side `/voice/*` TypeScript modules. Qualified REST continues through the existing `/workspace` prefix.

Keep the existing exact `/voice/stream` rule for primary compatibility.

## Error behavior

| Failure                                           | UI behavior                                                                                          | Fallback |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| Target unknown/unregistered                       | Voice hidden                                                                                         | None     |
| Target known untrusted                            | Voice hidden before status or mic                                                                    | None     |
| Primary `voice_transcribe` absent                 | Primary dictation hidden; existing primary model configuration remains available                     | None     |
| Secondary `workspace_qualified_voice` absent      | Secondary dictation and model configuration hidden                                                   | None     |
| Qualified core REST or Settings capability absent | Secondary model/Settings control hidden or command reported unsupported; dictation remains available | None     |
| Status/settings/providers 400, 403, or 503        | Relevant control hidden/closed; report model action error where already expected                     | None     |
| Status/provider response names another cwd        | Discard response and keep relevant control hidden                                                    | None     |
| Voice disabled                                    | Voice hidden                                                                                         | None     |
| Model missing/invalid                             | Existing server error message and retry behavior                                                     | None     |
| Capacity                                          | Existing “try again shortly” error; retry remains available                                          | None     |
| Removal/trust change during capture               | Abort resources, discard callbacks, hide while capabilities/status revalidate                        | None     |
| Session/workspace switch                          | Abort resources, close open Voice picker, discard stale responses/transcript                         | None     |
| Network/socket interruption                       | Release mic immediately, revalidate exact target, then allow retry only if still valid               | None     |

## Implementation slices

1. Add the pure ownership resolver, per-operation capability helpers, route helpers, and focused tests.
2. Pass resolved targets through the main and split-view `ChatEditor` paths.
3. Make `VoiceButton` status reads and `useVoiceCapture` URLs/ownership target-aware.
4. Make Voice model provider loading and only the `voiceModel` setting descriptor/mutation target-aware.
5. Add the narrow Vite qualified Voice WebSocket proxy rule.
6. Add focused unit/component tests, then the E2E coverage and evidence described below.

This ordering keeps each step reviewable and allows the capture safety work to be tested independently of the model/settings integration.

## Test strategy

### Pure/unit tests

- Primary, selected secondary, active-session, locked, split-pane, old single-workspace (including split propagation), unknown, removed, and untrusted target resolution.
- A session id with a missing workspace cwd, or a split pane whose explicit cwd disagrees with its connection, resolves to no target.
- Split resolution consumes the App's merged workspace list, including a locally registered locked capability not yet present in global capabilities.
- Ownership resolution is independent of capability; the capture gate requires only `workspace_qualified_voice` for secondary and `voice_transcribe` for primary.
- Secondary dictation remains available with only `workspace_qualified_voice`; model/Settings entry points separately require `workspace_qualified_rest_core` and `workspace_settings`.
- Primary model configuration remains available when the primary capture gate is absent.
- Stable id preference, cwd fallback, POSIX/Windows-drive/UNC paths, spaces/non-ASCII cwd encoding, reverse-proxy base paths, and no double encoding.
- Qualified status/providers/settings calls never call a legacy alternative after failure.
- Qualified status and provider responses with a mismatched `workspaceCwd` are rejected.
- User/workspace Voice model scope routing matches the table above.
- A workspace-scope write revalidates only buttons for that workspace; a user-scope write revalidates all Voice targets.
- A settings-version signal from a different workspace does not revalidate or abort the current target.
- Stale status, settings, provider, and picker successes or failures cannot affect UI after owner changes, including A → B → A.
- Pending Voice picker loads cannot reopen after their Settings panel closes or another model/auth surface supersedes them.
- Target/session changes in connecting, recording, and transcribing abort once and discard final/interim/error callbacks.
- Target changes from idle, error, and no-speech states also clear the old target's error/notice state.
- Pending microphone acquisition is stopped after target invalidation.
- Qualified `1012`/`1006` invalidation, error-frame/`1013` retry preservation, normal final, timeout, and unmount cleanup.
- Main and split `ChatEditor` pass the intended Voice target.

### Integration/E2E

- Real daemon with primary plus trusted secondary, Voice enabled/model configuration isolated between them.
- Main pre-session workspace selection, active secondary session, locked secondary embed, primary, and split pane.
- Qualified status/provider/settings requests and qualified Voice WebSocket upgrade by id.
- Cwd fallback encoding in a focused browser/hook integration fixture.
- Mid-capture workspace switch, session replacement, removal, and trust/capability loss.
- Primary token/no-token bearer-subprotocol compatibility.
- Development Vite proxy upgrades both legacy and qualified Voice sockets without proxying `/voice/voiceModels.ts`.

The detailed execution plan lives in `.qwen/e2e-tests/web-shell-secondary-workspace-voice.md`.

## Compatibility and rollout

- No protocol or SDK version change.
- Primary continues to use only the legacy status/settings/providers/stream routes.
- Primary model configuration keeps its existing availability even when primary dictation is unsupported.
- Older daemons without `workspace_qualified_voice` retain primary Voice and hide secondary Voice.
- A secondary with qualified Voice but no Settings persistence can dictate while its model/Settings mutation controls stay unavailable.
- Host `visibleToolbarActions` remains the outer Voice gate.
- Existing button labels, waveform, timers, empty-speech notice, model dialog, and setting scopes remain unchanged.
- No automatic fallback or retry crosses workspace ownership.

## Risks and mitigations

### A broad Settings refactor expands the issue

Only the `voiceModel` descriptor and mutation are overlaid for a secondary target. Other Settings ownership remains out of scope.

### A late final reaches a different composer

The capture snapshots its callback and owner, target changes invalidate the generation in layout timing, and final delivery rechecks both.

### Same-cwd runtime replacement looks unchanged

The target key includes the preferred runtime id, not only cwd.

### A Voice picker writes after navigation

The picker stores its opening owner and closes/refuses selection after an owner change.

### The dev proxy has overlapping REST and WebSocket contexts

The qualified rule is limited to the Voice stream suffix and explicitly enables WebSockets. It is kept next to and before `/workspace` so future proxy changes do not obscure the overlap.

### User-scope writes appear primary-bound

That is the intended settings ownership: user scope is shared and qualified settings writes are workspace-only. Target status/settings are explicitly reloaded after the global write.

## Alternatives rejected

### Retarget the global `DaemonWorkspaceProvider`

The provider owns process/global discovery and many primary compatibility surfaces. Retargeting it would change unrelated settings, extensions, auth, and sidebar behavior and would not work for simultaneous split panes.

### Always use qualified routes, including primary

This would unnecessarily drop compatibility with older daemons and violate the explicit legacy-primary contract.

### Resolve the target inside `VoiceButton`

The button cannot reconstruct locked-workspace merging or main selection precedence, and it would duplicate split/main ownership logic.

### Keep the latest final callback and rely on effect cleanup

WebSocket events can race a committed owner change before passive cleanup. Snapshotting the owner/callback and invalidating in layout timing closes that window.

### Use `availableVoiceModels` alone for the picker

It proves runtime Voice availability but lacks the labels and provider metadata the existing picker already renders.

### Retry a failed secondary request on legacy primary

This is an ownership and trust violation and is forbidden by the protocol.
