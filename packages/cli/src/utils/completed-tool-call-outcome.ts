/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CompletedToolCallOutcome,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';

export function toCompletedToolCallOutcome(
  callId: string,
  status: CompletedToolCallOutcome['status'],
  response: ToolCallResponseInfo | undefined,
): CompletedToolCallOutcome {
  return {
    callId,
    status,
    executionStatus: response?.executionStatus,
    errorType: response?.errorType,
    responseParts: response?.responseParts,
  };
}
