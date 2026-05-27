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
  it('sanitizes additionalContext', () => {
    const output = createHookOutput('UserPromptSubmit', {
      hookSpecificOutput: { additionalContext: '<xml>value</xml>' },
    });

    expect(output.getAdditionalContext()).toBe('&lt;xml&gt;value&lt;/xml&gt;');
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

  it('escapes ampersands and angle brackets before capping the result', () => {
    const output = new UserPromptExpansionHookOutput({
      hookSpecificOutput: {
        additionalContext: `a&b<${'x'.repeat(
          MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
        )}`,
      },
    });

    const result = output.getAdditionalContext();

    expect(result).toHaveLength(
      MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
    );
    expect(result?.startsWith('a&amp;b&lt;')).toBe(true);
    expect(result).not.toContain('<');
  });

  it('does not leave a partial entity after truncation', () => {
    const output = new UserPromptExpansionHookOutput({
      hookSpecificOutput: {
        additionalContext:
          'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 1) +
          '<',
      },
    });

    const result = output.getAdditionalContext();

    expect(result).toBe(
      'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 1),
    );
  });

  it('does not leave a partial ampersand entity after truncation', () => {
    const output = new UserPromptExpansionHookOutput({
      hookSpecificOutput: {
        additionalContext:
          'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 2) +
          '&',
      },
    });

    const result = output.getAdditionalContext();

    expect(result).toBe(
      'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 2),
    );
  });
});
