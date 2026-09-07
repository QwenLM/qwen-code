/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Types for the agent agent — durable agent identities that
 * collaborate on a shared thread.
 *
 * The distinction from Agent Team: a teammate is a live in-process loop that
 * receives messages at a tool-round boundary and dies with its leader. A agent
 * agent is an identity whose work happens in a durable background agent that
 * is continued when addressed, so the conversation survives the process, is
 * visible to every participant, and can be replayed.
 */

/** Author id used for messages a person wrote. Never a valid agent id. */
export const HUMAN_AUTHOR_ID = 'user';

export const AGENTS_SCHEMA_VERSION = 1;

/**
 * Where this workspace's notifications go.
 *
 * There is deliberately no default. A notification is a convenience — the
 * state it announces is already durable in the thread and visible in the UI —
 * so guessing a destination would send a person's work to a channel nobody
 * chose. Until this is set, notification events stay pending, which is the
 * same rule every other unconsumed event kind follows.
 */
export interface AgentNotifyTarget {
  channelName: string;
  target: { type: 'user'; id: string } | { type: 'chat'; id: string };
}

export interface AgentWorkspaceState {
  schemaVersion: typeof AGENTS_SCHEMA_VERSION;
  workspaceId: string;
  hostSessionId?: string;
  nextRunSequence: number;
  /** Absent until a person picks one; see {@link AgentNotifyTarget}. */
  notifyTarget?: AgentNotifyTarget;
}

export interface WorkspaceAgentsFile {
  schemaVersion: typeof AGENTS_SCHEMA_VERSION;
  agents: WorkspaceAgent[];
}

/**
 * A durable agent identity, scoped to one workspace.
 *
 * The persona (system prompt, tools, MCP servers, skills) is NOT duplicated
 * here: `agentType` names an existing agent definition and that definition
 * stays the single source of truth, so editing it changes every workspace agent
 * built on it. What lives here is identity and policy — who this agent is in
 * the workspace, and the limits it runs under.
 */
export interface WorkspaceAgent {
  /** Stable id. Never reused, never derived from the name. */
  id: string;
  /**
   * Display name and the token people and agents type after `@`. Unique
   * within a workspace, case-insensitively — mention routing has to be
   * unambiguous, and two agents named `Review` and `review` would make it a
   * coin flip.
   */
  name: string;
  /** Free-text description. Display only; never enters a prompt. */
  description?: string;
  /** Hex colour (`#rrggbb`) for UI attribution. */
  color?: string;
  /** Name of the agent definition supplying this agent's persona. */
  agentType?: string;
  /** Model override; absent inherits the workspace default. */
  model?: string;
  /**
   * What this identity is told on top of its definition's prompt.
   *
   * An override rather than a replacement, because `agentType` is shared: two
   * agents built on the same definition differ by who they are here, not by
   * forking the definition. Appended to the persona at boot, so editing it
   * reaches the next turn rather than only the next spawn.
   *
   * It cannot widen anything. The read-only capability boundary is derived
   * from the definition and applied after this, so instructions change what an
   * agent is for and never what it may do.
   */
  instructions?: string;
  /**
   * How many runs may wait for this agent across all threads before further
   * mentions are refused. Absent means {@link DEFAULT_QUEUE_LIMIT}.
   *
   * Distinct from {@link maxConcurrentRuns}, which bounds how many threads
   * this agent works at once. This bounds how much may pile up behind those.
   * Refusing at the limit makes the agent's real throughput visible instead of
   * accruing a backlog nobody reaches.
   */
  queueLimit?: number;
  /**
   * Absent or `true` = can be addressed. `false` keeps the identity and its
   * history but stops it taking new work, matching how a disabled scheduled
   * task stays on disk.
   */
  enabled?: boolean;
  createdAt: number;
  /**
   * Set when a person deletes this agent. The entry stays so every post it
   * made keeps its author — those posts are evidence other agents reasoned
   * from — but it stops being addressable and reads `offline`.
   */
  retiredAt?: number;
  /**
   * The background agent carrying this identity's long-lived body, once it has
   * been started. Its transcript is this agent's memory across every thread.
   * Absent until the first dispatch.
   */
  /**
   * Where this identity's body runs.
   *
   * A discriminated union from the first version so a remote or cloud runtime
   * can be added without a migration, matching Multica's `runtime_mode`. Local
   * means one session process on this machine; `sessionId` is absent until it
   * has been started, and is the only handle anything needs to reach the body.
   */
  runtime?: { mode: 'local'; sessionId?: string };
  /**
   * How many threads this agent may work at once. Absent means 1.
   *
   * Multica's `max_concurrent_tasks`. Serial was a consequence of an agent
   * being a subagent that owned one chat inside a shared process; with a
   * process of its own it is a policy. Distinct from {@link queueLimit}, which
   * bounds how much may *wait* — throughput and backlog are different
   * questions.
   */
  maxConcurrentRuns?: number;
  /**
   * Runtime carrying this identity. V1 also keeps the local
   * `backgroundAgentId`; later runtime adapters bind through this generic id.
   */
  runtimeId?: string;
}

