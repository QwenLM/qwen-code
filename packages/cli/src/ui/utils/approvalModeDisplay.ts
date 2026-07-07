/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export function formatApprovalModeName(mode: ApprovalMode): string {
  switch (mode) {
    case ApprovalMode.DEFAULT:
      return t('Ask permissions');
    case ApprovalMode.YOLO:
      return 'YOLO';
    default:
      return mode;
  }
}

export function formatApprovalModeDescription(mode: ApprovalMode): string {
  switch (mode) {
    case ApprovalMode.PLAN:
      return t('Analyze only, do not modify files or execute commands');
    case ApprovalMode.DEFAULT:
      return t('Require approval for file edits or shell commands');
    case ApprovalMode.AUTO_EDIT:
      return t('Automatically approve file edits');
    case ApprovalMode.AUTO:
      return t('Use classifier to automatically approve safe tool calls');
    case ApprovalMode.YOLO:
      return t('Automatically approve all tools');
    default:
      return mode;
  }
}
