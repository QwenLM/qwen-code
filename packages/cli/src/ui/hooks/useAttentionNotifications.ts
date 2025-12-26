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

export const LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS = 20;

interface UseAttentionNotificationsOptions {
  isFocused: boolean;
  streamingState: StreamingState;
  elapsedTime: number;
  settings: LoadedSettings;
}

export const useAttentionNotifications = ({
  isFocused,
  streamingState,
  elapsedTime,
  settings,
}: UseAttentionNotificationsOptions) => {
  const terminalBellEnabled = settings?.merged?.general?.terminalBell ?? true;
  const awaitingNotificationSentRef = useRef(false);
  const respondingElapsedRef = useRef(0);

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
      return;
    }
  }, [streamingState, elapsedTime, isFocused, terminalBellEnabled]);
};
