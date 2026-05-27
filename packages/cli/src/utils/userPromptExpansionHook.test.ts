/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  appendUserPromptExpansionAdditionalContext,
  formatUserPromptExpansionBlockedMessage,
  serializeUserPromptExpansionPrompt,
} from './userPromptExpansionHook.js';

describe('appendUserPromptExpansionAdditionalContext', () => {
  it('returns content unchanged when additionalContext is undefined', () => {
    expect(
      appendUserPromptExpansionAdditionalContext('base prompt', undefined),
    ).toBe('base prompt');
  });

  it('appends additional context to string prompts', () => {
    const result = appendUserPromptExpansionAdditionalContext(
      'base prompt',
      'hook context',
    );

    expect(result).toBe('base prompt\n\nhook context');
  });

  it('appends additional context to part arrays', () => {
    const result = appendUserPromptExpansionAdditionalContext(
      [{ text: 'base prompt' }],
      'hook context',
    );

    expect(result).toEqual([
      { text: 'base prompt' },
      { text: '\n\nhook context' },
    ]);
  });

  it('appends additional context to a single part', () => {
    const result = appendUserPromptExpansionAdditionalContext(
      { text: 'base prompt' },
      'hook context',
    );

    expect(result).toEqual([
      { text: 'base prompt' },
      { text: '\n\nhook context' },
    ]);
  });
});

describe('formatUserPromptExpansionBlockedMessage', () => {
  it('escapes ampersands before angle brackets', () => {
    const result = formatUserPromptExpansionBlockedMessage('a&b<c>');

    expect(result).toBe('UserPromptExpansion blocked: a&amp;b&lt;c&gt;');
  });

  it('sanitizes and truncates block reasons', () => {
    const longReason = `<policy>${'x'.repeat(10_000)}</policy>`;

    const result = formatUserPromptExpansionBlockedMessage(longReason);

    expect(result).toBe(
      `UserPromptExpansion blocked: &lt;policy&gt;${'x'.repeat(9_986)}`,
    );
    expect(result.length).toBe('UserPromptExpansion blocked: '.length + 10_000);
  });

  it('does not leave a partial entity after truncation', () => {
    const result = formatUserPromptExpansionBlockedMessage(
      'x'.repeat(9_999) + '<',
    );

    expect(result).toBe(`UserPromptExpansion blocked: ${'x'.repeat(9_999)}`);
  });

  it('does not leave a partial ampersand entity after truncation', () => {
    const result = formatUserPromptExpansionBlockedMessage(
      'x'.repeat(9_998) + '&',
    );

    expect(result).toBe(`UserPromptExpansion blocked: ${'x'.repeat(9_998)}`);
  });
});

describe('serializeUserPromptExpansionPrompt', () => {
  it('returns string prompts unchanged', () => {
    expect(serializeUserPromptExpansionPrompt('plain prompt')).toBe(
      'plain prompt',
    );
  });

  it('serializes part arrays with verbose formatting', () => {
    expect(
      serializeUserPromptExpansionPrompt([
        { text: 'first' },
        { inlineData: { mimeType: 'text/plain', data: 'ZGF0YQ==' } },
        { text: 'last' },
      ]),
    ).toBe('first<text/plain>last');
  });

  it('serializes a single part object', () => {
    expect(serializeUserPromptExpansionPrompt({ text: 'single part' })).toBe(
      'single part',
    );
  });

  it('serializes empty part arrays to an empty string', () => {
    expect(serializeUserPromptExpansionPrompt([])).toBe('');
  });
});
