/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content, Part } from '@google/genai';
import {
  collectToolCallIdsFromHistory,
  dedupeToolCallsById,
  normalizeModelToolCallIds,
} from './toolCallIdUtils.js';

describe('toolCallIdUtils', () => {
  it('suffixes cross-turn duplicate ids and drops same-turn replays', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'dup_id_0001',
              name: 'read_file',
              args: { file_path: 'a.ts' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'dup_id_0001',
              name: 'read_file',
              response: { output: 'A' },
            },
          },
        ],
      },
    ];
    const seenIds = collectToolCallIdsFromHistory(history);
    const turnRawIds = new Set<string>();
    const parts: Part[] = [
      {
        functionCall: {
          id: 'dup_id_0001',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      },
      {
        functionCall: {
          id: 'dup_id_0001',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      },
      { text: 'done' },
    ];

    const normalized = normalizeModelToolCallIds(parts, seenIds, turnRawIds);

    expect(normalized).toEqual([
      {
        functionCall: {
          id: 'dup_id_0001__qwen_dup_2',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      },
      { text: 'done' },
    ]);
    expect(seenIds.has('dup_id_0001__qwen_dup_2')).toBe(true);
  });

  it('generates stable non-empty ids for missing functionCall ids', () => {
    const seenIds = new Set<string>(['call_qwen_1']);

    const normalized = normalizeModelToolCallIds(
      [
        { functionCall: { name: 'first', args: {} } },
        { functionCall: { name: 'second', args: {} } },
      ],
      seenIds,
      new Set<string>(),
    );

    expect(normalized.map((part) => part.functionCall?.id)).toEqual([
      'call_qwen_2',
      'call_qwen_3',
    ]);
  });

  it('deduplicates direct function call batches by id', () => {
    const calls = [
      { id: 'call_1', name: 'read_file', args: { file_path: 'a.ts' } },
      { id: 'call_1', name: 'read_file', args: { file_path: 'a.ts' } },
      { id: 'call_2', name: 'read_file', args: { file_path: 'b.ts' } },
      { name: 'missing_id', args: {} },
      { name: 'missing_id_again', args: {} },
    ];

    expect(dedupeToolCallsById(calls)).toEqual([
      calls[0],
      calls[2],
      calls[3],
      calls[4],
    ]);
  });
});
