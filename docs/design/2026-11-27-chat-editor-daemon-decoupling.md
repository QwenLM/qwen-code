# ChatEditor Daemon Toolbar and Upload Decoupling (Slice 6b)

[English](2026-11-27-chat-editor-daemon-decoupling.md) |
[简体中文](2026-11-27-chat-editor-daemon-decoupling.zh-CN.md)

Status: Implemented (Slice 6b of
[Unified Chat Surface](2026-11-16-unified-chat-surface.md), continuing from
[Slice 6a](2026-11-27-managed-host-boundary-guards-and-cleanup.md); the final
16 transcript/message/notification edges and CI `dist-managed-host/index.js`
bundle gate follow in Slice 6c). Date: 2026-11-27.

## Problem

After Slice 6a landed the fail-closed AST/compiler boundary guard and burned
down `packages/web-shell/client/managed-host.tsx`'s transitive daemon
value-import graph from 47 to 31 edges, 15 of the 31 remaining edges were
pulled exclusively through four static value imports in
`packages/web-shell/client/components/ChatEditor.tsx`:

1. `hooks/useFileUpload.ts` (2 edges: `../daemon/availability-context.js` and
   `../daemon/availability.js`) — used by both Daemon and Managed hosts for
   workspace file uploads, but coupled to daemon availability context and
   `isDaemonUnavailableError`.
2. `voice/VoiceButton.tsx` (3 edges: `voice/VoiceButton.tsx` and
   `voice/useVoiceCapture.ts` × 2) — daemon-only speech-to-text capture.
3. `live/LiveVoiceButton.tsx` (8 edges: `live/useLiveBrowserHost.ts`,
   `live/useLiveVoice.ts` × 3, `session-catalog/session-catalog-hooks.ts` × 3,
   and `session-catalog/session-catalog-store.ts`) — daemon-only live voice
   sessions.
4. `components/BranchPickerPopover.tsx` (2 edges: `@qwen-code/sdk/daemon` and
   `@qwen-code/web-shell/daemon-react-sdk`) — daemon-only git branch picker
   popover.

Managed hosts (`ManagedSessionsPage` and `WorkspaceBindingCreator`) never enable
`'voice'` or render `BranchPickerPopover`, yet still pulled all 15 daemon
modules into `managed-host.tsx`'s static dependency graph.

## Goals

- Eliminate all 15 Cluster-2 daemon value-import edges from
  `managed-host.tsx`'s transitive dependency graph (tightening the bidirectional
  ratchet in `packages/web-shell/client/chat-core/boundary.test.ts` from 31 to
  16 edges) while keeping `ChatEditor.tsx` and `hooks/useFileUpload.ts` free of
  daemon value imports.
- Keep Daemon (`App.tsx`, `ChatPane.tsx`, `DaemonWorkspaceProvider.tsx`) and
  Managed (`ManagedSessionsPage.tsx`, `WorkspaceBindingCreator.tsx`) behavior
  and visuals 100% unchanged.

## Non-goals

- Do not touch the remaining 16 Cluster-3 edges (`TranscriptViewport`,
  `TurnOutputs`, `ToolApproval`, `SystemMessage`, `ToolFilePreviewButton`,
  `HookStatistics`) or the CI bundle-artifact check — those belong to Slice 6c.
- Do not change any HTTP/SSE routes, OpenAPI schemas, storage keys, or i18n
  keys.

## Scope

- **Backend-neutral service availability bridge (−2 edges):**
  - `packages/web-shell/client/utils/service-availability.ts`: defines
    backend-neutral `ServiceAvailabilityState`, `ServiceAvailabilityController`,
    `ServiceUnavailableError`, `isServiceUnavailableError`,
    `ServiceAvailabilityContext`, `useServiceAvailabilityController`, and
    `useServiceAvailability` with zero daemon imports.
  - `packages/web-shell/client/daemon/availability.ts`: makes
    `DaemonUnavailableError` extend `ServiceUnavailableError` (preserving
    `this.name = 'DaemonUnavailableError'`, exact message, and
    `isDaemonUnavailableError`) and declares `DaemonAvailability implements
ServiceAvailabilityController`.
  - `packages/web-shell/client/daemon/availability-context.tsx`: re-exports the
    same `ServiceAvailabilityContext` instance as `DaemonAvailabilityContext`
    and delegates `useDaemonAvailabilityController` / `useDaemonAvailability`
    so every existing `<DaemonAvailabilityContext.Provider>` feeds
    `useFileUpload` transparently without touching `DaemonWorkspaceProvider` or
    existing daemon callers.
  - `packages/web-shell/client/hooks/useFileUpload.ts`: imports
    `useServiceAvailabilityController` and `isServiceUnavailableError` from
    `../utils/service-availability.js`.
