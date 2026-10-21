# Model selector refresh

[English](2026-10-19-model-selector-refresh.md) | [简体中文](2026-10-19-model-selector-refresh.zh-CN.md)

## Problem and scope

An embedding host can update its platform model catalog without updating the models offered by an already-open Web Shell. Add explicit refresh to the conversation model selector, including its model dialog and split panes. Do not introduce polling, cross-page notifications, platform-specific requests, or automatic model switching.

## Design

Expose optional `onRefreshModels({ workspaceCwd, sessionId })` on Web Shell. Await its `void | Promise<void>` result before reloading; an absent callback follows the same local reload path. Rejection stops the operation and retains the previous list. Hosts own fetching and persisting their platform catalog.

Add `POST /workspaces/:workspace/models/reload` and the matching workspace SDK method, reusing `reloadModelProviders`. This selected-runtime mutation requires authentication, trust, a valid runtime generation, and runtime-scoped client identity. Unknown or unavailable workspaces must never fall back to primary. Advertise `workspace_model_reload` so older daemons do not show an unsupported action. The endpoint returns the existing `applied | deferred | failed` result and does not write settings or broadcast events.

The session action captures the current workspace/session before awaiting the host. Reload that runtime, then read the existing live-session context and map its authoritative model list. Before a session exists, read workspace providers instead; deferred reload is acceptable only in that state. Do not create or replay a session. Refresh the provider cache and model-list metadata, including the retained model's context limit, while preserving the current selection and other session state. Reject degraded or empty welcome catalogs without replacing the previous list. Compare semantic workspace/session ownership, and prevent an older same-session load from replacing a completed refresh.

Render a refresh icon button beside the selector's search input, including the reasoning submenu. The model dialog keeps the same icon after the list so keyboard focus still opens on the model rows. Keep the old list while loading, prevent duplicate requests, and display a localized failure message with retry. Share the same action between the main composer, split panes, and main-model dialog. Non-workspace session contexts and older daemons do not expose the button.

## Implementation boundaries

Changes span daemon lifecycle routing/capabilities, the TypeScript workspace SDK, and Web Shell actions, customization, model-picker UI, and tests. Reuse the model-provider reload path. It re-reads user/workspace settings and refreshes the selected runtime environment overlay and ACP child environment to pick up provider credentials; unrelated environment keys may also change there without an event or response field. It leaves daemon-process environment, workflow enablement, and active model selection unchanged. A refresh updates only the requesting page; other pages can refresh independently.

## Validation and acceptance

Cover absent/void/rejected callbacks; callback-before-reload-before-read order; unchanged current model; failures retaining the old list; duplicate clicks; navigation during every await; welcome-state deferred reload; secondary-workspace isolation and trust/generation failures; compatibility with older daemons; and newly visible models being selectable. Verify busy-session model reload without interrupting generation. Run build, typecheck, bundle, focused tests, browser E2E, and two clean self-audit passes.

Global `qwen` baseline was attempted but its installed 0.18.5-preview.0 distribution lacks Web Shell assets. Record that limitation and use the repository browser harness plus the local bundled daemon for verification. Design status: implemented; verification results belong in the E2E report and PR.

## Open questions

None. No settings migration is required.