/**
 * Lifecycle of a unit of work.
 *
 * `blocked` is how an agent asks a person for something: it posts the question,
 * sets this, and ends its run rather than holding its body and budget open
 * while it waits. `done` is deliberately a human's call — an agent may push a
 * thread to `in_review`, never past it.
 */
/**
 * What a person sees beside an agent's name.
 *
 * Derived, never stored: the body's liveness is the runtime's fact, and a
 * stored copy would be wrong every time a process died without saying so.
 * `offline` is the honest reading of "no session", which is also what a
 * retired agent reports.
 */
export type WorkspaceAgentStatus =
  | 'offline'
  | 'idle'
  | 'working'
  | 'blocked'
  | 'error';

export type ThreadStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'in_review'
  | 'done';

/**
 * How urgently a thread wants a turn, highest first.
 *
 * These names are ours. Multica's issue carries a priority, but its value set
 * was not verified from source, so inventing a match would be a guess wearing
 * a citation. Four levels is what an ordering needs: one above normal for
 * "before the queue", one for "soon", the default, and one for "whenever".
 */
export type ThreadPriority = 'urgent' | 'high' | 'normal' | 'low';

/** Priorities in dispatch order. Index is the rank; lower goes first. */
export const THREAD_PRIORITY_ORDER: readonly ThreadPriority[] = [
  'urgent',
  'high',
  'normal',
  'low',
];

export const DEFAULT_THREAD_PRIORITY: ThreadPriority = 'normal';

/**
 * Dispatch rank of a thread's priority. An absent priority ranks as the
 * default, so a thread written before this field existed keeps its place
 * rather than sinking or jumping the queue.
 */
export function threadPriorityRank(priority?: ThreadPriority): number {
  const rank = THREAD_PRIORITY_ORDER.indexOf(
    priority ?? DEFAULT_THREAD_PRIORITY,
  );
  return rank === -1
    ? THREAD_PRIORITY_ORDER.indexOf(DEFAULT_THREAD_PRIORITY)
    : rank;
}

/**
 * One post on a thread. Append-only: an agent's turn is evidence, and
 * rewriting it would let a later run change what an earlier one is recorded
 * as having said.
 */
export interface ThreadMessage {
  id: string;
  sequence: number;
  authorKind: 'human' | 'agent' | 'system';
  /** {@link HUMAN_AUTHOR_ID} or the id of the agent that posted. */
  from: string;
  authorNameSnapshot: string;
  sourceRunId?: string;
  triggerKind?: string;
  text: string;
  /** Agent ids resolved from `@name` tokens at post time, in order. */
  mentions: string[];
  outcomes: MessageOutcome[];
  at: number;
  /** Idempotency key for a cross-thread outbox event. */
  originEventId?: string;
}

export type MessageOutcomeKind = 'dispatch' | 'coalesce' | 'skip';

export interface MessageOutcome {
  targetAgentId?: string;
  targetAgentName?: string;
  kind: MessageOutcomeKind;
  reason?: string;
  runId?: string;
  into?: 'queued' | 'running';
}

export type ThreadRunStatus =
  | 'queued'
  | 'running'
  | 'finishing'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunCloseKind = 'waiting' | 'blocked' | 'review' | 'unclosed';

export interface RunUsageRound {
  attempt: number;
  round: number;
  tokens: number;
}

/**
 * One agent turn against one thread.
 *
 * `sessionId` links this run to the background agent transcript. Because one
 * workspace agent works across threads, a run is a slice of that transcript rather
 * than the whole log; the dispatcher will record the slice boundaries.
 */
