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
import type { LoadedSettings } from '../../config/settings.js';

const mockSettings: LoadedSettings = {
  merged: {
    general: {
      terminalBell: true,
    },
  },
} as LoadedSettings;

const mockSettingsDisabled: LoadedSettings = {
  merged: {
    general: {
      terminalBell: false,
    },
  },
} as LoadedSettings;

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
          settings: mockSettings,
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
        settings: mockSettings,
      },
    });

    expect(mockedNotify).toHaveBeenCalledWith(
      AttentionNotificationReason.ToolApproval,
      { enabled: true },
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
        settings: mockSettings,
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
        settings: mockSettings,
      },
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
        settings: mockSettings,
      },
    });

    expect(mockedNotify).toHaveBeenCalledWith(
      AttentionNotificationReason.LongTaskComplete,
      { enabled: true },
    );
  });

  it('does not notify about long tasks when the CLI is focused', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: true,
        streamingState: StreamingState.Responding,
        elapsedTime: LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS + 2,
        settings: mockSettings,
      },
    });

    rerender({
      hookProps: {
        isFocused: true,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
        settings: mockSettings,
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
        settings: mockSettings,
      },
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
        settings: mockSettings,
      },
    });

    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('does not notify when terminalBell setting is disabled', () => {
    const { rerender } = render({
      settings: mockSettingsDisabled,
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.WaitingForConfirmation,
        elapsedTime: 0,
        settings: mockSettingsDisabled,
      },
    });

    expect(mockedNotify).toHaveBeenCalledWith(
      AttentionNotificationReason.ToolApproval,
      { enabled: false },
    );
  });
});
