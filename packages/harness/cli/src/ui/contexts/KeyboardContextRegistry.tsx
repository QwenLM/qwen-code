/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * KeyboardContextRegistry — named-context system for keyboard dispatch.
 *
 * Components declare which keyboard context they belong to via
 * `useRegisterKeyboardContext`. The registry tracks which contexts are
 * currently active and notifies subscribers when the active set changes.
 */

import type React from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Context name enum
// ---------------------------------------------------------------------------

/**
 * All keyboard contexts, ordered by conceptual layer.
 *
 * Layer 1: Always active
 * Layer 2: Main view
 * Layer 3: Overlay modes (stack on top of main views)
 * Layer 4: Modal overlays
 * Layer 5: Shared primitives (nested inside other contexts)
 */
export const KEYBOARD_CONTEXTS = [
  // Layer 1: Always active (handled separately — penetrating + non-penetrating)
  'Global',

  // Layer 2: Main view
  'Chat',

  // Layer 3: Overlay modes (mutually exclusive with main view keys via isActive)
  'Autocomplete',
  'AgentRail',
  'HistorySearch',
  'CommandSearch',
  'VimNormal',

  // Layer 4: Modal overlays
  'Dialog',
  'Fullscreen',

  // Layer 5: Shared primitives (embedded inside modals → later = wins)
  'Select',
  'Tabs',
  'Confirmation',
] as const;

export type KeyboardContextName = (typeof KEYBOARD_CONTEXTS)[number];

/**
 * Context declaration order — determines conflict resolution via
 * "last-one-wins" semantics (following the established registry approach).
 *
 * When multiple active contexts bind the same key, the context that
 * appears LATER in KEYBOARD_CONTEXTS wins. No numeric priority — just
 * structural declaration order.
 *
 * The order is already correct:
 *   Global (always, handled separately) → Chat (main view)
 *   → Autocomplete/HistorySearch/... (overlay modes)
 *   → Dialog/Fullscreen (modal overlays)
 *   → Select/Tabs/Confirmation (shared primitives, inside overlays)
 *
 * Shared primitives (Select, Tabs) appear AFTER modals (Dialog, Fullscreen)
 * because they are embedded inside modals — the inner component should win.
 */

/**
 * Derived declaration-order index for each context.
 * Used by the resolver to sort active contexts: higher index = checked first.
 *
 * This replaces the old `CONTEXT_LAYER_PRIORITY` numeric map.
 * The values are auto-generated from `KEYBOARD_CONTEXTS` array position,
 * so re-ordering the array is the ONLY way to change conflict resolution.
 */
export const CONTEXT_DECLARATION_ORDER: Record<KeyboardContextName, number> =
  Object.fromEntries(
    KEYBOARD_CONTEXTS.map((name, index) => [name, index]),
  ) as Record<KeyboardContextName, number>;

// ---------------------------------------------------------------------------
// Registry class (imperative, framework-agnostic)
// ---------------------------------------------------------------------------

type ChangeListener = () => void;

/**
 * Tracks which keyboard contexts are currently active.
 * Components register/unregister contexts; the resolver queries active set.
 */
export class KeyboardContextRegistry {
  /**
   * Reference-counted context registrations.
   * Multiple components can register the same context — only when the last
   * registration is removed does the context become inactive.
   */
  private readonly _refCounts = new Map<KeyboardContextName, number>();
  private readonly _listeners = new Set<ChangeListener>();

  /** Register a context as active (reference-counted). */
  registerContext(name: KeyboardContextName): void {
    const prev = this._refCounts.get(name) ?? 0;
    this._refCounts.set(name, prev + 1);
    if (prev === 0) {
      // Context just became active
      this._notify();
    }
  }

  /** Unregister a context (reference-counted — only deactivates at zero). */
  unregisterContext(name: KeyboardContextName): void {
    const prev = this._refCounts.get(name) ?? 0;
    if (prev <= 1) {
      this._refCounts.delete(name);
      if (prev === 1) {
        // Context just became inactive
        this._notify();
      }
    } else {
      this._refCounts.set(name, prev - 1);
    }
  }

  /** Get the current set of active contexts (read-only snapshot). */
  getActiveContexts(): ReadonlySet<KeyboardContextName> {
    return new Set(this._refCounts.keys());
  }

  /** Check if a specific context is active. */
  isActive(name: KeyboardContextName): boolean {
    return (this._refCounts.get(name) ?? 0) > 0;
  }

  /** Subscribe to changes in the active context set. Returns unsubscribe fn. */
  subscribe(listener: ChangeListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}

// ---------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------

const KeyboardContextRegistryContext =
  createContext<KeyboardContextRegistry | null>(null);

interface KeyboardContextProviderProps {
  children: React.ReactNode;
  /** Optional registry instance (useful for tests). */
  registry?: KeyboardContextRegistry;
}

/**
 * Provides a KeyboardContextRegistry to the component tree.
 * Must wrap all components that use `useRegisterKeyboardContext`.
 */
export const KeyboardContextProvider: React.FC<
  KeyboardContextProviderProps
> = ({ children, registry: registryProp }) => {
  // Create a stable registry instance if none provided
  const registryRef = useRef<KeyboardContextRegistry>(
    registryProp ?? new KeyboardContextRegistry(),
  );

  // If a prop registry is provided, use it (for tests)
  const registry = registryProp ?? registryRef.current;

  return (
    <KeyboardContextRegistryContext.Provider value={registry}>
      {children}
    </KeyboardContextRegistryContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Access the raw KeyboardContextRegistry instance.
 * Returns null if no KeyboardContextProvider is mounted (graceful degradation).
 */
export function useKeyboardContextRegistry(): KeyboardContextRegistry | null {
  return useContext(KeyboardContextRegistryContext);
}

/**
 * Register a keyboard context for the calling component.
 *
 * When `isActive` is true, the context is added to the active set.
 * When `isActive` is false (or on unmount), the context is removed.
 *
 * If no KeyboardContextProvider is mounted, this hook is a no-op.
 * This allows Phase 1 context registrations to coexist safely before
 * the Provider is added to the tree.
 *
 * Usage:
 * ```ts
 * useRegisterKeyboardContext('Chat', isChatActive);
 * ```
 */
export function useRegisterKeyboardContext(
  name: KeyboardContextName,
  isActive: boolean,
): void {
  const registry = useKeyboardContextRegistry();

  useLayoutEffect(() => {
    if (!registry) return undefined;

    if (isActive) {
      registry.registerContext(name);
      return () => {
        registry.unregisterContext(name);
      };
    }
    // If not active, ensure it's unregistered (idempotent)
    registry.unregisterContext(name);
    return undefined;
  }, [registry, name, isActive]);
}

/**
 * Subscribe to the active contexts and return them as React state.
 * Useful for debug panels or components that need to react to context changes.
 *
 * Returns an empty set if no KeyboardContextProvider is mounted.
 */
export function useActiveKeyboardContexts(): ReadonlySet<KeyboardContextName> {
  const registry = useKeyboardContextRegistry();
  const [, setTick] = useState(0);
  const emptySet = useRef<ReadonlySet<KeyboardContextName>>(new Set());

  useEffect(() => {
    if (!registry) return undefined;
    return registry.subscribe(() => {
      setTick((t) => t + 1);
    });
  }, [registry]);

  return registry ? registry.getActiveContexts() : emptySet.current;
}
