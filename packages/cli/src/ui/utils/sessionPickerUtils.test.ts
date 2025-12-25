/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { truncateText } from './sessionPickerUtils.js';

describe('sessionPickerUtils', () => {
  describe('truncateText', () => {
    it('returns the original text when it fits and has no newline', () => {
      expect(truncateText('hello', 10)).toBe('hello');
    });

    it('truncates long text with ellipsis', () => {
      expect(truncateText('hello world', 5)).toBe('he...');
    });

    it('truncates without ellipsis when maxWidth <= 3', () => {
      expect(truncateText('hello', 3)).toBe('hel');
      expect(truncateText('hello', 2)).toBe('he');
    });

    it('breaks at newline and returns only the first line', () => {
      expect(truncateText('hello\nworld', 20)).toBe('hello');
      expect(truncateText('hello\r\nworld', 20)).toBe('hello');
    });

    it('breaks at newline and still truncates the first line when needed', () => {
      expect(truncateText('hello\nworld', 2)).toBe('he');
      expect(truncateText('hello\nworld', 3)).toBe('hel');
      expect(truncateText('hello\nworld', 4)).toBe('h...');
    });

    it('does not add ellipsis when the string ends at a newline', () => {
      expect(truncateText('hello\n', 20)).toBe('hello');
      expect(truncateText('hello\r\n', 20)).toBe('hello');
    });

    it('returns only the first line even if there are multiple line breaks', () => {
      expect(truncateText('hello\n\nworld', 20)).toBe('hello');
    });
  });
});
