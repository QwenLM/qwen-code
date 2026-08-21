/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command-context parity for the OpenTUI renderer (PR1 slice 5).
 *
 * The ink TUI builds its `CommandContext` inside `useSlashCommandProcessor`
 * (the `commandContext` useMemo). This module builds the SAME context shape
 * for the OpenTUI renderer from an `OpenTuiCommandHost` — the surface the
 * OpenTUI backend provides for history, session state, and the dialogs the
 * original commands drive. Command actions therefore run against identical
 * services regardless of renderer.
 */

import type { ReactNode } from 'react';
import type {
  Config,
  Logger,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import type { CommandContext } from '../commands/types.js';
import type {
  ConfirmationRequest,
  HistoryItem,
  HistoryItemBtw,
  HistoryItemWithoutId,
} from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type {
  ExtensionUpdateAction,
  ExtensionUpdateStatus,
} from '../state/extensions.js';
import { ExtensionRefreshState } from '../../config/extension-refresh-state.js';

/** Resolution of a shell-command confirmation dialog (ink ShellConfirmation). */
export interface ShellConfirmationResolution {
  outcome: ToolConfirmationOutcome;
  approvedCommands?: string[];
}

/**
 * The UI capabilities the original `CommandContext` and the slash processor
 * require, provided by the OpenTUI backend. Method names follow the ink
 * history manager / processor actions so the parity mapping is 1:1.
 */
export interface OpenTuiCommandHost {
  getHistory(): readonly HistoryItem[];
  addItem: UseHistoryManagerReturn['addItem'];
  updateItem: UseHistoryManagerReturn['updateItem'];
  clearItems: UseHistoryManagerReturn['clearItems'];
  loadHistory: UseHistoryManagerReturn['loadHistory'];
  refreshStatic(): void;
  clearPendingState(): void;
  cancelBtw(): void;
  btwItem: HistoryItemBtw | null;
  setBtwItem(item: HistoryItemBtw | null): void;
  btwAbortControllerRef: { current: AbortController | null };
  pendingItem: HistoryItemWithoutId | null;
  setPendingItem(item: HistoryItemWithoutId | null): void;
  setDebugMessage(message: string): void;
  toggleVimEnabled(): Promise<boolean>;
  setGeminiMdFileCount(count: number): void;
  reloadCommands(): void | Promise<void>;
  setSessionName(name: string | null): void;
  /** Parity of `isIdleRef.current` — no model turn in flight. */
  isIdle(): boolean;
  extensionsUpdateState: Map<string, ExtensionUpdateStatus>;
  dispatchExtensionStateUpdate(action: ExtensionUpdateAction): void;
  addConfirmUpdateExtensionRequest(value: ConfirmationRequest): void;
  sessionStats: SessionStatsState;
  sessionShellAllowlist: Set<string>;
  /** Parity of the processor's `setSessionShellAllowlist` merge. */
  addSessionShellAllowlist(commands: readonly string[]): void;
  startNewSession?(sessionId: string): void;
  /** Parity of `setIsProcessing` — gates the ESC-to-cancel keypress. */
  setIsProcessing(processing: boolean): void;
  /** Presents the shell-commands confirmation; resolves like ink's dialog. */
  presentShellConfirmation(
    commands: readonly string[],
  ): Promise<ShellConfirmationResolution>;
  /** Presents a yes/no confirmation; resolves like ink's dialog. */
  presentActionConfirmation(prompt: ReactNode): Promise<boolean>;
  /** Parity of `actions.handleResume` — awaited like the ink processor. */
  handleResume(sessionId: string): Promise<void>;
  /** Parity of `actions.handleBranch` — awaited like the ink processor. */
  handleBranch(name?: string): Promise<void>;
}

export interface OpenTuiCommandServices {
  config: Config | null;
  settings: LoadedSettings;
  logger: Logger | null;
  extensionRefreshState?: ExtensionRefreshState;
}

/**
 * Builds the `CommandContext` exactly like the ink processor's
 * `commandContext` useMemo (slashCommandProcessor.ts):
 *  - `ui.clear()` = cancelBtw → clearPendingState → clearItems →
 *    refreshStatic → setSessionName(null). The ink `clearScreen()` step is
 *    intentionally skipped: the OpenTUI renderer owns the screen, and
 *    `clearItems` already performs the renderer-level clear (writing raw
 *    ANSI here would fight the cell-diff painter — audit 01 G-20).
 *  - a live `history` getter backed by the host
 *  - a fallback `ExtensionRefreshState` when the backend has none
 */
export function createOpenTuiCommandContext(
  host: OpenTuiCommandHost,
  services: OpenTuiCommandServices,
): CommandContext {
  const extensionRefreshState =
    services.extensionRefreshState ?? new ExtensionRefreshState();
  return {
    executionMode: 'interactive' as const,
    services: {
      config: services.config,
      settings: services.settings,
      logger: services.logger,
      extensionRefreshState,
    },
    ui: {
      get history() {
        return [...host.getHistory()];
      },
      addItem: (item, timestamp) => host.addItem(item, timestamp),
      clear: () => {
        host.cancelBtw();
        host.clearPendingState();
        host.clearItems();
        host.refreshStatic();
        host.setSessionName(null);
      },
      clearPendingState: () => host.clearPendingState(),
      loadHistory: (history) => host.loadHistory(history),
      refreshStatic: () => host.refreshStatic(),
      setDebugMessage: (message) => host.setDebugMessage(message),
      pendingItem: host.pendingItem,
      setPendingItem: (item) => host.setPendingItem(item),
      btwItem: host.btwItem,
      setBtwItem: (item) => host.setBtwItem(item),
      cancelBtw: () => host.cancelBtw(),
      btwAbortControllerRef: host.btwAbortControllerRef,
      isIdleRef: {
        get current() {
          return host.isIdle();
        },
      },
      toggleVimEnabled: () => host.toggleVimEnabled(),
      setGeminiMdFileCount: (count) => host.setGeminiMdFileCount(count),
      reloadCommands: () => host.reloadCommands(),
      setSessionName: (name) => host.setSessionName(name),
      extensionsUpdateState: host.extensionsUpdateState,
      dispatchExtensionStateUpdate: (action) =>
        host.dispatchExtensionStateUpdate(action),
      addConfirmUpdateExtensionRequest: (value) =>
        host.addConfirmUpdateExtensionRequest(value),
    },
    session: {
      stats: host.sessionStats,
      sessionShellAllowlist: host.sessionShellAllowlist,
      startNewSession: host.startNewSession,
    },
  };
}
