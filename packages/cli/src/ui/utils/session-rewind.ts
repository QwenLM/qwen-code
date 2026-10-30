/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { FileHistorySnapshot } from '@qwen-code/qwen-code-core/services/fileHistoryService.js';
import type {
  HistoryItem,
  HistoryItemUser,
  HistoryItemWithoutId,
} from '../types.js';
import type { RestoreOption } from '../components/RewindSelector.js';
import { t } from '../../i18n/index.js';
import {
  computeApiTruncationIndex,
  isRetainedUserTurn,
} from './historyMapping.js';
import { expandCollapsedHistory } from './resumeHistoryUtils.js';
import { recoalesceFindingsHistoryItems } from './findings-coalescing.js';

export async function rewindSession(
  config: Config,
  history: HistoryItem[],
  userItem: HistoryItem,
  option: RestoreOption,
  onConversationRewound: (
    history: HistoryItem[],
    draft: string,
  ) => number | void,
  isCurrent: () => boolean,
): Promise<{ stale: boolean; messages: HistoryItemWithoutId[] }> {
  const messages: HistoryItemWithoutId[] = [];
  if (
    config.getShellExecutionSandbox?.() &&
    (option === 'code' || option === 'both')
  ) {
    messages.push({
      type: 'error',
      text: 'File restore is unavailable in tool sandbox.',
    });
    return { stale: false, messages };
  }

  // For 'both', validate that conversation can be truncated BEFORE
  // touching files — otherwise we'd roll back the workspace while
  // the conversation stays at the newer state.
  const needsConversation = option === 'conversation' || option === 'both';
  const llmClient = needsConversation ? config.getLlmClient() : null;
  const recordingService = config.getChatRecordingService();
  let apiTruncateIndex = -1;
  let recordingTurnIndex = -1;
  let survivingFileHistorySnapshots: FileHistorySnapshot[] | undefined;
  let conversationSkippedNoClient = false;
  if (needsConversation) {
    if (!llmClient) {
      if (option === 'conversation') {
        messages.push({
          type: 'error',
          text: t('Cannot rewind conversation: no active model client.'),
        });
        return { stale: false, messages };
      }
      // 'both' with no client: skip conversation, still try files,
      // and surface a warning after the restore output.
      conversationSkippedNoClient = true;
    } else {
      apiTruncateIndex = computeApiTruncationIndex(
        history,
        userItem.id,
        llmClient.getHistoryShallow(),
      );
      if (apiTruncateIndex < 0) {
        messages.push({
          type: 'error',
          text: isRetainedUserTurn(history, userItem.id)
            ? t(
                'Cannot rewind the conversation to this turn: it no longer matches the model history (for example, after a retry). Try a more recent turn.',
              )
            : t(
                'Cannot rewind to a turn that was compressed. Try a more recent turn.',
              ),
        });
        if (option === 'both') {
          // Abort file restore too — don't create inconsistent state
          return { stale: false, messages };
        }
        return { stale: false, messages };
      }
      if (recordingService) {
        const rewindId =
          userItem.type === 'user'
            ? (userItem.promptId ?? userItem.rewindId)
            : undefined;
        recordingTurnIndex = rewindId
          ? recordingService.getRewindTurnIndex(rewindId)
          : -1;
        if (recordingTurnIndex < 0) {
          messages.push({
            type: 'error',
            text: t('Rewind failed: {{error}}', {
              error: 'This turn has no unique recorded boundary.',
            }),
          });
          return { stale: false, messages };
        }
        const snapshots = config.getFileHistoryService().getSnapshots();
        const checkpointPromptId =
          userItem.type === 'user' ? userItem.promptId : undefined;
        const targetCheckpointIndex = checkpointPromptId
          ? snapshots.findIndex((s) => s.promptId === checkpointPromptId)
          : -1;
        const snapshotTurnIndices =
          targetCheckpointIndex < 0
            ? snapshots.map((s) =>
                recordingService.getRewindTurnIndex(s.promptId),
              )
            : [];
        if (
          (targetCheckpointIndex >= 0 &&
            snapshots.findLastIndex(
              (s) => s.promptId === checkpointPromptId,
            ) !== targetCheckpointIndex) ||
          snapshotTurnIndices.some((index) => index < 0)
        ) {
          messages.push({
            type: 'error',
            text: t('Rewind failed: {{error}}', {
              error: 'This turn has no unique checkpoint association.',
            }),
          });
          return { stale: false, messages };
        }
        survivingFileHistorySnapshots =
          targetCheckpointIndex >= 0
            ? snapshots.slice(0, targetCheckpointIndex + 1)
            : snapshots.filter(
                (_, index) => snapshotTurnIndices[index]! <= recordingTurnIndex,
              );
      }
    }
  }

  // Restore code (files on disk). For 'code'-only, don't truncate
  // the snapshot timeline — the conversation turns remain visible
  // and their snapshots must stay available for future rewinds.
  let fileRestoreMessage: string | undefined;
  let fileRestoreError: string | undefined;
  let hasRestoreFailure = false;
  if (option === 'code' || option === 'both') {
    const promptId = (userItem as HistoryItemUser).promptId;
    if (promptId) {
      try {
        const truncateHistory =
          option === 'both' && !!llmClient && apiTruncateIndex >= 0;
        const result = await config
          .getFileHistoryService()
          .rewind(promptId, truncateHistory);
        if (result.filesChanged.length > 0) {
          fileRestoreMessage = t('Restored {{count}} file(s).', {
            count: String(result.filesChanged.length),
          });
        } else if (result.filesFailed.length === 0) {
          fileRestoreMessage = t('No files needed to be restored.');
        }
        if (result.filesFailed.length > 0) {
          hasRestoreFailure = true;
          fileRestoreError = t(
            'Failed to restore {{count}} file(s): {{files}}',
            {
              count: String(result.filesFailed.length),
              files: result.filesFailed
                .map((f) => f.split('/').pop())
                .join(', '),
            },
          );
        }
      } catch (error) {
        hasRestoreFailure = true;
        fileRestoreError = t('Failed to restore files: {{error}}', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      hasRestoreFailure = true;
      fileRestoreError = t(
        'Cannot restore files: this turn was created before file checkpointing was enabled.',
      );
    }
  }

  if (!isCurrent()) return { stale: true, messages: [] };

  // Truncate conversation (already validated above).
  // Skip if file restore had failures in "both" mode to avoid inconsistent state.
  if (
    needsConversation &&
    llmClient &&
    apiTruncateIndex >= 0 &&
    !(option === 'both' && hasRestoreFailure)
  ) {
    const originalHistory = history;
    const hasSummary = originalHistory.some(
      (h) => h.display?.kind === 'collapse-summary',
    );
    const effectiveLength = hasSummary
      ? originalHistory.length - 1
      : originalHistory.length;

    llmClient.truncateHistory(apiTruncateIndex);

    // Strip suppressOnRestore flags and filter out collapse-summary items
    // so rewound items remain visible without stale summary text
    const truncatedUi = recoalesceFindingsHistoryItems(
      expandCollapsedHistory(originalHistory.filter((h) => h.id < userItem.id)),
    );
    const removedCount = onConversationRewound(
      truncatedUi,
      userItem.type === 'user' ? userItem.text : '',
    );

    recordingService?.rewindRecording(
      recordingTurnIndex,
      { truncatedCount: removedCount ?? effectiveLength - truncatedUi.length },
      !hasRestoreFailure ? survivingFileHistorySnapshots : undefined,
    );
  }

  // Show file restore result after conversation truncation so the
  // message isn't immediately removed by loadHistory.
  if (fileRestoreMessage) {
    messages.push({ type: 'info', text: fileRestoreMessage });
  }
  if (fileRestoreError) {
    messages.push({ type: 'error', text: fileRestoreError });
  }
  if (conversationSkippedNoClient) {
    messages.push({
      type: 'info',
      text: t(
        'Code restored, but conversation could not be rewound (no active client).',
      ),
    });
  }
  return { stale: false, messages };
}
