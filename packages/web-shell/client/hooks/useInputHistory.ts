import { useCallback, useEffect, useRef } from 'react';

const DEFAULT_STORAGE_KEY = 'qwen-web-shell-history';
const DEFAULT_SHELL_STORAGE_KEY = 'qwen-web-shell-command-history';
const MAX_HISTORY = 100;

export function getPromptHistoryStorageKey(workspaceCwd?: string): string {
  return workspaceCwd
    ? `${DEFAULT_STORAGE_KEY}:${encodeURIComponent(workspaceCwd)}`
    : DEFAULT_STORAGE_KEY;
}

export function getShellHistoryStorageKey(workspaceCwd?: string): string {
  return workspaceCwd
    ? `${DEFAULT_SHELL_STORAGE_KEY}:${encodeURIComponent(workspaceCwd)}`
    : DEFAULT_SHELL_STORAGE_KEY;
}

/**
 * Merges local entries with authoritative daemon entries (both oldest-to-newest).
 * Keeps unique local-only entries first so pre-existing browser history is not
 * lost, then appends canonical server entries at the newest tail.
 */
export function mergeRemoteInputHistory(
  localEntries: readonly string[],
  remoteEntries: readonly string[],
): string[] {
  const remoteSeen = new Set<string>();
  const remoteNewestFirst: string[] = [];
  for (let i = remoteEntries.length - 1; i >= 0; i--) {
    const entry = remoteEntries[i];
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      remoteSeen.has(entry)
    )
      continue;
    remoteSeen.add(entry);
    remoteNewestFirst.push(entry);
    if (remoteNewestFirst.length >= MAX_HISTORY) break;
  }
  const normalizedRemote = remoteNewestFirst.reverse();

  const localOnlyNewestFirst: string[] = [];
  const localSeen = new Set<string>(remoteSeen);
  const remainingSlots = MAX_HISTORY - normalizedRemote.length;
  if (remainingSlots > 0) {
    for (let i = localEntries.length - 1; i >= 0; i--) {
      const entry = localEntries[i];
      if (
        typeof entry !== 'string' ||
        entry.length === 0 ||
        localSeen.has(entry)
      ) {
        continue;
      }
      localSeen.add(entry);
      localOnlyNewestFirst.push(entry);
      if (localOnlyNewestFirst.length >= remainingSlots) break;
    }
  }
  return [...localOnlyNewestFirst.reverse(), ...normalizedRemote];
}

function readHistory(storageKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === 'string')
      : [];
  } catch {
    return null;
  }
}

function loadHistory(
  storageKey: string,
  fallbackStorageKey?: string,
): string[] | null {
  const history = readHistory(storageKey);
  return history?.length === 0 && fallbackStorageKey
    ? readHistory(fallbackStorageKey)
    : history;
}

function saveHistory(storageKey: string, history: string[]) {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(history.slice(-MAX_HISTORY)),
    );
    return true;
  } catch {
    // Ignore storage failures in private browsing or restricted contexts.
    return false;
  }
}

export function pushInputHistoryEntry(
  storageKey: string,
  text: string,
  fallbackStorageKey?: string,
): void {
  const history = loadHistory(storageKey, fallbackStorageKey) ?? [];
  if (history[history.length - 1] === text) {
    if (fallbackStorageKey && readHistory(storageKey)?.length === 0) {
      saveHistory(storageKey, history);
    }
    return;
  }
  history.push(text);
  if (history.length > MAX_HISTORY) history.shift();
  saveHistory(storageKey, history);
}

