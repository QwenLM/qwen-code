/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { HistoryItem, IndividualToolCallDisplay } from '../types.js';
import { ToolCallStatus } from '../types.js';
import { buildVirtualItems } from './virtual-items.js';
import {
  getSearchableText,
  MAX_TRANSCRIPT_SEARCH_MATCHES,
  searchTranscriptItems,
} from './transcript-search.js';

const user = (id: number, text: string): HistoryItem => ({
  id,
  type: 'user',
  text,
});

const gemini = (id: number, text: string): HistoryItem => ({
  id,
  type: 'gemini',
  text,
});

const toolGroup = (
  id: number,
  overrides: Partial<IndividualToolCallDisplay> = {},
): HistoryItem => ({
  id,
  type: 'tool_group',
  tools: [
    {
      callId: `call-${id}`,
      name: 'run_shell_command',
      description: 'ls -la',
      status: ToolCallStatus.Success,
      confirmationDetails: undefined,
      resultDisplay: undefined,
      ...overrides,
    },
  ],
});

describe('searchTranscriptItems', () => {
  it('returns nothing for a blank query', () => {
    const items = buildVirtualItems([user(1, 'hello')], []);
    expect(searchTranscriptItems(items, '')).toEqual({
      matches: [],
      truncated: false,
    });
    expect(searchTranscriptItems(items, '   ').matches).toHaveLength(0);
  });

  it('matches case-insensitively and reports the viewport index (banner included)', () => {
    const items = buildVirtualItems(
      [user(1, 'Fix the PORT clash'), gemini(2, 'nothing here')],
      [],
    );
    const { matches, truncated } = searchTranscriptItems(items, 'port');
    expect(truncated).toBe(false);
    expect(matches).toHaveLength(1);
    // Index 0 is the banner sentinel, so the prompt lives at index 1.
    expect(matches[0].index).toBe(1);
    expect(matches[0].itemType).toBe('user');
    expect(matches[0].snippet.toLowerCase()).toContain('port');
  });

  it('skips the banner sentinel and items without text', () => {
    const items = buildVirtualItems([gemini(3, '')], []);
    expect(searchTranscriptItems(items, 'banner').matches).toHaveLength(0);
    expect(searchTranscriptItems(items, 'gemini').matches).toHaveLength(0);
  });

  it('searches tool output held in a structured resultDisplay', () => {
    const items = buildVirtualItems(
      [
        toolGroup(1, {
          resultDisplay: {
            file_path: '/tmp/app.log',
            content: 'bind: EADDRINUSE',
          } as unknown as IndividualToolCallDisplay['resultDisplay'],
        }),
      ],
      [],
    );
    const { matches } = searchTranscriptItems(items, 'eaddrinuse');
    expect(matches).toHaveLength(1);
    expect(matches[0].index).toBe(1);
    expect(matches[0].itemType).toBe('tool_group');
  });

  it('searches raw tool arguments, not only the human description', () => {
    const items = buildVirtualItems(
      [
        toolGroup(1, {
          args: { command: 'curl http://localhost:4783/health' },
        }),
      ],
      [],
    );
    expect(searchTranscriptItems(items, '4783').matches).toHaveLength(1);
  });

  it('searches the Ctrl+O detailed text whose summary is only a count', () => {
    const items = buildVirtualItems(
      [
        toolGroup(1, {
          resultDisplay: 'Read 200 lines',
          detailedDisplay: 'line 1\nconst API_TIMEOUT = 3000;',
        }),
      ],
      [],
    );
    expect(searchTranscriptItems(items, 'api_timeout').matches).toHaveLength(1);
  });

  it('searches pending items too, after the committed history', () => {
    const items = buildVirtualItems(
      [user(1, 'older prompt')],
      [{ type: 'gemini', text: 'live answer mentioning zebra' }],
    );
    const { matches } = searchTranscriptItems(items, 'zebra');
    expect(matches).toHaveLength(1);
    expect(matches[0].index).toBe(2);
  });

  it('emits one match per item, in transcript order', () => {
    const items = buildVirtualItems(
      [user(1, 'alpha alpha alpha'), user(2, 'alpha beta')],
      [],
    );
    const { matches } = searchTranscriptItems(items, 'alpha');
    expect(matches.map((match) => match.index)).toEqual([1, 2]);
  });

  it('caps the result set to the NEWEST matches, in ascending order', () => {
    const items = buildVirtualItems(
      [user(1, 'alpha'), user(2, 'alpha'), user(3, 'alpha')],
      [],
    );
    const { matches, truncated } = searchTranscriptItems(items, 'alpha', 2);
    // Forward-limiting would keep 1 and 2 and make the newest hit unreachable.
    expect(matches.map((match) => match.index)).toEqual([2, 3]);
    expect(truncated).toBe(true);
  });

  it('keeps the newest occurrence reachable across the 500-match boundary', () => {
    const history = Array.from({ length: 501 }, (_, i) => user(i + 1, 'alpha'));
    const items = buildVirtualItems(history, []);
    const { matches, truncated } = searchTranscriptItems(items, 'alpha');
    expect(truncated).toBe(true);
    expect(matches).toHaveLength(MAX_TRANSCRIPT_SEARCH_MATCHES);
    expect(matches[matches.length - 1].index).toBe(501);
    expect(matches[0].index).toBe(2);
    const indexes = matches.map((match) => match.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('produces single-line snippets with ellipses around long matches', () => {
    const items = buildVirtualItems(
      [gemini(1, `${'x'.repeat(200)}\nneedle\n${'y'.repeat(200)}`)],
      [],
    );
    const { matches } = searchTranscriptItems(items, 'needle');
    expect(matches[0].snippet).not.toContain('\n');
    expect(matches[0].snippet).toContain('needle');
    expect(matches[0].snippet.startsWith('…')).toBe(true);
    expect(matches[0].snippet.endsWith('…')).toBe(true);
  });

  it('caches flattened text per committed item', () => {
    const historyItem = user(1, 'cache me');
    expect(getSearchableText(historyItem)).toBe('cache me');
    // The cache is keyed by object identity: the same reference must not be
    // recomputed, and mutating nothing else can change the result.
    expect(getSearchableText(historyItem)).toBe('cache me');
  });
});
