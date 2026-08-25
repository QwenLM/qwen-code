/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const PERMISSION_MODES = [
  'plan',
  'default',
  'auto-edit',
  'auto',
  'yolo',
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
