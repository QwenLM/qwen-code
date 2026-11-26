import { useCallback, useEffect, useRef } from 'react';
import {
  MAX_INPUT_HISTORY_ENTRIES,
  MAX_INPUT_HISTORY_ENTRY_CHARS,
} from '@qwen-code/qwen-code-core/utils/input-history.js';

const DEFAULT_STORAGE_KEY = 'qwen-web-shell-history';
const DEFAULT_SHELL_STORAGE_KEY = 'qwen-web-shell-command-history';
const MAX_HISTORY = MAX_INPUT_HISTORY_ENTRIES;
const MAX_PENDING_REMOTE_ENTRIES = MAX_HISTORY;
const MAX_MISSED_SNAPSHOTS = 2;

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
  previousRemoteEntries: readonly string[] | null = [],
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
  // Missing provenance makes the old window ambiguous. Never infer that all
  // its entries were remote and discard independent local history from text
  // overlap alone.
  for (const entry of previousRemoteEntries ?? []) remoteSeen.add(entry);

  const localOnlyNewestFirst: string[] = [];
  for (let i = localEntries.length - 1; i >= 0; i--) {
    const entry = localEntries[i];
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      remoteSeen.has(entry)
    ) {
      continue;
    }
    remoteSeen.add(entry);
    localOnlyNewestFirst.push(entry);
    if (localOnlyNewestFirst.length >= MAX_HISTORY) break;
  }

  const local = localOnlyNewestFirst.reverse();
  const retainedLocals =
    normalizedRemote.length === 0
      ? local
      : local.slice(-Math.min(local.length, MAX_HISTORY - 1));
  const remoteSlots = MAX_HISTORY - retainedLocals.length;
  // Preserve independent local entries ahead of older remote entries, but
  // keep an incoming remote item visible when local history fills the window.
  return [
    ...retainedLocals,
    ...normalizedRemote.slice(
      Math.max(0, normalizedRemote.length - remoteSlots),
    ),
  ];
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

interface PendingRemoteEntry {
  text: string;
  seenRemoteRevision?: string;
  missedRemoteSnapshots: number;
  hadLocalBefore?: boolean;
}

function getPendingRemoteStorageKey(storageKey: string): string {
  return `${storageKey}:pending-remote`;
}

function getRemoteSourceStorageKey(storageKey: string): string {
  return `${storageKey}:remote-source`;
}

function loadRemoteSource(storageKey: string): Set<string> | null {
  const sourceKey = getRemoteSourceStorageKey(storageKey);
  try {
    if (localStorage.getItem(sourceKey) === null) return null;
    const entries = readHistory(sourceKey);
    return entries === null ? null : new Set(entries);
  } catch {
    // Do not discard local history just because provenance cannot be read.
    return new Set();
  }
}

function loadPendingRemoteHistory(storageKey: string): PendingRemoteEntry[] {
  try {
    const raw = localStorage.getItem(getPendingRemoteStorageKey(storageKey));
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const entries: PendingRemoteEntry[] = [];
    for (const value of data) {
      let entry: PendingRemoteEntry;
      if (typeof value === 'string') {
        entry = {
          text: value,
          missedRemoteSnapshots: 0,
          hadLocalBefore: true,
        };
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const candidate = value as Record<string, unknown>;
        if (typeof candidate['text'] !== 'string') continue;
        const missed = candidate['missedRemoteSnapshots'];
        entry = {
          text: candidate['text'],
          ...(candidate['hadLocalBefore'] === true
            ? { hadLocalBefore: true }
            : {}),
          ...(typeof candidate['seenRemoteRevision'] === 'string'
            ? { seenRemoteRevision: candidate['seenRemoteRevision'] }
            : {}),
          missedRemoteSnapshots:
            typeof missed === 'number' && Number.isFinite(missed)
              ? Math.min(
                  MAX_MISSED_SNAPSHOTS - 1,
                  Math.max(0, Math.floor(missed)),
                )
              : 0,
        };
      } else {
        continue;
      }
      const text = entry.text.trim();
      if (text.length === 0 || text.length > MAX_INPUT_HISTORY_ENTRY_CHARS) {
        continue;
      }
      const duplicate = entries.findIndex(
        (candidate) => candidate.text.trim() === text,
      );
      if (duplicate !== -1) entries.splice(duplicate, 1);
      if (entry.hadLocalBefore !== true) delete entry.hadLocalBefore;
      entries.push({ ...entry, text });
    }
    return entries.slice(-MAX_PENDING_REMOTE_ENTRIES);
  } catch {
    return [];
  }
}

