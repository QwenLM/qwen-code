/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { type Extension } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';

interface UninstallConfirmStepProps {
  selectedExtension: Extension | null;
  onConfirm: (extension: Extension) => Promise<void>;
  onNavigateBack: () => void;
}

const debugLogger = createDebugLogger('EXTENSION_UNINSTALL_STEP');

export function UninstallConfirmStep({
  selectedExtension,
  onConfirm,
  onNavigateBack,
}: UninstallConfirmStepProps) {
  useKeypress(
    async (key) => {
      if (!selectedExtension) return;

      if (key.name === 'y' || key.name === 'return') {
        try {
          await onConfirm(selectedExtension);
          // Navigation will be handled by the parent component after successful uninstall
        } catch (error) {
          debugLogger.error('Failed to uninstall extension:', error);
        }
      } else if (key.name === 'n' || key.name === 'escape') {
        onNavigateBack();
      }
    },
    { isActive: true },
  );

  if (!selectedExtension) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No extension selected')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={theme.status.error}>
        {t('Are you sure you want to uninstall extension "{{name}}"?', {
          name: selectedExtension.name,
        })}
      </Text>
      <Text color={theme.text.secondary}>
        {t('This action cannot be undone.')}
      </Text>
      <Box marginTop={1}>
        <Text>{t('Press Y/Enter to confirm, N/Esc to cancel')}</Text>
      </Box>
    </Box>
  );
}
