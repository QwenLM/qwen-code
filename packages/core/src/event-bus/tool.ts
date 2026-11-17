/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { batchOptions, runToolBatch } from '../core/agent-loop.js';
import type { ToolCallRequestInfo } from '../core/turn.js';
import type { LoopEventBus } from './bus.js';
import type { AnyBusEvent } from './events.js';
import { publishFor } from './handler-support.js';
import {
  currentRound,
  type LoopRunState,
  type RunStateStore,
} from './state.js';

/**
 * Runs one tool batch per `tool.request`, wrapping the unchanged
 * `runToolBatch`. The host's `onToolResult` and the selection/launch/output
 * callbacks fire inside that call, exactly as in the procedural loop. Writes
 * only the batch slot, then reports `tool.settled`. Conversation publishes
 * `tool.request` only after it has fired `onRoundEnd`, so the boundary
 * callback order matches the procedural loop.
 */
export class ToolHandler {
  constructor(
    private readonly bus: LoopEventBus,
    private readonly store: RunStateStore<LoopRunState>,
  ) {}

  register(): () => void {
    return this.bus.subscribe('tool', ['tool.request'], (event) =>
      this.handle(event),
    );
  }

  private handle(event: AnyBusEvent): void {
    const state = this.store.get(event.runId);
    if (!state || event.type !== 'tool.request') return;
    const round = currentRound(state, event.round);
    if (round === undefined) return;
    void this.run(state, event.data.calls, round).catch((error: unknown) => {
      this.bus.reportFailure('tool', event, error);
    });
  }

  private async run(
    state: LoopRunState,
    calls: ToolCallRequestInfo[],
    round: number,
  ): Promise<void> {
    const isFinished = () =>
      state.finished !== undefined || this.store.get(state.runId) !== state;
    const batch = await runToolBatch(calls, {
      ...batchOptions(state.input, state.duplicates, state.executor),
      isFinished,
    });
    if (isFinished() || state.round !== round) return;
    state.batch = batch;
    publishFor(this.bus, state, 'tool.settled', { round }, round);
  }
}
