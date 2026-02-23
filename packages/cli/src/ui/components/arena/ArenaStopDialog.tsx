/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  ArenaSessionStatus,
  createDebugLogger,
  type Config,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { MessageType, type HistoryItemWithoutId } from '../../types.js';
import type { UseHistoryManagerReturn } from '../../hooks/useHistoryManager.js';
import { DescriptiveRadioButtonSelect } from '../shared/DescriptiveRadioButtonSelect.js';
import type { DescriptiveRadioSelectItem } from '../shared/DescriptiveRadioButtonSelect.js';

const debugLogger = createDebugLogger('ARENA_STOP_DIALOG');

type StopAction = 'cleanup' | 'preserve';

interface ArenaStopDialogProps {
  config: Config;
  addItem: UseHistoryManagerReturn['addItem'];
  closeArenaDialog: () => void;
}

export function ArenaStopDialog({
  config,
  addItem,
  closeArenaDialog,
}: ArenaStopDialogProps): React.JSX.Element {
  const [isProcessing, setIsProcessing] = useState(false);

  const pushMessage = useCallback(
    (result: { messageType: 'info' | 'error'; content: string }) => {
      const item: HistoryItemWithoutId = {
        type:
          result.messageType === 'info' ? MessageType.INFO : MessageType.ERROR,
        text: result.content,
      };
      addItem(item, Date.now());

      try {
        const chatRecorder = config.getChatRecordingService();
        chatRecorder?.recordSlashCommand({
          phase: 'result',
          rawCommand: '/arena stop',
          outputHistoryItems: [{ ...item } as Record<string, unknown>],
        });
      } catch {
        // Best-effort recording
      }
    },
    [addItem, config],
  );

  const onStop = useCallback(
    async (action: StopAction) => {
      if (isProcessing) return;
      setIsProcessing(true);
      closeArenaDialog();

      const mgr = config.getArenaManager();
      if (!mgr) {
        pushMessage({
          messageType: 'error',
          content: 'No running Arena session found.',
        });
        return;
      }

      try {
        const sessionStatus = mgr.getSessionStatus();
        if (
          sessionStatus === ArenaSessionStatus.RUNNING ||
          sessionStatus === ArenaSessionStatus.INITIALIZING
        ) {
          await mgr.cancel();
        }
        await mgr.waitForSettled();

        if (action === 'preserve') {
          await mgr.cleanupRuntime();
        } else {
          await mgr.cleanup();
        }
        config.setArenaManager(null);

        if (action === 'preserve') {
          pushMessage({
            messageType: 'info',
            content:
              'Arena session stopped. Worktrees and session files were preserved. ' +
              'Use /arena select --discard to manually clean up later.',
          });
        } else {
          pushMessage({
            messageType: 'info',
            content:
              'Arena session stopped. All Arena resources (including Git worktrees) were cleaned up.',
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.error('Failed to stop Arena session:', error);
        pushMessage({
          messageType: 'error',
          content: `Failed to stop Arena session: ${message}`,
        });
      }
    },
    [isProcessing, closeArenaDialog, config, pushMessage],
  );

  const configPreserve =
    config.getAgentsSettings().arena?.preserveArtifacts ?? false;

  const items: Array<DescriptiveRadioSelectItem<StopAction>> = useMemo(
    () => [
      {
        key: 'cleanup',
        value: 'cleanup' as StopAction,
        title: <Text>Stop and clean up</Text>,
        description: (
          <Text color={theme.text.secondary}>
            Remove all worktrees and session files
          </Text>
        ),
      },
      {
        key: 'preserve',
        value: 'preserve' as StopAction,
        title: <Text>Stop and preserve artifacts</Text>,
        description: (
          <Text color={theme.text.secondary}>
            Keep worktrees and session files for later inspection
          </Text>
        ),
      },
    ],
    [],
  );

  const defaultIndex = configPreserve ? 1 : 0;

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        closeArenaDialog();
      }
    },
    { isActive: !isProcessing },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={theme.text.primary}>
        Stop Arena Session
      </Text>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Choose what to do with Arena artifacts:
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <DescriptiveRadioButtonSelect
          items={items}
          initialIndex={defaultIndex}
          onSelect={(action: StopAction) => {
            onStop(action);
          }}
          isFocused={!isProcessing}
          showNumbers={false}
        />
      </Box>

      {configPreserve && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary} dimColor>
            Default: preserve (agents.arena.preserveArtifacts is enabled)
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Enter to confirm, Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
