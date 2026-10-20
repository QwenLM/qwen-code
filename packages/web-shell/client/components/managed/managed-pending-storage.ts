const DATABASE = 'qwen-managed-pending';
const STORE = 'requests';
const INLINE_BYTES = 128 * 1024;

async function request<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    let blocked = false;
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    opening.onsuccess = () => {
      if (blocked) opening.result.close();
      else resolve(opening.result);
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => {
      blocked = true;
      reject(new Error('Pending request database is blocked.'));
    };
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const operation = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(operation.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function reference(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return item['storage'] === 'indexeddb' &&
    typeof item['pendingId'] === 'string'
    ? item['pendingId']
    : undefined;
}

async function remove(id: string, key: string): Promise<void> {
  const stored: unknown = await request('readonly', (store) => store.get(id));
  if (
    stored &&
    typeof stored === 'object' &&
    (stored as Record<string, unknown>)['key'] === key
  )
    await request('readwrite', (store) => store.delete(id));
}

export async function readManagedPending(key: string): Promise<unknown> {
  const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
  const id = reference(stored);
  if (!id) return stored;
  const saved: unknown = await request('readonly', (store) => store.get(id));
  if (!saved || typeof saved !== 'object')
    throw new Error('The pending request could not be restored.');
  const item = saved as Record<string, unknown>;
  if (item['key'] !== key)
    throw new Error('The pending request belongs to another client.');
  return item['value'];
}

export async function saveManagedPending(
  key: string,
  value?: unknown,
): Promise<boolean> {
  let id: string | undefined;
  try {
    const stored = sessionStorage.getItem(key);
    let previous: string | undefined;
    try {
      previous = reference(JSON.parse(stored ?? 'null'));
    } catch {
      if (value !== undefined) return false;
    }
    if (value === undefined) sessionStorage.removeItem(key);
    else {
      const encoded = JSON.stringify(value);
      if (new TextEncoder().encode(encoded).byteLength <= INLINE_BYTES) {
        sessionStorage.setItem(key, encoded);
      } else {
        id = crypto.randomUUID();
        await request('readwrite', (store) => store.put({ key, value }, id));
        sessionStorage.setItem(
          key,
          JSON.stringify({ storage: 'indexeddb', pendingId: id }),
        );
      }
    }
    if (previous) await remove(previous, key).catch(() => undefined);
    return true;
  } catch {
    const failed = id;
    if (failed) await remove(failed, key).catch(() => undefined);
    return false;
  }
}
