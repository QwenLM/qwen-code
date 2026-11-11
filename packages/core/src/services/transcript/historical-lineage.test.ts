/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '../../protocol/transcript/entry.js';
import { selectHistoricalLineage } from './historical-lineage.js';

function message(
  uuid: string,
  type: 'user' | 'assistant',
  parentUuid: string | null,
): TranscriptMessage {
  const common = {
    uuid,
    parentUuid,
    sessionId: 'session-id',
    timestamp: '2026-08-23T00:00:00.000Z',
    cwd: '/project',
    version: 'test',
    gitBranch: 'main',
    userType: 'external',
    isSidechain: false,
  };
  return type === 'user'
    ? {
        ...common,
        type,
        message: { role: 'user', content: uuid },
      }
    : {
        ...common,
        type,
        requestId: `request-${uuid}`,
        message: {
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          id: `provider-${uuid}`,

          model: 'test-model',
          stop_reason: 'end_turn',

          content: [],
        },
      };
}

describe('selectHistoricalLineage', () => {
  const firstUser = message('first-user', 'user', null);
  const firstAssistant = message(
    'first-assistant',
    'assistant',
    firstUser.uuid,
  );
  const secondUser = message('second-user', 'user', firstAssistant.uuid);
  const secondAssistant = message(
    'second-assistant',
    'assistant',
    secondUser.uuid,
  );
  const lineage = [firstUser, firstAssistant, secondUser, secondAssistant];

  it('partitions through the target for Fork and Resume', () => {
    const selection = selectHistoricalLineage(
      lineage,
      secondUser.uuid,
      'through-target',
    );

    expect(selection?.retainedChain).toEqual([
      firstUser,
      firstAssistant,
      secondUser,
    ]);
    expect(selection?.discardedChain).toEqual([secondAssistant]);
    expect(selection?.runtimeMessages.map(({ uuid }) => uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
      secondUser.uuid,
    ]);
    expect(selection?.retainedLeafUuid).toBe(secondUser.uuid);
  });

  it('partitions from the target for Rewind', () => {
    const selection = selectHistoricalLineage(
      lineage,
      secondUser.uuid,
      'before-target',
    );

    expect(selection?.target).toBe(secondUser);
    expect(selection?.retainedChain).toEqual([firstUser, firstAssistant]);
    expect(selection?.discardedChain).toEqual([secondUser, secondAssistant]);
    expect(selection?.runtimeMessages.map(({ uuid }) => uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ]);
    expect(selection?.retainedLeafUuid).toBe(firstAssistant.uuid);
  });

  it('returns undefined when the target is outside the active lineage', () => {
    expect(
      selectHistoricalLineage(lineage, 'missing', 'through-target'),
    ).toBeUndefined();
  });
});
