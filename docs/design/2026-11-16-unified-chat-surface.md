# Unified Chat Surface for Daemon and Managed Sessions

[English](2026-11-16-unified-chat-surface.md) |
[简体中文](2026-11-16-unified-chat-surface.zh-CN.md)

Status: proposal. Date: 2026-11-16. Revised 2026-11-16 after review: the
ChatPane chat column is now in scope, the contract separates admission from
outcome establishment, and several current-state claims were corrected. A
second revision tightens the contract (observable operation state,
correlation identity, compile-time capability-mapping guards) and corrects
the daemon-import exception scope and the guard lane. Nothing in this
document is implemented yet; the current state below describes the code as
of the proposal date.

## Problem

Web Shell renders chat through three separate orchestrations inside
`packages/web-shell`: the main daemon chat column inline in `App.tsx`, a
second daemon chat column in `components/ChatPane.tsx` (the split-view and
side-task panes), and the managed chat column in `ManagedSessionsPage.tsx`
plus the `components/managed/**` hooks. The transcript rendering, editor,
and UI primitives are already shared, but everything above them (page
layout, composer wiring, approval flow, status display, session operations)
is implemented once per column.

The consequences are visible today:

- Feature drift. The daemon side renders a composer status stack (inline
  JSX in both `App.tsx` and `ChatPane.tsx`, styled by
  `ComposerStatusStack.module.css`), usage statistics
  (`ComposerUsageStats`), conversation search (`ConversationSearch`), and a
  goal strip (`GoalStatusStrip`); the managed chat surface has no equivalent
  of any of them and shows its own `ManagedSessionProgress` instead. Even
  the two daemon columns duplicate the status-stack JSX. A managed session
  and a daemon session in the same shell look and behave differently.
- Multiple implementation cost. Draft persistence, approval answering,
  model selection, approval-mode selection, context compression, rename,
  export, cancel, and lifecycle each have a daemon implementation and a
  parallel `use-managed-*` implementation, and the split-view column keeps
  its own copy of submit, cancel, approval, and status wiring. Every new
  chat feature must be built once per column, and a copy is routinely
  forgotten.
- No reuse path. The main daemon chat column is not a component; it is
  inline in a ~27k-line `App.tsx`. `ChatPane.tsx` is a component, but it is
  daemon-shaped and carries its own copy of the orchestration. Products
  that embed the whole shell — the VS Code companion already renders
  `WebShellWithProviders` — still cannot reuse a chat column alone across
  backends.

## Current state

All paths below are relative to `packages/web-shell/client/`. Line counts are
approximate production-code counts at the proposal date, excluding tests.

### Already shared (one implementation)

| Layer                                      | Files                                                                                                                                                                                           | Consumers                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Transcript rendering                       | `components/MessageList.tsx` (~6.4k lines), `components/messages/**` (~31.6k lines); `ChatPane` reaches `MessageList` through `components/TranscriptViewport.tsx`                               | all three columns                                       |
| Message model                              | `adapters/types.ts` (`Message`, `ACPToolCall`)                                                                                                                                                  | both projectors                                         |
| Composer                                   | `components/ChatEditor.tsx`, `hooks/useComposerCore.ts`                                                                                                                                         | all three columns                                       |
| UI primitives, theme, i18n, portal scoping | `components/ui/**`, `themeContext.ts`, `i18n.tsx`, `portalRoot.ts`                                                                                                                              | all three columns (ChatPane partly via shared children) |
| Shell chrome and workspace navigation      | `App.tsx` outer shell; unified navigation per [managed-daemon-web-shell](2026-10-21-managed-daemon-web-shell.md) and [unified-workspace-navigation](2026-10-21-unified-workspace-navigation.md) | both session kinds                                      |

Both paths already project their backend events into the same `Message`
model: the daemon path through `adapters/transcriptToMessages.ts` and
`adapters/transcriptAdapter.ts` (imported by `App.tsx`), the managed path
through `createManagedMessageProjector` in
`components/managed/managed-session-messages.ts`. The managed projection is
incremental by design
([managed-incremental-message-projection](managed-incremental-message-projection.md)).

