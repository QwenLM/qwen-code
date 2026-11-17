/**
 * Persistence for the granted directory handle.
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so IndexedDB keeps the
 * grant across reloads; without it every refresh would force the user back
 * through the native picker. IndexedDB can itself be unavailable (a blocked or
 * partitioned storage context), so every method fails soft — the caller treats
 * a miss as "ask again", never as an error.
 */

import { runIndexedDbRequest, type IndexedDbSchema } from '../utils/indexeddb';

const DB_NAME = 'qwen-local-files';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const KEY = 'directory';

const SCHEMA: IndexedDbSchema = {
  name: DB_NAME,
  version: DB_VERSION,
  store: STORE_NAME,
};

export interface DirectoryHandleStore {
  save(handle: FileSystemDirectoryHandle): Promise<boolean>;
  load(): Promise<FileSystemDirectoryHandle | undefined>;
  clear(): Promise<boolean>;
}

export function createDirectoryHandleStore(
  idb: IDBFactory,
  baseUrl: string,
  pageOrigin: string,
): DirectoryHandleStore {
  const daemonOrigin = new URL(baseUrl, pageOrigin).origin;
  const key =
    daemonOrigin === new URL(pageOrigin).origin
      ? KEY
      : `${KEY}:${daemonOrigin}`;
  return {
    async save(handle) {
      try {
        await runIndexedDbRequest(idb, SCHEMA, 'readwrite', (store) =>
          store.put(handle, key),
        );
        return true;
      } catch {
        return false;
      }
    },
    async load() {
      try {
        const stored = await runIndexedDbRequest(
          idb,
          SCHEMA,
          'readonly',
          (store) => store.get(key),
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
        await runIndexedDbRequest(idb, SCHEMA, 'readwrite', (store) =>
          store.delete(key),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
