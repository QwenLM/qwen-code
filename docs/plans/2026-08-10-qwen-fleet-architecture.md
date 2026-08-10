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
| `terminal-bridge.ts`                                     | **Reuse, defer**                    | Only needed for PR 3 raw attach                                                                    |
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
works. "MVP" below means **the state after PR 1B** (§7.3); the PR column names where each
capability lands.

| Capability                                                  | MVP                   | Lands in | Eventual                      |
| ----------------------------------------------------------- | --------------------- | -------- | ----------------------------- |
| Independent teammate processes                              | ✅                    | 1B       | ✅                            |
| Live teammate state (working/blocked/idle/completed/failed) | ✅                    | 1B       | ✅                            |
| Inspect a teammate while running                            | ✅ via transcript tab | 1B       | ✅ + raw PTY attach           |
| Interact with one teammate directly                         | ✅ via tab composer   | 1B       | ✅ + full terminal takeover   |
| Messages with turn correlation                              | ✅                    | 1A       | ✅                            |
| Explicit routable approvals                                 | ✅                    | 1A       | ✅                            |
| Enforced read-only teammates                                | ✅                    | 1A       | ✅                            |
| Clean leader exit stops teammates                           | ✅                    | 1B       | ✅                            |
| Leader crash → teammate survival, restart → reattach        | ❌                    | 2        | ✅                            |
| Single-leader lock                                          | ❌                    | 2        | ✅                            |
| Teammate→leader latency                                     | poll (existing)       | 2        | socket wake                   |
| Task-change notification across processes                   | poll                  | 2        | socket fan-out                |
| Raw terminal attach / resize / scrollback                   | ❌                    | 3        | ✅ (`terminal-bridge`)        |
| Hibernation / respawn                                       | ❌                    | 3        | ✅                            |
| tmux / external surfaces                                    | ❌                    | 3        | ✅ optional adapters          |
| Heterogeneous CLIs, remote/SSH                              | ❌                    | —        | ❌ — permanently out of scope |

**MVP op set** on the supervisor: `dispatch`, `send`, `answer`, `stop`, `list`, `subscribe`, plus
a shutdown broadcast. Six handlers plus the existing three, not the full nineteen; `kill`,
`respawn` and the attach/peek family are deferred to PR 2 and PR 3.

## 7. Implementation strategy

The work ships as **four PRs**, not a long refactor chain. Each delivers something exercisable.

### 7.1 Sizing verdict

A single PR containing the whole MVP measures at roughly **3,400 production LOC + 3,400 test LOC
across ~50 files**. That is too large to review in this repository — for scale, #8804 was
398+/52− across 12 files. There is no _correctness_ reason it cannot be one PR; the objection is
reviewability alone.

The smallest adjustment that keeps every PR exercisable is to split the MVP once, at the
**process boundary**: in-process semantics first, subprocess runtime second. This yields four
PRs total, and PR 1A still changes real product behaviour rather than being pure plumbing.

### 7.2 Reuse categorisation

The reason PR 1 is tractable at all is that most of the machinery already exists.

**Reused unchanged — 0 LOC written (~4,360 LOC of existing behaviour):**

| Module                            | LOC   | Why it holds                                      |
| --------------------------------- | ----- | ------------------------------------------------- |
| `tasks.ts`                        | 1,050 | file-based, cross-process locked, claim protocol  |
| `mailbox.ts`                      | 361   | same lock model; already the teammate→leader path |
| `teamHelpers.ts`                  | 378   | pure helpers                                      |
| `agent-view/supervisor-store.ts`  | 677   | atomic read/write for every protocol file         |
| `agent-view/supervisor-client.ts` | 670   | typed client; every op already declared           |
| `agent-view/supervisor-server.ts` | 547   | framing, auth, streaming-op dispatch              |
| `agent-view/terminal-bridge.ts`   | 249   | untouched until PR 3                              |
| `agent-view/protocol.ts`          | 207   | types already model the target state planes       |
| `agentHistoryAdapter.ts`          | ~180  | `AgentMessage[]` → `HistoryItem[]`                |
| `agent-view/current-cli-argv.ts`  | 40    | dev-tsx / bundled / global relaunch               |

