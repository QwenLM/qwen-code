/**
 * @license
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

// Export new hook runners
export { HttpHookRunner } from './httpHookRunner.js';
export { FunctionHookRunner } from './functionHookRunner.js';

// Export session and async hook management
export { SessionHooksManager } from './sessionHooksManager.js';
export type { SessionHookEntry } from './sessionHooksManager.js';
export { AsyncHookRegistry, generateHookId } from './asyncHookRegistry.js';

// Export utilities
export {
  interpolateEnvVars,
  interpolateHeaders,
  interpolateUrl,
  hasEnvVarReferences,
  extractEnvVarNames,
} from './envInterpolator.js';
export { UrlValidator, createUrlValidator } from './urlValidator.js';

// Export interfaces and enums
export type { HookRegistryEntry } from './hookRegistry.js';
export { HooksConfigSource as ConfigSource } from './types.js';
export type { AggregatedHookResult } from './hookAggregator.js';
export type { HookEventContext } from './hookPlanner.js';
