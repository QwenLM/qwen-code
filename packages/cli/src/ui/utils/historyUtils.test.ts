/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { HistoryItem } from '../types.js';
import { ToolCallStatus } from '../types.js';
import {
  buildThoughtHeadIdMap,
  findLastUserItemIndex,
  isSyntheticHistoryItem,
  itemsAfterAreOnlySynthetic,
  realUserPromptTexts,
} from './historyUtils.js';

const mk = (
  overrides: Partial<HistoryItem> & { type: HistoryItem['type'] },
  id = 1,
): HistoryItem => ({ id, ...(overrides as object) }) as HistoryItem;

describe('isSyntheticHistoryItem', () => {
  it('treats info/error/warning/success/retry/vision_notice/notification/summary/thought as synthetic', () => {
    for (const type of [
      'info',
      'error',
      'warning',
      'success',
      'retry_countdown',
      'vision_notice',
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

  it('treats regular user items as meaningful', () => {
    expect(isSyntheticHistoryItem(mk({ type: 'user', text: 'hello' }))).toBe(
      false,
    );
    expect(
      isSyntheticHistoryItem(
        mk({ type: 'user', text: 'hi', sentToModel: true }),
      ),
    ).toBe(false);
  });

  it('treats steer items (sentToModel === false) as synthetic', () => {
    expect(
      isSyntheticHistoryItem(
        mk({ type: 'user', text: 'steer', sentToModel: false }),
      ),
    ).toBe(true);
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

  it('treats a trailing steer (sentToModel false) as synthetic, enabling full rewind', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'real prompt' }, 1),
      mk({ type: 'user', text: 'steer msg', sentToModel: false }, 2),
      mk({ type: 'info', text: 'Request cancelled.' }, 3),
    ];
    expect(itemsAfterAreOnlySynthetic(h, 0)).toBe(true);
  });
});

describe('buildThoughtHeadIdMap', () => {
  it('returns empty map when no gemini_thought items exist', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'hi' }, 1),
      mk({ type: 'gemini_content', text: 'hello' }, 2),
    ];
    expect(buildThoughtHeadIdMap(h).size).toBe(0);
  });

  it('maps a lone thought head to its own id', () => {
    const thought = mk({ type: 'gemini_thought', text: 'thinking...' }, 1);
    const h: HistoryItem[] = [
      thought,
      mk({ type: 'gemini_content', text: 'answer' }, 2),
    ];
    const map = buildThoughtHeadIdMap(h);
    expect(map.get(thought)).toBe(1);
    expect(map.size).toBe(1);
  });

  it('maps consecutive continuations to the preceding head id', () => {
    const head = mk({ type: 'gemini_thought', text: 'header' }, 1);
    const c1 = mk({ type: 'gemini_thought_content', text: 'part1' }, 2);
    const c2 = mk({ type: 'gemini_thought_content', text: 'part2' }, 3);
    const h: HistoryItem[] = [
      head,
      c1,
      c2,
      mk({ type: 'gemini_content', text: 'answer' }, 4),
    ];
    const map = buildThoughtHeadIdMap(h);
    expect(map.get(head)).toBe(1);
    expect(map.get(c1)).toBe(1);
    expect(map.get(c2)).toBe(1);
  });

  it('stops grouping at the first non-continuation item', () => {
    const head1 = mk({ type: 'gemini_thought', text: 't1' }, 1);
    const c1 = mk({ type: 'gemini_thought_content', text: 'c1' }, 2);
    const head2 = mk({ type: 'gemini_thought', text: 't2' }, 4);
    const c2 = mk({ type: 'gemini_thought_content', text: 'c2' }, 5);
    const h: HistoryItem[] = [
      head1,
      c1,
      mk({ type: 'gemini_content', text: 'answer' }, 3),
      head2,
      c2,
    ];
    const map = buildThoughtHeadIdMap(h);
    expect(map.get(head1)).toBe(1);
    expect(map.get(c1)).toBe(1);
    expect(map.get(head2)).toBe(4);
    expect(map.get(c2)).toBe(4);
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

  it('skips user items with sentToModel false', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'real' }, 1),
      mk({ type: 'user', text: 'steer', sentToModel: false }, 2),
    ];
    expect(findLastUserItemIndex(h)).toBe(0);
  });
});

describe('realUserPromptTexts', () => {
  it('returns texts of real user prompts oldest-first', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'first' }, 1),
      mk({ type: 'gemini_content', text: 'reply' }, 2),
      mk({ type: 'user', text: 'second' }, 3),
    ];
    expect(realUserPromptTexts(h)).toEqual(['first', 'second']);
  });

  it('excludes steer messages with sentToModel false', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: 'real' }, 1),
      mk({ type: 'user', text: 'steer', sentToModel: false }, 2),
    ];
    expect(realUserPromptTexts(h)).toEqual(['real']);
  });

  it('excludes empty and whitespace-only prompts', () => {
    const h: HistoryItem[] = [
      mk({ type: 'user', text: '' }, 1),
      mk({ type: 'user', text: '   ' }, 2),
      mk({ type: 'user', text: 'valid' }, 3),
    ];
    expect(realUserPromptTexts(h)).toEqual(['valid']);
  });
});
