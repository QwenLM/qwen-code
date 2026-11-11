/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { ENV_FEATURE_PREFIX } from './brand.js';

// ---------------------------------------------------------------------------
// Worktree — always enabled
// ---------------------------------------------------------------------------

/** Determine whether the worktree feature should be active. */
export function resolveWorktreeEnabled(): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// Generic feature gate — ENV_FEATURE_PREFIX + <NAME>
// ---------------------------------------------------------------------------

const FEATURE_DEFAULTS: Record<string, boolean> = {
  TASKS: true,
};

export const TASKS_FEATURE_NAME = 'TASKS';
export const TASKS_FEATURE_ENV = `${ENV_FEATURE_PREFIX}${TASKS_FEATURE_NAME}`;

/**
 * Checks whether a named feature flag is enabled via environment variable.
 * Reads `<BRAND_PREFIX>FEATURE_<NAME>`. Falls back to FEATURE_DEFAULTS when unset.
 * Set to `0` or `false` to explicitly disable a default-on feature.
 */
export function isFeatureOpen(name: string): boolean {
  const key = name.toUpperCase();
  const value = process.env[`${ENV_FEATURE_PREFIX}${key}`];
  if (value === undefined || value === '') {
    return FEATURE_DEFAULTS[key] ?? false;
  }
  return value === '1' || value === 'true';
}

export function resolveTasksEnabled(): boolean {
  return isFeatureOpen(TASKS_FEATURE_NAME);
}
