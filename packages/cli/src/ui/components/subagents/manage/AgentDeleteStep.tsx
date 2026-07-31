/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { type SubagentConfig } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { StepNavigationProps } from '../types.js';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';

interface AgentDeleteStepProps extends StepNavigationProps {
  selectedAgent: SubagentConfig | null;
  onDelete: (agent: SubagentConfig) => Promise<void>;
}

const debugLogger = createDebugLogger('AGENT_DELETE_STEP');

export function AgentDeleteStep({
  selectedAgent,
  onDelete,
  onNavigateBack,
}: AgentDeleteStepProps) {
  useKeypress(
    async (key) => {
      if (!selectedAgent) return;

      if (key.name === 'y' || key.name === 'return') {
        try {
          await onDelete(selectedAgent);
          // Navigation will be handled by the parent component after successful deletion
        } catch (error) {
          debugLogger.error('Failed to delete agent:', error);
        }
      } else if (key.name === 'n') {
        onNavigateBack();
      }
    },
    { isActive: true },
  );

  if (!selectedAgent) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No agent selected')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={theme.status.error}>
        {t('Are you sure you want to delete agent "{{name}}"?', {
          name: selectedAgent.name,
        })}
      </Text>
    </Box>
  );
}
