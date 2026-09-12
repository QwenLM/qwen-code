/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
import { ObserverClient, recordObservation } from './observer.js';
import {
  MemorySession,
  renderWmReceipt,
  type MemorySessionOptions,
} from './session.js';
import { MemoryStore } from './store.js';
import { applyPatch } from './updater.js';

const cleanups: Array<() => void> = [];
const sessions: MemorySession[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-memory-session-'));
  const store = new MemoryStore({ directory, defaultId: 'default' });
  store.ensureDefault();
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (extra: Partial<MemorySessionOptions> = {}) => {
    const session = new MemorySession({
      store,
      libraryId: 'default',
      sessionId: 's1',
      config: structuredClone(DEFAULT_MEMORY_CONFIG),
      connection: { baseUrl: '' },
      ...extra,
    });
    sessions.push(session);
    return session;
  };
  return { store, create, database: store.database('default') };
}
afterEach(() => {
  sessions.splice(0).forEach((session) => session.close());
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

describe('MemorySession', () => {
  it('retries a failed final segment without accepting more input or losing its index', async () => {
    const { create, database } = setup();
    const session = create();
    session.recordUser('orchid care');
    session.recordAssistant('Water sparingly.');
    database.exec('PRAGMA query_only=ON');
    try {
      expect(() => session.close()).toThrow();
      expect(session.closed).toBe(true);
      session.recordUser('must not be recorded');
      expect(
        database.prepare('SELECT COUNT(*) AS n FROM dialogue_segments').get()?.[
          'n'
        ],
      ).toBe(0);
    } finally {
      database.exec('PRAGMA query_only=OFF');
    }
    session.close();
    session.close();
    expect(
      database
        .prepare('SELECT COUNT(*) AS n FROM turns WHERE seg_id IS NOT NULL')
        .get()?.['n'],
    ).toBe(1);
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM dialogue_segments').get()?.[
        'n'
      ],
    ).toBe(1);
    expect(
      (
        await create({ sessionId: 's2' }).retrieve({
          query: 'orchid',
          source: 'dialogue',
        })
      ).count,
    ).toBe(1);
  });

  it('preserves failed mid-call segment and turn writes in order until persistence recovers', () => {
    const { create, database } = setup();
    const enqueueEmbedding = vi.fn();
    const session = create({
      config: {
        ...structuredClone(DEFAULT_MEMORY_CONFIG),
        segment: { ...DEFAULT_MEMORY_CONFIG.segment, maxTurns: 1 },
      },
      enqueueEmbedding,
    });
    session.recordUser('orchid first');
    session.recordAssistant('answer first');
    database.exec('PRAGMA query_only=ON');
    try {
      session.recordUser('orchid second');
      session.recordAssistant('answer second');
      expect(() => session.close()).toThrow();
    } finally {
      database.exec('PRAGMA query_only=OFF');
    }
    session.close();
    expect(
      database
        .prepare(
          'SELECT turn_idx, user_text FROM turns WHERE seg_id IS NOT NULL ORDER BY turn_idx',
        )
        .all(),
    ).toEqual([
      { turn_idx: 0, user_text: 'orchid first' },
      { turn_idx: 1, user_text: 'orchid second' },
    ]);
    expect(
      database
        .prepare(
          'SELECT turn_from, turn_to FROM dialogue_segments ORDER BY turn_from',
        )
        .all(),
    ).toEqual([
      { turn_from: 0, turn_to: 0 },
      { turn_from: 1, turn_to: 1 },
    ]);
    expect(enqueueEmbedding).toHaveBeenCalledTimes(2);
  });

  it('persists dialogue, a short last segment and WM, then resumes without overwriting', async () => {
    const { create, database } = setup();
    const first = create();
    first.recordUser('辣椒的间距留多少？');
    first.recordAssistant('先说一个后台通知', { source: 'background' });
    first.recordAssistant('三十到四十厘米。');
    expect(
      renderWmReceipt(first.applyOmnibio({ add: ['用户喜欢种辣椒。'] })),
    ).toBe('Successfully updated memory.');
    first.close();
    first.close();
    const second = create();
    expect(second.wmEntries).toEqual(['用户喜欢种辣椒。']);
    second.recordUser('我也种番茄');
    second.recordAssistant('番茄需要更大的间距。');
    second.applyOmnibio({ add: ['用户也种番茄。'] });
    second.close();
    expect(
      database
        .prepare('SELECT turn_idx, asst_text FROM turns ORDER BY turn_idx')
        .all(),
    ).toEqual([
      { turn_idx: 0, asst_text: '三十到四十厘米。' },
      { turn_idx: 1, asst_text: '番茄需要更大的间距。' },
    ]);
    expect(
      database
        .prepare('SELECT seq FROM wm_snapshots ORDER BY seq')
        .all()
        .map((row) => row['seq']),
    ).toEqual([1, 2]);
    expect(
      database
        .prepare('SELECT n_turns, n_segments FROM library_sessions')
        .get(),
    ).toMatchObject({ n_turns: 2, n_segments: 2 });
    expect(
      database
        .prepare('SELECT COUNT(*) AS n FROM turns WHERE seg_id IS NULL')
        .get()?.['n'],
    ).toBe(0);
  });

  it('keeps preload frozen within an attachment and refreshes it in the next one', () => {
    const { create, database } = setup();
    applyPatch(database, { ltm_patch: { set: { name: '小王' } } }, 'past');
    const first = create();
    applyPatch(database, { ltm_patch: { set: { name: '小张' } } }, 'other');
    expect(first.promptBlocks()).toContain('小王');
    expect(first.promptBlocks()).not.toContain('小张');
    expect(create({ sessionId: 's2' }).promptBlocks()).toContain('小张');
  });

  it('publishes searchable tail dialogue, clears an empty lookup, and keeps receipts free of excerpts', async () => {
    const { create } = setup();
    const session = create();
    session.recordUser('辣椒间距多少');
    session.recordAssistant('三十到四十厘米。');
    const result = await session.retrieve({
      query: '辣椒 间距',
      source: 'dialogue',
    });
    expect(result).toMatchObject({
      count: 1,
      changed: true,
      receipt: 'Successfully searched past conversations. 1 matched.',
    });
    expect(session.promptBlocks()).toContain('三十到四十厘米');
    expect(result.receipt).not.toContain('厘米');
    expect(
      await session.retrieve({ query: '量子纠缠', source: 'dialogue' }),
    ).toMatchObject({ count: 0, changed: true });
    expect(session.promptBlocks()).toContain('<retrieved>\n</retrieved>');
    await session.retrieve({ query: '', source: 'dialogue' });
    expect(session.promptBlocks()).toContain('<retrieved>\n</retrieved>');
  });

  it('keeps dialogue and historical visual recall separate even while observation is disabled', async () => {
    const { create, database } = setup();
    const session = create();
    recordObservation(database, '用户把黑框眼镜放在键盘右侧。', 's1');
    expect(
      await session.retrieve({ query: '眼镜 键盘', source: 'env' }),
    ).toMatchObject({
      count: 1,
      receipt: 'Successfully searched past visual observations. 1 matched.',
    });
    expect(session.promptBlocks()).toContain('[visual]');
    expect(
      await session.retrieve({ query: '眼镜 键盘', source: 'dialogue' }),
    ).toMatchObject({ count: 0 });
  });

  it('contains embedding enqueue failures and still records the following turn', () => {
    const { create, database } = setup();
    const session = create({
      config: {
        ...structuredClone(DEFAULT_MEMORY_CONFIG),
        segment: { ...DEFAULT_MEMORY_CONFIG.segment, maxTurns: 1 },
      },
      enqueueEmbedding: () => {
        throw new Error('queue stopped');
      },
    });
    session.recordUser('first');
    session.recordAssistant('answer');
    session.recordUser('second');
    session.recordAssistant('answer');
    session.close();
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM turns').get()?.['n'],
    ).toBe(2);
  });

  it('returns copies of WM and refuses changes after close', () => {
    const session = setup().create();
    session.applyOmnibio({ add: ['用户是牙医。'] });
    session.wmEntries.push('invisible mutation');
    expect(session.wmEntries).toEqual(['用户是牙医。']);
    session.close();
    expect(session.applyOmnibio({ add: ['late'] }).succeeded).toBe(false);
  });

  it('rejects an over-budget working-memory update before changing state or writing a snapshot', () => {
    const { create, database } = setup();
    const session = create({ maxPromptChars: 260 });
    expect(session.applyOmnibio({ add: ['Keep this memory'] }).succeeded).toBe(
      true,
    );
    const before = session.promptBlocks();
    const result = session.applyOmnibio({
      update: [{ index: 0, content: 'Changed memory' }],
      add: ['x'.repeat(200)],
    });
    expect(result).toMatchObject({
      added: 0,
      updated: 0,
      deleted: 0,
      changed: false,
      succeeded: false,
      nAfter: 1,
    });
    expect(session.wmEntries).toEqual(['Keep this memory']);
    expect(session.promptBlocks()).toBe(before);
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM wm_snapshots').get()?.['n'],
    ).toBe(1);
  });

  it('keeps working memory unchanged when snapshot persistence fails and retries without advancing its version', () => {
    const { create, database } = setup();
    const session = create();
    session.applyOmnibio({
      add: ['Keep the first fact', 'Keep the second fact'],
    });
    const before = session.promptBlocks();
    database.exec('PRAGMA query_only=ON');
    try {
      const result = session.applyOmnibio({
        update: [{ index: 0, content: 'Rejected replacement' }],
        delete: [1],
        add: ['Rejected addition'],
      });
      expect(result).toMatchObject({
        added: 0,
        updated: 0,
        deleted: 0,
        skipped: 3,
        nAfter: 2,
        changed: false,
        succeeded: false,
      });
      expect(renderWmReceipt(result)).toBe('Failed to update memory.');
      expect(session.wmEntries).toEqual([
        'Keep the first fact',
        'Keep the second fact',
      ]);
      expect(session.promptBlocks()).toBe(before);
      expect(
        database.prepare('SELECT COUNT(*) AS n FROM wm_snapshots').get()?.['n'],
      ).toBe(1);
    } finally {
      database.exec('PRAGMA query_only=OFF');
    }
    expect(
      session.applyOmnibio({ add: ['Persisted after recovery'] }).succeeded,
    ).toBe(true);
    expect(
      database.prepare('SELECT seq FROM wm_snapshots ORDER BY seq').all(),
    ).toEqual([{ seq: 1 }, { seq: 2 }]);
    session.close();
    expect(create().wmEntries).toEqual([
      'Keep the first fact',
      'Keep the second fact',
      'Persisted after recovery',
    ]);
  });

  it('leaves the last retrieved section intact when a new result exceeds the total prompt budget', async () => {
    const { create } = setup();
    const session = create({ maxPromptChars: 500 });
    session.recordUser('orchid');
    session.recordAssistant('Keep the roots aerated.');
    session.flush();
    expect(
      (await session.retrieve({ query: 'orchid', source: 'dialogue' })).count,
    ).toBe(1);
    const before = session.promptBlocks();
    session.recordUser('monstera');
    session.recordAssistant('large '.repeat(150));
    session.flush();
    const result = await session.retrieve({
      query: 'monstera',
      source: 'dialogue',
    });
    expect(result).toEqual({ receipt: 'Failed to search memory.' });
    expect(session.promptBlocks()).toBe(before);
  });

  it('rejects oversized restored memory and preload at construction', () => {
    const { create, database } = setup();
    const first = create();
    first.applyOmnibio({ add: ['x'.repeat(200)] });
    first.close();
    expect(() => create({ maxPromptChars: 260 })).toThrow(/prompt budget/iu);
    database
      .prepare(
        'INSERT INTO ltm_entries(field,content,created_at,updated_at) VALUES(?,?,?,?)',
      )
      .run('name', 'x'.repeat(90_000), '2026-09-05', '2026-09-05');
    expect(() => create({ sessionId: 'new-session' })).toThrow(
      /prompt budget/iu,
    );
  });
});

