/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Config,
  LlmClient,
  ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import {
  runAgentLoop,
  type AgentLoopHost,
  type AgentLoopResult,
  type AgentLoopRound,
  type AgentLoopStopReason,
  type AgentLoopToolExecutor,
  type ToolBatchResult,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';

export interface SharedLoopRoundOptions {
  config: Config;
  /** Cancels the round. */
  signal: AbortSignal;
  /** The signal the batch's tools run under, unless the batch brings one. */
  toolSignal?: AbortSignal;
  /** Leave each result for the turn to record when it sends it. */
  deferRecording: boolean;
  /** Run the round on the event-bus kernel. */
  useEventBus: boolean;
  onModelEvent: NonNullable<AgentLoopHost['onModelEvent']>;
}

/** What the turn hands the round's batch. */
export interface SharedLoopBatch {
  executor: AgentLoopToolExecutor;
  /** The provider calls history and the turn already answered. */
  handled: Map<string, string>;
  /** The provider ids already answered, which the batch adds to. */
  responded: Set<string>;
  /**
   * The signal the batch's tools run under, for a turn that makes one per
   * batch.
   */
  toolSignal?: AbortSignal;
  beforeToolLaunch?: AgentLoopHost['beforeToolLaunch'];
  onToolResult: NonNullable<AgentLoopHost['onToolResult']>;
}

export type SharedLoopRound = ReturnType<typeof startSharedLoopRound>;

/**
 * A round on the shared agent loop (`experimental.unifiedAgentLoop`), its
 * model request and its tool batch in one `runAgentLoop` call, on the
 * event-bus kernel under `experimental.eventBusAgentLoop`.
 *
 * `model` settles once the model round ended, with its calls and stop. The
 * batch waits for the turn to hand it its scheduler with `runBatch` before
 * it processes any call, replays included. A turn that leaves before then
 * must `close` the round, which skips the batch; the first of the two wins.
 * The batch's tools run in the async context of the `runBatch` call, not in
 * the one the round started in.
 */
export function startSharedLoopRound(
  client: LlmClient,
  round: AgentLoopRound,
  options: SharedLoopRoundOptions,
): {
  model: Promise<{
    calls: ToolCallRequestInfo[];
    stop?: AgentLoopStopReason;
  }>;
  runBatch: (batch: SharedLoopBatch) => Promise<ToolBatchResult>;
  close: () => Promise<void>;
} {
  let supply!: (batch: SharedLoopBatch | undefined) => void;
  const handedOff = new Promise<SharedLoopBatch | undefined>(
    (resolve) => (supply = resolve),
  );
  let taken: SharedLoopBatch | undefined;
  const duplicates = {
    handled: new Map<string, string>(),
    responded: new Set<string>(),
  };
  let endRound!: (model: {
    calls: ToolCallRequestInfo[];
    stop?: AgentLoopStopReason;
  }) => void;
  let failRound!: (error: unknown) => void;
  const model = new Promise<{
    calls: ToolCallRequestInfo[];
    stop?: AgentLoopStopReason;
  }>((resolve, reject) => {
    endRound = resolve;
    failRound = reject;
  });
  const run: Promise<AgentLoopResult> = runAgentLoop({
    client,
    config: options.config,
    signal: options.signal,
    toolSignal: options.toolSignal,
    first: round,
    maxRounds: 1,
    duplicates,
    // A cancelled batch keeps its results, which the turn pairs into history.
    keepCancelledResults: true,
    deferRecording: options.deferRecording,
    useEventBus: options.useEventBus,
    executor: {
      run: (requests, signal, hooks) =>
        taken?.executor.run(requests, taken.toolSignal ?? signal, hooks) ??
        Promise.resolve([]),
    },
    host: {
      onModelEvent: options.onModelEvent,
      onRoundEnd: async (_round, { calls, stop }) => {
        endRound({ calls: [...calls], ...(stop ? { stop } : {}) });
        if (stop || calls.length === 0) return undefined;
        taken = await handedOff;
        if (!taken) return 'surface_ended';
        duplicates.handled = taken.handled;
        duplicates.responded = taken.responded;
        return undefined;
      },
      beforeToolLaunch: (request, settled) =>
        taken?.beforeToolLaunch?.(request, settled) ?? true,
      onToolResult: (result) => taken?.onToolResult(result),
    },
  });
  // The kernel can cancel before onRoundEnd if the model stream stalls.
  void run.then(({ reason }) => {
    if (reason === 'cancelled') endRound({ calls: [], stop: reason });
  }, failRound);
  return {
    model,
    runBatch: (batch) => {
      const inTurn = AsyncLocalStorage.snapshot();
      supply({
        ...batch,
        executor: {
          run: (requests, signal, hooks) =>
            inTurn(() => batch.executor.run(requests, signal, hooks)),
        },
      });
      return run.then(({ reason, parts, responses }) => ({
        parts: parts ?? [],
        ...(responses ? { responses } : {}),
        ...(reason === 'next_round' || reason === 'completed'
          ? {}
          : { stop: reason }),
      }));
    },
    close: async () => {
      supply(undefined);
      await run.catch(() => {});
    },
  };
}
