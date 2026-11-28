# Retire ManagedQuestionForm onto Shared AskUserQuestion (Slice 3c, Second Increment)

[English](2026-11-24-managed-ask-user-question-switch.md) |
[简体中文](2026-11-24-managed-ask-user-question-switch.zh-CN.md)

Status: implemented (slice 3c, second increment — Managed question card convergence).
Date: 2026-11-24. Part of the
[unified chat surface](2026-11-16-unified-chat-surface.md) migration. Builds on
`ChatSurface` Managed-host readiness (#18246), where shared `AskUserQuestion`
gained `required`, `allowText`, `maxTextLength`, conditional Ignore visibility,
and `disabled`.

## Problem Statement

`ManagedSessionsPage` already renders the shared `MessageList`, `ToolApproval`,
and `ChatEditor`, yet still renders a separate, bespoke `ManagedQuestionForm`
component for pending Managed question actions — the only remaining caller of
`ManagedQuestionForm` in the repository.

Before `ManagedSessionsPage` can retire `ManagedQuestionForm` onto shared
`AskUserQuestion` without regressing any Managed production behavior, four
concrete requirements must be preserved:

1. **Draft persistence across pending-action switches.** `useManagedActions`
   lists root and child-session pending actions together (`includeChildren`) and
   stores a per-action draft (`questionDraft` / `setQuestionDraft`) so users can
   partially answer one question, inspect another pending request or approval,
   and return without losing their draft. Shared `AskUserQuestion` currently
   keeps answers purely internal and loses them on unmount/remount.
2. **Content-stable `PermissionRequest` projection.** `ManagedSessionsPage`
   currently rebuilds `pendingApproval` in a `useMemo` that depends on
   `messages` (which changes reference on every streaming delta) and raw
   `approvals.action` (which changes reference on every poll or `expiresAt`
   refresh). Passing an uncached `toManagedQuestionPermissionRequest` result to
   `AskUserQuestion` would change `request.rawInput` and wipe the user's
   in-progress answers on every stream update or poll.
3. **Combined 32 KiB UTF-8 answer-size bound without locking the input.**
   Managed answers cannot exceed `MAX_MANAGED_QUESTION_ANSWER_BYTES` (32 KiB
   serialized UTF-8) or 8192 characters per answer. When exceeded, submission
   must be blocked with the localized `managed.question.tooLarge` alert while
   keeping the text input editable so the user can shorten their answer.
4. **Live expiry gating.** When a pending question's `expiresAt` passes (either
   on mount or while open via a bounded timeout), the card must become disabled,
   block submission (including a submit-time `Date.now() >= action.expiresAt`
   check), and display the localized `managed.question.expired` status line.

## Scope

- **Backend-neutral draft and submit-block seams on `AskUserQuestion`:**
  - Export `AskUserQuestionDraft` (`Record<string, { optionIds: string[]; text: string }>`)
    and accept optional `initialDraft?: AskUserQuestionDraft`,
    `onDraftChange?: (draft: AskUserQuestionDraft) => void`, and
    `submitDisabled?: boolean` (defaults to `false`).
  - Hydrate `answers`, `selectedMulti`, `customInputs`, and initial `selectedIdx`
    synchronously in lazy `useState` initializers (and on subsequent
    `(questions, request.id)` identity changes) from `initialDraft`, preventing
    any first-frame blank-draft flash under React 19 `StrictMode` and avoiding
    auto-selecting option 0 when a single-select question already has hydrated
    custom text.
  - Emit draft changes via a commit-phase `useEffect` gated on a dirty flag (no
    passive emission on mount, no parent state updates inside React state
    updaters, and a ref-held `onDraftChange` so inline host callbacks never
    trigger spurious re-runs).
  - Apply `submitDisabled` strictly to submission paths (Submit button,
    `Ctrl+Enter`/`Cmd+Enter`, and final-question `Enter` submit) while keeping
    option controls and text inputs editable.
  - Support optional `multilineText?: boolean` on `Question` (projected as
    `true` by `toManagedQuestionPermissionRequest`, omitted / `false` for
    single-line daemon questions). When `multilineText` is `true` or the
    current custom value already contains `\n`, render a `<textarea>` (with
    `Shift+Enter` inserting newlines and bare `Enter` advancing/submitting) and
    `white-space: pre-wrap` on the collapsed trigger so multi-line custom
    answers round-trip across draft restore and edits without silently
    collapsing line breaks.
