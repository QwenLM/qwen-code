/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

/**
 * Value published by a container (e.g. ChatViewer) that wants to issue
 * global "expand all" / "collapse all" commands to the collapsible
 * sections it renders.
 */
export interface ExpandControlContextValue {
  /**
   * Monotonic counter bumped every time a global expand/collapse command
   * is issued. Components sync to `expanded` only when this changes, so
   * unrelated re-renders never disturb their local toggle state.
   */
  signal: number;
  /** Target expanded state carried by the latest signal. */
  expanded: boolean;
}

/**
 * Context used to broadcast global expand/collapse commands.
 * Null when no ancestor provides the control — collapsible components
 * then behave exactly as before (purely local state).
 */
export const ExpandControlContext =
  createContext<ExpandControlContextValue | null>(null);

/**
 * Read the nearest global expand control, if any.
 */
export function useExpandControl(): ExpandControlContextValue | null {
  return useContext(ExpandControlContext);
}

/**
 * Local expanded state for a collapsible UI element that also obeys
 * global expand/collapse signals from the nearest
 * {@link ExpandControlContext}.
 *
 * - Without a provider: identical to `useState(defaultExpanded)`.
 * - With a provider: when a new global signal fires the local state is
 *   synced to the signal's target; individual toggles keep working and
 *   are not overridden until the next global signal.
 * - Mounting after a global signal inherits the latest target instead of
 *   falling back to the component default.
 */
export function useControlledExpanded(
  defaultExpanded = false,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const control = useContext(ExpandControlContext);
  const signal = control?.signal ?? 0;
  const [isExpanded, setIsExpanded] = useState(() =>
    control && signal > 0 ? control.expanded : defaultExpanded,
  );
  const [lastSignal, setLastSignal] = useState(signal);

  // Sync during render (React's "adjusting state while rendering" pattern)
  // instead of in an effect: an effect would let every consumer commit once
  // with its stale value before the sync fires, so each global command
  // would reconcile every collapsible section twice and land the visible
  // change one commit late. The previous signal is tracked in state rather
  // than a ref so the guard survives discarded render passes under
  // concurrent scheduling: a ref mutation persists even when React throws
  // the render away, permanently desyncing the consumer from the signal,
  // while a render-phase state update is re-applied on the retried render.
  if (signal !== lastSignal) {
    setLastSignal(signal);
    if (control && signal > 0) {
      setIsExpanded(control.expanded);
    }
  }

  return [isExpanded, setIsExpanded];
}
