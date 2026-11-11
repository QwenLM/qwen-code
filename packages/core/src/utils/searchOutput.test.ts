/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { decodeSearchContent } from './searchOutput.js';

describe('decodeSearchContent', () => {
  it('preserves complete results around malformed records and missing event data', () => {
    const record = (type: string, data: unknown) =>
      JSON.stringify({ type, data });
    const path = { text: 'a:b\nfile.txt' };
    const records = [
      record('begin', { path }),
      record('match', {
        path,
        lines: { text: 'needle\r\n中文 needle\r\n' },
        line_number: 1,
      }),
      '{"type":',
      'noise',
      'null',
      '[]',
      '{}',
      record('match', null),
      record('context', 42),
      record('end', { path, binary_offset: null }),
      '{',
    ];
    expect(
      decodeSearchContent(records, { context: true, onlyMatching: false }),
    ).toEqual([
      'a:b\nfile.txt\0' + '1:needle',
      'a:b\nfile.txt\0' + '2:中文 needle',
    ]);
  });
});