- **Switch `ManagedSessionsPage` from `ManagedQuestionForm` to shared `AskUserQuestion`:**
  - Move `ManagedQuestionDraft` and `MAX_MANAGED_QUESTION_TEXT_LENGTH` (re-exported
    by `chat-controller.ts` for a single source of truth) to
    `managed-question-response.ts` so `use-managed-actions.ts` has zero
    dependency on the retired form.
  - Project pending Managed questions through `toManagedQuestionPermissionRequest`
    behind a content-signature cache (keyed by action identity, revisions, and
    serialized questions, explicitly excluding `expiresAt` and independent of
    `messages`).
  - Render shared `<AskUserQuestion>` keyed by `managedActionKey(action)` with
    `variant="floating"`, `keyboardActive={false}`,
    `customInputLabel={t('managed.question.other')}`,
    `initialDraft={approvals.questionDraft}`,
    `onDraftChange`, `disabled` (forbidden / submitting / compression-blocked /
    expired), `submitDisabled={questionTooLarge}`, and `onConfirm` routing
    canonical structured answers through `approvals.respond` (returning `true`
    on completion and letting retryable rejections reset `AskUserQuestion`'s
    submitting state while preserving answers and idempotency key).
  - Render `managed.question.expired` (`role="status"`) and
    `managed.question.tooLarge` (`role="alert"`) beside the card, backed by a
    32-bit-safe expiry timeout.
- **Retire `ManagedQuestionForm` and orphan i18n key:**
  - Delete `ManagedQuestionForm.tsx` and `ManagedQuestionForm.test.tsx`, migrating
    every unique contract test (duplicate/comma option identity, option order,
    untrimmed custom text, refresh-stability, failed-delivery retry with same
    idempotency key, duplicate-submission fencing, forbidden/expired/32 KiB
    UTF-8 bounds) into `AskUserQuestion.test.tsx` and
    `ManagedSessionsPage.test.tsx`.
  - Remove the now-unused `'managed.question.title'` key from all four locale
    catalogs (`i18n.tsx`, `i18n-zh-cn.ts`, `i18n-zh-tw.ts`, `i18n-ru-part1.ts`).

### Out of Scope (Deferred to Later Increments)

- Replacing `ManagedSessionsPage`'s outer chat column JSX with `<ChatSurface>`
  (slice 3c.3), which requires sharing `useManagedSession` / `useManagedActions`
  / `useManagedTurnCancel` state without opening duplicate SSE streams and
  providing typed transcript/composer host seams on `ChatSurface`.
- Daemon main-column switch (rest of 2f), `ChatPane` convergence (slice 4),
  status-stack/usage-stat parity (slice 5), and bundle boundary enforcement
  (slice 6).
- No daemon/Java routes, OpenAPI schemas, session-id namespaces, or storage
  keys changed.

## Design Decisions and Rationale

1. **`initialDraft` + commit-phase `onDraftChange` instead of fully controlled internal state.**
   - `AskUserQuestion` owns rich keyboard state (roving tabindex, custom focus,
     multi-question pagination, single-select auto-selection). Replacing that
     state with a fully controlled external draft on every render would tangle
     keyboard focus management with parent re-renders and risk regressions on
     daemon callers.
   - Hydrating from `initialDraft` on `(questions, request.id)` mount/reset
     (with `key={managedActionKey(action)}` on action switch) and pushing user
     edits out in a commit-phase `useEffect` preserves 100% of daemon behavior,
     survives React 19 StrictMode cleanly, and keeps cross-action draft
     switching working identically.
2. **Separate `submitDisabled` from `disabled`.**
   - When combined UTF-8 answers exceed 32 KiB, locking all controls via
     `disabled` would trap the user unable to backspace their input.
     `submitDisabled` blocks only submission while leaving edits open.
3. **Content-keyed cache for `toManagedQuestionPermissionRequest` in `ManagedSessionsPage`.**
   - Decouples the projected question request's object identity from `messages`
     and `expiresAt`, preventing streaming deltas and poll refreshes from
     resetting `AskUserQuestion`'s local state and current question index.
