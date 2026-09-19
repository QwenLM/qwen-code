/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseBackgroundResponseContext } from './ChannelAgentBridge.js';

describe('parseBackgroundResponseContext', () => {
  it('keeps a turn that handles a message from another session', () => {
    expect(
      parseBackgroundResponseContext({
        taskId: 'msg-1',
        status: 'completed',
        kind: 'peer',
        label: 'build bot',
        turnId: 'turn-1',
      }),
    ).toEqual({
      taskId: 'msg-1',
      status: 'completed',
      kind: 'peer',
      label: 'build bot',
      turnId: 'turn-1',
    });
  });

  it('still rejects a kind it does not know', () => {
    expect(
      parseBackgroundResponseContext({
        taskId: 'x',
        status: 'completed',
        kind: 'mail',
      }),
    ).toBeUndefined();
  });
});
