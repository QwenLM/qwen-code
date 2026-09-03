/**
 * Persistence for the granted directory handle.
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so IndexedDB keeps the
 * grant across reloads; without it every refresh would force the user back
 * through the native picker. IndexedDB can itself be unavailable (a blocked or
 * partitioned storage context), so every method fails soft — the caller treats
 * a miss as "ask again", never as an error.
 */

const DB_NAME = 'qwen-local-files';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const KEY = 'directory';

export interface DirectoryHandleStore {
  save(handle: FileSystemDirectoryHandle): Promise<boolean>;
  load(): Promise<FileSystemDirectoryHandle | undefined>;
  clear(): Promise<boolean>;
}

function openDatabase(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () =>
      reject(new Error('IndexedDB open blocked by another connection'));
  });
}

async function runRequest<T>(
  idb: IDBFactory,
  mode: IDBTransactionMode,
  issue: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase(idb);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = issue(tx.objectStore(STORE_NAME));
      let value: T | undefined;
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
      // Resolve on commit, not on request success: the whole point of storing
      // the handle is that it survives a reload, and a write acknowledged
      // before `oncomplete` can still be lost if the page goes away.
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

export function createDirectoryHandleStore(
  idb: IDBFactory,
): DirectoryHandleStore {
  return {
    async save(handle) {
      try {
        await runRequest(idb, 'readwrite', (store) => store.put(handle, KEY));
        return true;
      } catch {
        return false;
      }
    },
    async load() {
      try {
        const stored = await runRequest(idb, 'readonly', (store) =>
          store.get(KEY),
        );
        // Only a directory handle is a valid stored grant; anything else (a
        // stale value from another feature, a corrupted record) is a miss.
        return (stored as { kind?: unknown } | undefined)?.kind === 'directory'
          ? (stored as FileSystemDirectoryHandle)
          : undefined;
      } catch {
        return undefined;
      }
    },
    async clear() {
      try {
        await runRequest(idb, 'readwrite', (store) => store.delete(KEY));
        return true;
      } catch {
        return false;
      }
    },
  };
}
