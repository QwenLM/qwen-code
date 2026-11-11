/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HintRegistryAPI {
  /**
   * Register hints from a child component. Returns an unregister function.
   * The `id` should be stable (e.g. component name or unique key).
   */
  register: (id: string, hints: ShortcutHint[]) => () => void;
  /** Subscribe to hint changes (for useSyncExternalStore) */
  subscribe: (listener: () => void) => () => void;
  /** Get current snapshot of all registered hints */
  getSnapshot: () => ShortcutHint[];
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const HintRegistryContext = createContext<HintRegistryAPI | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provides a HintRegistry to child components. Parent containers (e.g. BTD)
 * wrap their children with this provider and read registered hints via
 * `useRegisteredHints()`.
 */
export function HintRegistryProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const registryRef = useRef<Map<string, ShortcutHint[]>>(new Map());
  const listenersRef = useRef<Set<() => void>>(new Set());
  const snapshotRef = useRef<ShortcutHint[]>([]);

  const notify = useCallback(() => {
    // Rebuild snapshot
    const all: ShortcutHint[] = [];
    for (const hints of registryRef.current.values()) {
      all.push(...hints);
    }
    snapshotRef.current = all.sort((a, b) => a.order - b.order);
    // Notify subscribers
    for (const listener of listenersRef.current) {
      listener();
    }
  }, []);

  const register = useCallback(
    (id: string, hints: ShortcutHint[]) => {
      registryRef.current.set(id, hints);
      notify();
      return () => {
        registryRef.current.delete(id);
        notify();
      };
    },
    [notify],
  );

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const getSnapshot = useCallback(() => snapshotRef.current, []);

  const api = useRef<HintRegistryAPI>({ register, subscribe, getSnapshot });

  return (
    <HintRegistryContext.Provider value={api.current}>
      {children}
    </HintRegistryContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer hooks
// ---------------------------------------------------------------------------

/**
 * Register hints from a child component into the nearest HintRegistry.
 * Call this in child content components (e.g. SettingsListPanel inside BaseTabDialog)
 * so that their hints bubble up to the parent container's footer.
 *
 * @param id - Stable identifier for dedup (e.g. "SettingsListPanel")
 * @param hints - The hints to register
 */
export function useRegisterHints(id: string, hints: ShortcutHint[]): void {
  const registry = useContext(HintRegistryContext);
  // Serialize hints for dependency comparison
  const hintsKey = JSON.stringify(hints);

  React.useEffect(() => {
    if (!registry) return;
    const unregister = registry.register(id, hints);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hintsKey is the stable comparison
  }, [registry, id, hintsKey]);
}

/**
 * Read all registered child hints from the nearest HintRegistry.
 * Used by parent containers (e.g. BTD) to include child hints
 * in their footer.
 */
export function useRegisteredHints(): ShortcutHint[] {
  const registry = useContext(HintRegistryContext);
  return useSyncExternalStore(
    registry?.subscribe ?? (() => () => {}),
    registry?.getSnapshot ?? (() => []),
  );
}
