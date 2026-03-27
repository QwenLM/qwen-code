/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { generateFollowupSuggestions } from './suggestionGenerator.js';
import type { SuggestionContext } from './types.js';

describe('generateFollowupSuggestions', () => {
  it('generates suggestions after file edit', () => {
    const context: SuggestionContext = {
      lastMessage: '',
      toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
      modifiedFiles: [{ path: 'a.ts', type: 'edited' }],
      hasError: false,
      wasCancelled: false,
    };
    const result = generateFollowupSuggestions(context);
    expect(result.shouldShow).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('returns empty for no tool calls', () => {
    const context: SuggestionContext = {
      lastMessage: '',
      toolCalls: [],
      modifiedFiles: [],
      hasError: false,
      wasCancelled: false,
    };
    const result = generateFollowupSuggestions(context);
    expect(result.shouldShow).toBe(false);
  });
});
