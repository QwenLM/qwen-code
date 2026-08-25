/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend product-integration bridge for the OpenTUI renderer (R2).
 *
 * The real command stack (the original loader stack + CommandService via
 * `OpenTuiSlashDispatcher`) speaks ink history items and dialog requests; the
 * OpenTUI backend speaks the neutral streaming model. This module is the only
 * translation layer between the two:
 *
 *  - `projectCommandItem` maps one ink command history item onto the neutral
 *    stream event the backend folds into its chat history — the five basic
 *    message kinds plus the special transcript items (about/tools/stats/
 *    compression/summary/insight/goals/context/doctor/mcp/extensions/skills/
 *    memory_saved/quit/btw) projected to text (item-projection.ts);
 *  - `resolveDispatchOutcome` decides what the backend does for one
 *    `OpenTuiDispatchOutcome` (open a mounted dialog, submit to the live
 *    client, schedule a client-initiated tool, quit, or report an explicitly
 *    unsupported capability);
 *  - `resolveDialogRequest` classifies every dialog kind against the
 *    already-ported dialog family — unsupported kinds are represented
 *    explicitly, never silently dropped;
 *  - `createBackendCommandHost` builds the concrete `OpenTuiCommandHost` the
 *    dispatcher runs against, wired to the backend's event sinks. Session
 *    switching (/resume, /branch), confirmations, pending state, and the
 *    session stats are REAL when the backend supplies the matching sinks /
 *    options; without them (demo mode, unit tests) they report themselves
 *    explicitly instead of pretending to succeed.
 */

