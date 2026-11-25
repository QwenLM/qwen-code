/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Export types
export * from './types.js';

// Export core components
export { HookSystem } from './hookSystem.js';
export { HookRegistry } from './hookRegistry.js';
export { HookRunner } from './hookRunner.js';
export { HookAggregator } from './hookAggregator.js';
export { HookPlanner } from './hookPlanner.js';
export { HookEventHandler } from './hookEventHandler.js';
export {
  composeRewakeNotification,
  extractDynamicRewakeSummary,
  flushPendingAsyncRewakeHooks,
  ASYNC_REWAKE_FLUSH_TIMEOUT_MS,
} from './hookEventHandler.js';
export {
  hookOutputSchema,
  normalizeHookOutput,
  validateHookOutput,
} from './hookOutputSchema.js';

// Export interfaces and enums
export type { HookRegistryEntry } from './hookRegistry.js';
export { ConfigSource } from './types.js';
export type { AggregatedHookResult } from './hookAggregator.js';
export type { ValidatedHookOutput } from './hookOutputSchema.js';
export { hasBlockingResult } from './hookAggregator.js';
export type { HookEventContext } from './hookPlanner.js';

// Export hook coordinator implementations
export {
  NoopHookCoordinator,
  DefaultHookCoordinator,
  SubagentHookCoordinator,
} from './coordinators.js';

// Export session hooks utilities
export {
  registerFrontmatterHooks,
  clearFrontmatterHooks,
} from './sessionHooks.js';

// Export structured hook events emitter
export {
  hookEvents,
  HookEventEmitter,
  setAllHookEventsEnabled,
  type HookStartedEvent,
  type HookProgressEvent,
  type HookResponseEvent,
} from './hookEvents.js';

export { createHookConfigurationRef } from './hookConfigurationRef.js';
