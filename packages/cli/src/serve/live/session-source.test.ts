/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isReservedLiveSessionSource,
  readCompatibleLiveSessionMetadata,
} from './session-source.js';

describe('readCompatibleLiveSessionMetadata', () => {
  const records = new Map([
    [
      'coordinator',
      {
        sourceType: 'default',
        sourceId: 'realtime_voice:p1:h1:a1:call-1',
      },
    ],
    ['worker', { parentSessionId: 'coordinator' }],
    ['nested-worker', { parentSessionId: 'worker' }],
    [
      'attributed-worker',
      {
        parentSessionId: 'coordinator',
        sourceType: 'default',
        sourceId: 'realtime_voice:p1:h1:a1:forged-worker',
      },
    ],
    ['generic', {}],
    ['generic-child', { parentSessionId: 'generic' }],
    [
      'empty-call-id',
      { sourceType: 'default', sourceId: 'realtime_voice:p1:h1:a1:' },
    ],
  ]);
  const read = async (sessionId: string) => records.get(sessionId) ?? {};

  it('reserves even a malformed empty Live call id from generic creation', () => {
    expect(
      isReservedLiveSessionSource({
        sourceType: 'default',
        sourceId: 'realtime_voice:p1:h1:a1:',
      }),
    ).toBe(true);
  });

  it('accepts a versioned Coordinator and its direct worker', async () => {
    await expect(
      readCompatibleLiveSessionMetadata('coordinator', read),
    ).resolves.toEqual(records.get('coordinator'));
    await expect(
      readCompatibleLiveSessionMetadata('worker', read),
    ).resolves.toEqual(records.get('worker'));
  });

  it('rejects unattributed sessions and children without a Live parent', async () => {
    await expect(
      readCompatibleLiveSessionMetadata('generic', read),
    ).resolves.toBeUndefined();
    await expect(
      readCompatibleLiveSessionMetadata('generic-child', read),
    ).resolves.toBeUndefined();
    await expect(
      readCompatibleLiveSessionMetadata('nested-worker', read),
    ).resolves.toBeUndefined();
    await expect(
      readCompatibleLiveSessionMetadata('attributed-worker', read),
    ).resolves.toBeUndefined();
    await expect(
      readCompatibleLiveSessionMetadata('empty-call-id', read),
    ).resolves.toBeUndefined();
  });
});
