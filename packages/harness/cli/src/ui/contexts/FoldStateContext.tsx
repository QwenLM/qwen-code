/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  createContext,
  useContext,
  useCallback,
  useState,
  useMemo,
} from 'react';
import { FoldLevel, getNextFoldLevel } from '../constants/messageLayout.js';

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export interface FoldStateContextValue {
  /** Current global fold level applied to all tool groups without an override. */
  globalFoldLevel: FoldLevel;

  /**
   * Cycle through fold levels according to FOLD_CYCLE_MODE in messageLayout.ts.
   * 2-level: FullyExpanded(2) ↔ GroupExpandedToolCollapsed(1)
   * 3-level: FullyExpanded(2) → GroupCollapsed(0) → GroupExpandedToolCollapsed(1) → FullyExpanded(2)
   */
  cycleFoldLevel: () => void;

  /** Set the fold level for a specific tool group, overriding the global level. */
  setGroupFold: (groupId: string, level: FoldLevel) => void;

  /** Clear a per-group override so the group follows the global level again. */
  clearGroupFold: (groupId: string) => void;

  /**
   * Get the effective fold level for a tool group.
   * Returns the per-group override if set, otherwise the global level.
   */
  getEffectiveFoldLevel: (groupId: string) => FoldLevel;

  // -------------------------------------------------------------------------
  // Backward-compatibility derived values
  // -------------------------------------------------------------------------

  /**
   * Equivalent to the old `constrainHeight` boolean.
   * true when globalFoldLevel !== FullyExpanded (i.e. content should be height-constrained).
   */
  constrainHeight: boolean;

  /**
   * Backward-compatible per-tool expansion check.
   * A tool call is "expanded" when the effective fold level for its group is FullyExpanded
   * AND it has been individually expanded, OR when globalFoldLevel is FullyExpanded.
   *
   * During the migration period this delegates to the legacy expandedTools set
   * when fold level is FullyExpanded, preserving per-tool toggle behavior.
   */
  isExpanded: (callId: string) => boolean;

  /**
   * Toggle expansion for a single tool call (legacy compat).
   * Only meaningful when effective fold level is FullyExpanded.
   */
  toggleExpansion: (callId: string) => void;

  /**
   * Toggle expansion for all given tool call IDs (legacy compat).
   */
  toggleAllExpansion: (callIds: string[]) => void;

  /**
   * Reset fold state to constrained mode.
   * Called on new turn submission (handleFinalSubmit) to collapse everything.
   */
  resetToConstrained: () => void;
}

const FoldStateContext = createContext<FoldStateContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface FoldStateProviderProps {
  children: React.ReactNode;
  /** Override the initial fold level (default: GroupExpandedToolCollapsed). Useful for tests. */
  initialFoldLevel?: FoldLevel;
}

export const FoldStateProvider: React.FC<FoldStateProviderProps> = ({
  children,
  initialFoldLevel,
}) => {
  // Global fold level — default GroupExpandedToolCollapsed (constrainHeight=true).
  // This matches the old behavior where tool heights are limited and tools are collapsed by default.
  const [globalFoldLevel, setGlobalFoldLevel] = useState<FoldLevel>(
    initialFoldLevel ?? FoldLevel.GroupExpandedToolCollapsed,
  );

  // Per-group overrides
  const [groupOverrides, setGroupOverrides] = useState<Map<string, FoldLevel>>(
    () => new Map(),
  );

  // Legacy per-tool expansion set (compat bridge)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(
    () => new Set(),
  );

  // --- Actions ---

  const cycleFoldLevel = useCallback(() => {
    setGlobalFoldLevel((prev) => getNextFoldLevel(prev));
    // Clear per-group overrides on global cycle so all groups follow the new level
    setGroupOverrides(new Map());
  }, []);

  const setGroupFold = useCallback((groupId: string, level: FoldLevel) => {
    setGroupOverrides((prev) => {
      const next = new Map(prev);
      next.set(groupId, level);
      return next;
    });
  }, []);

  const clearGroupFold = useCallback((groupId: string) => {
    setGroupOverrides((prev) => {
      const next = new Map(prev);
      next.delete(groupId);
      return next;
    });
  }, []);

  const getEffectiveFoldLevel = useCallback(
    (groupId: string): FoldLevel =>
      groupOverrides.get(groupId) ?? globalFoldLevel,
    [groupOverrides, globalFoldLevel],
  );

  // --- Backward compat derived values ---

  const constrainHeight = globalFoldLevel !== FoldLevel.FullyExpanded;

  const isExpanded = useCallback(
    (callId: string): boolean => {
      // When globally expanded, defer to per-tool toggles (legacy behavior)
      if (globalFoldLevel === FoldLevel.FullyExpanded) {
        return expandedTools.has(callId);
      }
      // When not fully expanded, tools are never individually expanded
      return false;
    },
    [globalFoldLevel, expandedTools],
  );

  const toggleExpansion = useCallback((callId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) {
        next.delete(callId);
      } else {
        next.add(callId);
      }
      return next;
    });
  }, []);

  const toggleAllExpansion = useCallback((callIds: string[]) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      const anyCollapsed = callIds.some((id) => !next.has(id));
      if (anyCollapsed) {
        callIds.forEach((id) => next.add(id));
      } else {
        callIds.forEach((id) => next.delete(id));
      }
      return next;
    });
  }, []);

  const resetToConstrained = useCallback(() => {
    setGlobalFoldLevel(FoldLevel.GroupExpandedToolCollapsed);
    setGroupOverrides(new Map());
  }, []);

  // --- Context value ---

  const value = useMemo<FoldStateContextValue>(
    () => ({
      globalFoldLevel,
      cycleFoldLevel,
      setGroupFold,
      clearGroupFold,
      getEffectiveFoldLevel,
      constrainHeight,
      isExpanded,
      toggleExpansion,
      toggleAllExpansion,
      resetToConstrained,
    }),
    [
      globalFoldLevel,
      cycleFoldLevel,
      setGroupFold,
      clearGroupFold,
      getEffectiveFoldLevel,
      constrainHeight,
      isExpanded,
      toggleExpansion,
      toggleAllExpansion,
      resetToConstrained,
    ],
  );

  return (
    <FoldStateContext.Provider value={value}>
      {children}
    </FoldStateContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFoldState(): FoldStateContextValue {
  const context = useContext(FoldStateContext);
  if (!context) {
    throw new Error('useFoldState must be used within a FoldStateProvider');
  }
  return context;
}
