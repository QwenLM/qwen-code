/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createBusEvent, type LoopEventBus } from './bus.js';
import type { LoopBusEventMap, LoopBusEventType } from './events.js';
import type { RunState } from './state.js';

/** Publish a round-scoped event attributed to a run. */
export function publishFor<T extends LoopBusEventType>(
  bus: LoopEventBus,
  state: RunState,
  type: T,
  data: LoopBusEventMap[T],
  round?: number,
): void {
  bus.publish(createBusEvent(type, state, data, round));
}
