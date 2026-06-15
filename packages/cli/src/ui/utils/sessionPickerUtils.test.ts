/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { SessionListItem } from '@qwen-code/qwen-code-core';
import { filterSessions, truncateText } from './sessionPickerUtils.js';

function s(overrides: Partial<SessionListItem>): SessionListItem {
  return {
    sessionId: overrides.sessionId ?? 'id',
    cwd: '/cwd',
    startTime: '2025-01-01T00:00:00.000Z',
    mtime: 0,
    prompt: '',
    filePath: '/cwd/x.jsonl',
    messageCount: 1,
    ...overrides,
  };
}

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

  describe('filterSessions', () => {
    const sessions: SessionListItem[] = [
      s({ sessionId: 'a', prompt: 'fix login bug', gitBranch: 'main' }),
      s({ sessionId: 'b', customTitle: 'Add OAuth flow', gitBranch: 'feat' }),
      s({ sessionId: 'c', prompt: 'random work', gitBranch: 'hotfix/login' }),
      s({ sessionId: 'd', prompt: 'unrelated', gitBranch: 'main' }),
    ];

    it('passes everything through when no filter is set', () => {
      expect(filterSessions(sessions, false)).toEqual(sessions);
      expect(filterSessions(sessions, false, 'main', '')).toEqual(sessions);
    });

    it('matches the query against prompt, customTitle, and gitBranch', () => {
      const result = filterSessions(sessions, false, undefined, 'login');
      expect(result.map((x) => x.sessionId)).toEqual(['a', 'c']);
    });

    it('is case-insensitive and trims surrounding whitespace', () => {
      const result = filterSessions(sessions, false, undefined, '  OAUTH  ');
      expect(result.map((x) => x.sessionId)).toEqual(['b']);
    });

    it('composes branch filter and query as AND', () => {
      // Branch filter narrows to main; query then drops the unrelated row
      // even though 'unrelated' is on main.
      const result = filterSessions(sessions, true, 'main', 'login');
      expect(result.map((x) => x.sessionId)).toEqual(['a']);
    });

    it('returns empty when the query matches nothing', () => {
      expect(
        filterSessions(sessions, false, undefined, 'definitelynotpresent'),
      ).toEqual([]);
    });
  });
});
