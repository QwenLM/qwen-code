import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_STORAGE_KEY = 'qwen-web-shell-history';
const MAX_HISTORY = 100;

export function getPromptHistoryStorageKey(workspaceCwd?: string): string {
  return workspaceCwd
    ? `${DEFAULT_STORAGE_KEY}:${encodeURIComponent(workspaceCwd)}`
    : DEFAULT_STORAGE_KEY;
}

function readHistory(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

function loadHistory(
  storageKey: string,
  fallbackStorageKey?: string,
): string[] {
  const history = readHistory(storageKey);
  return history.length === 0 && fallbackStorageKey
    ? readHistory(fallbackStorageKey)
    : history;
}

function saveHistory(storageKey: string, history: string[]) {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(history.slice(-MAX_HISTORY)),
    );
  } catch {
    // Ignore storage failures in private browsing or restricted contexts.
  }
}

export function pushInputHistoryEntry(
  storageKey: string,
  text: string,
  fallbackStorageKey?: string,
): void {
  const history = loadHistory(storageKey, fallbackStorageKey);
  if (history[history.length - 1] === text) {
    if (fallbackStorageKey && readHistory(storageKey).length === 0) {
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
  if (!historyLoadedRef.current) {
    historyRef.current = loadHistory(storageKey, fallbackStorageKey);
    historyLoadedRef.current = true;
  }
  const indexRef = useRef<number>(-1);
  const draftRef = useRef<string>('');
  const searchIndexRef = useRef<number>(-1);
  // Drives the enabled/disabled state of the history nav buttons. canUp: an
  // older entry exists to recall; canDown: currently browsing history (a newer
  // entry or the saved draft to return to).
  const [nav, setNav] = useState(() => ({
    canUp: historyRef.current.length > 0,
    canDown: false,
  }));
  const syncNav = useCallback(() => {
    const h = historyRef.current;
    const i = indexRef.current;
    setNav({
      canUp: h.length > 0 && (i === -1 || i > 0),
      canDown: i !== -1,
    });
  }, []);

  useEffect(() => {
    if (
      loadedStorageKeyRef.current === storageKey &&
      loadedFallbackStorageKeyRef.current === fallbackStorageKey
    ) {
      return;
    }
    loadedStorageKeyRef.current = storageKey;
    loadedFallbackStorageKeyRef.current = fallbackStorageKey;
    historyRef.current = loadHistory(storageKey, fallbackStorageKey);
    indexRef.current = -1;
    draftRef.current = '';
    searchIndexRef.current = -1;
    syncNav();
  }, [fallbackStorageKey, storageKey, syncNav]);

  const push = useCallback(
    (text: string) => {
      const h = historyRef.current;
      if (h[h.length - 1] === text) {
        if (
          fallbackStorageKeyRef.current &&
          readHistory(storageKeyRef.current).length === 0
        ) {
          saveHistory(storageKeyRef.current, h);
        }
        return;
      }
      h.push(text);
      if (h.length > MAX_HISTORY) h.shift();
      saveHistory(storageKeyRef.current, h);
      indexRef.current = -1;
      syncNav();
    },
    [syncNav],
  );

  const navigateUp = useCallback(
    (currentText: string): string | null => {
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

      syncNav();
      return h[indexRef.current];
    },
    [syncNav],
  );

  const navigateDown = useCallback((): string | null => {
    const h = historyRef.current;
    if (indexRef.current === -1) return null;

    if (indexRef.current < h.length - 1) {
      indexRef.current++;
      syncNav();
      return h[indexRef.current];
    } else {
      indexRef.current = -1;
      syncNav();
      return draftRef.current;
    }
  }, [syncNav]);

  const isNavigating = useCallback(() => indexRef.current !== -1, []);

  const reset = useCallback(() => {
    indexRef.current = -1;
    searchIndexRef.current = -1;
    syncNav();
  }, [syncNav]);

  const searchReverse = useCallback((query: string): string | null => {
    const h = historyRef.current;
    if (h.length === 0 || !query) return null;

    const startIdx =
      searchIndexRef.current === -1 ? h.length - 1 : searchIndexRef.current - 1;

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
  }, []);

  const getReverseMatches = useCallback((query: string): string[] => {
    const lowerQuery = query.trim().toLowerCase();
    return historyRef.current
      .slice()
      .reverse()
      .filter((item) => !lowerQuery || item.toLowerCase().includes(lowerQuery));
  }, []);

  const getLastEntry = useCallback(
    (filter?: (entry: string) => boolean): string | null => {
      const h = historyRef.current;
      if (!filter) return h.length > 0 ? h[h.length - 1] : null;
      for (let i = h.length - 1; i >= 0; i--) {
        if (filter(h[i])) return h[i];
      }
      return null;
    },
    [],
  );

  const resetSearch = useCallback(() => {
    searchIndexRef.current = -1;
  }, []);

  return {
    push,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    searchReverse,
    getReverseMatches,
    getLastEntry,
    resetSearch,
    nav,
  };
}
