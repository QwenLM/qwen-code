/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { ToolPermissionDenial } from '../../core/tool-result.js';
import type { SystemMessage } from '../../protocol/transcript/message.js';

export function createPermissionDeniedSystemMessage(
  denial: ToolPermissionDenial,
  sessionId: string,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    content: denial.message,
    level: 'error',
    tool_name: denial.tool_name,
    tool_use_id: denial.tool_use_id,
    tool_input: denial.tool_input,
    message: denial.message,
    decision_reason_type: denial.decision_reason_type,
    decision_reason: denial.decision_reason,
    ...(denial.tool_denial_kind
      ? { tool_denial_kind: denial.tool_denial_kind }
      : {}),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId,
  };
}
