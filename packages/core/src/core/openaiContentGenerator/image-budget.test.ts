/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import {
  DEFAULT_MAX_REQUEST_IMAGES,
  evictOldestImagesBeyondCap,
} from './image-budget.js';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const img = (url: string) => ({
  type: 'image_url' as const,
  image_url: { url },
});
const txt = (text: string) => ({ type: 'text' as const, text });

function userWithImages(urls: string[]): Message {
  return { role: 'user', content: [txt('look'), ...urls.map(img)] } as Message;
}

function countImages(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const p of m.content)
        if ((p as { type?: string }).type === 'image_url') n++;
    }
  }
  return n;
}

describe('evictOldestImagesBeyondCap', () => {
  it('leaves a request under the cap untouched', () => {
    const messages = [userWithImages(['a', 'b', 'c'])];
    const evicted = evictOldestImagesBeyondCap(messages, 10);
    expect(evicted).toBe(0);
    expect(countImages(messages)).toBe(3);
  });

  it('evicts the oldest images and keeps the newest cap', () => {
    // Five images across two turns; cap 3 → evict the 2 oldest.
    const messages = [
      userWithImages(['a', 'b', 'c']),
      userWithImages(['d', 'e']),
    ];
    const evicted = evictOldestImagesBeyondCap(messages, 3);
    expect(evicted).toBe(2);
    expect(countImages(messages)).toBe(3);
    // The two oldest (a, b) became placeholders; c, d, e survive.
    const urls = messages
      .flatMap((m) =>
        Array.isArray(m.content) ? (m.content as unknown[]) : [],
      )
      .filter((p) => (p as { type?: string }).type === 'image_url')
      .map((p) => (p as { image_url: { url: string } }).image_url.url);
    expect(urls).toEqual(['c', 'd', 'e']);
    // Evicted slots keep a text part (message stays well-formed).
    const firstContent = messages[0].content as Array<{ type: string }>;
    expect(firstContent.filter((p) => p.type === 'text').length).toBe(3);
  });

  it('does not touch video_url parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          img('a'),
          img('b'),
          { type: 'video_url', video_url: { url: 'v' } },
        ],
      } as Message,
    ];
    const evicted = evictOldestImagesBeyondCap(messages, 1);
    expect(evicted).toBe(1);
    // video_url survives; one image remains.
    const kinds = (messages[0].content as Array<{ type: string }>).map(
      (p) => p.type,
    );
    expect(kinds.filter((k) => k === 'video_url').length).toBe(1);
    expect(kinds.filter((k) => k === 'image_url').length).toBe(1);
  });

  it('tolerates string-content messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'hi' } as Message,
      userWithImages(['a', 'b']),
    ];
    const evicted = evictOldestImagesBeyondCap(messages, 1);
    expect(evicted).toBe(1);
    expect(countImages(messages)).toBe(1);
  });

  it('defaults the cap to the qwen-omni safety margin', () => {
    expect(DEFAULT_MAX_REQUEST_IMAGES).toBeLessThan(256);
    const messages = [
      userWithImages(Array.from({ length: 300 }, (_, i) => `f${i}`)),
    ];
    evictOldestImagesBeyondCap(messages);
    expect(countImages(messages)).toBe(DEFAULT_MAX_REQUEST_IMAGES);
  });
});
