/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FollowupSuggestionsGenerator,
  extractSuggestionContext,
  getGenerator,
  resetGenerator,
} from './suggestionGenerator.js';
import type {
  SuggestionContext,
  SuggestionProvider,
  SuggestionResult,
} from './types.js';

describe('FollowupSuggestionsGenerator', () => {
  let generator: FollowupSuggestionsGenerator;

  beforeEach(() => {
    generator = new FollowupSuggestionsGenerator();
  });

  it('generates suggestions from default provider', () => {
    const context: SuggestionContext = {
      lastMessage: '',
      toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
      modifiedFiles: [{ path: 'a.ts', type: 'edited' }],
      hasError: false,
      wasCancelled: false,
    };
    const result = generator.generate(context);
    expect(result.shouldShow).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('returns empty for no context', () => {
    const context: SuggestionContext = {
      lastMessage: '',
      toolCalls: [],
      modifiedFiles: [],
      hasError: false,
      wasCancelled: false,
    };
    const result = generator.generate(context);
    expect(result.shouldShow).toBe(false);
  });

  it('custom provider takes priority over default', () => {
    const customProvider: SuggestionProvider = {
      getSuggestions: (): SuggestionResult => ({
        suggestions: [{ text: 'custom suggestion', priority: 100 }],
        shouldShow: true,
      }),
    };
    generator.addProvider(customProvider);

    const context: SuggestionContext = {
      lastMessage: '',
      toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
      modifiedFiles: [{ path: 'a.ts', type: 'edited' }],
      hasError: false,
      wasCancelled: false,
    };
    const result = generator.generate(context);
    expect(result.suggestions[0].text).toBe('custom suggestion');
  });

  it('removeProvider works', () => {
    const customProvider: SuggestionProvider = {
      getSuggestions: (): SuggestionResult => ({
        suggestions: [{ text: 'custom', priority: 100 }],
        shouldShow: true,
      }),
    };
    generator.addProvider(customProvider);
    generator.removeProvider(customProvider);

    const context: SuggestionContext = {
      lastMessage: '',
      toolCalls: [{ name: 'Edit', input: {}, status: 'success' }],
      modifiedFiles: [{ path: 'a.ts', type: 'edited' }],
      hasError: false,
      wasCancelled: false,
    };
    const result = generator.generate(context);
    // Should fall back to default provider
    expect(result.suggestions[0].text).not.toBe('custom');
  });
});

describe('extractSuggestionContext', () => {
  it('maps fields correctly', () => {
    const context = extractSuggestionContext({
      lastMessage: 'hello',
      toolCalls: [
        { name: 'Edit', input: { file: 'a.ts' }, status: 'success' },
        { name: 'Shell', input: {}, status: 'error' },
      ],
      modifiedFiles: [{ path: 'a.ts', type: 'edited' }],
      hasError: true,
      wasCancelled: false,
    });

    expect(context.lastMessage).toBe('hello');
    expect(context.toolCalls).toHaveLength(2);
    expect(context.toolCalls[0].status).toBe('success');
    expect(context.toolCalls[1].status).toBe('error');
    expect(context.modifiedFiles).toHaveLength(1);
    expect(context.hasError).toBe(true);
    expect(context.wasCancelled).toBe(false);
  });

  it('defaults optional fields', () => {
    const context = extractSuggestionContext({ lastMessage: 'test' });
    expect(context.toolCalls).toHaveLength(0);
    expect(context.modifiedFiles).toHaveLength(0);
    expect(context.hasError).toBe(false);
    expect(context.wasCancelled).toBe(false);
    expect(context.gitStatus).toBeUndefined();
  });

  it('maps unknown status to success', () => {
    const context = extractSuggestionContext({
      lastMessage: '',
      toolCalls: [{ name: 'Edit', input: {}, status: 'pending' }],
    });
    expect(context.toolCalls[0].status).toBe('success');
  });

  it('maps git status correctly', () => {
    const context = extractSuggestionContext({
      lastMessage: '',
      gitStatus: { hasStagedChanges: true, branch: 'main' },
    });
    expect(context.gitStatus?.hasStagedChanges).toBe(true);
    expect(context.gitStatus?.hasUnstagedChanges).toBe(false);
    expect(context.gitStatus?.branch).toBe('main');
  });
});

describe('getGenerator / resetGenerator', () => {
  beforeEach(() => {
    resetGenerator();
  });

  it('returns singleton', () => {
    const a = getGenerator();
    const b = getGenerator();
    expect(a).toBe(b);
  });

  it('resetGenerator creates new instance', () => {
    const a = getGenerator();
    resetGenerator();
    const b = getGenerator();
    expect(a).not.toBe(b);
  });
});
