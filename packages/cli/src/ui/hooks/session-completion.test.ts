/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';

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

import { getSessionSuggestions } from './session-completion.js';

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

  it('strips the session: prefix before filtering', async () => {
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
    const out = await getSessionSuggestions('/proj', 'session:auth');
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('session:id-1');
  });

  it('returns [] when listSessions throws (I/O failure)', async () => {
    mockListSessions.mockRejectedValue(new Error('disk gone'));
    const out = await getSessionSuggestions('/proj', '');
    expect(out).toEqual([]);
  });
});
