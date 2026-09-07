/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Concrete {@link OpenTuiCommandHost} + {@link SessionSwitchHost} for the
 * OpenTUI backend — the state the slash dispatcher and the `/resume` /
 * `/branch` actions run against.
 *
 * Why a plain class instead of React state: {@link OpenTuiSlashDispatcher}
 * is built once and holds a single host reference, so the host must be a
 * stable object whose accessors always read the live value. The renderer
 * (app-shell) subscribes through {@link subscribe}/{@link getVersion} and
 * re-reads through the getters, so this class owns exactly the fields the
 * command context expects — no duplicate store in React.
 *
 * Two concerns stay with the shell because they are not command history:
 *  - the live transcript (a separate, kind-based streaming model folded from
 *    `OpenTuiStreamEvent`s) — reached through the injected `transcript`;
 *  - modal confirmations (shell-command / generic yes-no), which need to
 *    render and await a dialog — reached through `confirmations`.
 * Everything else the host answers from its own fields.
 */

import type { ReactNode } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { Logger } from '@qwen-code/qwen-code-core/core/logger.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  type ConfirmationRequest,
  type HistoryItem,
  type HistoryItemBtw,
  type HistoryItemWithoutId,
} from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type {
  ExtensionUpdateAction,
  ExtensionUpdateStatus,
} from '../state/extensions.js';
import {
  coalesceFindingsHistoryItems,
  isFindingsListDisplay,
} from '../utils/findings-coalescing.js';
import { projectItemToStreamEvent } from './item-projection.js';
import type {
  OpenTuiCommandHost,
  ShellConfirmationResolution,
} from './commands-context.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import {
  handleBranchSession,
  handleResumeSession,
  type SessionSwitchHost,
} from './session-switch.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

const debugLogger = createDebugLogger('OPEN_TUI_HOST');

/** Live-transcript seam the shell owns (folds events into streaming rows). */
export interface OpenTuiTranscriptController {
  /** Replaces the visible transcript from a replay batch (single commit). */
  reset(events: OpenTuiStreamEvent[]): void;
  /**
   * Empties the visible transcript (/clear — the contract half of
   * SessionSwitchHost.clearItems that says "AND the visible transcript").
   */
  clear(): void;
  /** Appends one projected host-history item (U-28 project-on-write). */
  append(event: OpenTuiStreamEvent): void;
}

/** Modal-confirmation seam the shell owns (renders + awaits a dialog). */
export interface OpenTuiConfirmationBridge {
  presentShell(
    commands: readonly string[],
  ): Promise<ShellConfirmationResolution>;
  presentAction(prompt: ReactNode): Promise<boolean>;
}

export interface OpenTuiAppHostDeps {
  config: Config;
  settings: LoadedSettings;
  logger: Logger | null;
  transcript: OpenTuiTranscriptController;
  confirmations: OpenTuiConfirmationBridge;
  /** Signals the shell to re-read (drives `useSyncExternalStore`). */
  onChange(): void;
  toggleVimEnabled(): Promise<boolean>;
  reloadCommands(): void | Promise<void>;
  /** UI-side session rotation (new chat id + SessionStats refresh). */
  startNewSession(sessionId: string): void;
  /** Reads the current session-stats snapshot (owned by SessionStatsProvider). */
  getSessionStats(): SessionStatsState;
  /**
   * Applies an extension-update action to the shared status map in place. The
   * shell wires the real `extensionsReducer`; absent, updates are dropped
   * (the map reference the command context captured stays valid regardless).
   */
  reduceExtensionState?(
    map: Map<string, ExtensionUpdateStatus>,
    action: ExtensionUpdateAction,
  ): void;
}

type HistoryItemUpdater = (
  prevItem: HistoryItem,
) => Partial<HistoryItemWithoutId>;

/**
 * Stable command-context host. Instances are created once by the app-shell and
 * handed to `createOpenTuiSlashDispatcher`; the dispatcher and every command
 * read/write through these methods.
 */
