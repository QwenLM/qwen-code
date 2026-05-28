/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import {
  getApprovalModeIndicatorColor,
  getApprovalModePromptStyle,
} from './approvalModeVisuals.js';

describe('approval mode visuals', () => {
  it('uses distinct colors for auto-edit and classifier auto mode', () => {
    expect(getApprovalModeIndicatorColor(ApprovalMode.AUTO_EDIT)).toBe(
      theme.status.warning,
    );
    expect(getApprovalModeIndicatorColor(ApprovalMode.AUTO)).toBe(
      theme.text.link,
    );
  });

  it('gives classifier auto mode its own input styling', () => {
    expect(getApprovalModePromptStyle(ApprovalMode.AUTO_EDIT)).toEqual({
      color: theme.status.warningDim,
      prefix: '>',
      label: 'edits',
    });
    expect(getApprovalModePromptStyle(ApprovalMode.AUTO)).toEqual({
      color: theme.text.link,
      prefix: '>',
      label: 'auto',
    });
  });

  it('keeps yolo visually separate from both auto modes', () => {
    expect(getApprovalModePromptStyle(ApprovalMode.YOLO)).toEqual({
      color: theme.status.errorDim,
      prefix: '*',
      label: 'yolo',
    });
  });
});
