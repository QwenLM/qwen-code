/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { appendUserPromptExpansionAdditionalContext } from './userPromptExpansionHook.js';

describe('appendUserPromptExpansionAdditionalContext', () => {
  it('truncates additional context before appending to string prompts', () => {
    const longContext = 'x'.repeat(10_005);

    const result = appendUserPromptExpansionAdditionalContext(
      'base prompt',
      longContext,
    );

    expect(result).toBe(`base prompt\n\n${'x'.repeat(10_000)}`);
  });

  it('truncates additional context before appending to part arrays', () => {
    const longContext = 'y'.repeat(10_005);

    const result = appendUserPromptExpansionAdditionalContext(
      [{ text: 'base prompt' }],
      longContext,
    );

    expect(result).toEqual([
      { text: 'base prompt' },
      { text: `\n\n${'y'.repeat(10_000)}` },
    ]);
  });
});
