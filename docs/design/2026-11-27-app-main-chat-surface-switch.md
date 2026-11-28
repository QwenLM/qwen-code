# App Main Daemon Chat Column Convergence onto Shared ChatSurface (Slice 2f.3)

[English](2026-11-27-app-main-chat-surface-switch.md) |
[简体中文](2026-11-27-app-main-chat-surface-switch.zh-CN.md)

Status: implemented (Slice 2f.3 of
[Unified Chat Surface](2026-11-16-unified-chat-surface.md) — main daemon chat
column rendering plus approval/question routing onto `ChatSurface`; remaining
submit/cancel/status pipeline convergence is tracked as follow-up). Date:
2026-11-27.

## Problem

After switching `ManagedSessionsPage.tsx` (Slice 3c.3) and `ChatPane.tsx`
(Slice 4a) onto the shared backend-neutral `ChatSurface`, the main daemon chat
column in `packages/web-shell/client/App.tsx` is the last remaining chat column
in the repository still rendering `ToolApproval`, `AskUserQuestion`, and
`ChatEditor` inline with its own duplicated approval, question, and footer
wiring.

Switching `App.tsx`'s main daemon column onto `ChatSurface` driven by
`useDaemonChatControllerFromState` converges all three chat columns
(`ManagedSessionsPage`, `ChatPane`, and `App` main chat) onto one shared
surface while preserving `App`'s streaming-tail performance isolation, Blink
relayout boundaries, empty-state vertical centering, and host-owned submit /
cancel / recovery / footer chrome.

## Goals

- Switch `App.tsx`'s main daemon chat column onto `ChatSurface` backed by
  `useDaemonChatControllerFromState`, removing direct value imports and inline
  rendering of `ToolApproval`, `AskUserQuestion`, and `ChatEditor` plus
  `handleAskUserConfirm` from `App.tsx`.
- Preserve `App.tsx`'s memoized streaming-tail `LiveMessageList`,
  `ConversationSearch`, `btwPanel`, `mobileWelcomeGroup`, Blink relayout
  boundaries (`.chatViewWrap` / `.content` / `.appChatEmpty`), and
  `React.memo(ChatEditor)` stability across transcript-only renders.
- Keep main-column chrome (`scrollToBottomLayer`, `TodoPanel`,
  `ProjectHooksApprovalCard`, `askUserOverlayRef` floating environment-panel
  inset measurement, composer status banners, `ComposerTaskChips`,
  `ComposerStatusStack`, `WaitingMinigame`, `CustomFooter`,
  `ComposerUsageStats`, `emptyWelcomeFooter`), `ExitPlanMode` handoff locks,
  `WebShellApi.respondToPendingPermission`, and `submitComposerInput` /
  `handleCancel` behaviorally and visually unchanged.

## Non-goals

- Folding `App.tsx`'s `submitComposerInput` (local slash commands, inline shell
  queue, optimistic echo, `/plan` / `/goal` / `/btw` orchestration) or
  `handleCancel` (shell-queue drain and prompt take-back) into `ChatSurface` or
  `createDaemonChatController`.
- Replacing `LiveMessageList`'s per-frame streaming-tail isolation inside
  `App.tsx`.
- Changing daemon HTTP/SSE routes, OpenAPI schemas, storage keys, or i18n keys.
- Capability-gated parity across Managed (Slice 5) or `dist-managed-host`
  bundle boundary enforcement (Slice 6).

## Scope

- **`packages/web-shell/client/chat-core/ChatSurface.tsx`:**
  - Memoize the defensive copy `editorCommands = useMemo(() => [...commands], [commands])`
    so `ChatSurface` preserves `React.memo(ChatEditor)` stability across
    transcript-only renders on every host.
  - Combine `cardActive || Boolean(composerProps?.dialogOpen)` when
    `hideComposerWhenCardActive` is true so host-level modal blockers
    (`interactionBlocked`, `projectHooksApprovalActive`) keep `dialogOpen`
    asserted on `ChatEditor` even when no session permission card is open.
  - Omit the redundant inner `data-testid="approval-overlay"` when the host
    already sets `decisionTestId="approval-overlay"` on the outer decision
    wrapper (preventing duplicate nested `approval-overlay` test IDs).
  - Add minimal, backend-neutral host seams actively consumed by `App.tsx`
    (omitting them preserves all existing defaults):
    - `transcriptContent?: ReactNode` — replaces the default
      `<div className={transcriptClassName}><TranscriptViewport ... /></div>`
      region so `App.tsx` keeps its memoized `LiveMessageList` +
      `ConversationSearch` + `btwPanel` + `mobileWelcomeGroup` without
      re-rendering `App` per streaming token.
    - `footerRef?: Ref<HTMLDivElement>`, `footerStyle?: CSSProperties`,
      `footerHeader?: ReactNode`, and `footerTrailing?: ReactNode` — preserve
      `App`'s `.footer` `ResizeObserver` ref, responsive width `contentStyle`,
      top floating controls (`scrollToBottomLayer`, `TodoPanel`), and trailing
      chrome outside `.composerHidden` (`CustomFooter`, `ComposerUsageStats`,
      `emptyWelcomeFooter`).
    - `decisionRef?: Ref<HTMLDivElement>` — forwarded to the outer decision
      wrapper so `App`'s `askUserOverlayRef` measures the `AskUserQuestion`
      sheet for the floating environment panel bottom inset.
    - `questionKeyboardActive?: boolean` (defaults to `approvalKeyboardActive`)
      — allows `App` to drive independent keyboard focus authority for
      `ToolApproval` (`toolApprovalOverlayVisible`) vs `AskUserQuestion`
      (`askUserOverlayVisible`).
