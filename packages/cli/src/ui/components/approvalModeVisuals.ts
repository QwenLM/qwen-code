/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

export function getApprovalModeCycleHint(): string {
  return t(
    process.platform === 'win32' ? '(tab to cycle)' : '(shift + tab to cycle)',
  );
}

export function getApprovalModeLabel(approvalMode: ApprovalMode): string {
  switch (approvalMode) {
    case ApprovalMode.PLAN:
      return t('plan mode');
    case ApprovalMode.AUTO_EDIT:
      return t('auto-accept edits');
    case ApprovalMode.AUTO:
      return t('Auto mode');
    case ApprovalMode.YOLO:
      return t('YOLO mode');
    case ApprovalMode.DEFAULT:
      return `⏸ ${t('Ask permissions')}`;
    default:
      return '';
  }
}

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
      return theme.text.secondary;
    default:
      return undefined;
  }
}

export function getApprovalModePromptStyle(approvalMode: ApprovalMode): {
  color?: string;
  prefix: '>' | '*';
} {
  switch (approvalMode) {
    case ApprovalMode.AUTO_EDIT:
      return { color: theme.status.warningDim, prefix: '>' };
    case ApprovalMode.AUTO:
      return { color: theme.text.link, prefix: '>' };
    case ApprovalMode.YOLO:
      return { color: theme.status.errorDim, prefix: '*' };
    case ApprovalMode.PLAN:
    case ApprovalMode.DEFAULT:
    default:
      return { prefix: '>' };
  }
}
