/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueryEvent } from '../core/query-event.js';
import { createBusEvent, type QueryEventBus } from './bus.js';
import type { QueryBusEventMap, QueryBusEventType } from './events.js';
import type { QueryState } from './state.js';

export function publishFor<T extends QueryBusEventType>(
  bus: QueryEventBus,
  state: QueryState,
  type: T,
  data: QueryBusEventMap[T],
  roundId?: string,
): void {
  bus.publish(createBusEvent(type, state.input, data, roundId));
}

/** Delivery to the consumer; never awaited and never drives control flow. */
export function emitOutput(
  bus: QueryEventBus,
  state: QueryState,
  event: QueryEvent,
): void {
  publishFor(bus, state, 'query.output', { event });
}

// Captured at load so fake timers installed later cannot stall delivery.
const scheduleImmediate = globalThis.setImmediate.bind(globalThis);

/**
 * Lets microtask-driven consumers read what was just published before the
 * producer continues.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => scheduleImmediate(resolve));
}
