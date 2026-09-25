const STORAGE_PREFIX = 'qwen-code-web-shell-completed-unread:';

export function getCompletedUnreadStorageKey(baseUrl?: string): string {
  try {
    const url = new URL(baseUrl || '/', window.location.href);
    return `${STORAGE_PREFIX}${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return `${STORAGE_PREFIX}${baseUrl ?? ''}`;
  }
}

export function readCompletedUnreadIds(storageKey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCompletedUnreadIds(
  storageKey: string,
  ids: ReadonlySet<string>,
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...ids]));
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}
