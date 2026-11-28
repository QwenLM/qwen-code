/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueryEventBus } from './bus.js';
import type { AnyBusEvent } from './events.js';
import type { AnyHandleResult } from './results.js';
import type { QueryStateStore } from './state.js';

/** Registers its subscriptions and returns the matching unsubscribe. */
export interface EventHandler {
  register(): () => void;
  handle(event: AnyBusEvent): AnyHandleResult | Promise<AnyHandleResult>;
}

export type EventHandlerFactory = (
  bus: QueryEventBus,
  store: QueryStateStore,
) => EventHandler;
