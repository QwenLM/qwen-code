/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractTextFromBlocks,
  extractUserVisiblePromptText,
} from './promptTextUtils.js';

describe('promptTextUtils', () => {
  describe('extractTextFromBlocks', () => {
    it('joins text blocks and skips non-text blocks', () => {
      expect(
        extractTextFromBlocks([
          { type: 'text', text: '第一段' },
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: 'abc',
            },
          },
          { type: 'text', text: '第二段' },
        ]),
      ).toBe('第一段\n第二段');
    });
  });

  describe('extractUserVisiblePromptText', () => {
    it('omits system-reminder text blocks from block prompts', () => {
      expect(
        extractUserVisiblePromptText([
          { type: 'text', text: '用户问题' },
          {
            type: 'text',
            text: '<system-reminder>internal</system-reminder>',
          },
          { type: 'text', text: '补充说明' },
        ]),
      ).toBe('用户问题\n补充说明');
    });

    it('读取冻结的标准内容，不修改图片或缓存元数据', () => {
      const blocks = Object.freeze([
        Object.freeze({ type: 'text', text: '用户问题' }),
        Object.freeze({
          type: 'image',
          source: Object.freeze({ type: 'url', url: 'https://example.test/image.png' }),
          cacheControl: Object.freeze({ type: 'ephemeral', ttl: '1h' }),
        }),
      ]);
      expect(extractTextFromBlocks(blocks)).toBe('用户问题');
      expect(extractUserVisiblePromptText(blocks)).toBe('用户问题');
      expect(blocks[1]).toMatchObject({ cacheControl: { type: 'ephemeral', ttl: '1h' } });
    });

    it('passes string prompts through unchanged', () => {
      const prompt =
        '用户问题\n<system-reminder>legacy text stays</system-reminder>';

      expect(extractUserVisiblePromptText(prompt)).toBe(prompt);
    });
  });
});