**Adapter only — existing code retargeted, ~900 LOC changed:**

| Module                                        | File LOC | Changed | Nature                                                          |
| --------------------------------------------- | -------- | ------- | --------------------------------------------------------------- |
| `TeamManager.ts`                              | 1,829    | ~200    | 14 `getAgentFromBackend` + 5 `this.backend.*` + event bridge    |
| `InProcessBackend.ts`                         | 715      | ~290    | split; extract `createPerAgentConfig` (`:487`); delete 6 no-ops |
| `agent-interactive.ts`                        | 545      | ~80     | thread `turnId` through the message pump                        |
| `fake-backend.ts` + `coordination-harness.ts` | 406      | ~120    | test doubles satisfy the new contracts                          |
| `AgentViewContext.tsx`                        | 301      | ~70     | hold a view, not `AgentInteractive`                             |
| `useTeamInProcess.ts`                         | 190      | ~50     | drop the `DISPLAY_MODE.IN_PROCESS` guard                        |
| `leaderPermissionBridge.ts`                   | 142      | ~40     | route by `callId`                                               |
| `identity.ts`                                 | 96       | ~50     | env-based resolution for subprocesses                           |
| `send-message.ts`                             | ~300     | ~40     | no-`TeamManager` mailbox route                                  |
| `team-create.ts`                              | ~250     | ~25     | resolve runtime from an injected factory                        |
| `gemini.tsx`                                  | 1,426    | ~20     | two early dispatches — low LOC, **high risk**                   |

**Genuinely new — ~2,480 production LOC:**

| Module                                            | Est. |
| ------------------------------------------------- | ---- |
| supervisor handler ops (7)                        | 450  |
| `fleet/session.ts` + `runtime.ts` + `view.ts`     | 320  |
| teammate subprocess entrypoint + agent host       | 320  |
| `SupervisedRuntime.ts`                            | 280  |
| `RemoteSession.ts`                                | 260  |
| `session-projection.ts`                           | 220  |
| teammate sideband client                          | 180  |
| `fleet/serializable-confirmation.ts` (6 variants) | 140  |
| `fleet/approvals.ts` (one-shot registry)          | 130  |
| supervisor process entrypoint                     | 120  |
| feature gate + settings                           | 60   |

**Deliberately left in place — PR 1 does not touch:**

`Backend` stays exported and Arena keeps using it. `TmuxBackend`, `ITermBackend`, `ArenaManager`,
`terminal-bridge.ts` are untouched. `TeamAgentHandle` remains as a type alias. The display no-ops
survive on `Backend` for Arena's sake even though `InProcessRuntime` drops them. Hibernation,
respawn, `kill`, and the roster's own UI component are all deferred — PR 1B surfaces teammate
status through the **existing `AgentTabBar`**, which already renders per-agent state indicators.

### 7.3 The four PRs

| PR     | Scope                                  | Prod LOC | Test LOC | Files | Review risk | Impl. risk |
| ------ | -------------------------------------- | -------- | -------- | ----- | ----------- | ---------- |
| **1A** | Fleet contracts + in-process semantics | ~1,300   | ~1,400   | ~25   | Medium      | Low        |
| **1B** | Supervised runtime — **the MVP**       | ~1,900   | ~2,000   | ~25   | High        | High       |
| **2**  | Persistence, recovery, hardening       | ~1,200   | ~1,600   | ~20   | Medium      | Medium     |
| **3**  | PTY attach + legacy cleanup            | ~1,100   | ~1,000   | ~25   | Medium      | Medium     |

#### PR 1A — Fleet contracts and in-process semantics

Contracts, `ApprovalRegistry` with one-shot semantics, serializable confirmation details, turn
correlation, `TeamManager` migration, `InProcessBackend` split, view extraction, and #8804's
`read_only` enforcement folded in (§0.1 makes it load-bearing).

_Demonstrable:_ in-process teammates whose turns are correlated end to end, whose approvals reach
the leader with real call IDs and cannot be double-answered, and whose read-only mode is enforced
by the runtime rather than by prompt. This is product behaviour, not plumbing.

