/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import { isTypedPrompt } from '@qwen-code/qwen-code-core';
import { markInjectedFilePart } from './injected-file-parts.js';
import { markPromptParts } from './prompt-parts.js';

describe('markPromptParts', () => {
  it('marks a plain-string prompt', () => {
    const [part] = markPromptParts('review the parser');

    expect(part!.text).toBe('review the parser');
    expect(isTypedPrompt(part!)).toBe(true);
  });

  it('marks text parts and leaves media as it is', () => {
    const image: Part = { inlineData: { mimeType: 'image/png', data: 'abc' } };

    const parts = markPromptParts([{ text: 'what is this' }, image]);

    expect(isTypedPrompt(parts[0]!)).toBe(true);
    expect(parts[1]).toBe(image);
  });

  it('leaves file content an @{path} injection added unmarked', () => {
    const fileBody = markInjectedFilePart({ text: 'const x = 1;' });

    const parts = markPromptParts([
      { text: 'Explain this file:\n' },
      fileBody,
      { text: '\nKeep it short.' },
    ]);

    expect(parts.map(isTypedPrompt)).toEqual([true, false, true]);
    expect(parts[1]).toBe(fileBody);
  });

  it('leaves a thought part unmarked', () => {
    const [part] = markPromptParts([{ text: 'reasoning', thought: true }]);

    expect(isTypedPrompt(part!)).toBe(false);
  });
});
