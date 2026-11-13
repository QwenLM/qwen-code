/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming markdown heal: unclosed markers are completed so the streaming
 * tail renders as styled text instead of flipping between literal markers
 * and rendered styles frame to frame; settled text renders raw.
 */

import { describe, expect, it } from 'vitest';
import {
  assistantMarkdownForRender,
  healStreamingMarkdown,
} from './markdown-heal.js';

describe('healStreamingMarkdown', () => {
  it('closes an unclosed bold marker', () => {
    expect(healStreamingMarkdown('1. **聚合')).toBe('1. **聚合**');
  });

  it('renders an incomplete link as plain text (text-only mode)', () => {
    expect(healStreamingMarkdown('看 [这个链接](https://exampl')).toBe(
      '看 这个链接',
    );
  });

  it('leaves complete markdown untouched', () => {
    const complete = '完整 **加粗** 与 [链接](https://example.com) 文本';
    expect(healStreamingMarkdown(complete)).toBe(complete);
  });

  it('passes empty text through', () => {
    expect(healStreamingMarkdown('')).toBe('');
  });
});

describe('assistantMarkdownForRender', () => {
  it('heals while streaming', () => {
    expect(assistantMarkdownForRender('1. **聚合', true)).toBe('1. **聚合**');
  });

  it('renders the raw text once settled', () => {
    expect(assistantMarkdownForRender('1. **聚合', false)).toBe('1. **聚合');
  });
});
