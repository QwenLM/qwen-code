/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  checkExhaustive,
  parseThought,
  type ThoughtSummary,
} from '@qwen-code/core';
import type {
  AssistantStreamDelta,
  SessionMessageSource,
  SessionChange,
  SessionMessageInput,
  SessionSubmitOptions,
  SessionInterruptOptions,
  SessionPort,
} from '../../session/sessionPort.js';
import type {
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
  ModelQueueProps,
  StreamingState,
} from '../types.js';
import { getMessageHistoryPolicy } from './messageHistoryPolicy.js';
import { createPendingAssistantTextStore } from '../state/pendingAssistantTextStore.js';
import { createThinkingTextState } from '../state/thinkingTextState.js';
import { applyAssistantStreamDelta } from '../utils/assistantStreamProjection.js';
import { appendAssistantMessageToHistory } from '../utils/assistantMessageProjection.js';
import {
  appendUserMessageToHistory,
  extractUserMessageImages,
  type UserMessageDisplayContent,
} from '../utils/userMessageProjection.js';
import { appendToolResultsToHistory } from '../utils/toolResultProjection.js';
import type { ProjectToolDisplayInput } from '../utils/toolDisplayProjection.js';
import {
  applyDisplayHistoryChange,
  prepareMessageHistory,
  type DisplayHistoryChange,
} from '../utils/displayHistoryProjection.js';
import { buildPendingHistoryItems } from '../utils/historyProjection.js';
import {
  getActiveModelQueue,
  getSessionStreamingState,
} from '../utils/sessionStatusProjection.js';
import {
  appendMessageError,
  applyMessageError,
  applyMessageInterruption,
} from '../utils/messageNoticeProjection.js';

/** Inputs used by the terminal's response-state render cache. */
export interface CliSessionResponseState {
  readonly pendingAssistantText: string;
  readonly pendingApprovalCount: number;
  readonly workerStatus: string;
}

/** Current terminal display; formal history remains owned by historyManager. */
export interface CliSessionDisplaySnapshot extends CliSessionResponseState {
  readonly thought: ThoughtSummary | null;
  readonly pendingHistoryItems: HistoryItemWithoutId[];
  readonly activeModelQueue: ModelQueueProps | null;
}

export interface CliSessionDisplayInitialState {
  pendingAssistantText: string;
  pendingApprovalTools: IndividualToolCallDisplay[];
  workerStatus: string;
  pendingDisplayHistory: HistoryItemWithoutId[] | null;
  historyAvailable: boolean;
}

type ApprovalToolsUpdate =
  | IndividualToolCallDisplay[]
  | ((previous: IndividualToolCallDisplay[]) => IndividualToolCallDisplay[]);

/** CLI display input, not the SessionPort or remote wire protocol. */
export type CliSessionDisplayChange =
  | {
      type: 'assistant_stream_delta';
      delta: AssistantStreamDelta;
    }
  | { type: 'user_message'; content: UserMessageDisplayContent }
  | { type: 'tool_results'; results: readonly ProjectToolDisplayInput[] }
  | {
      type: 'assistant_message';
      thinkingTexts: readonly string[];
      text: string;
    }
  | { type: 'user_received' }
  | { type: 'assistant_received'; terminal: boolean }
  | { type: 'submission_started' }
  | { type: 'submission_finished' }
  | { type: 'worker_status'; status: string }
  | { type: 'worker_idle' }
  | { type: 'approval_tools'; update: ApprovalToolsUpdate }
  | { type: 'display_history'; change: DisplayHistoryChange }
  | { type: 'error'; text: string }
  | { type: 'request_error'; text: string }
  | { type: 'interruption'; message: string; permissionOnly: boolean }
  | { type: 'disconnected' };

type HistoryWriter = (item: HistoryItemWithoutId) => void;