- **Optional composer integration injection (−13 edges):**
  - `packages/web-shell/client/components/composer/composer-integrations.ts`:
    type-only `ComposerIntegrations` interface for optional `VoiceButton`,
    `LiveVoiceButton`, and `BranchPickerPopover` components (React 18/19
    ref-compatible via `RefAttributes<VoiceButtonHandle>`).
  - `packages/web-shell/client/components/composer/daemon-composer-integrations.ts`:
    daemon-only `DAEMON_COMPOSER_INTEGRATIONS` constant binding the real
    `VoiceButton`, `LiveVoiceButton`, and `BranchPickerPopover`.
  - `packages/web-shell/client/components/ChatEditor.tsx`: switches
    `VoiceButton`, `LiveVoiceButton`, and `BranchPickerPopover` imports to
    type-only, accepts optional `composerIntegrations?: ComposerIntegrations`,
    gates branch-picker visibility/measurement (`hasGitBranchControl`,
    `gitBranchVisible`, `branchPickerContextAvailable`), mobile `AddMenu` live
    voice entry, and toolbar voice controls on injected component presence, and
    resets `voiceActive` / `liveVoiceOpen` / `liveVoiceSupported` when an
    integration is absent.
  - `packages/web-shell/client/App.tsx` and
    `packages/web-shell/client/components/ChatPane.tsx`: pass
    `composerIntegrations: DAEMON_COMPOSER_INTEGRATIONS` through
    `<ChatSurface composerProps={...} />`.
- **Boundary ratchet & regression tests:**
  - `packages/web-shell/client/chat-core/boundary.test.ts`: removes all 15
    Slice 6b edges from `REMAINING_MANAGED_HOST_DAEMON_EDGES` (31 → 16).
  - `packages/web-shell/client/hooks/useFileUpload.test.tsx`: replaces the
    module mock with a live `<DaemonAvailabilityContext.Provider>` proving the
    real React Context and `DaemonUnavailableError extends
ServiceUnavailableError` inheritance chain end to end.
  - `packages/web-shell/client/components/ChatEditor.test.tsx` &
    `ChatPane.test.tsx`: injects test doubles via `composerIntegrations`, adds
    coverage for omitted/partial/toggled `composerIntegrations` (including
    `GitModePopover` remaining active without `BranchPickerPopover`), and
    verifies `ChatPane` passes `DAEMON_COMPOSER_INTEGRATIONS`.

## Key Design Decisions

1. **Share one React Context identity and error superclass for availability
   rather than duplicating providers.**
   - Re-using `ServiceAvailabilityContext` as `DaemonAvailabilityContext` and
     having `DaemonUnavailableError extends ServiceUnavailableError` keeps
     `instanceof DaemonUnavailableError` and every existing
     `<DaemonAvailabilityContext.Provider>` 100% intact with zero wrapper
     churn, while removing both daemon imports from `hooks/useFileUpload.ts`.
2. **Inject daemon composer controls via an explicit optional prop rather than
   an ambient context.**
   - Only two production daemon hosts render `ChatSurface`/`ChatEditor`
     (`App.tsx` and `ChatPane.tsx`), and `App.test.tsx` renders `App` without a
     `DaemonWorkspaceProvider`. Passing `composerIntegrations:
DAEMON_COMPOSER_INTEGRATIONS` explicitly through `composerProps` avoids
     ambient coupling, works identically in harnesses without a workspace
     provider, and lets `ManagedSessionsPage` and `WorkspaceBindingCreator`
     omit it cleanly.
3. **Keep `gitBranchVisible` and toolbar measurement aligned with actual
   rendered controls.**
   - Defining `hasGitBranchControl` as `Boolean(gitModeIntent &&
onGitModeIntentChange) || Boolean(BranchPickerPopoverComponent)` prevents
     an empty context row or phantom measurement span when a host passes
     `gitBranch` without `BranchPickerPopover` or `gitModeIntent`, while
     keeping `GitModePopover` unaffected.

## Constraints

- Zero visual or behavioral changes on Daemon (`App.tsx`, `ChatPane.tsx`,
  `VoiceButton`, `LiveVoiceButton`, `BranchPickerPopover`, `useFileUpload`) or
  Managed (`ManagedSessionsPage`, `WorkspaceBindingCreator`,
  `ManagedAgentWebShell`).
- React 18 and React 19 ref compatibility preserved for `VoiceButton` via
  `RefAttributes<VoiceButtonHandle>`.
- `build:managed-host`, `build-artifact.test.ts`, and full-repository
  `npm run typecheck` (including `typecheck:integration`) remain green.

## Validation & Acceptance Criteria

- **Unit & boundary tests:** `chat-core/boundary.test.ts` (asserting 0
  `chat-core/**` violations, 0 unresolved specifiers, and exact 16 remaining
  `managed-host.tsx` edges with all 15 Cluster-2 edges gone),
  `hooks/useFileUpload.test.tsx`, `daemon/availability.test.ts`,
  `components/ChatEditor.test.tsx`, `components/ChatPane.test.tsx`,
  `components/managed/ManagedSessionsPage.test.tsx`,
  `components/managed/WorkspaceBindingCreator.test.tsx`, `App.test.tsx`
  (voice/branch/upload suites), and `build-artifact.test.ts` all pass.
- **Mutation witnesses:** Removing `composerIntegrations` from `ChatPane.tsx`
  or `App.tsx`, breaking `DaemonUnavailableError extends
ServiceUnavailableError`, breaking `DaemonAvailabilityContext ===
ServiceAvailabilityContext`, or removing `hasGitBranchControl` /
  `LiveVoiceButtonComponent` gating in `ChatEditor.tsx` all verified to fail
  tests.
- **Static gates:** `eslint --max-warnings=0`, `prettier --check`,
  `tsconfig.json`, `tsconfig.lib.json`, `web-shell` + `managed-host` builds,
  and full-repo `npm run typecheck`.
- **Real browser verification:** Real Chromium verification of
  `<ManagedAgentWebShell>` plus Playwright E2E suites covering daemon
  composer/voice/branch picker, file upload, and split persistence.
