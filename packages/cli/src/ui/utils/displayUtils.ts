/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { theme } from '../semantic-colors.js';
import { AgentStatus } from '@qwen-code/qwen-code-core';

// --- Status Labels ---

export interface StatusLabel {
  icon: string;
  text: string;
  color: string;
}

export function getArenaStatusLabel(status: AgentStatus): StatusLabel {
  switch (status) {
    case AgentStatus.COMPLETED:
      return { icon: '✓', text: 'Done', color: theme.status.success };
    case AgentStatus.CANCELLED:
      return { icon: '⊘', text: 'Cancelled', color: theme.status.warning };
    case AgentStatus.FAILED:
      return { icon: '✗', text: 'Failed', color: theme.status.error };
    case AgentStatus.RUNNING:
      return { icon: '○', text: 'Running', color: theme.text.secondary };
    case AgentStatus.INITIALIZING:
      return { icon: '○', text: 'Initializing', color: theme.text.secondary };
    default:
      return { icon: '○', text: status, color: theme.text.secondary };
  }
}

// --- Thresholds ---
export const TOOL_SUCCESS_RATE_HIGH = 95;
export const TOOL_SUCCESS_RATE_MEDIUM = 85;

export const USER_AGREEMENT_RATE_HIGH = 75;
export const USER_AGREEMENT_RATE_MEDIUM = 45;

export const CACHE_EFFICIENCY_HIGH = 40;
export const CACHE_EFFICIENCY_MEDIUM = 15;

// --- Color Logic ---
export const getStatusColor = (
  value: number,
  thresholds: { green: number; yellow: number; red?: number },
  options: { defaultColor?: string } = {},
) => {
  if (value >= thresholds.green) {
    return theme.status.success;
  }
  if (value >= thresholds.yellow) {
    return theme.status.warning;
  }
  if (thresholds.red != null && value >= thresholds.red) {
    return theme.status.error;
  }
  return options.defaultColor ?? theme.status.error;
};
