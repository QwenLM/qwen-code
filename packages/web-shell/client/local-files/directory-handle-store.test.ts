import { describe, expect, it, vi } from 'vitest';
import { createDirectoryHandleStore } from './directory-handle-store.js';

/**
 * Fires success/error after the caller has attached its handlers, then tells
 * the owning transaction to auto-commit — the ordering the real IndexedDB
 * guarantees and the one `runRequest` depends on.
 */
class FakeRequest<T> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(result?: T, error?: Error, settle?: (ok: boolean) => void) {
    queueMicrotask(() => {
      if (error) {
        this.error = error;
        this.onerror?.();
        settle?.(false);
        return;
      }
      this.result = result;
      this.onsuccess?.();
      settle?.(true);
    });
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: Error | null = null;

  constructor(
    private readonly data: Map<string, unknown>,
    private readonly failRequests: boolean,
  ) {}

  objectStore(): {
    put(value: unknown, key: unknown): FakeRequest<undefined>;
    get(key: unknown): FakeRequest<unknown>;
    delete(key: unknown): FakeRequest<undefined>;
  } {
    const settle = (ok: boolean) => {
      queueMicrotask(() => {
        if (ok) this.oncomplete?.();
        else this.onabort?.();
      });
    };
    const fail = (message: string) =>
      new FakeRequest<unknown>(undefined, new Error(message), settle);
    return {
      put: (value, key) => {
        if (this.failRequests) {
          return fail('put failed') as FakeRequest<undefined>;
        }
        this.data.set(String(key), value);
        return new FakeRequest<undefined>(undefined, undefined, settle);
      },
      get: (key) => {
        if (this.failRequests) return fail('get failed');
        return new FakeRequest<unknown>(
          this.data.get(String(key)),
          undefined,
          settle,
        );
      },
      delete: (key) => {
        this.data.delete(String(key));
        return new FakeRequest<undefined>(undefined, undefined, settle);
      },
    };
  }
}

class FakeDatabase {
  closed = false;
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  constructor(
    private readonly stores: Map<string, Map<string, unknown>>,
    private readonly failRequests: boolean,
  ) {}
  createObjectStore(name: string): void {
    this.stores.set(name, new Map<string, unknown>());
  }
  transaction(name: string): FakeTransaction {
    const data = this.stores.get(name) ?? new Map<string, unknown>();
    return new FakeTransaction(data, this.failRequests);
  }
  close(): void {
    this.closed = true;
  }
  /** Test hook: put a foreign value under a key without going through IDB. */
  seed(storeName: string, key: string, value: unknown): void {
    let data = this.stores.get(storeName);
    if (!data) {
      data = new Map<string, unknown>();
      this.stores.set(storeName, data);
    }
    data.set(key, value);
  }
}

function fakeIdb(
  options: {
    failOpen?: boolean;
    failRequests?: boolean;
    blockedThenSuccess?: boolean;
  } = {},
) {
  const stores = new Map<string, Map<string, unknown>>();
  const db = new FakeDatabase(stores, options.failRequests === true);
  const open = vi.fn(() => {
    const request = {
      result: db as unknown as IDBDatabase,
      error: null as Error | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
    };
    queueMicrotask(() => {
      if (options.failOpen) {
        request.error = new Error('open failed');
        request.onerror?.();
        return;
      }
      if (options.blockedThenSuccess) {
        // `blocked` is not terminal: the open can still succeed afterwards.
        request.onblocked?.();
        queueMicrotask(() => request.onsuccess?.());
        return;
      }
      // The real IndexedDB only fires this on first creation; the store created
      // here is what makes the object store exist at all.
      if (!stores.has('handles')) db.createObjectStore('handles');
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  });
  return { db, factory: { open } as unknown as IDBFactory, open };
}

const directoryHandle = {
  kind: 'directory',
  name: 'ai_coding',
} as unknown as FileSystemDirectoryHandle;

describe('createDirectoryHandleStore', () => {
  it('round-trips the granted handle through IndexedDB', async () => {
    const { factory } = fakeIdb();
    const store = createDirectoryHandleStore(factory);

    expect(await store.save(directoryHandle)).toBe(true);
    expect(await store.load()).toBe(directoryHandle);
  });

  it('creates its object store on first open', async () => {
    const { factory, db } = fakeIdb();
    await createDirectoryHandleStore(factory).save(directoryHandle);
    expect(db.objectStoreNames.contains('handles')).toBe(true);
  });

  it('closes the database after every operation', async () => {
    const { factory, db } = fakeIdb();
    const store = createDirectoryHandleStore(factory);
    await store.save(directoryHandle);
    await store.load();
    // A leaked connection would block any future version upgrade.
    expect(db.closed).toBe(true);
  });

  it('reports a miss as undefined', async () => {
    const { factory } = fakeIdb();
    expect(await createDirectoryHandleStore(factory).load()).toBeUndefined();
  });

  it('ignores a stored value that is not a directory handle', async () => {
    const { factory, db } = fakeIdb();
    const store = createDirectoryHandleStore(factory);
    await store.save(directoryHandle);
    // Simulate a stale or foreign record under the same key.
    db.seed('handles', 'directory', { kind: 'file', name: 'x' });
    expect(await store.load()).toBeUndefined();
  });

  it('clears the stored grant', async () => {
    const { factory } = fakeIdb();
    const store = createDirectoryHandleStore(factory);
    await store.save(directoryHandle);
    expect(await store.clear()).toBe(true);
    expect(await store.load()).toBeUndefined();
  });

  it('fails soft when IndexedDB cannot be opened', async () => {
    const { factory } = fakeIdb({ failOpen: true });
    const store = createDirectoryHandleStore(factory);
    // Persistence is an optimization: a blocked storage context must degrade to
    // "ask the user again", never to an error the UI has to explain.
    expect(await store.save(directoryHandle)).toBe(false);
    expect(await store.load()).toBeUndefined();
    expect(await store.clear()).toBe(false);
  });

  it('closes a connection whose open succeeded after being blocked', async () => {
    const { factory, db } = fakeIdb({ blockedThenSuccess: true });
    const store = createDirectoryHandleStore(factory);
    // The blocked event rejects the open (fail-soft); the success that can
    // still follow must close the fresh connection instead of leaking it.
    expect(await store.load()).toBeUndefined();
    expect(db.closed).toBe(true);
  });

  it('fails soft when a request fails', async () => {
    const { factory } = fakeIdb({ failRequests: true });
    const store = createDirectoryHandleStore(factory);
    expect(await store.save(directoryHandle)).toBe(false);
    expect(await store.load()).toBeUndefined();
  });
});
