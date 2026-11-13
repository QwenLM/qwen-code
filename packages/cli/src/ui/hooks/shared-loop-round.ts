/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
  /** The signal the batch's tools run under. */
  toolSignal: AbortSignal;
  /** The provider ids already answered, which the batch adds to. */
  responded: Set<string>;
  /** Run the round on the event-bus kernel. */
  useEventBus: boolean;
  onModelEvent: NonNullable<AgentLoopHost['onModelEvent']>;
}

/** What the turn hands the round's batch. */
export interface SharedLoopBatch {
  executor: AgentLoopToolExecutor;
  /** The provider calls history and the turn already answered. */
  handled: Map<string, string>;
  onToolResult: NonNullable<AgentLoopHost['onToolResult']>;
}

/**
 * A round on the shared agent loop (`experimental.unifiedAgentLoop`), its
 * model request and its tool batch in one `runAgentLoop` call, on the
 * event-bus kernel under `experimental.eventBusAgentLoop`.
 *
 * `model` settles once the model round ended, with its calls and stop. The
 * batch waits for the turn to hand it its scheduler with `runBatch` before
 * it processes any call, replays included. A turn that leaves before then
 * must `close` the round, which skips the batch; the first of the two wins.
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
    responded: options.responded,
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
    // Esc keeps the results, which the TUI pairs into history.
    keepCancelledResults: true,
    // The TUI records only the results it sends, in its own session.
    deferRecording: true,
    useEventBus: options.useEventBus,
    executor: {
      run: (requests, signal, hooks) =>
        taken?.executor.run(requests, signal, hooks) ?? Promise.resolve([]),
    },
    host: {
      onModelEvent: options.onModelEvent,
      onRoundEnd: async (_round, { calls, stop }) => {
        endRound({ calls: [...calls], ...(stop ? { stop } : {}) });
        if (stop || calls.length === 0) return undefined;
        taken = await handedOff;
        if (!taken) return 'surface_ended';
        duplicates.handled = taken.handled;
        return undefined;
      },
      onToolResult: (result) => taken?.onToolResult(result),
    },
  });
  // A failure before the round ended is the round's; one after it reaches
  // the batch's caller.
  void run.catch(failRound);
  return {
    model,
    runBatch: (batch) => {
      supply(batch);
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
