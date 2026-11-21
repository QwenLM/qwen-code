/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonGeneratedUiStateWriteResult } from '@qwen-code/sdk/daemon';
import {
  generatedUiCardId,
  ViewStateCoordinator,
  type ViewStateStatus,
  type ViewStateStore,
} from './view-state';

const CARD = 'gc_aaaaaaaaaaaaaaaaaaaaaa';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let sessions = 0;
function harness(
  initial: { revision: number; value: unknown } = {
    revision: 0,
    value: null,
  },
) {
  const writes: Array<{
    write: { baseRevision: number; value: unknown };
    reply: ReturnType<typeof deferred<DaemonGeneratedUiStateWriteResult>>;
  }> = [];
  const store: ViewStateStore = {
    sessionId: `session-${++sessions}`,
    get: vi.fn(async () => ({ cardId: CARD, ...initial })),
    set: vi.fn((_cardId, write) => {
      const reply = deferred<DaemonGeneratedUiStateWriteResult>();
      writes.push({ write, reply });
      return reply.promise;
    }),
  };
  const statuses: ViewStateStatus[] = [];
  const coordinator = new ViewStateCoordinator(store, CARD, (status) =>
    statuses.push(status),
  );
  const saved = async (index: number, revision: number) => {
    writes[index]!.reply.resolve({ outcome: 'saved', cardId: CARD, revision });
    await vi.waitFor(() => expect(statuses.at(-1)).not.toBe('saving'));
  };
  return { store, writes, statuses, coordinator, saved };
}

describe('Generated UI card id', () => {
  it('reads only a well-formed id from the bundled result metadata', () => {
    expect(
      generatedUiCardId({ _meta: { 'qwen/generated-ui': { cardId: CARD } } }),
    ).toBe(CARD);
    for (const cardId of [undefined, 'gc_short', 'card', 7])
      expect(
        generatedUiCardId({ _meta: { 'qwen/generated-ui': { cardId } } }),
      ).toBeUndefined();
    expect(generatedUiCardId({})).toBeUndefined();
  });
});

