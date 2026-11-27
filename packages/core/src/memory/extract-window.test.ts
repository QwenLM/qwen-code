/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  EXTRACT_STABLE_WINDOW_ENV,
  hashCuratedEntry,
  isStableExtractionWindowEnabled,
  resolveExtractWindow,
} from './extract-window.js';
import type { AutoMemoryExtractCursor } from './types.js';

function turn(role: 'user' | 'model', text: string): Content {
  return { role, parts: [{ text }] };
}

/** Alternating user/model turns ending with a model turn, like a settled one. */
function conversation(count: number, prefix = 'turn'): Content[] {
  const history: Content[] = [];
  for (let i = 0; i < count; i++) {
    history.push(turn(i % 2 === 0 ? 'user' : 'model', `${prefix}-${i}`));
  }
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    history.push(turn('model', `${prefix}-ack`));
  }
  return history;
}

/** The cursor a previous stable-window run leaves behind for `history`. */
function windowCursor(
  history: Content[],
  overrides: Partial<AutoMemoryExtractCursor> = {},
): AutoMemoryExtractCursor {
  return {
    sessionId: 'session-1',
    processedOffset: history.length,
    updatedAt: new Date(0).toISOString(),
    epoch: 1,
    windowStartCurated: Math.max(0, history.length - 40),
    coveredCurated: history.length,
    windowHeadHash: hashCuratedEntry(history[Math.max(0, history.length - 40)]),
    windowEpochId: 'token:0',
    ...overrides,
  };
}

describe('isStableExtractionWindowEnabled', () => {
  it('is off by default and for unknown values', () => {
    expect(isStableExtractionWindowEnabled({})).toBe(false);
    expect(
      isStableExtractionWindowEnabled({ [EXTRACT_STABLE_WINDOW_ENV]: '0' }),
    ).toBe(false);
    expect(
      isStableExtractionWindowEnabled({ [EXTRACT_STABLE_WINDOW_ENV]: 'off' }),
    ).toBe(false);
    expect(
      isStableExtractionWindowEnabled({ [EXTRACT_STABLE_WINDOW_ENV]: 'no' }),
    ).toBe(false);
  });

  it('accepts the documented opt-in spellings, trimmed and case-insensitive', () => {
    for (const raw of ['1', 'true', 'TRUE', 'on', 'YES', ' yes ']) {
      expect(
        isStableExtractionWindowEnabled({ [EXTRACT_STABLE_WINDOW_ENV]: raw }),
      ).toBe(true);
    }
  });
});

describe('hashCuratedEntry', () => {
  it('is stable for the same entry and differs when its text changes', () => {
    const entry = turn('user', 'I prefer pnpm.');
    expect(hashCuratedEntry(entry)).toBe(hashCuratedEntry({ ...entry }));
    expect(hashCuratedEntry(entry)).not.toBe(
      hashCuratedEntry(turn('user', 'I prefer npm.')),
    );
  });

  it('does not hash inline media payload bytes', () => {
    const base = {
      role: 'user' as const,
      parts: [
        {
          inlineData: { mimeType: 'image/png', data: 'AAAA' },
        },
      ],
    };
    const sameLength = {
      ...base,
      parts: [{ inlineData: { mimeType: 'image/png', data: 'BBBB' } }],
    };
    expect(hashCuratedEntry(base)).toBe(hashCuratedEntry(sameLength));
  });
});

