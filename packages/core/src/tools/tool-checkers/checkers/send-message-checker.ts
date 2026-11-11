/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for sending a message to another agent.
 *
 * The baseline has no permission self-check for this tool, so this aligns
 * with it: absent a rule the call runs silently. Rules still apply, so a user
 * can deny or ask for it.
 */

import { alwaysAllowChecker, type HostToolChecker } from '../rule-precedence.js';

export function createSendMessageToolChecker(
  toolName: string,
): HostToolChecker {
  return alwaysAllowChecker(toolName, 'send_message_default.allow');
}
