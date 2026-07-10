/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorStore } from './cursorStore.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-cursor-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PATH = () => join(dir, 'cursors.json');

describe('CursorStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = await CursorStore.open(PATH());
    expect(store.get('tok1', 'sess-a')).toBeUndefined();
  });

  it('persists lastEventId and survives a reopen', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 42);
    const store2 = await CursorStore.open(PATH());
    expect(store2.get('tok1', 'sess-a')).toEqual({
      lastEventId: 42,
      lastDeliveredEventId: 42,
    });
  });

  it('persists lastDeliveredEventId and survives a reopen', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 10);
    await store.setLastDeliveredEventId('tok1', 'sess-a', 7);
    const store2 = await CursorStore.open(PATH());
    expect(store2.get('tok1', 'sess-a')).toEqual({
      lastEventId: 10,
      lastDeliveredEventId: 7,
    });
  });

  it('setLastEventId initialises lastDeliveredEventId when no entry exists', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-new', 99);
    expect(store.get('tok1', 'sess-new')).toEqual({
      lastEventId: 99,
      lastDeliveredEventId: 99,
    });
  });

  it('setLastDeliveredEventId initialises lastEventId when no entry exists', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastDeliveredEventId('tok1', 'sess-new', 5);
    expect(store.get('tok1', 'sess-new')).toEqual({
      lastEventId: 5,
      lastDeliveredEventId: 5,
    });
  });

  it('cursors are keyed per (tokenId, sessionId) pair', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 10);
    await store.setLastEventId('tok2', 'sess-a', 20);
    await store.setLastEventId('tok1', 'sess-b', 30);
    expect(store.get('tok1', 'sess-a')?.lastEventId).toBe(10);
    expect(store.get('tok2', 'sess-a')?.lastEventId).toBe(20);
    expect(store.get('tok1', 'sess-b')?.lastEventId).toBe(30);
  });

  it('delete removes the entry and flushes', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 50);
    await store.delete('tok1', 'sess-a');
    expect(store.get('tok1', 'sess-a')).toBeUndefined();
    // Verify persistence
    const store2 = await CursorStore.open(PATH());
    expect(store2.get('tok1', 'sess-a')).toBeUndefined();
  });

  it('write is atomic: the file is never partially written (temp+rename)', async () => {
    const store = await CursorStore.open(PATH());
    // Run several concurrent writes to exercise the rename path.
    await Promise.all([
      store.setLastEventId('tok1', 's1', 1),
      store.setLastEventId('tok1', 's2', 2),
      store.setLastEventId('tok1', 's3', 3),
    ]);
    // At minimum the file is valid JSON after concurrent writes.
    const raw = await readFile(PATH(), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('silently ignores a corrupt file and starts empty', async () => {
    const p = PATH();
    await rm(dir, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(dir, { recursive: true }),
    );
    await import('node:fs/promises').then((fs) => fs.writeFile(p, 'NOT JSON'));
    const store = await CursorStore.open(p);
    expect(store.get('tok1', 'sess-a')).toBeUndefined();
  });
});
