/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runModelRound, type AgentLoopRound } from '../core/agent-loop.js';
import type { LoopEventBus } from './bus.js';
import type { AnyBusEvent } from './events.js';
import { publishFor } from './handler-support.js';
import {
  currentRound,
  type LoopRunState,
  type RunStateStore,
} from './state.js';

/**
 * Runs one model round per `llm.request`, wrapping the unchanged
 * `runModelRound`. The host's `onModelEvent` fires inside that call, in stream
 * order, exactly as in the procedural loop. Writes only the round's model
 * slot, then reports `llm.settled`.
 */
export class LlmHandler {
  constructor(
    private readonly bus: LoopEventBus,
    private readonly store: RunStateStore<LoopRunState>,
  ) {}

  register(): () => void {
    return this.bus.subscribe('llm', ['llm.request'], (event) =>
      this.handle(event),
    );
  }

  private handle(event: AnyBusEvent): void {
    const state = this.store.get(event.runId);
    if (!state || event.type !== 'llm.request') return;
    const round = currentRound(state, event.round);
    if (round === undefined) return;
    void this.run(state, event.data.send, round).catch((error: unknown) => {
      this.bus.reportFailure('llm', event, error);
    });
  }

  private async run(
    state: LoopRunState,
    send: AgentLoopRound,
    round: number,
  ): Promise<void> {
    const { client, signal, host = {} } = state.input;
    const { turn, calls, stop } = await runModelRound(
      client,
      send,
      signal,
      host,
    );
    // A late round (the run already moved on or finished) writes nothing.
    if (this.store.get(state.runId) !== state || state.round !== round) return;
    state.model = { turn, calls, stop };
    publishFor(
      this.bus,
      state,
      'llm.settled',
      { round, calls, ...(stop ? { terminal: stop } : {}) },
      round,
    );
  }
}
