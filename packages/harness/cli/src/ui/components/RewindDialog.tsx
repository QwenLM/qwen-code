/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isFileDiff,
  type FileHistoryDiffStats,
  type FileHistoryManager,
  type Message,
  type RewindCandidate,
  type UserMessage,
} from '@qwen-code/core';
import { formatRelativeTime } from '../../utils/sessionUtils.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { theme } from '../semantic-colors.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { CliSpinner } from './CliSpinner.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { calculateCenteredWindow } from '../utils/calculateCenteredWindow.js';
import { figures } from '../utils/figures.js';

const MAX_VISIBLE_MESSAGES = 7;
const CURRENT_OPTION_KEY = '__rewind-current__';
/** How long a restore may run before the busy line advertises the Esc exit. */
const RESTORE_SLOW_HINT_MS = 5_000;

interface RewindListDiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

interface RewindOption {
  key: string;
  isCurrent: boolean;
  candidate: RewindCandidate | null;
}

export interface RewindDialogProps {
  messages: RewindCandidate[];
  allMessages: Message[];
  fileHistory?: FileHistoryManager;
  onClose: () => void;
  onRestoreConversation: (candidate: RewindCandidate) => Promise<void>;
  onRestoreFiles: (candidate: RewindCandidate) => Promise<void>;
  onRestoreBoth: (candidate: RewindCandidate) => Promise<void>;
  /**
   * Reports a restore failure that lands after the user dismissed the dialog,
   * which would otherwise be swallowed by the unmounted component.
   */
  onBackgroundError?: (message: string) => void;
}

