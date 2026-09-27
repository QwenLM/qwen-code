/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content, Part } from '@google/genai';
import {
  collectToolCallIdsFromHistory,
  getProviderToolCallId,
  normalizeModelToolCallIds,
} from './toolCallIdUtils.js';
import { content, fnCall, fnResponse } from '../test-utils/model-fixtures.js';

describe('tool call ID boundaries', () => {
  it('suffixes cross-turn duplicate ids and drops same-turn replays', () => {
    const history: Content[] = [
      content(
        'model',
        fnCall('read_file', { file_path: 'a.ts' }, 'dup_id_0001'),
      ),
      content('user', fnResponse('read_file', { output: 'A' }, 'dup_id_0001')),
    ];
    const seenIds = collectToolCallIdsFromHistory(history);
    const turnRawIds = new Set<string>();
    const parts: Part[] = [
      fnCall('read_file', { file_path: 'b.ts' }, 'dup_id_0001'),
      fnCall('read_file', { file_path: 'b.ts' }, 'dup_id_0001'),
      { text: 'done' },
    ];

    const normalized = normalizeModelToolCallIds(parts, seenIds, turnRawIds);

    expect(normalized).toEqual([
      fnCall('read_file', { file_path: 'b.ts' }, 'dup_id_0001__qwen_dup_2'),
      { text: 'done' },
    ]);
    expect(getProviderToolCallId(normalized[0]!.functionCall!)).toBe(
      'dup_id_0001',
    );
    expect(seenIds.has('dup_id_0001__qwen_dup_2')).toBe(true);
  });
});
