/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Content } from '@google/genai';
import {
  SessionStartSource,
  type Config,
  type PermissionMode,
  type ResumedSessionData,
  CompressionStatus,
  buildApiHistoryFromConversation,
  getCompressionPrompt,
} from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { RewindAction, RewindHistoryEntry } from '../types/rewind.js';

interface RewindSessionService {
  loadSession(
    sessionId: string,
    options?: { leafUuid?: string | null },
  ): Promise<ResumedSessionData | undefined>;
}

export interface UseRewindCommandOptions {
  config: Config | null;
  historyManager: Pick<
    UseHistoryManagerReturn,
    'addItem' | 'clearItems' | 'loadHistory'
  > &
    Partial<Pick<UseHistoryManagerReturn, 'updateItem'>>;
  startNewSession: (sessionId: string) => void;
  setInputText: (text: string) => void;
  remount?: () => void;
}

export interface UseRewindCommandResult {
  isRewindDialogOpen: boolean;
  rewindTarget: RewindHistoryEntry | null;
  openRewindDialog: () => void;
  closeRewindDialog: () => void;
  closeRewindConfirmation: () => void;
  handleRewind: (entry: RewindHistoryEntry) => void;
  handleRewindAction: (action: RewindAction) => void;
}

function extractResponseText(response: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string {
  return (
    response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter((text): text is string => typeof text === 'string')
      .join('') ?? ''
  );
}

export function useRewindCommand(
  options?: UseRewindCommandOptions,
): UseRewindCommandResult {
  const [isRewindDialogOpen, setIsRewindDialogOpen] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<RewindHistoryEntry | null>(
    null,
  );

  const openRewindDialog = useCallback(() => {
    setRewindTarget(null);
    setIsRewindDialogOpen(true);
  }, []);

  const closeRewindDialog = useCallback(() => {
    setIsRewindDialogOpen(false);
  }, []);

  const closeRewindConfirmation = useCallback(() => {
    setRewindTarget(null);
  }, []);

  const { config, historyManager, startNewSession, setInputText, remount } =
    options ?? {};

  const fireSessionStartEvent = useCallback(async () => {
    if (!config) {
      return;
    }

    try {
      await config
        .getHookSystem()
        ?.fireSessionStartEvent(
          SessionStartSource.Resume,
          config.getModel() ?? '',
          String(config.getApprovalMode()) as PermissionMode,
        );
    } catch (err) {
      config.getDebugLogger().warn(`SessionStart hook failed: ${err}`);
    }
  }, [config]);

  const restoreConversation = useCallback(
    async (entry: RewindHistoryEntry) => {
      if (
        !config ||
        !historyManager ||
        !startNewSession ||
        !setInputText ||
        !entry.node
      ) {
        return;
      }

      const sessionId = config.getSessionId();
      const sessionService =
        config.getSessionService() as unknown as RewindSessionService;
      const sessionData = await sessionService.loadSession(sessionId, {
        leafUuid: entry.node.parentUuid,
      });

      if (!sessionData) {
        return;
      }

      startNewSession(sessionId);

      const uiHistoryItems = buildResumedHistoryItems(sessionData, config);
      historyManager.clearItems();
      historyManager.loadHistory(uiHistoryItems);

      config.startNewSession(sessionId, sessionData);
      await config.getGeminiClient()?.initialize?.();
      setInputText(entry.node.prompt);
      await fireSessionStartEvent();
      remount?.();
    },
    [
      config,
      fireSessionStartEvent,
      historyManager,
      remount,
      setInputText,
      startNewSession,
    ],
  );

  const restoreCode = useCallback(
    async (entry: RewindHistoryEntry, addInfoMessage: boolean) => {
      const restoreCodeSummary = entry.restoreCodeSummary ?? entry.codeSummary;
      if (!config || !restoreCodeSummary.checkpointCommitHash) {
        return;
      }

      const gitService = await config.getGitService();
      await gitService.restoreProjectFromSnapshot(
        restoreCodeSummary.checkpointCommitHash,
      );

      if (addInfoMessage) {
        historyManager?.addItem(
          {
            type: 'info',
            text: restoreCodeSummary.detailText,
          },
          Date.now(),
        );
      }
    },
    [config, historyManager],
  );

  const summarizeFromHere = useCallback(
    async (entry: RewindHistoryEntry) => {
      if (
        !config ||
        !historyManager ||
        !startNewSession ||
        !setInputText ||
        !entry.node
      ) {
        return;
      }

      const compressionPendingItem = {
        type: 'compression',
        compression: {
          isPending: true,
          originalTokenCount: null,
          newTokenCount: null,
          compressionStatus: null,
        },
      } as Parameters<typeof historyManager.addItem>[0];
      const pendingCompressionId = historyManager.addItem(
        compressionPendingItem,
        Date.now(),
      );
      remount?.();

      const sessionId = config.getSessionId();
      const sessionService =
        config.getSessionService() as unknown as RewindSessionService;
      const [prefixSessionData, currentSessionData] = await Promise.all([
        sessionService.loadSession(sessionId, {
          leafUuid: entry.node.parentUuid,
        }),
        sessionService.loadSession(sessionId),
      ]);

      if (!prefixSessionData || !currentSessionData) {
        return;
      }

      const currentMessages = currentSessionData.conversation.messages;
      const startIndex = currentMessages.findIndex(
        (message) => message.uuid === entry.node?.uuid,
      );

      if (startIndex < 0) {
        await restoreConversation(entry);
        return;
      }

      const historyToSummarize: Content[] = currentMessages
        .slice(startIndex)
        .filter((message) => message.type !== 'system' && message.message)
        .map((message) => structuredClone(message.message as Content));

      if (historyToSummarize.length === 0) {
        await restoreConversation(entry);
        return;
      }

      const contentGenerator = config.getContentGenerator();
      if (!contentGenerator) {
        const unavailableErrorUpdate = {
          type: 'error',
          text: 'Failed to summarize messages from this point.',
          hint: 'Content generator unavailable',
        } as Parameters<NonNullable<typeof historyManager.updateItem>>[1];
        historyManager.updateItem?.(
          pendingCompressionId,
          unavailableErrorUpdate,
        );
        remount?.();
        return;
      }

      try {
        const response = await contentGenerator.generateContent(
          {
            model: config.getModel(),
            contents: [
              ...historyToSummarize,
              {
                role: 'user',
                parts: [
                  {
                    text: 'First, reason in your scratchpad. Then, generate the <state_snapshot>.',
                  },
                ],
              },
            ],
            config: {
              systemInstruction: getCompressionPrompt(),
            },
          },
          `rewind-summarize-${Date.now()}`,
        );

        const summaryText = extractResponseText(response).trim();
        if (!summaryText) {
          const emptySummaryErrorUpdate = {
            type: 'error',
            text: 'Failed to summarize messages from this point.',
            hint: 'Empty summary',
          } as Parameters<NonNullable<typeof historyManager.updateItem>>[1];
          historyManager.updateItem?.(
            pendingCompressionId,
            emptySummaryErrorUpdate,
          );
          remount?.();
          return;
        }

        const prefixHistory = buildApiHistoryFromConversation(
          prefixSessionData.conversation,
        );
        const summaryHistory: Content[] = [
          {
            role: 'user',
            parts: [{ text: summaryText }],
          },
          {
            role: 'model',
            parts: [{ text: 'Got it. Thanks for the additional context!' }],
          },
        ];
        const compressedHistory = [...prefixHistory, ...summaryHistory];

        startNewSession(sessionId);
        historyManager.clearItems();
        historyManager.loadHistory(
          buildResumedHistoryItems(prefixSessionData, config),
        );
        const compressionCompleteItem = {
          type: 'compression',
          compression: {
            isPending: false,
            originalTokenCount:
              response.usageMetadata?.promptTokenCount ??
              historyToSummarize.length,
            newTokenCount:
              response.usageMetadata?.totalTokenCount ??
              response.usageMetadata?.candidatesTokenCount ??
              summaryHistory.length,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        } as Parameters<typeof historyManager.addItem>[0];
        historyManager.addItem(compressionCompleteItem, Date.now());
        historyManager.addItem(
          {
            type: 'info',
            text: 'Summarized conversation',
          },
          Date.now(),
        );
        historyManager.addItem(
          {
            type: 'info',
            text: `Summarized ${historyToSummarize.length} messages from this point. Context: “${entry.node.prompt}”`,
          },
          Date.now(),
        );

        config.startNewSession(sessionId, prefixSessionData);
        await config.getGeminiClient()?.initialize?.();
        config.getGeminiClient()?.setHistory(compressedHistory);
        config.getChatRecordingService()?.recordChatCompression({
          info: {
            originalTokenCount:
              response.usageMetadata?.promptTokenCount ??
              historyToSummarize.length,
            newTokenCount:
              response.usageMetadata?.totalTokenCount ??
              response.usageMetadata?.candidatesTokenCount ??
              summaryHistory.length,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory,
        });
        setInputText(entry.node.prompt);
        await fireSessionStartEvent();
        remount?.();
      } catch (error) {
        const summarizeErrorUpdate = {
          type: 'error',
          text: 'Failed to summarize messages from this point.',
          hint: error instanceof Error ? error.message : String(error),
        } as Parameters<NonNullable<typeof historyManager.updateItem>>[1];
        historyManager.updateItem?.(pendingCompressionId, summarizeErrorUpdate);
        remount?.();
      }
    },
    [
      config,
      fireSessionStartEvent,
      historyManager,
      remount,
      restoreConversation,
      setInputText,
      startNewSession,
    ],
  );

  const handleRewind = useCallback(
    (entry: RewindHistoryEntry) => {
      closeRewindDialog();
      if (entry.kind === 'current') {
        return;
      }
      setRewindTarget(entry);
    },
    [closeRewindDialog],
  );

  const handleRewindAction = useCallback(
    async (action: RewindAction) => {
      if (!rewindTarget) {
        return;
      }

      if (action === 'cancel') {
        closeRewindConfirmation();
        return;
      }

      closeRewindConfirmation();

      if (action === 'restore_code') {
        await restoreCode(rewindTarget, true);
        return;
      }

      if (action === 'restore_code_and_conversation') {
        await restoreCode(rewindTarget, false);
        await restoreConversation(rewindTarget);
        return;
      }

      if (action === 'summarize_from_here') {
        await summarizeFromHere(rewindTarget);
        return;
      }

      await restoreConversation(rewindTarget);
    },
    [
      closeRewindConfirmation,
      restoreCode,
      restoreConversation,
      rewindTarget,
      summarizeFromHere,
    ],
  );

  return {
    isRewindDialogOpen,
    rewindTarget,
    openRewindDialog,
    closeRewindDialog,
    closeRewindConfirmation,
    handleRewind,
    handleRewindAction,
  };
}
