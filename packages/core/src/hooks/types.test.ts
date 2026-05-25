/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
  createHookOutput,
  UserPromptExpansionHookOutput,
} from './types.js';

describe('UserPromptSubmitHookOutput.getAdditionalContext', () => {
  it('preserves raw additionalContext', () => {
    const output = createHookOutput('UserPromptSubmit', {
      hookSpecificOutput: { additionalContext: '<xml>value</xml>' },
    });

    expect(output.getAdditionalContext()).toBe('<xml>value</xml>');
  });
});

describe('UserPromptExpansionHookOutput.getAdditionalContext', () => {
  it('returns undefined when hookSpecificOutput is absent', () => {
    expect(
      new UserPromptExpansionHookOutput().getAdditionalContext(),
    ).toBeUndefined();
  });

  it('returns undefined when additionalContext is absent', () => {
    expect(
      new UserPromptExpansionHookOutput({
        hookSpecificOutput: {},
      }).getAdditionalContext(),
    ).toBeUndefined();
  });

  it('returns undefined when additionalContext is not a string', () => {
    expect(
      new UserPromptExpansionHookOutput({
        hookSpecificOutput: { additionalContext: 123 },
      }).getAdditionalContext(),
    ).toBeUndefined();
  });

  it('preserves empty-string semantics', () => {
    expect(
      new UserPromptExpansionHookOutput({
        hookSpecificOutput: { additionalContext: '' },
      }).getAdditionalContext(),
    ).toBe('');
  });

  it('escapes after truncating and caps the escaped result', () => {
    const output = new UserPromptExpansionHookOutput({
      hookSpecificOutput: {
        additionalContext:
          '<'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH) +
          'ignored',
      },
    });

    const result = output.getAdditionalContext();

    expect(result).toHaveLength(
      MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
    );
    expect(result).not.toContain('<');
  });
});
