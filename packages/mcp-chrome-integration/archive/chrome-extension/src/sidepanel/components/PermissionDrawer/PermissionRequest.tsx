/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  PermissionOption,
  PermissionToolCall,
} from '@qwen-code/webui';

export type { PermissionOption };
export type ToolCall = PermissionToolCall;

export interface PermissionRequestProps {
  options: PermissionOption[];
  toolCall: PermissionToolCall;
  onResponse: (optionId: string) => void;
}