import {
  ToolConfirmationOutcome,
  type Config,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import type { PartListUnion } from '@google/genai';
import type {
  HistoryItem,
  HistoryItemBtw,
  HistoryItemWithoutId,
} from '../types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { GoalSnapshotLike, OpenTuiStreamEvent } from './event-adapter.js';
import type {
  OpenTuiCommandHost,
  ShellConfirmationResolution,
} from './commands-context.js';
import type { OpenTuiDispatchOutcome } from './commands-dispatch.js';
import type { OpenTuiDialogRequest } from './commands-registry.js';
import type { ModelDialogMode } from './dialogs-model.js';
import {
  extractPromptText,
  projectSpecialItemText,
  type ItemProjectionContext,
} from './item-projection.js';
import {
  handleBranchSession,
  handleResumeSession,
  type SessionSwitchHost,
} from './session-switch.js';

/** Dialogs the already-ported OpenTUI dialog family can mount. */
export type MountedDialog =
  | { dialog: 'help' }
  | { dialog: 'theme' }
  | { dialog: 'settings' }
  | { dialog: 'permissions' }
  | { dialog: 'extensions_manage' }
  | { dialog: 'mcp' }
  | { dialog: 'stats' }
  | { dialog: 'skills_manage' }
  | { dialog: 'approval-mode' }
  | { dialog: 'effort' }
  | { dialog: 'memory' }
  | { dialog: 'statusline' }
  | { dialog: 'editor' }
  | { dialog: 'auth' }
  | { dialog: 'trust' }
  | { dialog: 'delete' }
  | { dialog: 'resume'; matchedSessions?: SessionListItem[] }
  | { dialog: 'branch' }
  | { dialog: 'hooks' }
  | { dialog: 'rewind' }
  | { dialog: 'diff' }
  | { dialog: 'arena'; mode: 'start' | 'select' | 'stop' | 'status' }
  | { dialog: 'subagent_create' }
  | { dialog: 'subagent_list' }
  | {
      dialog: 'model';
      mode: ModelDialogMode;
      persistScope?: 'workspace' | 'user';
    };

export type DialogResolution =
  | { kind: 'mount'; dialog: MountedDialog }
  | { kind: 'unsupported'; message: string };

/** The backend action derived from one dispatcher outcome. */
export type BackendAction =
  /** Not a slash command after all — submit it as a normal prompt. */
  | { kind: 'passthrough' }
  /** The dispatcher already applied everything through the host. */
  | { kind: 'handled' }
  | { kind: 'dialog'; resolution: DialogResolution }
  /**
   * Command output destined for the model (submit_prompt results). The parts
   * list (multimodal included), the post-turn callback, and the per-turn model
   * override travel unchanged into the live client turn — the ink pipeline
   * (useGeminiStream) consumes all three the same way.
   */
  | {
      kind: 'submit';
      content: PartListUnion;
      onComplete?: () => Promise<void>;
      modelOverride?: string;
      /**
       * ink parity (useGeminiStream refreshContextFilesOnWriteRef): when the
       * turn writes a context file (GEMINI.md/…), refresh the memory
       * instruction once the tool batch completes.
       */
      refreshContextFilesOnWrite?: boolean;
    }
  /**
   * A client-initiated tool call (/restore, /setup-github). The backend
   * schedules it through the real CoreToolScheduler (client-tool-run.ts);
   * the result never feeds the model back (ink parity).
   */
  | {
      kind: 'schedule_tool';
      toolName: string;
      toolArgs: Record<string, unknown>;
    }
  /** Quit; `messages` carry the farewell (session summary) to render first. */
  | { kind: 'quit'; messages: HistoryItem[] }
  /** A capability this renderer does not implement yet. */
  | { kind: 'unsupported'; message: string };

/**
 * Projects one ink command history item onto the neutral stream. Returns null
 * for item kinds the chat transcript does not render (dialog payloads, tool
 * groups, …). `ctx` supplies the runtime state the special items read in ink
 * (session stats, extensions, MCP status); without it they still project
 * with service-level fallbacks where possible.
 */
export function projectCommandItem(
  item: HistoryItemWithoutId,
  ctx?: ItemProjectionContext,
): OpenTuiStreamEvent | null {
  switch (item.type) {
    case 'user':
      // promptId/sentToModel ride along so /rewind can match file
      // checkpoints and filter out locally-handled command echoes.
      return {
        type: 'user',
        text: item.text,
        promptId: item.promptId,
        sentToModel: item.sentToModel,
      };
    case 'info':
    case 'success':
    case 'warning':
    case 'error':
      return { type: 'text', delta: item.text };
    case 'compression':
      return { type: 'compaction', compression: item.compression };
    case 'goal_state':
      // ink renders goal_state history items through GoalStateCard.
      return {
        type: 'goal',
        snapshot: item.snapshot as GoalSnapshotLike,
        cause: item.cause as string | undefined,
      };
    case 'goal_status':
      // ink renders goal_status history items through GoalStatusMessage's
      // kind form (the /goal command path).
      return {
        type: 'goal-legacy',
        kind: item.kind,
        condition: item.condition,
        iterations: item.iterations,
        durationMs: item.durationMs,
        lastReason: item.lastReason,
      };
    default: {
      const text = projectSpecialItemText(item, ctx ?? {});
      return text ? { type: 'text', delta: text } : null;
    }
  }
}

/**
 * Classifies one dialog request against the mounted dialog family.
 * Exhaustive: a new dialog kind fails the `never` check at compile time.
 */
export function resolveDialogRequest(
  request: OpenTuiDialogRequest,
): DialogResolution {
  switch (request.dialog) {
    case 'help':
      return { kind: 'mount', dialog: { dialog: 'help' } };
    case 'theme':
      return { kind: 'mount', dialog: { dialog: 'theme' } };
    case 'settings':
      return { kind: 'mount', dialog: { dialog: 'settings' } };
    case 'permissions':
      return { kind: 'mount', dialog: { dialog: 'permissions' } };
    case 'extensions_manage':
      return { kind: 'mount', dialog: { dialog: 'extensions_manage' } };
    case 'mcp':
      return { kind: 'mount', dialog: { dialog: 'mcp' } };
    case 'stats':
      return { kind: 'mount', dialog: { dialog: 'stats' } };
    case 'skills_manage':
      return { kind: 'mount', dialog: { dialog: 'skills_manage' } };
    case 'approval-mode':
      return { kind: 'mount', dialog: { dialog: 'approval-mode' } };
    case 'effort':
      return { kind: 'mount', dialog: { dialog: 'effort' } };
    case 'memory':
      return { kind: 'mount', dialog: { dialog: 'memory' } };
    case 'statusline':
      return { kind: 'mount', dialog: { dialog: 'statusline' } };
    case 'model':
      return {
        kind: 'mount',
        dialog: {
          dialog: 'model',
          mode: request.mode,
          ...(request.persistScope
            ? { persistScope: request.persistScope }
            : {}),
        },
      };
    case 'editor':
      return { kind: 'mount', dialog: { dialog: 'editor' } };
    case 'auth':
      return { kind: 'mount', dialog: { dialog: 'auth' } };
    case 'trust':
      return { kind: 'mount', dialog: { dialog: 'trust' } };
    case 'delete':
      return { kind: 'mount', dialog: { dialog: 'delete' } };
    case 'resume':
      return {
        kind: 'mount',
        dialog: {
          dialog: 'resume',
          ...(request.matchedSessions
            ? { matchedSessions: request.matchedSessions }
            : {}),
        },
      };
    case 'branch':
      return { kind: 'mount', dialog: { dialog: 'branch' } };
    case 'hooks':
      return { kind: 'mount', dialog: { dialog: 'hooks' } };
    case 'rewind':
      return { kind: 'mount', dialog: { dialog: 'rewind' } };
    case 'diff':
      return { kind: 'mount', dialog: { dialog: 'diff' } };
    case 'arena':
      return {
        kind: 'mount',
        dialog: { dialog: 'arena', mode: request.mode },
      };
    case 'subagent_create':
      return { kind: 'mount', dialog: { dialog: 'subagent_create' } };
    case 'subagent_list':
      return { kind: 'mount', dialog: { dialog: 'subagent_list' } };
    default: {
      const unhandled: never = request;
      throw new Error(
        `Unhandled OpenTUI dialog request: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

/** Resolves one dispatcher outcome into the backend action to apply. */
export function resolveDispatchOutcome(
  outcome: OpenTuiDispatchOutcome | false,
): BackendAction {
  if (outcome === false) {
    return { kind: 'passthrough' };
  }
  switch (outcome.kind) {
    case 'handled':
      return { kind: 'handled' };
    case 'open_dialog':
      return {
        kind: 'dialog',
        resolution: resolveDialogRequest(outcome.request),
      };
    case 'submit_prompt':
      return {
        kind: 'submit',
        content: outcome.content,
        ...(outcome.onComplete ? { onComplete: outcome.onComplete } : {}),
        ...(outcome.modelOverride
          ? { modelOverride: outcome.modelOverride }
          : {}),
        ...(outcome.refreshContextFilesOnWrite
          ? { refreshContextFilesOnWrite: true }
          : {}),
      };
    case 'quit':
      return { kind: 'quit', messages: outcome.messages };
    case 'schedule_tool':
      return {
        kind: 'schedule_tool',
        toolName: outcome.toolName,
        toolArgs: outcome.toolArgs,
      };
    default: {
      const unhandled: never = outcome;
      throw new Error(
        `Unhandled OpenTUI dispatch outcome: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

/** Live capabilities the backend lends the command host. */
export interface BackendCommandSinks {
  applyEvent: (event: OpenTuiStreamEvent) => void;
  /** Clears the visible chat history ('/clear' parity via ui.clear()). */
  clearItems: () => void;
  /** No model turn in flight. */
  isIdle: () => boolean;
  setProcessing: (processing: boolean) => void;
  /** Rebuilds the command registry (commands that mutate the surface). */
  reloadCommands?: () => void;
  /**
   * Replaces the visible transcript with one replay (resume/branch UI swap).
   * The backend folds the events in a single commit (the mount-time replay
   * showed that burst setState drops items).
   */
  resetTranscript?: (events: OpenTuiStreamEvent[]) => void;
  /** UI-side session reset (SessionStats/session-id refresh; /clear). */
  startNewSession?: (sessionId: string) => void;
  setSessionName?: (name: string | null) => void;
  setDebugMessage?: (message: string) => void;
  setGeminiMdFileCount?: (count: number) => void;
  /** Real session stats (uiTelemetryService + real session start time). */
  getSessionStats?: () => SessionStatsState;
  /** Real shell-command confirmation dialog (y / always / n). */
  presentShellConfirmation?: (
    commands: readonly string[],
  ) => Promise<ShellConfirmationResolution>;
  /** Real yes/no action confirmation dialog. */
  presentActionConfirmation?: (promptText: string) => Promise<boolean>;
  /**
   * Live pending command item (spinner rows like /rename's title
   * generation): rendered in a pending area, never committed to the
   * transcript (ink pendingHistoryItems parity).
   */
  setPendingItem?: (item: HistoryItemWithoutId | null) => void;
}

/** Product context the backend lends the host for real session operations. */
export interface BackendCommandHostOptions {
  config?: Config | null;
  settings?: LoadedSettings;
}

/**
 * Builds the concrete command host the dispatcher runs against. History items
 * the dispatcher adds are projected onto the neutral stream; capabilities this
 * renderer does not implement yet report themselves explicitly instead of
 * pretending to succeed.
 */
export function createBackendCommandHost(
  sinks: BackendCommandSinks,
  options?: BackendCommandHostOptions,
): OpenTuiCommandHost {
  const history: HistoryItem[] = [];
  let nextId = 0;
  const sessionShellAllowlist = new Set<string>();
  let pendingItem: HistoryItemWithoutId | null = null;
  let btwItem: HistoryItemBtw | null = null;
  const btwAbortControllerRef: { current: AbortController | null } = {
    current: null,
  };
  // Vim keybindings are not implemented in the OpenTUI renderer; the state
  // tracks reality (always off) so /vim reports faithfully.
  const vimEnabled = false;
  const emit = (text: string) =>
    sinks.applyEvent({ type: 'text', delta: text });

  const projectionContext = (): ItemProjectionContext => ({
    config: options?.config ?? null,
    stats: sinks.getSessionStats?.(),
    settings: options?.settings,
    extensionsUpdateState: host.extensionsUpdateState,
  });

  const host: OpenTuiCommandHost = {
    getHistory: () => history,
    addItem: (item, timestamp) => {
      const id = nextId++;
      history.push({ ...item, id, timestamp } as HistoryItem);
      const event = projectCommandItem(item, projectionContext());
      if (event) sinks.applyEvent(event);
      return id;
    },
    updateItem: (id, updates) => {
      const index = history.findIndex((item) => item.id === id);
      if (index < 0) return;
      const current = history[index];
      if (!current) return;
      history[index] = { ...current, ...updates } as HistoryItem;
    },
    clearItems: () => {
      history.length = 0;
      sinks.clearItems();
    },
    loadHistory: (items) => {
      history.length = 0;
      history.push(...items);
      // Commands that bulk-reload history (e.g. /restore re-instating the
      // rewound transcript) expect it to become visible. Project the items
      // as one transcript commit; session switches override this right
      // after with the authoritative replay.
      if (sinks.resetTranscript) {
        const events: OpenTuiStreamEvent[] = [];
        for (const item of items) {
          const event = projectCommandItem(item, projectionContext());
          if (event) events.push(event);
        }
        events.push({ type: 'done' });
        sinks.resetTranscript(events);
      }
    },
    refreshStatic: () => {},
    clearPendingState: () => {
      pendingItem = null;
      sinks.setPendingItem?.(null);
    },
    cancelBtw: () => {
      btwAbortControllerRef.current?.abort();
      btwAbortControllerRef.current = null;
      btwItem = null;
    },
    get btwItem() {
      return btwItem;
    },
    setBtwItem: (item) => {
      btwItem = item;
      // Make the side-question answer visible in the transcript once it
      // completes (ink pins it in a bottom box; the pending placeholder is
      // not surfaced — only the finished answer is).
      if (item && !item.btw.isPending) {
        const event = projectCommandItem(
          { type: 'btw', btw: item.btw },
          projectionContext(),
        );
        if (event) sinks.applyEvent(event);
      }
    },
    btwAbortControllerRef,
    get pendingItem() {
      return pendingItem;
    },
    setPendingItem: (item) => {
      // Pending rows live outside the transcript (ink pendingHistoryItems):
      // ticks (e.g. /rename's 500ms spinner) must not append permanent
      // history items.
      pendingItem = item;
      sinks.setPendingItem?.(item);
    },
    setDebugMessage: (message) => {
      if (sinks.setDebugMessage) {
        sinks.setDebugMessage(message);
      } else if (message) {
        emit(message);
      }
    },
    // Faithful: vim mode does not exist in this renderer, so the toggle
    // never enables it and reports the actual (off) state. The dispatcher
    // replaces the resulting message with an explicit unsupported notice.
    toggleVimEnabled: async () => vimEnabled,
    setGeminiMdFileCount: (count) => sinks.setGeminiMdFileCount?.(count),
    reloadCommands: () => sinks.reloadCommands?.(),
    setSessionName: (name) => sinks.setSessionName?.(name),
    isIdle: () => sinks.isIdle(),
    extensionsUpdateState: new Map(),
    dispatchExtensionStateUpdate: () => {},
    addConfirmUpdateExtensionRequest: () => {},
    get sessionStats() {
      const live = sinks.getSessionStats?.();
      if (live) return live;
      return {
        sessionId: '',
        sessionStartTime: new Date(),
        metrics: {},
        lastPromptTokenCount: 0,
        promptCount: 0,
      } as unknown as SessionStatsState;
    },
    sessionShellAllowlist,
    addSessionShellAllowlist: (commands) => {
      for (const command of commands) sessionShellAllowlist.add(command);
    },
    startNewSession: (sessionId) => sinks.startNewSession?.(sessionId),
    setIsProcessing: (processing) => sinks.setProcessing(processing),
    presentShellConfirmation: async (commands) => {
      if (sinks.presentShellConfirmation) {
        return sinks.presentShellConfirmation(commands);
      }
      emit(
        `Shell command confirmation (${[...commands].join(', ')}) is not yet ` +
          'available in the OpenTUI renderer; the command was cancelled.',
      );
      return { outcome: ToolConfirmationOutcome.Cancel };
    },
    presentActionConfirmation: async (prompt) => {
      const text = extractPromptText(prompt);
      if (sinks.presentActionConfirmation) {
        return sinks.presentActionConfirmation(
          text || 'Do you want to proceed?',
        );
      }
      emit(
        `Action confirmation${text ? ` (${text})` : ''} is not yet available ` +
          'in the OpenTUI renderer; the action was cancelled.',
      );
      return false;
    },
    handleResume: async (sessionId) => {
      if (options?.config && options.settings) {
        await handleResumeSession(
          buildSessionSwitchHost(sinks, options.config, options.settings, {
            addItem: (item, timestamp) => host.addItem(item, timestamp),
            clearItems: () => host.clearItems(),
            loadHistory: (items) => host.loadHistory(items),
            clearPendingState: () => host.clearPendingState(),
          }),
          sessionId,
        );
        return;
      }
      emit(
        `Resuming session ${sessionId} is not yet available in the OpenTUI renderer.`,
      );
    },
    handleBranch: async (name) => {
      if (options?.config && options.settings) {
        await handleBranchSession(
          buildSessionSwitchHost(sinks, options.config, options.settings, {
            addItem: (item, timestamp) => host.addItem(item, timestamp),
            clearItems: () => host.clearItems(),
            loadHistory: (items) => host.loadHistory(items),
            clearPendingState: () => host.clearPendingState(),
          }),
          name,
        );
        return;
      }
      emit(
        `Session branching${name ? ` ('/${name}')` : ''} is not yet available in the OpenTUI renderer.`,
      );
    },
  };
  return host;
}

/** Adapts the backend sinks to the session-switch host surface. */
function buildSessionSwitchHost(
  sinks: BackendCommandSinks,
  config: Config,
  settings: LoadedSettings,
  historyOps: {
    addItem(item: HistoryItemWithoutId, timestamp: number): number;
    clearItems(): void;
    loadHistory(items: HistoryItem[]): void;
    clearPendingState(): void;
  },
): SessionSwitchHost {
  return {
    config,
    settings,
    addItem: historyOps.addItem,
    clearItems: historyOps.clearItems,
    loadHistory: historyOps.loadHistory,
    startNewSession: (sessionId) => sinks.startNewSession?.(sessionId),
    setSessionName: (name) => sinks.setSessionName?.(name),
    clearPendingState: historyOps.clearPendingState,
    resetTranscript: (events) => {
      if (sinks.resetTranscript) {
        sinks.resetTranscript(events);
        return;
      }
      for (const event of events) sinks.applyEvent(event);
    },
  };
}
