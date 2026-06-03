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
  it('formats yolo as uppercase', () => {
    expect(formatApprovalModeName(ApprovalMode.YOLO)).toBe('YOLO');
  });

  it('uses a specific classifier description for auto mode', () => {
    expect(formatApprovalModeDescription(ApprovalMode.AUTO)).toBe(
      'Use classifier to automatically approve safe tool calls',
    );
  });
});
