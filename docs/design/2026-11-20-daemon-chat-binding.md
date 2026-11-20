# Daemon Chat Controller Binding (Slice 2d)

[English](2026-11-20-daemon-chat-binding.md) |
[简体中文](2026-11-20-daemon-chat-binding.zh-CN.md)

Status: implemented (slice 2d, binding hook). Date: 2026-11-20. Part of the
[unified chat surface](2026-11-16-unified-chat-surface.md) migration. Builds on the
merged contract (#17520), status stack (#17684), intent engine (#17709), and
controller assembly (#17794).

## Scope

Slice 2c landed `createDaemonChatController(deps)`, a dependency-injected assembly
that is backend-neutral and testable without the provider. This slice lands the
**binding hook** `useDaemonChatController()` that constructs that controller from
the live `DaemonSessionProvider` state, so the daemon chat column can be driven by
the shared `SessionChatController` contract. It renders nothing on its own; the
`ChatSurface` component and the main-column switch (with the visual before/after
gate) are the next increment.

## Design

- **One controller per session.** The hook constructs the controller once per
  `connection.sessionId` and recreates it when the session changes (resetting the
  permission-tracking state). Live facts (messages, transcript state, pending
  approvals, capabilities, status facts) are read through getters backed by a ref
  updated each render, so the long-lived controller always sees current provider
  state without being rebuilt.
- **Transports wrap the session actions.** `submitPrompt` maps the composer input
  to `actions.submitPrompt` and forwards the daemon's `onAdmitted` prompt id;
  `cancelPrompt`, `submitPermission`, and `submitQuestionAnswers` wrap the
  corresponding actions and map their result to an admission (`accepted` /
  `rejected` / `unknown` on a thrown transport). A rejected answer is untracked so
  it cannot seed a decision signal. A question answer must vote the request's
  submit (`allow_once`) option with the answers attached — the same wire shape
  `AskUserQuestion.handleSubmit` uses, looked up by `questionSubmitOptionId`;
  voting with no option id would send a `cancelled` outcome, which discards the
  answers and cancels the question, so a missing submit option is a `rejected`
  admission rather than a cancel vote.
- **Prompt settlement** is bridged from `useDaemonPromptSettled` (the terminal
  `turn_complete` / `turn_error` / cancelled event) to the controller's
  `subscribePromptSettlement`, keyed by `promptId`.
- **Approval currency and decision settlement are derived**, because the provider
  exposes no explicit channel for them. The pure helper `derivePermissionSignals`
  diffs the pending-permission set across renders:
  - a newly pending request is marked live;
  - a request that leaves the pending set **after this controller answered it**
    emits an `applied: true` decision settlement (the block resolving is the
    authoritative evidence the daemon applied the answer) and stays live so the
    decision can establish — the engine releases the identity on establishment;
  - a request that leaves the pending set **without an answer from this
    controller** was superseded, so it is marked not-live.
    The helper is pure and unit-tested; the hook keeps the previous pending set and
    the answered set in refs and forwards the derived signals to the controller.
- **Storage key** reuses `getComposerDraftStorageKey(sessionId, workspaceCwd)` so
  the surface's draft persistence matches the existing daemon composer.
- **Capabilities** are derived from `connection.capabilities.features` via the
  exhaustive `DAEMON_CHAT_CAPABILITY_MAP` (unknown tags are skipped).

## Bound conservatively (follow-ups for the ChatSurface increment)

- `pendingQuestions`, `statusFacts.queueLength`, and `statusFacts.goalActive` have
  no direct provider selector/hook yet; they are bound conservatively (empty /
  zero / false) and will be wired to their real sources when the status stack and
  question region are switched.
- `settledPhase` is `idle`; a failed-session phase will be derived from connection
  state when needed.
- The optional capability-gated sub-controllers (model selection, approval mode,
  context usage, session ops) are not bound yet; their regions stay hidden until a
  later increment wires them. The contract's `acknowledge` exposure (to release
  consumed terminal rows) also lands with the surface.

Two decisions the surface switch must make explicitly before it renders
certifications (review follow-ups, not silently carryable):

- **Decision-emission race window.** The derivation can emit `applied: true` when
  the block leaves the pending set before this controller's POST result resolves;
  if someone else answered the same request and this POST then returns `false`, the
  engine's monotonic freeze cannot withdraw the certification. This is inherent to
  request-level correlation plus block-resolution authority. The surface must
  decide whether to gate the emitted decision on the transport's admission or to
  accept block-resolution authority and dedupe at the provider.
- **Superseded rendering.** `pendingApprovals` never carries `status: 'superseded'`
  because the selector drops resolved blocks, while the contract comment describes
  superseded approvals lingering until confirmed. The surface must decide whether
  superseded rendering reads the operation rows instead.

## Constraints respected

- No daemon routes, Java routes, or OpenAPI change; no UI behavior change (the hook
  is not rendered yet).
- The hook lives under `daemon/`, outside `chat-core`; it imports the contract, the
  controller, and the provider, and `chat-core` imports nothing from it.
- Session id namespaces and storage keys are untouched (the draft key is reused,
  not redefined).
