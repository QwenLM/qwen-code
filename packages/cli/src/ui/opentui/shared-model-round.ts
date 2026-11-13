/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  LlmClient,
  ServerLlmStreamEvent,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';
import {
  runAgentLoop,
  type AgentLoopDuplicateState,
  type AgentLoopResult,
  type AgentLoopRound,
  type AgentLoopStopReason,
  type AgentLoopToolExecutor,
  type ToolBatchResult,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';

/** What a shared model round leaves for the turn once its events ran out. */
export interface SharedModelRoundResult {
  /** The calls to run: those of the attempt no retry or fallback replaced. */
  calls: ToolCallRequestInfo[];
  /** Set when the round must not run its calls, e.g. a detected loop. */
  stop?: AgentLoopStopReason;
}

export interface SharedRoundOptions {
  config: Config;
  /** The calls history and the turn already answered. */
  duplicates: AgentLoopDuplicateState;
  /** Run the round on the event-bus kernel. */
  useEventBus: boolean;
  /**
   * Right after the model round, when it has calls and did not stop, before
   * its batch reads `duplicates`.
   */
  beforeBatch(): void;
}

/** The live turn ended the round before its events ran out. */
class SharedModelRoundClosed extends Error {
  constructor() {
    super('The live turn closed the shared model round');
  }
}

/**
 * A round on the shared agent loop (`experimental.unifiedAgentLoop`), its
 * model request and its tool batch in one `runAgentLoop` call, on the
 * event-bus kernel under `experimental.eventBusAgentLoop`. The turn reads
 * the model round as an event stream: the loop sends the round, collects its
 * tool calls, drops those of an attempt a retry or fallback replaced, and
 * turns the client's terminal events into a stop reason.
 *
 * Each event waits until the turn took it, as the client's own stream does,
 * so the turn handles the round at the same pace as before. A turn that
 * stops reading ends the round, which closes the client's stream. `result`
 * is set once the events ran out.
 *
 * The batch starts right after the round, but runs no call until the turn
 * hands it the executor over its scheduler with `runBatch`; replays it
 * answers in place are in `answered`. A turn that leaves without running the
 * batch must `close` the round, which lets the batch run nothing.
 */
export function sharedModelRound(
  client: LlmClient,
  round: AgentLoopRound,
  signal: AbortSignal,
  options: SharedRoundOptions,
): {
  events: AsyncIterable<ServerLlmStreamEvent>;
  result: () => SharedModelRoundResult | undefined;
  answered: Array<{
    request: ToolCallRequestInfo;
    response: ToolCallResponseInfo;
  }>;
  runBatch: (executor: AgentLoopToolExecutor) => Promise<ToolBatchResult>;
  close: () => Promise<void>;
} {
  let result: SharedModelRoundResult | undefined;
  let run: Promise<AgentLoopResult> | undefined;
  let supply!: (executor: AgentLoopToolExecutor | undefined) => void;
  const executor = new Promise<AgentLoopToolExecutor | undefined>(
    (resolve) => (supply = resolve),
  );
  const answered: Array<{
    request: ToolCallRequestInfo;
    response: ToolCallResponseInfo;
  }> = [];
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
    run = runAgentLoop({
      client,
      config: options.config,
      signal,
      first: round,
      maxRounds: 1,
      duplicates: options.duplicates,
      // Esc keeps the results, which the turn pairs into history.
      keepCancelledResults: true,
      // The turn records the results only while it is current.
      deferRecording: true,
      useEventBus: options.useEventBus,
      executor: {
        run: async (requests, runSignal, hooks) =>
          (await executor)?.run(requests, runSignal, hooks) ?? [],
      },
      host: {
        onModelEvent: (event) =>
          new Promise<void>((take, refuse) => {
            if (closed) {
              refuse(new SharedModelRoundClosed());
              return;
            }
            offered = { event, take, refuse };
            wake?.();
          }),
        onRoundEnd: (_round, model) => {
          result = {
            calls: [...model.calls],
            ...(model.stop ? { stop: model.stop } : {}),
          };
          done = true;
          wake?.();
          if (!model.stop && model.calls.length > 0) options.beforeBatch();
        },
        onToolResult: ({ request, response, origin }) => {
          if (origin !== 'executed') answered.push({ request, response });
        },
      },
    });
    const settled = () => {
      done = true;
      wake?.();
    };
    void run.then(settled, (error: unknown) => {
      if (!result && !(error instanceof SharedModelRoundClosed))
        failure = { error };
      settled();
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
        // The round ended; its batch waits for the turn.
        if (result) return;
        // The run settled before the round ended.
        await run.catch(() => {});
        if (failure) throw failure.error;
        return;
      }
    } finally {
      if (!result) {
        closed = true;
        (taking ?? offered)?.refuse(new SharedModelRoundClosed());
        supply(undefined);
        await run.catch(() => {});
      }
    }
  }
  return {
    events: events(),
    result: () => result,
    answered,
    runBatch: (batchExecutor) => {
      supply(batchExecutor);
      return run!.then(({ reason, parts, responses }) => ({
        parts: parts ?? [],
        ...(responses ? { responses } : {}),
        ...(reason === 'next_round' || reason === 'completed'
          ? {}
          : { stop: reason }),
      }));
    },
    close: async () => {
      supply(undefined);
      await run?.catch(() => {});
    },
  };
}
