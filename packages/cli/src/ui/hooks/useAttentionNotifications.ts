/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { StreamingState } from '../types.js';
import {
  notifyTerminalAttention,
  AttentionNotificationReason,
} from '../../utils/attentionNotification.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  fireNotificationHook,
  NotificationType,
} from '@qwen-code/qwen-code-core';

export const LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS = 20;

interface UseAttentionNotificationsOptions {
  isFocused: boolean;
  streamingState: StreamingState;
  elapsedTime: number;
  settings: LoadedSettings;
  config?: Config;
}

export const useAttentionNotifications = ({
  isFocused,
  streamingState,
  elapsedTime,
  settings,
  config,
}: UseAttentionNotificationsOptions) => {
  const terminalBellEnabled = settings?.merged?.general?.terminalBell ?? true;
  const awaitingNotificationSentRef = useRef(false);
  const respondingElapsedRef = useRef(0);
  const idleNotificationSentRef = useRef(false);

  useEffect(() => {
    if (
      streamingState === StreamingState.WaitingForConfirmation &&
      !isFocused &&
      !awaitingNotificationSentRef.current
    ) {
      notifyTerminalAttention(AttentionNotificationReason.ToolApproval, {
        enabled: terminalBellEnabled,
      });
      awaitingNotificationSentRef.current = true;
    }

    if (streamingState !== StreamingState.WaitingForConfirmation || isFocused) {
      awaitingNotificationSentRef.current = false;
    }
  }, [isFocused, streamingState, terminalBellEnabled]);

  useEffect(() => {
    if (streamingState === StreamingState.Responding) {
      respondingElapsedRef.current = elapsedTime;
      // Reset idle notification flag when responding
      idleNotificationSentRef.current = false;
      return;
    }

    if (streamingState === StreamingState.Idle) {
      const wasLongTask =
        respondingElapsedRef.current >=
        LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS;
      if (wasLongTask && !isFocused) {
        notifyTerminalAttention(AttentionNotificationReason.LongTaskComplete, {
          enabled: terminalBellEnabled,
        });
      }
      // Reset tracking for next task
      respondingElapsedRef.current = 0;

      // Fire idle_prompt notification hook when entering idle state
      if (config && !idleNotificationSentRef.current) {
        const messageBus = config.getMessageBus();
        const hooksEnabled = !config.getDisableAllHooks();
        if (hooksEnabled && messageBus) {
          fireNotificationHook(
            messageBus,
            'Qwen Code is waiting for your input',
            NotificationType.IdlePrompt,
            'Waiting for input',
          ).catch(() => {
            // Silently ignore errors - fireNotificationHook has internal error handling
            // and notification hooks should not block the idle flow
          });
        }
        idleNotificationSentRef.current = true;
      }
      return;
    }

    // Reset idle notification flag when in WaitingForConfirmation state
    idleNotificationSentRef.current = false;
  }, [streamingState, elapsedTime, isFocused, terminalBellEnabled, config]);
};
