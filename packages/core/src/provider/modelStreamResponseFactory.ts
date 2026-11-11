/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamEvent } from './event/modelStreamEvent.js';
import type { ModelCompleteEvent } from './event/modelCompleteEvent.js';
import type { ModelMessage } from './event/modelCompleteEvent.js';
import type { ModelPartialMessage } from './aggregate/modelPartialMessage.js';
import type { ModelStreamResponse } from './modelStreamResponse.js';
import { DefaultModelStreamAggregator } from './aggregate/defaultModelStreamAggregator.js';
import {
  classifyClientError,
  ModelInferenceError,
  type ModelInferenceErrorClassifier,
} from './modelInferenceError.js';

type Pending<T> = { value: T; done?: boolean };

type StreamItem = ModelStreamEvent | ModelCompleteEvent;

/**
 * Turns one raw primitive stream into the dual-channel
 * `{ events, completed, partial, cancel }` response.
 *
 * Every source event is forwarded to the `events` leg,
 * with aggregate completion events (produced by the aggregator) inserted
 * just before their triggering primitive — `content_block_complete` before
 * the matching `content_block_stop`, `message_complete` before
 * `message_stop`. Pumping starts at construction, so a caller that only
 * awaits `completed` still drives the stream to completion. Stream failures
 * propagate to both legs (events iteration throws; `completed` rejects).
 * A repairable tool stop and all following events wait for a terminal, then
 * replay in source order. Confirmed closing suffixes are appended to argument
 * deltas before the matching completion and stop.
 *
 * The `events` leg is single-consumer: iterating it more than once (or from
 * two places) interleaves items arbitrarily. `cancel()` is idempotent,
 * unblocks both legs immediately, and closes the source; the driver stops
 * consuming once terminated, so events produced by a misbehaving source
 * after cancellation are dropped instead of accumulating.
 *
 * It is also the single exit of the inference error contract: a source
 * failure is mapped by the provider's `classify` into a ModelInferenceError
 * (the original error kept as `cause`) before reaching either leg. Aborts and
 * errors already in contract form pass through unchanged.
 */
