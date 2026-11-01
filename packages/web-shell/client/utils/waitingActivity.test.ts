/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildWaitingActivity,
  buildWaitingTokenUsage,
  WAITING_ACTIVITY_CELLS,
} from './waitingActivity';

// Wednesday, November 4, 2026 (local time), so the current week has future days.
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime();
const at = (month: number, day: number, hour = 10, year = 2026): number =>
  new Date(year, month, day, hour).getTime();
const startOfDay = (value: number): number => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

describe('waiting activity calendar', () => {
  it('returns a fixed 44-week calendar with empty days', () => {
    const cells = buildWaitingActivity([], { now: NOW });
    expect(cells).toHaveLength(WAITING_ACTIVITY_CELLS);
    expect(cells.every((cell) => cell.count === 0)).toBe(true);
    expect(cells.every((cell) => cell.future || cell.startAt > 0)).toBe(true);
    expect(cells.filter((cell) => cell.future)).toHaveLength(4);
    expect(new Date(cells[0]!.startAt).getHours()).toBe(0);
    expect(cells[0]!.endAt).toBe(cells[1]!.startAt);
  });

  it('groups messages into fixed local days and anchors the first user', () => {
    const cells = buildWaitingActivity(
      [
        { id: 'assistant-old', role: 'assistant', timestamp: at(9, 28) },
        { id: 'user-old', role: 'user', timestamp: at(9, 28, 11) },
        { id: 'user-2-old', role: 'user', timestamp: at(9, 28, 12) },
        { id: 'assistant-today', role: 'assistant', timestamp: at(10, 4) },
        { id: 'user-today', role: 'user', timestamp: at(10, 4, 11) },
      ],
      { weeks: 2, now: NOW },
    );
    expect(cells).toHaveLength(14);
    const oldDay = cells.find((cell) => cell.startAt === startOfDay(at(9, 28)));
    const today = cells.find((cell) => cell.startAt === startOfDay(at(10, 4)));
    expect(oldDay).toMatchObject({ count: 3, messageId: 'user-old' });
    expect(today).toMatchObject({ count: 2, messageId: 'user-today' });
    expect(today?.future).toBeUndefined();
    expect(cells.filter((cell) => cell.count > 0)).toHaveLength(2);
  });

  it('ignores messages outside the calendar window', () => {
    const cells = buildWaitingActivity(
      [
        { id: 'too-old', role: 'user', timestamp: at(8, 1) },
        { id: 'too-new', role: 'user', timestamp: at(10, 5) },
      ],
      { weeks: 2, now: NOW },
    );
    expect(cells.every((cell) => cell.count === 0)).toBe(true);
    expect(cells.every((cell) => cell.messageId === undefined)).toBe(true);
  });

  it('marks days after today as future placeholders', () => {
    const cells = buildWaitingActivity([], { weeks: 1, now: NOW });
    expect(cells.slice(0, 3).every((cell) => !cell.future)).toBe(true);
    expect(cells.slice(3).every((cell) => cell.future)).toBe(true);
  });

  it('sums assistant usage and falls back to the latest usage event', () => {
    const summed = buildWaitingTokenUsage(
      [
        {
          role: 'assistant',
          usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
        },
        {
          role: 'assistant',
          usage: { inputTokens: 50, outputTokens: 10 },
        },
      ],
      {},
      900,
      1_000,
    );
    expect(summed).toEqual({
      input: 150,
      output: 30,
      cached: 40,
      context: 900,
      contextLimit: 1_000,
    });

    const fallback = buildWaitingTokenUsage([{ role: 'user' }], {
      inputTokens: 7,
      outputTokens: 3,
      cachedTokens: 1,
    });
    expect(fallback).toEqual({ input: 7, output: 3, cached: 1 });
  });
});
