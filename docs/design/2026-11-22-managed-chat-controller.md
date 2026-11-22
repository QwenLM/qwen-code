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
  runtime/tool phases → `'running'`), while combining with `operations` so an
  in-flight `cancel` lifts a running session to `'cancelling'` and an in-flight
  `submit` lifts an idle/failed session to `'submitting'`.
- **Admission ≠ establishment.** Each of `submit`, `cancel`, `respondApproval`,
  and `respondQuestion` dispatches through `deps.*` returning a
  `ManagedTransportAdmission`. A `'rejected'` admission is not tracked; an
  `'unknown'` or thrown transport abandons the tracked row so `phase` never
  latches. An `'accepted'` admission stays `'pending'` (`outcome: 'unsettled'`)
  until authoritative settlement evidence arrives via
  `subscribeOperationSettlement` (`completed` → `'established'`,
  `failed`/`cancelled` → `'failed'`, `recovery_blocked` → `'unsettled'`),
  `subscribeTurnSettlement` (projected per kind: a turn completing on its own
  fails a bound `cancel`), or `subscribeActionSettlement` (`resolved` →
  `'established'`, `expired`/`superseded`/`failed` → `'failed'`). Settlements
  that arrive while a transport call is still in flight are buffered and applied
  immediately when admission resolves.
- **Turn-scoped cancel with bounded retention.** `cancel()` fails closed when
  `deps.activeTurnId` is `undefined` (managed cancel requires a `turnId`),
  captures `cancelTarget = deps.activeTurnId` at dispatch time, keeps the
  retained operation's target bare `{ sessionId }` so `retainOperations` stays
  bounded per session, and stamps `turnId: cancelTarget` onto the returned
  `IntentResult.target` copy so `ChatSurface`'s turn-scoped cancel guard works
  identically for managed sessions.
- **Pending permissions and questions.** Permission actions (`kind !== 'question'`)
  reuse `toManagedPermissionRequest(action, messages)`. Question actions
  (`kind === 'question'`) project through `toManagedQuestionPermissionRequest`
  into the `PermissionRequest` shape consumed by `ChatSurface`'s shared
  `AskUserQuestion` card (`allow_once` `'submit'` option and `reject_once`
  `'deny'` dismiss option). Both `respondApproval` and `respondQuestion` fail
  closed on unknown action ids, invalid options, concurrent duplicate dispatches
  for the same `actionId`, or invalid/missing required question answers
  (`normalizeManagedQuestionAnswers` accepts both decimal question indices and
  explicit question ids, matches option ids or labels, enforces `allowText` and
  `required`, and rejects anything else before calling transport).
- **Snapshot stability and lifetime.** `operations` is memoized into a frozen
  array rebuilt only when tracked state changes. All settlement subscriptions
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
- `components/managed/chat-controller.test.ts` covers exhaustive
  phase/operation-status mappings, live one-hot pagination pass-through +
  `loadOlder({ force: true })`, permission/question projection, question answer
  normalization and fail-closed rejections, submit/cancel/approval/question
  admission vs settlement (including buffered early settlements,
  `recovery_blocked`, dispatch-time cancel `turnId` stamping, turn-completed
  cancel failure, concurrent duplicate refusal), snapshot identity stability,
  and `AbortSignal` cleanup.
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
- **Daemon main-column switch (rest of 2f)**, **ChatPane convergence (slice 4)**,
  **status-stack parity (slice 5)**, and **boundary guards (slice 6)**.
