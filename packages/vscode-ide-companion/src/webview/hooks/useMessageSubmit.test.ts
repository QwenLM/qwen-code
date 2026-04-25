/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ZERO_WIDTH_SPACE, stripZeroWidthSpaces } from '@qwen-code/webui';
import { shouldSendMessage } from './useMessageSubmit.js';

describe('ZERO_WIDTH_SPACE and stripZeroWidthSpaces', () => {
  it('ZERO_WIDTH_SPACE is U+200B', () => {
    expect(ZERO_WIDTH_SPACE).toBe('\u200B');
    expect(ZERO_WIDTH_SPACE.length).toBe(1);
  });

  it('strips a single leading zero-width space', () => {
    expect(stripZeroWidthSpaces('\u200B')).toBe('');
  });

  it('strips zero-width space before real text', () => {
    expect(stripZeroWidthSpaces('\u200B/help')).toBe('/help');
  });

  it('strips multiple zero-width spaces', () => {
    expect(stripZeroWidthSpaces('\u200Bhello\u200B world\u200B')).toBe(
      'hello world',
    );
  });

  it('returns unchanged text when no zero-width spaces present', () => {
    expect(stripZeroWidthSpaces('hello world')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(stripZeroWidthSpaces('')).toBe('');
  });

  it('preserves other whitespace characters', () => {
    expect(stripZeroWidthSpaces('\u200B \t\n')).toBe(' \t\n');
  });
});

describe('shouldSendMessage', () => {
  const defaults = {
    isStreaming: false,
    isWaitingForResponse: false,
  };

  it('returns false when streaming', () => {
    expect(
      shouldSendMessage({ ...defaults, inputText: 'hello', isStreaming: true }),
    ).toBe(false);
  });

  it('returns false when waiting for response', () => {
    expect(
      shouldSendMessage({
        ...defaults,
        inputText: 'hello',
        isWaitingForResponse: true,
      }),
    ).toBe(false);
  });

  it('returns true for non-empty text', () => {
    expect(shouldSendMessage({ ...defaults, inputText: 'hello' })).toBe(true);
  });

  it('returns false for empty text', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '' })).toBe(false);
  });

  it('returns false for whitespace-only text', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '   ' })).toBe(false);
  });

  it('returns false when input is only a zero-width space placeholder', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '\u200B' })).toBe(false);
  });

  it('returns false when input is zero-width space plus whitespace', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '\u200B   ' })).toBe(
      false,
    );
  });

  it('returns true when input has real text after zero-width space', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '\u200Bhello' })).toBe(
      true,
    );
  });

  it('returns true when input has only attachments and no text', () => {
    expect(
      shouldSendMessage({
        ...defaults,
        inputText: '',
        attachedImages: [
          {
            id: '1',
            name: 'test.png',
            type: 'image/png',
            size: 100,
            data: 'base64data',
            timestamp: Date.now(),
          },
        ],
      }),
    ).toBe(true);
  });

  it('returns true when input has only attachments and zero-width space', () => {
    expect(
      shouldSendMessage({
        ...defaults,
        inputText: '\u200B',
        attachedImages: [
          {
            id: '1',
            name: 'test.png',
            type: 'image/png',
            size: 100,
            data: 'base64data',
            timestamp: Date.now(),
          },
        ],
      }),
    ).toBe(true);
  });
});
