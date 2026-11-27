# ChatPane Convergence onto Shared ChatSurface (Slice 4)

[English](2026-11-27-chat-pane-chat-surface-switch.md) |
[简体中文](2026-11-27-chat-pane-chat-surface-switch.zh-CN.md)

Status: implemented (Slice 4 of
[Unified Chat Surface](2026-11-16-unified-chat-surface.md)). Date: 2026-11-27.

## Problem

After switching the Managed chat column onto the shared backend-neutral
`ChatSurface` (`ManagedSessionsPage.tsx`) and completing the daemon chat
controller and binding hook (`createDaemonChatController`,
`useDaemonChatController`), the daemon split-view and side-task chat column
(`packages/web-shell/client/components/ChatPane.tsx`) still renders
`TranscriptViewport`, `ToolApproval`, `AskUserQuestion`, and `ChatEditor`
inline with its own approval, question, and cancel wiring.

Switching `ChatPane.tsx` onto `ChatSurface` delivers the first live daemon
columns (`SplitView` and `SideTaskPanel`) on the shared surface, retires
`ChatPane`'s duplicated approval, question, cancel, and layout orchestration,
and validates the shared daemon adapter and host seams before converging the
main daemon column in `App.tsx`.

## Goals

- Switch `ChatPane.tsx` onto `ChatSurface` backed by the daemon controller
  adapter (`useDaemonChatControllerFromState`), removing direct imports and
  inline rendering of `TranscriptViewport`, `ToolApproval`, `AskUserQuestion`,
  and `ChatEditor` from `ChatPane.tsx`.
- Reuse `ChatPane`'s already-mounted daemon context hooks, frame-throttled
  transcript snapshot (`useAnimationFrameTranscriptSnapshot`), message
  projection (`useMessagesFromBlocks`), history pagination, live status facts
  (`queueLength`, `goalActive`), and `ExitPlanMode` mode-transition lock without
  opening duplicate subscriptions or re-projecting messages.
- Keep pane chrome (`<header>`, `PaneHeaderActions`, `SessionDetailsTooltip`,
  `connectionError`), `GoalEditDialog`, `ReportedArtifactRegistration`,
  composer status stack (`StreamingStatus`, `ComposerStatusStack`,
  `SessionRecoveryBanner`, `runtimeStopped`), `CapacityRecoveryDialog`,
  `CustomComposerFooter`, and `ChatPane.handleSubmit` (slash/plan/goal/queue/
  capacity orchestration) behaviorally and visually unchanged across both
  `SplitView` and `SideTaskPanel` (`embedded` and `readOnly` modes).

## Non-goals

- Switching the main daemon column in `App.tsx` (tracked separately).
- Folding `ChatPane.handleSubmit`'s pane-local slash commands (`/plan`,
  `/goal`, `/logout`, `/model`, host `onSlashCommand`), mid-turn message queue
  (`useQueuedPrompts`), or `CapacityRecoveryDialog` into `ChatSurface` or
  `createDaemonChatController`.
- Changing daemon HTTP/SSE routes, OpenAPI schemas, storage keys, or i18n keys.
- Enforcing `dist-managed-host` bundle boundaries (Slice 6).

## Scope

- **`packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx`:**
  - Export `useOptionalDaemonPromptSettled(listener)`, identical to
    `useDaemonPromptSettled` except that it returns silently when mounted
    outside `DaemonSessionProvider` (supporting shared-state callers whose unit
    tests mock `@qwen-code/web-shell/daemon-react-sdk` directly).
- **`packages/web-shell/client/daemon/useDaemonChatController.ts`:**
  - Extract the shared binding core (`useDaemonChatControllerFromState`) and
    delegate standalone `useDaemonChatController()` to it with zero contract
    change.
  - `useDaemonChatControllerFromState` accepts caller-owned `connection`,
    `actions`, `transcriptHistory`, `messages`, `pendingApprovals`,
    `pendingQuestions`, `pendingSignature`, and optional `transcriptState`,
    `statusFacts`, and `submitPermission` override.
  - Both standalone `useDaemonChatController()` and
    `useDaemonChatControllerFromState()` derive permission currency and decision
    settlement through the same `derivePermissionSignals` effect, resolve
    `ExitPlanMode` / `AskUserQuestion` metadata directly from the render-ready
    `PendingApproval.request` / `PendingQuestion.request`, and forward prompt
    settlements into `createDaemonChatController`.
- **`packages/web-shell/client/chat-core/ChatSurface.tsx`:**
  - Pass `activeApproval?.request ?? null` (tool approvals only, excluding
    `AskUserQuestion`) to `TranscriptViewport.pendingApproval`, while keeping
    `approvalOverlayActive={cardActive}` covering both approvals and questions.
  - Add three minimal, backend-neutral host seams actively consumed by
    `ChatPane.tsx` (omitting them preserves all existing defaults):
    - `transcriptRef?: Ref<MessageListHandle>` forwarded to
      `TranscriptViewport` (and `'ref'` added to `SurfaceOwnedTranscriptKeys`).
    - `footerClassName?: string` optionally wrapping the bottom stack (decision
      cards, `panels`, admission banner, composer block) in a single styled
      container.
    - `composerEditorVisible?: boolean` (default `true`) hiding `ChatEditor`
      and `composerFooter` while keeping `composerStatus` mounted inside the
      approval-hidden wrapper (used by `ChatPane` when `readOnly` is `true`).
