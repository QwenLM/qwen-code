/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingState } from '../types.js';
import {
  LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS,
  useAttentionNotifications,
} from './useAttentionNotifications.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { TerminalNotification } from './useTerminalNotification.js';

vi.mock('../../services/notificationService.js', () => ({
  sendNotification: vi.fn(),
}));

const { sendNotification: mockedSendNotification } = await import(
  '../../services/notificationService.js'
);

const mockTerminal: TerminalNotification = {
  notifyITerm2: vi.fn(),
  notifyKitty: vi.fn(),
  notifyGhostty: vi.fn(),
  notifyBell: vi.fn(),
};

const mockSettings: LoadedSettings = {
  merged: {
    general: {
      notifications: 'auto',
    },
  },
} as LoadedSettings;

const mockSettingsDisabled: LoadedSettings = {
  merged: {
    general: {
      notifications: 'notifications_disabled',
    },
  },
} as LoadedSettings;

describe('useAttentionNotifications', () => {
  beforeEach(() => {
    vi.mocked(mockedSendNotification).mockReset();
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
          terminal: mockTerminal,
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
        terminal: mockTerminal,
      },
    });

    expect(mockedSendNotification).toHaveBeenCalledTimes(1);
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
        terminal: mockTerminal,
      },
    });

    expect(mockedSendNotification).toHaveBeenCalledTimes(1);
  });

  it('sends a notification when a long task finishes while unfocused', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Responding,
        elapsedTime: LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS + 5,
        settings: mockSettings,
        terminal: mockTerminal,
      },
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
        settings: mockSettings,
        terminal: mockTerminal,
      },
    });

    expect(mockedSendNotification).toHaveBeenCalledTimes(1);
  });

  it('does not notify about long tasks when the CLI is focused', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: true,
        streamingState: StreamingState.Responding,
        elapsedTime: LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS + 2,
        settings: mockSettings,
        terminal: mockTerminal,
      },
    });

    rerender({
      hookProps: {
        isFocused: true,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
        settings: mockSettings,
        terminal: mockTerminal,
      },
    });

    expect(mockedSendNotification).not.toHaveBeenCalled();
  });

  it('does not treat short responses as long tasks', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Responding,
        elapsedTime: 5,
        settings: mockSettings,
        terminal: mockTerminal,
      },
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.Idle,
        elapsedTime: 0,
        settings: mockSettings,
        terminal: mockTerminal,
      },
    });

    expect(mockedSendNotification).not.toHaveBeenCalled();
  });

  it('does not notify when notifications are disabled', () => {
    const { rerender } = render({
      settings: mockSettingsDisabled,
    });

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.WaitingForConfirmation,
        elapsedTime: 0,
        settings: mockSettingsDisabled,
        terminal: mockTerminal,
      },
    });

    expect(mockedSendNotification).not.toHaveBeenCalled();
  });
});
