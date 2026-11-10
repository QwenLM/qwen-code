/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  excludedHostedPrompts,
  filterHostedTurnHistory,
  isExcludedHostedRecord,
  normalizeHostedTurnRecords,
} from './hosted-turn-history.js';
import { buildSessionHistoryFromConversation } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import { getApiHistoryPromptId } from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';
import { CompressionStatus } from '@qwen-code/qwen-code-core/core/turn.js';

describe('Hosted committed-work exclusions', () => {
  it.each([
    ['cancelled', 'harness_interruption', 'assistant', false],
    ['cancelled', 'harness_interruption', 'tool_result', false],
    ['cancelled', 'harness_interruption', 'user', true],
    ['cancelled', 'cancelled', 'assistant', true],
    ['error', 'error', 'assistant', true],
    ['completed', 'end_turn', 'user', false],
  ] as const)(
    'exclusion for %s/%s with only %s work is %s',
    (outcome, stopReason, type, excluded) => {
      const event = {
        kind: 'turn.settled',
        payload: { turnId: 'turn-a', outcome, stopReason },
      } as unknown as ManagedSessionEvent;
      const record = {
        uuid: 'record-a',
        parentUuid: null,
        sessionId: 'session',
        timestamp: '2026-11-10T00:00:00.000Z',
        cwd: '/workspace',
        version: 'test',
        daemonPromptId: 'turn-a',
        type,
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: [{ text: 'committed content' }],
        },
      } satisfies ChatRecord;
      expect(excludedHostedPrompts([event], [record]).has('turn-a')).toBe(
        excluded,
      );
    },
  );
});

describe('Hosted snapshot turn identities', () => {
  it.each(
    [false, true].flatMap((canonical) =>
      [false, true].map((wake) => ({ canonical, wake })),
    ),
  )(
    'keeps a later wake-only group after exclusion (canonical=$canonical, excluded wake=$wake)',
    ({ canonical, wake }) => {
      const envelope = {
        parentUuid: null,
        sessionId: 'session',
        timestamp: '2026-11-10T00:00:00.000Z',
        cwd: '/workspace',
        version: 'hosted-harness/1',
      };
      const raw: ChatRecord[] = [
        {
          ...envelope,
          uuid: 'cancelled-user',
          type: 'user',
          daemonPromptId: 'cancelled',
          message: { role: 'user', parts: [{ text: 'cancelled instruction' }] },
        },
        {
          ...envelope,
          uuid: 'cancelled-answer',
          type: 'assistant',
          daemonPromptId: 'cancelled',
          message: { role: 'model', parts: [{ text: 'cancelled answer' }] },
        },
        {
          ...envelope,
          uuid: 'wake-attempt',
          type: 'system',
          subtype: 'turn_attempt',
          daemonPromptId: 'wake',
        },
        {
          ...envelope,
          uuid: 'wake-answer',
          type: 'assistant',
          daemonPromptId: 'wake',
          message: {
            role: 'model',
            parts: [{ text: 'completed wake answer' }],
          },
        },
      ];
      if (wake)
        raw[0] = {
          ...envelope,
          uuid: 'cancelled-attempt',
          type: 'system',
          subtype: 'turn_attempt',
          daemonPromptId: 'cancelled',
        };
      const projected = buildSessionHistoryFromConversation({
        messages: canonical ? normalizeHostedTurnRecords(raw) : raw,
      }).apiHistory;
      const prefix = [
        { role: 'user', parts: [{ text: 'compressed summary' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ];
      const snapshot: ChatRecord = JSON.parse(
        JSON.stringify({
          ...envelope,
          uuid: 'snapshot',
          type: 'system',
          subtype: 'chat_compression',
          systemPayload: {
            info: {
              compressionStatus: CompressionStatus.COMPRESSED,
              originalTokenCount: 100,
              newTokenCount: 10,
            },
            compressedHistory: [...prefix, ...projected],
            promptIds: [
              null,
              null,
              ...projected.map((entry) => getApiHistoryPromptId(entry) ?? null),
            ],
            summaryPrefixLength: 2,
          },
        }),
      );
      const records = [...raw, snapshot];
      const original = structuredClone(records);
      const excluded = new Set(['cancelled']);
      const normalized = normalizeHostedTurnRecords(records, excluded);
      const history = filterHostedTurnHistory(
        buildSessionHistoryFromConversation({
          messages: normalized.filter(
            (record) => !isExcludedHostedRecord(record, excluded),
          ),
        }).apiHistory,
        excluded,
      );
      expect(history.map((entry) => entry.parts?.[0].text)).toEqual(
        canonical
          ? ['compressed summary', 'Understood.', 'completed wake answer']
          : ['completed wake answer'],
      );
      expect(getApiHistoryPromptId(history.at(-1)!)).toBe('wake');
      expect(records).toEqual(original);
    },
  );
});