_Incomplete:_ no subprocess teammates; teammates still share the leader process.

_Risk note:_ low implementation risk — everything is in one process and the existing
`coordination-harness.test.ts` (751 LOC) acts as the regression net. Review risk is medium
because `TeamManager` is touched in ~19 places.

Commits:

1. `fleet/` contracts + `TeamAgentHandle` alias
2. serializable confirmation details + `ApprovalRegistry`
3. `turnId` correlation through `AgentInteractive`
4. `InProcessBackend` split into `InProcessRuntime` + `InProcessSession`
5. `TeamManager` retargeted to `AgentRuntime`/`AgentSession`
6. `AgentSessionView` extraction in the tab UI
7. `read_only` enforcement (from #8804)
8. tests + docs

#### PR 1B — Supervised runtime (the MVP)

The six new supervisor ops, the supervisor process entrypoint, the teammate subprocess entrypoint
and sideband, `SupervisedRuntime` / `RemoteSession`, semantic event streaming, session
projection, the `experimental.fleet` gate, and teammate status in the existing tab bar.

_Demonstrable — the acceptance criterion in full:_ one leader plus multiple real Qwen subprocess
teammates, task assignment, reliable semantic messaging, correlated turns, explicit approvals,
live status, and inspectable teammate transcripts, with no PTY attach.

_Incomplete:_ no crash survival, no reattach, no single-leader lock, no socket fan-out (polling
is used), no raw attach.

_Risk note:_ highest of the four. Two new process entrypoints, one of them in `gemini.tsx`, plus
the first cross-process semantic transport.

Commits:

1. supervisor handler ops against the existing store
2. supervisor process entrypoint (`--internal-agent-view-supervisor`)
3. teammate subprocess entrypoint + shared agent construction
4. teammate sideband client (worker → supervisor events)
5. `SupervisedRuntime` + `RemoteSession`
6. session projection into the existing tab UI
7. feature gate + `/coordinate` entry
8. end-to-end tests + docs

#### PR 2 — Persistence, recovery, hardening

Leader crash → teammate survival; leader restart → reattach; worker generation and stale-event
rejection; single-leader lock with stale reclaim; subprocess crash handling; worktree ownership
recovery; socket fan-out replacing polling; Windows lifecycle validation; resource cleanup;
failure-mode tests.

#### PR 3 — Terminal session experience and cleanup

Raw PTY attach via `terminal-bridge`, enter/detach a teammate session, resize and terminal
lifecycle, hibernation and respawn if justified, optional surface adapters, Arena migration, and
deletion of `Backend` once every consumer has moved. Items that grow beyond this should become
independent follow-ups rather than expanding PR 3.

### 7.4 What cannot be deferred out of PR 1B

Three items look like PR 2 hardening but are load-bearing the moment subprocesses exist:

1. **Supervisor-driven teammate shutdown.** §0.1 decided clean leader exit stops teammates.
   Without it, quitting Qwen Code leaves agents running and spending tokens.
2. **Nested fan-out denial.** A teammate that can spawn its own team is a runaway risk from the
   first subprocess. Reject `team_create` when a teammate identity is present.
3. **Token sanitisation.** The teammate's supervisor token must not reach its own shell, MCP, or
   hook children — route every spawn through `sanitize-child-env.ts`.

Conversely, **stale generation rejection genuinely can wait** for PR 2: PR 1B has no respawn and
no reattach, so a worker generation can never rotate within its scope.

## 8. Risks and compatibility

**Concurrency on the task board — verified, no upgrade needed.** Two or more OS processes will
mutate `~/.qwen/teams/{team}/`. Both `tasks.ts` and `mailbox.ts` already implement a deliberate
two-tier lock: an in-process `async-mutex` serializing local writers, wrapping a
`proper-lockfile` **cross-process file lock** (`retries: 30`, randomized exponential backoff
5→100ms, `stale: 5000`, `onCompromised` handler), over `atomicWriteJSON`. The in-source rationale
names the multi-process case directly — the mutex exists so local writers "don't stampede the
file lock", which is retained "to still guard against writers in other agent processes" — and the
jitter comment cites `scanIdleAgentsForTasks` racing `MAX_TEAMMATES` claimants at one task file.

The coordination plane was built for multi-process access. PR 1B needs **no lock upgrade**, and
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

**Compatibility.** `Backend` and `TeamAgentHandle` stay exported until PR 3. Existing
in-process teams keep working unchanged — the in-process runtime is the default. Supervised
teammates sit behind a new gate (`experimental.fleet`) layered on the existing
`experimental.agentTeam`.

**Settings drift.** A teammate process re-reads settings independently. Its execution profile must
be locked from the spec at launch, ignoring user-config sources that could execute code.

## 9. Remaining questions, and who answers them

The four product decisions in §0.1 are settled, and the cross-process locking question is
resolved in §8. What remains are implementation choices, to be made with engineering judgment
during the phase that needs them rather than escalated:

1. Does `AgentApprovalRequestEvent` already carry a stable `callId`, or must one be introduced?
   Determined by tracing during R4.
2. Stream a teammate's transcript continuously, or fetch on tab focus? Default to streaming
   append-only deltas with a bounded buffer; revisit only if large teams show cost pressure.
3. Leader poll interval for MVP. Tune against real runs; socket fan-out (PR 2) supersedes it.
4. `worktreePath` ownership on teammate crash — reuse the `WorktreeSession` receipt or extend the
   supervisor's `AgentViewWorktreeState`. Decide by tracing both during PR 2.
5. Naming, module paths, socket op names, and commit boundaries inside each PR.

Escalate only if one of these turns out to change user-visible behavior or contradict §0.1.

## 10. What this means for open work

- **#8804** — land the `read_only` enforcement, corrected to a four-tool inspection base rather
  than reusing the seven-tool plan-mode _pre-approval_ list (a UX list being used as a security
  boundary). Split out `working_dir` and the auto-forward change. Under this architecture
  `read_only` becomes a field on `AgentSpec`, applied by whichever runtime starts the session.
- **#7800–#7803** — this is PR 1B's dependency. The protocol is right; the handlers are what is
  missing. Consider landing only the seven MVP ops rather than the full stack.
- **Arena tmux split panes** — orthogonal. Stands alone as a fix to a documented-but-absent
  feature; becomes an `AgentSurface` in PR 3. Not a step toward this architecture.

## 11. Execution, issues, and handoff

This section is the contract between implementation agents. An agent should be able to start
from its GitHub issue plus the previous stage's handoff, without any chat history.

### 11.1 Issue structure

**One umbrella, four implementation issues. Nothing finer.**

| Issue                                                    | Role               | PR    | Depends on |
| -------------------------------------------------------- | ------------------ | ----- | ---------- |
| **#8718** (existing)                                     | Umbrella / roadmap | —     | —          |
| `feat(core): fleet contracts and in-process semantics`   | Stage 1A           | PR 1A | —          |
| `feat(cli): supervised teammate runtime (fleet MVP)`     | Stage 1B           | PR 1B | 1A         |
| `feat(cli): fleet persistence, recovery, and hardening`  | Stage 2            | PR 2  | 1B         |
| `feat(cli): teammate terminal attach and legacy cleanup` | Stage 3            | PR 3  | 2          |

Rationale for this shape:

- **#8718 is reused, not replaced.** It is already open, already carries `roadmap/multi-agent`,
  and its title — "Native coordination for independent Qwen sessions" — still describes the work.
  A second umbrella would fragment the roadmap.
- **One issue per PR, 1:1.** An issue spanning two PRs cannot be cleanly closed, and an agent
  picking up work needs exactly one place to read the goal and one place to leave the handoff.
- **1A and 1B stay separate** even though together they are "the MVP". They will be picked up by
  different agents, and each needs its own acceptance criteria and handoff.
- **Stage 3 is created thin and labelled `status/blocked`.** Its real scope depends on what
  Stage 2 leaves behind (whether hibernation is justified, what the recovery model settled on).
  Writing detailed acceptance criteria now would be speculation. It exists so the dependency
  graph is visible; it gets specified when Stage 2 lands.

**Avoid duplicating specs.** The full stage specification lives in §11.3 of this document, which
is in the repository the agent is already working in. Issue bodies carry only what is needed to
_start_: objective, non-goals, prerequisites with a link to the prior handoff, acceptance
checklist, and verification commands. This keeps one source of truth and prevents the issue body
and the design doc from drifting apart.

Labels: `roadmap/multi-agent`, `category/core` (1A) or `category/cli` (1B, 2, 3),
`type/feature-request`, `priority/P2`. Add `status/in-progress` when an agent picks it up,
`status/in-review` when its PR opens, `status/blocked` while prerequisites are unmet.

### 11.2 Handoff protocol

**Where it lives.** The handoff packet is posted as a **final comment on the implementation
issue**, immediately before closing it. Not in the issue body — the body is the spec and must
stay readable as the entry point. Not in the PR description — that is bot-gated against
`.github/pull_request_template.md` and cannot absorb extra headings. The PR description instead
links to the handoff comment.

The next stage's issue links directly to the previous handoff comment URL under
**Prerequisites**. That link is the only thing the next agent needs beyond its own issue.

**Single source of truth.** Handoffs are not mirrored into the repository. If an implementation
agent has no network access, paste the handoff into its task prompt rather than committing a
copy — two locations drift.

**When to close.** An issue closes when its PR **merges**, and only after the handoff comment is
posted. Never close on PR open, and never on "code complete". If a stage lands only partially,
do not close: post a partial handoff, keep `status/in-progress`, and state precisely what is
missing.

**The handoff packet template.** Every implementation agent must post this verbatim structure:

```markdown
## Handoff — Stage <1A|1B|2|3>

**Base commit:** <sha> (`main` at branch point)
**Final head commit:** <sha>
**PR:** #<n> (merged <date>)

### Scope actually implemented

<what was built, in one paragraph, against the stage objective>

### Files and interfaces changed

| File | Change | Interface impact |
| ---- | ------ | ---------------- |

<one row per meaningful file; name every exported type added or changed>

### Behaviour now guaranteed

<numbered list of behaviours a later stage may rely on>

### Tests run and results

| Command | Result |
| ------- | ------ |

<exact commands, copy-pasteable, with pass/fail counts>

### Architecture deviations

<anything that differs from docs/plans/2026-08-10-qwen-fleet-architecture.md, and why.
"None" is a valid answer and should be stated explicitly.>

### Known limitations

<behaviour that is incomplete or degraded, with the condition that triggers it>

### Unresolved review comments

<links, or "none">

### Compatibility adapters still present

<every temporary shim, where it lives, and what removes it>

### Deferred work

<what was consciously not done, and which stage owns it>

### Security invariants upheld

<which invariants from §11.3 this stage is responsible for, and how they are tested>

### Prerequisites for the next stage

<exact, checkable statements the next agent may rely on>

### The next agent must NOT assume

<explicit negative list>
```

### 11.3 Stage specifications

Common to all stages — **invariants that may never be violated**:

- `TeamManager` never imports from `packages/cli`, never sees a surface, a PTY, or a socket.
- The nonce envelope and identity wrap in `flushNextMessage` stay leader-side, whatever the
  transport.
- No second task database, roster, or permission bus is introduced.
- Approval closures never cross a process boundary; only `{callId, outcome}` does.
- Existing in-process teams keep working unchanged at every stage.

---

#### Stage 1A — Fleet contracts and in-process semantics

**Objective.** Establish the three contracts and prove them in-process, delivering correlated
turns, call-ID approval routing, and runtime-enforced read-only teammates.

**Scope.** `fleet/` contracts (`session.ts`, `runtime.ts`, `view.ts`, `approvals.ts`);
serializable confirmation details for all six variants; `turnId` threading through
`AgentInteractive`; `InProcessBackend` split into `InProcessRuntime` + `InProcessSession` with
`createPerAgentConfig` (`InProcessBackend.ts:487`) extracted to a shared module; `TeamManager`
retargeted across its 19 call sites; `AgentSessionView` extraction in the tab UI; #8804's
`read_only` enforcement corrected to a four-tool inspection base.

**Non-goals.** No subprocess. No socket. No supervisor. No `Backend` deletion. No Arena change.
No new UI component.

**Prerequisites.** None — starts from `main`.

**Expected files.** New: `packages/core/src/agents/fleet/*`. Changed: `TeamManager.ts`,
`InProcessBackend.ts`, `agent-interactive.ts`, `leaderPermissionBridge.ts`,
`subagent-plan-tool-policy.ts`, `AgentViewContext.tsx`, `useTeamInProcess.ts`,
`AgentChatView.tsx`, `fake-backend.ts`, `coordination-harness.ts`, `team-create.ts`.

**Expected behaviour.** Teammates spawn through `AgentRuntime`; every turn carries a `turnId`
that correlates its status transitions and final text; teammate approvals reach the leader
carrying a real `callId` and cannot be answered twice; a `read_only` teammate has no shell, write,
memory, schedule, or agent-spawn tool at either the declaration or execution layer.

**Acceptance criteria.**

1. `TeamManager` has zero references to `Backend` or `getAgent`.
2. `coordination-harness.test.ts` passes with only mechanical edits to the fakes.
3. A test proves a second `answer` for the same `callId` is a no-op.
4. A test proves a `read_only` teammate's tool list excludes `run_shell_command`, `save_memory`
   and `create_sub_session` at both layers.
5. A test proves `turnId` on a status transition matches the `turnId` returned by `send()`.
6. The six no-op display methods are deleted from the runtime, not ported.

**Required tests.** Extend `coordination-harness.test.ts`; new `fleet/approvals.test.ts`,
`fleet/serializable-confirmation.test.ts`; update `agent.test.ts` for `read_only`.

**Security invariants.** Read-only enforcement holds at the execution layer even if the model is
prompted otherwise. The four-tool base must not silently inherit the plan-mode pre-approval list.

**Known risks.** `TeamManager` is touched in ~19 places; the regression net is the existing
751-LOC harness. Medium review risk, low implementation risk.

**Deferrable.** `TaskNotifier` seam, `identity.ts` env resolution, `send_message` mailbox route —
all dormant until 1B, and may land in either stage.

**Next agent may assume.** The three contracts exist and are stable; an `AgentRuntime`
implementation is injectable via `Config`; approvals are serializable and one-shot.

**Next agent must NOT assume.** Any subprocess exists; any socket op is implemented; the tab UI
can render a non-in-process session end to end; `Backend` is gone.

---

#### Stage 1B — Supervised teammate runtime (the fleet MVP)

**Objective.** Deliver the first genuinely useful fleet experience: real Qwen subprocess
teammates coordinated by a leader.

**Scope.** Six supervisor handler ops (`dispatch`, `send`, `answer`, `stop`, `list`, plus a
`subscribe` broadcast) against the existing store; the supervisor process entrypoint for
`--internal-agent-view-supervisor`; a teammate subprocess entrypoint reusing the extracted agent
construction; the teammate sideband client; `SupervisedRuntime` + `RemoteSession`;
`session-projection.ts`; the `experimental.fleet` gate; teammate status surfaced through the
existing `AgentTabBar`.

**Non-goals.** No PTY attach, resize, scrollback, or `peek`. No hibernation or respawn. No
reattach. No single-leader lock. No socket fan-out — polling stays. No new roster component.

**Prerequisites.** Stage 1A merged. Read its handoff.

**Expected files.** New: `packages/cli/src/agent-view/SupervisedRuntime.ts`, `RemoteSession.ts`,
`session-projection.ts`, `teammate-entry.ts`, sideband client; supervisor handler ops in
`supervisor-process.ts`. Changed: `gemini.tsx` (two early dispatches), `identity.ts`,
`send-message.ts`, `settingsSchema.ts`, `AgentTabBar.tsx`.

**Expected behaviour — the acceptance demo.** One leader plus two or more real Qwen subprocess
teammates; tasks assigned through the existing shared task list; messages delivered reliably in
both directions; turns correlated; approvals explicit and routable; live status visible; each
teammate's transcript inspectable in a tab. No PTY attach anywhere.

**Acceptance criteria.**

1. A recorded end-to-end run demonstrates the paragraph above with no manual intervention.
2. Teammates are separate OS processes — verifiable by PID.
3. Killing the leader cleanly stops every teammate.
4. A teammate cannot create a team (`team_create` rejected under teammate identity).
5. No `QWEN_AGENT_VIEW_*` credential is visible in a teammate's shell child.
6. Disabling `experimental.fleet` restores exactly today's in-process behaviour.

**Required tests.** Supervisor op tests in the style of `supervisor-server.test.ts`; a
`RemoteSession` contract test asserting parity with `InProcessSession`; an end-to-end test
spawning real subprocesses; env-sanitisation and nested-denial tests.

**Security invariants — none of these may be deferred to Stage 2.**

1. Supervisor-driven teammate shutdown on clean leader exit.
2. Nested fan-out denial under teammate identity.
3. Token sanitisation through `sanitize-child-env.ts` for every spawn.

**Known risks.** Highest of the four stages. Two new process entrypoints, one inside the
1,426-line `gemini.tsx` — dispatch as early as possible, keep logic in separate modules, target
~20 added lines there. First cross-process semantic transport.

**Deferrable.** Everything in the non-goals list, plus `kill`.

**Next agent may assume.** Subprocess teammates run, are coordinated, and are inspectable; the
supervisor persists session state files; the semantic transport is proven.

**Next agent must NOT assume.** Any teammate survives a leader crash; any session can be
reattached; worker generations rotate; the supervisor recovers its projection after restart;
polling has been replaced.

---

#### Stage 2 — Persistence, recovery, and hardening

**Objective.** Turn the working MVP into something robust enough for broader use.

**Scope.** Leader crash → teammate survival; leader restart → `reattach`; worker generation and
stale-event rejection; single-leader lock with stale reclaim (§0.1); subprocess crash handling;
worktree ownership recovery; socket fan-out replacing polling; Windows lifecycle validation;
resource cleanup; failure-mode tests.

**Non-goals.** No PTY attach. No Arena migration. No `Backend` deletion.

**Prerequisites.** Stage 1B merged. Read its handoff.

**Acceptance criteria.**

1. `SIGKILL` on the leader leaves teammates running; the next launch reattaches them.
2. A late event from a superseded worker generation is rejected, not applied.
3. A second leader in the same project sees the roster read-only.
4. A supervisor restart rebuilds its projection; unconfirmable state becomes `failed` with a
   reason and is **never** guessed as `completed`.
5. Fault injection at each crash window either preserves or safely reclaims the worktree, and
   never deletes a dirty one.

**Security invariants.** Stale generation rejection; single-leader lock cannot be stolen inside
its stale window; recovery never fabricates success.

**Known risks.** Recovery correctness is the hard part. Windows is under-validated across the
whole design.

**Next agent must NOT assume.** Any terminal/PTY capability exists.

---

#### Stage 3 — Terminal attach and legacy cleanup

**Objective.** Complete the herdr-like session experience and retire the legacy abstraction.

**Scope (provisional — specify when Stage 2 lands).** Raw PTY attach via the existing
`terminal-bridge.ts`; enter and detach a teammate session; resize and terminal lifecycle;
hibernation and respawn _if Stage 2's evidence justifies them_; optional surface adapters
including tmux; Arena migration to `AgentRuntime` + `AgentSurface`; deletion of `Backend` once
every consumer has moved.

**Non-goals.** Heterogeneous CLI hosting. Remote/SSH transport. Anything that would make this
stage a dumping ground — overflow becomes independent follow-ups.

**Prerequisites.** Stage 2 merged. **This stage is not ready for pickup until its scope is
rewritten against Stage 2's handoff.**

**Note on parallelism.** Arena migration plus `Backend` deletion depends only on Stage 1A, not on
1B or 2. If wall-clock time matters more than a serial queue, it can be split into its own issue
and run in parallel from 1A onward. Default is to keep it here.
