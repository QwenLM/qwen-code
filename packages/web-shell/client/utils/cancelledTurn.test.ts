/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { cancelledTurnProducedNothing } from './cancelledTurn';

function block(kind: DaemonTranscriptBlock['kind']): DaemonTranscriptBlock {
  return { id: kind, kind } as DaemonTranscriptBlock;
}

describe('cancelledTurnProducedNothing', () => {
  it('holds when the prompt is the last block', () => {
    expect(cancelledTurnProducedNothing([])).toBe(true);
  });

  it('holds when only thoughts and notices followed the prompt', () => {
    expect(
      cancelledTurnProducedNothing([
        block('thought'),
        block('status'),
        block('error'),
        block('debug'),
        block('prompt_cancelled'),
      ]),
    ).toBe(true);
  });

  it.each(['assistant', 'tool', 'shell', 'user_shell', 'permission', 'user'])(
    'fails once a %s block followed the prompt',
    (kind) => {
      expect(
        cancelledTurnProducedNothing([
          block('thought'),
          block(kind as DaemonTranscriptBlock['kind']),
          block('prompt_cancelled'),
        ]),
      ).toBe(false);
    },
  );
});
