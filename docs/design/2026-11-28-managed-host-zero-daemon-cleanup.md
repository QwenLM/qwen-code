# Managed Host Zero-Daemon Completion and CI Bundle Guard (Slice 6c)

[English](2026-11-28-managed-host-zero-daemon-cleanup.md) |
[简体中文](2026-11-28-managed-host-zero-daemon-cleanup.zh-CN.md)

Status: Implemented (final Slice 6c completing
[Unified Chat Surface](2026-11-16-unified-chat-surface.md) / issue #17460,
following [Slice 6a](2026-11-27-managed-host-boundary-guards-and-cleanup.md) and
[Slice 6b](2026-11-27-chat-editor-daemon-decoupling.md)). Date: 2026-11-28.

## Problem

After Slice 6a (47 → 31 edges) and Slice 6b (31 → 16 edges), sixteen transitive
daemon value-import edges remained in
`packages/web-shell/client/managed-host.tsx`'s dependency graph:

1. **Pure leaf utilities and error checks (4 edges):**
   - `components/messages/HookStatistics.tsx` (`summarizeHookExecutions` from
     `@qwen-code/sdk/daemon`),
   - `components/messages/GoalStatusMessage.tsx`
     (`DAEMON_GOAL_STATUS_SENTINEL_PREFIX` from `@qwen-code/sdk/daemon`),
   - `components/messages/SystemMessage.tsx` (`parseDaemonBackgroundTurn` from
     `@qwen-code/sdk/daemon`),
   - `components/artifacts/artifactUtils.ts` (`DaemonHttpError` and
     `isSessionLevelNotFound` from `@qwen-code/sdk/daemon`).
2. **Browser notification settings context (1 edge):**
   - `components/messages/BrowserNotificationControl.tsx` imported
     `useBrowserNotificationSettings` from `browser-turn-notifications.tsx`,
     which pulls `./daemon/session/turn-notification-context`.
3. **Daemon transcript history viewport and deletion (5 edges):**
   - `components/TranscriptViewport.tsx` statically imported
     `useOptionalDaemonHistoryNavigationStore`, `useTranscriptViewport`, and
     `useMessageDeletion` (transitively pulling `adapters/transcriptToMessages`,
     `@qwen-code/sdk/daemon`, and `@qwen-code/web-shell/daemon-react-sdk`).
4. **Daemon-only status sub-cards in `SystemMessage` (4 edges):**
   - `components/messages/SystemMessage.tsx` statically imported
     `McpStatusMessage.tsx` (1 edge) and `TasksStatusMessage.tsx` (3 edges).
5. **Workspace target resolution in shared transcript renderers (2 edges):**
   - `components/artifacts/TurnOutputs.tsx` (`useArtifactWorkspaceTarget.ts`)
     and `components/messages/ToolFilePreviewButton.tsx` imported
     `@qwen-code/web-shell/daemon-react-sdk` (`useWorkspace` /
     `useWorkspaceActions`).

In addition, `.github/workflows/web-shell-managed-host.yml` verified positive
bundle markers in `packages/web-shell/dist-managed-host/` but did not yet fail
CI if daemon runtime code leaked back into the emitted managed-host bundle.

## Goals

- Eliminate all 16 remaining transitive daemon value-import edges from
  `packages/web-shell/client/managed-host.tsx` (47 → 31 → 16 → 0).
- Delete `REMAINING_MANAGED_HOST_DAEMON_EDGES` from
  `packages/web-shell/client/chat-core/boundary.test.ts` and assert exact zero
  (`expect(daemonEdges).toEqual([])`) alongside zero unresolved specifiers and
  zero `chat-core/**` violations.
- Enforce a live-verified negative daemon runtime marker gate on
  `packages/web-shell/dist-managed-host` in
  `.github/workflows/web-shell-managed-host.yml` and pin it in
  `scripts/tests/web-shell-managed-host-workflow.test.js`.

## Non-goals

- Do not remove the prerequisite workspace builds (`core`, `acp-bridge`, `sdk`)
  from `web-shell-managed-host.yml` (browser-safe core subpaths and type-only
  SDK references remain valid inputs).
