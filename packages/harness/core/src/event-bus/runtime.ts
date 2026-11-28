/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryEventBus } from './bus.js';
import { ConversationHandler } from './conversation/conversation-handler.js';
import { LlmHandler } from './llm/llm-handler.js';
import { createQueryStateStore, type QueryStateStore } from './state.js';
import { ToolHandler } from './tool/tool-handler.js';

/** One event bus, query state store and the three handlers; shareable across sessions. */
export interface QueryEventRuntime {
  readonly bus: QueryEventBus;
  readonly store: QueryStateStore;
  dispose(): void;
}

export function createQueryEventBus(): QueryEventRuntime {
  const bus = new QueryEventBus();
  const store = createQueryStateStore();
  const unsubscribe = [
    new ConversationHandler(bus, store).register(),
    new LlmHandler(bus, store).register(),
    new ToolHandler(bus, store).register(),
  ];
  return {
    bus,
    store,
    dispose: () => {
      for (const off of unsubscribe) off();
    },
  };
}
