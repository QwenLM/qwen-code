# Unified Chat Surface for Daemon and Managed Sessions

[English](2026-11-16-unified-chat-surface.md) |
[简体中文](2026-11-16-unified-chat-surface.zh-CN.md)

Status: proposal. Date: 2026-11-16. Nothing in this document is implemented
yet; the current state below describes the code as of the proposal date.

## Problem

Web Shell renders two kinds of sessions — normal daemon sessions and Java
Managed Agent sessions — through two separate chat orchestrations inside
`packages/web-shell`. The transcript rendering, editor, and UI primitives are
already shared, but everything above them (page layout, composer wiring,
approval flow, status display, session operations) is implemented twice: once
inline in `App.tsx` for daemon sessions, and once in `ManagedSessionsPage.tsx`
plus the `components/managed/**` hooks for managed sessions.

The consequences are visible today:

- Feature drift. The daemon chat surface imports `ComposerStatusStack`,
  `ComposerUsageStats`, `ConversationSearch`, and `GoalStatusStrip`;
  `ManagedSessionsPage.tsx` imports none of them and shows its own
  `ManagedSessionProgress` instead. A managed session and a daemon session in
  the same shell look and behave differently.
- Double implementation cost. Draft persistence, approval answering, model
  selection, approval-mode selection, context compression, rename, export,
  cancel, and lifecycle each have a daemon implementation and a parallel
  `use-managed-*` implementation. Every new chat feature must be built twice,
  and the second copy is routinely forgotten.
- No reuse path. The daemon chat surface is not a component; it is inline in
  a ~27k-line `App.tsx`. Other products that embed Web Shell (for example the
  VS Code companion, which ESLint already forces to render through
  `@qwen-code/web-shell`) cannot reuse it either.

## Current state

All paths below are relative to `packages/web-shell/client/`. Line counts are
approximate production-code counts at the proposal date, excluding tests.

### Already shared (one implementation)

| Layer                                      | Files                                                                                                                                                                                           | Consumers       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Transcript rendering                       | `components/MessageList.tsx` (~6.4k lines), `components/messages/**` (~28k lines)                                                                                                               | both paths      |
| Message model                              | `adapters/types.ts` (`Message`, `ACPToolCall`)                                                                                                                                                  | both projectors |
| Composer                                   | `components/ChatEditor.tsx`, `hooks/useComposerCore.ts`                                                                                                                                         | both paths      |
| UI primitives, theme, i18n, portal scoping | `components/ui/**`, `themeContext.ts`, `i18n.tsx`, `portalRoot.ts`                                                                                                                              | both paths      |
| Shell chrome and workspace navigation      | `App.tsx` outer shell; unified navigation per [managed-daemon-web-shell](2026-10-21-managed-daemon-web-shell.md) and [unified-workspace-navigation](2026-10-21-unified-workspace-navigation.md) | both paths      |

Both paths already project their backend events into the same `Message`
model: the daemon path through `adapters/transcriptToMessages.ts` and
`adapters/transcriptAdapter.ts` (imported by `App.tsx`), the managed path
through `createManagedMessageProjector` in
`components/managed/managed-session-messages.ts`. The managed projection is
incremental by design
([managed-incremental-message-projection](managed-incremental-message-projection.md)).

### Forked (two implementations)

| Concern             | Daemon path                                                                      | Managed path                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat orchestration  | inline in `App.tsx` (~27k lines total)                                           | `components/managed/ManagedSessionsPage.tsx` (~3.4k lines)                                                                                         |
| Session state       | `daemon/session/DaemonSessionProvider.tsx` (~7.1k lines) and `daemon/session/**` | `components/managed/use-managed-session.ts` and the `use-managed-*` hooks                                                                          |
| Backend contract    | `DaemonSessionClient` from `@qwen-code/sdk/daemon`                               | `ManagedAgentProvider` (`components/managed/managed-agent-provider.ts`, ~910 lines of interface) over `/api/agent/web-shell/v1/**`                 |
| Status display      | `ComposerStatusStack`, `ComposerUsageStats`, `GoalStatusStrip`                   | `ManagedSessionProgress`                                                                                                                           |
| Conversation search | `ConversationSearch`                                                             | absent                                                                                                                                             |
| Panels              | daemon terminal, artifacts, local files, git mode, voice, Live                   | `ManagedTerminalPanel`, `ManagedToolResultPanel`, `ManagedTaskPanel`, `ManagedDiagnosticsPanel`, `ManagedRecoveryPanel`, `ManagedChildSessionView` |