export function RewindDialog({
  messages,
  allMessages,
  fileHistory,
  onClose,
  onRestoreConversation,
  onRestoreFiles,
  onRestoreBoth,
  onBackgroundError,
}: RewindDialogProps): React.JSX.Element {
  const options = useMemo<RewindOption[]>(
    () =>
      messages.length === 0
        ? []
        : [
            ...messages.map((candidate) => ({
              key: candidate.message.uuid,
              isCurrent: false,
              candidate,
            })),
            {
              key: CURRENT_OPTION_KEY,
              isCurrent: true,
              candidate: null,
            },
          ],
    [messages],
  );
  const [activeIndex, setActiveIndex] = useState(
    Math.max(options.length - 1, 0),
  );
  const [messageToRestore, setMessageToRestore] =
    useState<RewindCandidate | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isRestoreSlow, setIsRestoreSlow] = useState(false);
  const dismissedWhileBusyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [diffStatsForRestore, setDiffStatsForRestore] = useState<
    FileHistoryDiffStats | undefined
  >();

  const activeOption = options[activeIndex];
  const fileHistoryMetadata = useMemo(
    () => computeMetadataForMessages(allMessages, messages),
    [allMessages, messages],
  );

  const visibleStart = useMemo(
    () =>
      calculateCenteredWindow(
        activeIndex,
        options.length,
        MAX_VISIBLE_MESSAGES,
      ),
    [activeIndex, options.length],
  );

  const visibleOptions = useMemo(
    () => options.slice(visibleStart, visibleStart + MAX_VISIBLE_MESSAGES),
    [options, visibleStart],
  );

  useEffect(() => {
    if (options.length === 0) {
      setActiveIndex(0);
      setMessageToRestore(null);
      return;
    }
    setActiveIndex((prev) => Math.min(prev, options.length - 1));
  }, [options.length]);

  useEffect(() => {
    let cancelled = false;

    const loadDiffStats = async () => {
      setDiffStatsForRestore(undefined);
      if (
        !messageToRestore ||
        !fileHistory?.canRewind(messageToRestore.message.uuid)
      ) {
        return;
      }

      try {
        const nextStats = await fileHistory.getDiffStats(
          messageToRestore.message.uuid,
        );
        if (!cancelled) {
          setDiffStatsForRestore(nextStats);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error ? nextError.message : String(nextError),
          );
        }
      }
    };

    void loadDiffStats();

    return () => {
      cancelled = true;
    };
  }, [fileHistory, messageToRestore]);

  useEffect(() => {
    if (!isBusy) {
      setIsRestoreSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setIsRestoreSlow(true), RESTORE_SLOW_HINT_MS);
    return () => clearTimeout(timer);
  }, [isBusy]);

  const runAction = useCallback(
    async (action: (candidate: RewindCandidate) => Promise<void>) => {
      if (!messageToRestore || isBusy) {
        return;
      }

      dismissedWhileBusyRef.current = false;
      setIsBusy(true);
      setError(null);
      try {
        await action(messageToRestore);
        // The user may have dismissed the dialog while the action ran; closing
        // again would be a no-op at best and reopen races at worst.
        if (!dismissedWhileBusyRef.current) {
          onClose();
        }
      } catch (nextError) {
        const message =
          nextError instanceof Error ? nextError.message : String(nextError);
        if (dismissedWhileBusyRef.current) {
          onBackgroundError?.(message);
        } else {
          setError(message);
        }
      } finally {
        setIsBusy(false);
      }
    },
    [messageToRestore, isBusy, onClose, onBackgroundError],
  );

  const canRestoreFiles = Boolean(
    messageToRestore &&
      fileHistory?.canRewind(messageToRestore.message.uuid),
  );

  // ─── Escape handler (overrides BaseTabDialog's default escape behavior) ───
  const handleEscape = useCallback(() => {
    if (isBusy) {
      // The action has no cancellation token, but the user must never be
      // trapped behind it. Let it finish in the background; a late failure is
      // reported through onBackgroundError.
      dismissedWhileBusyRef.current = true;
      onClose();
      return;
    }
    if (messageToRestore) {
      setMessageToRestore(null);
      setError(null);
      return;
    }
    onClose();
  }, [isBusy, messageToRestore, onClose]);

  // ─── Action handlers for Dialog context ───
  const actionHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:navigate:up': () => {
        if (isBusy || messageToRestore) return false;
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return true;
      },
      'dialog:navigate:down': () => {
        if (isBusy || messageToRestore) return false;
        setActiveIndex((prev) => Math.min(prev + 1, options.length - 1));
        return true;
      },
      'dialog:confirm': () => {
        if (isBusy) return false;
        if (messageToRestore) {
          void runAction(
            canRestoreFiles ? onRestoreBoth : onRestoreConversation,
          );
          return true;
        }
        // List mode: select current option
        if (activeOption?.isCurrent) {
          onClose();
          return true;
        }
        if (activeOption?.candidate) {
          setMessageToRestore(activeOption.candidate);
          setError(null);
        }
        return true;
      },
    }),
    [
      isBusy,
      messageToRestore,
      activeOption,
      options.length,
      onClose,
      canRestoreFiles,
      onRestoreConversation,
      onRestoreBoth,
      runAction,
    ],
  );

  useRegisterActionHandlers('Dialog', actionHandlers);

  // ─── Fallback handler for letter shortcuts ───
  const fallbackHandler = useCallback<ActionHandler>(
    (key) => {
      if (isBusy) return true;

      if (messageToRestore) {
        if (key.sequence === 'c') {
          void runAction(onRestoreConversation);
          return true;
        }
        if (key.sequence === 'f' && canRestoreFiles) {
          void runAction(onRestoreFiles);
          return true;
        }
        return false;
      }

      // List mode: Ctrl+P / Ctrl+N for navigation
      if (key.ctrl && key.name === 'p') {
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return true;
      }
      if (key.ctrl && key.name === 'n') {
        setActiveIndex((prev) => Math.min(prev + 1, options.length - 1));
        return true;
      }

      return false;
    },
    [
      isBusy,
      messageToRestore,
      options.length,
      onRestoreConversation,
      onRestoreFiles,
      canRestoreFiles,
      runAction,
    ],
  );

  useRegisterFallbackHandler('Dialog', fallbackHandler);

  // ─── Dynamic extra hints based on current phase ───
  const extraHints = useMemo(() => {
    if (messageToRestore) {
      return canRestoreFiles
        ? [
            { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
            { label: SHORTCUT_HINTS.ENTER_FILES_AND_CONVERSATION, order: 30 },
            { label: SHORTCUT_HINTS.C_CONVERSATION_ONLY, order: 40 },
            { label: SHORTCUT_HINTS.F_FILES_ONLY, order: 50 },
            { label: SHORTCUT_HINTS.GO_BACK, order: 100 },
          ]
        : [
            { label: 'Enter conversation', order: 30 },
            { label: SHORTCUT_HINTS.GO_BACK, order: 100 },
          ];
    }
    return [
      { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
      { label: SHORTCUT_HINTS.SELECT, order: 30 },
    ];
  }, [canRestoreFiles, messageToRestore]);

  return (
    <BaseTabDialog
      title="Rewind"
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={handleEscape}
      extraHints={extraHints}
    >
      {messages.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>Nothing to rewind to yet.</Text>
        </Box>
      ) : messageToRestore ? (
        <RewindConfirmView
          candidate={messageToRestore}
          diffStats={diffStatsForRestore}
          fileHistory={fileHistory}
        />
      ) : (
        <RewindListView
          activeIndex={activeIndex}
          fileHistory={fileHistory}
          metadata={fileHistoryMetadata}
          options={options}
          visibleOptions={visibleOptions}
          visibleStart={visibleStart}
        />
      )}
      {isBusy ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            <CliSpinner type="dots" />{' '}
            {isRestoreSlow
              ? 'Still restoring… press Esc to dismiss; it will finish in the background.'
              : 'Restoring…'}
          </Text>
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      ) : null}
    </BaseTabDialog>
  );
}

