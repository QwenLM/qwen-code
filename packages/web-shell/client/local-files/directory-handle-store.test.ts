import { describe, expect, it } from 'vitest';
import { createDirectoryHandleStore } from './directory-handle-store.js';

import { createFakeIndexedDB } from '../test/fake-indexeddb';

// The shared fake covers open/upgrade/blocked, put/get/delete, request
// failures, and seeding a foreign record.
const fakeIdb = createFakeIndexedDB;

const directoryHandle = {
  kind: 'directory',
  name: 'ai_coding',
} as unknown as FileSystemDirectoryHandle;

const PAGE_ORIGIN = 'http://localhost:4170';

describe('createDirectoryHandleStore', () => {
  it('round-trips the granted handle through IndexedDB', async () => {
    const { factory } = fakeIdb();
    const store = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);

    expect(await store.save(directoryHandle)).toBe(true);
    expect(await store.load()).toBe(directoryHandle);
  });

  it('preserves the legacy grant only for the page daemon', async () => {
    const { factory, db } = fakeIdb();
    db.seed('handles', 'directory', directoryHandle);
    const local = createDirectoryHandleStore(factory, '', PAGE_ORIGIN);
    const remote = createDirectoryHandleStore(
      factory,
      'https://remote.example',
      PAGE_ORIGIN,
    );

    expect(await local.load()).toBe(directoryHandle);
    expect(await remote.load()).toBeUndefined();
    expect(await remote.clear()).toBe(true);
    expect(await local.load()).toBe(directoryHandle);
    expect(await local.clear()).toBe(true);
    expect(await local.load()).toBeUndefined();
  });

  it('isolates remote grants and clearing by normalized daemon origin', async () => {
    const { factory } = fakeIdb();
    const local = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);
    const remote = createDirectoryHandleStore(
      factory,
      'https://remote.example',
      PAGE_ORIGIN,
    );
    const other = createDirectoryHandleStore(
      factory,
      'https://other.example',
      PAGE_ORIGIN,
    );
    const remoteHandle = {
      kind: 'directory',
      name: 'remote-share',
    } as FileSystemDirectoryHandle;
    await local.save(directoryHandle);
    expect(await remote.save(remoteHandle)).toBe(true);
    expect(await local.load()).toBe(directoryHandle);
    expect(await other.load()).toBeUndefined();
    const restored = createDirectoryHandleStore(
      factory,
      'https://REMOTE.example:443/',
      PAGE_ORIGIN,
    );
    expect(await restored.load()).toBe(remoteHandle);
    await other.save(directoryHandle);
    expect(await restored.clear()).toBe(true);
    expect(await remote.load()).toBeUndefined();
    expect(await other.load()).toBe(directoryHandle);
    expect(await local.load()).toBe(directoryHandle);
  });

  it('creates its object store on first open', async () => {
    const { factory, db } = fakeIdb();
    await createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN).save(
      directoryHandle,
    );
    expect(db.objectStoreNames.contains('handles')).toBe(true);
  });

  it('closes the database after every operation', async () => {
    const { factory, db } = fakeIdb();
    const store = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);
    await store.save(directoryHandle);
    await store.load();
    // A leaked connection would block any future version upgrade.
    expect(db.closed).toBe(true);
  });

  it('reports a miss as undefined', async () => {
    const { factory } = fakeIdb();
    expect(
      await createDirectoryHandleStore(
        factory,
        PAGE_ORIGIN,
        PAGE_ORIGIN,
      ).load(),
    ).toBeUndefined();
  });

  it('ignores a stored value that is not a directory handle', async () => {
    const { factory, db } = fakeIdb();
    const store = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);
    await store.save(directoryHandle);
    // Simulate a stale or foreign record under the same key.
    db.seed('handles', 'directory', { kind: 'file', name: 'x' });
    expect(await store.load()).toBeUndefined();
  });

  it('clears the stored grant', async () => {
    const { factory } = fakeIdb();
    const store = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);
    await store.save(directoryHandle);
    expect(await store.clear()).toBe(true);
    expect(await store.load()).toBeUndefined();
  });

  it('fails soft when IndexedDB cannot be opened', async () => {
    const { factory } = fakeIdb({ failOpen: true });
    const store = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);
    // Persistence is an optimization: a blocked storage context must degrade to
    // "ask the user again", never to an error the UI has to explain.
    expect(await store.save(directoryHandle)).toBe(false);
    expect(await store.load()).toBeUndefined();
    expect(await store.clear()).toBe(false);
  });

  it('closes a connection whose open succeeded after being blocked', async () => {
    const { factory, db } = fakeIdb({ blockedThenSuccess: true });
    const store = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);
    // The blocked event rejects the open (fail-soft); the success that can
    // still follow must close the fresh connection instead of leaking it.
    expect(await store.load()).toBeUndefined();
    expect(db.closed).toBe(true);
  });

  it('fails soft when a request fails', async () => {
    const { factory } = fakeIdb({ failRequests: true });
    const store = createDirectoryHandleStore(factory, PAGE_ORIGIN, PAGE_ORIGIN);
    expect(await store.save(directoryHandle)).toBe(false);
    expect(await store.load()).toBeUndefined();
  });
});
