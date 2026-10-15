/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/sdk/daemon';

type ApprovalModeByValue = {
  [Mode in DaemonApprovalMode]: Mode;
};

const APPROVAL_MODE_BY_VALUE = Object.fromEntries(
  DAEMON_APPROVAL_MODES.map((mode) => [mode, mode]),
) as ApprovalModeByValue;

export const ApprovalMode = {
  PLAN: APPROVAL_MODE_BY_VALUE.plan,
  DEFAULT: APPROVAL_MODE_BY_VALUE.default,
  AUTO_EDIT: APPROVAL_MODE_BY_VALUE['auto-edit'],
  AUTO: APPROVAL_MODE_BY_VALUE.auto,
  YOLO: APPROVAL_MODE_BY_VALUE.yolo,
} as const;

export type ApprovalMode = DaemonApprovalMode;

/**
 * Mapping from string values to enum values for runtime conversion
 */
export const APPROVAL_MODE_MAP: Record<string, ApprovalMode> =
  APPROVAL_MODE_BY_VALUE;

/**
 * UI display information for each approval mode
 */
export const APPROVAL_MODE_INFO: Record<
  ApprovalMode,
  {
    label: string;
    title: string;
    iconType?: 'edit' | 'auto' | 'plan' | 'yolo';
  }
> = {
  [ApprovalMode.PLAN]: {
    label: 'Plan mode',
    title: 'Qwen will plan before executing. Click to switch modes.',
    iconType: 'plan',
  },
  [ApprovalMode.DEFAULT]: {
    label: 'Ask before edits',
    title: 'Qwen will ask before each edit. Click to switch modes.',
    iconType: 'edit',
  },
  [ApprovalMode.AUTO_EDIT]: {
    label: 'Edit automatically',
    title: 'Qwen will edit files automatically. Click to switch modes.',
    iconType: 'auto',
  },
  [ApprovalMode.AUTO]: {
    label: 'Auto',
    title:
      'Qwen will use a classifier to auto-approve safe tools and block risky ones. Click to switch modes.',
    iconType: 'auto',
  },
  [ApprovalMode.YOLO]: {
    label: 'YOLO',
    title: 'Automatically approve all tools. Click to switch modes.',
    iconType: 'yolo',
  },
};

/**
 * Get UI display information for an approval mode from string value
 */
export function getApprovalModeInfoFromString(mode: string): {
  label: string;
  title: string;
  iconType?: 'edit' | 'auto' | 'plan' | 'yolo';
} {
  const enumValue = APPROVAL_MODE_MAP[mode];
  if (enumValue !== undefined) {
    return APPROVAL_MODE_INFO[enumValue];
  }
  return {
    label: 'Unknown mode',
    title: 'Unknown edit mode',
    iconType: undefined,
  };
}