describe('resolveExtractWindow', () => {
  it('starts a fresh epoch at the last-40 tail when no window was persisted', () => {
    const history = conversation(80);
    const resolved = resolveExtractWindow({
      curatedHistory: history,
      sessionId: 'session-1',
      previous: {
        sessionId: 'session-1',
        updatedAt: new Date(0).toISOString(),
      },
    });
    expect(resolved.epoch).toBe(1);
    expect(resolved.windowStartCurated).toBe(40);
    expect(resolved.coveredCurated).toBe(40);
    expect(resolved.rebaseReason).toBe('new_epoch');
    expect(resolved.windowHeadHash).toBe(hashCuratedEntry(history[40]));
  });

  it('seeds a new epoch at the last-40 tail regardless of entry size', () => {
    // No size-based seeding: the last 40 curated entries are the fallback even
    // when that suffix is large, because bounding growth is a compaction
    // policy decision (#15493).
    const history = conversation(80).map((entry, index) => ({
      ...entry,
      parts: [{ text: `${index}`.padEnd(4000, 'x') }],
    }));
    const resolved = resolveExtractWindow({
      curatedHistory: history,
      sessionId: 'session-1',
      previous: {
        sessionId: 'session-1',
        updatedAt: new Date(0).toISOString(),
      },
    });
    expect(resolved.rebaseReason).toBe('new_epoch');
    expect(resolved.windowStartCurated).toBe(40);
  });

  it('keeps the start index when the history only appended', () => {
    const first = conversation(60);
    const previous = windowCursor(first);
    const appended = [...first, turn('user', 'next'), turn('model', 'ok')];
    const resolved = resolveExtractWindow({
      curatedHistory: appended,
      sessionId: 'session-1',
      previous,
      epochId: 'token:0',
    });
    expect(resolved.rebaseReason).toBeUndefined();
    expect(resolved.epoch).toBe(1);
    expect(resolved.windowStartCurated).toBe(previous.windowStartCurated);
    expect(resolved.coveredCurated).toBe(first.length);
  });

  it('rebases when a history-rewriting boundary changed the epoch identity', () => {
    const first = conversation(60);
    const previous = windowCursor(first);
    const appended = [...first, turn('user', 'next'), turn('model', 'ok')];
    const resolved = resolveExtractWindow({
      curatedHistory: appended,
      sessionId: 'session-1',
      previous,
      epochId: 'token:1',
    });
    expect(resolved.rebaseReason).toBe('epoch_id_changed');
    expect(resolved.epoch).toBe(previous.epoch! + 1);
    // Seed stays at or before the covered index: the appended turns are in.
    expect(resolved.windowStartCurated).toBeLessThanOrEqual(
      previous.coveredCurated!,
    );
  });

  it('rebases on a session change instead of reusing another session cursor', () => {
    const history = conversation(60);
    const previous = windowCursor(history);
    const resolved = resolveExtractWindow({
      curatedHistory: history,
      sessionId: 'session-2',
      previous,
      epochId: 'token:0',
    });
    expect(resolved.rebaseReason).toBe('new_session');
    expect(resolved.epoch).toBe(previous.epoch! + 1);
    expect(resolved.windowStartCurated).toBe(Math.max(0, history.length - 40));
  });

  it('rebases when the history shrank below the pinned start', () => {
    const first = conversation(60);
    const previous = windowCursor(first);
    const compacted = conversation(20, 'compacted');
    const resolved = resolveExtractWindow({
      curatedHistory: compacted,
      sessionId: 'session-1',
      previous,
      epochId: 'token:0',
    });
    expect(resolved.rebaseReason).toBe('history_shrank');
    expect(resolved.epoch).toBe(previous.epoch! + 1);
    expect(resolved.windowStartCurated).toBe(0);
  });

  it('rebases when the entry at the pinned start was rewritten', () => {
    const first = conversation(60);
    const previous = windowCursor(first);
    const rewritten = first.map((entry, index) =>
      index === previous.windowStartCurated
        ? turn('user', 'compaction summary')
        : entry,
    );
    const resolved = resolveExtractWindow({
      curatedHistory: rewritten,
      sessionId: 'session-1',
      previous,
      epochId: 'token:0',
    });
    expect(resolved.rebaseReason).toBe('head_changed');
    expect(resolved.epoch).toBe(previous.epoch! + 1);
  });

  it('seeds a rebased epoch no later than the first unextracted entry', () => {
    // Only the first three entries were ever covered; 47 are unextracted.
    const history = conversation(50);
    const previous = windowCursor(history, {
      windowStartCurated: 0,
      coveredCurated: 3,
      windowHeadHash: hashCuratedEntry(history[0]),
    });
    const resolved = resolveExtractWindow({
      curatedHistory: history,
      sessionId: 'session-1',
      previous,
      epochId: 'token:1',
    });
    expect(resolved.rebaseReason).toBe('epoch_id_changed');
    expect(resolved.coveredCurated).toBeLessThanOrEqual(3);
    expect(resolved.windowStartCurated).toBeLessThanOrEqual(3);
  });

  it('never re-slices a large window to a newer tail: no size-driven rebase', () => {
    // #15493 keeps growth bounding as the session-compaction policy's
    // decision. A tool-heavy window that is far larger than any model budget
    // must keep its pinned start across appended turns instead of sliding.
    const huge = conversation(60).map((entry, index) => ({
      ...entry,
      parts: [{ text: `${index}`.padEnd(4000, 'x') }],
    }));
    const previous = windowCursor(huge, {
      windowStartCurated: 0,
      coveredCurated: huge.length,
      windowHeadHash: hashCuratedEntry(huge[0]),
    });
    const appended = [
      ...huge,
      turn('user', 'more'),
      turn('model', 'more back'),
    ];
    const resolved = resolveExtractWindow({
      curatedHistory: appended,
      sessionId: 'session-1',
      previous,
      epochId: 'token:0',
    });
    expect(resolved.rebaseReason).toBeUndefined();
    expect(resolved.epoch).toBe(previous.epoch);
    expect(resolved.windowStartCurated).toBe(0);
  });

  it('treats a pre-experiment cursor with only session/offset as a fresh epoch', () => {
    const history = conversation(12);
    const resolved = resolveExtractWindow({
      curatedHistory: history,
      sessionId: 'session-1',
      previous: {
        sessionId: 'session-1',
        processedOffset: 4,
        updatedAt: new Date(0).toISOString(),
      },
    });
    expect(resolved.rebaseReason).toBe('new_epoch');
    expect(resolved.epoch).toBe(1);
    expect(resolved.windowStartCurated).toBe(0);
  });
});
