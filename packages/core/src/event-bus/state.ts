/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentLoopDuplicateState,
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopRound,
  AgentLoopStopReason,
  AgentLoopToolExecutor,
  ToolBatchResult,
} from '../core/agent-loop.js';
import type { ToolCallRequestInfo, Turn } from '../core/turn.js';

/**
 * Per-run state for the event-driven agent loop.
 *
 * Writer ownership (enforced by convention): Conversation owns the current
 * round and the continuation decision; Llm owns the round's collected calls
 * and outcome; Tool owns the batch's settled results. The store itself only
 * owns identity and lifetime.
 *
 * Ported from the v1.0.0-preview `QueryStateStore` (587e3429cabf).
 */
export interface RunState {
  readonly runId: string;
  readonly promptId: string;
  /** The round currently in flight, assigned by Conversation. */
  round?: number;
}

/** The agent loop's run state: identity plus the three ownership slots. */
export interface LoopRunState extends RunState {
  readonly input: AgentLoopOptions;
  readonly duplicates: AgentLoopDuplicateState;
  readonly executor: AgentLoopToolExecutor;
  /** Conversation-owned: the round to send next, and the final result. */
  current: AgentLoopRound;
  finished?: AgentLoopResult;
  /**
   * Conversation-owned: ends a cancelled run that has not settled. The
   * adapter clears it when the run settles, however it settles.
   */
  settleTimer?: ReturnType<typeof setTimeout>;
  /** Llm-owned: the settled model round. */
  model?: {
    turn?: Turn;
    calls: ToolCallRequestInfo[];
    stop?: AgentLoopStopReason;
  };
  /** Tool-owned: the settled tool batch. */
  batch?: ToolBatchResult;
}

export interface RunStateStore<T extends RunState = RunState> {
  create(state: T): T;
  get(runId: string): T | undefined;
  delete(runId: string): void;
}

export function createRunStateStore<
  T extends RunState = RunState,
>(): RunStateStore<T> {
  const states = new Map<string, T>();
  return {
    create(state) {
      if (states.has(state.runId)) {
        throw new Error(`Run ${state.runId} already exists.`);
      }
      states.set(state.runId, state);
      return state;
    },
    get: (runId) => states.get(runId),
    delete: (runId) => {
      states.delete(runId);
    },
  };
}

/**
 * The round an event belongs to, or undefined for a late event from an
 * abandoned round. Handlers use this to drop work that no longer applies.
 *
 * Round 0 is a legitimate round (the first one), so the result is falsy only
 * when it is undefined. Consumers must test `=== undefined`, not `!round`,
 * or they will drop the first round.
 */
export function currentRound(
  state: RunState | undefined,
  round: number | undefined,
): number | undefined {
  if (!state || round === undefined || state.round !== round) {
    return undefined;
  }
  return round;
}
