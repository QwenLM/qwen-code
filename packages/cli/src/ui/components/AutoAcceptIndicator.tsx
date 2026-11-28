/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import type { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import {
  getApprovalModeCycleHint,
  getApprovalModeIndicatorColor,
  getApprovalModeLabel,
} from './approvalModeVisuals.js';

interface AutoAcceptIndicatorProps {
  approvalMode: ApprovalMode;
}

export const AutoAcceptIndicator: React.FC<AutoAcceptIndicatorProps> = ({
  approvalMode,
}) => {
  const textColor = getApprovalModeIndicatorColor(approvalMode) ?? '';
  const textContent = getApprovalModeLabel(approvalMode);

  return (
    <Text color={textColor}>
      {textContent}
      <Text color={theme.text.secondary}>
        {textContent && ' '}
        {getApprovalModeCycleHint()}
      </Text>
    </Text>
  );
};
