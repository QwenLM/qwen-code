/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AppFocusContext — React bindings for the AppFocusStateMachine.
 *
 * Provides:
 * - `<AppFocusProvider>`: wraps the component tree, owns the state machine instance.
 * - `useAppFocus()`: read the current focus snapshot (triggers re-render on change).
 * - `useAppFocusActions()`: get the state machine instance for sending events.
 * - `useAppFocusEffect()`: bridge that syncs state machine → KeyboardContextRegistry.
 */

import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import type { KeyboardContextName } from '../contexts/KeyboardContextRegistry.js';
import { useKeyboardContextRegistry } from '../contexts/KeyboardContextRegistry.js';
import type { AppFocusSnapshot, BaseFocus } from './AppFocusStateMachine.js';
import { AppFocusStateMachine } from './AppFocusStateMachine.js';

// ---------------------------------------------------------------------------
// React contexts
// ---------------------------------------------------------------------------

const AppFocusMachineContext = createContext<AppFocusStateMachine | null>(null);

interface AppFocusProviderProps {
  children: React.ReactNode;
  /** Optional initial base focus (default: 'Chat'). */
  initialBase?: BaseFocus;
  /** Optional pre-created instance (useful for tests). */
  machine?: AppFocusStateMachine;
}

/**
 * Provides the AppFocusStateMachine to the component tree.
 *
 * Usage:
 * ```tsx
 * <AppFocusProvider>
 *   <KeyboardContextProvider>
 *     <App />
 *   </KeyboardContextProvider>
 * </AppFocusProvider>
 * ```
 */
export const AppFocusProvider: React.FC<AppFocusProviderProps> = ({
  children,
  initialBase = 'Chat',
  machine: machineProp,
}) => {
  const machineRef = useRef<AppFocusStateMachine>(
    machineProp ?? new AppFocusStateMachine(initialBase),
  );
  const machine = machineProp ?? machineRef.current;

  return (
    <AppFocusMachineContext.Provider value={machine}>
      {children}
    </AppFocusMachineContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Access the raw AppFocusStateMachine instance.
 * Use this to send events (transitions).
 *
 * Returns null if no provider is mounted (graceful degradation during migration).
 */
export function useAppFocusMachine(): AppFocusStateMachine | null {
  return useContext(AppFocusMachineContext);
}

/**
 * Read the current focus snapshot.
 * Re-renders the component when focus state changes.
 *
 * Uses `useSyncExternalStore` for tear-free reads.
 */
export function useAppFocus(): AppFocusSnapshot {
  const machine = useContext(AppFocusMachineContext);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!machine) return () => {};
      return machine.subscribe(onStoreChange);
    },
    [machine],
  );

  const getSnapshot = useCallback(() => {
    if (!machine) {
      return DEFAULT_SNAPSHOT;
    }
    return machine.getSnapshot();
  }, [machine]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const DEFAULT_SNAPSHOT: AppFocusSnapshot = {
  baseFocus: 'Chat',
  overlayStack: [],
  effectiveFocus: 'Chat',
};

/**
 * Bridge: syncs AppFocusStateMachine → KeyboardContextRegistry.
 *
 * When the state machine's active contexts change, this hook updates
 * the KeyboardContextRegistry to match — a single centralized sync point.
 *
 * **Managed contexts**: Global, Chat, Fullscreen, Dialog
 * **NOT managed**: Autocomplete, HistorySearch, CommandSearch, VimNormal, Select, Tabs,
 *   Confirmation — this has its own activation logic driven by
 *   component-local state (e.g. suggestions visible, search active).
 */
const MANAGED_CONTEXTS: KeyboardContextName[] = [
  'Global',
  'Chat',
  'Fullscreen',
  'Dialog',
];

export function useAppFocusContextSync(): void {
  const machine = useAppFocusMachine();
  const registry = useKeyboardContextRegistry();

  useEffect(() => {
    if (!machine || !registry) return undefined;

    // Initial sync
    syncContexts(machine, registry);

    // Subscribe to changes
    return machine.subscribe(() => {
      syncContexts(machine, registry);
    });
  }, [machine, registry]);
}

function syncContexts(
  machine: AppFocusStateMachine,
  registry: {
    registerContext: (name: KeyboardContextName) => void;
    unregisterContext: (name: KeyboardContextName) => void;
  },
): void {
  const active = machine.getActiveContexts();

  for (const ctx of MANAGED_CONTEXTS) {
    if (active.has(ctx)) {
      registry.registerContext(ctx);
    } else {
      registry.unregisterContext(ctx);
    }
  }
}
