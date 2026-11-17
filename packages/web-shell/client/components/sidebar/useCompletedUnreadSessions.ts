import { useCallback, useEffect, useState } from 'react';
import {
  readCompletedUnreadIds,
  subscribeCompletedUnreadIds,
  updateCompletedUnreadIds,
  type CompletedUnreadUpdate,
} from './completedUnreadSessions';

export function useCompletedUnreadSessions(storageKey: string) {
  const [snapshot, setSnapshot] = useState(() => ({
    storageKey,
    ids: readCompletedUnreadIds(storageKey) ?? new Set<string>(),
  }));
  if (snapshot.storageKey !== storageKey) {
    setSnapshot({
      storageKey,
      ids: readCompletedUnreadIds(storageKey) ?? new Set<string>(),
    });
  }

  useEffect(() => {
    let storageAvailable = true;
    const replace = (ids: Set<string>) => {
      setSnapshot((current) =>
        current.storageKey !== storageKey ||
        (current.ids.size === ids.size &&
          [...ids].every((id) => current.ids.has(id)))
          ? current
          : { storageKey, ids },
      );
    };
    const reload = () => {
      if (!storageAvailable) return;
      const ids = readCompletedUnreadIds(storageKey);
      if (ids) replace(ids);
    };
    const unsubscribe = subscribeCompletedUnreadIds(
      storageKey,
      (update, persisted) => {
        // Quota failures can leave reads available but stale; retain memory state.
        storageAvailable &&= persisted;
        setSnapshot((current) => {
          if (current.storageKey !== storageKey) return current;
          const ids = new Set(current.ids);
          for (const id of update.add ?? []) ids.add(id);
          for (const id of update.remove ?? []) ids.delete(id);
          return current.ids.size === ids.size &&
            [...ids].every((id) => current.ids.has(id))
            ? current
            : { storageKey, ids };
        });
      },
    );
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(`${storageKey}\0`)) {
        // A queued event may predate a newer local clear; read the current value.
        reload();
      }
    };
    window.addEventListener('storage', handleStorage);
    reload();
    return () => {
      unsubscribe();
      window.removeEventListener('storage', handleStorage);
    };
  }, [storageKey]);

  const update = useCallback(
    (change: CompletedUnreadUpdate) =>
      updateCompletedUnreadIds(storageKey, change),
    [storageKey],
  );
  return [snapshot.ids, update] as const;
}
