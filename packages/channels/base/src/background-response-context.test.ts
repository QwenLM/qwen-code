/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseBackgroundResponseContext } from './ChannelAgentBridge.js';

describe('parseBackgroundResponseContext', () => {
  // A context this parser rejects is delivered to the channel without one,
  // which costs the message its header and its turn grouping. Every kind a
  // session can produce has to be listed here as well as in the type.
  it.each(['agent', 'monitor', 'shell', 'workflow', 'peer'] as const)(
    'carries a %s context through',
    (kind) => {
      expect(
        parseBackgroundResponseContext({
          taskId: 'k1',
          status: 'completed',
          kind,
          label: 'a label',
        }),
      ).toEqual({
        taskId: 'k1',
        status: 'completed',
        kind,
        label: 'a label',
      });
    },
  );

  it('drops a kind it does not know', () => {
    expect(
      parseBackgroundResponseContext({
        taskId: 'k1',
        status: 'completed',
        kind: 'something-else',
      }),
    ).toBeUndefined();
  });
});
