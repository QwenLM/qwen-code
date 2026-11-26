# Switch ManagedSessionsPage Chat Column onto Shared ChatSurface (Slice 3c, Third Increment)

[English](2026-11-26-managed-page-chat-surface-switch.md) |
[简体中文](2026-11-26-managed-page-chat-surface-switch.zh-CN.md)

Status: implemented (slice 3c, third increment — ManagedSessionsPage ChatSurface switch).
Date: 2026-11-26. Part of the
[unified chat surface](2026-11-16-unified-chat-surface.md) migration. Builds on
`ChatSurface` Managed-host readiness (#18246) and retiring `ManagedQuestionForm`
onto shared `AskUserQuestion` (#18273).

## Problem Statement

With #18273 merged, `ManagedSessionsPage` already renders all four shared chat
primitives (`MessageList`, `ToolApproval`, `AskUserQuestion`, and `ChatEditor`),
yet it still orchestrates them inline instead of rendering the shared
backend-neutral `<ChatSurface>` backed by the Managed adapter.

Three concrete seams must close for `ManagedSessionsPage` to render
`<ChatSurface>` directly without opening duplicate SSE streams, losing child
session action isolation, or regressing Managed's durable outbox and layout:

1. **Sharing live Managed hooks without duplicate streams.**
   `useManagedChatController` currently instantiates its own private
   `useManagedSession`, `useManagedActions`, and `useManagedTurnCancel`.
   Because `ManagedSessionsPage` already owns those hooks for its sidebar,
   header, recovery verdicts, worktree status, panels, and sub-controllers,
   calling `useManagedChatController` directly would open a second SSE stream
   and duplicate `/sessions/get`, `/transcript/query`, and `/actions/query`
   polling for the same session.
2. **Child-session action identity and expired-action display parity.**
   `ManagedSessionsPage` displays root and child-session pending actions
   together (where two child sessions can share the same `actionId`) and keeps
   an expired action visible in a disabled state alongside the localized
   `managed.question.expired` status line. `createManagedChatController`
   currently keys its projection cache by bare `actionId` alone, passes root
   `messages` into every approval projection, and hides expired actions from
   pending projections.
3. **Backend-neutral host seams on `ChatSurface`.**
   `ManagedSessionsPage` supplies page-owned transcript props (`welcomeHeader`,
   `onToolResultOpen`, `showRetryHint`, `tailContent`, `hideSessionTimeline`),
   decision chrome (multi-action switcher, child-source label, expiry/size/
   argument caveats, `managed-approval` container test id), composer props
   (model/mode/plan/context/skills/file-references/attachments/placeholder),
   durable pending-command submission (with `/btw`, `/recap`, user-message
   queue, and IndexedDB outbox), layout wrapper classes preserving
   `[data-managed-home][data-managed-empty]` centering, and keeping the
   composer visible while a pending decision card is open.

## Scope

- **`use-managed-actions.ts`:**
  - Accept an optional third `observer?: ManagedAgentOperationObserver`
    parameter on `respond` and forward it into `provider.actions.respond(...)`.
  - Return `Promise<boolean>` (`true` when the response succeeded or a terminal
    `endedAction` closed the card; `false` when early-returned as not pending
    or already in flight; throws on retryable errors as before).
- **`chat-controller.ts`:**
  - Key `pendingProjection.requests` by `${action.sessionId}:${action.actionId}`
    so child sessions sharing an `actionId` never collide.
  - Pass `action.sessionId === deps.sessionId ? messages : []` into
    `toManagedPermissionRequest` so root messages never bleed into child-session
    approval previews.
  - Add optional `retainExpiredActions?: boolean` (default `false`) to
    `ManagedChatControllerDeps`. When `true`, expired actions stay visible in
    `pendingApprovals`/`pendingQuestions` for disabled UI display while
    `respondApproval`/`respondQuestion` still reject expired submissions
    fail-closed.
- **`use-managed-chat-controller.ts`:**
  - Export `useManagedChatControllerFromState(options)` accepting caller-owned
    `detail`, `pending`, `turnCancel`, and a shared `cancelObserverRef` (plus
    `messages`, the single `selectedAction` currently shown by the host,
    `retainExpiredActions`, `canRespondAction`, `canCancel`), so
    `ManagedSessionsPage` binds a live `SessionChatController` with zero
    duplicate SSE streams or polling. Keeping `selectedAction` singular makes
    bare-`actionId` submission routing unambiguous by construction even when
    multiple child sessions share an `actionId`.
  - Route approval and question submissions through `pending.respond(action,
response, observer)` so `useManagedActions` state (`submitting`,
    `answerError`, `respondForbidden`, draft clearing, answered filtering) and
    controller admission/settlement stay synchronized through one transport
    call, accepting `action.sessionId` for child-session actions.
  - Preserve standalone `useManagedChatController({ provider, clientId,
sessionId })` with identical public contract and strict admission semantics.
- **`ChatSurface.tsx`:**
  - Add backend-neutral host seams actively consumed by `ManagedSessionsPage`
    (zero dead switches): `className`, `transcriptClassName`,
    `transcriptProps`, `decisionClassName`, `decisionTestId`, `decisionHeader`,
    `decisionFooter`, `approvalKey`, `approvalExtraDescriptionId`,
    `questionKey`, `askUserInitialDraft`, `askUserOnDraftChange`,
    `askUserSubmitDisabled`, `hideComposerWhenCardActive` (default `true`),
    `composerClassName`, `composerVisible` (default `true`), `composerKey`,
    `composerRef`, `composerContainerRef`, `composerFooter`,
    `composerCancelEnabled` (default `true`), `onComposerSubmit`, and
    `composerProps`.
  - Existing callers omitting these optional props retain 100% unchanged
    behavior. `ChatSurface` still never branches on `controller.kind`.
- **`ManagedSessionsPage.tsx`:**
  - Render `<ChatSurface>` backed by `useManagedChatControllerFromState` for
    all chat column states outside the `!sessionId && provider.workspaceBinding`
    workspace-binding creator.
  - Delete inline `<MessageList>`, `<ToolApproval>`, `<AskUserQuestion>`,
    `<ChatEditor>`, duplicate `pendingQuestionRequest`/`pendingApproval`
    projection memos, and the inline `cancel` callback; `ManagedSessionsPage`
    no longer imports `MessageList`, `ToolApproval`, `AskUserQuestion`,
    `ChatEditor`, `toManagedPermissionRequest`, or
    `toManagedQuestionPermissionRequest` directly.

### Out of Scope (Deferred to Later Increments)

- Moving `ManagedSessionsPage`'s durable pending-command outbox (`pendingHere`,
  `pendingElsewhere`, `managed-pending-storage.ts`, `/btw`, `/recap`,
  `userMessages` queue) inside `useManagedChatController` itself (remains
  hosted via `onComposerSubmit` until a follow-up convergence pass).
- Daemon main-column switch (`App.tsx`, rest of 2f), `ChatPane` convergence
  (slice 4), status-stack/usage-stat parity (slice 5), and slice 6 bundle
  boundary enforcement.
- No daemon/Java routes, OpenAPI schemas, storage keys, or i18n keys changed.

## Design Decisions and Rationale

1. **Shared-state hook `useManagedChatControllerFromState` alongside standalone `useManagedChatController`.**
   - Avoids duplicating `useManagedSession` (SSE + transcript fetches),
     `useManagedActions` (polling + child actions + drafts + forbidden latch),
     and `useManagedTurnCancel` (persisted cancel intent + operation polling)
     without violating React's Rules of Hooks or altering the strict standalone
     3b contract.
2. **Single transport call for action responses via `pending.respond(action, response, observer)`.**
   - Keeps `useManagedActions`'s forbidden-session latch, error banner, draft
     clearing, and answered-key tracking synchronized with the controller's
     intent ledger and operation settlement observations. When a test mock
     `provider.actions.respond` resolves cleanly without invoking `onAccepted`,
     `useManagedChatControllerFromState` treats the completed call as admitted
     (still never forging `established` without an `onSettlement` event), while
     standalone `useManagedChatController` preserves its strict `unknown` rule.
3. **Retain expired actions in UI projection (`retainExpiredActions: true`) while disabling both permissions and questions and rejecting submission fail-closed.**
   - Preserves Managed's UX (showing `managed.question.expired` for questions
     and `managed.actions.expired` for permissions alongside disabled controls
     backed by a shared 32-bit-safe expiry timer) while keeping the
     controller's submit-time `isActionExpired` invariant intact (including
     wall-clock jump protection).
