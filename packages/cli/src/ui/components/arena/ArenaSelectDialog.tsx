/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  type ArenaManager,
  isSuccessStatus,
  type Config,
  type ArenaAgentResult,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { MessageType, type HistoryItemWithoutId } from '../../types.js';
import type { UseHistoryManagerReturn } from '../../hooks/useHistoryManager.js';
import { formatDuration } from '../../utils/formatters.js';
import { getArenaStatusLabel } from '../../utils/displayUtils.js';
import { DescriptiveRadioButtonSelect } from '../shared/DescriptiveRadioButtonSelect.js';
import type { DescriptiveRadioSelectItem } from '../shared/DescriptiveRadioButtonSelect.js';

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
      const label = agent?.model.modelId || agentId;

      pushMessage({
        messageType: 'info',
        content: `Applying changes from ${label}…`,
      });
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
      pushMessage({
        messageType: 'info',
        content: 'Discarding Arena results and cleaning up…',
      });
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
  const firstSelectableAgentId = agents.find((agent) =>
    isSuccessStatus(agent.status),
  )?.agentId;
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(
    firstSelectableAgentId,
  );
  const [showPreview, setShowPreview] = useState(false);
  const [showDetailedDiff, setShowDetailedDiff] = useState(false);
  const selectedResult = result?.agents.find(
    (agent) => agent.agentId === selectedAgentId,
  );

  const items: Array<DescriptiveRadioSelectItem<string>> = useMemo(
    () =>
      agents.map((agent) => {
        const label = agent.model.modelId;
        const statusInfo = getArenaStatusLabel(agent.status);
        const duration = formatDuration(agent.stats.durationMs);
        const tokens = agent.stats.totalTokens.toLocaleString();

        // Build diff summary from cached result if available
        let diffAdditions = 0;
        let diffDeletions = 0;
        let fileCount = 0;
        if (isSuccessStatus(agent.status) && result) {
          const agentResult = result.agents.find(
            (a) => a.agentId === agent.agentId,
          );
          if (agentResult?.diffSummary) {
            diffAdditions = agentResult.diffSummary.additions;
            diffDeletions = agentResult.diffSummary.deletions;
            fileCount = agentResult.diffSummary.files.length;
          } else if (agentResult?.diff) {
            const lines = agentResult.diff.split('\n');
            for (const line of lines) {
              if (line.startsWith('+') && !line.startsWith('+++')) {
                diffAdditions++;
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                diffDeletions++;
              }
            }
          }
          fileCount = agentResult?.modifiedFiles?.length ?? fileCount;
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
            {fileCount > 0 && (
              <>
                <Text color={theme.text.secondary}> · </Text>
                <Text color={theme.text.secondary}>{fileCount} files</Text>
              </>
            )}
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
          disabled: !isSuccessStatus(agent.status),
        };
      }),
    [agents, result],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        closeArenaDialog();
      }
      if (key.name === 'p' && !key.ctrl && !key.meta) {
        setShowPreview((current) => !current);
      }
      if (key.name === 'd' && !key.ctrl && !key.meta) {
        setShowDetailedDiff((current) => !current);
      }
      if (key.name === 'x' && !key.ctrl && !key.meta) {
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
          onHighlight={(agentId: string) => {
            setSelectedAgentId(agentId);
          }}
          isFocused={true}
          showNumbers={false}
        />
      </Box>

      {showPreview && selectedResult && (
        <ArenaAgentPreview result={selectedResult} />
      )}

      {showDetailedDiff && selectedResult && (
        <ArenaAgentDetailedDiff result={selectedResult} />
      )}

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          p preview, d detailed diff, Enter select winner, x discard all, Esc
          cancel
        </Text>
      </Box>
    </Box>
  );
}

function ArenaAgentPreview({
  result,
}: {
  result: ArenaAgentResult;
}): React.JSX.Element {
  const fileSummary = result.diffSummary?.files ?? [];
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color={theme.text.primary}>
        Quick Preview · {result.model.modelId}
      </Text>
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>Approach: </Text>
        <Text color={theme.text.primary}>
          {result.approachSummary ?? 'No approach summary available.'}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>Major files: </Text>
        <Text color={theme.text.primary}>
          {formatFileList(fileSummary.map((file) => file.path))}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>Metrics: </Text>
        <Text color={theme.text.primary}>
          {result.stats.totalTokens.toLocaleString()} tokens ·{' '}
          {formatDuration(result.stats.durationMs)} · {result.stats.toolCalls}{' '}
          tools
        </Text>
      </Box>
    </Box>
  );
}

function ArenaAgentDetailedDiff({
  result,
}: {
  result: ArenaAgentResult;
}): React.JSX.Element {
  const diffLines = getVisibleDiffLines(result.diff);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color={theme.text.primary}>
        Detailed Diff · {result.model.modelId}
      </Text>
      {diffLines.length === 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.text.secondary}>No diff available.</Text>
        </Box>
      ) : (
        <Box marginLeft={2} flexDirection="column">
          {diffLines.map((line, index) => (
            <Text key={`${index}-${line}`} color={getDiffLineColor(line)}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function formatFileList(files: string[]): string {
  if (files.length === 0) {
    return 'none';
  }
  const visible = files.slice(0, 6);
  const suffix =
    files.length > visible.length
      ? `, +${files.length - visible.length} more`
      : '';
  return `${visible.join(', ')}${suffix}`;
}

function getVisibleDiffLines(diff: string | undefined): string[] {
  if (!diff) {
    return [];
  }
  const lines = diff.split('\n');
  const maxLines = 180;
  if (lines.length <= maxLines) {
    return lines;
  }
  return [
    ...lines.slice(0, maxLines),
    `... truncated ${lines.length - maxLines} diff lines`,
  ];
}

function getDiffLineColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return theme.status.success;
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return theme.status.error;
  }
  if (
    line.startsWith('diff --git') ||
    line.startsWith('@@') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return theme.text.accent;
  }
  return theme.text.secondary;
}
