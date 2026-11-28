# ChatSurface Managed-Host Readiness (Slice 3c, First Increment)

[English](2026-11-24-chat-surface-managed-readiness.md) |
[简体中文](2026-11-24-chat-surface-managed-readiness.zh-CN.md)

Status: implemented (slice 3c, first increment — switch readiness). Date:
2026-11-24. Part of the [unified chat surface](2026-11-16-unified-chat-surface.md)
migration. Builds on `ChatSurface` (#17952), session-scoped locks and history
pagination (#18066, #18091), the Managed adapter core (#18117), and the
`useManagedChatController` provider binding (#18205).

## Problem Statement

`useManagedChatController` now exposes a live `SessionChatController` for a
Managed session, yet rendering `<ChatSurface controller={managedController} />`
with real transcript messages and a real composer still fails on concrete
blockers before `ManagedSessionsPage` can be switched over:

1. **`TranscriptViewport` and default `ChatEditor` toolbar actions are
   hard-wired to daemon React contexts.**
   `TranscriptViewport` unconditionally calls `useTranscriptViewport` (which
   calls `useDaemonHistoryNavigationStore()` and throws outside
   `DaemonSessionProvider`) and `useMessageDeletion` (which calls
   `useConnection`, `useActions`, `useTranscriptStore`, and `useWorkspace` and
   throws outside `DaemonSessionProvider`/`DaemonWorkspaceProvider`). Likewise,
   `ChatSurface` omitted `visibleToolbarActions` when rendering `ChatEditor`,
   which defaulted `ChatEditor` to mounting every toolbar action including
   `'voice'` (`LiveVoiceButton` + `VoiceButton`, both of which unconditionally
   call `useWorkspace()` / `useConnection()`).
   - In the standalone Managed shell (`ManagedAgentWebShell`), no daemon
     provider exists, so mounting `ChatSurface` with `transcriptState !== 'error'`
     and a real `ChatEditor` crashes immediately.
   - In the full Web Shell (`App.tsx`), `ManagedSessionsPage` mounts **inside**
     `DaemonSessionProvider` and `DaemonWorkspaceProvider`. Making the hooks
     merely optional would therefore silently attach the sibling daemon
     session's turn-navigation viewport, message-deletion toolbar, voice
     controls, and composer workspace features (`ComposerWorkspaceProvider`) to
     a Managed chat column.
2. **The shared `AskUserQuestion` card does not yet cover the Managed question
   contract.**
   - Managed questions carry `required: boolean`, `allowText: boolean`, and a
     8192-character per-answer text limit (`MAX_MANAGED_QUESTION_TEXT_LENGTH`),
     and carry no dismiss (`reject_once`/`reject_always`) wire variant.
   - `toManagedQuestionPermissionRequest` currently drops `required`,
     `allowText`, and `maxTextLength`.
   - `AskUserQuestion` currently treats every question as required (auto-selecting
     the first single-select option on visit and blocking submit until every
     question has text), always renders the free-text "Other" row (even when
     `allowText` is `false`), renders an inert "Ignore" button when no reject
     option exists in `request.options`, emits empty structured entries for
     unanswered optional questions instead of omitting them, and accepts no
     `disabled` prop (so `ChatSurface`'s `approvalDisabled` reaches
     `ToolApproval` but not `AskUserQuestion`).

## Scope

This increment closes both blockers so a real `<ChatSurface>` backed by a
Managed controller renders and operates end-to-end both standalone (no daemon
providers) and co-mounted inside a daemon host tree, without leaking daemon
context:

- **Decoupled `TranscriptViewport` with fail-closed `ChatSurface` isolation:**
  - Export `useOptionalDaemonHistoryNavigationStore()` from
    `DaemonSessionProvider.tsx` alongside `useOptionalDaemonActions()`.
  - Split `TranscriptViewport` into a live-only `<LiveTranscriptViewport>`
    (rendering `<ModRowsProvider>` + `<MessageList>` with no daemon hook calls)
    and the existing `<DaemonTranscriptViewport>`.
  - Add backend-neutral `sessionViewportEnabled?: boolean` (default `true` on
    `TranscriptViewport`; subsequently refined in
    [Slice 6c](2026-11-28-managed-host-zero-daemon-cleanup.md) to pair with an
    explicitly injected `sessionViewportComponent` rather than importing daemon
    hooks inside `TranscriptViewport.tsx`). When `sessionViewportEnabled ===
false` or no `sessionViewportComponent` is supplied, `TranscriptViewport`
    renders `<LiveTranscriptViewport>` directly without reading any daemon
    context (logging a dev-mode warning if `sessionViewportEnabled` is set
    without an injected component). When daemon hosts (`App.tsx`,
    `ChatPane.tsx`) inject `DaemonTranscriptViewport`, it checks
    `useOptionalDaemonHistoryNavigationStore()` and falls back to
    `<LiveTranscriptViewport>` when absent rather than throwing.
  - Add backend-neutral `sessionViewportEnabled?: boolean` (default `false`),
    `workspaceFeaturesEnabled?: boolean` (default `false`), and
    `visibleToolbarActions?: readonly ComposerToolbarAction[]` (default `[]`)
    to `ChatSurfaceProps` and forward them to `TranscriptViewport` and
    `ChatEditor` respectively. Fail-closed defaults guarantee that a Managed
    `ChatSurface` neither crashes outside daemon providers (for example via
    `LiveVoiceButton`/`VoiceButton`) nor leaks an ancestor
    `DaemonSessionProvider` or `ComposerWorkspaceProvider` when co-mounted in
    `App.tsx`, while future daemon column switches explicitly opt in.
    `ChatSurface` still never branches on `controller.kind`.
- **Shared `AskUserQuestion` Managed parity:**
  - Extend `toManagedQuestionPermissionRequest` to project `required`,
    `allowText`, and `maxTextLength: MAX_MANAGED_QUESTION_TEXT_LENGTH` on each
    projected question in `rawInput.questions`.
  - Teach `AskUserQuestion` to honor optional `required?: boolean` (defaults to
    `true`), `allowText?: boolean` (defaults to `true`), `maxTextLength?: number`,
    `disabled?: boolean` (defaults to `false`), and conditional cancel/Ignore
    rendering based on whether `request.options` contains a `reject_once` or
    `reject_always` option.
  - Forward `disabled={approvalDisabled}` from `ChatSurface` to
    `AskUserQuestion`.
- **Unmocked Managed `ChatSurface` integration coverage:**
  - Upgrade `chat-controller.local-integration.test.tsx` from
    `transcriptState: 'error'` to `transcriptState: 'ready'` with real rendered
    messages and no `TranscriptViewport` mock, and add co-mounted
    cross-provider isolation tests.

### Out of Scope (Deferred to Later Increments)

- Switching `ManagedSessionsPage.tsx` JSX to render `<ChatSurface>` and
  deleting `ManagedQuestionForm` (slice 3c, subsequent increment, with the
  visual before/after gate). That switch still requires wiring Managed's
  persistent pending outbox, running-turn user-message queue, side queries
  (`/btw`, `/recap`), file references, skills, multi-action selector (including
  child sessions), and toolbar sub-controllers.
- Removing the remaining transitive `daemon/**` value import from
  `TranscriptViewport.tsx` out of the standalone Managed bundle (slice 6
  boundary enforcement).
- Daemon main-column switch (rest of 2f), `ChatPane` convergence (slice 4),
  and status-stack/usage-stat parity (slice 5).
- No daemon/Java routes, OpenAPI schemas, session-id namespaces, storage keys,
  or new i18n keys.

## Design Decisions and Rationale

1. **Two-layer defense in `TranscriptViewport` (explicit gate + optional hook).**
   - Why not optional hooks alone? Inside `App.tsx`, `ManagedSessionsPage` is
     rendered beneath `DaemonSessionProvider` and `DaemonWorkspaceProvider`.
     Optional hooks alone would still resolve the sibling daemon session's
     store and attach daemon turn-navigation and message-deletion UI to a
     Managed transcript.
   - Why not the explicit gate alone? A caller rendering `<TranscriptViewport>`
     or `<ChatSurface sessionViewportEnabled />` outside a daemon provider (for
     example a standalone shell or unit test) should degrade cleanly to the
     live `<MessageList>` instead of crashing.
   - Why default `sessionViewportEnabled = true` on `TranscriptViewport` and
     `false` on `ChatSurface`? `ChatSurface` is backend-neutral so fail-closed
     defaults prevent silent cross-provider leaks without branching on
     `controller.kind`; in
     [Slice 6c](2026-11-28-managed-host-zero-daemon-cleanup.md),
     `DaemonTranscriptViewport` was extracted out of `TranscriptViewport.tsx`
     and explicitly injected via `sessionViewportComponent` by `App.tsx` and
     `ChatPane.tsx` so `TranscriptViewport.tsx` stays completely free of daemon
     imports.
2. **Optional questions (`required: false`) never fabricate an answer.**
   - Visiting or mounting an optional single-select question leaves its answer
     unset (`aria-checked="false"` across all options) instead of auto-selecting
     option 0.
   - Clicking an already-selected option on an optional single-select question
     clears the selection so a user can undo an accidental pick.
   - Arrow keys on an optional single-select question move focus/roving
     tabindex without committing an answer; `Enter` on a focused option selects
     and advances (matching multi-select), while `Next`, `ArrowRight`, `Submit`,
     and `Ctrl+Enter`/`Cmd+Enter` advance or submit without selecting.
   - Unanswered optional questions are omitted from `structuredAnswers`,
     matching `ManagedQuestionForm` and `ManagedUserQuestions.java` (which
     rejects empty answer objects carrying neither `optionIds` nor `text`).
   - All existing daemon questions omit `required` (defaulting to `true`) and
     therefore preserve their exact WAI-ARIA radiogroup auto-selection and
     validation behavior.
3. **`allowText: false` removes the free-text row completely.**
   - When `allowText` is `false`, the custom row is not rendered, roving
     tabindex and digit/Home/End bounds shrink to `options.length`, and
     `focusCustomInput` is a no-op. If both `allowText === false` and
     `options.length === 0`, keyboard navigation guards against modulo-by-zero
     and leaves focus unset cleanly.
   - When `allowText` is `true` and `options.length === 0` (text-only question),
     index `0` resolves directly to the custom input trigger so keyboard and
     pointer flows work without options.
4. **Hide the Ignore button when no reject option exists.**
   - `toManagedQuestionPermissionRequest` intentionally omits any reject option
     because the Managed wire protocol has no dismiss variant for question
     actions. Rendering the Ignore button unconditionally produced a dead
     control that did nothing on click. Gating the button on the presence of a
     `reject_once`/`reject_always` option preserves daemon behavior identically
     and removes the dead button on Managed requests.
5. **`disabled` parity on `AskUserQuestion`.**
   - `ChatSurface` already forwards `approvalDisabled` to `ToolApproval`;
     forwarding it to `AskUserQuestion` ensures session-level write locks (such
     as `respondForbidden` or pending context compression) disable both
     decision cards uniformly across clicks and keyboard shortcuts.

## Constraints and Risks

- **Zero daemon regression:** `App.tsx`, `ChatPane.tsx`, all existing
  `TranscriptViewport` tests (with `DaemonTranscriptViewport` injected via
  `sessionViewportComponent` as refined in
  [Slice 6c](2026-11-28-managed-host-zero-daemon-cleanup.md)), and all existing
  `AskUserQuestion` tests must keep their exact behavior when `required`,
  `allowText`, and `disabled` are omitted.
- **Test-mock alignment:** Four `TranscriptViewport*.test.tsx` files partially
  mock `../daemon/session/DaemonSessionProvider` with only
  `useDaemonHistoryNavigationStore`; each must also export
  `useOptionalDaemonHistoryNavigationStore` in its mock factory.
- **No new i18n keys:** Avoids locale drift and keeps the document-export
  renderer bundle size budget untouched.
- **Residual risk:** If a host mounts `<DaemonSessionProvider>` without
  `<DaemonWorkspaceProvider>` and leaves `sessionViewportEnabled={true}`,
  `useMessageDeletion` still expects `DaemonWorkspaceProvider` (unchanged from
  main). Production daemon shells always nest `DaemonSessionProvider` inside
  `DaemonWorkspaceProvider`.

## Validation Plan and Acceptance Criteria

- **Unit & integration tests:**
  - `TranscriptViewport`: renders real `<MessageList>` with no
    `DaemonSessionProvider` (no crash); with `sessionViewportEnabled={false}`
    inside a tree that _does_ provide `DaemonTurnNavigationContext`, neither
    `useTranscriptViewport` nor `useMessageDeletion` runs and daemon navigation
    UI does not appear; existing 4 `TranscriptViewport*.test.tsx` suites stay
    green.
  - `AskUserQuestion`: covers `required: false` (no auto-select, click-to-clear,
    arrow focus without commit, submit skipping optional while enforcing
    required, omitting unanswered optional entries from `structuredAnswers`),
    `allowText: false` (no custom row, bounded Arrow/Home/End/digit navigation,
    `options: []` + `allowText: false` no-NaN safety), text-only question
    (`options: []` + `allowText: true`), hiding Ignore when no reject option
    exists (and keeping it when `reject_once` exists), `disabled` blocking
    clicks and `Ctrl+Enter`/`Escape`/`Enter`/digits, and `maxLength` forwarding.
  - `ChatSurface` & `chat-controller`: verifies `sessionViewportEnabled` /
    `workspaceFeaturesEnabled` default `false` and `visibleToolbarActions`
    defaults `[]` (plus explicit opt-in forwarding), `approvalDisabled`
    forwarded to `AskUserQuestion`, `toManagedQuestionPermissionRequest`
    projects `required`/`allowText`/`maxTextLength`, and
    `chat-controller.local-integration.test.tsx` renders real `<ChatSurface>`
    with `transcriptState: 'ready'`, real messages, real `TranscriptViewport`,
    and real `ChatEditor` (zero component mocks, zero daemon providers).
- **Mutation witnesses:** Every new guard and branch verified red under an
  isolated mutation harness.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`, strict test `tsc`,
  `eslint --max-warnings=0`, `prettier --check`, and repository
  `npm run build && npm run typecheck`.
- **Real browser E2E:** Real local HTTP/SSE server + Vite + Chromium
  (`<StrictMode>`) rendering the **actual `<ChatSurface>`** driven by
  `useManagedChatController` with zero daemon providers, verifying transcript
  rendering, optional & `allowText: false` & text-only questions,
  `approvalDisabled` gating, expiry-only rerender preservation, prompt submit
  over SSE, and turn cancel over operation polling with 0 page/console errors.

## Open Questions

- Whether `ManagedSessionsPage` switch (3c.2) will surface the 32 KiB combined
  UTF-8 question-answer byte counter directly inside `AskUserQuestion` or via
  controller rejection copy; deferred until `ManagedQuestionForm` is retired.
- Whether `ChatSurface` should eventually take a typed `composerSlotProps` or
  capability-driven sub-controllers for Managed's model/approval/compression
  toolbar controls; scoped to 3c.2.
