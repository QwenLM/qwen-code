/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import {
  type AgentUnifiedTask,
} from '@qwen-code/core';
import { useAgentTranscript } from '../hooks/useAgentTranscript.js';
import { TranscriptHistoryView } from './TranscriptHistoryView.js';
import { theme } from '../semantic-colors.js';

export interface AgentTranscriptViewProps {
  task: AgentUnifiedTask;
  terminalWidth: number;
  availableTerminalHeight?: number;
}

export const AgentTranscriptView: React.FC<AgentTranscriptViewProps> = ({
  task,
  terminalWidth,
  availableTerminalHeight,
}) => {
  const { messages, loading, error } = useAgentTranscript(task);

  if (loading && messages.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.text.secondary}>Loading transcript...</Text>
      </Box>
    );
  }

  if (error && messages.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.status.error}>{error}</Text>
      </Box>
    );
  }

  if (messages.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.text.secondary}>No transcript messages yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <TranscriptHistoryView
        conversationKey={`agent:${task.id}`}
        messages={messages}
        terminalWidth={terminalWidth}
        availableTerminalHeight={availableTerminalHeight}
        taskStatus={task.status}
        inProgressToolUseIds={task.inProgressToolUseIds}
      />
    </Box>
  );
};
