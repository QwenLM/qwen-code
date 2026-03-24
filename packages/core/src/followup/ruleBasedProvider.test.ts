/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuleBasedProvider } from './ruleBasedProvider.js';
import type { SuggestionContext } from './types.js';

function makeContext(
  overrides: Partial<SuggestionContext> = {},
): SuggestionContext {
  return {
    lastMessage: '',
    toolCalls: [],
    modifiedFiles: [],
    hasError: false,
    wasCancelled: false,
    ...overrides,
  };
}

describe('RuleBasedProvider', () => {
  let provider: RuleBasedProvider;

  beforeEach(() => {
    provider = new RuleBasedProvider();
  });

  it('returns empty when context has error', () => {
    const result = provider.getSuggestions(
      makeContext({
        hasError: true,
        toolCalls: [{ name: 'Edit', input: {}, status: 'error' }],
      }),
    );
    expect(result.shouldShow).toBe(false);
    expect(result.suggestions).toHaveLength(0);
  });

  it('returns empty when context was cancelled', () => {
    const result = provider.getSuggestions(
      makeContext({
        wasCancelled: true,
        toolCalls: [{ name: 'Edit', input: {}, status: 'cancelled' }],
      }),
    );
    expect(result.shouldShow).toBe(false);
  });

  it('returns empty when no tool calls and no modified files', () => {
    const result = provider.getSuggestions(makeContext());
    expect(result.shouldShow).toBe(false);
  });

  it('suggests after file edit with modified files', () => {
    const result = provider.getSuggestions(
      makeContext({
        toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
        modifiedFiles: [{ path: 'foo.ts', type: 'edited' }],
      }),
    );
    expect(result.shouldShow).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.some((s) => s.text.includes('commit'))).toBe(
      true,
    );
  });

  it('suggests after creating new files', () => {
    const result = provider.getSuggestions(
      makeContext({
        toolCalls: [{ name: 'WriteFile', input: {}, status: 'success' }],
        modifiedFiles: [{ path: 'new.ts', type: 'created' }],
      }),
    );
    expect(result.shouldShow).toBe(true);
    expect(result.suggestions.some((s) => s.text.includes('test'))).toBe(true);
  });

  it('suggests after fixing bugs (matchMessage rule)', () => {
    const result = provider.getSuggestions(
      makeContext({
        lastMessage: 'I fixed the bug in the login handler',
        toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
        modifiedFiles: [{ path: 'login.ts', type: 'edited' }],
      }),
    );
    expect(result.shouldShow).toBe(true);
    expect(
      result.suggestions.some(
        (s) => s.text.includes('verify fix') || s.text.includes('commit'),
      ),
    ).toBe(true);
  });

  it('suggests after refactoring (matchMessage rule)', () => {
    const result = provider.getSuggestions(
      makeContext({
        lastMessage: 'I refactored the auth module',
        toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
        modifiedFiles: [{ path: 'auth.ts', type: 'edited' }],
      }),
    );
    expect(result.shouldShow).toBe(true);
    expect(
      result.suggestions.some(
        (s) => s.text.includes('run tests') || s.text.includes('commit'),
      ),
    ).toBe(true);
  });

  it('merges suggestions from multiple matching rules', () => {
    const result = provider.getSuggestions(
      makeContext({
        lastMessage: 'Fixed the bug',
        toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
        modifiedFiles: [{ path: 'foo.ts', type: 'edited' }],
      }),
    );
    expect(result.shouldShow).toBe(true);
    // Should have suggestions from both the Edit rule and the fix/bug rule
    expect(result.suggestions.length).toBeGreaterThan(3);
  });

  it('deduplicates suggestions across rules', () => {
    const result = provider.getSuggestions(
      makeContext({
        lastMessage: 'Refactored and edited',
        toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
        modifiedFiles: [{ path: 'foo.ts', type: 'edited' }],
      }),
    );
    const texts = result.suggestions.map((s) => s.text);
    const uniqueTexts = new Set(texts);
    expect(texts.length).toBe(uniqueTexts.size);
  });

  it('limits suggestions to MAX_SUGGESTIONS (5)', () => {
    const result = provider.getSuggestions(
      makeContext({
        lastMessage: 'Fixed the bug and refactored',
        toolCalls: [
          { name: 'Edit', input: {}, status: 'success' },
          { name: 'WriteFile', input: {}, status: 'success' },
        ],
        modifiedFiles: [
          { path: 'foo.ts', type: 'edited' },
          { path: 'bar.ts', type: 'created' },
        ],
      }),
    );
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
  });

  it('handles custom rules via addRule', () => {
    provider.addRule({
      pattern: /CustomTool/,
      suggestions: [
        { text: 'custom action', description: 'Do something custom' },
      ],
      priority: 200,
    });
    const result = provider.getSuggestions(
      makeContext({
        toolCalls: [{ name: 'CustomTool', input: {}, status: 'success' }],
      }),
    );
    expect(result.shouldShow).toBe(true);
    expect(result.suggestions[0].text).toBe('custom action');
  });

  it('does not suggest Edit rule when no files were modified', () => {
    const result = provider.getSuggestions(
      makeContext({
        toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
        modifiedFiles: [], // condition requires modifiedFiles.length > 0
      }),
    );
    // Edit rule should not match because condition fails
    // But we still have toolCalls, so other rules might match via lastMessage
    const hasCommitSuggestion = result.suggestions.some(
      (s) => s.text === 'commit this',
    );
    expect(hasCommitSuggestion).toBe(false);
  });
});