describe('one card’s saved state', () => {
  it('saves nothing before the state was read', () => {
    const h = harness();
    h.coordinator.save({ items: [1] });
    expect(h.store.set).not.toHaveBeenCalled();
  });

  it('sends at once, coalesces while a write is in flight and tracks the revision', async () => {
    const h = harness({ revision: 4, value: { items: [] } });
    await expect(h.coordinator.load()).resolves.toEqual({ items: [] });
    h.coordinator.save({ items: [] });
    expect(h.store.set).not.toHaveBeenCalled();
    h.coordinator.save({ items: [1] });
    h.coordinator.save({ items: [1, 2] });
    h.coordinator.save({ items: [1, 2, 3] });
    expect(h.writes.map(({ write }) => write)).toEqual([
      { baseRevision: 4, value: { items: [1] } },
    ]);
    expect(h.statuses).toEqual(['saving']);
    h.writes[0]!.reply.resolve({ outcome: 'saved', cardId: CARD, revision: 9 });
    await vi.waitFor(() => expect(h.writes).toHaveLength(2));
    expect(h.writes[1]!.write).toEqual({
      baseRevision: 9,
      value: { items: [1, 2, 3] },
    });
    await h.saved(1, 10);
    expect(h.statuses).toEqual(['saving', 'saved']);
  });

  it('sends a change back to the saved value made while a write is in flight', async () => {
    const h = harness({ revision: 1, value: 'start' });
    await h.coordinator.load();
    h.coordinator.save('changed');
    h.coordinator.save('start');
    h.writes[0]!.reply.resolve({ outcome: 'saved', cardId: CARD, revision: 2 });
    await vi.waitFor(() => expect(h.writes).toHaveLength(2));
    expect(h.writes[1]!.write).toEqual({ baseRevision: 2, value: 'start' });
    await h.saved(1, 3);
    h.coordinator.save('changed');
    h.coordinator.save('other');
    h.coordinator.save('changed');
    await h.saved(2, 4);
    expect(h.writes).toHaveLength(3);
  });

  it('clears a too-large report when the value returns to what is saved', async () => {
    const h = harness();
    await h.coordinator.load();
    h.coordinator.save(1);
    h.coordinator.save('x'.repeat(16 * 1024));
    await h.saved(0, 1);
    expect(h.statuses.at(-1)).toBe('too_large');
    h.coordinator.save(1);
    expect(h.statuses.at(-1)).toBe('saved');
    expect(h.writes).toHaveLength(1);
  });

  it('stops saving after a stale write', async () => {
    const h = harness();
    await h.coordinator.load();
    h.coordinator.save(1);
    h.writes[0]!.reply.resolve({
      outcome: 'stale',
      cardId: CARD,
      revision: 3,
      value: 'theirs',
    });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('stale'));
    h.coordinator.save(2);
    expect(h.writes).toHaveLength(1);
  });

  it('reports a value over 16 KiB without sending it', async () => {
    const h = harness();
    await h.coordinator.load();
    h.coordinator.save('x'.repeat(16 * 1024));
    expect(h.store.set).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(['too_large']);
    h.coordinator.save(1);
    await h.saved(0, 1);
    expect(h.statuses).toEqual(['too_large', 'saving', 'saved']);
  });

  it('reports a failed write and retries with the next change', async () => {
    const h = harness();
    await h.coordinator.load();
    h.coordinator.save(1);
    h.writes[0]!.reply.reject(new Error('503'));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('failed'));
    h.coordinator.save(2);
    expect(h.writes[1]!.write).toEqual({ baseRevision: 0, value: 2 });
  });

  it('reports a refused save after a previous value was saved', async () => {
    const h = harness();
    await h.coordinator.load();
    h.coordinator.save(1);
    await h.saved(0, 1);
    h.store.captureWrite = () => {
      throw new Error('inactive');
    };
    expect(() => h.coordinator.save(2)).toThrow('inactive');
    expect(h.writes).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe('failed');

    h.store.captureWrite = undefined;
    h.coordinator.save(2);
    expect(h.writes[1]!.write).toEqual({ baseRevision: 1, value: 2 });
    await h.saved(1, 2);
    expect(h.statuses.at(-1)).toBe('saved');
  });

  it('reports that a stale revision stops saving even after a later save refusal', async () => {
    const h = harness();
    await h.coordinator.load();
    h.coordinator.save(1);
    h.store.captureWrite = () => {
      throw new Error('inactive');
    };
    expect(() => h.coordinator.save(2)).toThrow('inactive');
    h.writes[0]!.reply.resolve({
      outcome: 'stale',
      cardId: CARD,
      revision: 2,
      value: 'theirs',
    });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('stale'));
    h.store.captureWrite = undefined;
    h.coordinator.save(3);
    expect(h.writes).toHaveLength(1);
  });

  it('does not report a revert as saved after a write loses its response', async () => {
    const h = harness({ revision: 1, value: 'start' });
    await h.coordinator.load();
    h.coordinator.save('changed');
    h.writes[0]!.reply.reject(new Error('Response lost'));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('failed'));

    h.coordinator.save('start');
    expect(h.writes[1]!.write).toEqual({ baseRevision: 1, value: 'start' });
    h.writes[1]!.reply.resolve({
      outcome: 'stale',
      cardId: CARD,
      revision: 2,
      value: 'changed',
    });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('stale'));
    expect(h.statuses).not.toContain('saved');
  });

  it('reports a load failure and then saves nothing', async () => {
    const h = harness();
    vi.mocked(h.store.get).mockRejectedValueOnce(new Error('503'));
    await expect(h.coordinator.load()).rejects.toThrow('503');
    expect(h.statuses).toEqual(['unavailable']);
    h.coordinator.save(1);
    expect(h.store.set).not.toHaveBeenCalled();
  });

  it('lets a remounted card read only after the earlier writes landed', async () => {
    const h = harness();
    await h.coordinator.load();
    h.coordinator.save(1);
    h.coordinator.save(2);
    const remounted = new ViewStateCoordinator(h.store, CARD, () => {});
    const loading = remounted.load();
    h.writes[0]!.reply.resolve({ outcome: 'saved', cardId: CARD, revision: 1 });
    await vi.waitFor(() => expect(h.writes).toHaveLength(2));
    expect(h.store.get).toHaveBeenCalledTimes(1);
    vi.mocked(h.store.get).mockResolvedValueOnce({
      cardId: CARD,
      revision: 2,
      value: 2,
    });
    await h.saved(1, 2);
    await expect(loading).resolves.toBe(2);
    expect(h.store.get).toHaveBeenCalledTimes(2);
  });

  it('clears the saved state from a fresh read, even after a stale write', async () => {
    const h = harness({ revision: 2, value: 'mine' });
    await h.coordinator.load();
    h.coordinator.save('newer');
    h.writes[0]!.reply.resolve({
      outcome: 'stale',
      cardId: CARD,
      revision: 5,
      value: 'theirs',
    });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('stale'));
    vi.mocked(h.store.get).mockResolvedValueOnce({
      cardId: CARD,
      revision: 5,
      value: 'theirs',
    });
    const clearing = h.coordinator.clear();
    await vi.waitFor(() => expect(h.writes).toHaveLength(2));
    expect(h.writes[1]!.write).toEqual({ baseRevision: 5, value: null });
    h.writes[1]!.reply.resolve({ outcome: 'saved', cardId: CARD, revision: 6 });
    await expect(clearing).resolves.toBe(true);
    h.coordinator.save('after');
    expect(h.writes).toHaveLength(2);
  });

  it('reports a reset whose clear failed', async () => {
    const h = harness({ revision: 2, value: 'mine' });
    const clearing = h.coordinator.clear();
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    h.writes[0]!.reply.reject(new Error('503'));
    await expect(clearing).resolves.toBe(false);
    expect(h.statuses.at(-1)).toBe('failed');
  });
});
