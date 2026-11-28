# ChatPane Convergence onto Shared ChatSurface (Slice 4)

[English](2026-11-27-chat-pane-chat-surface-switch.md) |
[简体中文](2026-11-27-chat-pane-chat-surface-switch.zh-CN.md)

Status: implemented (Slice 4a landed in #18476; Slice 4b completed 2026-11-28,
retiring `ChatPane`'s temporary `onComposerCancel` and
`transcriptProps.isResponding` overrides via `responding` and `cancelPrompt` on
`useDaemonChatControllerFromState` while keeping daemon-only slash/queue
`onComposerSubmit` and `composerStatus` as host-owned slots; see
[Unified Chat Surface](2026-11-16-unified-chat-surface.md)). Date: 2026-11-27
(updated 2026-11-28).

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
  capacity orchestration) behaviorally and visually unchanged across
  `SplitView`, `SideTaskPanel` (`embedded`), and
  `components/artifacts/SessionPanel.tsx` (`embedded` + `readOnly`, the
  artifacts panel's session tab).

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
  - Extract the shared private binding core (`useDaemonChatControllerCore`);
    standalone `useDaemonChatController()` calls it with the strict
    `useDaemonPromptSettled` guard and pending-permission split (zero contract
    change), while `useDaemonChatControllerFromState()` calls the same core
    with the optional, non-throwing `useOptionalDaemonPromptSettled`
    subscription.
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
  - Add minimal, backend-neutral host seams actively consumed by
    `ChatPane.tsx` (omitting them preserves all existing defaults):
    - `transcriptRef?: Ref<MessageListHandle>` forwarded to
      `TranscriptViewport` (adding `'ref'` to `SurfaceOwnedTranscriptKeys`).
    - `transcriptProps.isResponding` host override (introduced in Slice 4a and
      **retired in Slice 4b / #18596**): `'isResponding'` is now restored to
      `SurfaceOwnedTranscriptKeys` and derived from `controller.phase`, with
      `ChatPane` feeding live `responding: isResponding` through
      `useDaemonChatControllerFromState`.
    - `footerClassName?: string` optionally wrapping the bottom stack (decision
      cards, `panels`, admission banner, composer block) in a single styled
      container.
    - `composerEditorVisible?: boolean` (default `true`) hiding `ChatEditor`
      and `composerFooter` while keeping `composerStatus` mounted inside the
      approval-hidden wrapper (used by `ChatPane` when `readOnly` is `true`).
    - `onComposerCancel?: () => void` optional cancel override (still used by
      `App.tsx` for inline-shell queue draining and cancelled-prompt take-back;
      **retired from `ChatPane.tsx` in Slice 4b / #18596**, which now routes
      Stop through `ChatSurface` → `controller.cancel()` via `cancelPrompt`).
- **`packages/web-shell/client/components/ChatPane.tsx`,
  `ChatPane.module.css`, and `App.css.test.ts`:**
  - Replace the inline `<TranscriptViewport>`, `<ToolApproval>`,
    `<AskUserQuestion>`, and `<ChatEditor>` blocks with `<ChatSurface>` driven
    by `useDaemonChatControllerFromState`, routing both permission decisions
    and Stop cancellation through the controller while preserving specific
    permission-failure, mode-lock, and cancel causes in FIFO order through the
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
   one private core (`useDaemonChatControllerCore`).**
   - `ChatPane` already throttles transcript updates via
     `useAnimationFrameTranscriptSnapshot` and memoizes `messages` via
     `useMessagesFromBlocks`, and its tests mock
     `@qwen-code/web-shell/daemon-react-sdk` directly. Having both
     `useDaemonChatController()` (with strict `useDaemonPromptSettled`) and
     `useDaemonChatControllerFromState()` (with optional
     `useOptionalDaemonPromptSettled`) call the shared private
     `useDaemonChatControllerCore` avoids a second `messages` projection,
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
5. **Keep `ChatPane.handleSubmit` and `composerStatus` host-owned while
   converging Stop onto `controller.cancel()` (Slice 4b / #18596).**
   - Pane-local slash commands, `/plan` mode preparation, `/goal` commands,
     mid-turn prompt queueing, and capacity-recovery dialogs stay behind
     `onComposerSubmit` and `composerStatus`, matching `App.tsx`.
   - Slice 4b converged Stop cancellation onto `ChatSurface` →
     `controller.cancel()` via `useDaemonChatControllerFromState`'s
     `cancelPrompt` and `responding` options, and updated
     `createDaemonChatController.cancel()` so cancelling a host-driven
     responding turn (`cancelTarget === undefined && deps.responding`) surfaces
     `'cancelling'` while in flight without fabricating a `failed` cancel row
     on `controller.operations`.

## Constraints

- `chat-core` modules must remain strictly daemon-free (zero imports from
  `daemon/**` or `@qwen-code/sdk/daemon`) and never branch on `controller.kind`.
- No changes to daemon HTTP/SSE routes, OpenAPI schemas, storage keys, or i18n
  keys.
- Web Shell CSS scoping (`data-web-shell-root`, portal roots) and React 18/19
  `forwardRef` compatibility remain intact.
- Both `SplitView` (multi-pane) and `SideTaskPanel` (`embedded`) layouts
  remain pixel-consistent, and `components/artifacts/SessionPanel.tsx`
  (`embedded` + `readOnly`, the artifacts panel's session tab) keeps its
  read-only status chrome.

## Validation & Acceptance Criteria

- **Unit & integration tests:**
  - `App.css.test.ts`, `ChatPane.test.tsx`, `SplitView.test.tsx`,
    `SideTaskPanel.test.tsx`, `ChatSurface.test.tsx`,
    `TranscriptViewport.test.tsx`, `DaemonSessionProvider.test.tsx`,
    `useDaemonChatController.test.tsx`, `daemon/chat-controller.test.ts`,
    `daemon/permission-signals.test.ts`, and `build-artifact.test.ts` all pass.
  - New regression tests cover `useOptionalDaemonPromptSettled` (no-provider,
    provider delivery, listener update), `useDaemonChatControllerFromState`
    (including same-signature session switch re-seeding, `responding` phase
    precedence, and `cancelPrompt` delegation), `ChatSurface` seams
    (`transcriptRef`, controller-derived `isResponding`, `footerClassName`,
    `composerEditorVisible`, `onComposerCancel` for `App.tsx`, question-only
    `pendingApproval === null`, and session-scoped approval/cancel error
    reporting in `ChatSurface.test.tsx`), `App.css.test.ts` `.pane .body` /
    `.pane .surface` pins, and `ChatPane` `<ChatSurface>` rendering +
    `AskUserQuestion` submit/dismiss + single-transport resolving Stop + FIFO
    preserved cancel/approval failure diagnostics.
- **Mutation witnesses:** Reachable new guards and seams verified red under an
  isolated mutation harness.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`,
  `eslint --max-warnings=0`, `prettier --check`, and repository
  `npm run build && npm run typecheck`.
- **Real browser Before/After E2E:** Real local Vite + Chromium (`<StrictMode>`)
  mounting `ChatPane` Before (unmodified `origin/main` baseline) vs After
  (switched onto `ChatSurface`), verifying pixel-consistent layout across
  `SplitView`, tool approval, `AskUserQuestion` submit/dismiss, turn
  cancellation, `readOnly` status chrome (as mounted by the artifacts panel's
  session tab `SessionPanel`), and zero page or unexpected console errors.
