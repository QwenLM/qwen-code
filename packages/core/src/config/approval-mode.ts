/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum ApprovalMode {
  PLAN = 'plan',
  DEFAULT = 'default',
  AUTO_EDIT = 'auto-edit',
  AUTO = 'auto',
  YOLO = 'yolo',
}

export const APPROVAL_MODES = Object.values(ApprovalMode);
