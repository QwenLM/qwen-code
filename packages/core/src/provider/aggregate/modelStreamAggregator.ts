/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamEvent } from '../event/modelStreamEvent.js';
import type { ModelPartialMessage } from './modelPartialMessage.js';
import type {
  ModelCompleteEvent,
  ModelMessage,
} from '../event/modelCompleteEvent.js';

/**
 * Single-owner aggregator for one model stream.
 *
 * Pull-based and synchronous: the driver feeds every raw `ModelStreamEvent`
 * into `process()` and drains the aggregate completion events produced by
 * that call; `getResult()` yields the fully assembled `ModelMessage` once
 * the stream has ended. It never wraps or replaces raw events — completion
 * events are supplements the driver chooses to forward.
 *
 * One aggregator instance per stream; not reusable across streams.
 */
export interface ModelStreamAggregator {
  /**
   * Feed one raw stream event.
   *
   * Returns the completion events produced by this call, in emission order:
   * - a `content_block_complete` when the event closes a content block
   *   (emitted before the matching `content_block_stop`);
   * - a `message_complete` when the event is `message_stop`.
   */
  process(event: ModelStreamEvent): ModelCompleteEvent[];

  /**
   * The fully assembled message. Meaningful only after `message_stop` has
   * been processed; the returned instance is the same object that the
   * `message_complete` event and the `completed` promise carry.
   */
  getResult(): ModelMessage;

  /** 流终止后的完整块与残缺块副本，不提前缓存整轮完成结果。 */
  getPartialResult(): ModelPartialMessage;
}
