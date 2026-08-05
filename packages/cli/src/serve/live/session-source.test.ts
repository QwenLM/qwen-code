/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isReservedLiveSessionSource,
  readLoadableLiveConversationMetadata,
} from './session-source.js';

describe('readLoadableLiveConversationMetadata', () => {
  const records = new Map([
    [
      'coordinator',
      {
        sourceType: 'default',
        sourceId: 'realtime_voice:call-1',
      },
    ],
    ['worker', { parentSessionId: 'coordinator' }],
    ['nested-worker', { parentSessionId: 'worker' }],
    [
      'attributed-worker',
      {
        parentSessionId: 'coordinator',
        sourceType: 'default',
        sourceId: 'realtime_voice:forged-worker',
      },
    ],
    ['generic', { sourceType: 'default' }],
    ['generic-child', { parentSessionId: 'generic' }],
    ['empty-call-id', { sourceType: 'default', sourceId: 'realtime_voice:' }],
  ]);
  const read = async (sessionId: string) => records.get(sessionId) ?? {};

  it('reserves even a malformed empty Live call id from generic creation', () => {
    expect(
      isReservedLiveSessionSource({
        sourceType: 'default',
        sourceId: 'realtime_voice:',
      }),
    ).toBe(true);
  });

  it('accepts a versioned Coordinator and its direct worker', async () => {
    await expect(
      readLoadableLiveConversationMetadata('coordinator', read),
    ).resolves.toEqual(records.get('coordinator'));
    await expect(
      readLoadableLiveConversationMetadata('worker', read),
    ).resolves.toEqual(records.get('worker'));
  });

  it('accepts a standalone projectless task and its direct child', async () => {
    await expect(
      readLoadableLiveConversationMetadata('generic', read),
    ).resolves.toEqual(records.get('generic'));
    await expect(
      readLoadableLiveConversationMetadata('generic-child', read),
    ).resolves.toEqual(records.get('generic-child'));
  });

  it('rejects nested, attributed, and malformed Live sessions', async () => {
    await expect(
      readLoadableLiveConversationMetadata('nested-worker', read),
    ).resolves.toBeUndefined();
    await expect(
      readLoadableLiveConversationMetadata('attributed-worker', read),
    ).resolves.toBeUndefined();
    await expect(
      readLoadableLiveConversationMetadata('empty-call-id', read),
    ).resolves.toBeUndefined();
  });
});
