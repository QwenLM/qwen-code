/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-run state for the event-driven agent loop.
 *
 * Writer ownership (enforced by convention, established by the handlers in the
 * next slice): Conversation owns the current round and the continuation
 * decision; Llm owns the round's collected/discarded calls and outcome; Tool
 * owns the batch's working state and settled results. The store itself only
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

export interface RunStateStore {
  create(state: RunState): RunState;
  get(runId: string): RunState | undefined;
  delete(runId: string): void;
}

export function createRunStateStore(): RunStateStore {
  const states = new Map<string, RunState>();
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