4. **Preserve layout classes and `onComposerSubmit` seam.**
   - Forwarding `shellStyles.content` and `shellStyles.footer` preserves the
     existing `[data-managed-home][data-managed-empty]` centering and
     `--chat-shell-width` rules with zero visual regression.
   - Keeping `ManagedSessionsPage`'s durable IndexedDB outbox + `/btw` +
     `/recap` + `userMessages` queue behind `onComposerSubmit` avoids
     conflicting with `ChatSurface`'s transient `admission-locked-banner` and
     keeps `managed-draft-retry.spec.ts` intact.

## Constraints and Risks

- **Zero regression on existing `ChatSurface` callers and tests:** All new
  `ChatSurface` props are optional and default to exact existing behavior
  (`hideComposerWhenCardActive = true`, `composerVisible = true`,
  `composerCancelEnabled = true`).
- **Zero duplicate network traffic:** Verified by asserting `getSession`,
  `getTranscript`, `subscribeEvents`, and `actions.listPending` call counts in
  `ManagedSessionsPage.test.tsx` and real HTTP/SSE Chromium verification.
- **Visual parity:** Verified with real Chromium Before/After screenshots of
  `ManagedSessionsPage` anchored to the same live session DOM.

## Validation Plan and Acceptance Criteria

- **Unit & integration tests:**
  - `ManagedSessionsPage.test.tsx` (all 262+ existing tests stay green, plus
    new assertions verifying `<ChatSurface>` (`[data-testid="chat-surface"]`)
    is rendered, zero duplicate `subscribeEvents`/`listPending` calls, and
    cancel routes through `ChatSurface` → `controller.cancel()`).
  - `use-managed-chat-controller.test.tsx`: standalone 22 tests unchanged + new
    tests for `useManagedChatControllerFromState` (shared hooks without
    duplicate subscriptions, child-session action respond + settlement,
    `canRespondAction` block, `retainExpiredActions` display + fail-closed
    reject, `canCancel: false` gate).
  - `chat-controller.test.ts`: child-session same-`actionId` cache separation,
    child-session approval excluding root `messages`, and
    `retainExpiredActions: true` projecting expired action while rejecting
    `respondApproval`/`respondQuestion`.
  - `ChatSurface.test.tsx`: tests all newly added host seams (`transcriptProps`,
    `decisionHeader`/`decisionFooter`/`decisionTestId`, `askUser*`,
    `hideComposerWhenCardActive={false}`, `composerVisible={false}`,
    `composerCancelEnabled={false}`, `onComposerSubmit`, `composerProps`,
    `composerFooter`).
  - `use-managed-actions.test.tsx`, `chat-controller.local-integration.test.tsx`,
    `build-artifact.test.ts`.
- **Mutation witnesses:** Reachable new guards and branches verified red under
  an isolated mutation harness.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`, strict test `tsc`,
  `eslint --max-warnings=0`, `prettier --check`, repository
  `npm run build && npm run typecheck`.
- **Real browser Before/After E2E:** Real local HTTP/SSE server + Vite +
  Chromium (`<StrictMode>`) mounting `ManagedSessionsPage` Before (unmodified
  `a3560a089b01`) and After (rendering `<ChatSurface>`), verifying visual
  layout parity, single SSE connection count (`=== 1`), multi-question child
  draft round-trip with newlines, 503 retry with identical `idempotencyKey`,
  32 KiB limit, live expiry, prompt submit, and turn cancel through
  `<ChatSurface>` with 0 page errors and 0 unexpected console errors.

## Open Questions

- Follow-up convergence can move Managed's persistent pending-command outbox
  and user-message queue into the controller layer so `onComposerSubmit` is no
  longer needed, and can converge `App.tsx` (2f) and `ChatPane.tsx` (slice 4)
  onto the same `ChatSurface` host seams.
