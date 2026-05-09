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