- Do not change any HTTP/SSE routes, OpenAPI schemas, storage keys, i18n keys,
  or user-visible behavior in Daemon, Managed, or exported transcript views.

## Scope

- **Pure leaf cuts & parity tests (−4 edges):**
  - `components/messages/HookStatistics.tsx`: imports `summarizeHookExecutions`
    directly from `@qwen-code/qwen-code-core/telemetry/hook-lifecycle-contract.js`.
  - `components/messages/GoalStatusMessage.tsx` + `.test.tsx`: exports local
    `GOAL_STATUS_SENTINEL_PREFIX = 'web-shell:goal-status:v1:'` pinned against
    `@qwen-code/sdk/daemon`'s `DAEMON_GOAL_STATUS_SENTINEL_PREFIX`.
  - `utils/background-turn.ts` + `.test.ts`: browser-safe `parseBackgroundTurn`
    pinned clause-for-clause against `@qwen-code/sdk/daemon`'s
    `parseDaemonBackgroundTurn`; consumed by `SystemMessage.tsx`.
  - `components/artifacts/artifactUtils.ts` + `.test.ts`: replaces
    `instanceof DaemonHttpError` and `isSessionLevelNotFound` with a
    `DaemonHttpError`-named structural check pinned against `@qwen-code/sdk/daemon`.
- **Browser notification settings context split (−1 edge):**
  - `browser-notification-settings-context.ts`: holds
    `BrowserNotificationSettings`, `BrowserNotificationSettingsContext`, and
    `useBrowserNotificationSettings` with zero daemon imports (re-exported by
    `browser-turn-notifications.tsx`; imported directly by
    `BrowserNotificationControl.tsx`).
- **Daemon transcript viewport split (−5 edges):**
  - `components/DaemonTranscriptViewport.tsx`: moves
    `SessionAwareTranscriptViewport` and `DaemonSessionTranscriptViewport`
    verbatim out of `TranscriptViewport.tsx`.
  - `components/TranscriptViewport.tsx`: stays pure (`LiveTranscriptViewport`,
    `followRangeFromRows`, optional React 18/19 ref-compatible
    `sessionViewportComponent` prop).
  - `App.tsx` and `components/ChatPane.tsx`: pass
    `sessionViewportComponent={DaemonTranscriptViewport}` (`App.test.tsx` and
    `ChatPane.test.tsx` pin the binding).
- **Daemon status card renderers context (−4 edges):**
  - `components/messages/daemon-status-cards-context.ts`: neutral
    `DaemonStatusCardsContext` / `useDaemonStatusCards`.
  - `components/messages/daemon-status-cards.tsx` + `.test.tsx`:
    `DAEMON_STATUS_CARD_RENDERERS: Required<DaemonStatusCardRenderers>` binding
    `McpStatusMessage` and `TasksStatusMessage`.
  - `SystemMessage.tsx`: reads `useDaemonStatusCards()` without importing
    `McpStatusMessage` or `TasksStatusMessage`.
  - Provided by `App.tsx`, `ChatPane.tsx`, and `WebShellTranscript.tsx`
    (keeping headless `DaemonWorkspaceProvider` free of UI imports while
    preserving offline transcript rendering).
- **Shared workspace runtime context (−2 edges):**
  - `utils/workspace-context.ts`: neutral `WorkspaceRuntimeContext` and
    `useOptionalWorkspaceRuntime()` shared as `DaemonWorkspaceContext` inside
    `DaemonWorkspaceProvider.tsx` (preserving module-scoped context identity
    and duplicate-copy diagnostics).
  - `components/artifacts/artifact-workspace-target.ts`: verbatim extraction of
    `resolveArtifactWorkspaceOwner` and `useArtifactWorkspaceTargetFromRuntime`
    returning `undefined` safely when no workspace runtime is mounted;
    `useArtifactWorkspaceTarget.ts` remains a thin wrapper for daemon callers.
  - `components/artifacts/TurnOutputs.tsx` and
    `components/messages/ToolFilePreviewButton.tsx`: read
    `useOptionalWorkspaceRuntime()` + `useArtifactWorkspaceTargetFromRuntime`,
    failing closed safely outside `DaemonWorkspaceProvider`.
