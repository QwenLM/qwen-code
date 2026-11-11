/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  enqueue as enqueueCommand,
  clearCommandQueue,
  dequeueAllMatching,
  subscribeToCommandQueue,
  getCommandQueueSnapshot,
  type PastedContent,
} from '@qwen-code/core';

const isUserPrompt = (cmd: {
  commandMode: string;
  targetAgentId?: string;
  isMeta?: boolean;
  origin?: { kind: string };
}) =>
  cmd.commandMode === 'prompt' &&
  cmd.targetAgentId === undefined &&
  cmd.isMeta !== true &&
  (cmd.origin === undefined || cmd.origin.kind === 'human');

export interface UseUserMessageQueueReturn {
  messageQueue: string[];
  addMessage: (
    message: string,
    options?: {
      pastedContents?: Record<number, PastedContent>;
      preExpansionText?: string;
      uuid?: string;
      suppressWorkflowKeyword?: boolean;
    },
  ) => void;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  popAllMessages: () => string | undefined;
}

/**
 * Subscribes to the unified command queue and projects user prompts as a
 * display-only string[] for QueuedMessageDisplay. Also exposes the queue
 * mutators (enqueue/clear/pop) the UI needs.
 *
 * Task notifications and agent-targeted commands are filtered out — only
 * raw user prompts surface here.
 */
export function useUserMessageQueue(
  shouldSkipSlashCommands?: (message: string) => boolean,
): UseUserMessageQueueReturn {
  const commandQueueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  );

  const messageQueue = useMemo<string[]>(
    () =>
      commandQueueSnapshot
        .filter(isUserPrompt)
        .map((cmd) => (typeof cmd.prompt === 'string' ? cmd.prompt : ''))
        .filter(Boolean),
    [commandQueueSnapshot],
  );

  const addMessage = useCallback(
    (
      message: string,
      options?: {
        pastedContents?: Record<number, PastedContent>;
        preExpansionText?: string;
        uuid?: string;
        suppressWorkflowKeyword?: boolean;
      },
    ) => {
      const trimmed = message.trim();
      if (trimmed) {
        enqueueCommand({
          prompt: trimmed,
          commandMode: 'prompt',
          priority: 'next',
          origin: { kind: 'human' },
          ...(shouldSkipSlashCommands?.(trimmed)
            ? { skipSlashCommands: true }
            : {}),
          ...(options?.pastedContents
            ? { pastedContents: options.pastedContents }
            : {}),
          ...(options?.preExpansionText
            ? { preExpansionPrompt: options.preExpansionText }
            : {}),
          ...(options?.uuid ? { uuid: options.uuid } : {}),
          ...(options?.suppressWorkflowKeyword
            ? { suppressWorkflowKeyword: true }
            : {}),
        });
      }
    },
    [shouldSkipSlashCommands],
  );

  const getQueuedMessagesText = useCallback(() => {
    if (messageQueue.length === 0) return '';
    return messageQueue.join('\n\n');
  }, [messageQueue]);

  const popAllMessages = useCallback(() => {
    const matched = dequeueAllMatching(isUserPrompt);
    if (matched.length === 0) return undefined;
    return matched
      .map((cmd) => (typeof cmd.prompt === 'string' ? cmd.prompt : ''))
      .filter(Boolean)
      .join('\n\n');
  }, []);

  return {
    messageQueue,
    addMessage,
    clearQueue: clearCommandQueue,
    getQueuedMessagesText,
    popAllMessages,
  };
}
