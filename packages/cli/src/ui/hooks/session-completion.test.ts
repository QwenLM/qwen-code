/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListSessions = vi.fn();

vi.mock('@qwen-code/qwen-code-core', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    SessionService: class {
      listSessions = mockListSessions;
    },
  };
});

import {
  getSessionSuggestions,
  __resetSessionSuggestionCacheForTest,
} from './session-completion.js';

beforeEach(() => {
  mockListSessions.mockReset();
  __resetSessionSuggestionCacheForTest();
});

describe('getSessionSuggestions', () => {
  it('maps sessions to category:session suggestions with @session: values', async () => {
    mockListSessions.mockResolvedValue({
      items: [
        {
          sessionId: 'id-1',
          customTitle: 'Fix auth bug',
          prompt: 'fix auth',
          mtime: 2,
        },
        {
          sessionId: 'id-2',
          customTitle: undefined,
          prompt: 'add tests',
          mtime: 1,
        },
      ],
      hasMore: false,
    });
    const out = await getSessionSuggestions('/proj', '');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      label: 'Fix auth bug',
      value: 'session:id-1',
      category: 'session',
    });
    // falls back to first prompt when no custom title
    expect(out[1].label).toBe('add tests');
  });

  it('filters by pattern against title and prompt', async () => {
    mockListSessions.mockResolvedValue({
      items: [
        {
          sessionId: 'id-1',
          customTitle: 'Fix auth bug',
          prompt: 'fix auth',
          mtime: 2,
        },
        {
          sessionId: 'id-2',
          customTitle: undefined,
          prompt: 'add tests',
          mtime: 1,
        },
      ],
      hasMore: false,
    });
    const out = await getSessionSuggestions('/proj', 'auth');
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('session:id-1');
  });

  it('returns [] when listSessions throws (I/O failure)', async () => {
    mockListSessions.mockRejectedValue(new Error('disk gone'));
    const out = await getSessionSuggestions('/proj', '');
    expect(out).toEqual([]);
  });

  it('caches the listing within the TTL (no re-list on pattern change)', async () => {
    mockListSessions.mockResolvedValue({
      items: [
        {
          sessionId: 'id-1',
          customTitle: 'Fix auth bug',
          prompt: 'fix auth',
          mtime: 2,
        },
        {
          sessionId: 'id-2',
          customTitle: undefined,
          prompt: 'add tests',
          mtime: 1,
        },
      ],
      hasMore: false,
    });
    // Three keystrokes within the TTL window; filtering still applies each time.
    const a = await getSessionSuggestions('/proj', '', 1000);
    const b = await getSessionSuggestions('/proj', 'auth', 1500);
    const c = await getSessionSuggestions('/proj', 'tests', 2000);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(b[0].value).toBe('session:id-1');
    expect(c).toHaveLength(1);
    expect(c[0].value).toBe('session:id-2');
    // Listed from disk only ONCE despite three calls.
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });

  it('re-lists after the TTL expires', async () => {
    mockListSessions.mockResolvedValue({ items: [], hasMore: false });
    await getSessionSuggestions('/proj', '', 1000);
    await getSessionSuggestions('/proj', '', 1000 + 10_000); // well past TTL
    expect(mockListSessions).toHaveBeenCalledTimes(2);
  });

  it('caches per cwd (different project re-lists)', async () => {
    mockListSessions.mockResolvedValue({ items: [], hasMore: false });
    await getSessionSuggestions('/proj-a', '', 1000);
    await getSessionSuggestions('/proj-b', '', 1000);
    expect(mockListSessions).toHaveBeenCalledTimes(2);
  });
});
