/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  getAssistantTextBlocks,
  getDisplayableUserText,
  isHiddenUserMessageInDefaultHistory,
  type Message,
} from '@qwen-code/core';
import type {
  HistoryItemSubagent,
  IndividualToolCallDisplay,
} from '../../types.js';
import { theme } from '../../semantic-colors.js';
import {
  collectSubagentToolResults,
  projectSubagentToolCalls,
} from '../../../utils/subagentTraceProjection.js';
import { ToolGroupMessage } from './ToolGroupMessage.js';
import { useConfig } from '../../contexts/ConfigContext.js';

interface SubagentHistoryMessageProps {
  item: HistoryItemSubagent;
  terminalWidth: number;
}

type TraceRow =
  | { key: string; type: 'text'; text: string; color: string }
  | { key: string; type: 'tools'; tools: IndividualToolCallDisplay[] };

function renderMessageTrace(
  messages: readonly Message[],
  targetDir?: string,
): TraceRow[] {
  const rows: TraceRow[] = [];
  const toolResults = collectSubagentToolResults(messages);

  for (const message of messages) {
    if (
      message.type === 'user' &&
      !isHiddenUserMessageInDefaultHistory(message)
    ) {
      const text = getDisplayableUserText(message);
      if (!text) {
        continue;
      }
      rows.push({
        key: `${message.uuid}:user`,
        type: 'text',
        text: `👤 ${text}`,
        color: theme.text.primary,
      });
      continue;
    }

    if (message.type === 'assistant') {
      for (const text of getAssistantTextBlocks(message)) {
        rows.push({
          key: `${message.uuid}:assistant:${rows.length}`,
          type: 'text',
          text: `🤖 ${text}`,
          color: theme.text.accent,
        });
      }

      const toolCalls = projectSubagentToolCalls(message, toolResults, {
        targetDir,
      });
      if (toolCalls.length > 0) {
        rows.push({
          key: `${message.uuid}:tools`,
          type: 'tools',
          tools: toolCalls,
        });
      }
    }
  }

  return rows;
}

export const SubagentHistoryMessage: React.FC<SubagentHistoryMessageProps> = ({
  item,
  terminalWidth,
}) => {
  const config = useConfig();
  const traceRows = useMemo(
    () => renderMessageTrace(item.messages, config.getTargetDir()),
    [item.messages, config],
  );
  const traceCount = item.messages.length;

  return (
    <Box flexDirection="column" width={terminalWidth} marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.text.accent}>
          🤖 {item.agentName} Trace ({traceCount} messages)
        </Text>
      </Box>

      {traceRows.map((row) =>
        row.type === 'text' ? (
          <Box key={row.key} marginLeft={2} marginBottom={0}>
            <Text color={row.color}>{row.text}</Text>
          </Box>
        ) : (
          <Box key={row.key} marginLeft={2} marginBottom={0}>
            <ToolGroupMessage
              item={{ type: 'tool_group', tools: row.tools }}
              toolCalls={row.tools}
              terminalWidth={Math.max(20, terminalWidth - 2)}
              borderTop={false}
              borderBottom={false}
              isExpandable={false}
            />
          </Box>
        ),
      )}
    </Box>
  );
};
