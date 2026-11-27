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
  projection (`useMessagesFromBlocks`), history pagination, and `ExitPlanMode`
  mode-transition lock without opening duplicate subscriptions or re-projecting
  messages.
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
  - Export `useOptionalDaemonPromptSettled(listener)`, sharing the same
    subscription helper as `useDaemonPromptSettled` without the throw guard
    when mounted outside `DaemonSessionProvider` (supporting shared-state
    callers whose unit tests mock `@qwen-code/web-shell/daemon-react-sdk`
    directly).
- **`packages/web-shell/client/daemon/useDaemonChatController.ts` and
  `permission-signals.ts`:**
  - Extract the shared binding core (`useDaemonChatControllerFromState`) and
    delegate standalone `useDaemonChatController()` to it with zero contract
    change.
  - `useDaemonChatControllerFromState` accepts caller-owned `connection`,
    `actions`, `transcriptHistory`, `messages`, `pendingApprovals`,
    `pendingQuestions`, `pendingSignature`, and optional `transcriptState` and
    `submitPermission` override.
  - Both standalone `useDaemonChatController()` and
    `useDaemonChatControllerFromState()` derive permission currency and decision
    settlement through the same `derivePermissionSignals` effect (keyed on
    `[pendingSignature, sessionId]` so session switches sharing a signature
    still re-seed `prevPendingRef`), resolve `ExitPlanMode` / `AskUserQuestion`
    metadata directly from the render-ready `PendingApproval.request` /
    `PendingQuestion.request`, and forward prompt settlements into
    `createDaemonChatController`.
  - Remove the now-unused `questionSubmitOptionId` helper from
    `permission-signals.ts` (and its dead tests).
- **`packages/web-shell/client/chat-core/ChatSurface.tsx`:**
  - Pass `activeApproval?.request ?? null` (tool approvals only, excluding
    `AskUserQuestion`) to `TranscriptViewport.pendingApproval`, while keeping
    `approvalOverlayActive={cardActive}` covering both approvals and questions.
  - Guard `ToolApproval.onConfirm` error reporting on mounted + owning session.
  - Add five minimal, backend-neutral host seams actively consumed by
    `ChatPane.tsx` (omitting them preserves all existing defaults):
    - `transcriptRef?: Ref<MessageListHandle>` forwarded to
      `TranscriptViewport` (adding `'ref'` to `SurfaceOwnedTranscriptKeys`).
    - `transcriptProps.isResponding` host override (removing `'isResponding'`
      from `SurfaceOwnedTranscriptKeys`, falling back to controller-derived
      `isRunning` when omitted): needed when a pane reopens onto an
      already-admitted turn or submits through `onComposerSubmit`, where the
      controller has no non-terminal submit so `deriveChatPhase` returns
      `'idle'` while `TranscriptViewport` deletion gating and streaming
      affordances still require the live responding state.
    - `footerClassName?: string` optionally wrapping the bottom stack (decision
      cards, `panels`, admission banner, composer block) in a single styled
      container.
    - `composerEditorVisible?: boolean` (default `true`) hiding `ChatEditor`
      and `composerFooter` while keeping `composerStatus` mounted inside the
      approval-hidden wrapper (used by `ChatPane` when `readOnly` is `true`).
    - `onComposerCancel?: () => void` optional cancel override (paralleling
      `onComposerSubmit`, still gated by `composerCancelEnabled`), allowing a
      host whose submit pipeline stays outside the controller to cancel via
      `actions.cancel()` without recording an unsettleable `failed` cancel
      operation in `controller.operations`.
- **`packages/web-shell/client/components/ChatPane.tsx`,
  `ChatPane.module.css`, and `App.css.test.ts`:**
  - Replace the inline `<TranscriptViewport>`, `<ToolApproval>`,
    `<AskUserQuestion>`, and `<ChatEditor>` blocks with `<ChatSurface>` driven
    by `useDaemonChatControllerFromState`, passing `onComposerCancel` and
    preserving specific permission-failure / mode-lock causes through the
    surface error sink without double-reporting.
  - Delete direct value imports of `TranscriptViewport`, `ToolApproval`,
    `AskUserQuestion`, and `ChatEditor`, delete `handleAskUserConfirm`, and
    remove the now-redundant `.composerHidden` CSS rule from
    `ChatPane.module.css`.
  - Scope `.pane .surface` and `.pane .body` in `ChatPane.module.css` so flex
    height and scrolling remain pixel-identical regardless of stylesheet import
    order, and pin both rules in `App.css.test.ts`.

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
   - `MessageList` uses `pendingApproval` to keep a compact tool-call group
     expanded while a tool approval is open, and `DaemonTranscriptViewport`
     folds `props.pendingApproval !== null` (deliberately not
     `approvalOverlayActive`, as pinned by `TranscriptViewport.test.tsx`) into
     `useMessageDeletion`'s blocked guard. `AskUserQuestion` is not a tool
     approval, and `ManagedSessionsPage` mounts with
     `sessionViewportEnabled={false}` (where `useMessageDeletion` does not
     run). Narrowing `ChatSurface`'s `pendingApproval` to
     `activeApproval?.request ?? null` matches `App.tsx` and `ChatPane` while
     keeping `approvalOverlayActive={cardActive}` covering both cards.
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
5. **Keep `ChatPane.handleSubmit` and `handleCancel` behind
   `ChatSurface.onComposerSubmit` / `onComposerCancel`.**
   - Pane-local slash commands, `/plan` mode preparation, `/goal` commands,
     mid-turn prompt queueing, and capacity-recovery dialogs remain behind
     `onComposerSubmit` until a dedicated submit-pipeline convergence pass.
   - Because host-submitted turns do not populate the daemon controller's
     live-turn queue, `ChatPane` passes `onComposerCancel` so Stop dispatches
     `actions.cancel()` directly instead of recording an unsettleable `failed`
     cancel operation on `controller.operations`.

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
  - `App.css.test.ts`, `ChatPane.test.tsx`, `SplitView.test.tsx`,
    `SideTaskPanel.test.tsx`, `ChatSurface.test.tsx`,
    `TranscriptViewport.test.tsx`, `DaemonSessionProvider.test.tsx`,
    `useDaemonChatController.test.tsx`, `daemon/chat-controller.test.ts`,
    `daemon/permission-signals.test.ts`, and `build-artifact.test.ts` all pass.
  - New regression tests cover `useOptionalDaemonPromptSettled` (no-provider,
    provider delivery, listener update), `useDaemonChatControllerFromState`
    (including same-signature session switch re-seeding), `ChatSurface` new
    seams (`transcriptRef`, `transcriptProps.isResponding`, `footerClassName`,
    `composerEditorVisible`, `onComposerCancel`, question-only
    `pendingApproval === null`, and session-scoped approval error reporting in
    `ChatSurface.test.tsx`), `App.css.test.ts` `.pane .body` / `.pane .surface`
    pins, and `ChatPane` `<ChatSurface>` rendering + `AskUserQuestion`
    submit/dismiss + preserved approval failure diagnostics.
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