export interface CliSessionBridge {
  getSnapshot: () => CliSessionDisplaySnapshot;
  observeSession: () => () => void;
  submitMessage: (
    message: SessionMessageInput,
    options?: SessionSubmitOptions,
    writer?: HistoryWriter,
  ) => Promise<void>;
  interrupt: (
    writer?: HistoryWriter,
    options?: SessionInterruptOptions,
  ) => void;
  subscribe: (listener: () => void) => () => void;
  apply: (
    change: CliSessionDisplayChange,
    addHistoryItem?: HistoryWriter,
  ) => void;
  initialize: (state: CliSessionDisplayInitialState) => void;
  prepareHistory: (options: {
    preferDisplayEvents?: boolean;
    allowDurableDisplayFallback?: boolean;
  }) => boolean;
  // The caller caches this calculation using the input fields from its render.
  getStreamingState: (response: CliSessionResponseState) => StreamingState;
  getIsResponding: () => boolean;
  dispose: () => void;
}

interface DisplayState
  extends Omit<CliSessionDisplayInitialState, 'pendingAssistantText'> {
  thought: ThoughtSummary | null;
}

/** Owns one session's display state without React, transport or execution. */
export function createCliSessionBridge({
  initialState,
  addHistoryItem,
  port,
  formatRequestError = (operation, message) =>
    `Failed to ${operation === 'submit' ? 'send message' : 'interrupt session'}: ${message}`,
}: {
  initialState: CliSessionDisplayInitialState;
  addHistoryItem: HistoryWriter;
  port?: SessionPort;
  formatRequestError?: (
    operation: 'submit' | 'interrupt',
    message: string,
  ) => string;
}): CliSessionBridge {
  const assistantText = createPendingAssistantTextStore(
    initialState.pendingAssistantText,
  );
  const thinkingText = createThinkingTextState();
  const listeners = new Set<() => void>();
  const submissions = new Map<
    string,
    { hideFromDisplay?: boolean; writer: HistoryWriter }
  >();
  let stopSessionObservation: (() => void) | undefined;
  let state: DisplayState = {
    pendingApprovalTools: initialState.pendingApprovalTools,
    workerStatus: initialState.workerStatus,
    pendingDisplayHistory: initialState.pendingDisplayHistory,
    historyAvailable: initialState.historyAvailable,
    thought: null,
  };
  // Like the original ref, submission alone does not invalidate display caches.
  let isSubmitting = false;
  let snapshot: CliSessionDisplaySnapshot;
  let previousState: DisplayState | undefined;

  const update = (patch: Partial<DisplayState>) => {
    state = { ...state, ...patch };
  };
  const clearActiveDisplay = () => {
    assistantText.replace('');
    thinkingText.clearPending();
    update({ thought: null });
  };

  const refreshSnapshot = (): boolean => {
    const text = assistantText.getSnapshot();
    const previous = previousState;
    const activeModelQueue =
      previous && previous.pendingDisplayHistory === state.pendingDisplayHistory
        ? snapshot.activeModelQueue
        : getActiveModelQueue(state.pendingDisplayHistory);
    const pendingHistoryItems =
      previous &&
      snapshot.pendingAssistantText === text &&
      previous.pendingApprovalTools === state.pendingApprovalTools &&
      previous.pendingDisplayHistory === state.pendingDisplayHistory &&
      previous.thought === state.thought
        ? snapshot.pendingHistoryItems
        : buildPendingHistoryItems({
            pendingDisplayHistory: state.pendingDisplayHistory,
            pendingAssistantText: text,
            pendingApprovalTools: state.pendingApprovalTools,
            thought: state.thought,
          });
    previousState = state;
    if (
      snapshot &&
      snapshot.pendingAssistantText === text &&
      snapshot.thought === state.thought &&
      snapshot.pendingHistoryItems === pendingHistoryItems &&
      snapshot.pendingApprovalCount === state.pendingApprovalTools.length &&
      snapshot.workerStatus === state.workerStatus &&
      snapshot.activeModelQueue === activeModelQueue
    ) {
      return false;
    }
    snapshot = {
      pendingAssistantText: text,
      thought: state.thought,
      pendingHistoryItems,
      pendingApprovalCount: state.pendingApprovalTools.length,
      workerStatus: state.workerStatus,
      activeModelQueue,
    };
    return true;
  };

  const publish = () => {
    if (refreshSnapshot()) {
      for (const listener of listeners) listener();
    }
  };
  refreshSnapshot();

  const apply: CliSessionBridge['apply'] = (
    change,
    writeHistory = addHistoryItem,
  ) => {
    const noticeTarget = {
      addHistoryItem: writeHistory,
      setIdle: () => update({ workerStatus: 'idle' }),
      clearAssistantText: () => assistantText.replace(''),
      clearThinkingText: thinkingText.clearPending,
      clearThought: () => update({ thought: null }),
      clearApprovals: () => update({ pendingApprovalTools: [] }),
      clearPendingHistory: () => update({ pendingDisplayHistory: null }),
    };
    try {
      switch (change.type) {
        case 'assistant_stream_delta':
          applyAssistantStreamDelta(change.delta, {
            thinkingTextState: thinkingText,
            appendAssistantText: assistantText.append,
            setThought: (thought) => update({ thought }),
            addHistoryItem: writeHistory,
          });
          break;
        case 'user_message':
          appendUserMessageToHistory(change.content, writeHistory);
          break;
        case 'tool_results':
          appendToolResultsToHistory(change.results, writeHistory);
          break;
        case 'assistant_message':
          appendAssistantMessageToHistory(change, {
            thinkingTextState: thinkingText,
            addHistoryItem: writeHistory,
          });
          break;
        case 'user_received':
          assistantText.replace('');
          thinkingText.reset();
          update({ thought: null });
          break;
        case 'assistant_received':
          clearActiveDisplay();
          if (change.terminal) {
            update({ workerStatus: 'idle', pendingDisplayHistory: null });
          }
          break;
        case 'submission_started':
          isSubmitting = true;
          update({ workerStatus: 'running' });
          thinkingText.reset();
          update({ thought: null });
          break;
        case 'submission_finished':
          isSubmitting = false;
          break;
        case 'worker_status':
          update({ workerStatus: change.status });
          break;
        case 'worker_idle':
          // Status was applied by the caller; this entry only clears display.
          clearActiveDisplay();
          update({ pendingDisplayHistory: null });
          break;
        case 'approval_tools':
          update({
            pendingApprovalTools:
              typeof change.update === 'function'
                ? change.update(state.pendingApprovalTools)
                : change.update,
          });
          break;
        case 'display_history':
          applyDisplayHistoryChange(change.change, {
            isHistoryAvailable: () => state.historyAvailable,
            markHistoryAvailable: () => update({ historyAvailable: true }),
            addHistoryItem: writeHistory,
            setPendingHistory: (items) =>
              update({ pendingDisplayHistory: items }),
          });
          break;
        case 'error':
          applyMessageError(change.text, noticeTarget);
          break;
        case 'request_error':
          appendMessageError(change.text, writeHistory);
          break;
        case 'interruption':
          applyMessageInterruption(
            { ...change, historyAvailable: state.historyAvailable },
            noticeTarget,
          );
          break;
        case 'disconnected':
          assistantText.replace('');
          update({ pendingApprovalTools: [] });
          break;
        default:
          checkExhaustive(change);
      }
    } finally {
      publish();
    }
  };

  const consumeSessionChange = (change: SessionChange) => {
    switch (change.type) {
      case 'snapshot':
        assistantText.replace(change.state.pendingAssistantText);
        thinkingText.clearPending();
        if (change.state.pendingThinkingText) {
          thinkingText.append(change.state.pendingThinkingText);
          update({ thought: parseThought(change.state.pendingThinkingText) });
        } else if (change.reason === 'observe') {
          // Observation reads current facts; restore retains the old thought display.
          update({ thought: null });
        }
        isSubmitting = change.state.isSending;
        update({ workerStatus: change.state.activityStatus });
        publish();
        break;
      case 'input_prepared': {
        const submission = submissions.get(change.message.id);
        if (!change.source?.hasDisplayHistory && !submission?.hideFromDisplay) {
          apply(
            {
              type: 'user_message',
              content: {
                text: change.message.text,
                images: extractUserMessageImages(change.message.content),
              },
            },
            submission?.writer,
          );
        }
        break;
      }
      case 'send_started':
        apply({ type: 'submission_started' });
        break;
      case 'send_failed':
        apply(
          {
            type: 'request_error',
            text: formatRequestError('submit', change.errorMessage),
          },
          submissions.get(change.messageId)?.writer,
        );
        break;
      case 'send_finished':
        apply({ type: 'submission_finished' });
        break;
      case 'user_message': {
        const suppress = prepareHistoryForMessage(change.source);
        if (!suppress) {
          if (change.toolResults?.length)
            apply({ type: 'tool_results', results: change.toolResults });
          else if (
            change.content &&
            !change.synthetic &&
            (change.content.text || change.content.images.length > 0)
          ) {
            apply({ type: 'user_message', content: change.content });
          }
        }
        apply({ type: 'user_received' });
        break;
      }
      case 'assistant_message':
        if (!prepareHistoryForMessage(change.source) && change.content) {
          apply({ type: 'assistant_message', ...change.content });
        }
        apply({ type: 'assistant_received', terminal: change.endsTurn });
        break;
      case 'assistant_stream':
        prepareHistoryForMessage(change.source);
        apply({ type: 'worker_status', status: 'running' });
        if (change.delta)
          apply(
            { type: 'assistant_stream_delta', delta: change.delta },
            // The source already persists thinking in its display history.
            change.source.hasDisplayHistory ? () => {} : undefined,
          );
        break;
      case 'status':
        apply({ type: 'worker_status', status: change.activityStatus });
        if (change.transition && change.activityStatus === 'idle')
          apply({ type: 'worker_idle' });
        break;
      case 'interrupted':
        apply({
          type: 'interruption',
          message: change.message,
          permissionOnly: change.scope === 'permission',
        });
        break;
      case 'error':
        apply({ type: 'error', text: change.message });
        break;
      case 'connection_closed':
        apply({ type: 'disconnected' });
        break;
      default:
        checkExhaustive(change);
    }
  };
  const prepareHistoryForMessage = (source: SessionMessageSource) => {
    const suppress = prepareMessageHistory(
      {
        historyAvailable: state.historyAvailable,
        ...getMessageHistoryPolicy(source),
      },
      (items) => update({ pendingDisplayHistory: items }),
    );
    publish();
    return suppress;
  };
  const observeSession = () => {
    if (port && !stopSessionObservation)
      stopSessionObservation = port.observe(consumeSessionChange);
    return () => {
      stopSessionObservation?.();
      stopSessionObservation = undefined;
    };
  };
  const requirePort = () => {
    if (!port) throw new Error('Session operations are not connected');
    observeSession();
    return port;
  };

  return {
    getSnapshot: () => snapshot,
    observeSession,
    submitMessage: async (message, options, writer = addHistoryItem) => {
      const session = requirePort();
      submissions.set(message.id, {
        hideFromDisplay: options?.hideFromDisplay,
        writer,
      });
      try {
        await session.submitMessage(message, options);
      } finally {
        submissions.delete(message.id);
      }
    },
    interrupt: (writer = addHistoryItem, options) => {
      void requirePort()
        .interrupt(options)
        .catch((error: unknown) => {
          apply(
            {
              type: 'request_error',
              text: formatRequestError(
                'interrupt',
                error instanceof Error ? error.message : String(error),
              ),
            },
            writer,
          );
        });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply,
    initialize: (initial) => {
      assistantText.replace(initial.pendingAssistantText);
      update({
        workerStatus: initial.workerStatus,
        pendingDisplayHistory: initial.pendingDisplayHistory,
        historyAvailable: initial.historyAvailable,
        pendingApprovalTools: initial.pendingApprovalTools,
      });
      thinkingText.reset();
      // The original restore effect does not clear the current thought or submission ref.
      publish();
    },
    prepareHistory: (options) => {
      const suppress = prepareMessageHistory(
        { ...options, historyAvailable: state.historyAvailable },
        (items) => update({ pendingDisplayHistory: items }),
      );
      publish();
      return suppress;
    },
    getStreamingState: (response) =>
      getSessionStreamingState({ ...response, isSubmitting }),
    getIsResponding: () =>
      state.pendingApprovalTools.length > 0 ||
      !!assistantText.getSnapshot() ||
      state.workerStatus === 'running' ||
      isSubmitting,
    // Cleanup must also tolerate React's setup/cleanup/setup subscription cycle.
    // No connection or execution resource is owned by this display bridge.
    dispose: () => {
      stopSessionObservation?.();
      stopSessionObservation = undefined;
      listeners.clear();
    },
  };
}
