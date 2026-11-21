# ChatSurface Component (Slice 2e)

[English](2026-11-21-chat-surface.md) |
[简体中文](2026-11-21-chat-surface.zh-CN.md)

Status: implemented (slice 2e, the surface component). Date: 2026-11-21. Part of
the [unified chat surface](2026-11-16-unified-chat-surface.md) migration. Builds
on the merged contract (#17520), status stack (#17684), intent engine (#17709),
controller assembly (#17794), and binding hook (#17895).

## Scope

The prior slices built the backend-neutral kernel and the daemon adapter, but no
component yet renders a chat column from the `SessionChatController` contract.
This slice lands **`ChatSurface`** (`chat-core/ChatSurface.tsx`), the shared chat
column renderer, plus the one contract extension it needs. It is not wired into a
column yet: the daemon main-column switch with the visual before/after gate is the
next increment (2f), so this slice is additive and renders nothing on its own.

## Design

- **One component, driven by the contract.** `ChatSurface` takes a
  `SessionChatController` and renders the chat column: the transcript
  (`TranscriptViewport`), the active tool approval (`ToolApproval`), the active
  question (`AskUserQuestion`), and the composer (`ChatEditor`). It never branches
  on `controller.kind`; a region renders only when its facts are present.
- **Render-ready pending items (contract extension).** `ToolApproval` and
  `AskUserQuestion` consume a full `PermissionRequest`, but the contract's
  `PendingApproval`/`PendingQuestion` previously carried only `{ id, status }` /
  `{ id }`. This slice adds a backend-neutral `request: PermissionRequest` (the
  shared `adapters/types` model) to both, so the surface can render them without
  reaching into a provider. The daemon binding populates it in the pending split.
- **The split keeps its per-delta optimization.** The render-ready request is
  extracted only when the content signature changes (the slice-2d ref cache), not
  on every streaming delta; the cheap block-level classifier still builds the
  signature each render.
- **Admission is not establishment, in the composer too.** `ChatEditor.onSubmit`
  dispatches `controller.submit` and clears the draft (`commitAccepted`) only on an
  `accepted` admission — never on establishment. It returns the literal `false` to
  defer `useComposerCore`'s synchronous commit **only when a commit callback is
  present** (`return commitAccepted ? false : undefined`): the commit-less entrances
  (`submitSearchMatch`, `retryLast`) read `false` as "refused, keep the text", so they
  must get `undefined` to keep their synchronous clear. Because the controller's
  `phase` is a getter over a snapshot with no reactive source here, the surface holds
  its own in-flight latch (ref + state) set synchronously on the first submit and
  cleared in `.finally`, and passes
  `submitDisabled={composerSubmitBlocked || transcriptState === 'loading' || submitInFlight || admissionLocked || phase === 'submitting'}`
  so a second Enter/click during the POST round-trip cannot dispatch a duplicate send
  even for an attachment-bearing prompt (no optimistic echo to trigger a re-render),
  while mid-turn sends stay allowed. An `unknown` admission additionally sets an
  admission payload lock (ref + state) that keeps rejecting every submit path until
  the user explicitly acknowledges via a banner (`queue.admissionUnknown` copy), since
  delivery is uncertain and the daemon may already be running the prompt — the draft
  is kept, never wiped. It reports `unknown` and `rejected` admissions and transport
  rejections through `onError` (the reported `Error` is built from a localized `chat.*`
  string with the transport error as `cause`, since the host sink displays
  `error.message`), keeping the draft on every non-accepted path. The `chat.*` strings
  carry a catalog-parity test across zh-CN/zh-TW/ru. `onCancel` dispatches
  `controller.cancel`.
  `isRunning` derives from `phase` (`submitting`/`running`/`cancelling`), so a cancel
  in flight keeps the stop affordance and the streaming indicator until settlement
  evidence arrives.
- **Approvals/questions.** The surface renders the first `pending` approval
  (superseded items are skipped) and the first pending question. `ToolApproval`
  confirmation routes to `respondApproval(id, optionId)` and **rejects** on a
  non-accepted admission (reporting through `onError`), because `ToolApproval`
  re-arms only through rejection — resolving would latch the card inert.
  `AskUserQuestion` confirmation routes by the chosen option: the submit
  (`allow_once`) option normalizes its index-keyed answers record into
  `QuestionAnswer[]` and goes to `respondQuestion`; the reject option is a decision
  vote and goes to `respondApproval` (`respondQuestion` always votes the submit
  option and cannot express a rejection). Both return `admission === 'accepted'`
  as the component's success boolean.
- **In-flow decision sheets.** A pending card renders in flow before the composer
  and replaces it (the composer is hidden and gets `dialogOpen`), so the transcript
  shrinks above the card instead of being covered by a floating overlay and the
  composer does not keep the keyboard. Approval and question keep distinct
  containers (`approval-overlay` / `question-overlay`) so both stay operable when
  pending together; `approvalOverlayActive` is passed for either.
- **Slots keep the kernel backend-neutral.** Header, backend-specific panels, the
  composer status stack, and the localized transcript-unavailable UI arrive as
  slots (`header`, `panels`, `composerStatus`, `transcriptError`). The status stack
  and usage stats need richer facts than the current conservative `statusFacts`
  (`queueLength`/`goalActive`), so the owning page supplies them until parity lands.
- **Page-supplied facts and gating.** History pagination forwards
  `hasOlderHistory`, `onLoadOlderHistory` (defaulting to `controller.loadOlder`), and
  the paired `historyPaginationError` (without it a failed older page is invisible
  and every top-scroll re-issues it). Plan facts and focus/notification gating
  arrive as props (`planTodos`, `planExecutionMode`, `approvalDisabled`,
  `approvalKeyboardActive`, `showBrowserNotifications`) because the owning page
  computes them; split-view panes pass `approvalKeyboardActive={false}` to avoid
  stealing focus (it reaches both the approval and the question card). The question
  card also receives the host's `askUserFreeTextLabel` / `askUserDetails` (the
  details escape hatch matters because the composer is hidden while a card is
  active). The composer receives `atWorkspaceCwd` / `composerScopeKey` so a new chat
  (no session id yet) still persists its draft — the draft key is scoped by the
  workspace/new-chat fact, not by `sessionId` alone and not by forwarding
  `controller.storageKey` (which `getComposerDraftStorageKey` would re-prefix). The
  default `onError` is an observable `console.error` sink, not a silent no-op.

## Deferred to later increments

- **Daemon main-column switch + visual before/after gate (2f).** `App.tsx` renders
  `ChatSurface` with the daemon binding and the duplicated inline orchestration is
  deleted; the visual preview must show no unexplained daemon-side difference.
- **Status stack / usage-stat parity (slice 5)** once `statusFacts` carries the full
  queued-prompt and goal facts.
- **Managed adapter (slice 3)** and **ChatPane convergence (slice 4)** render through
  this same component.

## Constraints respected

- `chat-core`'s own modules import no `daemon/**` or `@qwen-code/sdk/daemon` value;
  the shared components `ChatSurface` composes carry only type-only SDK imports
  (erased at build), verified across all eight.
- No daemon/Java route or OpenAPI change; session id namespaces and storage keys are
  untouched. The composer reuses the existing draft-key convention: the session
  branch keys by `sessionId`, and the new-chat branch keys by the workspace/scope
  fact (`atWorkspaceCwd` / `composerScopeKey`), so a draft persists before a session
  id exists.
- The contract extension is additive and backend-neutral; the daemon binding is the
  only populated adapter today.
