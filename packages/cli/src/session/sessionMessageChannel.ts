/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { checkExhaustive } from '@qwen-code/core';
import type {
  SessionChange,
  SessionEvent,
  SessionMessageState,
  SessionPort,
  SessionRestoreState,
} from './sessionPort.js';

/** In-process message facts and ordered observations; no transport or execution. */
export interface SessionMessageChannel {
  applyEvent: (event: SessionEvent) => void;
  restore: (state: SessionRestoreState) => void;
  observe: SessionPort['observe'];
}

export function createSessionMessageChannel(
  initialState: SessionRestoreState,
): SessionMessageChannel {
  let state: SessionMessageState = {
    ...initialState,
    pendingThinkingText: '',
    isSending: false,
  };
  const listeners = new Set<(change: SessionChange) => void>();
  // Only serializes observation delivery; it is not an execution/input queue.
  const notifications: Array<{
    change: SessionChange;
    recipients: Array<(change: SessionChange) => void>;
  }> = [];
  let publishing = false;

  const broadcast = (change: SessionChange) => {
    notifications.push({ change, recipients: [...listeners] });
    if (publishing) return;
    publishing = true;
    try {
      while (notifications.length > 0) {
        const notification = notifications.shift()!;
        for (const recipient of notification.recipients) {
          if (listeners.has(recipient)) recipient(notification.change);
        }
      }
    } finally {
      publishing = false;
    }
  };

  const applyEvent = (change: SessionEvent) => {
    switch (change.type) {
      case 'input_prepared':
      case 'send_failed':
        break;
      case 'send_started':
        state = {
          ...state,
          isSending: true,
          activityStatus: 'running',
          pendingThinkingText: '',
        };
        break;
      case 'send_finished':
        state = { ...state, isSending: false };
        break;
      case 'user_message':
        state = { ...state, pendingAssistantText: '', pendingThinkingText: '' };
        break;
      case 'assistant_message':
        state = {
          ...state,
          pendingAssistantText: '',
          pendingThinkingText: '',
          ...(change.endsTurn ? { activityStatus: 'idle' } : {}),
        };
        break;
      case 'assistant_stream':
        state = { ...state, activityStatus: 'running' };
        if (change.delta?.type === 'text_delta') {
          state = {
            ...state,
            pendingAssistantText:
              state.pendingAssistantText + change.delta.text,
            pendingThinkingText: '',
          };
        } else if (change.delta?.type === 'thinking_delta') {
          state = {
            ...state,
            pendingThinkingText: state.pendingThinkingText + change.delta.text,
          };
        }
        break;
      case 'status':
        state = { ...state, activityStatus: change.activityStatus };
        if (change.transition && change.activityStatus === 'idle') {
          state = {
            ...state,
            pendingAssistantText: '',
            pendingThinkingText: '',
          };
        }
        break;
      case 'interrupted':
        if (change.scope !== 'permission') {
          state = {
            ...state,
            activityStatus: 'idle',
            pendingAssistantText: '',
            pendingThinkingText: '',
          };
        }
        break;
      case 'error':
        state = {
          ...state,
          activityStatus: 'idle',
          pendingAssistantText: '',
          pendingThinkingText: '',
        };
        break;
      case 'connection_closed':
        state = { ...state, pendingAssistantText: '' };
        break;
      default:
        checkExhaustive(change);
    }
    broadcast(change);
  };

  return {
    applyEvent,
    restore: (restored) => {
      // Like the old restore effect, keep the current send flag.
      state = { ...state, ...restored, pendingThinkingText: '' };
      broadcast({ type: 'snapshot', state, reason: 'restore' });
    },
    observe: (listener) => {
      let initializing = true;
      let active = true;
      const pending: SessionChange[] = [];
      const receive = (change: SessionChange) => {
        if (!active) return;
        if (initializing) pending.push(change);
        else listener(change);
      };
      listeners.add(receive);
      try {
        listener({ type: 'snapshot', state, reason: 'observe' });
        while (pending.length > 0) listener(pending.shift()!);
        initializing = false;
      } catch (error) {
        listeners.delete(receive);
        throw error;
      }
      return () => {
        active = false;
        pending.length = 0;
        listeners.delete(receive);
      };
    },
  };
}
