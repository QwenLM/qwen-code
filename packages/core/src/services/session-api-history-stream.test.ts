/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { ChatRecord } from './chatRecordingService.js';
import {
  getLastApiPromptCancellation,
  getLastApiPromptCancellationFromHistory,
  markApiHistoryPrompt,
} from './session-api-history.js';

describe('streamed cancellation ownership', () => {
  const base = {
    sessionId: 'session',
    timestamp: '2026-10-27T00:00:00.000Z',
    cwd: '/workspace',
    version: 'test',
    parentUuid: null,
  };
  const owner: ChatRecord = {
    ...base,
    uuid: 'owner',
    type: 'user',
    promptId: 'client',
    daemonPromptId: 'daemon',
    message: { role: 'user', parts: [{ text: 'work' }] },
  };
  const result: ChatRecord = {
    ...base,
    uuid: 'cancelled',
    type: 'system',
    subtype: 'turn_result',
    promptId: 'client',
    systemPayload: {
      promptId: 'daemon',
      state: 'cancelled',
      cancelledAt: 1,
      endedAt: 2,
    },
  };
  const history: Content[] = [structuredClone(owner.message!)];
  markApiHistoryPrompt(history[0]!, 'client');
  const source = (
    entries: readonly ChatRecord[],
  ): AsyncIterable<ChatRecord> => ({
    async *[Symbol.asyncIterator]() {
      for (const entry of entries) yield structuredClone(entry);
    },
  });

  it('preserves the original confirmation after long completed metadata', async () => {
    let passes = 0;
    const records = {
      async *[Symbol.asyncIterator]() {
        passes++;
        yield owner;
        for (let i = 0; i < 10_000; i++)
          yield {
            ...base,
            uuid: `ui-${i}`,
            type: 'system' as const,
            subtype: 'ui_telemetry' as const,
          };
        yield result;
      },
    };
    expect(
      await getLastApiPromptCancellationFromHistory(history, records),
    ).toEqual({
      reason: 'unknown',
      promptId: 'daemon',
      confirmationId: 'cancelled',
    });
    expect(passes).toBe(3);
  });

  it('matches existing ownership rules for ambiguous, duplicate and unrelated results', async () => {
    const variants: ChatRecord[] = [
      owner,
      { ...owner, uuid: 'other-owner', promptId: 'other' },
      { ...owner, uuid: 'attempt', type: 'system', subtype: 'turn_attempt' },
      result,
      { ...result, uuid: 'second-result' },
      {
        ...result,
        uuid: 'completed',
        systemPayload: { promptId: 'daemon', state: 'completed', endedAt: 3 },
      },
      { ...result, uuid: 'legacy', promptId: undefined },
      {
        ...result,
        uuid: 'unrelated',
        promptId: 'other',
        systemPayload: {
          promptId: 'unrelated',
          state: 'cancelled',
          cancelledAt: 5,
          endedAt: 6,
        },
      },
      {
        ...result,
        uuid: 'explicit-user',
        systemPayload: {
          ...(result.systemPayload as object),
          cancelReason: 'user',
        },
      } as ChatRecord,
    ];
    for (const before of variants)
      for (const after of variants) {
        const entries = [before, owner, result, after].map((entry) =>
          structuredClone(entry),
        );
        expect(
          await getLastApiPromptCancellationFromHistory(
            history,
            source(entries),
          ),
          `${before.uuid} -> ${after.uuid}`,
        ).toEqual(getLastApiPromptCancellation(history, entries));
      }
    for (const entries of [
      [],
      [result],
      [owner],
      [result, owner],
      [result, owner, { ...result }],
    ])
      expect(
        await getLastApiPromptCancellationFromHistory(history, source(entries)),
      ).toEqual(getLastApiPromptCancellation(history, entries));
  });
});