export function useInputHistory(
  storageKey = DEFAULT_STORAGE_KEY,
  fallbackStorageKey?: string,
) {
  const storageKeyRef = useRef(storageKey);
  const fallbackStorageKeyRef = useRef(fallbackStorageKey);
  const loadedStorageKeyRef = useRef(storageKey);
  const loadedFallbackStorageKeyRef = useRef(fallbackStorageKey);
  storageKeyRef.current = storageKey;
  fallbackStorageKeyRef.current = fallbackStorageKey;
  const historyRef = useRef<string[]>([]);
  const historyLoadedRef = useRef(false);
  const unsavedHistoryRef = useRef(false);
  if (!historyLoadedRef.current) {
    historyRef.current = loadHistory(storageKey, fallbackStorageKey) ?? [];
    historyLoadedRef.current = true;
  }
  const indexRef = useRef<number>(-1);
  const draftRef = useRef<string>('');
  const searchIndexRef = useRef<number>(-1);
  const mutationVersionRef = useRef<number>(0);

  useEffect(() => {
    if (
      loadedStorageKeyRef.current === storageKey &&
      loadedFallbackStorageKeyRef.current === fallbackStorageKey
    ) {
      return;
    }
    loadedStorageKeyRef.current = storageKey;
    loadedFallbackStorageKeyRef.current = fallbackStorageKey;
    historyRef.current = loadHistory(storageKey, fallbackStorageKey) ?? [];
    unsavedHistoryRef.current = false;
    indexRef.current = -1;
    draftRef.current = '';
    searchIndexRef.current = -1;
    mutationVersionRef.current++;
  }, [fallbackStorageKey, storageKey]);

  const readCurrentHistory = useCallback(() => {
    if (unsavedHistoryRef.current) return historyRef.current;
    return (
      loadHistory(storageKeyRef.current, fallbackStorageKeyRef.current) ??
      historyRef.current
    );
  }, []);

  const getMutationVersion = useCallback(() => mutationVersionRef.current, []);

  const push = useCallback(
    (text: string) => {
      mutationVersionRef.current++;
      const h = readCurrentHistory();
      if (h[h.length - 1] === text) {
        if (
          unsavedHistoryRef.current ||
          (fallbackStorageKeyRef.current &&
            readHistory(storageKeyRef.current)?.length === 0)
        ) {
          unsavedHistoryRef.current = !saveHistory(storageKeyRef.current, h);
        }
        return;
      }
      historyRef.current = h;
      h.push(text);
      if (h.length > MAX_HISTORY) h.shift();
      unsavedHistoryRef.current = !saveHistory(storageKeyRef.current, h);
      indexRef.current = -1;
    },
    [readCurrentHistory],
  );

  const applyRemoteEntries = useCallback(
    (
      remoteEntries: readonly string[],
      expectedMutationVersion?: number,
    ): boolean => {
      if (
        expectedMutationVersion !== undefined &&
        expectedMutationVersion !== mutationVersionRef.current
      ) {
        return false;
      }
      const current = readCurrentHistory();
      const merged = mergeRemoteInputHistory(current, remoteEntries);
      if (
        merged.length === current.length &&
        merged.every((entry, idx) => entry === current[idx])
      ) {
        return false;
      }
      const saved = saveHistory(storageKeyRef.current, merged);
      unsavedHistoryRef.current = !saved;
      if (indexRef.current === -1 || !saved) {
        historyRef.current = merged;
      }
      return true;
    },
    [readCurrentHistory],
  );

  const navigateUp = useCallback(
    (currentText: string): string | null => {
      if (indexRef.current === -1) {
        // A deferred acceptance can write history after the workspace changes.
        historyRef.current = readCurrentHistory();
      }
      const h = historyRef.current;
      if (h.length === 0) return null;

      if (indexRef.current === -1) {
        draftRef.current = currentText;
        indexRef.current = h.length - 1;
      } else if (indexRef.current > 0) {
        indexRef.current--;
      } else {
        return null;
      }

      return h[indexRef.current];
    },
    [readCurrentHistory],
  );

  const navigateDown = useCallback((): string | null => {
    const h = historyRef.current;
    if (indexRef.current === -1) return null;

    if (indexRef.current < h.length - 1) {
      indexRef.current++;
      return h[indexRef.current];
    } else {
      indexRef.current = -1;
      return draftRef.current;
    }
  }, []);

  const isNavigating = useCallback(() => indexRef.current !== -1, []);

  const reset = useCallback(() => {
    indexRef.current = -1;
    searchIndexRef.current = -1;
  }, []);

  const searchReverse = useCallback(
    (query: string): string | null => {
      if (searchIndexRef.current === -1 && indexRef.current === -1) {
        historyRef.current = readCurrentHistory();
      }
      const h = historyRef.current;
      if (h.length === 0 || !query) return null;

      const startIdx =
        searchIndexRef.current === -1
          ? h.length - 1
          : searchIndexRef.current - 1;

      if (startIdx < 0) {
        searchIndexRef.current = -1;
        return null;
      }

      const lowerQuery = query.toLowerCase();
      for (let i = startIdx; i >= 0; i--) {
        if (h[i].toLowerCase().includes(lowerQuery)) {
          searchIndexRef.current = i;
          return h[i];
        }
      }

      searchIndexRef.current = -1;
      return null;
    },
    [readCurrentHistory],
  );

  const getReverseMatches = useCallback(
    (query: string): string[] => {
      const lowerQuery = query.trim().toLowerCase();
      return readCurrentHistory()
        .slice()
        .reverse()
        .filter(
          (item) => !lowerQuery || item.toLowerCase().includes(lowerQuery),
        );
    },
    [readCurrentHistory],
  );

  const getLastEntry = useCallback(
    (filter?: (entry: string) => boolean): string | null => {
      const h = readCurrentHistory();
      if (!filter) return h.length > 0 ? h[h.length - 1] : null;
      for (let i = h.length - 1; i >= 0; i--) {
        if (filter(h[i])) return h[i];
      }
      return null;
    },
    [readCurrentHistory],
  );

  const resetSearch = useCallback(() => {
    searchIndexRef.current = -1;
  }, []);

  return {
    push,
    applyRemoteEntries,
    getMutationVersion,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    searchReverse,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  };
}
