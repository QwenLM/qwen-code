/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

interface AutoAcceptIndicatorProps {
  approvalMode: ApprovalMode;
  workMode?: {
    id: string;
    name: string;
    icon: string;
    color: string;
  };
}

export const AutoAcceptIndicator: React.FC<AutoAcceptIndicatorProps> = ({
  approvalMode,
  workMode,
}) => {
  let textColor = '';
  let textContent = '';
  let subText = '';

  const cycleText =
    process.platform === 'win32'
      ? ` ${t('(tab to cycle)')}`
      : ` ${t('(shift + tab to cycle)')}`;

  // Check if we're in a work mode
  if (workMode) {
    textColor = workMode.color || theme.text.primary;
    textContent = `${workMode.icon} ${workMode.name} mode`;
    subText = cycleText;
  } else {
    // Approval modes
    switch (approvalMode) {
      case ApprovalMode.PLAN:
        textColor = '#9333EA'; // Purple
        textContent = `📋 ${t('plan mode')}`;
        subText = cycleText;
        break;
      case ApprovalMode.AUTO_EDIT:
        textColor = '#F59E0B'; // Amber/Orange
        textContent = `✅ ${t('auto-accept edits')}`;
        subText = cycleText;
        break;
      case ApprovalMode.YOLO:
        textColor = '#EF4444'; // Red
        textContent = `🚀 ${t('YOLO mode')}`;
        subText = cycleText;
        break;
      case ApprovalMode.DEFAULT:
      default:
        textColor = theme.text.secondary;
        textContent = t('? for shortcuts');
        break;
    }
  }

  return (
    <Box>
      <Text color={textColor}>
        {textContent}
        {subText && <Text color={theme.text.secondary}>{subText}</Text>}
      </Text>
    </Box>
  );
};
