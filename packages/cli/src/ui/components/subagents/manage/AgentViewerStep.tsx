/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { shouldShowColor, getColorForDisplay } from '../utils.js';
import { type SubagentConfig } from '@qwen-code/qwen-code-core';
import { t } from '../../../../i18n/index.js';

interface AgentViewerStepProps {
  selectedAgent: SubagentConfig | null;
}

export const AgentViewerStep = ({ selectedAgent }: AgentViewerStepProps) => {
  if (!selectedAgent) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No agent selected')}</Text>
      </Box>
    );
  }

  const agent = selectedAgent;

  const toolsDisplay = agent.tools ? agent.tools.join(', ') : '*';

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.text.primary}>{t('File Path: ')}</Text>
          <Text>{agent.filePath}</Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>{t('Tools: ')}</Text>
          <Text>{toolsDisplay}</Text>
        </Box>

        {shouldShowColor(agent.color) && (
          <Box>
            <Text color={theme.text.primary}>{t('Color: ')}</Text>
            <Text color={getColorForDisplay(agent.color)}>{agent.color}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Description:')}</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">{agent.description}</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('System Prompt:')}</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">{agent.systemPrompt}</Text>
        </Box>
      </Box>
    </Box>
  );
};
