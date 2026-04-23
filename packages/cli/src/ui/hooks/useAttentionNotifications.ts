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
import {
  sendNotification,
  type NotificationChannel,
} from '../../services/notificationService.js';

export const LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS = 20;

const NOTIFICATION_TITLE = 'Qwen Code';
const NOTIFICATION_MESSAGE = 'Qwen Code is waiting for your input';

interface UseAttentionNotificationsOptions {
  isFocused: boolean;
  streamingState: StreamingState;
  elapsedTime: number;
  settings: LoadedSettings;
  config?: Config;
  terminal: TerminalNotification;
}

export const useAttentionNotifications = ({
  isFocused,
  streamingState,
  elapsedTime,
  settings,
  config,
  terminal,
}: UseAttentionNotificationsOptions) => {
  const notificationChannel: NotificationChannel =
    (settings?.merged?.general?.notifications as NotificationChannel) ?? 'auto';
  const isDisabled = notificationChannel === 'notifications_disabled';

  const awaitingNotificationSentRef = useRef(false);
  const respondingElapsedRef = useRef(0);
  const idleNotificationSentRef = useRef(false);

  useEffect(() => {
    if (
      streamingState === StreamingState.WaitingForConfirmation &&
      !isFocused &&
      !awaitingNotificationSentRef.current &&
      !isDisabled
    ) {
      sendNotification(
        { message: NOTIFICATION_MESSAGE, title: NOTIFICATION_TITLE },
        terminal,
        notificationChannel,
      );
      awaitingNotificationSentRef.current = true;
    }

    if (streamingState !== StreamingState.WaitingForConfirmation || isFocused) {
      awaitingNotificationSentRef.current = false;
    }
  }, [isFocused, streamingState, notificationChannel, isDisabled, terminal]);

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
      if (wasLongTask && !isFocused && !isDisabled) {
        sendNotification(
          { message: NOTIFICATION_MESSAGE, title: NOTIFICATION_TITLE },
          terminal,
          notificationChannel,
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
            NOTIFICATION_MESSAGE,
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
    notificationChannel,
    isDisabled,
    config,
    terminal,
  ]);
};