function savePendingRemoteHistory(
  storageKey: string,
  pending: readonly PendingRemoteEntry[],
): void {
  try {
    localStorage.setItem(
      getPendingRemoteStorageKey(storageKey),
      JSON.stringify(pending.slice(-MAX_PENDING_REMOTE_ENTRIES)),
    );
  } catch {
    // Remote confirmation remains best-effort when browser storage is unavailable.
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
  remoteHistoryEnabled = false,
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
  const pendingRemoteEntriesRef = useRef<PendingRemoteEntry[]>([]);
  const remoteSourceRef = useRef<Set<string> | null>(null);
  if (!historyLoadedRef.current) {
    historyRef.current = loadHistory(storageKey, fallbackStorageKey) ?? [];
    pendingRemoteEntriesRef.current = loadPendingRemoteHistory(storageKey);
    remoteSourceRef.current = loadRemoteSource(storageKey);
    historyLoadedRef.current = true;
  }
  const indexRef = useRef<number>(-1);
  const draftRef = useRef<string>('');
  const searchIndexRef = useRef<number>(-1);
  const mutationVersionRef = useRef<number>(0);
  const remoteHistoryEnabledRef = useRef(remoteHistoryEnabled);
  remoteHistoryEnabledRef.current = remoteHistoryEnabled;
  const seenRemoteRevisionRef = useRef<string | undefined>(undefined);

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
    pendingRemoteEntriesRef.current = loadPendingRemoteHistory(storageKey);
    remoteSourceRef.current = loadRemoteSource(storageKey);
    seenRemoteRevisionRef.current = undefined;
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
      const h = readCurrentHistory();
      mutationVersionRef.current++;
      if (remoteHistoryEnabledRef.current) {
        const normalized = text.trim();
        const previous = pendingRemoteEntriesRef.current.find(
          (entry) => entry.text === normalized,
        );
        const next = pendingRemoteEntriesRef.current.filter(
          (entry) => entry.text !== normalized,
        );
        if (
          normalized.length > 0 &&
          normalized.length <= MAX_INPUT_HISTORY_ENTRY_CHARS
        ) {
          next.push({
            ...previous,
            text: normalized,
            ...(previous === undefined &&
            h.some((entry) => entry.trim() === normalized) &&
            remoteSourceRef.current?.has(normalized) !== true
              ? { hadLocalBefore: true }
              : {}),
            seenRemoteRevision: seenRemoteRevisionRef.current,
            missedRemoteSnapshots: 0,
          });
        }
        pendingRemoteEntriesRef.current = next.slice(
          -MAX_PENDING_REMOTE_ENTRIES,
        );
        savePendingRemoteHistory(
          storageKeyRef.current,
          pendingRemoteEntriesRef.current,
        );
      }
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
      remoteRevision?: string,
    ): boolean => {
      if (
        expectedMutationVersion !== undefined &&
        expectedMutationVersion !== mutationVersionRef.current
      ) {
        return false;
      }
      const current = readCurrentHistory();
      const normalizedRevision =
        typeof remoteRevision === 'string' ? remoteRevision.trim() : undefined;
      if (normalizedRevision) {
        seenRemoteRevisionRef.current = normalizedRevision;
      }
      const remoteSet = new Set(remoteEntries);
      const previouslyPendingSet = new Set(
        (remoteHistoryEnabledRef.current
          ? pendingRemoteEntriesRef.current
          : []
        ).map((entry) => entry.text),
      );
      const confirmedPending = new Set<string>();
      const expiredPending = new Set<string>();
      const preservedLocalExpired = new Set<string>();
      const pending: PendingRemoteEntry[] = [];
      if (remoteHistoryEnabledRef.current) {
        for (const entry of pendingRemoteEntriesRef.current) {
          if (remoteSet.has(entry.text)) {
            confirmedPending.add(entry.text);
            continue;
          }
          const entryLength = entry.text.trim().length;
          if (
            entryLength === 0 ||
            entryLength > MAX_INPUT_HISTORY_ENTRY_CHARS
          ) {
            if (!entry.hadLocalBefore) expiredPending.add(entry.text);
            else preservedLocalExpired.add(entry.text);
            continue;
          }
          if (
            !normalizedRevision ||
            !entry.seenRemoteRevision ||
            entry.seenRemoteRevision === normalizedRevision
          ) {
            pending.push({
              ...entry,
              seenRemoteRevision:
                entry.seenRemoteRevision || normalizedRevision,
            });
            continue;
          }
          if (entry.missedRemoteSnapshots + 1 < MAX_MISSED_SNAPSHOTS) {
            pending.push({
              ...entry,
              seenRemoteRevision: normalizedRevision,
              missedRemoteSnapshots: entry.missedRemoteSnapshots + 1,
            });
          } else if (!entry.hadLocalBefore) {
            expiredPending.add(entry.text);
          } else {
            preservedLocalExpired.add(entry.text);
          }
        }
        pendingRemoteEntriesRef.current = pending;
        savePendingRemoteHistory(storageKeyRef.current, pending);
      }
      const beforeMerge = current.filter(
        (entry) =>
          (!confirmedPending.has(entry.trim()) &&
            !expiredPending.has(entry.trim()) &&
            !previouslyPendingSet.has(entry.trim())) ||
          preservedLocalExpired.has(entry.trim()),
      );
      const merged = [
        ...mergeRemoteInputHistory(
          beforeMerge,
          remoteEntries,
          remoteSourceRef.current === null
            ? null
            : [...remoteSourceRef.current],
        ),
        ...pending.map((entry) => entry.text),
      ].slice(-MAX_HISTORY);
      // Remember only remote entries that survived into this bounded merged
      // window. Older entries evicted by the daemon must not become local-only.
      remoteSourceRef.current = new Set(
        remoteEntries.filter((entry) => merged.includes(entry)),
      );
      saveHistory(getRemoteSourceStorageKey(storageKeyRef.current), [
        ...remoteSourceRef.current,
      ]);
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

  const endNavigation = useCallback((): string | null => {
    if (indexRef.current === -1) return null;
    indexRef.current = -1;
    return draftRef.current;
  }, []);

  const navigateDown = useCallback((): string | null => {
    const h = historyRef.current;
    if (indexRef.current === -1) return null;

    if (indexRef.current < h.length - 1) {
      indexRef.current++;
      return h[indexRef.current];
    }
    return endNavigation();
  }, [endNavigation]);

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
    endNavigation,
    isNavigating,
    reset,
    searchReverse,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  };
}
