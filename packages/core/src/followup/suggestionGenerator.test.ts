/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { shouldFilterSuggestion } from './suggestionGenerator.js';

describe('shouldFilterSuggestion', () => {
  it('filters "done"', () => {
    expect(shouldFilterSuggestion('done')).toBe(true);
  });

  it('filters meta-text', () => {
    expect(shouldFilterSuggestion('nothing found')).toBe(true);
    expect(shouldFilterSuggestion('no suggestion needed')).toBe(true);
    expect(shouldFilterSuggestion('silence')).toBe(true);
    expect(shouldFilterSuggestion('staying silent here')).toBe(true);
  });

  it('filters meta-wrapped text', () => {
    expect(shouldFilterSuggestion('(silence)')).toBe(true);
    expect(shouldFilterSuggestion('[no suggestion]')).toBe(true);
  });

  it('filters error messages', () => {
    expect(shouldFilterSuggestion('api error: 500')).toBe(true);
    expect(shouldFilterSuggestion('prompt is too long')).toBe(true);
  });

  it('filters prefixed labels', () => {
    expect(shouldFilterSuggestion('Suggestion: commit this')).toBe(true);
  });

  it('filters single words not in whitelist', () => {
    expect(shouldFilterSuggestion('hmm')).toBe(true);
    expect(shouldFilterSuggestion('maybe')).toBe(true);
  });

  it('allows whitelisted single words', () => {
    expect(shouldFilterSuggestion('yes')).toBe(false);
    expect(shouldFilterSuggestion('commit')).toBe(false);
    expect(shouldFilterSuggestion('push')).toBe(false);
    expect(shouldFilterSuggestion('no')).toBe(false);
  });

  it('allows slash commands as single word', () => {
    expect(shouldFilterSuggestion('/commit')).toBe(false);
  });

  it('filters too many words', () => {
    expect(
      shouldFilterSuggestion(
        'this is a very long suggestion with way too many words in it to show',
      ),
    ).toBe(true);
  });

  it('filters suggestions >= 100 chars', () => {
    expect(shouldFilterSuggestion('a'.repeat(100))).toBe(true);
  });

  it('filters multiple sentences', () => {
    expect(shouldFilterSuggestion('Run the tests. Then commit.')).toBe(true);
  });

  it('filters formatting', () => {
    expect(shouldFilterSuggestion('run the **tests**')).toBe(true);
    expect(shouldFilterSuggestion('line1\nline2')).toBe(true);
  });

  it('filters evaluative language', () => {
    expect(shouldFilterSuggestion('looks good to me')).toBe(true);
    expect(shouldFilterSuggestion('thanks for the help')).toBe(true);
    expect(shouldFilterSuggestion('that works perfectly')).toBe(true);
  });

  it('filters AI-voice patterns', () => {
    expect(shouldFilterSuggestion('Let me check that')).toBe(true);
    expect(shouldFilterSuggestion("I'll run the tests")).toBe(true);
    expect(shouldFilterSuggestion("Here's what I found")).toBe(true);
  });

  it('does not false-positive on evaluative substrings', () => {
    expect(shouldFilterSuggestion('run nicely formatted tests')).toBe(false);
    expect(shouldFilterSuggestion('fix the greatest issue')).toBe(false);
    expect(shouldFilterSuggestion('create thanksgiving banner')).toBe(false);
  });

  it('allows good suggestions', () => {
    expect(shouldFilterSuggestion('run the tests')).toBe(false);
    expect(shouldFilterSuggestion('commit this')).toBe(false);
    expect(shouldFilterSuggestion('try it out')).toBe(false);
    expect(shouldFilterSuggestion('push it')).toBe(false);
    expect(shouldFilterSuggestion('create a PR')).toBe(false);
  });
});
