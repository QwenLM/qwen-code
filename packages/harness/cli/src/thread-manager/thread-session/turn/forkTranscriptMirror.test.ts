/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ndjsonSafeStringify } from '@qwen-code/core';
import {
  chunkForkTranscriptEntries,
  FORK_TRANSCRIPT_MIRROR_CHUNK_BYTES,
} from './forkTranscriptMirror.js';

function bytesOf(value: unknown): number {
  return Buffer.byteLength(ndjsonSafeStringify(value), 'utf8');
}

describe('chunkForkTranscriptEntries', () => {
  it('按序列化字节上限分片并保持顺序', () => {
    const first = { uuid: '1', text: 'a'.repeat(20) };
    const second = { uuid: '2', text: 'b'.repeat(20) };
    const third = { uuid: '3', text: 'c'.repeat(20) };
    const chunks = chunkForkTranscriptEntries(
      [first, second, third],
      bytesOf(first) + bytesOf(second) - 1,
    );

    expect(chunks).toEqual([[first], [second], [third]]);
  });

  it('空输入不产生空分片', () => {
    expect(chunkForkTranscriptEntries([])).toEqual([]);
  });

  it('单条超过上限时仍独立成片，不丢内容', () => {
    const entry = { uuid: 'big', text: 'x'.repeat(FORK_TRANSCRIPT_MIRROR_CHUNK_BYTES) };
    expect(chunkForkTranscriptEntries([entry], 16)).toEqual([[entry]]);
  });

  it('默认上限下小条目合并为一片', () => {
    const entries = [{ uuid: '1' }, { uuid: '2' }];
    expect(chunkForkTranscriptEntries(entries)).toEqual([entries]);
  });
});
