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
}

export const AutoAcceptIndicator: React.FC<AutoAcceptIndicatorProps> = ({
  approvalMode,
}) => {
  let textColor = '';
  let textContent = '';
  let subText = '';

  switch (approvalMode) {
    case ApprovalMode.PLAN:
      textColor = theme.status.success;
      textContent = t('plan mode');
      subText = ` ${t('(shift + tab to cycle)')}`;
      break;
    case ApprovalMode.AUTO_EDIT:
      textColor = theme.status.warning;
      textContent = t('auto-accept edits');
      subText = ` ${t('(shift + tab to cycle)')}`;
      break;
    case ApprovalMode.YOLO:
      textColor = theme.status.error;
      textContent = t('YOLO mode');
      subText = ` ${t('(shift + tab to cycle)')}`;
      break;
    case ApprovalMode.DEFAULT:
    default:
      break;
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
