/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

interface ProQuotaDialogProps {
  failedModel: string;
  fallbackModel: string;
  onChoice: (choice: 'auth' | 'continue') => void;
}

export function ProQuotaDialog({
  failedModel,
  fallbackModel,
  onChoice,
}: ProQuotaDialogProps): React.JSX.Element {
  const items = [
    {
      label: t('Change auth (executes the /auth command)'),
      value: 'auth' as const,
      key: 'auth',
    },
    {
      label: t('Continue with {{model}}', { model: fallbackModel }),
      value: 'continue' as const,
      key: 'continue',
    },
  ];

  const handleSelect = (choice: 'auth' | 'continue') => {
    onChoice(choice);
  };

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold color={theme.status.warning}>
        {t('Pro quota limit reached for {{model}}.', { model: failedModel })}
      </Text>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={1}
          onSelect={handleSelect}
        />
      </Box>
    </Box>
  );
}
