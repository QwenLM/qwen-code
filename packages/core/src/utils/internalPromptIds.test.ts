/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isInternalPromptId } from './internalPromptIds.js';

describe('isInternalPromptId', () => {
  it('returns true for prompt_suggestion', () => {
    expect(isInternalPromptId('prompt_suggestion')).toBe(true);
  });

  it('returns true for forked_query', () => {
    expect(isInternalPromptId('forked_query')).toBe(true);
  });

  it('returns false for user_query', () => {
    expect(isInternalPromptId('user_query')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isInternalPromptId('')).toBe(false);
  });

  it('returns false for arbitrary prompt ids', () => {
    expect(isInternalPromptId('btw-prompt-id')).toBe(false);
    expect(isInternalPromptId('context-prompt-id')).toBe(false);
  });
});