- **`packages/web-shell/client/App.tsx`, `App.module.css`, and
  `App.css.test.ts`:**
  - Bind `mainSurfaceController = useDaemonChatControllerFromState(...)` with
    `pendingApprovals` / `pendingQuestions` gated on `mainView === 'chat'`,
    `transcriptState: connection.loadingTranscript ? 'loading' : 'ready'`, and
    `submitPermission: submitMainPermission` (preserving `ExitPlanMode`
    `modeTransitionRef` serialization, localized `t('mode.changePending')`, and
    single-report diagnostic preservation for both `ToolApproval` and
    `AskUserQuestion` dismissal via `pendingPermissionFailureRef` +
    `handleSurfaceError`).
  - Route `WebShellApi.respondToPendingPermission` through
    `mainSurfaceController.respondApproval(...)` while rethrowing the failure
    cause on non-accepted admission.
  - Replace the inline `.footer`, `<ToolApproval>`, `<AskUserQuestion>`, and
    `<ChatEditor>` JSX with `<ChatSurface className={styles.chatSurface} ... />`,
    deleting direct value imports of `ToolApproval`, `AskUserQuestion`, and
    `ChatEditor` plus `handleAskUserConfirm`.
  - Add `.chatSubtree .chatSurface { display: contents; }` in `App.module.css`
    and pin it in `App.css.test.ts` so `.content` and `.footer` remain direct
    flex children of `.chatViewWrap` across both active and empty chat states.

## Key Design Decisions

1. **Keep `.chatSubtree .chatSurface { display: contents; }` to preserve Blink
   relayout boundaries and empty-state centering.**
   - `App.module.css` relies on `.content` and `.footer` being direct flex
     children of `.chatViewWrap` (for `contain: layout size style` during active
     chat, vertical centering under `.appChatEmpty .chatViewWrap`, and compact
     mobile `.mobileWelcomeGroup`). Setting `display: contents` on
     `.chatSubtree .chatSurface` keeps the exact flex tree and zero-pixel layout
     parity without duplicating or weakening any `App.css.test.ts` contract.
2. **Isolate `LiveMessageList` behind `transcriptContent`.**
   - `LiveMessageList` subscribes to `useAnimationFrameTranscriptSnapshot()`
     internally so streaming tokens never trigger a full `App.tsx` re-render.
     Passing `LiveMessageList` (plus `ConversationSearch`, `btwPanel`, and
     `mobileWelcomeGroup`) via `transcriptContent` preserves that performance
     isolation while converging all bottom decision cards and composer
     orchestration onto `ChatSurface`.
3. **Memoize `editorCommands` in `ChatSurface` to preserve `React.memo(ChatEditor)`.**
   - Spreading `[...commands]` on every `ChatSurface` render allocated a fresh
     array identity and broke `React.memo(ChatEditor)` on transcript-only
     updates. `useMemo(() => [...commands], [commands])` keeps the defensive
     copy while preserving referential stability across all `ChatSurface` hosts.
4. **Gate `mainSurfaceController` pending items on `mainView === 'chat'` and
   preserve host-level `approvalOverlayActive` hiding.**
   - When the user switches to Split View or Scheduled Tasks, the outer chat
     stays mounted but hidden; gating `pendingApprovals` and `pendingQuestions`
     on `mainView === 'chat'` guarantees no outer approval overlay mounts under
     another full-page view. `ProjectHooksApprovalCard` renders in `panels`, and
     `composerClassName` retains `styles.composerHidden` when
     `projectHooksApprovalActive` is active without a session permission card.

## Constraints

- `chat-core` modules remain strictly daemon-free (zero imports from `daemon/**`
  or `@qwen-code/sdk/daemon`) and never branch on `controller.kind`.
- No changes to daemon HTTP/SSE routes, OpenAPI schemas, storage keys, or i18n
  keys.
- Web Shell CSS scoping (`data-web-shell-root`, portal roots) and React 18/19
  `forwardRef` compatibility remain intact.
- `App.test.tsx`'s `React.memo(ChatEditor)` render-count invariant and all
  `App.css.test.ts` relayout-boundary contracts remain green.

## Validation & Acceptance Criteria

- **Unit & integration tests:**
  - `App.test.tsx`, `App.css.test.ts`, `ChatSurface.test.tsx`,
    `ChatPane.test.tsx`, `SplitView.test.tsx`, `SideTaskPanel.test.tsx`,
    `ManagedSessionsPage.test.tsx`, `useDaemonChatController.test.tsx`,
    `daemon/chat-controller.test.ts`, and `build-artifact.test.ts` all pass.
  - New regression tests cover `ChatSurface` new seams (`transcriptContent`,
    `footerRef`, `footerStyle`, `footerHeader`, `footerTrailing`, `decisionRef`,
    `questionKeyboardActive`, `dialogOpen` OR-combination, deduplicated
    `approval-overlay` testid, and `editorCommands` memo stability),
    `App.css.test.ts` `.chatSubtree .chatSurface` pin, and `App.test.tsx`
    `ChatSurface` rendering + `AskUserQuestion` submit/dismiss + single-report
    approval/mode-lock diagnostics.
- **Mutation witnesses:** Reachable new guards and seams verified red under an
  isolated mutation harness.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`,
  `eslint --max-warnings=0`, `prettier --check`, and repository
  `npm run build && npm run typecheck`.
- **Real browser Before/After E2E:** Real local Vite + Chromium (`<StrictMode>`)
  comparing unmodified `origin/main` (Before) vs switched `ChatSurface` (After)
  on the main daemon chat column (empty welcome state, active conversation with
  `ToolApproval`, `AskUserQuestion`, composer restoration, and live turn
  cancellation), verifying 0px layout drift and zero page or unexpected console
  errors.
