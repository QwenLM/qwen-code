/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BackgroundTaskViewContext — React state for the Background tasks
 * dialog. Subscription plumbing (registry callbacks → entries) lives in
 * `useBackgroundTaskView`, invoked once here so it owns the single-slot
 * `setStatusChangeCallback` for the TUI's lifetime.
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { type Config } from '@qwen-code/qwen-code-core';
import {
  type DialogEntry,
  useBackgroundTaskView,
} from '../hooks/useBackgroundTaskView.js';

// ─── Types ──────────────────────────────────────────────────

export type BackgroundDialogMode = 'closed' | 'list' | 'detail';

export interface BackgroundTaskViewState {
  /**
   * Live snapshot of every background entry across both registries
   * (subagents + managed shells), ordered by `startTime`. Each entry carries
   * a `kind` discriminator so renderers can dispatch on agent vs shell.
   */
  entries: readonly DialogEntry[];
  /** Index into `entries` for the currently focused row (0-based). */
  selectedIndex: number;
  /** `'closed'` when the overlay isn't mounted; otherwise the active mode. */
  dialogMode: BackgroundDialogMode;
  /** Convenience boolean: `dialogMode !== 'closed'`. */
  dialogOpen: boolean;
  /**
   * True when the footer pill owns keyboard focus (highlighted, awaiting
   * Enter to open the dialog). Mirrors the Arena tab-bar focus pattern.
   */
  pillFocused: boolean;
}

export interface BackgroundTaskViewActions {
  moveSelectionUp(): boolean;
  moveSelectionDown(): boolean;
  openDialog(): void;
  closeDialog(): void;
  enterDetail(): void;
  exitDetail(): void;
  /** Stop or abandon the currently selected entry. */
  cancelSelected(): void;
  /** Resume the currently selected paused entry. */
  resumeSelected(): Promise<void>;
  setPillFocused(focused: boolean): void;
}

// ─── Context ────────────────────────────────────────────────

export const BackgroundTaskViewStateContext =
  createContext<BackgroundTaskViewState | null>(null);
export const BackgroundTaskViewActionsContext =
  createContext<BackgroundTaskViewActions | null>(null);

// ─── Defaults (used when no provider is mounted) ────────────

const DEFAULT_STATE: BackgroundTaskViewState = {
  entries: [],
  selectedIndex: 0,
  dialogMode: 'closed',
  dialogOpen: false,
  pillFocused: false,
};

const noop = () => {};
const noopBool = () => false;

const DEFAULT_ACTIONS: BackgroundTaskViewActions = {
  moveSelectionUp: noopBool,
  moveSelectionDown: noopBool,
  openDialog: noop,
  closeDialog: noop,
  enterDetail: noop,
  exitDetail: noop,
  cancelSelected: noop,
  resumeSelected: async () => {},
  setPillFocused: noop,
};

// ─── Hooks ──────────────────────────────────────────────────

export function useBackgroundTaskViewState(): BackgroundTaskViewState {
  return useContext(BackgroundTaskViewStateContext) ?? DEFAULT_STATE;
}

export function useBackgroundTaskViewActions(): BackgroundTaskViewActions {
  return useContext(BackgroundTaskViewActionsContext) ?? DEFAULT_ACTIONS;
}

// ─── Provider ───────────────────────────────────────────────

interface BackgroundTaskViewProviderProps {
  config?: Config;
  children: React.ReactNode;
}

export function BackgroundTaskViewProvider({
  config,
  children,
}: BackgroundTaskViewProviderProps) {
  const { entries } = useBackgroundTaskView(config ?? null);

  const [rawSelectedIndex, setRawSelectedIndex] = useState(0);
  const [dialogMode, setDialogMode] = useState<BackgroundDialogMode>('closed');
  const [pillFocused, setPillFocused] = useState(false);
  const dialogOpen = dialogMode !== 'closed';
  const hasEntries = entries.length > 0;

  // Drop stale pill focus once the pill itself unmounts — i.e., when the
  // registry is empty. The pill stays rendered while terminal entries
  // exist (so the user can reopen the dialog post-termination), so we
  // intentionally do *not* drop focus on the running → terminal flip.
  useEffect(() => {
    if (pillFocused && !hasEntries) setPillFocused(false);
  }, [pillFocused, hasEntries]);

  // rawSelectedIndex can fall out of range when entries shrink; clamp on read.
  const selectedIndex =
    entries.length === 0
      ? 0
      : Math.min(Math.max(0, rawSelectedIndex), entries.length - 1);

  const moveSelectionUp = useCallback((): boolean => {
    if (selectedIndex <= 0) return false;
    setRawSelectedIndex(selectedIndex - 1);
    return true;
  }, [selectedIndex]);

  const moveSelectionDown = useCallback((): boolean => {
    if (entries.length === 0) return false;
    if (selectedIndex >= entries.length - 1) return false;
    setRawSelectedIndex(selectedIndex + 1);
    return true;
  }, [entries.length, selectedIndex]);

  const openDialog = useCallback(() => {
    setDialogMode('list');
    setPillFocused(false);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogMode('closed');
  }, []);

  const enterDetail = useCallback(() => {
    if (entries.length === 0) return;
    setDialogMode('detail');
  }, [entries.length]);

  const exitDetail = useCallback(() => {
    setDialogMode('list');
  }, []);

  const cancelSelected = useCallback(() => {
    if (!config) return;
    const target = entries[selectedIndex];
    if (!target) return;
    if (target.kind === 'agent' && target.status === 'paused') {
      config.abandonBackgroundAgent(target.agentId);
      return;
    }
    // Both registries' cancel paths are no-ops on non-running entries, so
    // no pre-check here. Shell cancel goes through requestCancel — it
    // triggers the AbortController only and lets the spawn's settle path
    // record the real terminal moment + outcome (mirrors the task_stop
    // tool path in #3687).
    if (target.kind === 'agent') {
      config.getBackgroundTaskRegistry().cancel(target.agentId);
    } else {
      config.getBackgroundShellRegistry().requestCancel(target.shellId);
    }
  }, [config, entries, selectedIndex]);

  const resumeSelected = useCallback(async () => {
    if (!config) return;
    const target = entries[selectedIndex];
    if (
      !target ||
      target.kind !== 'agent' ||
      target.status !== 'paused' ||
      target.resumeBlockedReason
    ) {
      return;
    }
    await config.resumeBackgroundAgent(target.agentId);
  }, [config, entries, selectedIndex]);

  const state: BackgroundTaskViewState = useMemo(
    () => ({
      entries,
      selectedIndex,
      dialogMode,
      dialogOpen,
      pillFocused,
    }),
    [entries, selectedIndex, dialogMode, dialogOpen, pillFocused],
  );

  const actions: BackgroundTaskViewActions = useMemo(
    () => ({
      moveSelectionUp,
      moveSelectionDown,
      openDialog,
      closeDialog,
      enterDetail,
      exitDetail,
      cancelSelected,
      resumeSelected,
      setPillFocused,
    }),
    [
      moveSelectionUp,
      moveSelectionDown,
      openDialog,
      closeDialog,
      enterDetail,
      exitDetail,
      cancelSelected,
      resumeSelected,
      setPillFocused,
    ],
  );

  return (
    <BackgroundTaskViewStateContext.Provider value={state}>
      <BackgroundTaskViewActionsContext.Provider value={actions}>
        {children}
      </BackgroundTaskViewActionsContext.Provider>
    </BackgroundTaskViewStateContext.Provider>
  );
}
