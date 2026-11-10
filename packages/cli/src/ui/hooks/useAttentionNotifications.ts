/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef } from 'react';
import { StreamingState } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { captureHookExecutionOwner } from '@qwen-code/qwen-code-core/hooks/hook-execution-context.js';
import { fireNotificationHook } from '@qwen-code/qwen-code-core/core/toolHookTriggers.js';
import { NotificationType } from '@qwen-code/qwen-code-core/hooks/types.js';
import type { TerminalNotification } from './useTerminalNotification.js';
import type {
  TrackedExecutingToolCall,
  TrackedToolCall,
} from './useReactToolScheduler.js';
import type { PendingBackgroundApproval } from '../components/background-view/BackgroundTasksPill.js';
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
  /** Approvals parked by background agents and workflows, oldest first. */
  backgroundApprovals?: readonly PendingBackgroundApproval[];
}

export const useAttentionNotifications = ({
  isFocused,
  streamingState,
  elapsedTime,
  settings,
  config,
  terminal,
  pendingToolCalls,
  backgroundApprovals,
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
    if (awaitingTool) return awaitingTool.request.name;
    // A foreground subagent's prompt rides on the executing Agent call's live
    // output; name the subagent's tool rather than the Agent tool.
    for (const tc of pendingToolCalls ?? []) {
      if (tc.status !== 'executing') continue;
      const liveOutput = (tc as TrackedExecutingToolCall).liveOutput;
      if (
        typeof liveOutput === 'object' &&
        liveOutput !== null &&
        'type' in liveOutput &&
        liveOutput.type === 'task_execution' &&
        liveOutput.pendingConfirmation != null
      ) {
        return liveOutput.toolCalls?.find(
          (call) => call.status === 'awaiting_approval',
        )?.name;
      }
    }
    return undefined;
  }, [pendingToolCalls]);

  // Approvals parked by background agents and workflows never put the main
  // session into WaitingForConfirmation, so they need their own trigger.
  // Each one notifies once per unfocused stretch, keyed by a primitive
  // signature so array identity changes don't re-run the effect.
  const backgroundApprovalSignature = useMemo(
    () =>
      JSON.stringify(
        (backgroundApprovals ?? []).map((approval) => [
          approval.key,
          approval.toolName,
        ]),
      ),
    [backgroundApprovals],
  );
  const notifiedBackgroundApprovalsRef = useRef(new Set<string>());

  useEffect(() => {
    const pending = (
      JSON.parse(backgroundApprovalSignature) as Array<[string, string]>
    ).map(([key, toolName]) => ({ key, toolName }));
    const notified = notifiedBackgroundApprovalsRef.current;
    const pendingKeys = new Set(pending.map((approval) => approval.key));
    for (const key of notified) {
      if (!pendingKeys.has(key)) notified.delete(key);
    }
    if (isFocused) {
      // Re-arm, like the main prompt: losing focus again with an approval
      // still parked notifies again.
      notified.clear();
      return;
    }
    const fresh = pending.filter((approval) => !notified.has(approval.key));
    if (fresh.length === 0) return;
    for (const approval of fresh) notified.add(approval.key);
    // The main prompt's own notification already covers this stretch.
    if (streamingState === StreamingState.WaitingForConfirmation) return;
    if (!terminalBellEnabled || !approvalNotificationsEnabled) return;
    const toolName = fresh.at(-1)!.toolName;
    sendNotification(
      {
        message: toolName
          ? `Qwen Code needs your permission to use ${toolName}`
          : 'Qwen Code is waiting for your input',
        title: NOTIFICATION_TITLE,
      },
      terminal,
      terminalBellEnabled,
    );
  }, [
    backgroundApprovalSignature,
    isFocused,
    streamingState,
    terminalBellEnabled,
    approvalNotificationsEnabled,
    terminal,
  ]);

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
            undefined,
            captureHookExecutionOwner(config, null),
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
