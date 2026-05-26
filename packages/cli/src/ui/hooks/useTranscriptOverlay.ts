/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useState } from 'react';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';

/**
 * Snapshot captured when the user enters the transcript overlay
 * (Ctrl+O). The overlay slices the live history / pending arrays at
 * these lengths so the user sees a frozen view while the underlying
 * stream continues to grow in the background. Exit (Esc or Ctrl+O
 * again) restores the live view.
 *
 * Modelled after Claude Code's `frozenTranscriptState`
 * (`src/screens/REPL.tsx:1325-1328`): we keep only length integers,
 * not array clones, so the snapshot is O(1) memory.
 */
export interface FrozenSnapshot {
  historyLength: number;
  pendingHistoryLength: number;
  frozenAt: number;
}

export interface TranscriptOverlayApi {
  snapshot: FrozenSnapshot | null;
  isActive: boolean;
  enter: (
    history: readonly HistoryItem[],
    pendingHistoryItems: readonly HistoryItemWithoutId[],
  ) => void;
  exit: () => void;
}

export function useTranscriptOverlay(): TranscriptOverlayApi {
  const [snapshot, setSnapshot] = useState<FrozenSnapshot | null>(null);

  const enter = useCallback(
    (
      history: readonly HistoryItem[],
      pendingHistoryItems: readonly HistoryItemWithoutId[],
    ) => {
      setSnapshot({
        historyLength: history.length,
        pendingHistoryLength: pendingHistoryItems.length,
        frozenAt: Date.now(),
      });
    },
    [],
  );

  const exit = useCallback(() => {
    setSnapshot(null);
  }, []);

  // Memoise the returned object so consumers that pass it as a
  // dependency (e.g. AppContainer's global keypress callback) don't
  // re-bind on every render. Without this, every streaming chunk would
  // re-register the global keypress handler.
  return useMemo<TranscriptOverlayApi>(
    () => ({
      snapshot,
      isActive: snapshot !== null,
      enter,
      exit,
    }),
    [snapshot, enter, exit],
  );
}