4. **32-bit timeout guard on the expiry timer.**
   - Clamping `expiresAt - Date.now()` avoids immediate firing if a server sets
     an expiry beyond Node/browser `setTimeout`'s 32-bit signed max (~24.8 days).
5. **Visual Before/After gate.**
   - Because Managed questions transition from the stacked `ManagedQuestionForm`
     to the unified floating `AskUserQuestion` card, real Chromium Before/After
     screenshots anchored to the same live Managed session state verify visual
     layout and interactivity before landing.

## Constraints and Risks

- **Zero daemon regression:** When `initialDraft`, `onDraftChange`, and
  `submitDisabled` are omitted, `AskUserQuestion` behaves identically for every
  daemon caller.
- **Step-by-step vs stacked UX change:** Shared `AskUserQuestion` presents
  multi-question actions one question at a time (`1/2 questions`, `previous` /
  `next`) with keyboard navigation, matching Daemon. Existing tests in
  `ManagedSessionsPage.test.tsx` that queried stacked `<textarea>` elements are
  updated to drive the unified `AskUserQuestion` card while preserving every
  assertion on wire payloads, idempotency keys, retries, and child-action draft
  isolation.
- **Locale consistency:** Removing `'managed.question.title'` across all four
  catalogs avoids orphaned keys and keeps `i18n.test.ts` parity intact.

## Validation Plan and Acceptance Criteria

- **Unit & integration tests:**
  - `AskUserQuestion.test.tsx`: covers `initialDraft` hydration (single-select
    option id, single-select custom text without option-0 auto-select,
    multi-select options + custom text, invalid/unknown option ids ignored),
    `onDraftChange` commit-phase emission (no passive mount emission, tracks
    option toggle / custom text / clear, inline callback stability), and
    `submitDisabled` blocking Submit button, `Ctrl+Enter`, and final-question
    `Enter` while keeping options and custom input editable.
  - `ManagedSessionsPage.test.tsx`: verifies root and child Managed questions
    render shared `AskUserQuestion` (no `ManagedQuestionForm`, no approval
    buttons, no dead Ignore button), preserve answers on streaming/poll refresh
    and failed delivery with identical idempotency key on retry, preserve
    per-action drafts across `child-a` / `child-b` / permission switches, fence
    duplicate submissions, enforce 32 KiB UTF-8 `role="alert"` +
    `submitDisabled` while keeping input editable, and enforce live expiry
    `role="status"` + disabled card.
  - `use-managed-actions.test.tsx`, `chat-controller.local-integration.test.tsx`,
    `i18n.test.ts`, and `build-artifact.test.ts` all pass.
- **Mutation witnesses:** Reachable guards and branches (initial and
  in-place request-change draft hydration, commit-phase draft emission,
  passive-mount silence, custom-text auto-select suppression,
  `submitDisabled` without locking inputs, multi-line `<textarea>` and
  `Shift+Enter` preservation, content-signature request cache, 32 KiB UI
  limit, expiry-at-load, submit-time clock-jump expiry check, and live expiry
  timer) verified red under an isolated mutation harness. The redundant
  submit-time `exceedsManagedQuestionAnswerLimits` check inside `onConfirm`
  sits behind the UI `submitDisabled={questionTooLarge}` guard as defense in
  depth.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`, strict test `tsc`,
  `eslint --max-warnings=0`, `prettier --check`, repository
  `npm run build && npm run typecheck`.
- **Real browser Before/After E2E:** Real local HTTP/SSE server + Vite +
  Chromium (`<StrictMode>`) mounting `ManagedSessionsPage` on unmodified
  `origin/main` (Before) and after the change (After), verifying multi-question
  answering, child-action draft switching, expiry-only refresh preservation,
  32 KiB guard, retry on 503 with same idempotency key, and visual inspection
  of Before/After screenshots with 0 page/console errors.

## Open Questions

- Slice 3c.3 will decide the cleanest shared-state seam so `ManagedSessionsPage`
  and `useManagedChatController` share one `useManagedSession` /
  `useManagedActions` / `useManagedTurnCancel` instance without duplicating SSE
  streams or polling when adopting `<ChatSurface>`.