function RewindListView({
  activeIndex,
  fileHistory,
  metadata,
  options,
  visibleOptions,
  visibleStart,
}: {
  activeIndex: number;
  fileHistory: FileHistoryManager | undefined;
  metadata: Record<string, RewindListDiffStats | undefined>;
  options: RewindOption[];
  visibleOptions: RewindOption[];
  visibleStart: number;
}): React.JSX.Element {
  const hiddenAboveCount = visibleStart;
  const hiddenBelowCount = Math.max(
    options.length - (visibleStart + visibleOptions.length),
    0,
  );

  return (
    <>
      <Box>
        <Text>Choose where to rewind.</Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary} dimColor>
          Each entry shows changes made after that message.
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {hiddenAboveCount > 0 ? (
          <Text dimColor>↑ {hiddenAboveCount} earlier messages</Text>
        ) : null}
        {visibleOptions.map((option, index) => {
          const absoluteIndex = visibleStart + index;
          const selected = absoluteIndex === activeIndex;
          const messageMetadata = option.candidate
            ? metadata[option.candidate.message.uuid]
            : undefined;
          return (
            <Box key={option.key} flexDirection="column" marginBottom={1}>
              <Text
                color={selected ? theme.ui.focus : undefined}
                italic={option.isCurrent}
              >
                {selected ? figures.pointer : ' '}{' '}
                {option.candidate
                  ? option.candidate.displayText
                  : '(current)'}
              </Text>
              {option.isCurrent ? null : (
                <Text
                  dimColor
                  color={selected ? undefined : theme.text.secondary}
                >
                  {'  '}
                  {option.candidate
                    ? formatListSecondaryText(
                        option.candidate,
                        messageMetadata,
                        fileHistory,
                      )
                    : null}
                </Text>
              )}
            </Box>
          );
        })}
        {hiddenBelowCount > 0 ? (
          <Text dimColor>↓ {hiddenBelowCount} later messages</Text>
        ) : null}
      </Box>
    </>
  );
}

function RewindConfirmView({
  candidate,
  diffStats,
  fileHistory,
}: {
  candidate: RewindCandidate;
  diffStats: FileHistoryDiffStats | undefined;
  fileHistory: FileHistoryManager | undefined;
}): React.JSX.Element {
  return (
    <>
      <Box marginTop={1}>
        <Text>Confirm this rewind point:</Text>
      </Box>
      <Box
        flexDirection="column"
        marginTop={1}
        paddingLeft={1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
      >
        <Text>{candidate.displayText}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {formatConfirmDiffStats(
            diffStats,
            candidate.message.uuid,
            fileHistory,
          )}
        </Text>
        <Text dimColor>Choose what to restore from this point.</Text>
        <Text dimColor>
          Files edited manually or via shell may not be restored by rewind.
        </Text>
      </Box>
    </>
  );
}

function isToolResultUserMessage(message: Message): message is UserMessage {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return false;
  }
  return message.message.content.some((block) => block.type === 'tool_result');
}

function toRewindListDiffStats(
  result: unknown,
): RewindListDiffStats | undefined {
  if (!isFileDiff(result)) {
    return undefined;
  }

  return {
    filesChanged: [result.filePath],
    insertions:
      (result.diffStat?.model_added_lines ?? 0) +
      (result.diffStat?.user_added_lines ?? 0),
    deletions:
      (result.diffStat?.model_removed_lines ?? 0) +
      (result.diffStat?.user_removed_lines ?? 0),
  };
}

