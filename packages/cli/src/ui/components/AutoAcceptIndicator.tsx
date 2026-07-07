/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { getApprovalModeIndicatorColor } from './approvalModeVisuals.js';

interface AutoAcceptIndicatorProps {
  approvalMode: ApprovalMode;
}

export const AutoAcceptIndicator: React.FC<AutoAcceptIndicatorProps> = ({
  approvalMode,
}) => {
  const textColor = getApprovalModeIndicatorColor(approvalMode) ?? '';
  let textContent = '';
  let subText = '';

  const cycleText =
    process.platform === 'win32'
      ? ` ${t('(tab to cycle)')}`
      : ` ${t('(shift + tab to cycle)')}`;

  switch (approvalMode) {
    case ApprovalMode.PLAN:
      textContent = t('plan mode');
      subText = cycleText;
      break;
    case ApprovalMode.AUTO_EDIT:
      textContent = t('auto-accept edits');
      subText = cycleText;
      break;
    case ApprovalMode.AUTO:
      textContent = t('auto mode (classifier-evaluated)');
      subText = cycleText;
      break;
    case ApprovalMode.YOLO:
      textContent = t('YOLO mode');
      subText = cycleText;
      break;
    case ApprovalMode.DEFAULT:
    default:
      break;
  }

  return (
    <Text color={textColor}>
      {textContent}
      {subText && <Text color={theme.text.secondary}>{subText}</Text>}
    </Text>
  );
};
