/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef } from 'react';
import { StreamingState } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  fireNotificationHook,
  NotificationType,
} from '@qwen-code/qwen-code-core';
import type { TerminalNotification } from './useTerminalNotification.js';
import type { TrackedToolCall } from './useReactToolScheduler.js';
import { sendNotification } from '../../services/notificationService.js';

export const LONG_TASK_NOTIFICATION_THRESHOLD_SECONDS = 20;

const NOTIFICATION_TITLE = 'Qwen Code';

// The two accepted values for `general.notificationMode`:
//   - 'all' (default, historical behavior) — fire on every WaitingForConfirmation
//     transition AND on long-task idle.
//   - 'task-complete' — suppress per-approval notifications; only fire on
//     long-task idle. Requested in #6898: users driving many tool approvals
//     otherwise get "几十次弹窗" per task.
// The value read from settings is defensively narrowed at the call site — an
// unknown value falls back to 'all' rather than silently disabling approval
// notifications.
export type NotificationMode = 'all' | 'task-complete';

interface UseAttentionNotificationsOptions {
  isFocused: boolean;
  streamingState: StreamingState;
  elapsedTime: number;
  settings: LoadedSettings;
  config?: Config;
  terminal: TerminalNotification;
  pendingToolCalls?: TrackedToolCall[];
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
  // Only 'task-complete' suppresses the per-approval notification; any other
  // value (including missing / legacy configs) preserves the historical "all"
  // behavior. See #6898.
  const notificationMode: NotificationMode =
    (settings?.merged?.general as { notificationMode?: unknown } | undefined)
      ?.notificationMode === 'task-complete'
      ? 'task-complete'
      : 'all';
  const approvalNotificationsEnabled = notificationMode === 'all';

  const awaitingNotificationSentRef = useRef(false);
  const respondingElapsedRef = useRef(0);
  const idleNotificationSentRef = useRef(false);

  // Extract the awaiting tool name as a primitive so the effect doesn't
  // re-fire on every render due to pendingToolCalls array identity changes.
  const awaitingToolName = useMemo(() => {
    const awaitingTool = pendingToolCalls?.find(
      (tc) => tc.status === 'awaiting_approval',
    );
    return awaitingTool?.request.name;
  }, [pendingToolCalls]);

  useEffect(() => {
    if (
      streamingState === StreamingState.WaitingForConfirmation &&
      !isFocused &&
      !awaitingNotificationSentRef.current &&
      terminalBellEnabled &&
      approvalNotificationsEnabled
    ) {
      const message = awaitingToolName
        ? `Qwen Code needs your permission to use ${awaitingToolName}`
        : 'Qwen Code is waiting for your input';

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
    approvalNotificationsEnabled,
    terminal,
    awaitingToolName,
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
            message: 'Qwen Code is waiting for your input',
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
            'Qwen Code is waiting for your input',
            NotificationType.IdlePrompt,
            'Waiting for input',
          )
            .then((hookResult) => {
              if (hookResult.terminalSequence) {
                terminal.writeTerminalSequence(hookResult.terminalSequence);
              }
            })
            .catch(() => {
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
