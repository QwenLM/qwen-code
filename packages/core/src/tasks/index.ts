/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Task registry barrel — the single thin store over the
 * polymorphic `TaskState` union plus per-kind modules (agent, shell,
 * monitor, dream). Re-exported from `@qwen-code/qwen-code-core` so SDK
 * consumers can import task types and helpers directly.
 */

export * from './types.js';
export * from './agent-task.js';
export * from './shell-task.js';
export * from './monitor-task.js';
export * from './dream-task.js';
export * from './registry.js';
export * from './dispatcher.js';

import { _resetAgentTaskModuleStateForTest } from './agent-task.js';
import { _resetMonitorTaskModuleStateForTest } from './monitor-task.js';
import { _resetShellTaskModuleStateForTest } from './shell-task.js';
import type { TaskRegistry } from './registry.js';

/**
 * Test-only: reset everything — `registry._resetForTest()` plus every
 * per-kind module's singletons. Use in `afterEach` of test files that
 * touch any module-level callback/Map (notification, register,
 * owner-routed, cap, etc.) to avoid cross-test leakage.
 */
export function _resetTaskKindModuleStateForTest(
  registry?: TaskRegistry,
): void {
  registry?._resetForTest();
  _resetAgentTaskModuleStateForTest();
  _resetMonitorTaskModuleStateForTest();
  _resetShellTaskModuleStateForTest();
}
