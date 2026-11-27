// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  compareArchivedSessions,
  formatArchivedTimestamp,
  matchesArchivedSearch,
  readArchivedSessionSort,
  resolveArchivedSessionTimestamp,
  toServerArchivedSortBy,
  writeArchivedSessionSort,
} from './archived-session-sort';

function makeSummary(
  overrides: Partial<DaemonSessionSummary> & { sessionId: string },
): DaemonSessionSummary {
  return {
    workspaceCwd: '/tmp/project',
    isArchived: true,
    ...overrides,
  };
}

describe('archived-session-sort', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists archived sort preferences per host independently', () => {
    expect(readArchivedSessionSort('http://localhost:7777')).toBe('updatedAt');
    writeArchivedSessionSort('http://localhost:7777', 'alphabetical');
    writeArchivedSessionSort('http://localhost:8888', 'createdAt');
    expect(readArchivedSessionSort('http://localhost:7777')).toBe(
      'alphabetical',
    );
    expect(readArchivedSessionSort('http://localhost:8888')).toBe('createdAt');

    localStorage.setItem(
      'web-shell:archived-session-sort:http://localhost:7777',
      'bogus',
    );
    expect(readArchivedSessionSort('http://localhost:7777')).toBe('updatedAt');
  });

  it('handles disabled localStorage gracefully', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readArchivedSessionSort('http://localhost:7777')).toBe('updatedAt');
    expect(() =>
      writeArchivedSessionSort('http://localhost:7777', 'createdAt'),
    ).not.toThrow();
  });

  it('maps client sort to server sortBy based on daemon capability', () => {
    expect(toServerArchivedSortBy('updatedAt', false)).toBeUndefined();
    expect(toServerArchivedSortBy('lastUserPromptAt', false)).toBeUndefined();
    expect(toServerArchivedSortBy('lastUserPromptAt', true)).toBe(
      'lastUserPromptAt',
    );
    expect(toServerArchivedSortBy('createdAt', true)).toBe('updatedAt');
    expect(toServerArchivedSortBy('alphabetical', true)).toBe('updatedAt');
  });

  it('resolves timestamps by sort kind with valid fallbacks', () => {
    const session = makeSummary({
      sessionId: 's1',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
      lastUserPromptAt: '2026-10-05T00:00:00Z',
    });
    expect(resolveArchivedSessionTimestamp(session, 'updatedAt')).toEqual({
      iso: '2026-10-10T00:00:00Z',
      kind: 'updatedAt',
    });
    expect(
      resolveArchivedSessionTimestamp(session, 'lastUserPromptAt'),
    ).toEqual({
      iso: '2026-10-05T00:00:00Z',
      kind: 'lastUserPromptAt',
    });
    expect(resolveArchivedSessionTimestamp(session, 'createdAt')).toEqual({
      iso: '2026-10-01T00:00:00Z',
      kind: 'createdAt',
    });
    expect(resolveArchivedSessionTimestamp(session, 'alphabetical')).toEqual({
      iso: '2026-10-10T00:00:00Z',
      kind: 'updatedAt',
    });

    const malformed = makeSummary({
      sessionId: 's2',
      lastUserPromptAt: 'not-a-date',
      updatedAt: 'also-invalid',
      createdAt: '2026-10-02T00:00:00Z',
    });
    expect(
      resolveArchivedSessionTimestamp(malformed, 'lastUserPromptAt'),
    ).toEqual({
      iso: '2026-10-02T00:00:00Z',
      kind: 'createdAt',
    });
    expect(
      resolveArchivedSessionTimestamp(
        makeSummary({ sessionId: 's3' }),
        'updatedAt',
      ),
    ).toBeUndefined();
  });

  it('formats valid timestamps and returns empty string for invalid ones', () => {
    expect(formatArchivedTimestamp('invalid', 'en')).toBe('');
    expect(formatArchivedTimestamp('', 'en')).toBe('');
    const formattedEn = formatArchivedTimestamp('2026-11-25T10:33:00Z', 'en');
    expect(formattedEn.length).toBeGreaterThan(0);
    expect(formattedEn).toContain('2026');
    const formattedZh = formatArchivedTimestamp(
      '2026-11-25T10:33:00Z',
      'zh-CN',
    );
    expect(formattedZh).toContain('2026');
  });

  it('sorts archived sessions across all four modes deterministically', () => {
    const a = makeSummary({
      sessionId: 'b-id',
      displayName: 'beta task',
      createdAt: '2026-10-03T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
      lastUserPromptAt: '2026-10-04T00:00:00Z',
    });
    const b = makeSummary({
      sessionId: 'a-id',
      displayName: 'Alpha task',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-09T00:00:00Z',
      lastUserPromptAt: '2026-10-08T00:00:00Z',
    });
    const untitled = makeSummary({
      sessionId: 'c-id',
      displayName: '',
      createdAt: undefined,
      updatedAt: '2026-10-07T00:00:00Z',
    });

    expect(
      [a, b, untitled]
        .sort((x, y) => compareArchivedSessions(x, y, 'updatedAt'))
        .map((s) => s.sessionId),
    ).toEqual(['b-id', 'a-id', 'c-id']);

    expect(
      [a, b, untitled]
        .sort((x, y) => compareArchivedSessions(x, y, 'lastUserPromptAt'))
        .map((s) => s.sessionId),
    ).toEqual(['a-id', 'b-id', 'c-id']);

    expect(
      [a, b, untitled]
        .sort((x, y) => compareArchivedSessions(x, y, 'createdAt'))
        .map((s) => s.sessionId),
    ).toEqual(['b-id', 'a-id', 'c-id']);

    expect(
      [a, b, untitled]
        .sort((x, y) => compareArchivedSessions(x, y, 'alphabetical'))
        .map((s) => s.sessionId),
    ).toEqual(['a-id', 'b-id', 'c-id']);
  });

  it('matches displayName, sessionId, and git metadata case-insensitively', () => {
    const session = makeSummary({
      sessionId: 'deadbeef-1111-4111-8111-111111111111',
      displayName: 'Fix sidebar filter',
      branch: { name: 'feat/archive-ui', baseBranch: 'main' },
      prs: [
        {
          number: 4242,
          url: 'https://github.com/QwenLM/qwen-code/pull/4242',
          issues: [
            {
              number: 17772,
              url: 'https://github.com/QwenLM/qwen-code/issues/17772',
            },
          ],
        },
      ],
    });
    expect(matchesArchivedSearch(session, '')).toBe(true);
    expect(matchesArchivedSearch(session, '   ')).toBe(true);
    expect(matchesArchivedSearch(session, 'SIDEBAR')).toBe(true);
    expect(matchesArchivedSearch(session, 'DEADBEEF')).toBe(true);
    expect(matchesArchivedSearch(session, 'archive-ui')).toBe(true);
    expect(matchesArchivedSearch(session, '#4242')).toBe(true);
    expect(matchesArchivedSearch(session, '17772')).toBe(true);
    expect(matchesArchivedSearch(session, 'nonexistent')).toBe(false);
  });
});