The managed-only entry `ManagedAgentWebShell.tsx` (booted by
`ManagedStandaloneApp.tsx` through `/managed/boot`) mounts
`ManagedSessionsPage` without any daemon context. The full shell mounts the
same page for managed sessions while daemon sessions render through the
inline `App.tsx` surface.

### Standing decisions this design must respect

- [managed-agent-dual-path-web-shell](2026-09-20-managed-agent-dual-path-web-shell.md):
  each surface routes to its original owner; no translation layer between the
  daemon and Java protocols; the managed-only entry stays daemon-free; the
  two session ID namespaces and storage keys never merge.
- [managed-daemon-web-shell](2026-10-21-managed-daemon-web-shell.md):
  navigation is already unified; both session components stay mounted; no
  cross-provider operations, no session migration, no merged storage.
- Server-side convergence is out of scope: the unified-agent-loop work and
  the Hosted harness evaluation keep specialized server implementations.
  Unification therefore happens in the client only.

## Goals

1. One chat surface component renders both daemon and managed sessions, so
   layout, composer behavior, approval flow, and status display are identical
   by construction.
2. A new chat feature is implemented once, against a backend-neutral
   contract, and reaches both session kinds wherever the backend supports it.
3. The duplicated orchestration listed above is deleted, not wrapped.
4. The managed-only entry keeps working without a daemon and without
   importing daemon code.

## Non-goals

- No protocol translation layer, in either direction, client or server.
- No merging of session state, storage keys, or ID namespaces across
  providers; no cross-provider operations.
- No backend changes are required by this design. Features whose backend
  support is missing on one side stay capability-gated, not emulated.
- Daemon-only surfaces (voice, Live sessions, desktop relay, channels, git
  mode, local files) are not ported to managed sessions; they become
  capability-gated slots of the shared surface.
- Workspace navigation, creation dialogs, and the shell chrome are already
  unified and are not reworked here.

## Proposed solution

Introduce a backend-neutral chat kernel in a new directory
`packages/web-shell/client/chat-core/` (final name settled in slice 1
review), consisting of a view-model contract, one surface component, and two
adapters:

```text
App.tsx (shell, navigation, settings)          ManagedAgentWebShell (managed-only)
        │                                              │
        ▼                                              ▼
  ChatSurface  ◄──────────── one component ────────────►
        ▲
        │ SessionChatController (view model)
   ┌────┴─────────────────────┐
   │                          │
daemon adapter            managed adapter
(DaemonSessionProvider    (use-managed-session +
 state, ACP updates)       use-managed-* hooks,
                           Java operations)
```

### SessionChatController contract

The controller is a view model, not a protocol client. It exposes observable
state and intent-level operations; idempotency keys, expected revisions,
receipts, and operation polling stay inside the managed adapter. Illustrative
shape (final field names settled in slice 1):

```ts
interface SessionChatController {
  readonly kind: 'daemon' | 'managed';
  readonly sessionId: string;
  readonly storageKey: string;

  // Transcript: the shared Message model, already projected incrementally.
  readonly messages: readonly Message[];
  readonly transcriptState: 'loading' | 'ready' | 'error';
  loadOlder?(): Promise<void>;

  // Turn lifecycle.
  readonly phase: ChatPhase; // idle | submitting | running | cancelling | failed
  submit(input: ComposerSubmit): Promise<SubmitOutcome>;
  cancel(): Promise<CancelOutcome>;

  // Approvals and questions, normalized to the shared ToolApproval /
  // ManagedQuestionForm inputs.
  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingQuestions: readonly PendingQuestion[];
  respondApproval(id: string, optionId: string): Promise<void>;
  respondQuestion(id: string, answers: QuestionAnswer[]): Promise<void>;

  // Capability-gated sub-controllers; absent when the backend lacks support.
  readonly modelSelection?: ModelSelectionController;
  readonly approvalSelection?: ApprovalSelectionController;
  readonly contextUsage?: ContextUsageController; // usage facts + compression
  readonly sessionOps?: SessionOpsController; // rename, export, lifecycle

  // Facts for the shared status stack and usage stats.
  readonly statusFacts: ChatStatusFacts;
  readonly capabilities: ChatCapabilities;
}
```

