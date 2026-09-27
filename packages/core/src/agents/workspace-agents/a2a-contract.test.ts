/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { externalRequestKey, toA2ATaskState } from './a2a-contract.js';
import type { ThreadStatus } from './types.js';

describe('A2A contract', () => {
  it('scopes opaque message ids without delimiter collisions', () => {
    const first = externalRequestKey({
      callerId: 'a:b',
      targetAgentId: 'c',
      messageId: 'd',
    });
    const second = externalRequestKey({
      callerId: 'a',
      targetAgentId: 'b:c',
      messageId: 'd',
    });

    expect(first).not.toBe(second);
  });

  it('refuses an unmapped local status', () => {
    expect(() => toA2ATaskState('future' as ThreadStatus)).toThrow(
      'Unmapped thread status: future',
    );
  });
});
