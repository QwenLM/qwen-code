/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Agent } from '@agentclientprotocol/sdk';

describe('mock ACP agent type compliance', () => {
  it('satisfies required Agent interface methods', () => {
    const _typeCheck: Pick<
      Agent,
      'initialize' | 'authenticate' | 'newSession' | 'prompt' | 'cancel'
    > = {
      initialize: async () => ({
        protocolVersion: '',
        agentInfo: { name: '', version: '' },
        authMethods: [],
        agentCapabilities: {},
      }),
      authenticate: async () => ({}),
      newSession: async () => ({ sessionId: '' }),
      prompt: async () => ({ stopReason: 'end_turn' as const }),
      cancel: async () => {},
    };
    expect(_typeCheck).toBeDefined();
  });
});