- **`packages/web-shell/client/components/ChatPane.tsx` and
  `ChatPane.module.css`:**
  - Replace the inline `<TranscriptViewport>`, `<ToolApproval>`,
    `<AskUserQuestion>`, and `<ChatEditor>` blocks with `<ChatSurface>` driven
    by `useDaemonChatControllerFromState`.
  - Delete direct value imports of `TranscriptViewport`, `ToolApproval`,
    `AskUserQuestion`, and `ChatEditor`, delete `handleAskUserConfirm` and
    `handleCancel`, and remove the now-redundant `.composerHidden` CSS rule from
    `ChatPane.module.css`.
  - Scope `.pane .surface` and `.pane .body` in `ChatPane.module.css` so flex
    height and scrolling remain pixel-identical regardless of stylesheet import
    order.

## Key Design Decisions

1. **Shared-state daemon binding (`useDaemonChatControllerFromState`) reusing
   one core.**
   - `ChatPane` already throttles transcript updates via
     `useAnimationFrameTranscriptSnapshot` and memoizes `messages` via
     `useMessagesFromBlocks`, and its tests mock
     `@qwen-code/web-shell/daemon-react-sdk` directly. Factoring
     `useDaemonChatController()` as a thin wrapper over
     `useDaemonChatControllerFromState()` avoids a second `messages` projection,
     eliminates duplicated controller-binding logic, and keeps standalone
     `useDaemonChatController()`'s public contract and strict provider guard
     unchanged.
2. **Tool-approval-only `pendingApproval` on `TranscriptViewport`.**
   - `MessageList` uses `pendingApproval` only to keep a compact tool-call group
     expanded while a tool approval is open; `AskUserQuestion` is not a tool
     approval, and overlay layout already uses `approvalOverlayActive={cardActive}`.
     Narrowing `TranscriptViewport.pendingApproval` to
     `activeApproval?.request ?? null` matches `App.tsx`, `ChatPane.tsx`, and
     `ManagedSessionsPage.tsx`.
3. **Host `ExitPlanMode` handoff lock via `submitPermission` override.**
   - `ChatPane` owns `modeTransitionRef` and `modeControlsBusy` to serialize
     approval-mode switches against `ExitPlanMode` confirmations. Passing a
     `submitPermission` responder into `useDaemonChatControllerFromState` keeps
     that lock coupled to the pane's mode controls while routing all approval
     admission, currency, and settlement through `createDaemonChatController`
     and `ChatSurface`.
4. **Preserve `readOnly` status chrome through `composerEditorVisible`.**
   - In `ChatPane`, `readOnly` hides `ChatEditor` and `CustomComposerFooter`
     while keeping `runtimeStopped`, `StreamingStatus`, `ComposerStatusStack`,
     and `SessionRecoveryBanner` mounted inside the approval-hidden wrapper.
     Keeping `composerVisible` for whole-block hiding (used by
     `ManagedSessionsPage`) and adding `composerEditorVisible` (default `true`)
     preserves both hosts cleanly with zero backend branching.
5. **Keep `ChatPane.handleSubmit` behind `ChatSurface.onComposerSubmit`.**
   - Pane-local slash commands, `/plan` mode preparation, `/goal` commands,
     mid-turn prompt queueing, and capacity-recovery dialogs remain behind
     `onComposerSubmit` until a dedicated submit-pipeline convergence pass.

## Constraints

- `chat-core` modules must remain strictly daemon-free (zero imports from
  `daemon/**` or `@qwen-code/sdk/daemon`) and never branch on `controller.kind`.
- No changes to daemon HTTP/SSE routes, OpenAPI schemas, storage keys, or i18n
  keys.
- Web Shell CSS scoping (`data-web-shell-root`, portal roots) and React 18/19
  `forwardRef` compatibility remain intact.
- Both `SplitView` (multi-pane) and `SideTaskPanel` (`embedded` + `readOnly`)
  layouts remain pixel-consistent.

## Validation & Acceptance Criteria

- **Unit & integration tests:**
  - `ChatPane.test.tsx`, `SplitView.test.tsx`, `SideTaskPanel.test.tsx`,
    `ChatSurface.test.tsx`, `useDaemonChatController.test.tsx`,
    `daemon/chat-controller.test.ts`, and `build-artifact.test.ts` all pass.
  - New regression tests cover `useDaemonChatControllerFromState`, `ChatSurface`
    new seams (`transcriptRef`, `footerClassName`, `composerEditorVisible`,
    question-only `pendingApproval === null`), and `ChatPane` `<ChatSurface>`
    rendering + `AskUserQuestion` submit/dismiss routing.
- **Mutation witnesses:** Reachable new guards and seams verified red under an
  isolated mutation harness.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`,
  `eslint --max-warnings=0`, `prettier --check`, and repository
  `npm run build && npm run typecheck`.
- **Real browser Before/After E2E:** Real local Vite + Chromium (`<StrictMode>`)
  mounting `ChatPane` Before (unmodified `origin/main` baseline) vs After
  (switched onto `ChatSurface`), verifying pixel-consistent layout, tool
  approval, `AskUserQuestion` submit/dismiss, turn cancellation, `readOnly`
  status chrome, and zero page or unexpected console errors.
