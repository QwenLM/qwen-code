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
import type { TrackedToolCall } from './useReactToolScheduler.js';

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
  writeTerminalSequence: vi.fn(() => true),
};

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

// Approval notifications suppressed; task-completion notifications preserved.
const mockSettingsTaskCompleteOnly: LoadedSettings = {
  merged: {
    general: {
      terminalBell: true,
      notificationMode: 'task-complete',
    },
  },
} as LoadedSettings;

// Explicit 'all' — same behavior as an unset notificationMode.
const mockSettingsAllMode: LoadedSettings = {
  merged: {
    general: {
      terminalBell: true,
      notificationMode: 'all',
    },
  },
} as LoadedSettings;

// Unknown value must fall back to 'all' rather than silently disabling
// approval notifications (defensive parse in the hook).
const mockSettingsUnknownMode: LoadedSettings = {
  merged: {
    general: {
      terminalBell: true,
      notificationMode: 'garbage-value',
    },
  },
} as unknown as LoadedSettings;

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
    expect(mockedSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Qwen Code' }),
      mockTerminal,
      true,
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

  it('includes tool name in approval notification message', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.WaitingForConfirmation,
        elapsedTime: 0,
        settings: mockSettings,
        terminal: mockTerminal,
        pendingToolCalls: [
          { status: 'awaiting_approval', request: { name: 'Bash' } },
        ] as unknown as TrackedToolCall[],
      },
    });

    expect(mockedSendNotification).toHaveBeenCalledTimes(1);
    expect(mockedSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Qwen Code needs your permission to use Bash',
      }),
      mockTerminal,
      true,
    );
  });

  it('uses fallback message when no pending tool call is found', () => {
    const { rerender } = render();

    rerender({
      hookProps: {
        isFocused: false,
        streamingState: StreamingState.WaitingForConfirmation,
        elapsedTime: 0,
        settings: mockSettings,
        terminal: mockTerminal,
        pendingToolCalls: [] as TrackedToolCall[],
      },
    });

    expect(mockedSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Qwen Code is waiting for your input',
      }),
      mockTerminal,
      true,
    );
  });

  it('sends "waiting for input" message for long task completion', () => {
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

    expect(mockedSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Qwen Code is waiting for your input',
      }),
      mockTerminal,
      true,
    );
  });

  it('does not notify when terminalBell is disabled', () => {
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

  describe('notificationMode (#6898)', () => {
    it('suppresses approval notification when mode is task-complete', () => {
      // The whole point of the task-complete mode: users driving many tool
      // approvals in a single task no longer get an OS notification for every
      // one. The WaitingForConfirmation transition must NOT fire sendNotification.
      const { rerender } = render({ settings: mockSettingsTaskCompleteOnly });

      rerender({
        hookProps: {
          isFocused: false,
          streamingState: StreamingState.WaitingForConfirmation,
          elapsedTime: 0,
          settings: mockSettingsTaskCompleteOnly,
          terminal: mockTerminal,
        },
      });

      expect(mockedSendNotification).not.toHaveBeenCalled();
    });

    it('still fires task-completion notification when mode is task-complete', () => {
      // task-complete only silences approvals — the long-task idle notification
      // is the one the user WANTS to keep. Guards against widening the gate.
      const { rerender } = render({ settings: mockSettingsTaskCompleteOnly });

      // Simulate a long streaming task followed by return to Idle while
      // unfocused, matching the LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS path.
      rerender({
        hookProps: {
          isFocused: false,
          streamingState: StreamingState.Responding,
          elapsedTime: LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS + 1,
          settings: mockSettingsTaskCompleteOnly,
          terminal: mockTerminal,
        },
      });
      rerender({
        hookProps: {
          isFocused: false,
          streamingState: StreamingState.Idle,
          elapsedTime: LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS + 1,
          settings: mockSettingsTaskCompleteOnly,
          terminal: mockTerminal,
        },
      });

      expect(mockedSendNotification).toHaveBeenCalledTimes(1);
      expect(mockedSendNotification).toHaveBeenCalledWith(
        {
          message: 'Qwen Code is waiting for your input',
          title: 'Qwen Code',
        },
        mockTerminal,
        true,
      );
    });

    it('preserves current behavior when mode is explicitly "all"', () => {
      // Setting notificationMode: 'all' must be a no-op compared to leaving
      // it unset — same firing pattern as the pre-#6898 default.
      const { rerender } = render({ settings: mockSettingsAllMode });

      rerender({
        hookProps: {
          isFocused: false,
          streamingState: StreamingState.WaitingForConfirmation,
          elapsedTime: 0,
          settings: mockSettingsAllMode,
          terminal: mockTerminal,
        },
      });

      expect(mockedSendNotification).toHaveBeenCalledTimes(1);
    });

    it('falls back to "all" when notificationMode is an unrecognized value', () => {
      // A legacy settings file with a typo or a future value we don't know
      // yet must not silently disable approval notifications — the user's
      // intent is unclear, so we preserve the visible (louder) behavior.
      const { rerender } = render({ settings: mockSettingsUnknownMode });

      rerender({
        hookProps: {
          isFocused: false,
          streamingState: StreamingState.WaitingForConfirmation,
          elapsedTime: 0,
          settings: mockSettingsUnknownMode,
          terminal: mockTerminal,
        },
      });

      expect(mockedSendNotification).toHaveBeenCalledTimes(1);
    });
  });
});
