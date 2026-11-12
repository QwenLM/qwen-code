/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  anchorOrdinal,
  countAnchors,
  findAdjacentAnchor,
  isAnchorItem,
  isToolOutputItem,
  isTurnStart,
  type TranscriptNavItem,
} from './transcript-navigation.js';

const banner: TranscriptNavItem = { type: 'vp-banner' };
const prompt = (sentToModel?: boolean): TranscriptNavItem => ({
  type: 'user',
  ...(sentToModel === undefined ? {} : { sentToModel }),
});
const steer: TranscriptNavItem = { type: 'user', sentToModel: false };
const answer: TranscriptNavItem = { type: 'gemini' };
const tool: TranscriptNavItem = { type: 'tool_group' };

describe('isTurnStart', () => {
  it('accepts a prompt that was sent to the model', () => {
    expect(isTurnStart(prompt())).toBe(true);
    expect(isTurnStart(prompt(true))).toBe(true);
  });

  it('rejects steer items so they do not split a turn', () => {
    expect(isTurnStart(steer)).toBe(false);
  });

  it('rejects non-user rows, including the banner sentinel', () => {
    expect(isTurnStart(answer)).toBe(false);
    expect(isTurnStart(tool)).toBe(false);
    expect(isTurnStart(banner)).toBe(false);
  });
});

describe('isToolOutputItem', () => {
  it('accepts tool groups only', () => {
    expect(isToolOutputItem(tool)).toBe(true);
    expect(isToolOutputItem(answer)).toBe(false);
    expect(isToolOutputItem(banner)).toBe(false);
  });
});

describe('isAnchorItem', () => {
  it('routes the predicate by anchor kind', () => {
    expect(isAnchorItem(prompt(), 'turn')).toBe(true);
    expect(isAnchorItem(prompt(), 'tool')).toBe(false);
    expect(isAnchorItem(tool, 'tool')).toBe(true);
    expect(isAnchorItem(tool, 'turn')).toBe(false);
  });
});

// Layout: banner, turn A (prompt + tool + answer), steer, turn B (prompt +
// answer), turn C (prompt + tool + answer).
const items: readonly TranscriptNavItem[] = [
  banner, // 0
  prompt(), // 1
  tool, // 2
  answer, // 3
  steer, // 4
  prompt(), // 5
  answer, // 6
  prompt(), // 7
  tool, // 8
  answer, // 9
];

describe('findAdjacentAnchor', () => {
  it('finds the previous turn, skipping steer items and answers', () => {
    expect(findAdjacentAnchor(items, 7, 'previous', 'turn')).toBe(5);
    expect(findAdjacentAnchor(items, 6, 'previous', 'turn')).toBe(5);
    expect(findAdjacentAnchor(items, 5, 'previous', 'turn')).toBe(1);
  });

  it('finds the next turn, skipping steer items and answers', () => {
    expect(findAdjacentAnchor(items, 1, 'next', 'turn')).toBe(5);
    expect(findAdjacentAnchor(items, 4, 'next', 'turn')).toBe(5);
    expect(findAdjacentAnchor(items, 5, 'next', 'turn')).toBe(7);
  });

  it('never returns the anchor the search started on', () => {
    expect(findAdjacentAnchor(items, 1, 'next', 'turn')).not.toBe(1);
    expect(findAdjacentAnchor(items, 7, 'previous', 'turn')).not.toBe(7);
  });

  it('finds tool outputs independently of turns', () => {
    expect(findAdjacentAnchor(items, 9, 'previous', 'tool')).toBe(8);
    expect(findAdjacentAnchor(items, 8, 'previous', 'tool')).toBe(2);
    expect(findAdjacentAnchor(items, 2, 'next', 'tool')).toBe(8);
  });

  it('returns -1 when there is no anchor in that direction', () => {
    expect(findAdjacentAnchor(items, 1, 'previous', 'turn')).toBe(-1);
    expect(findAdjacentAnchor(items, 0, 'previous', 'turn')).toBe(-1);
    expect(findAdjacentAnchor(items, 7, 'next', 'turn')).toBe(-1);
    expect(findAdjacentAnchor(items, 8, 'next', 'tool')).toBe(-1);
    expect(findAdjacentAnchor(items, 2, 'previous', 'tool')).toBe(-1);
  });

  it('handles an empty transcript', () => {
    expect(findAdjacentAnchor([], 0, 'next', 'turn')).toBe(-1);
    expect(findAdjacentAnchor([], 0, 'previous', 'tool')).toBe(-1);
  });
});

describe('countAnchors', () => {
  it('counts turns and tool outputs separately', () => {
    expect(countAnchors(items, 'turn')).toBe(3);
    expect(countAnchors(items, 'tool')).toBe(2);
  });

  it('counts zero for a transcript with no anchors', () => {
    expect(countAnchors([banner, answer], 'turn')).toBe(0);
    expect(countAnchors([banner, answer], 'tool')).toBe(0);
  });
});

describe('anchorOrdinal', () => {
  it('reports the 1-based position of an anchor', () => {
    expect(anchorOrdinal(items, 1, 'turn')).toBe(1);
    expect(anchorOrdinal(items, 5, 'turn')).toBe(2);
    expect(anchorOrdinal(items, 7, 'turn')).toBe(3);
    expect(anchorOrdinal(items, 8, 'tool')).toBe(2);
  });

  it('reports 0 for rows that are not anchors', () => {
    expect(anchorOrdinal(items, 0, 'turn')).toBe(0);
    expect(anchorOrdinal(items, 4, 'turn')).toBe(0);
    expect(anchorOrdinal(items, 3, 'tool')).toBe(0);
  });

  it('reports 0 for out-of-range indexes', () => {
    expect(anchorOrdinal(items, -1, 'turn')).toBe(0);
    expect(anchorOrdinal(items, items.length, 'turn')).toBe(0);
  });
});