function mergeRewindListDiffStats(
  stats: RewindListDiffStats[],
): RewindListDiffStats | undefined {
  if (stats.length === 0) {
    return undefined;
  }

  const filesChanged: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const stat of stats) {
    for (const filePath of stat.filesChanged) {
      if (!filesChanged.includes(filePath)) {
        filesChanged.push(filePath);
      }
    }
    insertions += stat.insertions;
    deletions += stat.deletions;
  }

  return {
    filesChanged,
    insertions,
    deletions,
  };
}

function computeMetadataForMessages(
  allMessages: Message[],
  messages: RewindCandidate[],
): Record<string, RewindListDiffStats | undefined> {
  const metadata: Record<string, RewindListDiffStats | undefined> = {};

  for (let i = 0; i < messages.length; i += 1) {
    const currentMessage = messages[i].message;
    const nextMessage = messages[i + 1]?.message;
    const startIndex = allMessages.findIndex(
      (candidate) => candidate.uuid === currentMessage.uuid,
    );

    if (startIndex === -1) {
      metadata[currentMessage.uuid] = undefined;
      continue;
    }

    let endIndex = nextMessage
      ? allMessages.findIndex(
          (candidate) => candidate.uuid === nextMessage.uuid,
        )
      : allMessages.length;
    if (endIndex === -1) {
      endIndex = allMessages.length;
    }

    const stats: RewindListDiffStats[] = [];
    for (
      let messageIndex = startIndex + 1;
      messageIndex < endIndex;
      messageIndex += 1
    ) {
      const message = allMessages[messageIndex];
      if (!message || !isToolResultUserMessage(message)) {
        continue;
      }

      const diffStats = toRewindListDiffStats(message.toolUseResult);
      if (diffStats) {
        stats.push(diffStats);
      }
    }

    metadata[currentMessage.uuid] = mergeRewindListDiffStats(stats);
  }

  return metadata;
}

function formatListMetadata(
  stats: RewindListDiffStats | undefined,
  fileHistory: FileHistoryManager | undefined,
): string {
  if (!fileHistory) {
    return 'Conversation only';
  }
  if (stats === undefined) {
    return 'No file changes in that step';
  }
  if (stats.filesChanged.length === 0) {
    return 'No file changes in that step';
  }

  const fileLabel =
    stats.filesChanged.length === 1
      ? path.basename(stats.filesChanged[0] ?? '')
      : `${stats.filesChanged.length} files changed`;

  return `${fileLabel} · +${stats.insertions} -${stats.deletions}`;
}

function formatListSecondaryText(
  candidate: RewindCandidate,
  stats: RewindListDiffStats | undefined,
  fileHistory: FileHistoryManager | undefined,
): string {
  return `${formatRelativeTime(
    candidate.message.timestamp,
    'short',
  )} · ${formatListMetadata(stats, fileHistory)}`;
}

function formatConfirmDiffStats(
  stats: FileHistoryDiffStats | undefined,
  messageId: string | undefined,
  fileHistory: FileHistoryManager | undefined,
): string {
  if (!messageId || !fileHistory?.canRewind(messageId)) {
    return 'Conversation will be restored. Files will stay as they are now.';
  }
  if (!stats) {
    return 'Checking what file changes would be restored...';
  }
  if (stats.failedFiles?.length) {
    return `${stats.filesChanged.length} file(s) can be restored; ${stats.failedFiles.length} file(s) have no usable backup and will be skipped: ${stats.failedFiles.map((file) => path.basename(file.path)).join(', ')}.`;
  }
  if (stats.filesChanged.length === 0) {
    return 'Conversation will be restored. No file changes would be restored.';
  }
  return `If you rewind now, ${formatConfirmFileLabel(stats.filesChanged)} would be restored (+${stats.insertions} -${stats.deletions}).`;
}

function formatConfirmFileLabel(filesChanged: string[]): string {
  if (filesChanged.length === 0) {
    return 'no files';
  }
  if (filesChanged.length === 1) {
    return path.basename(filesChanged[0] ?? '');
  }
  if (filesChanged.length === 2) {
    return `${path.basename(filesChanged[0] ?? '')} and ${path.basename(filesChanged[1] ?? '')}`;
  }
  return `${path.basename(filesChanged[0] ?? '')} and ${filesChanged.length - 1} other files`;
}
