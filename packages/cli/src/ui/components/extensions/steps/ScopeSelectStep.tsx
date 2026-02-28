/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { type Extension } from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { t } from '../../../../i18n/index.js';

interface ScopeSelectStepProps {
  selectedExtension: Extension | null;
  mode: 'disable' | 'enable';
  onScopeSelect: (scope: 'user' | 'workspace') => void;
  onNavigateBack: () => void;
}

export function ScopeSelectStep({
  selectedExtension,
  mode,
  onScopeSelect,
  onNavigateBack,
}: ScopeSelectStepProps) {
  const scopeItems = [
    {
      key: 'user',
      get label() {
        return t('User (global)');
      },
      value: 'user' as const,
    },
    {
      key: 'workspace',
      get label() {
        return t('Workspace (project-specific)');
      },
      value: 'workspace' as const,
    },
    {
      key: 'back',
      get label() {
        return t('Back');
      },
      value: 'back' as const,
    },
  ];

  const handleSelect = (value: 'user' | 'workspace' | 'back') => {
    if (value === 'back') {
      onNavigateBack();
      return;
    }
    onScopeSelect(value);
  };

  if (!selectedExtension) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No extension selected')}</Text>
      </Box>
    );
  }

  const title =
    mode === 'disable'
      ? t('Disable "{{name}}" - Select Scope', { name: selectedExtension.name })
      : t('Enable "{{name}}" - Select Scope', { name: selectedExtension.name });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={theme.text.primary}>{title}</Text>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={scopeItems}
          onSelect={handleSelect}
          showNumbers={false}
        />
      </Box>
    </Box>
  );
}
