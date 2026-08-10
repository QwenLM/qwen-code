# Fleet architecture for Qwen Code multi-agent work

> Status: Proposed — design only, no implementation
> Baseline: Qwen Code `002305b90` (2026-08-10)
> Evolves the plan originally proposed in this PR; re-frames [#8718](https://github.com/QwenLM/qwen-code/issues/8718) and [#8804](https://github.com/QwenLM/qwen-code/pull/8804)

## 0. Decision summary

Build a herdr-_like_ experience natively. Treat herdr as a UX reference, not a dependency.

The design rests on one distinction that herdr cannot make and we can:

| Channel                         | Carries                                                                      | Used for                                                |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Semantic** (JSON over socket) | status, turn text, approvals with call IDs, tool activity, transcript deltas | coordination, roster, tab rendering — **authoritative** |
| **Terminal** (PTY bytes)        | raw screen                                                                   | true "enter the session" attach only                    |

Herdr has only the terminal channel and _infers_ the semantic one by reading the screen. We
emit the semantic channel from inside the agent, so `blocked` is a specific tool call with a
call ID and an outcome set, not a guess. Everything below follows from making the semantic
channel primary and the terminal channel optional.

Consequence for sequencing: **the semantic fleet layer is built first and works without any PTY
infrastructure.** Raw terminal attach is a later phase, not a prerequisite.

### 0.1 Settled product decisions

These four were decided deliberately and are load-bearing for the phases below. They are
recorded here so implementation PRs do not relitigate them.

| Decision           | Choice                                                                                                                                                      | Rejected alternative and why                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP inspection** | Transcript tab only — read the full transcript and message the teammate through the existing tab UI                                                         | Raw PTY attach in MVP: pulls terminal infrastructure ahead of the semantic layer, the specific inversion this plan avoids             |
| **Approvals**      | Investigation teammates default to `read_only` so they cannot raise approvals at all; the single writer routes to the leader. Never auto-escalate to `yolo` | All-to-leader makes the leader an interrupt bottleneck at N teammates; per-teammate auto-approval is an unauditable safety regression |
| **Leader exit**    | Clean exit stops teammates; a leader _crash_ leaves them running and reattachable                                                                           | Always-persist risks unattended token spend; always-die loses reattach entirely                                                       |
| **Fleet scope**    | One fleet per project (keyed by project cwd) with a **single-leader lock**; a second Qwen in the same repo sees the roster read-only                        | Per-session loses reattach-from-a-new-window; multi-leader invites task-ownership races the claim protocol never modelled             |

Two consequences worth stating explicitly:

- The approval decision makes #8804's `read_only` enforcement **load-bearing**, not optional
  polish. It is the mechanism that keeps the leader from drowning in approvals.
- The single-leader lock is new state. It belongs next to the supervisor's roster, keyed on
  project cwd, and must be released on clean exit and reclaimed after the `stale` window on
  crash — the same 5s semantics the task locks already use.

## 1. What herdr actually is

Verified against the primary source. [github.com/herdrdev/herdr](https://github.com/herdrdev/herdr)
— Rust, Apache-2.0, ~26.5k stars, "the runtime your coding agents live on."

- A **terminal multiplexer**. Client–server: a background server owns sessions, workspaces and
  panes; a thin client renders. Unix socket locally, SSH remotely.
- Hosts **unmodified** agents (Claude Code, Codex, Cursor, amp, 17+). It owns their terminals;
  it does not wrap them. No hooks required.
- **State detection is external and generic**: `working` / `blocked` / `idle`, inferred from the
  terminal.
- **Persistence is the headline**: always-on server, `ctrl+b q` to detach, rerun `herdr` to
  reattach; survives lid close, network drop, restart.
- **Socket API mirrors the CLI** (`herdr pane split-right`, `herdr agent read`, `herdr pane
close`), so an agent can open panes, run work, wait, read, summarize, close.

What herdr does **not** provide: task DAG, ownership/claim, reliable mailbox, turn-level
acknowledgement, handoff. Its `wait` waits on lifecycle state, not a specific turn.

> Sourcing: repo metadata, README and feature set from the primary source. Verbatim subcommand
> names come from a third-party guide; herdr's own API reference was unreachable. Treat exact op
> names as indicative.

What we take as reference: the roster-with-live-state UX, detach/reattach, persistent background
server, agent-drivable control API. What we deliberately do not take: being a multiplexer,
hosting other vendors' CLIs, screen-scraped state.

## 2. Current implementation, traced

Findings that determined the design. All line references at `002305b90`.

### 2.1 `Backend` fuses five concerns and its main implementer stubs most of them

`packages/core/src/agents/backends/types.ts` defines one 20-method interface:

| Concern             | Methods                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| Process lifecycle   | `spawnAgent` `stopAgent` `stopAll` `cleanup` `setOnAgentExit` `waitForAll` |
| Navigation          | `switchTo` `switchToNext` `switchToPrevious` `getActiveAgentId`            |
| Screen capture      | `getActiveSnapshot` `getAgentSnapshot` `getAgentScrollbackLength`          |
| Input               | `forwardInput` `writeToAgent` `resizeAll`                                  |
| External display    | `getAttachHint`                                                            |
| **Semantic handle** | `getAgent?()` — _optional, in-process only_                                |

`InProcessBackend` — the only backend actually wired up — implements the display half as
**no-ops**: `getActiveSnapshot`/`getAgentSnapshot` return `null` (`InProcessBackend.ts:338,342`),
`getAgentScrollbackLength` returns `0` (`:349`), `forwardInput` returns `false` (`:355`),
`resizeAll` is empty (`:370`), `getAttachHint` returns `null` (`:376`).

The semantic seam is an optional escape hatch on a display interface, and its own doc comment
states the consequence: _"PTY-based backends (tmux, iTerm2) don't expose an agent handle because
the agent runs in a subprocess."_ To get panes you surrender coordination; to keep coordination
you stay in-process.

### 2.2 `TeamManager` needs very little, which makes the seam cheap

`TeamManager` calls `getAgentFromBackend()` in ~14 places (`TeamManager.ts:1298`) and uses only
five methods of `TeamAgentHandle`: `getStatus`, `getEventEmitter`, `enqueueMessage`, `abort`,
`getError?`.

It subscribes to **four** of nineteen event types (`TeamManager.ts:1486-1510`):
`STATUS_CHANGE`, `TOOL_CALL`, `TOOL_RESULT`, `TOOL_WAITING_APPROVAL`.

### 2.3 Message delivery is already queue-and-flush, leader-side

`flushNextMessage` (`TeamManager.ts:1581`) gates on `agent.getStatus() !== IDLE`, then delivers
by priority: shutdown mailbox → pending queue → auto-claim. Sender attribution is wrapped in a
**fresh per-delivery nonce envelope** (`:1613-1628`) to prevent teammate impersonation, and
delivery is wrapped in AsyncLocalStorage identity (`enqueueWithIdentity`, `:1646`).

The queue lives in the leader. Only the final `enqueueMessage` call touches the agent. **The
transport is swappable without touching the security model**, provided the envelope stays
leader-side.

### 2.4 The coordination plane is already cross-process capable

`tasks.ts` and `mailbox.ts` are already file-based under `~/.qwen/teams/{team}/` with locking and
atomic writes — inboxes at `inboxes/{agentName}.json` (`mailbox.ts:167`), tasks at
`tasks/{taskId}.json` (`tasks.ts:191`) with `claimTask`, `releaseOwnedTask`,
`unassignTeammateTasks`.

**No second task database is needed.** Only two pieces are process-local:

- `notifyTasksUpdated` (`tasks.ts:212`) — an in-memory `EventEmitter` driving auto-claim.
- `identity.ts` — AsyncLocalStorage, whose predicate is already named `isInProcessTeammate()`.

And the leader **already polls its own inbox** (`ensureLeaderInboxPolling` `:876`,
`drainLeaderInbox` `:901`). So teammate→leader messaging needs **no new transport at all** for a
first release; a socket wake signal is a latency optimization, not a correctness requirement.

### 2.5 One tool is hard-bound to in-process

`send_message` requires `this.config.getTeamManager()` (`send-message.ts:221`) — an in-process
object. `task_update` by contrast uses `resolveActiveTeamName` + file-based `tasks.ts`
(`task-update.ts:194`) and already works out of process once identity is available.

### 2.6 The tab UI's coupling is small, and a read-only path already exists

`RegisteredAgent` holds a concrete `AgentInteractive` (`AgentViewContext.tsx:36`), but the tab
components consume very little of it: `getCore` ×2, `getStatus`, `getEventEmitter`,
`enqueueMessage`. The rendering reads from `AgentCore`
(`AgentChatContent.tsx:106-115`): `getMessages`, `getPendingApprovals`, `getLiveOutputs`,
`getShellPids`, plus `getExecutionStartTimes` and `getStatus` from the interactive.

Two facts make remote rendering easy: `AgentChatContent` already supports a read-only mode
(`readonly = !interactiveAgent`, `:59`), and `agentHistoryAdapter` documents that
`AgentMessage[]` is **append-only** — so an incremental delta stream over a socket is a natural
fit.

`useTeamInProcess.ts:88` hard-guards `backend.type !== DISPLAY_MODE.IN_PROCESS → return null`.
That is the UI-side coupling to remove.

### 2.7 The control plane is designed and half-built

`packages/cli/src/agent-view/` (merged, #7799) already has: protocol types separating
`SessionState` / `ProcessState` / `AttachState` / `Ownership`; worktree ownership; a roster; a
supervisor file with socket path and auth token; a store with atomic read/write for every file;
a framed socket server with streaming ops; a typed client; a runner that can spawn the supervisor
(`supervisor-runner.ts`, with `buildCurrentQwenCliArgv` handling dev-tsx/bundled/global relaunch);
and a generic PTY↔stdio `terminal-bridge.ts` that abstracts the PTY behind an interface.

Critically, `AgentViewWorkerControlEvent` of type `answer` already carries `callId` and an
`outcome` enum (`protocol.ts:191-207`) — precisely the replacement for the in-process approval
closure.

What is **not** implemented: `AgentViewSupervisorProcessHandler` implements only `status`, `list`,
`subscribe`, `shutdown` (`supervisor-process.ts:113-147`). Every worker-managing op —
`dispatch`, `send`, `answer`, `stop`, `kill`, `respawn`, `attachStream`, `peek`, `logs` — is
declared optional on the handler interface (`supervisor-server.ts:31-50`) and unimplemented.
`hibernateIdleSessions` returns an empty array. The `subscribers` set exists but nothing
broadcasts to it. No session state file is ever written.

## 3. Target architecture

### 3.1 Ownership: what each contract owns

| Contract           | Owns                                                                                                          | Does **not** own                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **`AgentSession`** | One agent's _semantics_: status, turn correlation, message delivery, approval requests, abort                 | How the agent runs; how it is displayed           |
| **`AgentRuntime`** | _Existence and lifecycle_ of sessions: start, reattach, list, stop, kill, answer-routing, crash recovery      | What a turn means; any rendering                  |
| **`AgentSurface`** | _Presentation_: which sessions are visible, focus, raw-terminal attach, resize                                | Any coordination decision; any lifecycle decision |
| **`TeamManager`**  | _Orchestration_: task assignment, message priority and envelopes, shutdown protocol, plan approval, team file | How any agent is executed or shown                |

The rule that keeps this honest: **`TeamManager` may only touch `AgentSession` and
`AgentRuntime`. It must never see a `Surface`, a PTY, or a socket.**

### 3.2 Module structure

```
packages/core/src/agents/fleet/          NEW — vendor-neutral contracts
  session.ts          AgentSession, event map, ApprovalRequest/Decision, TurnId
  runtime.ts          AgentRuntime, AgentSpec, AgentSessionDescriptor
  view.ts             AgentSessionView (render projection)
  approvals.ts        ApprovalRegistry (callId → responder, one-shot)
  index.ts

packages/core/src/agents/team/           EXISTING — retargeted, logic unchanged
  TeamManager.ts      depends on AgentRuntime + AgentSession (was: Backend)
  tasks.ts            unchanged
  mailbox.ts          unchanged
  identity.ts         + env-based resolution for subprocess teammates
  taskNotifier.ts     NEW — pluggable notification transport (default: in-memory)

packages/core/src/agents/runtime/inproc/ ADAPTED from InProcessBackend
  InProcessRuntime.ts     lifecycle half of InProcessBackend
  InProcessSession.ts     wraps AgentInteractive, adds turnId correlation

packages/cli/src/agent-view/             EXISTING supervisor + NEW adapters
  supervisor-*.ts         existing; add the missing handler ops
  SupervisedRuntime.ts    NEW — AgentRuntime over the supervisor socket
  RemoteSession.ts        NEW — AgentSession over the supervisor socket
  session-projection.ts   NEW — transcript delta stream → AgentSessionView
  teammate-entry.ts       NEW — subprocess entry: --internal-fleet-teammate

packages/cli/src/ui/agent-view/          ADAPTED
  AgentViewContext        holds AgentSessionView, not AgentInteractive
  FleetRoster.tsx         NEW — herdr-style roster with live state

packages/core/src/agents/backends/       DEPRECATED, migrated last
  Backend / InProcessBackend / TmuxBackend / ITermBackend
```

**Dependency rule**: `core` defines the contracts; `cli` implements the supervised runtime and
injects it. Core must never import `agent-view`. Injection point: a runtime factory registered on
`Config` at CLI startup, resolved by `team-create.ts` instead of today's hardcoded
`new InProcessBackend(this.config)` (`team-create.ts:138`).

### 3.3 Key interfaces

```ts
// packages/core/src/agents/fleet/session.ts

export type TurnId = string;
export type AgentSessionKind = 'in-process' | 'supervised';

/**
 * The semantic contract TeamManager depends on. Satisfied by an in-process
 * AgentInteractive and by a supervised subprocess over the supervisor socket.
 * Deliberately contains no terminal, pane, or rendering concept.
 */
export interface AgentSession {
  readonly agentId: string;
  readonly teamId: string;
  readonly kind: AgentSessionKind;

  getStatus(): AgentStatus;
  getError(): string | undefined;

  /** Deliver one turn. The returned id correlates every event for that turn. */
  send(message: string): Promise<TurnId>;

  /** Abort the in-flight turn; the session stays alive and returns to idle. */
  cancelTurn(): void;

  /** Terminal stop of this session. */
  abort(): void;

  on<E extends keyof AgentSessionEvents>(
    event: E,
    handler: (payload: AgentSessionEvents[E]) => void,
  ): Unsubscribe;
}

export interface AgentSessionEvents {
  status: {
    previous: AgentStatus;
    next: AgentStatus;
    /** Present when the transition ends a turn. */
    turnId?: TurnId;
    cancelledByUser?: boolean;
  };
  /** Final model-visible answer for a turn. */
  turnText: { turnId: TurnId; text: string };
  approvalRequest: ApprovalRequest;
  toolActivity: {
    turnId: TurnId;
    phase: 'call' | 'result';
    toolName: string;
    callId: string;
  };
  exited: { code: number | null; reason: string };
}

/** Serializable approval — no closure, so it can cross a process boundary. */
export interface ApprovalRequest {
  callId: string;
  turnId: TurnId;
  agentId: string;
  toolName: string;
  details: SerializableConfirmationDetails;
}

export interface ApprovalDecision {
  callId: string;
  outcome: ToolConfirmationOutcome;
  payload?: Record<string, unknown>;
}
```

```ts
// packages/core/src/agents/fleet/runtime.ts

export interface AgentSpec {
  agentId: string;
  teamId: string;
  name: string;
  cwd: string;
  worktreePath?: string;
  systemPrompt: string;
  identity: TeammateIdentity;
  toolConfig?: ToolConfig;
  modelConfig?: ModelConfig;
  approvalMode?: ApprovalMode;
  readOnly?: boolean;
}

export interface AgentRuntime {
  readonly kind: AgentSessionKind;

  start(spec: AgentSpec): Promise<AgentSession>;

  /** Rebind to a session that outlived this leader process. */
  reattach(agentId: string): Promise<AgentSession | undefined>;

  /** Enumerate sessions this runtime can see — roster and recovery. */
  list(teamId?: string): Promise<AgentSessionDescriptor[]>;

  stop(agentId: string, opts?: { graceMs?: number }): Promise<void>;
  kill(agentId: string): Promise<void>;

  /** Resolve a pending approval. One-shot; a second call is a no-op. */
  answer(agentId: string, decision: ApprovalDecision): Promise<void>;

  dispose(): Promise<void>;
}

export interface AgentSessionDescriptor {
  agentId: string;
  teamId: string;
  name: string;
  status: AgentStatus;
  processState: 'starting' | 'alive' | 'hibernated' | 'restarting' | 'exited';
  cwd: string;
  worktreePath?: string;
  lastActivityAt: string;
  /** Set when status is blocked; drives the roster's "waiting" affordance. */
  waitingFor?: { callId: string; toolName: string; summary: string };
}
```

```ts
// packages/core/src/agents/fleet/view.ts
// Derived from exactly what AgentChatContent reads today.

export interface AgentSessionView {
  getStatus(): AgentStatus;
  getMessages(): readonly AgentMessage[]; // append-only
  getPendingApprovals(): ReadonlyMap<string, SerializableConfirmationDetails>;
  getLiveOutputs(): ReadonlyMap<string, ToolResultDisplay>;
  getShellPids(): ReadonlyMap<string, number>;
  getExecutionStartTimes(): ReadonlyMap<string, number>;
  readonly workingDir: string;
  readonly modelId: string;
  onChange(cb: () => void): Unsubscribe;
}
```

```ts
// packages/cli — presentation only, never seen by core orchestration.

export interface AgentSurface {
  readonly kind: 'tab' | 'tmux' | 'none';
  present(agentId: string, view: AgentSessionView): Disposable;
  focus(agentId: string): void;
  /** True raw-terminal attach. Absent when the runtime has no PTY. */
  attachTerminal?(agentId: string, io: TerminalIo): Promise<Disposable>;
  attachHint(): string | null;
}
```

## 4. Flows

### 4.1 Spawn a supervised teammate

```
leader: TeamManager.spawnTeammate(config)
  → runtime.start(spec)                        [SupervisedRuntime]
  → supervisor.dispatch({ spec, launch })      [socket]
  → supervisor writes state.json + launch.json, ownership='managed'
  → spawn: qwen --internal-fleet-teammate --team <id> --agent <id> \
            --session-id <uuid> --task-file <path>
  → worker connects back, authenticates with per-spawn token
  → worker emits `ready` {capabilities}
  → supervisor: processState='alive', sessionState='idle', broadcast to subscribers
  → SupervisedRuntime resolves RemoteSession
  → TeamManager registers member, attaches event bridge (unchanged logic)
```

The launch token is generated per spawn, never persisted in `launch.json` (digest only), and
stripped from any grandchild environment via `sanitize-child-env.ts`.

### 4.2 Leader → teammate message

Unchanged above the transport. The queue, priority ordering, nonce envelope and identity wrap all
stay in `TeamManager`:

```
TeamManager.flushNextMessage(agentId)
  → gate on session.getStatus() === IDLE
  → build nonce envelope (unchanged, leader-side)
  → session.send(labeled) → TurnId
      in-process:  runWithTeammateIdentity(identity, () => interactive.enqueueMessage(text))
      supervised:  supervisor.send({ sessionId, text, turnId })
                   → worker enqueues into its own AgentInteractive
```

### 4.3 Teammate → leader report

**No new transport required.** The teammate writes the mailbox file; the leader's existing poll
drains it.

```
teammate: send_message tool
  → in-process:  config.getTeamManager().sendMessage(...)      [today's path]
  → supervised:  writeMessage(team, LEADER_NAME, envelope)     [file, already supported]
                 + optional socket `report` for low latency
leader: drainLeaderInbox() (existing poll)  →  leader turn
```

`send_message` (`send-message.ts:221`) is the single tool needing a second route: when there is
no in-process `TeamManager` but a teammate identity is present, write the mailbox directly.

### 4.4 Approval

The closure never crosses a boundary — it stays in a one-shot registry on the owning side.

```
teammate tool call needs confirmation
  → owning side registers respond-closure under callId  [ApprovalRegistry]
  → session emits approvalRequest { callId, turnId, toolName, details }
  → TeamManager → leaderPermissionBridge → leader UI (existing badge/forward path)
  → leader decides
  → runtime.answer(agentId, { callId, outcome })
      in-process:  registry.resolve(callId, outcome)   — deletes on use
      supervised:  supervisor.answer({ sessionId, callId, outcome })
                   → worker resolves its own pending confirmation, one-shot
```

Timeout keeps the session in `blocked`; it never auto-answers.

### 4.5 Reattach and recovery

```
leader restarts
  → runtime.list(teamId)                 [from supervisor store, not memory]
  → for each descriptor: runtime.reattach(agentId)
  → RemoteSession replays transcript (logs/peek) into its projection
  → TeamManager rebinds members from the team file
```

Supervisor restart rebuilds its projection from the state files. Any state it cannot confirm is
marked `failed` with a reason — **never guessed as `completed`**. Stale events from a previous
worker generation are rejected.

## 5. Component disposition

| Component                                                | Disposition                         | Notes                                                                                              |
| -------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `tasks.ts`, `mailbox.ts`                                 | **Reuse as-is**                     | Already file-based and cross-process                                                               |
| `TeamManager` coordination logic                         | **Reuse as-is**                     | Queues, priority, nonce envelopes, shutdown protocol, plan approval, auto-claim — the crown jewels |
| `TeamManager` backend binding                            | **Adapt**                           | `Backend` → `AgentRuntime` + `AgentSession`                                                        |
| `TeamAgentHandle`                                        | **Adapt** → `AgentSession`          | Superset: adds `turnId`, `on()`, `cancelTurn()`. Keep a type alias through migration               |
| `InProcessBackend`                                       | **Split**                           | Lifecycle half → `InProcessRuntime`; `getAgent` → `InProcessSession`; no-op display half → deleted |
| `agent-view` protocol + store + server + client + runner | **Reuse as-is**                     | Already the right contract                                                                         |
| `agent-view` handler ops                                 | **Implement**                       | `dispatch`, `send`, `answer`, `stop`, `kill`, `list`, `subscribe` broadcast                        |
| `terminal-bridge.ts`                                     | **Reuse, defer**                    | Only needed for Phase 5 raw attach                                                                 |
| `identity.ts`                                            | **Extend**                          | Add env-based resolution alongside AsyncLocalStorage                                               |
| `notifyTasksUpdated`                                     | **Adapt**                           | Extract a `TaskNotifier` seam; default in-memory, supervised fan-out later                         |
| `send_message` tool                                      | **Adapt**                           | Add the no-TeamManager mailbox route                                                               |
| `AgentViewContext` / tab UI                              | **Adapt**                           | Depend on `AgentSessionView`, not `AgentInteractive`                                               |
| `Backend` interface                                      | **Deprecate**                       | Kept exported during migration; deleted after Arena migrates                                       |
| `TmuxBackend` / `ITermBackend`                           | **Defer** → optional `AgentSurface` | Not on the critical path                                                                           |
| Arena + `ArenaManager`                                   | **Keep, migrate last**              | Competitive model is legitimately different; needs Runtime + Surface, not Team coordination        |
| `/coordinate` skill                                      | **Keep**                            | Becomes the natural-language entry; #8804's `read_only` lands here                                 |

## 6. MVP versus eventual architecture

The MVP boundary is drawn to avoid building terminal infrastructure before the semantic layer
works.

| Capability                                                     | MVP                   | Eventual                      |
| -------------------------------------------------------------- | --------------------- | ----------------------------- |
| Independent persistent teammate processes                      | ✅                    | ✅                            |
| Roster with live state (working/blocked/idle/completed/failed) | ✅                    | ✅                            |
| Inspect a teammate while running                               | ✅ via transcript tab | ✅ + raw PTY attach           |
| Interact with one teammate directly                            | ✅ via tab composer   | ✅ + full terminal takeover   |
| Messages with turn correlation                                 | ✅                    | ✅                            |
| Explicit routable approvals                                    | ✅                    | ✅                            |
| Leader restart → reattach                                      | ✅                    | ✅                            |
| Teammate→leader latency                                        | poll (existing)       | socket wake                   |
| Task-change notification across processes                      | poll                  | socket fan-out                |
| Raw terminal attach / resize / scrollback                      | ❌                    | ✅ (`terminal-bridge`)        |
| Hibernation / respawn                                          | ❌                    | ✅                            |
| tmux / external surfaces                                       | ❌                    | ✅ optional adapters          |
| Heterogeneous CLIs, remote/SSH                                 | ❌                    | ❌ — permanently out of scope |

**MVP op set** on the supervisor: `dispatch`, `send`, `answer`, `stop`, `kill`, `list`,
`subscribe`. That is seven handlers, not the full nineteen.

## 7. Phased plan

Phases 1–4 are pure refactors with **no user-visible change**. Behavior changes begin at Phase 5.

| #   | Phase                                                                               | User-visible? | Unlocks                                                                                                                |
| --- | ----------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Extract `AgentSession` from `TeamAgentHandle`; retarget `TeamManager`               | No            | The seam. Nothing else is possible without it                                                                          |
| 2   | Extract `AgentSessionView`; tab UI depends on it, not `AgentInteractive`            | No            | Remote sessions can render in existing tabs                                                                            |
| 3   | Split `Backend` → `AgentRuntime` + `AgentSurface`; `InProcessBackend` splits in two | No            | Runtime becomes pluggable; display no-ops deleted                                                                      |
| 4   | Add `turnId` correlation + `ApprovalRegistry` (in-process only)                     | No            | Correlation and approvals work before any IPC exists                                                                   |
| 5   | `SupervisedRuntime` + `RemoteSession` + the seven supervisor handlers               | **Yes**       | **MVP**: real independent persistent teammates, roster, inspection, correlated messaging, routable approvals, reattach |
| 6   | Socket fan-out for mailbox + task notification                                      | Yes (latency) | Removes polling                                                                                                        |
| 7   | Raw PTY attach via `terminal-bridge`; hibernation/respawn                           | Yes           | "Enter the session" and long-idle survival                                                                             |
| 8   | Arena migrates to Runtime + Surface; `Backend` deleted; tmux as optional surface    | No            | One runtime model repo-wide                                                                                            |

Phases 1–4 are worth landing regardless of whether 5–8 ever ship: they delete dead no-op code,
remove a concrete-class dependency from the UI, and make approvals correlatable in-process.

## 8. Landable as isolated refactors

Each is independently reviewable and revertible, with no behavior change:

- **R1** — `AgentSession` interface + `TeamAgentHandle` alias; `InProcessSession` wrapper. Tests:
  existing `coordination-harness.test.ts` must pass untouched.
- **R2** — `AgentSessionView` extraction; `AgentChatContent`/`AgentChatView` consume it;
  `RegisteredAgent.interactiveAgent` becomes `view`. Removes the
  `DISPLAY_MODE.IN_PROCESS` guard at `useTeamInProcess.ts:88`.
- **R3** — `Backend` split; `InProcessBackend` → `InProcessRuntime` + `InProcessSession`; the six
  no-op display methods deleted rather than ported.
- **R4** — `turnId` threaded through `AgentInteractive` events; `ApprovalRegistry` with one-shot
  semantics; `leaderPermissionBridge` routes by `callId`.
- **R5** — `TaskNotifier` seam extracted from `notifyTasksUpdated`; default implementation is
  today's in-memory emitter.
- **R6** — `identity.ts` gains env-based resolution; `send_message` gains the mailbox route. Both
  dormant until a subprocess teammate exists.

## 9. Risks and compatibility

**Concurrency on the task board — verified, no upgrade needed.** Two or more OS processes will
mutate `~/.qwen/teams/{team}/`. Both `tasks.ts` and `mailbox.ts` already implement a deliberate
two-tier lock: an in-process `async-mutex` serializing local writers, wrapping a
`proper-lockfile` **cross-process file lock** (`retries: 30`, randomized exponential backoff
5→100ms, `stale: 5000`, `onCompromised` handler), over `atomicWriteJSON`. The in-source rationale
names the multi-process case directly — the mutex exists so local writers "don't stampede the
file lock", which is retained "to still guard against writers in other agent processes" — and the
jitter comment cites `scanIdleAgentsForTasks` racing `MAX_TEAMMATES` claimants at one task file.

The coordination plane was built for multi-process access. Phase 5 needs **no lock upgrade**, and
a crashed teammate's lock self-clears after the 5s stale window, which also gives recovery a
defined bound.

**Secret inheritance.** Teammate subprocesses must not inherit supervisor tokens into their own
shell/MCP/hook children. Route every spawn through `sanitize-child-env.ts`.

**Nested fan-out.** A teammate must not spawn its own team. Enforce a denial-only marker at the
process-spawn boundary, and reject `team_create` when a teammate identity is present.

**Cost.** N teammate processes each carry a full context. The existing `MAX_TEAMMATES` cap
applies; the roster should surface per-teammate token usage.

**Approval storms.** N blocked teammates can queue N approvals at the leader. The roster must
show all blocked sessions at once, and the leader UI must handle a queue, not a single modal.

**Windows.** Named pipes are already handled in `getAgentViewSupervisorSocketPath`
(`supervisor-process.ts:68`), but subprocess teammates and later PTY attach need explicit Windows
validation.

**Compatibility.** `Backend` and `TeamAgentHandle` stay exported through Phases 1–7. Existing
in-process teams keep working unchanged — the in-process runtime is the default. Supervised
teammates sit behind a new gate (`experimental.fleet`) layered on the existing
`experimental.agentTeam`.

**Settings drift.** A teammate process re-reads settings independently. Its execution profile must
be locked from the spec at launch, ignoring user-config sources that could execute code.

## 10. Remaining questions, and who answers them

The four product decisions in §0.1 are settled, and the cross-process locking question is
resolved in §9. What remains are implementation choices, to be made with engineering judgment
during the phase that needs them rather than escalated:

1. Does `AgentApprovalRequestEvent` already carry a stable `callId`, or must one be introduced?
   Determined by tracing during R4.
2. Stream a teammate's transcript continuously, or fetch on tab focus? Default to streaming
   append-only deltas with a bounded buffer; revisit only if large teams show cost pressure.
3. Leader poll interval for MVP. Tune against real runs; socket fan-out (Phase 6) supersedes it.
4. `worktreePath` ownership on teammate crash — reuse the `WorktreeSession` receipt or extend the
   supervisor's `AgentViewWorktreeState`. Decide by tracing both during Phase 5.
5. Naming, module paths, socket op names, and how R1–R6 are grouped into PRs.

Escalate only if one of these turns out to change user-visible behavior or contradict §0.1.

## 11. What this means for open work

- **#8804** — land the `read_only` enforcement, corrected to a four-tool inspection base rather
  than reusing the seven-tool plan-mode _pre-approval_ list (a UX list being used as a security
  boundary). Split out `working_dir` and the auto-forward change. Under this architecture
  `read_only` becomes a field on `AgentSpec`, applied by whichever runtime starts the session.
- **#7800–#7803** — this is Phase 5's dependency. The protocol is right; the handlers are what is
  missing. Consider landing only the seven MVP ops rather than the full stack.
- **Arena tmux split panes** — orthogonal. Stands alone as a fix to a documented-but-absent
  feature; becomes an `AgentSurface` in Phase 8. Not a step toward this architecture.
