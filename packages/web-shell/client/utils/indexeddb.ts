/**
 * Shared IndexedDB plumbing for the Web Shell.
 *
 * Every operation opens a fresh connection and resolves only on transaction
 * commit: a write acknowledged before `oncomplete` can still be lost if the
 * page goes away. A `blocked` open is not terminal — a success can still
 * follow — so a success that arrives after the rejection closes that fresh
 * connection instead of leaking one that would block future upgrades.
 */

export interface IndexedDbSchema {
  name: string;
  version: number;
  store: string;
  blockedMessage?: string;
}

export function openIndexedDatabase(
  idb: IDBFactory,
  schema: IndexedDbSchema,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(schema.name, schema.version);
    let discarded = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(schema.store)) {
        db.createObjectStore(schema.store);
      }
    };
    request.onsuccess = () => {
      if (discarded) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => {
      discarded = true;
      reject(
        new Error(
          schema.blockedMessage ??
            'IndexedDB open blocked by another connection',
        ),
      );
    };
  });
}

export async function runIndexedDbRequest<T>(
  idb: IDBFactory,
  schema: IndexedDbSchema,
  mode: IDBTransactionMode,
  issue: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openIndexedDatabase(idb, schema);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(schema.store, mode);
      const request = issue(tx.objectStore(schema.store));
      let value: T | undefined;
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
      tx.oncomplete = () => resolve(value as T);
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
}
