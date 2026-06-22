/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { HistoryItem } from '../types.js';
import { ToolCallStatus } from '../types.js';
import {
  findLastUserItemIndex,
  getLatestToolUseSummary,
  isSyntheticHistoryItem,
  itemsAfterAreOnlySynthetic,
} from './historyUtils.js';

const mk = (
  overrides: Partial<HistoryItem> & { type: HistoryItem['type'] },
  id = 1,
): HistoryItem => ({ id, ...(overrides as object) }) as HistoryItem;

describe('isSyntheticHistoryItem', () => {
  it('treats info/error/warning/success/retry/notification/summary/thought as synthetic', () => {
    for (const type of [
      'info',
      'error',
      'warning',
      'success',
      'retry_countdown',
      'notification',
      'tool_use_summary',
      'gemini_thought',
      'gemini_thought_content',
    ] as const) {
      expect(isSyntheticHistoryItem(mk({ type, text: 'x' } as never))).toBe(
        true,
      );
    }
  });

  it('treats assistant text and tool runs as meaningful', () => {
    expect(isSyntheticHistoryItem(mk({ type: 'gemini', text: 'hi' }))).toBe(
      false,
    );
    expect(
      isSyntheticHistoryItem(mk({ type: 'gemini_content', text: 'hi' })),
    ).toBe(false);
    expect(
      isSyntheticHistoryItem(
        mk({
          type: 'tool_group',
          tools: [
            {
              callId: 'a',
              name: 'X',
              description: '',
              status: ToolCallStatus.Executing,
              resultDisplay: undefined,
              confirmationDetails: undefined,
            },
          ],
        } as never),
      ),
    ).toBe(false);
  });
});

describe('itemsAfterAreOnlySynthetic', () => {
  it('returns true on an empty trailing slice', () => {
    const h: HistoryItem[] = [mk({ type: 'user', text: 'foo' })];
    expect(itemsAfterAreOnlySynthetic(h, 0)).toBe(true);
  });

  it('returns true when only INFO follows the user message', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'foo' }, 1),
      mk({ type: 'info', text: 'Request cancelled.' }, 2),
    ];
    expect(itemsAfterAreOnlySynthetic(h, 0)).toBe(true);
  });

  it('returns false when assistant content followed', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'foo' }, 1),
      mk({ type: 'gemini_content', text: 'hello' }, 2),
      mk({ type: 'info', text: 'Request cancelled.' }, 3),
    ];
    expect(itemsAfterAreOnlySynthetic(h, 0)).toBe(false);
  });

  it('treats gemini_thought / gemini_thought_content trailing items as synthetic (matches claude-code)', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'foo' }, 1),
      mk({ type: 'gemini_thought', text: '...' }, 2),
      mk({ type: 'gemini_thought_content', text: 'thinking...' }, 3),
      mk({ type: 'info', text: 'Request cancelled.' }, 4),
    ];
    expect(itemsAfterAreOnlySynthetic(h, 0)).toBe(true);
  });

  it('returns false when a tool ran', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'foo' }, 1),
      mk(
        {
          type: 'tool_group',
          tools: [
            {
              callId: 'a',
              name: 'X',
              description: '',
              status: ToolCallStatus.Success,
              resultDisplay: undefined,
              confirmationDetails: undefined,
            },
          ],
        } as never,
        2,
      ),
    ];
    expect(itemsAfterAreOnlySynthetic(h, 0)).toBe(false);
  });
});

describe('findLastUserItemIndex', () => {
  it('returns -1 when no user item exists', () => {
    expect(
      findLastUserItemIndex([mk({ type: 'info', text: 'x' })] as HistoryItem[]),
    ).toBe(-1);
  });

  it('returns the latest user item index', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'first' }, 1),
      mk({ type: 'gemini_content', text: 'reply' }, 2),
      mk({ type: 'user', text: 'second' }, 3),
      mk({ type: 'info', text: 'Request cancelled.' }, 4),
    ];
    expect(findLastUserItemIndex(h)).toBe(2);
  });
});

describe('getLatestToolUseSummary', () => {
  const summary = (text: string, id: number): HistoryItem =>
    mk({ type: 'tool_use_summary', summary: text } as never, id);

  it('returns the summary when it is the last item', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'fix the bug' }, 1),
      mk({ type: 'tool_group', tools: [] } as never, 2),
      summary('Fixed NPE in UserService', 3),
    ];
    expect(getLatestToolUseSummary(h)).toBe('Fixed NPE in UserService');
  });

  it('returns the latest summary when multiple exist in one turn', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'refactor' }, 1),
      summary('Searched in auth/', 2),
      mk({ type: 'gemini_content', text: '...' }, 3),
      summary('Fixed NPE in UserService', 4),
    ];
    expect(getLatestToolUseSummary(h)).toBe('Fixed NPE in UserService');
  });

  it('returns undefined when a user message follows (new turn)', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'first' }, 1),
      summary('Searched in auth/', 2),
      mk({ type: 'user', text: 'second' }, 3),
      mk({ type: 'gemini_content', text: 'streaming...' }, 4),
    ];
    expect(getLatestToolUseSummary(h)).toBeUndefined();
  });

  it('returns undefined when no summary exists', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'hello' }, 1),
      mk({ type: 'gemini_content', text: 'hi' }, 2),
    ];
    expect(getLatestToolUseSummary(h)).toBeUndefined();
  });

  it('returns undefined on empty history', () => {
    expect(getLatestToolUseSummary([])).toBeUndefined();
  });
});