describe('memory observer lifecycle', () => {
  it('does not acquire frames by default and starts when the UI enables visual memory', async () => {
    vi.useFakeTimers();
    const { create, database } = setup();
    const capture = vi.fn(async () => ({
      image: 'frame',
      source: 'camera' as const,
    }));
    const observer = new ObserverClient({
      config: DEFAULT_MEMORY_CONFIG.observer,
      connection: { baseUrl: '' },
      transport: async () => '用户在书桌旁阅读。',
    });
    const session = create({
      captureVision: capture,
      visualSource: 'camera',
      observer,
    });
    session.startObserver();
    await vi.advanceTimersByTimeAsync(5000);
    expect(capture).not.toHaveBeenCalled();
    session.setObserverEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM stm_env').get()?.['n'],
    ).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM stm_env').get()?.['n'],
    ).toBe(1);
  });

  it.each(['close', 'disable', 'source'] as const)(
    'rejects a late observation after %s',
    async (change) => {
      vi.useFakeTimers();
      const { create, database } = setup();
      let finish!: (value: string) => void;
      const observer = new ObserverClient({
        config: DEFAULT_MEMORY_CONFIG.observer,
        connection: { baseUrl: '' },
        transport: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      });
      const session = create({
        config: {
          ...structuredClone(DEFAULT_MEMORY_CONFIG),
          observer: { ...DEFAULT_MEMORY_CONFIG.observer, enabled: true },
        },
        visualSource: 'camera',
        observer,
        captureVision: async () => ({ image: 'frame', source: 'camera' }),
      });
      session.startObserver();
      await vi.advanceTimersByTimeAsync(0);
      expect(finish).toBeTypeOf('function');
      if (change === 'close') session.close();
      else if (change === 'disable') session.setObserverEnabled(false);
      else session.setVisualSource('screen');
      finish('用户在厨房做饭。');
      await vi.advanceTimersByTimeAsync(0);
      expect(
        database.prepare('SELECT COUNT(*) AS n FROM stm_env').get()?.['n'],
      ).toBe(0);
    },
  );

  it('uses a fresh live frame independently of proactive tasks and skips stale frames', async () => {
    vi.useFakeTimers();
    const { create, database } = setup();
    const observed = vi.fn(async () => '用户在书桌旁阅读。');
    const observer = new ObserverClient({
      config: DEFAULT_MEMORY_CONFIG.observer,
      connection: { baseUrl: '' },
      transport: observed,
    });
    const session = create({
      config: {
        ...structuredClone(DEFAULT_MEMORY_CONFIG),
        observer: { ...DEFAULT_MEMORY_CONFIG.observer, enabled: true },
      },
      visualSource: 'camera',
      observer,
    });
    session.startObserver();
    session.feedImage('frame', 'camera');
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM stm_env').get()?.['n'],
    ).toBe(1);
  });
});
