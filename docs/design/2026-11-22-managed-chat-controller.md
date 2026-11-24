# Managed Chat Controller Adapter Core (Slice 3a)

[English](2026-11-22-managed-chat-controller.md) |
[简体中文](2026-11-22-managed-chat-controller.zh-CN.md)

Status: implemented (slice 3a — managed adapter core). Date: 2026-11-22. Part of
the [unified chat surface](2026-11-16-unified-chat-surface.md) migration. Builds
on the merged contract (#17520), daemon adapter and `ChatSurface` (#17684,
#17709, #17794, #17895, #17952, #18066, #18091).

## Scope

This slice introduces the pure, dependency-injected Managed adapter core under
`packages/web-shell/client/components/managed/`, building on the existing
`components/managed/chat-capabilities.ts` (landed in slice 1) and mirroring
`client/daemon/chat-controller.ts` without importing any `daemon/**` module:

- **`components/managed/chat-capabilities.ts`** — adds
  `managedCapabilitiesFromSummary(...)` on top of the existing exhaustive
  `MANAGED_CHAT_CAPABILITY_MAP` and tri-state `isManagedCapabilityOn`.
- **`components/managed/chat-controller.ts`** — `createManagedChatController(deps)`
  implementing `SessionChatController` (`kind: 'managed'`), plus pure helpers
  `mapManagedPhase`, `mapManagedOperationStatus`,
  `toManagedQuestionPermissionRequest`, and `normalizeManagedQuestionAnswers`.
- **Daemon follow-up pin** — closes the non-blocking P3 review note from #18091
  in `daemon/useDaemonChatController.test.tsx`, pinning the
  `!settledDuringSubmit.has(accepted.promptId)` guard so a prompt that settles
  before `submitPrompt` resolves is never seeded into rebuilt controllers.
- **Structured question hand-off** — carries question and option `id`s through
  `QuestionAnswer`, `ChatSurface`, and the shared `AskUserQuestion` card, whose
  existing `Record<string, string>` answers remain available for legacy hosts.

This increment is additive: `ManagedSessionsPage` is not switched yet. The React
binding hook (`useManagedChatController`) and the `ManagedSessionsPage` switch
(with the visual before/after gate) belong to slices 3b and 3c.

## Design

### Capability projection (`components/managed/chat-capabilities.ts`)

`managedCapabilitiesFromSummary` derives `ChatCapabilities` from
`ManagedAgentSessionSummary['capabilities']` using the existing exhaustive
`MANAGED_CHAT_CAPABILITY_MAP` and `isManagedCapabilityOn` (strict `=== true`,
because `terminal` is tri-state `boolean | null | undefined`):

- `modelChange` → `modelSelection`
- `approvalModeChange` → `approvalSelection`
- `contextCompression` → `contextUsage`
- `tasks`, `childAgents` → `tasks`
- `artifacts` → `artifacts`
- `diagnostics` → `diagnostics`
- `terminal` → `terminal`
- `canRename`, `sessionClose`, `sessionArchive`, `sessionUnarchive`,
  `sessionDelete` → `sessionOps`

All other flags (`canSend`, `canCancel`, `actions`, `workspaceTurns`,
`inputAttachments`, `btw`, `recap`, `clientFiles`) map to `[]`.

### Pure controller assembly (`components/managed/chat-controller.ts`)

`createManagedChatController(deps)` translates managed session state, pending
actions, and Java command operations into `SessionChatController`:

- **Phase projection (`mapManagedPhase` + `deriveChatPhase`).** Exhaustively
  maps all 10 `ManagedAgentSessionPhase` values (`created`/`completed`/`cancelled`
  → `'idle'`, `failed` → `'failed'`, `cancelling` → `'cancelling'`, active
  runtime/tool phases → `'running'`), while combining with `operations` so any
  non-terminal `cancel` (including `unsettled` after `recovery_blocked`) lifts a
  running session to `'cancelling'` and an unadmitted in-flight `submit` lifts
  an idle/failed session to `'submitting'`.
- **Admission ≠ establishment.** Each of `submit`, `cancel`, `respondApproval`,
  and `respondQuestion` dispatches through `deps.*` returning a
  `ManagedTransportAdmission`. A `'rejected'` admission is not tracked and omits
  `outcome` (matching `contract.ts` and the daemon adapter); an `'unknown'` or
  thrown transport removes the tracked row so `phase` never latches. An
  `'accepted'` admission carries `outcome: 'unsettled'`: a still-`'pending'`
  `submit` then transitions to `'running'`, matching the daemon adapter's
  admitted-turn phase. Partial recovery (`'recovery_blocked'` → `'unsettled'`)
  is not promoted back to running by a later transport admission, and
  establishment still requires authoritative settlement evidence via
  `subscribeOperationSettlement`
  (`completed` → `'established'`, `failed`/`cancelled` → `'failed'`,
  `recovery_blocked` → `'unsettled'`), `subscribeTurnSettlement` (projected per
  kind: a turn completing on its own fails a bound `cancel`), or
  `subscribeActionSettlement` (`resolved` → `'established'`,
  `expired`/`superseded`/`failed` → `'failed'`). Already-terminal rows never
  absorb a later settlement. Operations buffer a settlement with no active row
  only while a dispatch is in flight; turns buffer while a dispatch is in flight
  because a submit's `turnId` is unknown until its transport response; actions
  buffer only while their own `actionId` is in `inFlightActionIds`. Every
  operation, turn, and action buffer entry records the newest dispatch sequence
  at arrival. Only an attempt already started at that sequence can consume it
  on bind, so an early settlement while the matching transport is pending
  remains usable, but a rejected attempt's action evidence cannot be consumed
  by a later retry when another dispatch keeps the drain open. The turn buffer
  still serves an unbound in-flight cancel even when its shared submit row was
  active. Buffered operation/action entries are deleted on consumption;
  all three buffers clear when all in-flight dispatches drain.
- **Turn-scoped cancel with per-target retention.** `cancel()` fails closed when
  `deps.activeTurnId` is `undefined` (managed cancel requires a `turnId`),
  captures `cancelTarget = deps.activeTurnId` at dispatch time, keeps the
  retained operation's target bare `{ sessionId }` so `retainOperations` keeps
  at most one terminal entry per `(kind, target)` (one terminal row per session
  for `submit` and `cancel`, and one per `requestId` for `approval` and
  `question`, matching the daemon adapter), and stamps `turnId: cancelTarget`
  onto the returned `IntentResult.target` copy so `ChatSurface`'s turn-scoped
  cancel guard works identically for managed sessions.
- **Pending permissions and questions.** Expired actions (`expiresAt <= now`,
  using optional `deps.now` defaulting to `Date.now`) are filtered out at both
  projection getters and rejected by `respondApproval`/`respondQuestion`. Both
  projection getters share a content-keyed snapshot of the action id, kind,
  revisions, expiry, and complete render-ready request. Re-emitted pending
  actions with identical content preserve array and `rawInput` identities so
  parent renders do not reset the question card; genuine content changes
  rebuild the relevant request, while expiry still filters every access, so
  caching cannot retain an expired action. Permission actions (`kind !== 'question'`) reuse
  `toManagedPermissionRequest(action, messages)`. Question actions
  (`kind === 'question'`) project through `toManagedQuestionPermissionRequest`
  into the `PermissionRequest` shape consumed by `ChatSurface`'s shared
  `AskUserQuestion` card with question and option `id`s and only the
  `allow_once` `'submit'` option (the managed question wire format carries no
  string-option dismiss variant, so `respondApproval` fails closed on question
  actions). The card retains its legacy `Record<string, string>` answer
  argument for existing hosts and additionally supplies structured
  `QuestionAnswer`s when backend ids are available, keeping selected
  `optionIds` separate from free `text`, including text equal to another
  option's label and labels with boundary commas. `ChatSurface` forwards those
  structured answers without re-decoding labels. `normalizeManagedQuestionAnswers`
  strictly validates structured ids, duplicates, cardinality, `allowText`,
  `required`, and the 8192-char per-answer text limit, then routes through
  `canonicalQuestionAnswers` for canonical ordering and the 32 KiB
  `MAX_MANAGED_QUESTION_ANSWER_BYTES` cap. Legacy callers without ids still use
  unique-match single-select and bounded O(k·|options|) multi-select DP, with
  identical comma normalization on both comparison sides and fail-closed
  duplicate-label/join-collision handling (`Alpha` + `Beta` vs `Alpha, Beta`);
  unmatched flat-string `option, free text` payloads remain verbatim `text`
  only when `allowText` is true. Both `respondApproval` and `respondQuestion`
  also fail closed on unknown or expired action ids, invalid options, and
  in-flight or live non-terminal decision rows for the same `actionId`
  (`hasLiveAction`, matching the daemon adapter's `hasLiveDecision` so an
  action cannot be decided twice while a terminal `failed` row permits retry).
- **Snapshot stability and lifetime.** `operations` is memoized into a frozen
  array rebuilt only when tracked state changes. Rebuilds apply
  `retainOperations` and filter the internal `tracked` log by those retained
  ids, mirroring the daemon core: every non-terminal entry remains while
  superseded terminal rows are removed instead of growing without bound. All settlement subscriptions
  are released when `deps.signal` aborts, and skipped synchronously if
  `deps.signal?.aborted` is already true at construction.

## Constraints respected

- Zero `daemon/**` imports in `components/managed/chat-capabilities.ts` and
  `components/managed/chat-controller.ts`.
- No daemon↔Java protocol translation: the adapter translates Java's native
  summary/action/operation shapes directly into `SessionChatController`.
- No Java route, OpenAPI, session-id namespace, or storage-key change.
- Additive: no production page renders through `createManagedChatController`
  yet; visual before/after verification belongs to the page switch (slice 3c).

## Validation

- `components/managed/chat-capabilities.test.ts` covers empty/null/disabled
  inputs and one-hot mapping for every mapped `ManagedCapabilityKey` plus strict
  `terminal === true` handling.
- `ChatSurface.test.tsx`, `AskUserQuestion.test.tsx`, and
  `components/managed/chat-controller.test.ts` pin the structured hand-off,
  including a selected `Dry run` id plus separately typed `Verbose`, while all
  pre-existing legacy three-argument submissions remain unchanged.
- `components/managed/chat-controller.test.ts` covers exhaustive
  phase/operation-status mappings, accepted-submit running transitions,
  attempt-scoped settlement buffering
  (including own-action settlement, rejected transport, and both approval and
  question retries), live one-hot pagination +
  `loadOlder({ force: true })`, permission/question projection, question answer
  normalization and fail-closed rejections, submit/cancel/approval/question
  admission vs settlement (including buffered early settlements,
  `recovery_blocked`, dispatch-time cancel `turnId` stamping, turn-completed
  cancel failure, concurrent duplicate refusal), snapshot identity stability,
  and `AbortSignal` cleanup. Content-identical fresh pending snapshots preserve
  projection identity, real option changes invalidate it, and advancing the
  clock still expires actions.
- `components/managed/chat-controller.local-integration.test.tsx` mounts the
  actual `ChatSurface`, shared question card, and Managed controller. It drives
  navigation, selection, and free-text input through the DOM, forces a real
  parent re-render while preserving the selected option, and asserts the exact
  transport payload; only the out-of-scope daemon transcript/editor hosts
  are isolated. The Java provider binding remains slice 3b, so this is not a
  live Java service test.
- `daemon/useDaemonChatController.test.tsx` adds the P3 race test pinning
  `!settledDuringSubmit.has(accepted.promptId)`.
- All tests green; both web-shell type projects (`tsconfig.lib.json`,
  `tsconfig.json`) exit 0; ESLint and Prettier clean.

## Deferred (slices 3b–3c and later)

- **Slice 3b — `useManagedChatController` binding hook** wiring
  `useManagedSession`, `useManagedPendingActions`, and `ManagedAgentProvider`
  into `createManagedChatController`.
- **Slice 3c — `ManagedSessionsPage` switch onto `ChatSurface`** with the
  browser before/after visual gate (first real UI convergence across both modes).
  Before switching, teach the shared `AskUserQuestion` card `required` and
  `allowText` so optional questions can be skipped and `allowText: false`
  questions do not show a free-text input that the adapter rejects. Structured
  option ids and separate free text are already carried by this slice.
- **Daemon main-column switch (rest of 2f)**, **ChatPane convergence (slice 4)**,
  **status-stack parity (slice 5)**, and **boundary guards (slice 6)**.
