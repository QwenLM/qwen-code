/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamEvent } from './event/modelStreamEvent.js';
import type {
  ModelCompleteEvent,
  ModelMessage,
} from './event/modelCompleteEvent.js';

import type { ModelPartialMessage } from './aggregate/modelPartialMessage.js';

/**
 * Dual-channel model stream response.
 *
 * - `events`: protocol-neutral block-lifecycle events for incremental
 *   rendering (UI/TUI/SDK consume token and block boundaries in real time).
 * - `completed`: the aggregated outcome, resolved once the stream ends.
 *   Callers that only need the final content `await` this and never touch
 *   the event leg; the underlying stream is still pumped to completion.
 * - `cancel`: best-effort abort of the underlying transport.
 *
 * Both legs share one drive loop: consuming either one feeds the other, and
 * a stream failure surfaces in both (iteration throws; `completed` rejects).
 * The failure is always a ModelInferenceError, or an AbortError when the
 * request was cancelled.
 */
export interface ModelStreamResponse {
  readonly events: AsyncIterable<ModelStreamEvent | ModelCompleteEvent>;
  readonly completed: Promise<ModelMessage>;
  readonly partial: Promise<ModelPartialMessage>;
  cancel?(reason?: unknown): void | Promise<void>;
}
