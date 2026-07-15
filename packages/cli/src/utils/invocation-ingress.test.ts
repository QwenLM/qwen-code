/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SendMessageType } from '@qwen-code/qwen-code-core';
import { getAsyncInvocationIngress } from './invocation-ingress.js';

describe('getAsyncInvocationIngress', () => {
  it.each([
    [SendMessageType.Cron, 'scheduler'],
    [SendMessageType.Notification, 'internal'],
    [SendMessageType.Teammate, 'internal'],
    [SendMessageType.UserQuery, undefined],
    [SendMessageType.ToolResult, undefined],
    [SendMessageType.Retry, undefined],
    [SendMessageType.Hook, undefined],
    [undefined, undefined],
  ] as const)('maps %s to %s', (type, expected) => {
    expect(getAsyncInvocationIngress(type)).toBe(expected);
  });
});
