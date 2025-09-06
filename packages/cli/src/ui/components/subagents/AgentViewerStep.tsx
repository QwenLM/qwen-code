/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { shouldShowColor, getColorForDisplay } from './utils.js';
import { SubagentConfig } from '@qwen-code/qwen-code-core';

interface AgentViewerStepProps {
  selectedAgent: SubagentConfig | null;
}

export const AgentViewerStep = ({ selectedAgent }: AgentViewerStepProps) => {
  if (!selectedAgent) {
    return (
      <Box>
        <Text color={theme.status.error}>No agent selected</Text>
      </Box>
    );
  }

  const agent = selectedAgent;

  const toolsDisplay = agent.tools ? agent.tools.join(', ') : '*';

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text bold>Location: </Text>
          <Text>
            {agent.level === 'project'
              ? 'Project Level (.qwen/agents/)'
              : 'User Level (~/.qwen/agents/)'}
          </Text>
        </Box>

        <Box>
          <Text bold>File Path: </Text>
          <Text>{agent.filePath}</Text>
        </Box>

        <Box>
          <Text bold>Tools: </Text>
          <Text>{toolsDisplay}</Text>
        </Box>

        {shouldShowColor(agent.backgroundColor) && (
          <Box>
            <Text bold>Color: </Text>
            <Box backgroundColor={getColorForDisplay(agent.backgroundColor)}>
              <Text color="black">{` ${agent.name} `}</Text>
            </Box>
          </Box>
        )}

        <Box marginTop={1}>
          <Text bold>Description:</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">{agent.description}</Text>
        </Box>

        <Box marginTop={1}>
          <Text bold>System Prompt:</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">{agent.systemPrompt}</Text>
        </Box>
      </Box>
    </Box>
  );
};
