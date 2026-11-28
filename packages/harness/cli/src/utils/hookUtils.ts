/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type HookRegistryEntry,
  getHookDisplayText,
} from '@qwen-code/core';

/**
 * Get a display name for a hook entry.
 * Delegates to the core getHookDisplayText utility.
 */
export function getHookDisplayName(entry: HookRegistryEntry): string {
  return getHookDisplayText(entry.config);
}

/**
 * Extract the `if` condition from a hook config (not all types have it).
 */
export function getHookIfCondition(
  config: HookRegistryEntry['config'],
): string | undefined {
  return 'if' in config && config.if ? config.if : undefined;
}
