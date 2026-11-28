/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';
import { useCallback, useReducer, useRef } from 'react';
import type { Config } from '@qwen-code/core';
import {
  backgroundUserShellCommand,
  ExecutionLifecycleService,
  CoreToolCallStatus,
  runUserShellCommand,
} from '@qwen-code/core';
import { type PartListUnion } from '@google/genai';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { SHELL_COMMAND_NAME } from '../constants.js';
import { shellFocusReducer, initialShellFocusState } from './shellReducer.js';
import type { AppFocusStateMachine } from '../state/AppFocusStateMachine.js';
import type { BashCommandOutcome } from './localSession.shared.js';

/**
 * Hook for foreground shell command execution and Ctrl+B backgrounding.
 *
 * Background task tracking (UI panel, progress, eviction) is handled by the
 * unified TaskRegistry system. This hook only manages:
 * - Foreground shell focus (activeShellId)
 * - Shell output timing (lastShellOutputTime)
 * - The Ctrl+B backgrounding action (backgroundForegroundExecutions)
 * - The /shell interactive command flow (handleShellCommand)
 */
export const useExecutionLifecycle = (
  addItemToHistory: UseHistoryManagerReturn['addItem'],
  setPendingHistoryItem: React.Dispatch<
    React.SetStateAction<HistoryItemWithoutId | null>
  >,
  onDebugMessage: (message: string) => void,
  config: Config,
  focusMachine: AppFocusStateMachine | null,
  terminalWidth?: number,
  _terminalHeight?: number,
  foregroundToolExecutionIds: readonly number[] = [],
  _isWaitingForConfirmation?: boolean,
) => {
  const [state, dispatch] = useReducer(
    shellFocusReducer,
    initialShellFocusState,
  );
  const activeShellCommandRef = useRef<string | null>(null);

  const backgroundForegroundExecutions = useCallback((): number => {
    const toolExecutionIds = new Set(foregroundToolExecutionIds);
    let handled = 0;

    if (state.activeShellId !== null) {
      backgroundUserShellCommand(
        state.activeShellId,
        config.getSessionId?.() ?? 'default',
        activeShellCommandRef.current ?? '',
      );
      toolExecutionIds.delete(state.activeShellId);
      handled += 1;
    }

    for (const executionId of toolExecutionIds) {
      if (ExecutionLifecycleService.background(executionId, 'user')) {
        handled += 1;
      }
    }

    return handled;
  }, [state.activeShellId, foregroundToolExecutionIds, config]);

  const handleShellCommand = useCallback(
    async (
      rawQuery: PartListUnion,
      abortSignal: AbortSignal,
    ): Promise<BashCommandOutcome | false> => {
      if (typeof rawQuery !== 'string' || rawQuery.trim() === '') {
        return false;
      }

      const userMessageTimestamp = Date.now();
      const callId = `shell-${userMessageTimestamp}`;
      addItemToHistory(
        { type: 'user_shell', text: rawQuery },
        userMessageTimestamp,
      );

      const commandToExecute = rawQuery.trim();

      const executeCommand = async (): Promise<BashCommandOutcome> => {
        const initialToolDisplay: IndividualToolCallDisplay = {
          callId,
          name: SHELL_COMMAND_NAME,
          description: rawQuery,
          status: CoreToolCallStatus.Executing,
          isClientInitiated: true,
          resultDisplay: '',
          confirmationDetails: undefined,
          startedAt: userMessageTimestamp,
        };

        setPendingHistoryItem({
          type: 'tool_group',
          tools: [initialToolDisplay],
        });

        let executionPid: number | undefined;
        let latestProgress:
          | { totalLines: number; totalBytes: number }
          | undefined;

        const abortHandler = () => {
          onDebugMessage(
            `Aborting shell command (PID: ${executionPid ?? 'unknown'})`,
          );
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });

        onDebugMessage(
          `Executing through the default shell tool in ${config.getTargetDir()}: ${commandToExecute}`,
        );
        activeShellCommandRef.current = commandToExecute;

        try {
          const outcome = await runUserShellCommand({
            config,
            command: commandToExecute,
            signal: abortSignal,
            callId,
            onExecutionId: (pid) => {
              executionPid = pid;
              dispatch({ type: 'SET_ACTIVE_SHELL', pid });
              setPendingHistoryItem((prevItem) => {
                if (prevItem?.type !== 'tool_group') return prevItem;
                return {
                  ...prevItem,
                  tools: prevItem.tools.map((tool) =>
                    tool.callId === callId
                      ? { ...tool, executionId: pid }
                      : tool,
                  ),
                };
              });
            },
            onProgress: (progress) => {
              if (
                progress.totalLines !== undefined &&
                progress.totalBytes !== undefined
              ) {
                latestProgress = {
                  totalLines: progress.totalLines,
                  totalBytes: progress.totalBytes,
                };
              }
              dispatch({ type: 'SET_OUTPUT_TIME', time: Date.now() });
              setPendingHistoryItem((prevItem) => {
                if (prevItem?.type !== 'tool_group') return prevItem;
                return {
                  ...prevItem,
                  tools: prevItem.tools.map((tool) =>
                    tool.callId === callId
                      ? {
                          ...tool,
                          resultDisplay: progress.output,
                          shellProgress: latestProgress ?? tool.shellProgress,
                        }
                      : tool,
                  ),
                };
              });
            },
          });

          setPendingHistoryItem(null);
          const finalStatus =
            outcome.kind === 'cancelled'
              ? CoreToolCallStatus.Cancelled
              : outcome.kind === 'completed' &&
                  (outcome.errorMessage ||
                    outcome.signal !== null ||
                    (outcome.exitCode !== null && outcome.exitCode !== 0))
                ? CoreToolCallStatus.Error
                : CoreToolCallStatus.Success;

          const finalToolDisplay: IndividualToolCallDisplay = {
            ...initialToolDisplay,
            status: finalStatus,
            resultDisplay: outcome.displayOutput,
            executionId: executionPid,
            shellProgress:
              outcome.progress?.totalLines !== undefined &&
              outcome.progress.totalBytes !== undefined
                ? {
                    totalLines: outcome.progress.totalLines,
                    totalBytes: outcome.progress.totalBytes,
                  }
                : latestProgress,
          };

          if (finalStatus !== CoreToolCallStatus.Cancelled) {
            addItemToHistory(
              {
                type: 'tool_group',
                tools: [finalToolDisplay],
              } as HistoryItemWithoutId,
              userMessageTimestamp,
            );
          }

          return outcome;
        } catch (err) {
          setPendingHistoryItem(null);
          const errorMessage = err instanceof Error ? err.message : String(err);
          addItemToHistory(
            {
              type: 'error',
              text: `An unexpected error occurred: ${errorMessage}`,
            },
            userMessageTimestamp,
          );

          // Only an explicit abort suppresses model continuation. Execution
          // failures remain completed so the model can explain the error.
          if (abortSignal.aborted) {
            return {
              kind: 'cancelled',
              command: commandToExecute,
              displayOutput: `Command was cancelled.\n${errorMessage}`,
              modelOutput: { stdout: '', stderr: errorMessage },
              timedOut: false,
            };
          }

          return {
            kind: 'completed',
            command: commandToExecute,
            displayOutput: errorMessage,
            modelOutput: { stdout: '', stderr: errorMessage },
            exitCode: null,
            signal: null,
            errorMessage,
          };
        } finally {
          abortSignal.removeEventListener('abort', abortHandler);

          dispatch({ type: 'SET_ACTIVE_SHELL', pid: null });
          activeShellCommandRef.current = null;
          focusMachine?.focusChat();
        }
      };

      return executeCommand();
    },
    [
      config,
      onDebugMessage,
      addItemToHistory,
      setPendingHistoryItem,
      focusMachine,
      dispatch,
    ],
  );

  return {
    handleShellCommand,
    activeShellId: state.activeShellId,
    lastShellOutputTime: state.lastShellOutputTime,
    backgroundForegroundExecutions,
  };
};
