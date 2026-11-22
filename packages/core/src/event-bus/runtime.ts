/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LoopEventBus } from './bus.js';
import { ConversationHandler } from './conversation.js';
import { LlmHandler } from './llm.js';
import {
  createRunStateStore,
  type LoopRunState,
  type RunStateStore,
} from './state.js';
import { ToolHandler } from './tool.js';

/** One run's event bus, state store and the three handlers. */
export interface LoopEventRuntime {
  readonly bus: LoopEventBus;
  readonly store: RunStateStore<LoopRunState>;
  dispose(): void;
}

export function createLoopEventRuntime(): LoopEventRuntime {
  const bus = new LoopEventBus();
  const store = createRunStateStore<LoopRunState>();
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
