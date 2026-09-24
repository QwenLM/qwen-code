# Standalone Initial Model Options

## Problem

Web Shell defers standalone session creation until the first prompt. During that pending state the session provider intentionally clears session-scoped model data, so a fresh standalone page renders an empty model picker. Once the first session is created, the attached session supplies the model list and the picker starts working.

The initial selection also cannot be treated as a post-create preference. Standalone creation already accepts `modelServiceId`; applying the selection with a later best-effort `setModel` can silently run the first prompt with the daemon default when the switch fails.

## Design

The daemon exposes a capability-gated, read-only `GET /standalone/session-options` route. The route is owned by the internal Conversations runtime used for standalone sessions. It acquires that exact runtime, participates in its activity lease, verifies the internal root and runtime generation, and reads the runtime's provider status. The response omits the internal workspace path and ACP-channel state.

The TypeScript SDK validates the response at runtime and exposes it only when `standalone_session_options_v1` is advertised. Older daemons therefore keep their existing behavior without receiving an unsupported request.

While Web Shell is connected in a pending standalone context, the session provider reads the standalone options and maps them into the existing `models`, `currentModel`, `currentMode`, and `contextWindow` connection fields. This reuses the existing model picker and reasoning controls without introducing a second application-level model state machine. A failed or unsupported catalog read leaves those fields empty and does not block the first prompt.

When the first standalone prompt creates a session, Web Shell passes the selected `modelServiceId` in the create request and skips the post-attach model switch. A selected reasoning effort is still applied after attach because it is session configuration, but it is not persisted into the internal Conversations workspace settings. Workspace session creation remains unchanged.

## Boundaries

- The route never accepts `cwd` or `workspaceCwd` and never falls back to the primary workspace.
- Reading options must not create a standalone session or a per-session directory.
- The response must not expose the internal Conversations workspace path.
- Runtime replacement, quarantine, or generation changes fail closed.
- A missing capability or failed options request does not block prompt submission; the daemon default is used when no model is selected.
- Standalone create keeps its existing stable UUID, outcome-unknown recovery, and no-automatic-retry behavior.
- Workspace, Live, Recents, lifecycle menus, uploads, and daemon lifecycle behavior are out of scope.

## Verification

Unit tests cover runtime ownership and redaction, route behavior, capability advertisement, SDK validation, deferred Web Shell hydration, stale/failing option reads, and atomic standalone creation. Browser E2E verifies that a fresh standalone page shows models before creating a session, opening the picker does not create a session, and the selected model is sent in the first standalone create request.