- **Zero-daemon boundary & CI bundle guard:**
  - `chat-core/boundary.test.ts`: deletes `REMAINING_MANAGED_HOST_DAEMON_EDGES`
    and enforces `expect(daemonEdges).toEqual([])`.
  - `.github/workflows/web-shell-managed-host.yml` +
    `scripts/tests/web-shell-managed-host-workflow.test.js`: forbids 8
    live-verified minified daemon runtime markers (`DaemonSessionProvider`,
    `DaemonWorkspaceProvider`, `useDaemonWorkspace must be used within`,
    `The daemon is unavailable. Automatic refresh is paused.`,
    `__qwenWebShellDaemonWorkspaceProviderCopies`, `DaemonUnavailableError`,
    `web-shell:mcp-status:v1:`, `web-shell:tasks-status:v1:`) anywhere in
    `packages/web-shell/dist-managed-host`.

## Key Design Decisions

1. **Preserve exact runtime invariants on extracted guards and workspace
   authority.**
   - Moving `useArtifactWorkspaceTarget`'s trust-boundary, StrictMode
     microtask revocation, and capability-ref logic verbatim into
     `artifact-workspace-target.ts` ensures zero behavioral drift while making
     `TurnOutputs` and `ToolFilePreviewButton` fail-closed without a provider.
2. **Reuse module-scoped React Context identity for `WorkspaceRuntimeContext`
   and `BrowserNotificationSettingsContext`.**
   - Just like `ServiceAvailabilityContext` in Slice 6b, sharing the React
     Context instance avoids duplicate providers and keeps every existing
     daemon provider tree working transparently.
3. **Verify every CI bundle-guard marker is live in the minified daemon bundle.**
   - Minification renames internal class/function identifiers (`RestSseTransport`
     and `useDaemonSession must be used within` do not appear in minified
     `dist/`), so every marker pinned in `web-shell-managed-host.yml` was
     verified to hit 3–5 times in minified `packages/web-shell/dist/` and 0
     times across all emitted JS files in `packages/web-shell/dist-managed-host/`.

## Constraints

- Zero visual or behavioral regressions on Daemon (`App.tsx`, `ChatPane.tsx`,
  `DaemonWorkspaceProvider`, `TranscriptViewport`, `TurnOutputs`,
  `ToolFilePreviewButton`, `SystemMessage`), Managed (`ManagedSessionsPage`,
  `ManagedAgentWebShell`), or static `WebShellTranscript`.
- `build`, `build:managed-host`, `build-artifact.test.ts`, full-repository
  `npm run typecheck` (including `typecheck:integration` under `nodenext`), and
  `scripts/tests/web-shell-managed-host-workflow.test.js` all remain green.

## Validation & Acceptance Criteria

- **Boundary & workflow gates:** `chat-core/boundary.test.ts` passes with
  `daemonEdges === []` and `unresolvedSpecifiers === []`;
  `scripts/tests/web-shell-managed-host-workflow.test.js` passes; running the
  workflow verification shell snippet locally against
  `packages/web-shell/dist-managed-host` passes with exit 0.
- **Unit & parity tests:** `utils/background-turn.test.ts`,
  `components/messages/GoalStatusMessage.test.tsx`,
  `components/messages/HookStatistics.test.tsx`,
  `components/messages/SystemMessage.test.tsx`,
  `components/messages/daemon-status-cards.test.tsx`,
  `components/messages/TasksStatusMessage.test.tsx`,
  `components/messages/ToolFilePreviewButton.test.tsx`,
  `components/artifacts/artifactUtils.test.ts`,
  `components/artifacts/TurnOutputs.dom.test.tsx`,
  `components/artifacts/SubagentDetail.integration.test.tsx`,
  `components/artifacts/ArtifactPanel.test.tsx`,
  `components/TranscriptViewport*.test.tsx`, `components/ChatPane.test.tsx`,
  `App.test.tsx`, `components/managed/ManagedSessionsPage.test.tsx`,
  `daemon/workspace/DaemonWorkspaceProvider.test.tsx`, and
  `build-artifact.test.ts` all pass.
- **Real browser verification:** Real Chromium verification of
  `<ManagedAgentWebShell>` plus Playwright E2E suites covering transcript
  navigation/history, turn outputs, tool preview, and split persistence.
