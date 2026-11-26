/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission checks for entering and leaving a git worktree.
 *
 * The baseline has no permission self-check for either tool, so this aligns
 * with it: absent a rule the call runs silently. Rules still apply, so a user
 * can deny or ask for one.
 */

import { alwaysAllowChecker, type HostToolChecker } from '../rule-precedence.js';

export function createEnterWorktreeToolChecker(
  toolName: string,
): HostToolChecker {
  return alwaysAllowChecker(toolName, 'enter_worktree_default.allow');
}

export function createExitWorktreeToolChecker(
  toolName: string,
): HostToolChecker {
  return alwaysAllowChecker(toolName, 'exit_worktree_default.allow');
}
