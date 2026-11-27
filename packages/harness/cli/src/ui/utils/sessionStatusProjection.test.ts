/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MessageType,
  StreamingState,
  type HistoryItemWithoutId,
} from '../types.js';
import {
  getActiveModelQueue,
  getSessionStreamingState,
} from './sessionStatusProjection.js';

describe('session status projection', () => {
  it('prioritizes approval over running, pending text and submission', () => {
    expect(
      getSessionStreamingState({
        pendingApprovalCount: 1,
        pendingAssistantText: 'pending',
        workerStatus: 'running',
        isSubmitting: true,
      }),
    ).toBe(StreamingState.WaitingForConfirmation);
  });

  it.each([
    { pendingAssistantText: 'text', workerStatus: 'idle', isSubmitting: false },
    { pendingAssistantText: ' ', workerStatus: 'idle', isSubmitting: false },
    { pendingAssistantText: '', workerStatus: 'running', isSubmitting: false },
    { pendingAssistantText: '', workerStatus: 'idle', isSubmitting: true },
  ])('shows responding for %j', (state) => {
    expect(
      getSessionStreamingState({ pendingApprovalCount: 0, ...state }),
    ).toBe(StreamingState.Responding);
  });

  it('does not invent a pending approval from the worker status alone', () => {
    expect(
      getSessionStreamingState({
        pendingApprovalCount: 0,
        pendingAssistantText: '',
        workerStatus: 'requires_action',
        isSubmitting: false,
      }),
    ).toBe(StreamingState.Idle);
  });

  it('returns the first queue unchanged and ignores ordinary pending items', () => {
    const first = { status: 'queued' as const, progress: 10 };
    const second = { status: 'ready' as const, progress: 100 };
    const items: HistoryItemWithoutId[] = [
      { type: MessageType.GEMINI, text: 'pending' },
      { type: MessageType.MODEL_QUEUE, modelQueue: first },
      { type: MessageType.MODEL_QUEUE, modelQueue: second },
    ];
    expect(getActiveModelQueue(items)).toBe(first);
    expect(getActiveModelQueue(null)).toBeNull();
    expect(getActiveModelQueue(items.slice(0, 1))).toBeNull();
  });
});