### Forked (one implementation per column)

| Concern                       | Daemon path                                                                                                                                                 | Managed path                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Main chat orchestration       | inline in `App.tsx` (~27k lines total)                                                                                                                      | `components/managed/ManagedSessionsPage.tsx` (~3.4k lines)                                                                         |
| Split-view / side-task column | `components/ChatPane.tsx` (~2.2k lines), rendered by `components/SplitView.tsx` and `components/artifacts/SideTaskPanel.tsx`; `App.tsx` renders `SplitView` | absent — managed sessions do not open in split view or side tasks                                                                  |
| Session state                 | `daemon/session/DaemonSessionProvider.tsx` (~7.1k lines) and `daemon/session/**`                                                                            | `components/managed/use-managed-session.ts` and the `use-managed-*` hooks                                                          |
| Backend contract              | `DaemonSessionClient` from `@qwen-code/sdk/daemon`                                                                                                          | `ManagedAgentProvider` (`components/managed/managed-agent-provider.ts`, ~910 lines of interface) over `/api/agent/web-shell/v1/**` |
| Status display                | inline composer-status JSX in `App.tsx` and `ChatPane.tsx` (shared `ComposerStatusStack.module.css`), `ComposerUsageStats`, `GoalStatusStrip`               | `ManagedSessionProgress`                                                                                                           |
| Conversation search           | `ConversationSearch` (main column)                                                                                                                          | absent                                                                                                                             |
| Panels                        | daemon terminal, artifacts, local files, git mode, voice, Live                                                                                              | `ManagedTerminalPanel`, `ManagedToolResultPanel`, `ManagedTaskPanel`, `ManagedDiagnosticsPanel`, `ManagedChildSessionView`         |

`ChatPane.tsx` independently wires `TranscriptViewport`, `ToolApproval`,
`AskUserQuestion`, `GoalStatusStrip`, and `ChatEditor`, owns submit and
cancel, and renders its own inline composer-status block. It is the closest
existing thing to the proposed `ChatSurface`, but its props are daemon-shaped
(daemon session summary, workspace cwd) and it duplicates the main column's
orchestration; this design makes it an explicit migration target instead of
leaving a third copy behind. There is no `ComposerStatusStack` component
today — only the CSS module; the status stack is inline JSX in both daemon
columns, and slice 2 creates the component.

The managed-only entry `ManagedAgentWebShell.tsx` (booted by
`ManagedStandaloneApp.tsx` through `/managed/boot`) mounts
`ManagedSessionsPage` without any daemon context. The full shell mounts the
same page for managed sessions while daemon sessions render through the
inline `App.tsx` surface and the `ChatPane` columns.

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

1. One chat surface component renders every chat column — daemon main,
   split view, side task, and managed — so layout, composer behavior,
   approval flow, and status display are identical by construction.
2. A new chat feature is implemented once, against a backend-neutral
   contract, and reaches every column wherever the backend supports it.
3. The duplicated orchestration listed above is deleted, not wrapped.
4. The managed-only entry keeps working without a daemon and without
   importing daemon code into the shared kernel.

## Non-goals

- No protocol translation layer, in either direction, client or server.
- No merging of session state, storage keys, or ID namespaces across
  providers; no cross-provider operations.
- No backend changes are required by this design. Features whose backend
  support is missing on one side stay capability-gated, not emulated.
- Daemon-only surfaces (voice, Live sessions, desktop relay, channels, git
  mode, local files) are not ported to managed sessions; they become
  capability-gated slots of the shared surface.
- Workspace navigation, creation dialogs, the shell chrome, and the
  split-view pane chrome (title, maximize/close, header actions) are not
  reworked here; they stay with their hosts.

## Proposed solution

Introduce a backend-neutral chat kernel in a new directory
`packages/web-shell/client/chat-core/` (final name settled in slice 1
review). `chat-core` holds only the contract types and the surface
component; the two adapters live outside it, next to their providers
(daemon adapter under `daemon/`, managed adapter under
`components/managed/`), which is what makes the kernel's import ban
satisfiable:

