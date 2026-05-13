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