export class OpenTuiAppHost implements OpenTuiCommandHost, SessionSwitchHost {
  readonly config: Config;
  readonly settings: LoadedSettings;
  readonly logger: Logger | null;

  private readonly deps: OpenTuiAppHostDeps;
  private readonly transcript: OpenTuiTranscriptController;

  private history: HistoryItem[] = [];
  private messageIdCounter = 0;
  private pendingItemState: HistoryItemWithoutId | null = null;
  private btwItemValue: HistoryItemBtw | null = null;
  private debugMessageValue = '';
  private sessionNameValue: string | null = null;
  private memoryFileCountValue = 0;
  private processing = false;
  private streaming = false;

  readonly btwAbortControllerRef: { current: AbortController | null } = {
    current: null,
  };
  readonly sessionShellAllowlist = new Set<string>();
  readonly extensionsUpdateState = new Map<string, ExtensionUpdateStatus>();

  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(deps: OpenTuiAppHostDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.settings = deps.settings;
    this.logger = deps.logger;
    this.transcript = deps.transcript;
  }

  // --- external-store plumbing (app-shell re-render) ----------------------

  /** Coarse change counter — bumped on every state mutation. */
  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) this.runIsolated(listener);
    this.runIsolated(() => this.deps.onChange());
  }

  /**
   * `/resume` and `/branch` run the UI display steps after re-keying core, and
   * set their commit flag only once the last step returns. So one throw from a
   * caller-owned callback leaves the swap uncommitted: core rolls back to the
   * old session, and `/branch` deletes the fork it just created. Isolate the
   * steps so a broken subscriber cannot undo a session the user is already on.
   */
  private runIsolated(step: () => void): void {
    try {
      step();
    } catch (error) {
      debugLogger.error('UI step failed', error);
    }
  }

  // --- history (faithful `useHistory` parity) -----------------------------

  getHistory(): readonly HistoryItem[] {
    return this.history;
  }

  addItem: UseHistoryManagerReturn['addItem'] = (itemData, baseTimestamp) => {
    const id = baseTimestamp + ++this.messageIdCounter;
    const newItem = { ...itemData, id } as HistoryItem;

    const prev = this.history;
    if (
      !(
        prev.length > 0 &&
        prev[prev.length - 1].type === 'user' &&
        newItem.type === 'user' &&
        prev[prev.length - 1].text === newItem.text
      )
    ) {
      const next = [...prev, newItem];
      this.history =
        newItem.type === 'tool_group' &&
        newItem.tools.some((tool) => isFindingsListDisplay(tool.resultDisplay))
          ? coalesceFindingsHistoryItems(next)
          : next;
      // U-28 project-on-write: the recorded item becomes a transcript row so
      // command output is visible. updateItem/loadHistory do not project —
      // one is a flag flip the live row ignores, the other is followed by a
      // wholesale transcript reset.
      const event = projectItemToStreamEvent(newItem, {
        config: this.config,
        stats: this.sessionStats,
        settings: this.settings,
        extensionsUpdateState: this.extensionsUpdateState,
      });
      if (event) this.transcript.append(event);
    }
    this.notify();
    return id;
  };

  updateItem: UseHistoryManagerReturn['updateItem'] = (id, updates) => {
    const index = this.history.findIndex((item) => item.id === id);
    if (index === -1) return;
    const patch =
      typeof updates === 'function'
        ? (updates as HistoryItemUpdater)(this.history[index])
        : updates;
    this.history[index] = { ...this.history[index], ...patch } as HistoryItem;
    this.history = [...this.history];
    this.notify();
  };

  clearItems: UseHistoryManagerReturn['clearItems'] = () => {
    this.history = [];
    this.messageIdCounter = 0;
    // Contract completion (U-29): SessionSwitchHost documents clearItems as
    // clearing the command history AND the visible transcript.
    this.transcript.clear();
    this.notify();
  };

  loadHistory: UseHistoryManagerReturn['loadHistory'] = (newHistory) => {
    this.history = newHistory;
    this.notify();
  };

  /** Renderer repaint hint — the cell-diff painter re-renders on `notify`. */
  refreshStatic(): void {
    this.notify();
  }

  // --- pending / btw / debug / session ------------------------------------

  get pendingItem(): HistoryItemWithoutId | null {
    return this.pendingItemState;
  }

  setPendingItem: OpenTuiCommandHost['setPendingItem'] = (item) => {
    this.pendingItemState = item;
    this.notify();
  };

  clearPendingState(): void {
    this.pendingItemState = null;
    this.notify();
  }

  get btwItem(): HistoryItemBtw | null {
    return this.btwItemValue;
  }

  setBtwItem: OpenTuiCommandHost['setBtwItem'] = (item) => {
    this.btwItemValue = item;
    this.notify();
  };

  cancelBtw(): void {
    this.btwAbortControllerRef.current?.abort();
    this.btwAbortControllerRef.current = null;
    this.btwItemValue = null;
    this.notify();
  }

  setDebugMessage(message: string): void {
    this.debugMessageValue = message;
    this.notify();
  }

  get debugMessage(): string {
    return this.debugMessageValue;
  }

  get sessionName(): string | null {
    return this.sessionNameValue;
  }

  setSessionName(name: string | null): void {
    this.sessionNameValue = name;
    this.notify();
  }

  get memoryFileCount(): number {
    return this.memoryFileCountValue;
  }

  setMemoryFileCount(count: number): void {
    this.memoryFileCountValue = count;
    this.notify();
  }

  // --- command-context actions forwarded to the shell ---------------------

  toggleVimEnabled(): Promise<boolean> {
    return this.deps.toggleVimEnabled();
  }

  reloadCommands(): void | Promise<void> {
    return this.deps.reloadCommands();
  }

  startNewSession(sessionId: string): void {
    this.deps.startNewSession(sessionId);
  }

  get sessionStats(): SessionStatsState {
    return this.deps.getSessionStats();
  }

  addSessionShellAllowlist(commands: readonly string[]): void {
    for (const command of commands) this.sessionShellAllowlist.add(command);
    this.notify();
  }

  dispatchExtensionStateUpdate(action: ExtensionUpdateAction): void {
    this.deps.reduceExtensionState?.(this.extensionsUpdateState, action);
    this.notify();
  }

  /**
   * Extension consent has no renderer in this batch, so it goes through the
   * same bridge the shell auto-denies. The caller awaits `onConfirm` and
   * nothing else, so a request left pending here would wedge the slash
   * gateway for the rest of the session — hence a rejected bridge settles as
   * a denial too.
   */
  addConfirmUpdateExtensionRequest(value: ConfirmationRequest): void {
    void this.deps.confirmations
      .presentAction(value.prompt)
      .catch(() => false)
      .then((confirmed) => value.onConfirm(confirmed));
  }

  // --- idle / processing --------------------------------------------------

  /** Parity of `isIdleRef.current`: no dispatched command, no live turn. */
  isIdle(): boolean {
    return !this.processing && !this.streaming;
  }

  setIsProcessing(processing: boolean): void {
    this.processing = processing;
    this.notify();
  }

  /** Driven by the app-shell around `livePromptEvents` — not part of the host iface. */
  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    this.notify();
  }

  // --- confirmation dialogs (delegated to the shell) ----------------------

  presentShellConfirmation(
    commands: readonly string[],
  ): Promise<ShellConfirmationResolution> {
    return this.deps.confirmations.presentShell(commands);
  }

  presentActionConfirmation(prompt: ReactNode): Promise<boolean> {
    return this.deps.confirmations.presentAction(prompt);
  }

  // --- session switch (implements SessionSwitchHost for session-switch.ts) -

  resetTranscript(events: OpenTuiStreamEvent[]): void {
    this.runIsolated(() => this.transcript.reset(events));
  }

  handleResume(sessionId: string): Promise<void> {
    return handleResumeSession(this, sessionId);
  }

  handleBranch(name?: string): Promise<void> {
    return handleBranchSession(this, name);
  }
}
