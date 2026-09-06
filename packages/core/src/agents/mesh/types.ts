/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Types for the agent mesh — durable agent identities that
 * collaborate on a shared thread.
 *
 * The distinction from Agent Team: a teammate is a live in-process loop that
 * receives messages at a tool-round boundary and dies with its leader. A mesh
 * agent is an identity whose work happens in a daemon session that is resumed
 * when the agent is addressed, so the conversation survives the process, is
 * visible to every participant, and can be replayed.
 */

/** Author id used for messages a person wrote. Never a valid agent id. */
export const HUMAN_AUTHOR_ID = 'user';

/**
 * A durable agent identity, scoped to one workspace.
 *
 * The persona (system prompt, tools, MCP servers, skills) is NOT duplicated
 * here: `agentType` names an existing agent definition and that definition
 * stays the single source of truth, so editing it changes every mesh agent
 * built on it. What lives here is identity and policy — who this agent is in
 * the workspace, and the limits it runs under.
 */
export interface MeshAgent {
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
   * How many runs this agent may have in flight at once, across all threads.
   * Absent means {@link DEFAULT_MAX_CONCURRENT_RUNS}. A mesh agent is a real
   * model consumer, so this is a spend control as much as a correctness one.
   */
  maxConcurrentRuns?: number;
  /**
   * Absent or `true` = can be addressed. `false` keeps the identity and its
   * history but stops it taking new work, matching how a disabled scheduled
   * task stays on disk.
   */
  enabled?: boolean;
  createdAt: number;
}

/** Lifecycle of a unit of work. `done` is deliberately a human's call. */
export type ThreadStatus = 'open' | 'in_progress' | 'in_review' | 'done';

/**
 * One post on a thread. Append-only: an agent's turn is evidence, and
 * rewriting it would let a later run change what an earlier one is recorded
 * as having said.
 */
export interface ThreadMessage {
  id: string;
  /** {@link HUMAN_AUTHOR_ID} or the id of the agent that posted. */
  from: string;
  text: string;
  /** Agent ids resolved from `@name` tokens at post time, in order. */
  mentions: string[];
  at: number;
}

export type ThreadRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * One agent turn against one thread.
 *
 * `sessionId` is the durable link to the work itself: that session's
 * transcript IS this run's log. This mirrors how a session-bound scheduled
 * task uses its session transcript as run history rather than inventing a
 * second log format.
 */
export interface ThreadRun {
  id: string;
  agentId: string;
  /** Bound daemon session. Absent until the dispatcher has one. */
  sessionId?: string;
  status: ThreadRunStatus;
  /**
   * Messages this run was told to answer. More than one when a message
   * arrived while the run was still queued and was coalesced into it.
   */
  triggerMessageIds: string[];
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
  id: string;
  title: string;
  body: string;
  status: ThreadStatus;
  /** Agent that owns the thread when no message names someone explicitly. */
  assigneeAgentId?: string;
  createdAt: number;
  /** {@link HUMAN_AUTHOR_ID} or an agent id. */
  createdBy: string;
  messages: ThreadMessage[];
  runs: ThreadRun[];
  /**
   * Runs triggered by an agent's own post, since the last human message.
   * The loop breaker: two agents that answer each other would otherwise
   * ping-pong until the account runs dry. A human post resets it, because a
   * person watching the thread is the signal that the loop is wanted.
   */
  autoTurnsUsed: number;
}

/** Default cap on an agent's simultaneous runs. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 1;

/**
 * Default cap on consecutive agent-triggered runs on one thread. Chosen to
 * allow a real hand-off chain (delegate → work → report → follow-up) while
 * still stopping a two-agent loop within a few turns.
 */
export const DEFAULT_THREAD_AUTO_TURN_BUDGET = 12;

/** Bound on retained posts per thread. */
export const MAX_THREAD_MESSAGES = 500;

/** Bound on retained run records per thread. */
export const MAX_THREAD_RUNS = 200;
