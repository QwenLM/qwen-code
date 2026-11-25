/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission checks for creating and cancelling scheduled prompts.
 *
 * The baseline has no permission self-check for either tool, so this aligns
 * with it: absent a rule the call runs silently. Rules still apply, so a user
 * can deny or ask for one. Listing the entries is session-local and lives
 * with the default checkers.
 */

import { alwaysAllowChecker, type HostToolChecker } from '../rule-precedence.js';

export function createCronCreateToolChecker(
  toolName: string,
): HostToolChecker {
  return alwaysAllowChecker(toolName, 'cron_create_default.allow');
}

export function createCronDeleteToolChecker(
  toolName: string,
): HostToolChecker {
  return alwaysAllowChecker(toolName, 'cron_delete_default.allow');
}
