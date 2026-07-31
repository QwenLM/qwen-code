/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { t } from '../../../../i18n/index.js';
import type { DisableScopeSelectStepProps } from '../types.js';

export const DisableScopeSelectStep: React.FC<DisableScopeSelectStepProps> = ({
  server,
  onSelectScope,
  onBack,
}) => {
  const [selectedScope, setSelectedScope] = useState<'user' | 'workspace'>(
    'user',
  );

  const scopes = [
    {
      key: 'user',
      get label() {
        return t('User Settings (global)');
      },
      value: 'user' as const,
    },
    {
      key: 'workspace',
      get label() {
        return t('Workspace Settings (project-specific)');
      },
      value: 'workspace' as const,
    },
  ];

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      } else if (key.name === 'return') {
        onSelectScope(selectedScope);
      }
    },
    { isActive: true },
  );

  if (!server) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No server selected')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text color={theme.text.primary}>
          {t('Disable server:')} {server.name}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Select where to add the server to the exclude list:')}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <RadioButtonSelect<'user' | 'workspace'>
          items={scopes}
          onHighlight={(value: 'user' | 'workspace') => setSelectedScope(value)}
          onSelect={(value: 'user' | 'workspace') => onSelectScope(value)}
        />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Press Enter to confirm, Esc to cancel')}
        </Text>
      </Box>
    </Box>
  );
};
