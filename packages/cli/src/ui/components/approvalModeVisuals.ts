/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';

export function getApprovalModeIndicatorColor(
  approvalMode: ApprovalMode,
): string | undefined {
  switch (approvalMode) {
    case ApprovalMode.PLAN:
      return theme.status.success;
    case ApprovalMode.AUTO_EDIT:
      return theme.status.warning;
    case ApprovalMode.AUTO:
      return theme.text.link;
    case ApprovalMode.YOLO:
      return theme.status.error;
    case ApprovalMode.DEFAULT:
    default:
      return undefined;
  }
}

export function getApprovalModePromptStyle(approvalMode: ApprovalMode): {
  color?: string;
  prefix: '>' | '*';
  label?: string;
} {
  switch (approvalMode) {
    case ApprovalMode.AUTO_EDIT:
      return { color: theme.status.warningDim, prefix: '>', label: 'edits' };
    case ApprovalMode.AUTO:
      return { color: theme.text.link, prefix: '>', label: 'auto' };
    case ApprovalMode.YOLO:
      return { color: theme.status.errorDim, prefix: '*', label: 'yolo' };
    case ApprovalMode.PLAN:
    case ApprovalMode.DEFAULT:
    default:
      return { prefix: '>' };
  }
}
