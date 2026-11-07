/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseBackgroundNotificationTurn } from './bridgeTypes.js';

describe('parseBackgroundNotificationTurn', () => {
  // The bridge sits between a session that emits background turns and a
  // client that renders them, and the two are updated apart. A kind this
  // parser does not know is dropped on the floor — the client never learns
  // the turn happened — so every kind a session can emit has to be listed
  // here as well as in the type.
  it.each(['agent', 'monitor', 'shell', 'workflow', 'peer'] as const)(
    'carries a %s turn through',
    (kind) => {
      expect(
        parseBackgroundNotificationTurn({
          turnId: 't1',
          taskId: 'k1',
          kind,
          startedAt: 1,
          label: 'a label',
        }),
      ).toEqual({
        turnId: 't1',
        taskId: 'k1',
        kind,
        startedAt: 1,
        label: 'a label',
      });
    },
  );

  it('drops a kind it does not know', () => {
    expect(
      parseBackgroundNotificationTurn({
        turnId: 't1',
        taskId: 'k1',
        kind: 'something-else',
        startedAt: 1,
      }),
    ).toBeUndefined();
  });
});
