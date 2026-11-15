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
   * After the turn hands off its executor, before the batch reads `duplicates`.
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
 * The batch waits for the turn to hand off its scheduler with `runBatch`
 * before processing any calls, including replays. A turn that leaves
 * before handing it off must `close` the round to skip the batch.
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
  const consumer = options.useEventBus ? new AbortController() : undefined;
  const runSignal = consumer
    ? AbortSignal.any([signal, consumer.signal])
    : signal;
  let result: SharedModelRoundResult | undefined;
  let run: Promise<AgentLoopResult> | undefined;
  let runSettled = false;
  let supply!: (executor: AgentLoopToolExecutor | undefined) => void;
  const executor = new Promise<AgentLoopToolExecutor | undefined>(
    (resolve) => (supply = resolve),
  );
  const answered: Array<{
    request: ToolCallRequestInfo;
    response: ToolCallResponseInfo;
  }> = [];
  const abortConsumer = (error: SharedModelRoundClosed) => {
    if (run && !runSettled && !result) consumer?.abort(error);
  };
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
      signal: runSignal,
      toolSignal: signal,
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
            if (closed || consumer?.signal.aborted) {
              refuse(new SharedModelRoundClosed());
              return;
            }
            offered = { event, take, refuse };
            wake?.();
          }),
        onRoundEnd: async (_round, model) => {
          if (consumer?.signal.aborted) return 'surface_ended';
          result = {
            calls: [...model.calls],
            ...(model.stop ? { stop: model.stop } : {}),
          };
          done = true;
          wake?.();
          if (model.stop || model.calls.length === 0) return;
          if (!(await executor) || runSettled) return 'surface_ended';
          options.beforeBatch();
          return undefined;
        },
        onToolResult: ({ request, response, origin }) => {
          if (origin !== 'executed') answered.push({ request, response });
        },
      },
    });
    const settled = () => {
      runSettled = true;
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
        const error = new SharedModelRoundClosed();
        abortConsumer(error);
        (taking ?? offered)?.refuse(error);
        supply(undefined);
        await run.catch(() => {});
      }
    }
  }
  const stream = events();
  return {
    events: consumer
      ? {
          [Symbol.asyncIterator]: () => ({
            next: () => stream.next(),
            return: () => {
              // A generator's return waits behind any pending next call.
              abortConsumer(new SharedModelRoundClosed());
              return stream.return(undefined);
            },
          }),
        }
      : stream,
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
      if (consumer && run && !result) {
        abortConsumer(new SharedModelRoundClosed());
        await stream.return(undefined);
      }
      await run?.catch(() => {});
    },
  };
}
