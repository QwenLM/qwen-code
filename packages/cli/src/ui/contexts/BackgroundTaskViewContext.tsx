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
  useRef,
  useState,
} from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  entryId,
  type DialogEntry,
  useBackgroundTaskView,
} from '../hooks/useBackgroundTaskView.js';

const debugLogger = createDebugLogger('BG_TASK_VIEW');

// ─── Types ──────────────────────────────────────────────────

export type BackgroundDialogMode =
  | 'closed'
  | 'list'
  | 'detail'
  | 'detail-from-panel';

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
   * True when the approval auto-surface effect opened the dialog and the
   * user has not navigated explicitly yet. Keypress dispatch is a
   * broadcast, so the dialog disarms its destructive list keys until a
   * navigation key acknowledges the auto-open (#16432).
   */
  autoOpened: boolean;
  /**
   * True when the footer pill owns keyboard focus (highlighted, awaiting
   * Enter to open the dialog). Mirrors the Arena tab-bar focus pattern.
   */
  pillFocused: boolean;
  /**
   * True when LiveAgentPanel owns keyboard focus for row navigation.
   */
  livePanelFocused: boolean;
  livePanelSelectedIndex: number;
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
  /**
   * Cooperatively pause or resume the selected workflow. Returns whether
   * the registry accepted the transition, or `null` when the keypress does
   * not apply to the selection (not a backgrounded workflow in a pausable
   * state). A `false` verdict means the run's state changed mid-race.
   */
  toggleSelectedWorkflowPause(): boolean | null;
  enterDetailFromPanel(): void;
  /** Clear the auto-open disarm after the first explicit navigation. */
  acknowledgeAutoOpen(): void;
  setPillFocused(focused: boolean): void;
  setLivePanelFocused(focused: boolean): void;
  setLivePanelSelectedIndex(index: number): void;
  /** Pre-select a specific entry index before opening the dialog. */
  setSelectedIndex(index: number): void;
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
  autoOpened: false,
  pillFocused: false,
  livePanelFocused: false,
  livePanelSelectedIndex: 0,
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
  enterDetailFromPanel: noop,
  acknowledgeAutoOpen: noop,
  cancelSelected: noop,
  resumeSelected: async () => {},
  toggleSelectedWorkflowPause: () => null,
  setPillFocused: noop,
  setLivePanelFocused: noop,
  setLivePanelSelectedIndex: noop,
  setSelectedIndex: noop,
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

  const [selection, setSelection] = useState<{ index: number; id?: string }>({
    index: 0,
  });
  const setSelectedIndex = useCallback(
    (index: number) => {
      const entry = entries[index];
      setSelection({ index, id: entry ? entryId(entry) : undefined });
    },
    [entries],
  );
  const [dialogMode, setDialogMode] = useState<BackgroundDialogMode>('closed');
  const [autoOpened, setAutoOpened] = useState(false);
  const [pillFocused, setPillFocused] = useState(false);
  const [livePanelFocused, setLivePanelFocusedRaw] = useState(false);
  const [livePanelSelectedIndex, setLivePanelSelectedIndex] = useState(0);
  const setLivePanelFocused = useCallback((focused: boolean) => {
    setLivePanelFocusedRaw(focused);
    if (focused) setLivePanelSelectedIndex(0);
  }, []);
  const dialogOpen = dialogMode !== 'closed';
  const hasEntries = entries.length > 0;

  // Drop stale pill focus once the pill itself unmounts — i.e., when the
  // registry is empty. The pill stays rendered while terminal entries
  // exist (so the user can reopen the dialog post-termination), so we
  // intentionally do *not* drop focus on the running → terminal flip.
  useEffect(() => {
    if (pillFocused && !hasEntries) setPillFocused(false);
  }, [pillFocused, hasEntries]);

  const hasAgentEntries = entries.some((e) => e.kind === 'agent');
  useEffect(() => {
    if (livePanelFocused && !hasAgentEntries) setLivePanelFocusedRaw(false);
  }, [livePanelFocused, hasAgentEntries]);

  // A workflow approval can only be answered from the detail view, and the
  // registry rejects the call outright when no host answers it. Surface a
  // parked approval once per approvalId so a blocked workflow shows up as a
  // selected row instead of only a footer badge. Only the queue head is
  // latchable: it is the one approval the detail view renders, so latching
  // an approval parked behind it would mark it surfaced without ever
  // displaying it, and it would never prompt once it becomes head (#16432).
  // The latch stays a set because each entry has its own head. Auto-open
  // lands in list mode, never detail: detail arms the tool confirmation with
  // focus, and a stray Enter aimed at the composer the dialog just unmounted
  // would approve the background command (#16432 R1-2). Entering detail
  // stays an explicit user navigation.
  const surfacedApprovalIdsRef = useRef<Set<string>>(new Set());
  // Parked queue-head ids at the moment the user closed the dialog. Without
  // this, the close itself re-runs the effect, which finds the next entry
  // that still holds a parked approval and re-opens in the same frame — with
  // two parked workflows Escape looks broken and re-arms the disarm. A
  // genuinely new approval changes the snapshot and surfaces normally.
  const parkedHeadIds = entries
    .map((entry) =>
      entry.kind === 'workflow' && entry.pendingApprovals[0]
        ? entry.pendingApprovals[0].approvalId
        : '',
    )
    .join('|');
  const closedParkedHeadIdsRef = useRef<string | null>(null);
  useEffect(() => {
    if (dialogMode !== 'closed') return;
    if (closedParkedHeadIdsRef.current !== null) {
      if (closedParkedHeadIdsRef.current === parkedHeadIds) return;
      closedParkedHeadIdsRef.current = null;
    }
    const index = entries.findIndex(
      (entry) =>
        entry.kind === 'workflow' &&
        !!entry.pendingApprovals[0] &&
        !surfacedApprovalIdsRef.current.has(
          entry.pendingApprovals[0].approvalId,
        ),
    );
    const entry = entries[index];
    if (entry?.kind !== 'workflow') return;
    const approval = entry.pendingApprovals[0];
    if (!approval) return;
    surfacedApprovalIdsRef.current.add(approval.approvalId);
    setSelectedIndex(index);
    // Same invariant `openDialog` establishes: dialog open ⇒ pill unfocused.
    // The pill subscribes on `pillFocused` alone, so leaving it focused lets
    // its Enter run `openDialog()` and clear the disarm (#16432 R3-2).
    setPillFocused(false);
    setAutoOpened(true);
    setDialogMode('list');
  }, [entries, dialogMode, parkedHeadIds, setSelectedIndex]);

  // Registry updates re-sort rows. Keep the chosen task selected by identity,
  // falling back to the stored index if that task has been removed.
  const identityIndex = entries.findIndex(
    (entry) => entryId(entry) === selection.id,
  );
  const selectedIndex =
    identityIndex >= 0
      ? identityIndex
      : Math.max(0, Math.min(selection.index, entries.length - 1));

  const moveSelectionUp = useCallback((): boolean => {
    if (selectedIndex <= 0) return false;
    setSelectedIndex(selectedIndex - 1);
    return true;
  }, [selectedIndex, setSelectedIndex]);

  const moveSelectionDown = useCallback((): boolean => {
    if (entries.length === 0) return false;
    if (selectedIndex >= entries.length - 1) return false;
    setSelectedIndex(selectedIndex + 1);
    return true;
  }, [entries.length, selectedIndex, setSelectedIndex]);

  const openDialog = useCallback(() => {
    setAutoOpened(false);
    setDialogMode('list');
    setPillFocused(false);
  }, []);

  const closeDialog = useCallback(() => {
    // A dismissal before the acknowledgment would consume the latch with the
    // approval never seen: the dialog closes, the effect skips the latched
    // head forever and the run falls back to the badge-only hang this PR
    // removes. Swallow it like the other composer-aimed keys; Ctrl+C reaches
    // here through `closeAnyOpenDialog` too (#16432 R3-1).
    if (autoOpened) return;
    closedParkedHeadIdsRef.current = parkedHeadIds;
    setAutoOpened(false);
    setDialogMode('closed');
  }, [autoOpened, parkedHeadIds]);

  const acknowledgeAutoOpen = useCallback(() => {
    setAutoOpened(false);
  }, []);

  const enterDetail = useCallback(() => {
    if (entries.length === 0) return;
    setDialogMode('detail');
  }, [entries.length]);

  const enterDetailFromPanel = useCallback(() => {
    if (entries.length === 0) return;
    setDialogMode('detail-from-panel');
  }, [entries.length]);

  const exitDetail = useCallback(() => {
    if (dialogMode === 'detail-from-panel') {
      setDialogMode('closed');
      setLivePanelFocusedRaw(true);
    } else {
      setDialogMode('list');
    }
  }, [dialogMode]);

  const cancelSelected = useCallback(() => {
    if (!config) return;
    const target = entries[selectedIndex];
    if (!target) return;
    if (target.kind === 'agent' && target.status === 'paused') {
      config.abandonBackgroundAgent(target.agentId);
      return;
    }
    // Registry cancel paths are no-ops outside their actionable states,
    // so no pre-check here. Shell cancel goes through
    // requestCancel — it triggers the AbortController only and lets the
    // spawn's settle path record the real terminal moment + outcome
    // (mirrors the task_stop tool path in #3687). Monitor cancel is
    // synchronous: settle + abort happen inside the registry's cancel(),
    // matching its own task_stop path.
    switch (target.kind) {
      case 'agent':
        config.getBackgroundTaskRegistry().cancel(target.agentId);
        break;
      case 'shell':
        config.getBackgroundShellRegistry().requestCancel(target.shellId);
        break;
      case 'monitor':
        config.getMonitorRegistry().cancel(target.monitorId);
        break;
      case 'dream': {
        // Aborts the dream fork-agent via MemoryManager.cancelTask;
        // the manager flips status to 'cancelled' before aborting, and
        // the runDream finally block releases the consolidation lock as
        // the agent unwinds. Same one-shot fire-and-forget shape as
        // shell.requestCancel above.
        //
        // cancelTask returns false in the contract-violation path
        // (running record without an AbortController). Today this is
        // unreachable because the controller is registered before
        // storeWith fires the notify, but if a future refactor
        // breaks the invariant a silent ignore here would let the
        // user think the cancel took. Log + leave the dialog open.
        const ok = config.getMemoryManager().cancelTask(target.dreamId);
        if (!ok) {
          debugLogger.warn(
            `cancelSelected: dream task ${target.dreamId} could not be cancelled ` +
              `(internal state inconsistency — see MemoryManager.cancelTask warn).`,
          );
        }
        break;
      }
      case 'workflow':
        // Aborts the orchestrator + in-flight dispatches via the
        // registry's cancel — rejects queued work, flips status to
        // 'cancelled', and signals
        // the AbortController the WorkflowTool wired into the run.
        // The tool's catch arm sees signal.aborted and records the
        // terminal in the registry; the registry.cancel here is the
        // first half of that race (idempotent on either ordering).
        config.getWorkflowRunRegistry().cancel(target.runId, Date.now());
        break;
      default: {
        const _exhaustive: never = target;
        throw new Error(
          `cancelSelected: unknown DialogEntry kind: ${JSON.stringify(_exhaustive)}`,
        );
      }
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

  const toggleSelectedWorkflowPause = useCallback((): boolean | null => {
    if (!config) return null;
    const target = entries[selectedIndex];
    if (!target || target.kind !== 'workflow' || !target.isBackgrounded) {
      return null;
    }
    const registry = config.getWorkflowRunRegistry();
    if (target.status === 'running') return registry.pause(target.runId);
    if (target.status === 'paused') return registry.resume(target.runId);
    // R12 (doudouOUC): `pausing` can last a full subagent dispatch, so a
    // silent keypress reads as a stuck UI. The registry refuses the
    // transition (returns false), which lights the existing rejection
    // flash — same surface as any other refused pause/resume.
    if (target.status === 'pausing') return registry.pause(target.runId);
    return null;
  }, [config, entries, selectedIndex]);

  const state: BackgroundTaskViewState = useMemo(
    () => ({
      entries,
      selectedIndex,
      dialogMode,
      dialogOpen,
      autoOpened,
      pillFocused,
      livePanelFocused,
      livePanelSelectedIndex,
    }),
    [
      entries,
      selectedIndex,
      dialogMode,
      dialogOpen,
      autoOpened,
      pillFocused,
      livePanelFocused,
      livePanelSelectedIndex,
    ],
  );

  const actions: BackgroundTaskViewActions = useMemo(
    () => ({
      moveSelectionUp,
      moveSelectionDown,
      openDialog,
      closeDialog,
      enterDetail,
      enterDetailFromPanel,
      exitDetail,
      acknowledgeAutoOpen,
      cancelSelected,
      resumeSelected,
      toggleSelectedWorkflowPause,
      setPillFocused,
      setLivePanelFocused,
      setLivePanelSelectedIndex,
      setSelectedIndex,
    }),
    [
      moveSelectionUp,
      moveSelectionDown,
      openDialog,
      closeDialog,
      enterDetail,
      enterDetailFromPanel,
      exitDetail,
      acknowledgeAutoOpen,
      cancelSelected,
      resumeSelected,
      toggleSelectedWorkflowPause,
      setPillFocused,
      setLivePanelFocused,
      setLivePanelSelectedIndex,
      setSelectedIndex,
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
