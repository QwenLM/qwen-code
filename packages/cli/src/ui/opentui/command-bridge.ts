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
 *    stream event the backend folds into its chat history;
 *  - `resolveDispatchOutcome` decides what the backend does for one
 *    `OpenTuiDispatchOutcome` (open a mounted dialog, submit to the live
 *    client, quit, or report an explicitly unsupported capability);
 *  - `resolveDialogRequest` classifies every dialog kind against the
 *    already-ported dialog family — unsupported kinds are represented
 *    explicitly, never silently dropped;
 *  - `createBackendCommandHost` builds the concrete `OpenTuiCommandHost` the
 *    dispatcher runs against, wired to the backend's event sink.
 */

import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import type { PartListUnion } from '@google/genai';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { OpenTuiCommandHost } from './commands-context.js';
import type { OpenTuiDispatchOutcome } from './commands-dispatch.js';
import type { OpenTuiDialogRequest } from './commands-registry.js';
import type { ModelDialogMode } from './dialogs-model.js';

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
    }
  | { kind: 'quit' }
  /** A capability this renderer does not implement yet. */
  | { kind: 'unsupported'; message: string };

/**
 * Projects one ink command history item onto the neutral stream. Returns null
 * for item kinds the chat transcript does not render (dialog payloads, etc.).
 */
export function projectCommandItem(
  item: HistoryItemWithoutId,
): OpenTuiStreamEvent | null {
  switch (item.type) {
    case 'user':
      return { type: 'user', text: item.text };
    case 'info':
    case 'success':
    case 'warning':
    case 'error':
      return { type: 'text', delta: item.text };
    default:
      return null;
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
    case 'statusline':
    case 'memory':
    case 'auth':
    case 'trust':
    case 'approval-mode':
    case 'effort':
    case 'delete':
    case 'resume':
    case 'branch':
    case 'hooks':
    case 'rewind':
    case 'diff':
    case 'arena':
    case 'subagent_create':
    case 'subagent_list':
      return {
        kind: 'unsupported',
        message: `The '${request.dialog}' dialog is not yet available in the OpenTUI renderer.`,
      };
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
      };
    case 'quit':
      return { kind: 'quit' };
    case 'schedule_tool':
      return {
        kind: 'unsupported',
        message: `Tool scheduling for '${outcome.toolName}' is not yet available in the OpenTUI renderer.`,
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
}

/**
 * Builds the concrete command host the dispatcher runs against. History items
 * the dispatcher adds are projected onto the neutral stream; capabilities this
 * renderer does not implement yet report themselves explicitly instead of
 * pretending to succeed.
 */
export function createBackendCommandHost(
  sinks: BackendCommandSinks,
): OpenTuiCommandHost {
  const history: HistoryItem[] = [];
  let nextId = 0;
  const sessionShellAllowlist = new Set<string>();
  const emit = (text: string) =>
    sinks.applyEvent({ type: 'text', delta: text });

  const host: OpenTuiCommandHost = {
    getHistory: () => history,
    addItem: (item, timestamp) => {
      const id = nextId++;
      history.push({ ...item, id, timestamp } as HistoryItem);
      const event = projectCommandItem(item);
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
    },
    refreshStatic: () => {},
    clearPendingState: () => {},
    cancelBtw: () => {},
    btwItem: null,
    setBtwItem: () => {},
    btwAbortControllerRef: { current: null },
    pendingItem: null,
    setPendingItem: () => {},
    setDebugMessage: () => {},
    toggleVimEnabled: async () => false,
    setGeminiMdFileCount: () => {},
    reloadCommands: () => sinks.reloadCommands?.(),
    setSessionName: () => {},
    isIdle: () => sinks.isIdle(),
    extensionsUpdateState: new Map(),
    dispatchExtensionStateUpdate: () => {},
    addConfirmUpdateExtensionRequest: () => {},
    sessionStats: {
      sessionId: '',
      sessionStartTime: new Date(),
      metrics: {},
      lastPromptTokenCount: 0,
      promptCount: 0,
    } as unknown as SessionStatsState,
    sessionShellAllowlist,
    addSessionShellAllowlist: (commands) => {
      for (const command of commands) sessionShellAllowlist.add(command);
    },
    setIsProcessing: (processing) => sinks.setProcessing(processing),
    presentShellConfirmation: async (commands) => {
      emit(
        `Shell command confirmation (${[...commands].join(', ')}) is not yet ` +
          'available in the OpenTUI renderer; the command was cancelled.',
      );
      return { outcome: ToolConfirmationOutcome.Cancel };
    },
    presentActionConfirmation: async (prompt) => {
      const text = typeof prompt === 'string' ? prompt : '';
      emit(
        `Action confirmation${text ? ` (${text})` : ''} is not yet available ` +
          'in the OpenTUI renderer; the action was cancelled.',
      );
      return false;
    },
    handleResume: async (sessionId) => {
      emit(
        `Resuming session ${sessionId} is not yet available in the OpenTUI renderer.`,
      );
    },
    handleBranch: async (name) => {
      emit(
        `Session branching${name ? ` ('/${name}')` : ''} is not yet available in the OpenTUI renderer.`,
      );
    },
  };
  return host;
}
