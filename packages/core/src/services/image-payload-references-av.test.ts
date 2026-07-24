/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  countAllInlineAudioVideo,
  replaceAudioVideoPayloadsInPlace,
  InMemoryImagePayloadStore,
} from './image-payload-references.js';

function av(mimeType: string): Content {
  return {
    role: 'user',
    parts: [{ inlineData: { mimeType, data: 'AAAA' } }],
  };
}

describe('audio/video history governance', () => {
  it('counts inline audio and video payloads (not images)', () => {
    const contents: Content[] = [
      av('audio/mpeg'),
      av('video/mp4'),
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'x' } }],
      },
    ];
    expect(countAllInlineAudioVideo(contents)).toBe(2);
  });

  it('evicts a/v payloads to a memory-pointing reference, skipping the current turn', () => {
    const current = av('video/mp4');
    const contents: Content[] = [av('audio/mpeg'), current];
    const store = new InMemoryImagePayloadStore();
    const replaced = replaceAudioVideoPayloadsInPlace(contents, store, current);

    // Old audio turn was evicted...
    expect(replaced).toHaveLength(1);
    const evictedText = contents[0].parts?.[0]?.text ?? '';
    expect(evictedText).toContain('Audio #');
    expect(evictedText).toContain('media memory');
    expect(contents[0].parts?.[0]?.inlineData).toBeUndefined();
    // ...but the current turn's video is preserved (still sees fresh media).
    expect(current.parts?.[0]?.inlineData?.mimeType).toBe('video/mp4');
    // Original bytes are recoverable from the store.
    expect(store.get(replaced[0].id)?.data).toBe('AAAA');
  });

  it('does not touch inline images', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'x' } }],
      },
    ];
    const store = new InMemoryImagePayloadStore();
    const replaced = replaceAudioVideoPayloadsInPlace(contents, store);
    expect(replaced).toHaveLength(0);
    expect(contents[0].parts?.[0]?.inlineData?.mimeType).toBe('image/png');
  });
});
