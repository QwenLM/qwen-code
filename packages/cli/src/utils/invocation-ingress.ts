/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SendMessageType } from '@qwen-code/qwen-code-core';

export function getAsyncInvocationIngress(
  type: SendMessageType | undefined,
): 'scheduler' | 'internal' | undefined {
  switch (type) {
    case SendMessageType.Cron:
      return 'scheduler';
    case SendMessageType.Notification:
    case SendMessageType.Teammate:
      return 'internal';
    case SendMessageType.UserQuery:
    case SendMessageType.ToolResult:
    case SendMessageType.Retry:
    case SendMessageType.Hook:
    case undefined:
      return undefined;
    default: {
      const exhaustiveType: never = type;
      return exhaustiveType;
    }
  }
}