`ChatCapabilities` mirrors the existing capability style of
`ManagedAgentSessionSummary.capabilities` and daemon capabilities: the
surface gates every optional region on a flag, never on `kind`. Async managed
operations (compression, lifecycle, cancel, MCP commands) surface as a
generic operation state (`pending | running | completed | failed`) so the
surface renders one progress vocabulary for both backends.

### ChatSurface component

`ChatSurface` owns the chat column only: header (`ChatContextHeader` plus a
header-actions slot), `MessageList` wiring, approval and question rendering,
the composer (`ChatEditor` plus `ComposerStatusStack` and usage stats driven
by `statusFacts`), and a panel slot region. It takes the controller and slot
renderers as props and imports nothing from `daemon/**`,
`components/managed/**`, or `@qwen-code/sdk/daemon`. Backend-specific panels
(daemon artifacts, managed diagnostics/tasks/recovery/terminal) are passed in
as slots by the owning page.

### Adapters

- `createDaemonChatController` wraps the existing `DaemonSessionProvider`
  state and actions. It maps ACP-driven state onto the contract; immediate
  daemon results map to completed operation states.
- `createManagedChatController` wraps `use-managed-session` and the existing
  `use-managed-*` hooks. The hooks keep their current responsibilities
  (receipts, revisions, recovery barriers, pending-command storage); the
  adapter only normalizes their outputs. The incremental projector stays the
  single source of `messages`; the controller never re-projects.

### Page wiring after migration

- `App.tsx` renders `ChatSurface` with the daemon adapter for daemon
  sessions, keeping navigation, settings, and daemon-only panels.
- `ManagedSessionsPage.tsx` shrinks to session navigation plus the managed
  adapter and managed-only panel slots; its chat column becomes
  `ChatSurface`. The managed-only entry keeps its current layout and boot.

## Design decisions and rationale

1. **View-model contract, not a protocol adapter.** A client-side adapter
   that makes the Java API look like the daemon protocol was considered and
   rejected: it would have to emulate capabilities, workspace context,
   artifacts, terminal tickets, and voice semantics, recreating exactly the
   translation layer the dual-path design forbids, and the emulation itself
   would become a new maintenance burden. A view model sits above both
   protocols and only standardizes what the UI shows and does.
2. **Capability gating instead of backend branching.** The surface never
   asks which backend it serves. Missing backend support hides a region;
   it never triggers a fallback to the other provider, matching the standing
   no-fallback rule.
3. **Daemon-first extraction.** The daemon surface moves into `ChatSurface`
   first, with a visual before/after gate, because it is the larger and
   riskier extraction. Managed switches second, onto an already-proven
   component, and its duplicated orchestration is deleted in the same slice
   that replaces it.
4. **Operations stay encapsulated.** Exposing raw Java operations
   (idempotency keys, revisions, receipts) through the contract would leak
   managed semantics into the shared surface and force the daemon adapter to
   fake them. The generic operation state is the only async vocabulary the
   surface sees.
5. **Parity follows backend facts.** Managed gains the status stack and
   usage display where its events and diagnostics already provide the facts
   (for example `modelContext` token observations). Regions without backend
   facts stay hidden rather than filled with invented data.

## Migration slices

Each slice is an independently shippable PR with its own tests. Per
repository convention the design document lands together with the first
implementation slice.

1. **Contract and characterization pins.** Add `chat-core` with the contract
   types and capability model; add DOM-level characterization tests pinning
   the current behavior of both chat surfaces (composer submit, approval
   answering, status display, draft restore). No behavior change.
2. **Extract ChatSurface, daemon switches.** Move the chat column out of
   `App.tsx` into `ChatSurface` plus the daemon adapter. The visual
   before/after preview must show no unexplained daemon-side difference.
   Managed is untouched.
3. **Managed switches, duplicated orchestration deleted.** Add the managed
   adapter; the managed chat column renders `ChatSurface`; delete the
   replaced transcript/composer/approval/status orchestration from
   `ManagedSessionsPage.tsx`. Managed-only panels become slots.
4. **Capability-gated parity.** Unify status stack, usage stats, and context
   usage/compression display on both sides wherever backend facts exist.
   Conversation search and goal display remain gated pending the open
   questions below.
