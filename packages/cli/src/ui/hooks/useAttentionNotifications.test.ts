/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingState } from '../types.js';
import {
  AttentionNotificationReason,
  notifyTerminalAttention,
} from '../../utils/attentionNotification.js';
import {
  LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS,
  useAttentionNotifications,
} from './useAttentionNotifications.js';

vi.mock('../../utils/attentionNotification.js', () => ({
  notifyTerminalAttention: vi.fn(),
  AttentionNotificationReason: {
    ToolApproval: 'tool_approval',
    LongTaskComplete: 'long_task_complete',
  },
}));

const mockedNotify = vi.mocked(notifyTerminalAttention);

describe('useAttentionNotifications', () => {
  beforeEach(() => {
    mockedNotify.mockReset();
  });

  const render = (
    props?: Partial<Parameters<typeof useAttentionNotifications>[0]>,
  ) =>
    renderHook(({ hookProps }) => useAttentionNotifications(hookProps), {
      initialProps: {
        hookProps: {
          isFocused: true,
          streamingState: StreamingState.Idle,
          elapsedTime: 0,
          ...props,
        },
      },
    });

  it('notifies when tool approval is required while unfocused', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.WaitingForConfirmation,
        elapsedTime: 0,
      },
    });

    expect(mockedNotify).toHaveBeenCalledWith(
      AttentionNotificationReason.ToolApproval,
    );
  });

  it('notifies when focus is lost after entering approval wait state', () => {
    const { rerender } = render({
      isFocused: true,
      streamingState: StreamingState.WaitingForConfirmation,
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.WaitingForConfirmation,
        elapsedTime: 0,
      },
    });

    expect(mockedNotify).toHaveBeenCalledTimes(1);
  });

  it('sends a notification when a long task finishes while unfocused', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Responding,
        elapsedTime: LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS + 5,
      },
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
      },
    });

    expect(mockedNotify).toHaveBeenCalledWith(
      AttentionNotificationReason.LongTaskComplete,
    );
  });

  it('does not notify about long tasks when the CLI is focused', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: true,
        streamingState: StreamingState.Responding,
        elapsedTime: LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS + 2,
      },
    });

    rerender({
      hookProps: {
        isFocused: true,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
      },
    });

    expect(mockedNotify).not.toHaveBeenCalledWith(
      AttentionNotificationReason.LongTaskComplete,
      expect.anything(),
    );
  });

  it('does not treat short responses as long tasks', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Responding,
        elapsedTime: 5,
      },
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
      },
    });

    expect(mockedNotify).not.toHaveBeenCalled();
  });
});
