/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { StreamingState } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  fireNotificationHook,
  NotificationType,
} from '@qwen-code/qwen-code-core';
import type { TerminalNotification } from './useTerminalNotification.js';
import { sendNotification } from '../../services/notificationService.js';

export const LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS = 20;

const NOTIFICATION_TITLE = 'Qwen Code';

interface PendingToolCall {
  status: string;
  request: { name: string };
}

interface UseAttentionNotificationsOptions {
  isFocused: boolean;
  streamingState: StreamingState;
  elapsedTime: number;
  settings: LoadedSettings;
  config?: Config;
  terminal: TerminalNotification;
  pendingToolCalls?: PendingToolCall[];
}

export const useAttentionNotifications = ({
  isFocused,
  streamingState,
  elapsedTime,
  settings,
  config,
  terminal,
  pendingToolCalls,
}: UseAttentionNotificationsOptions) => {
  const terminalBellEnabled: boolean =
    (settings?.merged?.general?.terminalBell as boolean) ?? true;

  const awaitingNotificationSentRef = useRef(false);
  const respondingElapsedRef = useRef(0);
  const idleNotificationSentRef = useRef(false);

  useEffect(() => {
    if (
      streamingState === StreamingState.WaitingForConfirmation &&
      !isFocused &&
      !awaitingNotificationSentRef.current &&
      terminalBellEnabled
    ) {
      const awaitingTool = pendingToolCalls?.find(
        (tc) => tc.status === 'awaiting_approval',
      );
      const toolName = awaitingTool?.request.name;
      const message = toolName
        ? `Qwen needs your permission to use ${toolName}`
        : 'Qwen is waiting for your input';

      sendNotification(
        { message, title: NOTIFICATION_TITLE },
        terminal,
        terminalBellEnabled,
      );
      awaitingNotificationSentRef.current = true;
    }

    if (streamingState !== StreamingState.WaitingForConfirmation || isFocused) {
      awaitingNotificationSentRef.current = false;
    }
  }, [
    isFocused,
    streamingState,
    terminalBellEnabled,
    terminal,
    pendingToolCalls,
  ]);

  useEffect(() => {
    if (streamingState === StreamingState.Responding) {
      respondingElapsedRef.current = elapsedTime;
      idleNotificationSentRef.current = false;
      return;
    }

    if (streamingState === StreamingState.Idle) {
      const wasLongTask =
        respondingElapsedRef.current >=
        LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS;
      if (wasLongTask && !isFocused && terminalBellEnabled) {
        sendNotification(
          {
            message: 'Qwen is waiting for your input',
            title: NOTIFICATION_TITLE,
          },
          terminal,
          terminalBellEnabled,
        );
      }
      respondingElapsedRef.current = 0;

      // Fire idle_prompt notification hook when entering idle state
      if (config && !idleNotificationSentRef.current) {
        const messageBus = config.getMessageBus();
        const hooksEnabled = !config.getDisableAllHooks();
        if (hooksEnabled && messageBus) {
          fireNotificationHook(
            messageBus,
            'Qwen is waiting for your input',
            NotificationType.IdlePrompt,
            'Waiting for input',
          ).catch(() => {
            // Silently ignore errors - fireNotificationHook has internal error handling
          });
        }
        idleNotificationSentRef.current = true;
      }
      return;
    }

    idleNotificationSentRef.current = false;
  }, [
    streamingState,
    elapsedTime,
    isFocused,
    terminalBellEnabled,
    config,
    terminal,
  ]);
};
