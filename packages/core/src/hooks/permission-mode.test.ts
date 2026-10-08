/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import { approvalModeToPermissionMode } from './permission-mode.js';
import { PermissionMode } from './types.js';

describe('approvalModeToPermissionMode', () => {
  it.each([
    [ApprovalMode.DEFAULT, PermissionMode.Default],
    [ApprovalMode.PLAN, PermissionMode.Plan],
    [ApprovalMode.AUTO_EDIT, PermissionMode.AutoEdit],
    [ApprovalMode.AUTO, PermissionMode.Auto],
    [ApprovalMode.YOLO, PermissionMode.Yolo],
  ])('maps %s to %s', (mode, expected) => {
    expect(approvalModeToPermissionMode(mode)).toBe(expected);
  });

  it.each([undefined, '', 'unknown'])('maps %s to default', (mode) => {
    expect(approvalModeToPermissionMode(mode)).toBe(PermissionMode.Default);
  });
});