export interface ThreadRun {
  id: string;
  agentId: string;
  /** Bound background-agent session. Absent until the dispatcher starts it. */
  sessionId?: string;
  status: ThreadRunStatus;
  /**
   * Messages this run was told to answer. More than one when a further message
   * arrived while the run was queued, or while it was executing this same
   * thread — both coalesce rather than booking a second run.
   */
  triggerMessageIds: string[];
  acceptedMessageIds: string[];
  consumedMessageIds: string[];
  contextThroughSequence?: number;
  definitionVersion?: string;
  transcriptStartOffset?: number;
  transcriptEndOffset?: number;
  closeKind?: RunCloseKind;
  closeAcknowledgedAtSequence?: number;
  finalMessageId?: string;
  usageByRound: RunUsageRound[];
  /**
   * The agent body's cumulative token total when this run started.
   *
   * A body is long-lived and works many threads, so its total is not this
   * run's. Without the baseline the first settlement would charge one thread
   * tree for everything the agent has ever spent.
   */
  usageBaselineTokens?: number;
  failureStage?: string;
  /** Workspace-wide FIFO key. */
  queueSequence: number;
  /**
   * How many times this run has been started. A run revived after a stall or a
   * daemon restart is on attempt 2; a second failure is terminal.
   */
  attempts: number;
  /** Diagnostic wall clock only; never a FIFO key. */
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

/**
 * A unit of work several agents and people share.
 *
 * Stored one file per thread under the per-project runtime dir — not the
 * working tree. Thread text is written by agents and fed to other agents, so
 * it is a prompt-injection surface by construction; keeping it out of the
 * repo means it is never committed, pulled, or reviewed as if it were code.
 */
export interface Thread {
  schemaVersion: typeof AGENTS_SCHEMA_VERSION;
  id: string;
  title: string;
  body: string;
  /**
   * What "done" means for this thread, in the author's words.
   *
   * Separate from `body` because it is the one part an agent is checked
   * against: it goes into the turn envelope as the standard to meet, and a
   * review hand-back reports against it. A body says what to do; this says
   * when to stop.
   */
  acceptanceCriteria?: string;
  status: ThreadStatus;
  /**
   * Dispatch order within one agent's queue. Absent means the default.
   */
  priority?: ThreadPriority;
  /** Agent that owns the thread when no message names someone explicitly. */
  assigneeAgentId?: string;
  createdAt: number;
  /** {@link HUMAN_AUTHOR_ID} or an agent id. */
  createdBy: string;
  /** Set when an agent split this thread out of another one. */
  parentThreadId?: string;
  /**
   * Root of this thread tree. Equal to `id` for a root thread. Token spend is
   * charged there so splitting work cannot mint more money.
   */
  rootThreadId: string;
  messages: ThreadMessage[];
  runs: ThreadRun[];
  nextMessageSequence: number;
  deliveryByAgent: Record<string, AgentDelivery>;
  outbox: ThreadEvent[];
  /**
   * Agent-triggered deliveries on this thread since its last human post. A
   * delivery into a running agent counts too; otherwise two live agents could
   * ping-pong without booking another run. Local scope keeps a human reply on
   * one sub-thread from resetting an unrelated sibling loop.
   */
  autoTurnsUsed: number;
  /**
   * Derived cache of tokens spent by this thread's runs. Admission calculates
   * the tree total from every run instead of trusting this field. Unlike the
   * turn counter it is not reset by a human post.
   */
  tokensUsed: number;
}

export interface AgentDelivery {
  committedThroughSequence: number;
}

export type ThreadEventKind = 'parent_report' | 'notification';
export type ThreadEventStatus = 'pending' | 'acknowledged';

export interface ThreadEvent {
  id: string;
  kind: ThreadEventKind;
  causedByRunId?: string;
  payload: Record<string, unknown>;
  status: ThreadEventStatus;
  attempts: number;
  createdAt: number;
}

/** Default cap on runs waiting for one agent across all threads. */
export const DEFAULT_QUEUE_LIMIT = 5;

/**
 * Default cap on consecutive agent-triggered deliveries on one thread. Chosen to
 * allow a real hand-off chain (delegate → work → report → follow-up) while
 * still stopping a two-agent loop within a few turns.
 */
export const DEFAULT_THREAD_AUTO_TURN_BUDGET = 12;

/**
 * Default cap on tokens spent by one thread tree.
 *
 * There is deliberately no wall-clock gate beside these two. An earlier
 * revision had one, measured from first dispatch, which would have refused a
 * thread opened on Monday and revisited on Tuesday: elapsed time is not cost.
 * A run that hangs is the stall sweeper's problem, not the budget's.
 */
export const DEFAULT_THREAD_TOKEN_BUDGET = 1_000_000;

/** Bound on retained posts per thread. */
export const MAX_THREAD_MESSAGES = 500;

/** Bound on retained run records per thread. */
export const MAX_THREAD_RUNS = 200;
