/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

import {
  listDreamTasks,
  subscribeDreams,
  dreamSnapshotSignature,
  DreamTaskKind,
  MAX_RETAINED_TERMINAL_DREAMS,
} from './dream-task.js';
import type { MemoryManager, MemoryTaskRecord } from '../memory/manager.js';

const PROJECT = '/project';

function makeRecord(over: Partial<MemoryTaskRecord> = {}): MemoryTaskRecord {
  return {
    id: 'd1',
    taskType: 'dream',
    projectRoot: PROJECT,
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeMemoryManager(records: MemoryTaskRecord[]) {
  return {
    listTasksByType: vi.fn().mockReturnValue(records),
    subscribe: vi.fn().mockReturnValue(() => {}),
    cancelTask: vi.fn().mockReturnValue(true),
  } as unknown as MemoryManager & {
    listTasksByType: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    cancelTask: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  warnSpy.mockClear();
});

describe('listDreamTasks', () => {
  it('queries the dream task type for the given project root', () => {
    const mm = makeMemoryManager([]);
    listDreamTasks(mm, PROJECT);
    expect(mm.listTasksByType).toHaveBeenCalledWith('dream', PROJECT);
  });

  it('filters out pending and skipped records', () => {
    const mm = makeMemoryManager([
      makeRecord({ id: 'pending', status: 'pending' }),
      makeRecord({ id: 'skipped', status: 'skipped' }),
      makeRecord({ id: 'running', status: 'running' }),
    ]);

    const result = listDreamTasks(mm, PROJECT);

    expect(result.map((t) => t.dreamId)).toEqual(['running']);
  });

  it('always includes running entries regardless of the terminal cap', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ id: `run-${i}`, status: 'running' }),
    );
    const mm = makeMemoryManager(records);

    const result = listDreamTasks(mm, PROJECT);

    expect(result).toHaveLength(5);
    expect(result.every((t) => t.status === 'running')).toBe(true);
  });

  it('caps terminal entries and keeps the newest by updatedAt', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        id: `done-${i}`,
        status: 'completed',
        updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    const mm = makeMemoryManager(records);

    const result = listDreamTasks(mm, PROJECT);

    expect(result).toHaveLength(MAX_RETAINED_TERMINAL_DREAMS);
    // Newest-first: done-4 (Jan 05), done-3 (Jan 04), done-2 (Jan 03).
    expect(result.map((t) => t.dreamId)).toEqual([
      'done-4',
      'done-3',
      'done-2',
    ]);
  });

  it('lists running entries ahead of terminal ones', () => {
    const mm = makeMemoryManager([
      makeRecord({ id: 'done', status: 'failed' }),
      makeRecord({ id: 'live', status: 'running' }),
    ]);

    const result = listDreamTasks(mm, PROJECT);

    expect(result.map((t) => t.dreamId)).toEqual(['live', 'done']);
  });

  it('maps record fields into the DreamTask view-model', () => {
    const mm = makeMemoryManager([
      makeRecord({
        id: 'd-map',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:05:00.000Z',
        progressText: 'reviewing',
        metadata: {
          sessionCount: 7,
          touchedTopics: ['topic-a', 'topic-b'],
          lockReleaseError: 'lock boom',
          metadataWriteError: 'meta boom',
        },
      }),
    ]);

    const [task] = listDreamTasks(mm, PROJECT);

    expect(task).toMatchObject({
      kind: 'dream',
      dreamId: 'd-map',
      status: 'completed',
      startTime: Date.parse('2026-01-01T00:00:00.000Z'),
      endTime: Date.parse('2026-01-01T00:05:00.000Z'),
      progressText: 'reviewing',
      sessionCount: 7,
      touchedTopics: ['topic-a', 'topic-b'],
      lockReleaseError: 'lock boom',
      metadataWriteError: 'meta boom',
    });
  });

  it('leaves endTime undefined for running dreams', () => {
    const mm = makeMemoryManager([
      makeRecord({ id: 'live', status: 'running' }),
    ]);
    const [task] = listDreamTasks(mm, PROJECT);
    expect(task.endTime).toBeUndefined();
  });

  it('drops malformed metadata (non-number sessionCount, non-string topics)', () => {
    const mm = makeMemoryManager([
      makeRecord({
        id: 'd-bad',
        status: 'completed',
        metadata: {
          sessionCount: 'nope',
          touchedTopics: ['ok', 42, null],
        },
      }),
    ]);

    const [task] = listDreamTasks(mm, PROJECT);

    expect(task.sessionCount).toBeUndefined();
    expect(task.touchedTopics).toEqual(['ok']);
  });
});

describe('subscribeDreams', () => {
  it('subscribes with the dream task-type filter and returns the unsubscribe', () => {
    const unsub = vi.fn();
    const mm = makeMemoryManager([]);
    mm.subscribe.mockReturnValue(unsub);
    const listener = vi.fn();

    const returned = subscribeDreams(mm, listener);

    expect(mm.subscribe).toHaveBeenCalledWith(listener, { taskType: 'dream' });
    expect(returned).toBe(unsub);
  });
});

describe('dreamSnapshotSignature', () => {
  it('encodes id:status:updatedAt per record, joined', () => {
    const sig = dreamSnapshotSignature([
      makeRecord({ id: 'a', status: 'running', updatedAt: 'T1' }),
      makeRecord({ id: 'b', status: 'completed', updatedAt: 'T2' }),
    ]);
    expect(sig).toBe('a:running:T1|b:completed:T2');
  });

  it('changes when any dialog-visible field advances updatedAt', () => {
    const before = dreamSnapshotSignature([
      makeRecord({ id: 'a', status: 'running', updatedAt: 'T1' }),
    ]);
    const after = dreamSnapshotSignature([
      makeRecord({ id: 'a', status: 'running', updatedAt: 'T2' }),
    ]);
    expect(before).not.toBe(after);
  });
});

describe('DreamTaskKind', () => {
  it('has the dream kind', () => {
    expect(DreamTaskKind.kind).toBe('dream');
  });

  it('kill delegates to MemoryManager.cancelTask', () => {
    const mm = makeMemoryManager([]);
    DreamTaskKind.kill('d1', { registry: {} as never, memoryManager: mm });
    expect(mm.cancelTask).toHaveBeenCalledWith('d1');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('kill warns (without throwing) when cancelTask reports failure', () => {
    const mm = makeMemoryManager([]);
    mm.cancelTask.mockReturnValue(false);

    expect(() =>
      DreamTaskKind.kill('d1', { registry: {} as never, memoryManager: mm }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