5. **Boundary enforcement and cleanup.** Add a build/import guard proving
   `chat-core` and the managed-only bundle never import daemon code (in the
   style of the existing `build-artifact.test.ts` checks); remove dead
   managed orchestration and stale imports.

During slices 2–4, new chat features land only in `chat-core` once the
affected region has moved, so the migration does not race feature work.

## Constraints

- The managed-only entry (`ManagedAgentWebShell`) must not gain any daemon
  import; `chat-core` imports neither `daemon/**` nor `@qwen-code/sdk/daemon`.
- No changes to daemon routes, Java routes, or the OpenAPI contract.
- Provider storage keys, session ID namespaces, and tenant/actor headers are
  untouched; managed errors never fall back to the daemon backend.
- Web Shell CSS scoping (`data-web-shell-root`, portal roots) and the React
  18/19 `forwardRef` rules from the repository Web Shell conventions apply
  to every moved component.
- The managed incremental projection and its epoch/dedup semantics are
  preserved; the controller consumes projector output.
- Idempotency, expected-revision, and receipt semantics remain inside the
  managed adapter and its hooks.

## Risks and mitigations

| Risk                                                            | Mitigation                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Extracting from a ~27k-line `App.tsx` regresses daemon behavior | Characterization pins in slice 1; visual before/after gate in slice 2; small slices, daemon-first   |
| Contract drifts toward one backend's shape                      | Every slice reviews both adapters against the contract; capability flags instead of `kind` branches |
| Managed async semantics leak into the surface                   | Generic operation state; raw operations never cross the contract                                    |
| Performance regression from re-projection or lost memoization   | Controller consumes the incremental projector; memo boundaries pinned by tests                      |
| Feature work races the migration                                | Freeze rule: moved regions accept new features only through `chat-core`                             |
| Managed-only bundle accidentally gains daemon code              | Import/build guard in slice 5, checked in CI                                                        |

## Validation plan

- Unit tests collocated with each moved module; the existing daemon and
  managed suites (`App.test.tsx`, `ManagedSessionsPage.test.tsx`, the
  `use-managed-*` tests, `ManagedAgentWebShell.test.tsx`) stay green.
- Browser-level verification of both session kinds through the local dev
  server against a real daemon and the managed boot path: submit, approval,
  cancel, draft restore, refresh/deep-link restore, and panel slots, with
  assertions on the DOM rather than screenshots alone.
- The existing managed Playwright specs (`managed-usability`,
  `managed-context-compression`, `managed-recovery`, `managed-draft-retry`,
  and siblings) run against the migrated surface.
- The web-shell visual preview CI provides before/after evidence for every
  slice; daemon-side diffs must be empty or explained.
- Gates: package `typecheck`, `tsc -p tsconfig.lib.json` (the stricter CI
  build gate), package `build`, root `build` and `bundle`, targeted lint and
  format checks.

## Acceptance criteria

1. Daemon and managed chat columns render through the same `ChatSurface`
   component; the import graph shows one surface, two adapters.
2. The forked orchestrations listed in the current-state table are deleted
   from `ManagedSessionsPage.tsx` (transcript, composer wiring, approval
   flow, status display), with managed-only panels retained as slots.
3. The managed-only entry and bundle contain no daemon imports, proven by
   an automated guard.
4. Existing daemon and managed unit suites and the managed Playwright specs
   pass; the visual preview shows no unexplained daemon-side change.
5. Managed sessions show the shared status stack and usage display wherever
   backend facts exist, with absent regions capability-gated.

## Open questions

1. **Conversation search parity.** The managed provider advertises
   `titleSearch` for the session list only; transcript content search has no
   managed backend route today. Does parity require a new Java query route,
   or does search stay daemon-only behind a capability flag?
2. **Goal and loop display.** Managed loop scheduling designs exist, but the
   daemon `GoalStatusStrip` facts have no managed equivalent yet. Confirm the
   capability gating until the backend exposes goal facts.
3. **Daemon-only extras as slots.** Voice, git mode, and local files stay
   daemon-only; whether their entry points move into `ChatSurface` slots in
   slice 2 or remain in `App.tsx` chrome is settled during extraction.
4. **Kernel naming and placement.** `chat-core/` is a working name; the final
   directory and contract names are settled in slice 1 review.
