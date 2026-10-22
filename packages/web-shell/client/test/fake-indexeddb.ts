/**
 * In-memory IndexedDB stand-in for jsdom.
 *
 * jsdom ships no IndexedDB, and the Web Shell's stores only need a single
 * object store with put/get/delete plus the request/transaction event order
 * they rely on (`onsuccess` before `oncomplete`, `onabort` on failure).
 *
 * `deferGets` holds every `get` until `releaseLoads()`, which is how tests
 * create a window where a restore is still reading while other work happens.
 *
 * Known gaps, all in the direction of being *more* forgiving than a browser:
 * values are stored by reference (no structured clone, so aliasing bugs are
 * invisible), a closed database still transacts, an unknown store yields a
 * throwaway map instead of throwing `NotFoundError`, the database name and
 * version and transaction mode are ignored, and requests settle in a microtask
 * rather than a task.
 */

type Handler = (() => void) | null;

export interface FakeIndexedDbOptions {
  failOpen?: boolean;
  failRequests?: boolean;
  /** Fires `blocked` first, then a success that must close its connection. */
  blockedThenSuccess?: boolean;
  /** Holds every `get` request until `releaseLoads()` is called. */
  deferGets?: boolean;
}

export interface FakeIndexedDb {
  factory: IDBFactory;
  db: FakeDatabase;
  stores: Map<string, Map<string, unknown>>;
  /** Settles every held `get` request, in issue order. */
  releaseLoads(): void;
}

class FakeRequest<T> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  private settled = false;
  private readonly settle?: (ok: boolean) => void;

  constructor(
    result?: T,
    error?: Error,
    settle?: (ok: boolean) => void,
    defer = false,
  ) {
    this.result = result;
    this.error = error ?? null;
    this.settle = settle;
    // The store attaches its handlers synchronously after issuing the request,
    // and the real IndexedDB never settles before that.
    if (!defer) queueMicrotask(() => this.complete());
  }

  complete(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.error) {
      this.onerror?.();
      this.settle?.(false);
      return;
    }
    this.onsuccess?.();
    this.settle?.(true);
  }
}

class FakeTransaction {
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;
  error: Error | null = null;

  constructor(
    private readonly data: Map<string, unknown>,
    private readonly failRequests: boolean,
    private readonly deferGets: boolean,
    private readonly pendingGets: Array<() => void>,
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
    const fail = () =>
      new FakeRequest<unknown>(undefined, new Error('request failed'), settle);
    return {
      put: (value, key) => {
        if (this.failRequests) {
          return fail() as FakeRequest<undefined>;
        }
        // Reference, not clone: see the header's fidelity note.
        this.data.set(String(key), value);
        return new FakeRequest<undefined>(undefined, undefined, settle);
      },
      get: (key) => {
        if (this.failRequests) return fail();
        if (this.deferGets) {
          const request = new FakeRequest<unknown>(
            this.data.get(String(key)),
            undefined,
            settle,
            true,
          );
          this.pendingGets.push(() => request.complete());
          return request;
        }
        return new FakeRequest<unknown>(
          this.data.get(String(key)),
          undefined,
          settle,
        );
      },
      delete: (key) => {
        if (this.failRequests) {
          return fail() as FakeRequest<undefined>;
        }
        this.data.delete(String(key));
        return new FakeRequest<undefined>(undefined, undefined, settle);
      },
    };
  }
}

export class FakeDatabase {
  closed = false;
  readonly objectStoreNames: { contains(name: string): boolean };

  constructor(
    private readonly stores: Map<string, Map<string, unknown>>,
    private readonly failRequests: boolean,
    private readonly deferGets: boolean,
    private readonly pendingGets: Array<() => void>,
  ) {
    this.objectStoreNames = {
      contains: (name: string) => this.stores.has(name),
    };
  }

  createObjectStore(name: string): void {
    this.stores.set(name, new Map<string, unknown>());
  }

  transaction(name: string): FakeTransaction {
    const data = this.stores.get(name) ?? new Map<string, unknown>();
    return new FakeTransaction(
      data,
      this.failRequests,
      this.deferGets,
      this.pendingGets,
    );
  }

  close(): void {
    this.closed = true;
  }

  /** Puts a record in place without going through a transaction. */
  seed(storeName: string, key: string, value: unknown): void {
    let store = this.stores.get(storeName);
    if (!store) {
      store = new Map<string, unknown>();
      this.stores.set(storeName, store);
    }
    store.set(key, value);
  }
}

export function createFakeIndexedDB(
  options: FakeIndexedDbOptions = {},
): FakeIndexedDb {
  const stores = new Map<string, Map<string, unknown>>();
  const pendingGets: Array<() => void> = [];
  const db = new FakeDatabase(
    stores,
    options.failRequests === true,
    options.deferGets === true,
    pendingGets,
  );
  let started = false;
  const open = () => {
    // A fresh request per open, like the real API: two concurrent opens that
    // shared one object would overwrite each other's handlers and strand the
    // loser's promise.
    const request = {
      result: db as unknown as IDBDatabase,
      error: null as Error | null,
      onsuccess: null as Handler,
      onerror: null as Handler,
      onblocked: null as Handler,
      onupgradeneeded: null as Handler,
    };
    queueMicrotask(() => {
      if (options.failOpen) {
        request.error = new Error('open failed');
        request.onerror?.();
        return;
      }
      if (options.blockedThenSuccess) {
        // `blocked` is not terminal: a success can still follow it.
        request.onblocked?.();
      }
      // The real IndexedDB fires this only when the version increases; the
      // first open of a fresh database is exactly that case.
      if (!started) {
        started = true;
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  };
  return {
    factory: { open } as unknown as IDBFactory,
    db,
    stores,
    releaseLoads() {
      while (pendingGets.length > 0) pendingGets.shift()!();
    },
  };
}
