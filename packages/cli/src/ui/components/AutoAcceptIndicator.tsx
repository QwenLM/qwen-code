/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';

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
      textColor = Colors.AccentBlue;
      textContent = 'plan mode';
      subText = ' (shift + tab to cycle)';
      break;
    case ApprovalMode.AUTO_EDIT:
      textColor = Colors.AccentGreen;
      textContent = 'auto-accept edits';
      subText = ' (shift + tab to cycle)';
      break;
    case ApprovalMode.YOLO:
      textColor = Colors.AccentRed;
      textContent = 'YOLO mode';
      subText = ' (shift + tab to cycle)';
      break;
    case ApprovalMode.DEFAULT:
    default:
      break;
  }

  return (
    <Box>
      <Text color={textColor}>
        {textContent}
        {subText && <Text color={Colors.Gray}>{subText}</Text>}
      </Text>
    </Box>
  );
};
