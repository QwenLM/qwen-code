const STORAGE_PREFIX = 'qwen-code-web-shell-completed-unread:';

export interface CompletedUnreadUpdate {
  add?: Iterable<string>;
  remove?: Iterable<string>;
}

const listeners = new Set<{
  storageKey: string;
  callback: (update: CompletedUnreadUpdate, persisted: boolean) => void;
}>();

export function getCompletedUnreadStorageKey(baseUrl?: string): string {
  try {
    const url = new URL(baseUrl || '/', window.location.href);
    return `${STORAGE_PREFIX}${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return `${STORAGE_PREFIX}${baseUrl ?? ''}`;
  }
}

export function readCompletedUnreadIds(storageKey: string): Set<string> | null {
  try {
    const prefix = `${storageKey}\0`;
    const ids = new Set<string>();
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (
        key?.startsWith(prefix) &&
        key.length > prefix.length &&
        window.localStorage.getItem(key) === '1'
      ) {
        ids.add(key.slice(prefix.length));
      }
    }
    return ids;
  } catch {
    return null;
  }
}

export function updateCompletedUnreadIds(
  storageKey: string,
  update: CompletedUnreadUpdate,
): void {
  const add = [...(update.add ?? [])].filter(Boolean);
  const remove = [...(update.remove ?? [])].filter(Boolean);
  let persisted = true;
  // Independent keys keep another tab's stale snapshot from overwriting markers.
  for (const [ids, unread] of [
    [add, true],
    [remove, false],
  ] as const) {
    for (const id of ids) {
      try {
        const key = `${storageKey}\0${id}`;
        if (unread) window.localStorage.setItem(key, '1');
        else window.localStorage.removeItem(key);
      } catch {
        // Keep the in-memory update when browser storage is unavailable.
        persisted = false;
      }
    }
  }
  for (const listener of listeners) {
    if (listener.storageKey === storageKey) {
      listener.callback({ add, remove }, persisted);
    }
  }
}

export function subscribeCompletedUnreadIds(
  storageKey: string,
  callback: (update: CompletedUnreadUpdate, persisted: boolean) => void,
): () => void {
  const listener = { storageKey, callback };
  listeners.add(listener);
  return () => listeners.delete(listener);
}
