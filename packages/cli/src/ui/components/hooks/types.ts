/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookConfig,
  HooksConfigSource,
  HookEventName,
} from '@qwen-code/qwen-code-core';

export interface HookExitCode {
  code: number | string;
  description: string;
}

export interface HookEventDisplayInfo {
  event: HookEventName;
  shortDescription: string;
  description: string;
  exitCodes: HookExitCode[];
  matcherGroups: HookMatcherDisplayInfo[];
}

export interface HookMatcherDisplayInfo {
  matcher: string;
  sequential?: boolean;
  configs: HookConfigDisplayInfo[];
}

export interface HookConfigDisplayInfo {
  config: HookConfig;
  source: HooksConfigSource;
  sourceDisplay: string;
  sourcePath?: string;
  matcher?: string;
  sequential?: boolean;
  enabled: boolean;
}

export const HOOKS_MANAGEMENT_STEPS = {
  HOOKS_DISABLED: 'hooks_disabled',
  HOOKS_LIST: 'hooks_list',
  HOOK_DETAIL: 'hook_detail',
  HOOK_MATCHER_DETAIL: 'hook_matcher_detail',
  HOOK_CONFIG_DETAIL: 'hook_config_detail',
} as const;

export type HooksManagementStep =
  (typeof HOOKS_MANAGEMENT_STEPS)[keyof typeof HOOKS_MANAGEMENT_STEPS];

export interface HooksManagementDialogProps {
  onClose: () => void;
}
