/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskResultDisplay } from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';

export const getStatusColor = (
  status:
    | TaskResultDisplay['status']
    | 'executing'
    | 'success'
    | 'awaiting_approval',
) => {
  switch (status) {
    case 'running':
    case 'executing':
    case 'awaiting_approval':
      return theme.status.warning;
    case 'completed':
    case 'success':
      return theme.status.success;
    case 'cancelled':
      return theme.status.warning;
    case 'failed':
      return theme.status.error;
    default:
      return theme.text.secondary;
  }
};

export const getStatusText = (status: TaskResultDisplay['status']) => {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'User Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
};
