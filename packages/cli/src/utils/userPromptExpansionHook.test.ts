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

  it('truncates additional context before appending to a single part', () => {
    const longContext = 'z'.repeat(10_005);

    const result = appendUserPromptExpansionAdditionalContext(
      { text: 'base prompt' },
      longContext,
    );

    expect(result).toEqual([
      { text: 'base prompt' },
      { text: `\n\n${'z'.repeat(10_000)}` },
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