```text
App.tsx (main column, shell)     SplitView / SideTaskPanel     ManagedAgentWebShell
        │                              │                              │
        ▼                              ▼                              ▼
  ChatSurface  ◄──────────────── one component ──────────────────────►
        ▲
        │ SessionChatController (view model, types in chat-core)
   ┌────┴─────────────────────┐
   │                          │
daemon adapter            managed adapter
(under daemon/, wraps     (under components/managed/,
 DaemonSessionProvider)    wraps use-managed-* hooks)
```

### SessionChatController contract

The controller is a view model, not a protocol client. It exposes observable
state and intent-level operations; idempotency keys, expected revisions,
receipts, and operation polling stay inside the managed adapter. Every
intent reports two separate results: admission (was the request accepted,
and for which session/turn/attempt) and outcome (what authoritative witness
shows the intended effect is established). Illustrative shape (final field
names settled in slice 1):

```ts
type Admission = 'accepted' | 'rejected' | 'unknown';
type Outcome = 'established' | 'unsettled' | 'failed';

interface IntentResult {
  readonly admission: Admission;
  // Absent when admission is rejected; see the valid result pairs below.
  readonly outcome?: Outcome;
  // Correlation identity: which session/turn/attempt/request this is about.
  readonly target: {
    sessionId: string;
    turnId?: string;
    attemptId?: string;
    requestId?: string;
  };
}

type OperationState =
  | 'pending'
  | 'running'
  | 'established'
  | 'unsettled'
  | 'failed';

interface ChatOperation {
  readonly id: string;
  readonly kind:
    | 'submit'
    | 'cancel'
    | 'approval'
    | 'question'
    | 'compression'
    | 'lifecycle'
    | 'mcp';
  readonly state: OperationState;
  readonly target: IntentResult['target'];
}

interface SessionChatController {
  // Identity only; the surface never branches on it (decision 2).
  readonly kind: 'daemon' | 'managed';
  readonly sessionId: string;
  readonly storageKey: string;

  // In-flight and recently settled intents, observable across refresh;
  // `phase: 'cancelling'` is derived from an unestablished cancel operation
  // (one read path). Retention is bounded: see the operations prose below.
  readonly operations: readonly ChatOperation[];

  // Transcript: the shared Message model, already projected incrementally.
  readonly messages: readonly Message[];
  readonly transcriptState: 'loading' | 'ready' | 'error';
  loadOlder?(): Promise<void>;

  // Turn lifecycle. `cancelling` persists until settlement evidence arrives.
  readonly phase: ChatPhase; // idle | submitting | running | cancelling | failed
  submit(input: ComposerSubmit): Promise<IntentResult>;
  cancel(): Promise<IntentResult>;

  // Approvals and questions, normalized to the shared ToolApproval /
  // ManagedQuestionForm inputs.
  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingQuestions: readonly PendingQuestion[];
  respondApproval(id: string, optionId: string): Promise<IntentResult>;
  respondQuestion(id: string, answers: QuestionAnswer[]): Promise<IntentResult>;

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

Long-running intents (submit, cancel, approval, question, compression,
lifecycle, MCP commands) are observable contract state: `operations` carries
one `ChatOperation` per intent with the generic state above, so the surface
renders one progress vocabulary for both backends and can restore "sent /
awaiting outcome" after a refresh. Terminal entries (`established`,
`failed`) stay readable until acknowledged — the surface consumes the
outcome, or a new intent of the same kind supersedes it — and the adapter
keeps at most the latest terminal entry per kind and target, so `operations`
never grows without bound. `phase: 'cancelling'` is derived from an
unestablished cancel operation, not from a resolved `cancel()` promise. The
contract carries one invariant: **admission is not establishment.**

- A resolved promise or a transport-level acceptance never by itself
  produces `established`; the adapter must hold authoritative evidence
  (turn end, settlement receipt, a decision applied to the still-current
  request/revision).
- `unsettled` is a first-class state: admitted (or admission unknown) but no
  witness yet, including after a timeout or a refresh. It renders as "sent /
  awaiting outcome", is not `failed`, and offers no retry that bypasses the
  adapter.
- A superseded approval renders as superseded, not applied; an approval
  leaves pending only when the backend confirms the decision applies to the
  still-current request.
- Capability flags gate whether a control exists; the status shown after it
  follows outcome evidence, never the flag.

Valid result pairs: a `rejected` admission carries no outcome; `established`
and `failed` require an `accepted` admission; `unsettled` accompanies an
`accepted` or `unknown` admission (the timeout case: possibly in effect, no
witness). A superseded approval is a pending-item state
(`PendingApproval.status`), not an intent outcome. A region renders only when
its sub-controller is present; `ChatCapabilities` flags are derived from the
same facts and gate auxiliary controls — presence is the single authority.

`ChatCapabilities` mirrors the existing capability style of
`ManagedAgentSessionSummary.capabilities` and daemon capabilities. The
surface never branches on `kind`: a region renders only when its
sub-controller is present (the single authority, as stated above), and the
flags — derived from the same facts — gate auxiliary controls within a
region. Each adapter owns the mapping from its backend's capability shape
(the daemon feature list; the managed optional booleans) to
`ChatCapabilities`. Omission must be a compile error, not a shared blind
spot between a hand-written map and a hand-written table: the managed map is
typed against `keyof ManagedAgentSessionSummary['capabilities']` with a
key-set assertion off a `Required<>` fixture (which also decides the
tri-state `terminal?: boolean | null`), and the daemon map is an exhaustive
typed record over the canonical feature-tag union — the registry-keyed
pattern already used by `CAPABILITY_PARITY: Record<ServeFeature, ParityRow>`
in the CLI serve layer, with the union's shared home settled in slice 1 —
so a tag added by a later release is a compile error, not a silently hidden
region.

### ChatSurface component

`ChatSurface` owns the chat column only: header (`ChatContextHeader` plus a
header-actions slot), `MessageList` wiring, approval and question rendering,
the composer (`ChatEditor` plus a composer status stack component that
slice 2 extracts from the inline JSX currently duplicated in `App.tsx` and
`ChatPane.tsx`, plus usage stats driven by `statusFacts`), and a panel slot
region. It takes the controller and slot renderers as props and imports
nothing from `daemon/**`, `components/managed/**`, or
`@qwen-code/sdk/daemon`. Backend-specific panels (daemon artifacts, managed
diagnostics/tasks/terminal) are passed in as slots by the owning page. Managed
recovery has no panel slot: its verdict renders as a conversation message.

### Adapters

- `createDaemonChatController` wraps the existing `DaemonSessionProvider`
  state and actions. It maps ACP-driven state onto the contract and marks
  an outcome `established` only when daemon evidence settles it (turn end,
  applied permission response); a resolved call alone is admission.
- `createManagedChatController` wraps `use-managed-session` and the existing
  `use-managed-*` hooks. The hooks keep their current responsibilities
  (receipts, revisions, recovery barriers, pending-command storage); the
  adapter only normalizes their outputs into admission and outcome. The
  incremental projector stays the single source of `messages`; the
  controller never re-projects.

### Page wiring after migration

- `App.tsx` renders `ChatSurface` with the daemon adapter for the main
  column, keeping navigation, settings, and daemon-only panels.
- `SplitView` and `SideTaskPanel` render `ChatSurface` through the converged
  `ChatPane` chrome; pane chrome stays with the hosts.
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
3. **Daemon-first extraction.** The main daemon column moves into
   `ChatSurface` first, with a visual before/after gate, because it is the
   larger and riskier extraction. Managed switches second, onto an
   already-proven component; `ChatPane` converges third, so split view and
   side task do not keep a third orchestration. Each switch deletes the
   duplicated orchestration in the same slice that replaces it.
4. **Operations stay encapsulated.** Exposing raw Java operations
   (idempotency keys, revisions, receipts) through the contract would leak
   managed semantics into the shared surface and force the daemon adapter to
   fake them. The generic admission/outcome vocabulary is the only async
   language the surface sees.
5. **Parity follows backend facts.** Managed gains the shared status stack
   and the session usage statistics (`ComposerUsageStats`) where facts exist
   (the managed fact source is `diagnostics.getStatistics`); the context
   ring already renders `modelContext` token observations today and is not a
   new gain. Regions without backend facts stay hidden rather than filled
   with invented data.
6. **Admission is not establishment.** A backend-neutral UI state is not
   automatically a backend-neutral proof that an action took effect: a
   generic `completed` label can be truthful about the local API call and
   false about the user's operational state. The two-stage result keeps the
   truth conditions of user-facing states in the shared contract without
   leaking protocol fields, and it is a slice-1 contract rule, not an
   adapter implementation detail; each adapter's negative tests land with
   that adapter (slices 2 and 3). Decision 4 is unchanged: receipts,
   revisions, and recovery barriers stay inside the managed adapter.

## Migration slices

This document is a standalone proposal; implementation slices land
separately. Each slice is an independently shippable PR with its own tests.

1. **Contract and characterization pins.** Add `chat-core` with the contract
   types, the capability model, and the capability-mapping guards (typed
   managed map, `Required<>` key-set fixture, exhaustive daemon-tag record); add
   DOM-level characterization tests pinning the current behavior of all
   three chat columns (composer submit, approval answering, status display,
   draft restore); pin the admission/outcome truth table as pure-function
   tests. The per-adapter negative tests proving transport success alone
   never produces `established` — covering a delayed turn outcome, an
   unsettled cancel, and a superseded approval — land with each adapter in
   slices 2 and 3, not here. No behavior change.
2. **Extract ChatSurface, daemon main column switches.** Move the main chat
   column out of `App.tsx` into `ChatSurface` plus the daemon adapter,
   creating the composer status stack component from the inline JSX. The
   shared approval/composer components that `ChatSurface` renders
   (`ToolApproval`, `ChatEditor`) are decoupled from daemon value imports
   here, before the kernel may import them (`MessageList`'s SDK imports are
   type-only and erased at build), and the daemon adapter's negative tests
   land with it. The visual before/after preview must show no unexplained
   daemon-side difference. Managed and `ChatPane` are untouched.
3. **Managed switches, duplicated orchestration deleted.** Add the managed
   adapter with its negative tests; the managed chat column renders
   `ChatSurface`; delete the replaced transcript/composer/approval/status
   orchestration from `ManagedSessionsPage.tsx`. Managed-only panels become
   slots.
4. **ChatPane converges.**
   - **Slice 4a (rendering + approval/question routing):** Split view, side
     task, and the artifacts panel's read-only session tab (`SessionPanel`)
     render `ChatSurface` through the daemon adapter; pane chrome (title,
     maximize/close, header actions) stays as slots; `ChatPane`'s inline
     transcript, tool-approval, question, and composer rendering plus its
     question handler are deleted.
   - **Slice 4b (submit/cancel/status follow-up):** Converge `ChatPane`'s
     remaining host-owned submit (`onComposerSubmit`), cancel
     (`onComposerCancel`), and `composerStatus` orchestration onto the shared
     controller/surface pipeline and retire the temporary host-owned cancel and
     `transcriptProps.isResponding` overrides.
5. **Capability-gated parity.** Unify status stack, usage stats, and context
   usage/compression display on both sides wherever backend facts exist.
   Conversation search and goal display remain gated pending the open
   questions below.
6. **Boundary enforcement and cleanup.** First clear the remaining
   managed-only value-import graph of daemon imports — the examples in the
   constraints are illustrative, not an exhaustive budget, and the census is
   re-run here — then add two guards: a source-level import-specifier check
   proving `chat-core`'s own modules never import daemon code (in the style
   of the existing `build-artifact.test.ts` checks, which read `dist/`), and
   an artifact grep of `dist-managed-host/index.js` in the
   `web-shell-managed-host.yml` lane, because the default `build` does not
   emit the managed-only bundle and that lane runs no tests today. Remove
   dead orchestration and stale imports.

During slices 2–5, new chat features land only in `chat-core` once the
affected region has moved, so the migration does not race feature work.

## Constraints

- `chat-core`'s own modules import neither `daemon/**` nor
  `@qwen-code/sdk/daemon`; the adapters live outside the kernel. The
  managed-only entry keeps working without a daemon runtime. Today its
  source graph still reaches daemon value imports transitively through many
  shared modules; these examples are illustrative, not an exhaustive list:
  `ChatEditor.tsx` value-imports `useOptionalWorkspace` from
  `daemon-react-sdk` (which re-exports `daemon/index.ts`, which
  value-exports from `@qwen-code/sdk/daemon`), and shared message components
  such as `SystemMessage.tsx` import `@qwen-code/sdk/daemon` directly. The
  shared approval/composer value-import edges are decoupled in slice 2 because
  `ChatSurface` renders them; slice 6 clears the whole remaining graph, not
  a named subset, before the guards land. Until then the no-daemon-import
  constraint applies to `chat-core`'s own modules, not to the whole managed
  source graph.
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

| Risk                                                                                    | Mitigation                                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Extracting from a ~27k-line `App.tsx` and converging `ChatPane` regress daemon behavior | Characterization pins for all three columns in slice 1; visual before/after gate in slice 2; small slices, daemon-first |
| Contract drifts toward one backend's shape                                              | Every slice reviews both adapters against the contract; capability flags instead of `kind` branches                     |
| Managed async semantics leak into the surface                                           | Generic admission/outcome vocabulary; raw operations never cross the contract                                           |
| Transport success displayed as an established outcome                                   | Per-adapter negative tests landing with each adapter; `unsettled` is first-class and survives refresh                   |
| Performance regression from re-projection or lost memoization                           | Controller consumes the incremental projector; memo boundaries pinned by tests                                          |
| Feature work races the migration                                                        | Freeze rule: moved regions accept new features only through `chat-core`                                                 |

## Validation plan

- Unit tests collocated with each moved module; the existing daemon and
  managed suites (`App.test.tsx`, `ManagedSessionsPage.test.tsx`, the
  `use-managed-*` tests, `ManagedAgentWebShell.test.tsx`) stay green, and
  the per-adapter negative tests (landing with each adapter) prove transport
  success alone never produces `established`.
  `managed-draft-retry.spec.ts` already covers an unsettled submit across
  reload; the new coverage adds the cancel path and an explicit
  distinct-from-`failed` assertion.
- Browser-level verification of both session kinds through the local dev
  server against a real daemon and the managed boot path: submit, approval,
  cancel, draft restore, refresh/deep-link restore, and panel slots, in the
  main column and in split view / side task, with assertions on the DOM
  rather than screenshots alone.
- The existing managed Playwright specs (`managed-usability`,
  `managed-context-compression`, `managed-recovery`, `managed-draft-retry`,
  and siblings) run against the migrated surface.
- The web-shell visual preview CI provides before/after evidence for every
  slice; daemon-side diffs, including split view and side task, must be
  empty or explained.
- Gates: package `typecheck`, `tsc -p tsconfig.lib.json` (the stricter CI
  build gate), package `build`, root `build` and `bundle`, targeted lint and
  format checks.

## Acceptance criteria

1. Every chat column — daemon main, split view, side task, and managed —
   renders through the same `ChatSurface` component; the import graph shows
   one surface, two adapters.
2. The forked orchestrations listed in the current-state table are deleted
   from `ManagedSessionsPage.tsx` and `ChatPane.tsx` (transcript, composer
   wiring, approval flow, status display), with backend-specific panels
   retained as slots.
3. `chat-core`'s own modules contain no daemon imports and the managed-only
   source graph is cleared of daemon value imports, proven by a source-level
   check plus an artifact grep in the managed-host lane; the managed-only
   entry keeps working without a daemon.
4. Existing daemon and managed unit suites and the managed Playwright specs
   pass; the visual preview shows no unexplained daemon-side change.
5. Managed sessions show the shared status stack and session usage
   statistics (`ComposerUsageStats`) wherever backend facts exist, with
   absent regions capability-gated.
6. The admission-is-not-establishment invariant holds: per-adapter negative
   tests prove transport success alone never produces `established`;
   `unsettled` renders distinctly from `failed` and survives refresh;
   superseded approvals render as superseded, not applied.

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
