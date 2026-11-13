/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SendMessageType } from '../core/client.js';
import type { AgentLoopResult } from '../core/agent-loop.js';
import type { LoopEventBus } from './bus.js';
import type { AnyBusEvent } from './events.js';
import { publishFor } from './handler-support.js';
import {
  currentRound,
  type LoopRunState,
  type RunStateStore,
} from './state.js';

/** How long a cancelled run may take to settle before it ends anyway. */
export const CANCEL_SETTLEMENT_CAP_MS = 10_000;

/**
 * The loop's only decision maker and the only owner of the boundary
 * callbacks. It fires `onRoundStart`/`onRoundEnd` in its own serial delivery
 * chain before publishing the request that starts the next piece of work, so
 * the host observes the same callback order as the procedural loop. The
 * model-round and tool-batch work itself stays in the unchanged
 * `runModelRound`/`runToolBatch`.
 */
export class ConversationHandler {
  constructor(
    private readonly bus: LoopEventBus,
    private readonly store: RunStateStore<LoopRunState>,
  ) {}

  register(): () => void {
    return this.bus.subscribe(
      'conversation',
      ['loop.started', 'loop.cancelled', 'llm.settled', 'tool.settled'],
      (event) => this.handle(event),
    );
  }

  private async handle(event: AnyBusEvent): Promise<void> {
    const state = this.store.get(event.runId);
    if (!state || state.finished) return;
    const host = state.input.host ?? {};
    switch (event.type) {
      case 'loop.started': {
        state.round = 0;
        state.current = state.input.first;
        host.onRoundStart?.(0, state.current.promptId);
        publishFor(
          this.bus,
          state,
          'llm.request',
          { round: 0, send: state.current },
          0,
        );
        return;
      }
      case 'loop.cancelled': {
        // The handlers stop at the cancelled signal; a run they have not
        // settled within the cap ends here, and its late work is dropped.
        state.settleTimer ??= setTimeout(() => {
          this.finish(state, {
            reason: 'cancelled',
            rounds: (state.round ?? 0) + 1,
            ...(state.model?.turn ? { turn: state.model.turn } : {}),
          });
        }, CANCEL_SETTLEMENT_CAP_MS);
        state.settleTimer.unref?.();
        return;
      }
      case 'llm.settled': {
        const round = currentRound(state, event.round);
        const model = state.model;
        if (round === undefined || !model) return;
        const hostStop = await host.onRoundEnd?.(round, {
          calls: model.calls,
          ...(model.stop ? { stop: model.stop } : {}),
        });
        const stop = model.stop ?? hostStop;
        const rounds = round + 1;
        if (stop) {
          this.finish(state, { reason: stop, rounds, turn: model.turn });
          return;
        }
        if (model.calls.length === 0) {
          this.finish(state, { reason: 'completed', rounds, turn: model.turn });
          return;
        }
        publishFor(
          this.bus,
          state,
          'tool.request',
          { round, calls: model.calls },
          round,
        );
        return;
      }
      case 'tool.settled': {
        const round = currentRound(state, event.round);
        const batch = state.batch;
        if (round === undefined || !batch) return;
        const rounds = round + 1;
        const turn = state.model?.turn;
        const { parts, responses } = batch;
        if (batch.stop) {
          this.finish(state, {
            reason: batch.stop,
            rounds,
            turn,
            parts,
            responses,
          });
          return;
        }
        const { maxRounds } = state.input;
        if (maxRounds !== undefined && rounds >= maxRounds) {
          this.finish(state, {
            reason: 'next_round',
            rounds,
            turn,
            parts,
            responses,
          });
          return;
        }
        const next = host.nextRound?.(rounds, parts, responses) ?? {
          parts,
          promptId: state.current.promptId,
          options: { type: SendMessageType.ToolResult },
        };
        state.current = next;
        state.round = rounds;
        state.model = undefined;
        state.batch = undefined;
        host.onRoundStart?.(rounds, next.promptId);
        publishFor(
          this.bus,
          state,
          'llm.request',
          { round: rounds, send: next },
          rounds,
        );
        return;
      }
      default:
        return;
    }
  }

  private finish(state: LoopRunState, result: AgentLoopResult): void {
    if (state.finished) return;
    state.finished = result;
    publishFor(this.bus, state, 'loop.finished', { result });
  }
}
