/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  LlmClient,
  ServerLlmStreamEvent,
  ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import {
  runModelRound,
  type AgentLoopRound,
  type AgentLoopStopReason,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';

/** What a shared model round leaves for the turn once its events ran out. */
export interface SharedModelRoundResult {
  /** The calls to run: those of the attempt no retry or fallback replaced. */
  calls: ToolCallRequestInfo[];
  /** Set when the round must not run its calls, e.g. a detected loop. */
  stop?: AgentLoopStopReason;
}

/** The live turn ended the round before its events ran out. */
class SharedModelRoundClosed extends Error {
  constructor() {
    super('The live turn closed the shared model round');
  }
}

/**
 * A model round on the shared agent loop (`experimental.unifiedAgentLoop`),
 * as the event stream the live turn reads: `runModelRound` sends the round,
 * collects its tool calls, drops those of an attempt a retry or fallback
 * replaced, and turns the client's terminal events into a stop reason.
 *
 * Each event waits until the turn took it, as the client's own stream does,
 * so the turn handles the round at the same pace as before. A turn that
 * stops reading ends the round, which closes the client's stream. `result`
 * is set once the events ran out.
 */
export function sharedModelRound(
  client: LlmClient,
  round: AgentLoopRound,
  signal: AbortSignal,
): {
  events: AsyncIterable<ServerLlmStreamEvent>;
  result: () => SharedModelRoundResult | undefined;
} {
  let result: SharedModelRoundResult | undefined;
  async function* events(): AsyncGenerator<ServerLlmStreamEvent> {
    interface Offer {
      event: ServerLlmStreamEvent;
      take: () => void;
      refuse: (error: Error) => void;
    }
    let offered: Offer | undefined;
    let wake: (() => void) | undefined;
    let closed = false;
    let done = false;
    let failure: { error: unknown } | undefined;
    const run = runModelRound(client, round, signal, {
      onModelEvent: (event) =>
        new Promise<void>((take, refuse) => {
          if (closed) {
            refuse(new SharedModelRoundClosed());
            return;
          }
          offered = { event, take, refuse };
          wake?.();
        }),
    }).then(
      ({ calls, stop }) => {
        result = { calls, ...(stop ? { stop } : {}) };
      },
      (error: unknown) => {
        if (!(error instanceof SharedModelRoundClosed)) failure = { error };
      },
    );
    void run.finally(() => {
      done = true;
      wake?.();
    });
    let taking: Offer | undefined;
    try {
      for (;;) {
        if (!offered && !done)
          await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        if (offered) {
          taking = offered;
          offered = undefined;
          yield taking.event;
          taking.take();
          taking = undefined;
          continue;
        }
        if (failure) throw failure.error;
        return;
      }
    } finally {
      if (!done) {
        closed = true;
        (taking ?? offered)?.refuse(new SharedModelRoundClosed());
        await run;
      }
    }
  }
  return { events: events(), result: () => result };
}
