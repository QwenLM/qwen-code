/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import type { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { t } from '../../i18n/index.js';
import {
  getApprovalModeIndicatorColor,
  getApprovalModeLabel,
} from './approvalModeVisuals.js';

interface AutoAcceptIndicatorProps {
  approvalMode: ApprovalMode;
  showMode?: boolean;
}

export const AutoAcceptIndicator: React.FC<AutoAcceptIndicatorProps> = ({
  approvalMode,
  showMode = true,
}) => {
  const textColor = getApprovalModeIndicatorColor(approvalMode) ?? '';
  const textContent = showMode ? getApprovalModeLabel(approvalMode) : '';
  const cycleText =
    process.platform === 'win32'
      ? t('(tab to cycle)')
      : t('(shift + tab to cycle)');

  return (
    <Text color={textColor}>
      {textContent}
      <Text color={theme.text.secondary}>
        {textContent && ' '}
        {cycleText}
      </Text>
    </Text>
  );
};
