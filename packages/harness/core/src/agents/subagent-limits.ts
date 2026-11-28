/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ENV_MAX_CONCURRENT_SUBAGENTS,
  ENV_MAX_SUBAGENT_SPAWN_DEPTH,
  positiveIntegerFromEnv,
} from '../config/brand.js';

export const DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 1;
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20;

export function getMaxSubagentSpawnDepth(): number {
  return positiveIntegerFromEnv(
    ENV_MAX_SUBAGENT_SPAWN_DEPTH,
    DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH,
  );
}

/**
 * Whether an agent already nested `depth` levels deep may spawn one more.
 * Single home for the comparison: the Agent tool refuses the call at this
 * boundary, and registry setup hides the tool from children that are past it.
 */
export function canSpawnSubagentAtDepth(depth: number): boolean {
  return depth < getMaxSubagentSpawnDepth();
}

export function getMaxConcurrentSubagents(): number {
  return positiveIntegerFromEnv(
    ENV_MAX_CONCURRENT_SUBAGENTS,
    DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  );
}
