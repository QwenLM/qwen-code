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
  type SessionService,
  CompressionStatus,
  buildApiHistoryFromConversation,
  getCompressionPrompt,
} from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { RewindAction, RewindHistoryEntry } from '../types/rewind.js';

type RewindSessionService = Pick<SessionService, 'loadSession'>;
type HistoryItem = Parameters<UseHistoryManagerReturn['addItem']>[0];
const REWIND_COMPRESSION_SUMMARY_ACK =
  'Got it. Thanks for the additional context!';

interface RewindGitRestoreService {
  restoreProjectFromSnapshot(
    commitHash: string,
    options?: { untrackedPathsToDelete?: string[] },
  ): Promise<void>;
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

function getErrorHint(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRewindSummaryHistory(summaryText: string): Content[] {
  return [
    {
      role: 'user',
      parts: [{ text: summaryText }],
    },
    {
      role: 'model',
      parts: [{ text: REWIND_COMPRESSION_SUMMARY_ACK }],
    },
  ];
}

function derivePrefixSessionData(
  currentSessionData: ResumedSessionData,
  leafUuid: string | null,
): ResumedSessionData | undefined {
  if (leafUuid === null) {
    return {
      ...currentSessionData,
      conversation: {
        ...currentSessionData.conversation,
        messages: [],
      },
      lastCompletedUuid: null,
    };
  }

  const endIndex = currentSessionData.conversation.messages.findIndex(
    (message) => message.uuid === leafUuid,
  );
  if (endIndex < 0) {
    return undefined;
  }

  const messages = currentSessionData.conversation.messages.slice(
    0,
    endIndex + 1,
  );
  return {
    ...currentSessionData,
    conversation: {
      ...currentSessionData.conversation,
      messages,
    },
    lastCompletedUuid: messages.at(-1)?.uuid ?? null,
  };
}

function buildHistoryToSummarize(
  currentSessionData: ResumedSessionData,
  startUuid: string,
): Content[] | undefined {
  const currentMessages = currentSessionData.conversation.messages;
  const startIndex = currentMessages.findIndex(
    (message) => message.uuid === startUuid,
  );

  if (startIndex < 0) {
    return undefined;
  }

  return currentMessages
    .slice(startIndex + 1)
    .filter((message) => message.type !== 'system' && message.message)
    .map((message) => structuredClone(message.message as Content));
}

function getLastUpdatedMs(sessionData: ResumedSessionData): number {
  const parsed = Date.parse(sessionData.conversation.lastUpdated);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function selectCurrentSessionData(
  config: Config,
  sessionId: string,
  persistedSessionData: ResumedSessionData | undefined,
): ResumedSessionData | undefined {
  const resumedSessionData = config.getResumedSessionData?.();
  const activeSessionData =
    config.getSessionId() === sessionId &&
    resumedSessionData?.conversation.sessionId === sessionId
      ? resumedSessionData
      : undefined;

  return activeSessionData &&
    (!persistedSessionData ||
      getLastUpdatedMs(persistedSessionData) <=
        getLastUpdatedMs(activeSessionData))
    ? activeSessionData
    : persistedSessionData;
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

  const addRewindError = useCallback(
    (text: string, error?: unknown) => {
      historyManager?.addItem(
        {
          type: 'error',
          text,
          hint: error === undefined ? undefined : getErrorHint(error),
        } as HistoryItem,
        Date.now(),
      );
      remount?.();
    },
    [historyManager, remount],
  );

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

  const loadConversationSession = useCallback(
    async (entry: RewindHistoryEntry): Promise<ResumedSessionData> => {
      if (!config) {
        throw new Error('Rewind configuration is unavailable.');
      }
      if (!entry.node) {
        throw new Error('Rewind target is missing conversation data.');
      }
      const sessionId = config.getSessionId();
      const sessionService: RewindSessionService = config.getSessionService();
      const sessionData = await sessionService.loadSession(sessionId, {
        leafUuid: entry.node.parentUuid,
      });

      if (!sessionData) {
        throw new Error('Failed to load rewind session data.');
      }

      return sessionData;
    },
    [config],
  );

  const restoreConversation = useCallback(
    async (
      entry: RewindHistoryEntry,
      loadedSessionData?: ResumedSessionData,
    ) => {
      if (!config || !historyManager || !startNewSession || !setInputText) {
        throw new Error('Rewind conversation restore is unavailable.');
      }
      if (!entry.node) {
        throw new Error('Rewind target is missing conversation data.');
      }

      const sessionData =
        loadedSessionData ?? (await loadConversationSession(entry));
      const sessionId = config.getSessionId();

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
      loadConversationSession,
      remount,
      setInputText,
      startNewSession,
    ],
  );

  const restoreCode = useCallback(
    async (entry: RewindHistoryEntry, addInfoMessage: boolean) => {
      const restoreCodeSummary = entry.restoreCodeSummary ?? entry.codeSummary;
      if (!config) {
        throw new Error('Rewind code restore is unavailable.');
      }
      if (!restoreCodeSummary.checkpointCommitHash) {
        throw new Error(
          'No code checkpoint is available for this rewind point.',
        );
      }

      const gitService =
        (await config.getGitService()) as unknown as RewindGitRestoreService;
      await gitService.restoreProjectFromSnapshot(
        restoreCodeSummary.checkpointCommitHash,
        {
          untrackedPathsToDelete: restoreCodeSummary.changes.map(
            (change) => change.path,
          ),
        },
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

      const updatePendingWithError = (hint: string) => {
        const errorUpdate = {
          type: 'error',
          text: 'Failed to summarize messages from this point.',
          hint,
        } as Parameters<NonNullable<typeof historyManager.updateItem>>[1];
        if (historyManager.updateItem) {
          historyManager.updateItem(pendingCompressionId, errorUpdate);
        } else {
          historyManager.addItem(errorUpdate as HistoryItem, Date.now());
        }
        remount?.();
      };

      try {
        const sessionId = config.getSessionId();
        const sessionService: RewindSessionService = config.getSessionService();
        const currentSessionData = selectCurrentSessionData(
          config,
          sessionId,
          await sessionService.loadSession(sessionId),
        );

        if (!currentSessionData) {
          updatePendingWithError('Session data unavailable');
          return;
        }

        const prefixSessionData = derivePrefixSessionData(
          currentSessionData,
          entry.node.parentUuid,
        );

        if (!prefixSessionData) {
          updatePendingWithError('Rewind point is not in the current branch');
          return;
        }

        const historyToSummarize = buildHistoryToSummarize(
          currentSessionData,
          entry.node.uuid,
        );

        if (!historyToSummarize) {
          updatePendingWithError('Rewind point is not in the current branch');
          return;
        }

        if (historyToSummarize.length === 0) {
          await restoreConversation(entry, prefixSessionData);
          return;
        }

        const contentGenerator = config.getContentGenerator();
        if (!contentGenerator) {
          updatePendingWithError('Content generator unavailable');
          return;
        }

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
          updatePendingWithError('Empty summary');
          return;
        }

        const prefixHistory = buildApiHistoryFromConversation(
          prefixSessionData.conversation,
        );
        const summaryHistory = buildRewindSummaryHistory(summaryText);
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
        // Fetch after startNewSession because the config may recreate
        // session-scoped services for the newly restored branch.
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
        updatePendingWithError(getErrorHint(error));
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

      let codeRestoredBeforeFailure = false;
      try {
        if (action === 'restore_code') {
          await restoreCode(rewindTarget, true);
          return;
        }

        if (action === 'restore_code_and_conversation') {
          const sessionData = await loadConversationSession(rewindTarget);
          await restoreCode(rewindTarget, false);
          codeRestoredBeforeFailure = true;
          await restoreConversation(rewindTarget, sessionData);
          return;
        }

        if (action === 'summarize_from_here') {
          await summarizeFromHere(rewindTarget);
          return;
        }

        await restoreConversation(rewindTarget);
      } catch (error) {
        addRewindError(
          codeRestoredBeforeFailure
            ? 'Failed to restore conversation after restoring code. Code was already restored to the selected checkpoint.'
            : 'Failed to rewind session.',
          error,
        );
      }
    },
    [
      addRewindError,
      closeRewindConfirmation,
      loadConversationSession,
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