export function createModelStreamResponse(
  source: AsyncIterable<ModelStreamEvent>,
  cancel?: (reason?: unknown) => void | Promise<void>,
  classify: ModelInferenceErrorClassifier = classifyClientError,
): ModelStreamResponse {
  // Single-consumer event queue (unbounded buffer).
  const queue: Array<Pending<StreamItem>> = [];
  let queueWaiter: ((r: IteratorResult<StreamItem>) => void) | null = null;
  let finished = false;
  /** Whether any source event reached the queue; decides the error phase. */
  let exposed = false;

  const aggregator = new DefaultModelStreamAggregator();
  const deferredToolStops = new Map<
    number,
    {
      suffix: string;
      completion?: Extract<
        ModelCompleteEvent,
        { type: 'content_block_complete' }
      >;
    }
  >();
  const deferredEvents: StreamItem[] = [];

  let resolveCompleted!: (result: ModelMessage) => void;
  let rejectCompleted!: (reason?: unknown) => void;
  const completed = new Promise<ModelMessage>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  let resolvePartial!: (result: ModelPartialMessage) => void;
  const partial = new Promise<ModelPartialMessage>((resolve) => {
    resolvePartial = resolve;
  });

  function pushToQueue(item: StreamItem): void {
    if (queueWaiter) {
      const waiter = queueWaiter;
      queueWaiter = null;
      waiter({ value: item, done: false });
    } else {
      queue.push({ value: item });
    }
  }

  function emit(item: StreamItem): void {
    if (deferredToolStops.size > 0) {
      deferredEvents.push(item);
    } else {
      pushToQueue(item);
      exposed = true;
    }
  }

  function flushDeferredEvents(): void {
    if (
      deferredToolStops.size === 0 ||
      [...deferredToolStops.values()].some(({ completion }) => !completion)
    ) {
      return;
    }
    for (const item of deferredEvents) {
      const deferred =
        item.type === 'content_block_stop'
          ? deferredToolStops.get(item.index)
          : undefined;
      const completion = deferred?.completion;
      if (deferred && completion) {
        if (
          completion.block.type === 'tool_use' &&
          completion.block.inputJson === undefined
        ) {
          pushToQueue({
            type: 'content_block_delta',
            index: completion.index,
            delta: {
              type: 'input_json_delta',
              partial_json: deferred.suffix,
            },
          });
        }
        pushToQueue(completion);
        deferredToolStops.delete(completion.index);
      }
      pushToQueue(item);
    }
    deferredEvents.length = 0;
  }

  function closeEvents(): void {
    if (finished) return;
    finished = true;
    resolvePartial(aggregator.getPartialResult());
    deferredEvents.length = 0;
    deferredToolStops.clear();
    if (queueWaiter) {
      const waiter = queueWaiter;
      queueWaiter = null;
      waiter({ value: undefined, done: true });
    } else {
      queue.push({ value: undefined as never, done: true });
    }
  }

  function fail(error: unknown): void {
    if (finished) return;
    // 错误标记仍排在已接收事件之后，但聚合状态立即停止变化。
    finished = true;
    resolvePartial(aggregator.getPartialResult());
    deferredEvents.length = 0;
    deferredToolStops.clear();
    const rejected = Promise.reject<IteratorResult<StreamItem>>(error);
    rejected.catch(() => undefined); // avoid unhandled rejection on the direct path
    if (queueWaiter) {
      const waiter = queueWaiter;
      queueWaiter = null;
      waiter(rejected as unknown as IteratorResult<StreamItem>);
    } else {
      queue.push({ value: rejected as unknown as StreamItem });
    }
    rejectCompleted(error);
  }

  /** An event the aggregator rejects means the source broke the sequence. */
  function aggregate(event: ModelStreamEvent): ModelCompleteEvent[] {
    try {
      return aggregator.process(event);
    } catch (error) {
      throw toProtocolError(error);
    }
  }

  function toProtocolError(error: unknown): ModelInferenceError {
    return new ModelInferenceError(
      error instanceof Error ? error.message : String(error),
      {
        kind: 'protocol',
        phase: exposed ? 'after_output' : 'before_output',
        cause: error,
      },
    );
  }

  function toContractError(error: unknown): unknown {
    // Callers detect cancellation by `name === 'AbortError'`; keep it as is.
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      error instanceof ModelInferenceError
    ) {
      return error;
    }
    const detail = classify(error);
    return new ModelInferenceError(
      detail.message ??
        (error instanceof Error ? error.message : String(error)),
      {
        ...detail,
        phase: exposed ? 'after_output' : 'before_output',
        cause: error,
      },
    );
  }

  async function drive(): Promise<void> {
    try {
      for await (const event of source) {
        if (finished) break; // terminated: for-await break closes the source
        // Completion events go out before the primitive that triggered them,
        // mirroring the legacy assistant_block-before-stop timing.
        const completions = aggregate(event);
        for (const completion of completions) {
          const deferred =
            completion.type === 'content_block_complete'
              ? deferredToolStops.get(completion.index)
              : undefined;
          if (deferred && completion.type === 'content_block_complete') {
            deferred.completion = completion;
          } else {
            emit(completion);
          }
        }
        if (event.type === 'content_block_stop' && completions.length === 0) {
          const suffix = aggregator.getPendingToolInputSuffix(event.index);
          if (suffix !== undefined) {
            // 从当前 stop 起保留所有事件，避免后续工具或块回调越过待修复块。
            deferredToolStops.set(event.index, { suffix });
          }
        }
        emit(event);
        flushDeferredEvents();
      }
      if (finished) return; // rejected/failed already; nothing to settle
      let result: ModelMessage;
      try {
        result = aggregator.getResult();
      } catch (error) {
        throw toProtocolError(error);
      }
      closeEvents();
      resolveCompleted(result);
    } catch (error) {
      fail(toContractError(error));
    }
  }

  function terminate(reason: unknown): void | Promise<void> {
    if (finished) return undefined; // idempotent: already closed, do not re-cancel
    closeEvents();
    rejectCompleted(reason);
    // for-await break/return semantics still close the source generator.
    return cancel?.(reason);
  }

  const events: AsyncIterable<StreamItem> = {
    [Symbol.asyncIterator](): AsyncIterator<StreamItem> {
      return {
        next(): Promise<IteratorResult<StreamItem>> {
          if (queue.length > 0) {
            const item = queue.shift()!;
            if (item.done) {
              return Promise.resolve({ value: undefined, done: true });
            }
            // A queued rejected promise adopts its rejection here.
            return Promise.resolve(item.value).then((v) => ({
              value: v,
              done: false,
            }));
          }
          if (finished) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            queueWaiter = resolve;
          });
        },
      };
    },
  };

  // Pump from construction: the factory owns the stream lifecycle, so a
  // caller that only awaits `completed` (never touches `events`) still
  // drives the source to completion. `cancel()` / closeEvents() make the
  // late arrival of an events consumer harmless.
  void drive();

  return {
    events,
    completed,
    partial,
    cancel: terminate,
  };
}
