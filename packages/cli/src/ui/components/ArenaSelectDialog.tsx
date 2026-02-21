/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  type ArenaManager,
  AgentStatus,
  type Config,
} from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import { formatDuration } from '../utils/formatters.js';
import { getArenaStatusLabel } from '../utils/displayUtils.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import type { DescriptiveRadioSelectItem } from './shared/DescriptiveRadioButtonSelect.js';

interface ArenaSelectDialogProps {
  manager: ArenaManager;
  config: Config;
  addItem: UseHistoryManagerReturn['addItem'];
  closeArenaDialog: () => void;
}

export function ArenaSelectDialog({
  manager,
  config,
  addItem,
  closeArenaDialog,
}: ArenaSelectDialogProps): React.JSX.Element {
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
          rawCommand: '/arena select',
          outputHistoryItems: [{ ...item } as Record<string, unknown>],
        });
      } catch {
        // Best-effort recording
      }
    },
    [addItem, config],
  );

  const onSelect = useCallback(
    async (agentId: string) => {
      closeArenaDialog();
      const mgr = config.getArenaManager();
      if (!mgr) {
        pushMessage({
          messageType: 'error',
          content: 'No arena session found. Start one with /arena start.',
        });
        return;
      }

      const agent =
        mgr.getAgentState(agentId) ??
        mgr.getAgentStates().find((item) => item.agentId === agentId);
      const label = agent?.model.displayName || agent?.model.modelId || agentId;

      const result = await mgr.applyAgentResult(agentId);
      if (!result.success) {
        pushMessage({
          messageType: 'error',
          content: `Failed to apply changes from ${label}: ${result.error}`,
        });
        return;
      }

      try {
        await config.cleanupArenaRuntime(true);
      } catch (err) {
        pushMessage({
          messageType: 'error',
          content: `Warning: failed to clean up arena resources: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      pushMessage({
        messageType: 'info',
        content: `Applied changes from ${label} to workspace. Arena session complete.`,
      });
    },
    [closeArenaDialog, config, pushMessage],
  );

  const onDiscard = useCallback(async () => {
    closeArenaDialog();
    const mgr = config.getArenaManager();
    if (!mgr) {
      pushMessage({
        messageType: 'error',
        content: 'No arena session found. Start one with /arena start.',
      });
      return;
    }

    try {
      await config.cleanupArenaRuntime(true);
      pushMessage({
        messageType: 'info',
        content: 'Arena results discarded. All worktrees cleaned up.',
      });
    } catch (err) {
      pushMessage({
        messageType: 'error',
        content: `Failed to clean up arena worktrees: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [closeArenaDialog, config, pushMessage]);

  const result = manager.getResult();
  const agents = manager.getAgentStates();

  const items: Array<DescriptiveRadioSelectItem<string>> = useMemo(
    () =>
      agents.map((agent) => {
        const label = agent.model.displayName || agent.model.modelId;
        const statusInfo = getArenaStatusLabel(agent.status);
        const duration = formatDuration(agent.stats.durationMs);
        const tokens = agent.stats.totalTokens.toLocaleString();

        // Build diff summary from cached result if available
        let diffAdditions = 0;
        let diffDeletions = 0;
        if (agent.status === AgentStatus.COMPLETED && result) {
          const agentResult = result.agents.find(
            (a) => a.agentId === agent.agentId,
          );
          if (agentResult?.diff) {
            const lines = agentResult.diff.split('\n');
            for (const line of lines) {
              if (line.startsWith('+') && !line.startsWith('+++')) {
                diffAdditions++;
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                diffDeletions++;
              }
            }
          }
        }

        // Title: full model name (not truncated)
        const title = <Text>{label}</Text>;

        // Description: status, time, tokens, changes (unified with Arena Complete columns)
        const description = (
          <Text>
            <Text color={statusInfo.color}>{statusInfo.text}</Text>
            <Text color={theme.text.secondary}> · </Text>
            <Text color={theme.text.secondary}>{duration}</Text>
            <Text color={theme.text.secondary}> · </Text>
            <Text color={theme.text.secondary}>{tokens} tokens</Text>
            {(diffAdditions > 0 || diffDeletions > 0) && (
              <>
                <Text color={theme.text.secondary}> · </Text>
                <Text color={theme.status.success}>+{diffAdditions}</Text>
                <Text color={theme.text.secondary}>/</Text>
                <Text color={theme.status.error}>-{diffDeletions}</Text>
                <Text color={theme.text.secondary}> lines</Text>
              </>
            )}
          </Text>
        );

        return {
          key: agent.agentId,
          value: agent.agentId,
          title,
          description,
          disabled: agent.status !== AgentStatus.COMPLETED,
        };
      }),
    [agents, result],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        closeArenaDialog();
      }
      if (key.name === 'd' && !key.ctrl && !key.meta) {
        onDiscard();
      }
    },
    { isActive: true },
  );

  const task = result?.task || '';

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      {/* Neutral title color (not green) */}
      <Text bold color={theme.text.primary}>
        Arena Results
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={theme.text.secondary}>Task: </Text>
          <Text
            color={theme.text.primary}
          >{`"${task.length > 60 ? task.slice(0, 59) + '…' : task}"`}</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Select a winner to apply changes:
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <DescriptiveRadioButtonSelect
          items={items}
          initialIndex={items.findIndex((item) => !item.disabled)}
          onSelect={(agentId: string) => {
            onSelect(agentId);
          }}
          isFocused={true}
          showNumbers={false}
        />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Enter to select, d to discard all, Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
