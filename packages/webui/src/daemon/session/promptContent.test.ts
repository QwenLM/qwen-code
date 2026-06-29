/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toDaemonPromptContent } from './promptContent.js';

describe('toDaemonPromptContent', () => {
  it('keeps text prompts as the first daemon content block', () => {
    expect(toDaemonPromptContent('hello')).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('normalizes image aliases into daemon image content blocks', () => {
    expect(
      toDaemonPromptContent('look', [
        { data: 'a', mimeType: 'image/png' },
        { data: 'b', media_type: 'image/jpeg' },
      ]),
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'a', mimeType: 'image/png' },
      { type: 'image', data: 'b', mimeType: 'image/jpeg' },
    ]);
  });
});
