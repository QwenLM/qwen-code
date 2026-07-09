/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import {
  formatApprovalModeDescription,
  formatApprovalModeName,
} from './approvalModeDisplay.js';

describe('approval mode display', () => {
  describe('formatApprovalModeName', () => {
    it('formats all modes as friendly names', () => {
      expect(formatApprovalModeName(ApprovalMode.PLAN)).toBe('plan mode');
      expect(formatApprovalModeName(ApprovalMode.DEFAULT)).toBe(
        'Ask permissions',
      );
      expect(formatApprovalModeName(ApprovalMode.AUTO_EDIT)).toBe('Auto Edit');
      expect(formatApprovalModeName(ApprovalMode.AUTO)).toBe('Auto mode');
      expect(formatApprovalModeName(ApprovalMode.YOLO)).toBe('YOLO');
    });
  });

  describe('formatApprovalModeDescription', () => {
    it('uses a specific classifier description for auto mode', () => {
      expect(formatApprovalModeDescription(ApprovalMode.AUTO)).toBe(
        'Use classifier to automatically approve safe tool calls',
      );
    });

    it('describes the remaining modes', () => {
      expect(formatApprovalModeDescription(ApprovalMode.PLAN)).toBe(
        'Analyze only, do not modify files or execute commands',
      );
      expect(formatApprovalModeDescription(ApprovalMode.DEFAULT)).toBe(
        'Require approval for file edits or shell commands',
      );
      expect(formatApprovalModeDescription(ApprovalMode.AUTO_EDIT)).toBe(
        'Automatically approve file edits',
      );
      expect(formatApprovalModeDescription(ApprovalMode.YOLO)).toBe(
        'Automatically approve all tools',
      );
    });
  });
});
