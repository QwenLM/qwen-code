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
  isOnlyLeadingSystemReminders,
  isSyntheticHistoryItem,
  itemsAfterAreOnlySynthetic,
  omitSystemReminderBlocks,
  prependMissingSystemReminders,
  realUserPromptTexts,
  splitLeadingSystemReminders,
  stripLeadingSystemReminders,
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

  it('treats v2 goal lifecycle cards as meaningful history', () => {
    expect(
      isSyntheticHistoryItem(
        mk({
          type: 'goal_state',
          snapshot: {
            v: 2,
            activity: 'idle',
            goal: null,
          },
        }),
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
describe('stripLeadingSystemReminders', () => {
  it('strips a single leading envelope', () => {
    expect(
      stripLeadingSystemReminders(
        '<system-reminder>\nnote\n</system-reminder>\n\nmy prompt',
      ),
    ).toBe('my prompt');
  });

  it('strips stacked envelopes', () => {
    expect(
      stripLeadingSystemReminders(
        '<system-reminder>one</system-reminder>\n\n' +
          '<system-reminder>two</system-reminder>\n\nreview this',
      ),
    ).toBe('review this');
  });

  it('returns an envelope-only message unchanged rather than empty', () => {
    const only = '<system-reminder>\nnote\n</system-reminder>';
    expect(stripLeadingSystemReminders(only)).toBe(only);
    const stacked =
      '<system-reminder>one</system-reminder>\n\n<system-reminder>two</system-reminder>';
    expect(stripLeadingSystemReminders(stacked)).toBe(stacked);
  });

  it('keeps a mid-message envelope the user pasted', () => {
    const pasted = 'review <system-reminder>pasted</system-reminder> this';
    expect(stripLeadingSystemReminders(pasted)).toBe(pasted);
  });

  it('keeps an unterminated envelope', () => {
    const unterminated = '<system-reminder>never closed\nreview this';
    expect(stripLeadingSystemReminders(unterminated)).toBe(unterminated);
  });

  it('returns the empty string unchanged', () => {
    expect(stripLeadingSystemReminders('')).toBe('');
  });

  it('splits the exact reminder prefix from the display rest', () => {
    const text =
      '<system-reminder>\na\n</system-reminder>\n\n' +
      '<system-reminder>\nb\n</system-reminder>\n\nreview this';
    expect(splitLeadingSystemReminders(text)).toEqual({
      reminders:
        '<system-reminder>\na\n</system-reminder>\n\n' +
        '<system-reminder>\nb\n</system-reminder>\n\n',
      rest: 'review this',
    });
  });

  it('splits no prefix for plain or envelope-only text', () => {
    expect(splitLeadingSystemReminders('review this')).toEqual({
      reminders: '',
      rest: 'review this',
    });
    const only = '<system-reminder>\nnote\n</system-reminder>';
    expect(splitLeadingSystemReminders(only)).toEqual({
      reminders: '',
      rest: only,
    });
  });
});

describe('isOnlyLeadingSystemReminders', () => {
  it('accepts a single envelope prefix with trailing separator', () => {
    expect(
      isOnlyLeadingSystemReminders(
        '<system-reminder>\nnote\n</system-reminder>\n\n',
      ),
    ).toBe(true);
  });

  it('accepts stacked envelopes', () => {
    expect(
      isOnlyLeadingSystemReminders(
        '<system-reminder>one</system-reminder>\n\n' +
          '<system-reminder>two</system-reminder>\n\n',
      ),
    ).toBe(true);
  });

  it('rejects a prefix that mixes envelopes with display content', () => {
    expect(
      isOnlyLeadingSystemReminders(
        '<system-reminder>\nnote\n</system-reminder>\n\n@src/foo.ts\n\n',
      ),
    ).toBe(false);
  });

  it('rejects plain text, empty input, and unterminated envelopes', () => {
    expect(isOnlyLeadingSystemReminders('review this')).toBe(false);
    expect(isOnlyLeadingSystemReminders('')).toBe(false);
    expect(
      isOnlyLeadingSystemReminders('<system-reminder>never closed\n'),
    ).toBe(false);
  });
});

describe('prependMissingSystemReminders', () => {
  it('prepends an armed envelope that is not already present', () => {
    const envelope = '<system-reminder>\nnotice\n</system-reminder>';
    expect(
      prependMissingSystemReminders(`${envelope}\n\n`, 'review this'),
    ).toBe(`${envelope}\n\nreview this`);
  });

  it('drops an armed copy the injector already re-fired', () => {
    const envelope = '<system-reminder>\nsteering\n</system-reminder>';
    const text = `${envelope}\n\nrun the workflow`;
    expect(prependMissingSystemReminders(`${envelope}\n\n`, text)).toBe(text);
  });

  it('re-arms only the blocks that did not re-fire', () => {
    const first = '<system-reminder>\nrecovered\n</system-reminder>';
    const second = '<system-reminder>\nsteering\n</system-reminder>';
    const text = `${second}\n\nrun the workflow`;
    expect(
      prependMissingSystemReminders(`${first}\n\n${second}\n\n`, text),
    ).toBe(`${first}\n\n${text}`);
  });

  it('returns the text unchanged for an empty envelope run', () => {
    expect(prependMissingSystemReminders('', 'review this')).toBe(
      'review this',
    );
  });
});

describe('omitSystemReminderBlocks', () => {
  it('removes a mid-string envelope block listed by the producer', () => {
    const envelope = '<system-reminder>\nnotice\n</system-reminder>';
    expect(
      omitSystemReminderBlocks(
        `first\n\n${envelope}\n\nsecond`,
        `${envelope}\n\n`,
      ),
    ).toBe('first\n\nsecond');
  });

  it('removes each listed block once and leaves user-authored twins in place', () => {
    const envelope = '<system-reminder>\nnotice\n</system-reminder>';
    const text = `${envelope}\n\nfirst\n\n${envelope}\n\nsecond`;
    // The producer lists only the leading (injected) block; the identical
    // block the user pasted mid-message is content and stays.
    expect(omitSystemReminderBlocks(text, `${envelope}\n\n`)).toBe(
      `first\n\n${envelope}\n\nsecond`,
    );
  });

  it('returns the text unchanged for an empty reminder list', () => {
    const text = '<system-reminder>\nnotice\n</system-reminder>\n\nkept';
    expect(omitSystemReminderBlocks(text, '')).toBe(text);
  });

  it('matches the leading-only split when the listed block leads the text', () => {
    const envelope = '<system-reminder>\nnotice\n</system-reminder>';
    const text = `${envelope}\n\nmy prompt`;
    expect(omitSystemReminderBlocks(text, `${envelope}\n\n`)).toBe('my prompt');
  });

  it("removes only the producer separator, keeping the next line's indentation", () => {
    // A queue member's projection is the trimmed typed text, so the
    // producer's envelope run ends with the whitespace up to it —
    // including the user's own leading indentation. Removing a greedy
    // whitespace run with the block would eat that indentation.
    const envelope = '<system-reminder>\nnotice\n</system-reminder>';
    expect(
      omitSystemReminderBlocks(
        `${envelope}\n\n  indented prompt`,
        `${envelope}\n\n  `,
      ),
    ).toBe('  indented prompt');
    expect(
      omitSystemReminderBlocks(
        `first\n\n${envelope}\n\n  indented second`,
        `${envelope}\n\n  `,
      ),
    ).toBe('first\n\n  indented second');
  });
});
