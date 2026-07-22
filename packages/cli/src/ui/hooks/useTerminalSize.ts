/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

interface TerminalSize {
  columns: number;
  rows: number;
}

function getTerminalSize(): TerminalSize {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

// A single `process.stdout` 'resize' listener is shared across every
// `useTerminalSize` instance. Each hook only adds its own `setState` callback
// to `subscribers`, so the listener count on `process.stdout` stays at 1 no
// matter how many components mount — otherwise Node emits a
// MaxListenersExceededWarning once 11+ consumers are mounted concurrently.
let currentSize: TerminalSize = getTerminalSize();
const subscribers = new Set<(size: TerminalSize) => void>();

function handleResize(): void {
  currentSize = getTerminalSize();
  for (const notify of subscribers) {
    notify(currentSize);
  }
}

function subscribe(callback: (size: TerminalSize) => void): () => void {
  if (subscribers.size === 0) {
    // First subscriber: refresh the snapshot (it may be stale if the terminal
    // resized while no listener was attached) and attach the shared listener.
    currentSize = getTerminalSize();
    process.stdout.on('resize', handleResize);
  }
  subscribers.add(callback);

  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      process.stdout.off('resize', handleResize);
    }
  };
}

/**
 * Returns the actual terminal size without any padding adjustments.
 * Components should handle their own margins/padding as needed.
 */
export function useTerminalSize(): TerminalSize {
  // Read `process.stdout` at render time (like the original per-instance hook)
  // so the first paint is always current, even if the terminal resized while no
  // hook was subscribed and the module snapshot went stale.
  const [size, setSize] = useState(getTerminalSize);

  useEffect(() => {
    const unsubscribe = subscribe(setSize);
    // `subscribe` refreshes the snapshot when it attaches the listener, so sync
    // to the latest value in case a resize happened before this effect ran.
    setSize(currentSize);
    return unsubscribe;
  }, []);

  return size;
}
